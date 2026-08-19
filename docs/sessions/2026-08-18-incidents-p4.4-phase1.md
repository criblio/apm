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
