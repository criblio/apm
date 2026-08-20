# Incidents P4.4 Phase 1 — alerts→incidents grouping + state fold

**Session date:** 2026-08-18 (evening). Continues the P4.4 plan from
[2026-08-18-incidents-and-code-investigation-ux.md](./2026-08-18-incidents-and-code-investigation-ux.md);
design in
[incidents-and-lifecycle.md](../research/server-investigations/incidents-and-lifecycle.md).

## What shipped

P4.4 Phase 1: incidents now exist as data, entirely Cribl-Search-native
(no cell, works with `serverInvestigations` off). Three cooperating
scheduled searches on the 5-minute cadence:

| offset | search | job |
|---|---|---|
| +3 min | `criblapm__incident_grouper` | firing transitions → attach to a live incident (lookup join on svc, then single-hop graph adjacency) or open a new time-binned one; appends `opened`/`attached` events |
| +4 min | `criblapm__incidents_state` | incremental fold → one row per (incident, svc) with derived status/severity, in `$vt_results` |
| +0 min (next cycle) | `criblapm__incidents_export` | latest fold run's non-closed rows → `criblapm_incidents` lookup (the grouper's join surface) |

Plus: `criblapm_incidents` seed lookup, `listCachedIncidents()` /
`Q.incidentEvents()` read path with `IncidentSummary` /
`IncidentTimelineEntry` types, and an `incidentPipeline.test.ts`
suite pinning the KQL shapes, idempotency joins, and provisioning
wiring (snapshots + provision-guard).

## Design decisions (delta from the design doc)

- **Incremental fold, not recompute.** The first fold implementation
  replayed -7d of incident events with ~8 join subqueries — each
  subquery is a full-window dataset scan (>60s each on staging), which
  would have saturated the pool P4.5 just relieved. Rewrote to the
  evaluator pattern: read own previous output from `$vt_results`
  (latest-jobId self-join), merge a -1h delta with event_id dedup +
  per-member high-water `_time` mark. Documented as a skill.md query
  pattern.
