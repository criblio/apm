# Session: 2026-05-12 — Leak fingerprint detection + Investigator playbook for smooth-climb 5xx

## The scenario that broke today's detection

Front-end error rate has climbed monotonically for 11 days following
the Phase 1b session.id propagation deploy on 2026-05-01:

| Window                  | Total reqs | 5xx errs | Err %  |
|-------------------------|-----------:|---------:|-------:|
| 2026-05-01 (pre-deploy) |    516,535 |       19 |  0.00% |
| 2026-05-02 (deploy day) |  1,545,978 |    5,653 |  0.37% |
| -5d                     |    793,590 |   75,112 |  9.46% |
| -1d                     |    938,550 |  138,243 | 14.73% |
| last 30m                |     ~5,000 |   ~2,400 |  ~50%  |

Root cause: BaggageSpanProcessor stamps `session.id` on every span;
LoadTestShape recycles users every 10 min minting fresh sessions; the
frontend pod has been up since 2026-05-01T22:27:29Z and is accumulating
unbounded session-id cardinality in process memory. Downstream services
are *slow*, not erroring — the BFF times out waiting and returns 504.

## What the APM app currently misses

1. **No slope/drift signal.** Error widgets show absolute counts and
   current rate. A 0.37% → 14.73% climb over 10 days has tiny per-day
   deltas; no threshold ever trips.
2. **No origin attribution.** Clicking into a 504 on `/api/products`
   shows the trace but doesn't say "downstream span succeeded; the
   BFF gave up waiting." Latency-induced 5xx looks identical to a
   downstream failure.
3. **No pod-uptime axis.** No way to ask "are errors correlated with
   pod age?" The Investigator never considers `pod has not restarted`
   as a hypothesis.
4. **Cardinality is invisible.** `session.id` is a fingerprint, not
   a label. Its distinct-value count has been growing linearly for 11
   days and nothing in the app flags this.
5. **No "smooth-climb" investigator playbook.** Invoking the
   Copilot on the current alert will likely chase `paymentFailure`
   or `kafkaQueueProblems` flags because those are the named failure
   scenarios in the demo's eval set. The preamble doesn't include a
   branch for slow-leak signatures.

## Files surveyed (versus what was referenced in the issue)

| Referenced  | Actual path                       | Notes |
|---|---|---|
| `agentContext.ts` (Investigator preamble) | `src/api/agentContext.ts` | `staticPreamble()`, `signalsBlock()` — preamble + signals injection are split, good seam for the playbook update |
| Investigation seed shape | `InvestigationSeed` in `src/api/agentContext.ts` (`knownSignals: string[]`) | Used by HomePage, ServiceDetailPage, OperationAnomalyList — these are where we'd surface new signals |
| Service detail page (pod uptime) | `src/routes/ServiceDetailPage.tsx` | Already pulls `k8s.pod.phase` metric; has an "Instances" section. Pod-uptime overlay slots into the existing timeline |
| Trace view (origin attribution) | `src/routes/TraceView.tsx` + `SpanDetail.tsx` | Span detail panel is where the "downstream span succeeded, BFF timed out" annotation would render |
| Session log convention | `docs/sessions/YYYY-MM-DD-<slug>.md` | Confirmed in CLAUDE.md |

No path divergence — the issue's references match the codebase.

## Plan

Proposing five additive changes. Each lands in its own PR if you
want stacked review; or one larger PR if you'd rather see them
together. Dependencies flow one direction: A, C, D feed signals
that E (the Investigator playbook) consumes; B is independent.

### Order

1. **D — Cardinality watch** (cheapest, no UI). A scheduled search
   `criblapm__attr_cardinality` runs hourly over a rolling 24h
   window, computes `dcount(attributes.['<key>'])` for a hard-coded
   short-list of fingerprint-prone attributes (`session.id`,
   `user.id`, `enduser.id`, `correlation.id`, `request.id`, plus
   anything trace-context-related). Exports to a lookup keyed on
   `(svc, attr_name)` with `dcount`, `slope_per_hour`, and
   `linearity_score` (R² of linear fit). The lookup is what alerts
   and the Investigator read. ~50 lines of KQL + 1 entry in
   `provisionedSearches.ts`.

2. **A — Slope / drift detection.** Extend `criblapm__home_alerts`
   to compute per-service error_rate slope over the last 7d (or
   max available history) and surface a `drift` signal type
   alongside the existing `error_rate` / `traffic_drop` / `silent`
   types. State machine treats `drift` as a slower-acting signal
   (longer debounce — three consecutive bad windows before firing
   to avoid flapping on noisy services). UI affordance: small
   sparkline + "errors trending up: 0.4% → 14% over 7d" line on
   the service overview row. Wired into `knownSignals` so the
   Investigator sees it automatically.

3. **C — Pod uptime correlation.** Add a per-pod `start_time` line
   to the ServiceDetailPage timeline overlay. Source is
   `k8s.pod.start_time` resource attribute (already in the data).
   Compute `pod_age_hours = now - start_time`. Surface as a chip
   next to each instance row: "uptime 11d 4h". Flag in red when
   `pod_age_hours > 168 AND error_rate has > 5x'd over that uptime`.
   The "drift over uptime" computation is the leak-fingerprint
   signal — emit it as a `knownSignal` for the Investigator.