- **Resolution is fold-derived state, not an event.** All-clear
  (via the evaluator's `criblapm__home_alerts` panel cache) + 10m
  debounce → `resolved`; 24h quiet → `closed`; refire reopens
  automatically because status is recomputed. The `resolved` notify
  event lands with Phase 5.
- **Root service = first-firing member** for now; graph-derived
  root (downstream-most erroring node) comes with Phase 4's
  `/config/graph`. The grouper *does* use graph adjacency for attach.
- **New-incident identity is window-binned** (`inc:<bin(fire_time,
  15m)>`): all unmatched fires in a bin collapse to one incident.
  Deliberate over-coalescing bias — cascades usually spread across
  cycles and attach via the lookup; the supervisor (Phase 6) can split.

## Staging-verified KQL findings (now in skill.md)

1. **`project _time=<column>` after a `union` silently nulls `_time`
   on subquery-branch rows.** Main-branch rows keep it. A sort barrier
   between the union and the assignment fixes it. Constant
   `_time=now()` is unaffected. (Cost ~40 min to isolate.)
2. **A trailing `| sort` after a deep join pipeline silently drops
   every row** — 3 in, 0 out, single- and multi-key alike. This is why
   the first deployed fold materialized nothing; found by bisecting
   the live query stage by stage. Distinct from the sort-as-barrier
   usage in (1), which works. Folds/exports now don't sort; readers
   order client-side.
3. **Fold searches must be incremental** — see above.
4. Multi-key `join ... on a, b` and `join kind=leftanti` both work,
   including against empty right sides (verified before betting the
   dedup design on them).

## Fold liveness fix (second live bug)

The first fold of a brand-new incident derived `resolved` while its
services were at 25% errors: incident-level liveness joins
PREVIOUS-run members, which don't exist yet on the first fold. Fixed
with a per-member-row join against the evaluator's panel cache
(`own_bad`), and `listCachedIncidents()` reduces member rows to the
most-open status while the incident rollup lags one cycle.

## Validation

- Unit: 453 tests green, lint 0, tsc clean.
- Live (pre-provision): grouper body over -24h produced exactly one
  `opened` + one `attached` for yesterday's load-generator fire with
  deterministic ids; fold + reader parse clean on empty state.
- Deployed **0.13.46** (searches + seed), then **0.13.47** with the
  two live-found fixes (trailing sort; per-member liveness).
- End-to-end on `paymentFailure 50%` (recommendationCacheFailure
  left on):
  - Evaluator: payment 17→25% errors; payment + checkout +
    load-generator committed `firing` transitions in one cycle.
  - Grouper: **one** incident `inc:1787112900` opened, all three
    services attached, deterministic event ids; three later grouper
    cycles emitted zero duplicates (leftanti dedup proven).
  - Fold: 3 member rows, status `open` while firing.
  - Export: lookup maps all three services → the incident (follow-on
    fires would attach, not duplicate). `frontend` correctly absent —
    its firing transition predates the pipeline (see limitations).
  - Resolution: flag off → watched for derived `resolved` (results in
    the PR comment).

## RESOLVED DIAGNOSIS (2026-08-19 evening): platform-wide, not ours

Clint confirmed his own pre-existing, UI-created `tailscale_offline` →
ntfy notification ALSO stopped delivering, and the UI no longer renders
bound targets even for records whose API reads (and
`schedule.notifications` joins) are intact. **ALL scheduled-search
notification dispatch on the staging workspace broke ~Aug 15** — our
target/binding shapes were never the problem (field-identical to the
known-good ntfy one). Escalated to the Search team as a platform bug.
The coordinator poll (below) makes the cell immune to this class
regardless of the platform fix.

## Found along the way: Cribl→cell notify delivery is broken (P4.3)

Today's firing alerts started **no** autonomous investigation. Every
piece was individually healthy — notify search enabled + notification
bound, webhook target auth valid (direct POST accepted), cell up — and
replaying the exact payment firing event to `/alerts/fire` immediately
spawned an autonomous investigation that **concluded** and committed
`started`/`investigated` events to the dataset. Since the coordinator
dedupes on `event_id` and the replay spawned fresh, **Cribl never
delivered the webhook** during the three notify runs that had the
firing row in-window. Last successful webhook-triggered run: Aug 14–15,
i.e. likely broken since the cell's code-investigation redeploy and
masked by the recommendationCacheFailure detection gap (no alerts
fired since). Follow-up: catch a natural fire with fresh eyes on the
Cribl notification side (target delivery has no visible log surface —
that opacity is itself the problem to solve).

## Known limitations (Phase 1)

- Fold state carried via `$vt_results` is only visible inside the -1h
  search window: pausing the fold longer loses accumulated state (the
  event log in the dataset stays complete; active incidents rebuild
  from ongoing fires). A daily reconciliation search can land with
  Phase 3 if it bites.
- A human `closed` between fold cycles can still receive attaches for
  ≤10 min (until the export drops the row from the lookup).
- Status/severity override folding uses plain `max()` within the
  delta window — fine until the Phase 2 warroom UI writes them.
- No UI yet: Phase 1 is the data pipeline + read path. The Incidents
  list/detail UI is Phase 2.

## Environment state

- flagd: `paymentFailure` flipped to 50% for validation, then **off**;
  `recommendationCacheFailure` remains ON (unchanged from checkpoint).
- App: **0.13.47** deployed to staging.
- Branch: `feat/incidents-p4.4-phase1` (PR #146).
- One autonomous investigation (payment) ran on the cell from the
  manual replay; its lifecycle events are in the dataset, so the
  Alerts page badge has real data.
- Dev box: `scripts/cribl-mcp.sh` now auto-detects the PVE AppArmor
  quirk (was: every `docker run` failed).

## Addendum: latency arm shipped same session (PR #147)

After the incident validation completed, priority 3 from the
checkpoint landed as a stacked PR: the service-level p95-regression
arm (`3x AND >=100ms`, volume-gated, stream-filter parity with the
baseline). Live probe showed why nothing ever fired: recommendation's
regression is ~45→~140ms — a 3.5x that sits UNDER the per-op arm's
250ms floor. Deployed as **0.13.48**; zero false latency fires across
17 services at deploy time.

**Natural-fire test protocol (pending):** all flags were turned OFF at
05:45Z to flush the polluted baseline. After ≥2h15m (the -2h..-1h prev
window must be fully clean), flip `recommendationCacheFailure on` and
watch, in order: (1) `signal_type="latency"` firing transition for
recommendation, (2) whether the Cribl notification actually reaches
the cell (the P4.3 delivery break), (3) a latency incident opening in
the P4.4 pipeline. One flag flip validates all three.

## Addendum 2: Incidents drill-in UI (P4.4 Phase 2A, same branch as #147)

Per Clint's steer — incidents are not a new top-level concept; they sit
above alerts as the drill-in unit. The Alerts page now leads with an
Incidents section (status/severity/services/root/duration), rows expand
inline into member table + warroom timeline, `?incident=` deep-links,
closed hidden behind a toggle. The old client-paired "Alert Incidents"
table is renamed **Alert Episodes**. App **0.13.50** deployed; validated
via Playwright on staging (screenshots in
`screenshots/2026-08-18-incidents-p4.4-phase1/`). The detail's timeline
query windows from the incident's own age — a fixed -7d live scan took
>60s on the pool (same lesson as the fold).

Observed live in the screenshot: load-generator re-fired at 10:51 PM
and **attached** to the existing incident (fires=2) instead of opening
a duplicate; the incident later re-derived `resolved` after quiet.

Next: **Phase 2B** — human warroom writes (notes, status/severity
override, close/reopen) via `incidentEventCommitQuery` + `export to
search` from the app.

## Addendum 3: overnight build-out — the full loop (Clint's mandate)

Overnight goal set by Clint: "We collapse alerts, we create incidents,
then we investigate them, we annotate them, we make the human prepared
to deal with them. We allow the human to intervene and guide the
agent." What landed (apps 0.13.51–0.13.52):

1. **Rich incident page** (`/incident/:id`): deterministic summary
   narrative (root-first, downstream, outcome), correlated
   investigations with conclusions + transcript links, member table
   with signals/peak error rates, interleaved warroom timeline
   (incident events + investigation lifecycle).
2. **Warroom writes**: notes, status/severity overrides, close/reopen
   via `commitHumanIncidentAction()` — the pinned commit KQL through
   `export tee=true to search`, no cell required. Status-bearing
   events drive the state fold, so human overrides genuinely change
   incident state. Optimistic UI + honest ~5m re-fold banner.
   **Validated live via Playwright: a real note round-tripped through
   the dataset into the timeline; a status change committed.**
3. **Human-guides-agent**: the incident's Investigate button seeds the
   agent with the incident context (members in first-fired order,
   derived root, age-scoped window) and the create flow commits a
   deterministic `investigation_linked` event, so launched runs appear
   on the incident — interactive ones included ("Linked").
4. **Cell poll-trigger** (`f1be7c9`, cell/src/coordinatorDO.ts):
   replaces the broken Cribl notify webhook with a durable
   self-re-arming coordinator alarm that polls the firing-alert query
   every 5m through the same admission/dedup path. Handed to Clint for
   the cell agent to deploy (this box has no cell deploy path); the
   /alerts/fire webhook stays wired as a fallback.
5. Temp delivery-test resources (search/notification/target) removed
   from staging after confirming the notify break is in Cribl's
   dispatch layer, not our config (target/binding verified
   field-perfect; json_array and custom formats both undelivered).

## Addendum 4: natural-fire test — full loop proven (08:00–09:30Z)

`recommendationCacheFailure` on at 08:00Z after the baseline flush:

- **08:26Z the latency arm fired naturally** (p95 2.2ms → 160ms, 73×;
  pending→firing walk clean) — first-ever detection of this scenario.
- Grouper attached recommendation to the incident same-cycle.
- Autonomous investigation concluded in 4 minutes with a root cause
  down to the code lines (`recommendation_server.py:87-88`, 25%
  cached_ids growth → ~25M entries), flag + deploy correlation,
  remediation, and confidence. (Replay path; the coordinator poll
  awaits the cell-agent deploy — identical payload/admission.)
- The incident page shows the whole story: two concluded
  investigations w/ findings + transcripts, 6 members w/ per-signal
  detail, human note, interleaved timeline. Playwright-asserted;
  screenshots `morning-*.png`.

Soak findings fixed live (0.13.53–0.13.55): adjacency attaches only
to OPEN incidents (a frontend flap had resurrected the resolved
payment incident); late-attached members inherit title/root/opened_at
from carried state (fold prev-wins + defensive reader reduction — a
fresh member's own first-fire as opened_at had narrowed the page's
timeline window and hidden older notes).

End state: app **0.13.55**; `recommendationCacheFailure` ON (matches
checkpoint; live latency incident visible for review); cell poll
deploy pending (`f1be7c9`, handoff message delivered).

## Addendum 5: cartFailure fresh-scenario verification (18:05–19:50Z)

Clint's ask: new scenario, verify everything. All stages green (table
in the PR #147 comment). Three more live-observed fixes shipped during
the run (0.13.57–0.13.59): derived resolution supersedes active-state
human overrides (an `identified` incident now auto-resolves on
all-clear); the fold's liveness join and every current-state
$vt_results reader (`latestRunRows()`) keep only the newest evaluator
run — keepLastN=2 was mixing a stale run in, holding all-clear
incidents open and double-rendering flapping services.

The cart incident correctly REOPENED at the end when frontend
genuinely re-fired (new fire supersedes stale human status — by
design). Notification break confirmed platform-wide (Clint filed the
Search bug); once fixed, webhook resumes as primary with the poll as
dedup-free backstop.

## Addendum 6: eval-harness modernization (incidents-aware)

Per Clint: update the scenario eval framework for the new UI and add
incident coverage. Landed (eval/):

- **Incident-layer checks** (eval/incidentChecks.ts), auto-appended to
  the 9 alert-firing scenarios via `expectsIncident: true`: incident
  listed with live status on Alerts (10-min budget — the incident
  materializes ~6-8 min post-fire), drill-in page renders with the
  member, opened/attached events (-20m window so a previous scenario's
  closed incident can't satisfy it), live fold row.
- **Scenario isolation**: agent-closes all live incidents pre-scenario.
- **Investigator step** now supports server investigations (both
  composer generations + completion markers).
- **Three harness bugs found by live smokes**: fresh auth sessions
  re-show the workspace announcement modal (run.ts now uses the shared
  gotoApm that dismisses it); Capra VerticalNavigation items are
  BUTTONS, not links (getByRole('link') never matched — new navItem
  locator); nav wait budgets normalized to 30s.
- **Isolation insight**: back-to-back runs of the SAME scenario are
  contaminated — the alert never resolves between runs, so no fresh
  firing transition exists and the (transition-driven) grouper has no
  trigger. Full-suite runs with cooldowns + distinct services mostly
  avoid it; same-scenario reruns need the documented 15-30 min decay.

## Addendum 7: full-suite eval results (2026-08-20, 11h27m, pack 0.13.59)

Mean **0.48** across 14 scenarios (raw; every alert scenario carried
one guaranteed miss from the stale `data_datatype` history check —
fixed mid-run for future runs — so normalized ≈ 0.53-0.55).

| Tier | Scenarios | Story |
|---|---|---|
| Everything works | cartFailure **0.95**, paymentFailure 0.65 | Detection → incident → drill-in page → agent root cause, end to end. All 5 incident checks green. |
| Agent rescues | adFailure, failedReadinessProbe, kafkaQueueProblems, llmRateLimitError, paymentUnreachable, productCatalogFailure | Detection partial/missed; **investigator root-caused 8/13 scenarios**, 6 with no alert at all. |
| Detection gaps | adHighCpu, adManualGc, emailMemoryLeak | Subtle latency/leak signatures below current arms (known P2 targets). |
| Timing-shy | recommendationCacheFailure 0.53 | **The latency arm fired in-suite** and its incident materialized (alertState + both incident KQL checks ✓); only the UI-timing surfaces missed by ~2 min — scenario wait needs 15m→22m. |

New findings from the run:
1. **Silent-detection arm is structurally unreachable** (paymentUnreachable):
   a fully-silent service emits no spans → no evaluator row → the
   `curr_requests == 0` case can never produce a row. Fix: drive from
   the prev lookup (union leftanti current svcs). Tracked.
2. **Same-service scenario adjacency**: paymentFailure →
   paymentUnreachable back-to-back left payment's alert state unable to
   produce fresh transitions. Suite ordering should interleave services.
3. **Investigator wait budgets**: 5 of the "timed out" investigator legs
   matched the root-cause pattern but didn't conclude inside waitMs —
   budgets need +3-5m, or the completion marker needs to catch the
   conclusion-in-progress state.

## Addendum 8: 0.14.0 release-gate review + investigation-correlation fix

Pre-tag high-effort review of the full release diff: 9 confirmed
findings, all fixed (details in the PR #147 comment). Standouts: the
fold's lexicographic override reduction (close-after-reopen stuck
incidents open forever), the cell poll bypassing the
serverInvestigations gate (now reads the notify search's cached
results — flag off ⇒ no-op), a fleet-wide silent-alert storm guard,
and latency alerts being invisible in Overview's Detected Issues.

Clint then caught the incident page showing no investigations despite
runs existing. Three stacked causes, all fixed (0.13.61):
1. Correlation window ended at lastFire+30m — investigations often
   conclude later.
2. The -Nh investigation-events dataset scan could exceed the query
   budget on older incidents and get swallowed silently. The page now
   correlates via the CELL'S INDEX (one HTTP call) with per-id
   conclusion fetches — the dataset scan is gone.
3. The runs Clint saw were the eval's INTERACTIVE investigations,
   which stored incident_key='interactive' with no service metadata —
   structurally unmatchable. The cell now stamps "svc:interactive"
   from the seed context (rides with the pending celld deploy).

Verified live: autonomous replay for the open incident renders
Investigations (1)/Concluded on the deployed page
(screenshot investigations-index-fix.png).

**celld deploy now carries THREE changes** (cell/src/coordinatorDO.ts):
the poll trigger, the notify-search-results read (flag-gate
restoration), and the interactive svc metadata.

## Follow-ups

1. **P4.3: Cribl→cell notify delivery** — see above; highest priority
   because it silently disables the whole autonomous loop.
2. Long-firing alerts whose transition predates the grouper's -30m
   window never join incidents (observed: `frontend-proxy`, firing for
   ~4 days). Phase 2/4 could backfill via current `alert_status`.
3. Fold `n_svcs`/severity lag one cycle behind membership (prev-run
   rollup) — cosmetic, self-heals; note for the Phase 2 UI.
4. Same-bin root pick is alphabetical (`checkout` chosen over
   `payment` in the validation incident) — Phase 4's graph root fixes.
5. `frontend` rides the 5% error threshold and flaps (fired/resolved
   repeatedly all day on background noise) — P1.1 noise-budget tuning;
   its flapping also holds any incident it joins open.
6. Latency arm baseline-absorption: a sustained degradation stops
   alerting after ~2h as the rolling -2h..-1h baseline absorbs it (the
   recommendation alert self-resolved mid-degradation). A "sticky
   baseline" (freeze prev while firing) would fix it — deliberate
   evaluator-semantics change, needs its own PR.