4. **B — Origin attribution in trace view.** SpanDetail panel
   gets a "Why this span failed" subsection when
   `status.code == ERROR AND http.status_code IN (502, 503, 504)`.
   Walks the trace's downstream spans (children of this span,
   transitive) and labels:
     - All downstream spans succeeded with high latency →
       **"Latency-induced timeout: downstream `<svc>:<op>` took
       `<X>ms` and was canceled."**
     - Downstream span errored →
       **"Downstream failure: `<svc>:<op>` returned `<status>`."**
   Pure render-time logic; no new query. The distinction makes
   the 504 leak case visually obvious.

5. **E — Investigator playbook update.** Adds a new section to
   `staticPreamble()` titled "Smooth-climb 5xx (leak signature)":

   > Before chasing flagd or messaging scenarios, check for the
   > leak fingerprint. A leak presents as: errors trending up
   > monotonically over many windows (slope positive over both
   > the alert window AND the prior 7d), downstream services
   > healthy (their span error rates < 1%), and a pod that has
   > been up for >7d. The combination is a stronger signal than
   > any single flagd or named-failure scenario. Verification
   > step: recommend pod restart, not flag rollback.

   Plus a per-step playbook (slope check → pod uptime check →
   one representative trace → cardinality dump) that mirrors the
   structure of the existing "Common failure modes" section.

   The Investigator consumes the new signals from (A), (C), (D)
   via `knownSignals` — no new tool calls needed.

### Validation

After (E) ships, point the Investigator at the current frontend 5xx
trend in staging and confirm:

- Identifies the trend as "smooth climb, leak fingerprint"
- Notes the frontend pod's 11-day uptime
- Notes session.id cardinality
- Recommends `kubectl rollout restart deploy/frontend` as the
  verification action
- Does NOT chase `paymentFailure` / `kafkaQueueProblems` flags

If the Investigator still chases flagd scenarios, the playbook update
isn't strong enough — iterate on the preamble wording before
considering this done.

### What I'm NOT proposing

- A general anomaly-detection ML model. The slope + linearity check
  is enough for leak signatures and stays explainable.
- Live cardinality estimation at query time. The hourly scheduled
  search is the right cadence — cardinality doesn't move fast and
  doing it live every page load is wasteful.
- Auto-restart actions. The recommendation is the Investigator's
  job; the human runs the kubectl command. Same as every other
  scenario today.
- A new metric pipeline for memory/heap. The leak fingerprint is
  inferred from telemetry shape, not from observing memory growth
  directly. Adding a JVM/.NET heap-metric pipeline is a much bigger
  effort and orthogonal to this scenario's surface.

### Eval coverage

After (A)-(E) ship, add an eval scenario `leakFingerprint` to
`eval/scenarios/`. The scenario can be synthetic: flip a flagd flag
that simulates monotonic session.id cardinality growth (or just
take a synthetic-but-realistic baseline-vs-current state and seed
the lookup with it). Investigator should reach the leak hypothesis
in ≤8 turns and recommend pod restart. Score is binary —
"recommended restart correctly" vs "chased something else."

### Open questions for you

1. **Slope window for (A).** I proposed 7d. Real-world deploys
   change frequently enough that a 7d slope can include multiple
   regimes. Would 24h slope + 7d slope, with a "both positive AND
   similar" check, be more robust? My instinct says yes.
2. **Cardinality attribute list for (D).** Hard-coded short-list
   means we'd miss user-defined fingerprint attributes. The
   alternative — detect cardinality blowups automatically across
   all attributes — is expensive. Start with the short-list and
   make it user-configurable in Settings later?
3. **Pod-uptime correlation in (C).** What counts as "high uptime"?
   I proposed 7d. In dev workspaces with frequent redeploys that
   may be too lenient; in production it may be too strict. Could
   make it a Settings knob.
4. **PR strategy.** One PR per item (5 PRs, stacked) is the
   mobile-friendly chunking. One bigger PR is faster for a single
   reviewer. Your call — I'll default to stacked unless you say
   otherwise.

## What happens next

Pending your go-ahead on the plan. Once approved:
1. Implement D (cardinality watch) — simplest, foundational
2. Implement A (slope detection) — feeds E
3. Implement C (pod uptime correlation) — feeds E
4. Implement E (playbook) — pulls A/C/D signals
5. Implement B (origin attribution) — standalone
6. Validate end-to-end with the Investigator on staging
7. Add `leakFingerprint` eval scenario
8. Each step gets a commit + screenshot/MCP-query evidence in this log

## Validation tools I'll use

- **Cribl MCP** for any data probe — confirmed working with the
  apm-staging skill conventions.
- **Staging app for UI verification** — per CLAUDE.md, deployed
  staging is the validation surface. Will post raw.githubusercontent
  URLs to screenshots if any are produced.
- **Investigator end-to-end** — issue the seed against the current
  staging state via the InvestigatePage; transcript goes into this
  doc under `## Eval results`.
