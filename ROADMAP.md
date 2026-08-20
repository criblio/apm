# Cribl APM — Roadmap

This document is the canonical priority list for the Cribl APM
Search App. Re-reviewed adversarially on 2026-07-14 against v0.11.0,
the packaged artifact, the shared framework, and the live Cribl
workspace. The resilience release gate below supersedes feature
priority: restore the app's trust contracts before continuing the
per-signal-dataset work.

> **Refer to this doc as `ROADMAP.md`** (or `/ROADMAP.md` from the repo
> root). Companion docs: `FAILURE-SCENARIOS.md` for the flagd flag
> catalog and test plan; `CLAUDE.md` for repo-wide coding rules;
> `AGENTS.md` for the Cribl App Platform developer guide.

## 2026-07-14 adversarial review — resilience release gate

**Confirmed product direction:** this is intended to become a
customer-installable Cribl App for arbitrary Cribl Cloud workspaces.
The current OTel-demo data contract is an intermediate state, not the
finished product boundary; generalization remains in RG.12 after this
release gate.

No new feature work should ship ahead of the stop-ship items below.
The existing per-signal-dataset P0 remains the first feature priority
after this gate is green.

### 2026-07-14 framework extraction follow-through — v0.11.3

The hardening review identified reusable app-platform behavior that
should not be maintained independently by every Cribl App. The work is
split into a reviewable stack so the framework owns generic policy and
mechanics while APM retains its telemetry-specific behavior.

| Task | Status | Ownership and evidence |
|---|---|---|
| FX.1 shared runtime safety primitives | Complete — framework PR #16 | `@cribl/app-utils` owns KQL serialization/read-only validation, the bounded and cancelable Cribl Search job runner, typed failures, strict NDJSON handling, and the generic React resilience boundary. APM retains OTel trace/span validation, UI presentation, and canary policy. Framework tests cover 27 cases; APM's 290 tests pass against the shared implementation. |
| FX.2 shared release and supply-chain tooling | Complete — framework PR #17 | `@cribl/app-tooling` owns deterministic packaging, archive inspection, exact candidate deployment, release evidence/SBOM/checksums, action pinning, license policy, and secret checks. A SHA-pinned composite action gives apps one CI/release build path. Tooling tests cover reproducible archives and install/upgrade behavior without `force`. |
| FX.3 consume framework from APM | Complete — APM PR #107 | Deleted 1,100+ lines of copied infrastructure, retained only thin APM wrappers, and pinned both the action and cloned framework to merged framework commit `1d10110da4b12c10f66e95ce54f9658544ea3d07`. The package rebuilt twice at SHA-256 `808d754df1e8bf0ff68c9fc0e6cbc0d2d7b04878f67f733d1250aedf90bddc2c`; that exact tgz passed a non-force 0.11.2 → 0.11.3 live upgrade, reconciliation canaries, and all five authoritative hosted smoke tests locally and again in serialized PR CI run `29372182013`. |
| FX.4 migrate other framework consumers | Pending, not release-blocking | Adopt the packages in Customer Analytics and future Cribl Apps after framework PRs #16/#17 merge. Do not overwrite Customer Analytics' existing uncommitted `scripts/deploy.mjs`; reconcile that work in its own reviewed branch. |

**Required merge order:** framework PR #16, framework PR #17, APM
hardening PR #106, then the stacked APM v0.11.3 consumer PR. Do not
squash the app PRs together unless the live upgrade evidence is
re-created for the resulting release candidate.

### 2026-07-14 burn-down result — v0.11.2

| Gate | Status | Verification evidence |
|---|---|---|
| RG.1 generated-event contract | Complete | The deployed post-reconcile canary emitted and read two rows/two datatypes at schema v1 through the real `send` boundary. All alert/deploy readers dual-read `data_datatype` and legacy `datatype`, filter canaries, and use stable logical event IDs. |
| RG.2 ordered/exactly-once alerts | Complete | The two racing state/history jobs were deleted from the live workspace. One immutable evaluator now commits state and history. A live isolated `ok → pending → firing → resolving → ok` traversal replayed every evaluation and produced exactly five durable IDs, one firing, one resolved, and `fire_count=1`. |
| RG.3 read-only KQL boundary | Complete | Shared serializers now cover datasets, strings, identifiers, numbers, times, trace/span IDs, and predicates. The advanced editor is predicate-only. Investigator approval is app-controlled and every model query is read-only validated. Hostile pipeline, field, route, and prompt tests pass. |
| RG.4 reproducible release | Complete | CI and release use the same framework-pinned composite action and build once. `apm-0.11.2.tgz` rebuilt twice at SHA-256 `610613d197f4f276e82870bc22f2c248f4dda4bdc51682adc1e3bda869f9410c`, which is the exact artifact installed in staging. Pack inspection, lock/framework/source metadata, deterministic production SBOM, checksums, and provenance are wired. PR #106 recorded a successful serialized upgrade/reconcile and real-host route, generated-event, and exactly-once alert smoke suite against the owner-approved existing workspace. |
| RG.5 least privilege/product honesty | Complete | The packaged proxy manifest is empty and archive inspection rejects domains, injected headers, scripts, or dependencies. The non-functional notification-target selector and persisted dead settings were removed. |
| RG.6 dependencies/supply chain | Complete | Full-tree and production audits report zero vulnerabilities. React Router/Vite and transitive findings are patched; Node is pinned to a supported floor; Dependabot, dependency review, license denial, secret scanning, and SHA-pinned Actions are enforced. |
| RG.7 runtime containment | Complete | Root, route, and major-panel boundaries isolate failures. Secondary query failures render explicit unavailable/unknown state with Retry. `/configuration` replaces the host-conflicting route and wildcard recovery is present. All top-level routes plus forwarded `popstate` pass in the real Cribl iframe; deterministic route-level fault injection keeps Overview alive and labels missing data. |

**Stop-ship publication decision:** the gate is **CLEARED**. Engineering
criteria, the manual rehearsal, dependency review, and the serialized
PR live CI upgrade/smoke run are green. Version 0.11.2 is ready for code
review and may be merged/tagged after approval. A second disposable
workspace is not required for this gate. Fresh-install, legacy-upgrade,
and clean-uninstall coverage remain explicit RG.18 work when a safe
disposable tenant or equivalent reset mechanism is available.

### Evidence behind the gate

The bullets below are the observations at the start of the review; the
burn-down table above records their current disposition.

- Local checks are superficially green: 263 unit tests and type-check
  pass; lint has one unfailed hook-dependency warning. The tests are
  predominantly KQL snapshots and pure functions. There is no CI
  browser, live Cribl, package-install, failure-path, or coverage gate.
- The live event contract is split. In the last 24 hours, 47 alert and
  18 deploy events were stored as `data_datatype`, while `datatype` was
  `Uncategorized`. `noiseBudgetByService()` and `listRecentDeploys()`
  read `datatype`, so the shipped noise budget produces no rows and
  Investigator deploy context cannot see the emitted deploys.
- The three alert jobs share one cron. Recent live cycles ran
  `criblapm__alert_state_export` first, then the UI evaluator and
  history sender. Because all three recompute against mutable lookup
  state, the export can consume a transition before history observes
  it. Completion is not correctness here.
- All 51 inspected recent APM scheduled jobs completed, but queue wait
  ranged from 8.6 seconds to roughly 22.5 minutes. Several "5 minute"
  panels waited 37–130 seconds; hourly jobs waited 10–22 minutes. The
  configured cadence is therefore not the delivered freshness SLO.
- The release workflow clones the framework's current branch tip,
  whereas CI tests `.framework-sha`. A release can contain framework
  code that never passed this repository's CI.
- The packaged `proxies.yml` authorizes unused `api.example.com` paths
  and an injected credential expression even though README says the
  app makes no external calls.
- Current `npm audit` reports eight advisories, including three high
  severity findings in the React Router and Vite dependency trees.
- The app exposes `/settings` even though the platform guide records
  that host routes containing `settings` may be intercepted. There is
  also no root error boundary or wildcard route recovery.

### Stop-ship — restore correctness, security, and release integrity

- **RG.1 Repair and version generated-event contracts** (S) — define
  one typed schema for `criblapm_alert` and `criblapm_deploy` at the
  `| send` boundary, including the platform's stored field names.
  Migrate every reader (noise budget, alert pages/evals, recent
  deploys, Investigator preflight) to that contract. Add `schema_version`
  and stable event IDs. A post-reconcile contract canary must emit a
  sentinel event, read it back through the same query each consumer
  uses, and fail the deploy on drift. Backfill or dual-read old events
  for the supported upgrade window.
- **RG.2 Make alert transitions ordered and exactly-once** (M) — stop
  running three independent copies of the state machine against a
  mutable lookup on the same cron. Produce one immutable evaluator
  snapshot with an `evaluation_id`; have state persistence and history
  consume that same snapshot, independent of queue order. Make history
  idempotent by `(alert_id, evaluation_id, transitioned_to)`. Test the
  full `ok -> pending -> firing -> resolving -> ok` traversal against
  live scheduled jobs and assert exactly one firing and one resolved
  event, including retries and delayed/out-of-order consumers.
- **RG.3 Put a read-only KQL security boundary around all untrusted
  input** (L) — replace hand-built escaping with shared functions for
  KQL strings, field identifiers, dataset IDs, numbers, relative
  times, and hex trace/span IDs. Cover route params, tag keys, numeric
  filter values, metric/group-by names, Spotlight predicates, and
  service names. The advanced editor must accept a predicate only and
  reject pipeline/side-effect operators such as `send` and `export`.
  The Investigator must never trust the model-controlled
  `confirmBeforeRunning` flag: enforce read-only query validation and
  app-side approval policy before every `run_search`. Add hostile-string,
  property, and prompt-injection tests.
- **RG.4 Make releases reproducible from the tested commit** (S) — use
  `.framework-sha` in both CI and release, run the identical lint,
  unit, type, package, and pack-inspection gates in both, and fail lint
  on warnings. Build once, promote that artifact, publish its checksum,
  dependency lock digest, framework SHA, and SBOM/provenance. Install
  the produced tgz into the owner-approved existing validation workspace
  before publishing it, serialize all shared-workspace runs, and execute
  the authoritative real-host smoke suite after upgrade. Never rebuild a
  different artifact within a workflow. Fresh-install coverage is tracked
  separately in RG.18 because no safe disposable workspace is available.
- **RG.5 Remove undeclared privilege and false product affordances**
  (S) — ship an empty proxy manifest until a real external dependency
  exists; add an archive test that fails on unexpected domains or
  injected headers. The notification-target UI currently promises
  dispatch but only saves IDs; either wire it end-to-end with delivery
  evidence or hide/label it unavailable until the existing alerting
  roadmap work lands. Remove or implement other dead settings so saved
  configuration always has a consumer.
- **RG.6 Patch dependency advisories and add continuous supply-chain
  gates** (S) — update the vulnerable React Router, Vite, Babel,
  PostCSS, js-yaml, and brace-expansion trees; assess runtime versus
  build-only exposure in the PR. Add automated dependency updates,
  production and full-tree audit policy, license review, secret scan,
  and SHA-pin third-party GitHub Actions.
- **RG.7 Contain runtime failures and platform route conflicts** (M)
  — move Settings to a host-safe route such as `/configuration`, add
  a root error boundary and wildcard/not-found recovery, and give each
  major panel an isolated failure boundary with Retry. A failed
  dependency/anomaly/log query must render **unknown/unavailable**, not
  an empty collection that looks healthy. Exercise iframe navigation,
  back/forward, parent `popstate`, and every route in the real host.

**Stop-ship done =** the live contract canary passes; a fault produces
exactly one firing/resolved pair; adversarial inputs cannot add KQL
pipeline stages; the package has no unused proxy capability or known
high-severity advisory; and the released tgz is byte-identical to the
artifact tested with the recorded framework SHA.

### P1 resilience — make overload and partial failure boring

- **RG.8 Introduce a shared search-job coordinator** (L) — extend the
  framework client with `AbortSignal`, server-side job cancellation,
  request deduplication, a global concurrency budget, priority lanes
  (interactive before background), and bounded retry/backoff with
  jitter for 429/5xx/network failures. Replace fixed 400 ms polling
  with capped backoff. Navigation, range changes, refresh, and Stop
  must cancel the underlying job, not merely ignore its eventual React
  state update. Prevent overlapping refreshes and stale responses from
  overwriting newer ranges.
- **RG.9 Treat freshness as data** (M) — every cached panel and alert
  carries source job ID, scheduled time, start/completion time, age,
  configuration/dataset revision, and last error. Serve last-known-good
  data with an explicit stale badge; never silently fall back between
  cached and live semantics. Define page-load and detection-freshness
  SLOs, then fail health checks when queue delay violates them.
- **RG.10 Re-budget scheduled searches from live queue evidence** (M)
  — stagger heavy jobs, remove unnecessary duplicate scans, and keep
  expensive daily/hourly work out of the alert lane. Detect zero-row,
  missed, queued, failed, stale, and schema-invalid jobs individually;
  one sentinel search is insufficient. Add load shedding so a busy
  workspace degrades panel freshness before it starves Investigator
  and alert evaluation.
- **RG.11 Make configuration boot-safe, validated, and atomic** (M) —
  do not issue default-`otel` queries before pack-scoped KV settings
  load. Add a versioned runtime schema, migrations, corruption recovery,
  and an onboarding gate that validates dataset existence, permissions,
  signal presence, field shape, and recent data before activation.
  Key capability caches by dataset/config revision. Replace KV
  read-modify-write races with a serialized settings store or revision
  check so concurrent toggles cannot lose updates.
- **RG.12 Make install, upgrade, and uninstall tenant-safe** (L) —
  remove demo-specific `otel`, `open_telemetry:opentelemetry-demo`, and
  global default-ruleset mutations from automatic deploy behavior.
  Generate a least-privilege plan from the chosen signal datasets,
  show all workspace writes before apply, preserve user-owned fields,
  and keep an undo journal. If post-install provisioning or canaries
  fail after `force: true`, automatically roll back the pack and
  managed resources to the prior known-good revision.
- **RG.13 Add operator-visible diagnostics without leaking data** (M)
  — replace swallowed catches and console-only errors with a small
  typed error taxonomy and diagnostics view: auth/permission, queue,
  timeout, query parse, malformed response, cache stale, and config
  invalid. Include correlation/job IDs and remediation, but redact
  KQL literals, credentials, log bodies, and PII by default. Add
  lightweight counters for job latency, queue time, cancellations,
  cache hits, partial panels, and canary status.
- **RG.14 Bound and sanitize Investigator data flow** (M) — treat log,
  span, and metric values as untrusted data, not instructions. Cap
  result bytes as well as rows, allowlist fields sent back to the
  model, redact likely secrets/PII, and state clearly what Cribl AI
  receives. Validate tool arguments at runtime, cancel search tools
  with the investigation, and never report unsupported actions such
  as notebook saves as successful.

### Test and CI program required by the gate

- **RG.15 Strengthen static and unit gates** (M) — enable TypeScript
  `strict` and `noUncheckedIndexedAccess`; type-check tests, eval, and
  deploy/provision scripts; make zero lint warnings the baseline.
  Add coverage reporting and meaningful branch thresholds for API,
  settings, KQL serialization, provisioning, alert state, transforms,
  and Investigator tools. Split the 1–2K-line query/context/page files
  behind typed domain boundaries as tests are added, rather than
  continuing to grow monoliths.
- **RG.16 Add deterministic client/component failure tests** (L) — use
  a fake Search API/clock to cover queued/running/completed/failed/
  canceled jobs, 401/403/404/429/5xx, proxy timeout, abort, malformed
  and truncated NDJSON, pagination boundaries, KV outage/corruption,
  lookup flap, empty data, partial panels, rapid range changes, and
  concurrent refresh. Assert stale requests cannot win and missing
  data cannot be presented as healthy.
- **RG.17 Add Cribl contract and RBAC tests** (L) — derive endpoint
  shapes from `openapi.json`; assert all search endpoints use
  `/m/default_search`; verify app-scoped KV/proxy behavior and every
  packaged permission. Run a role matrix (installer/admin, normal
  analyst, read-only user, forbidden user) so client-credential tests
  cannot mask permissions the real iframe user lacks.
- **RG.18 Expand the real-host CI lane beyond the shared workspace** (L) —
  stop replacing the locked production `window.fetch` with a bearer
  token in the iframe for the authoritative suite. Test through the
  actual Cribl App host/proxy. The current owner-approved workspace lane
  runs serialized route, contract, and alert canaries. When a disposable
  tenant or safe reset mechanism becomes available, add sequential fresh
  install, legacy upgrade, three distinct signal datasets, wrong/empty schema,
  every route, provisioning, generated-event round trip, cache
  freshness, alert exactly-once, Investigator approval/stop, and clean
  uninstall. Keep the injected-fetch harness only as a fast non-
  authoritative test double and prevent tokens from entering traces.
- **RG.19 Add release and recovery drills** (M) — inspect archive
  contents, install the exact candidate tgz, run smoke/contract/canary
  checks, then deliberately fail provisioning and verify rollback.
  Quarterly, rehearse lookup corruption, queue saturation, revoked
  permissions, KV loss, and bad framework upgrade. Record recovery
  time and turn each escaped failure into a permanent regression test.

**Resilience gate done =** CI proves fresh install + upgrade on the
real host, critical boundaries meet coverage targets, every scheduled
dependency has freshness/schema health, partial failures are visible
and retryable, queue saturation preserves alert/interactive priority,
and rollback restores a known-good app without manual workspace repair.

## Guiding principle: lean on Cribl Search

The app runs *inside* Cribl Search, which already provides saved
searches, scheduled searches, alerts/notifications, KQL, federation,
and a pack-scoped KV store. We do **not** reinvent those — we build a
**domain-specific UI on top of them** that speaks traces / logs /
metrics. Users should never need to know there's a KQL editor
underneath (though power users get an escape hatch).

A second principle joined the first after the June outages:
**the platform must be unable to fail silently.** Every layer that
can corrupt quietly — KQL generation, provisioning, lookup exports —
gets a tripwire. We cannot sell detection we can't trust ourselves.

## Strategic posture (feature work after the resilience release gate)

Once the release gate above is green, three moves remain, in order:

1. **Per-signal datasets, then field mapping (P0 / P1)** — the
   forcing function: metrics support is landing now and metrics /
   logs may live in different datasets than traces. The single
   `getCurrentDataset()` everywhere is the blocker. Once per-signal
   resolution lands, field mapping is the natural next step toward
   schema-agnostic APM.
2. **Adoption finishers (P2-P3)** — detection-quality follow-ons,
   user alerts, SLOs, deploy correlation UI surfaces, flame graph.
   v0.10.0 shipped the platform-integrity floor and the alert /
   deploy pipelines; v0.11.0–v0.12.0 should make all of that user-
   facing.
3. **Moat (P4)** — Investigator v2, telemetry cost & noise
   analytics. Cribl-native capabilities that competitors
   structurally cannot copy because they don't sit on the pipeline.

---

## P0 — Per-signal datasets

Replace the single `getCurrentDataset()` with per-signal resolution
so traces, logs, and metrics can each live in a different dataset
without forking the query builders. This is the precondition for
the metrics work landing now — a Cribl Cloud workspace may emit
spans into `otel` while metrics arrive in `default_metrics` and
logs into `default_logs`. Today the app pins all three to one
dataset name in Settings, which is wrong.

- **P0.1 `datasetFor(signal)` abstraction** (M) — introduce
  `datasetFor('traces' | 'logs' | 'metrics')` in the framework's
  dataset module. Default behavior: return `getCurrentDataset()`
  for all three signals (no behavior change). Settings grows three
  fields (traces / logs / metrics dataset), with the existing
  single-dataset field as a fallback.
- **P0.2 Thread through queries.ts** (M) — replace
  `datasetClause()` in `spansBase()`, `logsBase()`, `metricsBase()`
  with their signal-specific equivalents. Golden snapshot tests
  catch any builder that still reads the old store.
- **P0.3 Thread through the provisioner** (S) — every
  `dataset="…"` baked into `provisionedSearches.ts` must use the
  signal-specific store. The provision-guard (already shipped)
  fences `dataset=""` so a missing signal binding fails fast.
- **P0.4 Migration path for existing single-dataset deploys** (S)
  — on first load of v0.11.0, if only the legacy `dataset` field
  is set, populate all three signal-specific fields with the same
  value. Zero-config upgrade.

**Done =** the same app installs cleanly on a Cribl Cloud
workspace where `service.name` rows arrive across three distinct
datasets, without any builder being modified beyond its choice of
which signal it queries.

## P1 — Field mapping

The second forcing function: not every Cribl Cloud workspace
follows OTel naming conventions exactly. A customer's `service.name`
may land at `app.svc` or `resource.service`. Field mapping makes
the app schema-agnostic on top of the per-signal-dataset work.
Pairs with the long-term schema-agnostic APM vision.

- **P1.1 `fieldResolver(signal, logicalName)` primitive** (M) —
  exact same shape as `datasetFor` but for fields. Each logical
  field (`service.name`, `status.code`, `duration_us`, etc.) maps
  to a per-signal physical-field expression. Default mapping
  matches OTel attribute names so the abstraction is a no-op for
  the common case.
- **P1.2 One builder behind it as the proof point** (M) — pick
  `serviceSummary()` or `spansBase()` and route every field access
  through `fieldResolver`. Verify against staging that the existing
  workspace continues to work identically; then mark the migration
  pattern as the template for the rest.
- **P1.3 Mapping editor UI** (L) — Settings page lets users
  override the default field mappings, scoped per signal. The
  workspace's actual schema is discovered via a sampling query
  (already exists for the metric-name catalog — generalize it).
- **P1.4 LLM-assisted mapping suggestions** (L) — the agent reads
  a sample of dataset rows and proposes a mapping. User accepts or
  edits before save. Reduces onboarding from a 30-minute exercise
  to one click for the common case.
- **P1.5 `create_field_mapping` Investigator tool** (S) — when
  the agent encounters an unmapped field during investigation, it
  proposes the mapping inline rather than failing. Closes the loop
  on workspace onboarding.

## P2 — Detection quality (remaining)

The eval harness optimizes recall on chaos scenarios; production
needs precision on real traffic. v0.10.0 shipped the noise-budget
aggregation (P1.1 in the old numbering) so threshold changes can
now be evaluated on both axes. Remaining items address gradual-
onset detection and CI live-smoke.

- ~~**P2.0 service-level p95-regression arm**~~ — **SHIPPED 2026-08-19
  (#147)**: `curr_p95 >= prev_p95 * 3 AND curr_p95 >= 100ms`,
  volume-gated, stream-filter parity with the baseline. Fired
  naturally on `recommendationCacheFailure` (2.2ms → 160ms) and again
  inside the 2026-08-20 full-suite eval. Known limitation: the rolling
  -2h..-1h baseline ABSORBS a sustained degradation after ~2h and the
  alert self-resolves — a **sticky baseline** (freeze prev while
  firing) is the follow-up, deliberate evaluator-semantics change.
- ~~**P2.0b silent arm reachability**~~ — **SHIPPED 2026-08-20**: the
  silent case was structurally unreachable (a down service emits no
  spans → no evaluator row; its alert state machine also froze). The
  evaluator now synthesizes `curr_requests=0` driver rows from the -1h
  service-summary cache (leftanti current window). Proven by synthetic
  blind test; found by the full-suite eval on `paymentUnreachable`.
- **P2.0c lowVolumeMode decision (S, config-only)** — the 2026-08-20
  full suite scored mean 0.48 (normalized ≈0.54); enabling the
  existing P1.2 `lowVolumeMode` flag on the demo workspace un-silences
  the three margin scenarios that never fire (`adFailure` ~4%<5%,
  `llmRateLimitError`, `productCatalogFailure`) → projected mean
  ≈0.75. Tradeoff is precision on noisy real workloads — that's why
  it's a flag. Decision owner: Clint.
- **P2.1 Slope-based latency detection** (L) — the real fix for
  gradual-onset scenarios (`emailMemoryLeak` scored 0.06 surfaces in
  the 2026-08-20 suite; `adHighCpu`/`adManualGc` similar). Alert
  when p95 is above baseline AND the slope over the last 3-5
  buckets is positive. With the p95 arm shipped, this layers slope on
  top; also needed: a traffic-surge arm (`loadGeneratorFloodHomepage`)
  and a look at why `failedReadinessProbe` no longer manifests.
- **P2.2 Seasonality-aware baselines** (L) — day-of-week /
  hour-of-day baselines instead of fixed prior-window. Needs the
  packed-row workaround for the lookup one-row-per-key limit
  (see Blocked on Cribl).
- **P2.3 CI live smoke** (M) — on master merge: deploy to a
  workspace, run `apm-smoke.spec.ts` + the post-reconcile canary.
  **Cribl will provision a dedicated CI workspace for this** —
  isolates CI from the demo cluster and unblocks eval-in-CI later.
- **P2.4 Learned noise baseline (research)** — identify
  (svc, op, status, message-fingerprint) tuples that are a
  steady-state minority over N days and treat them as expected.
  Feeds both alert precision and the Investigator's "we're done"
  stopping rule. Design doc first; the space is large.

## P3 — Adoption: the three trust gaps + trace depth

Table-stakes features every competitor has. v0.10.0 shipped the
deploy-event detection + Investigator context (the foundation of
the "what changed?" RCA story); remaining items finish that and
add user alerts, SLOs, and trace depth.

- **P3.1 User-created alerts + notification dispatch** (XL —
  needs breakdown) — "Create alert" persists a saved search +
  alert definition with notification targets (Slack / PagerDuty /
  email via the product-level targets API). Design:
  `docs/research/alerting-design.md`. Single biggest user-facing
  gap.
- **P3.2 Deploy correlation UI surfaces** (M) — the data pipeline
  (`criblapm__deploy_events`) and Investigator context shipped in
  v0.10.0. Remaining:
  - Service Detail RED-chart markers (vertical lines on Duration
    / Error charts at deploy timestamps).
  - "Deployed Nm before this alert" chip on Detected Issues.
  Both client-side over the already-emitted event stream.
- **P3.3 SLO budgets** (L) — SLO = saved search tracking
  success / total over 28 days + burn-rate alerts at 1h / 6h /
  24h windows. The lingua franca of reliability conversations.
- **P3.4 Flame graph + critical path** (L) — icicle / self-time
  view and critical-path highlighting on Trace detail; latency
  histogram per operation. Client-side over span data we already
  fetch.

## P4 — Moat: what only Cribl can build

- **P4.1 Investigator v2** (L) — auto-seed `knownSignals` when a
  prompt mentions a service (today only Service Detail's button
  seeds them); a "done" criterion using the P2.4 noise baseline so
  the agent can conclude "remaining errors are background";
  deployment events (P3.2) injected as context — **partially done
  in v0.10.0 via the deploy-event preflight injection**. **Design
  note: Cribl's AI Platform will ship a server-side agent runtime
  soon — keep the tool definitions and context builder
  (`agentTools.ts`, `agentContext.ts`) transport-agnostic so the
  loop can migrate from the client to the platform runtime without
  a rewrite.**
- **P4.2 Telemetry cost & noise analytics** (L) — we sit ON the
  pipeline; Datadog sits at the end of it. Page answering: which
  services emit the most span volume, what fraction is idle-wait /
  health-check noise (we already classify it), and what the
  Cribl Stream pipeline change to trim it would be. No competitor
  can close that loop.
- **P4.3 Server-side agent investigations** (XL — spec complete,
  2026-08-10) — when an alert fires, a Durable-Object-hosted agent
  (Worker bundle on celld, pi-agent-core loop against an
  OpenAI-compatible endpoint, Cloudflare Computer for bash/repo
  tools) investigates it autonomously with the same seed as the UI's
  Investigate button, persists the transcript server-side, streams
  progress to the UI as the existing `LoopEvent` union (identical
  rendering via `applyLoopEvent`), and commits
  `record_kind:'investigation'` events to the dataset so the Alerts
  page shows "Investigated" badges and drill-back — without the UI
  ever depending on the cell being up. Off by default behind a
  `serverInvestigations` flag with a cell-side kill switch. Full
  design + 13-PR sequence:
  `docs/research/server-investigations/design.md`.
  - **Entry criteria (spikes, in order): S1** WS-from-iframe CSP,
    **S2** celld viability — **passed 2026-08-10** (all core
    surfaces verified; agent loop must be alarm-driven per the
    300s handler budget; see the design doc's Spike results),
    **S4** notification-target webhook payload; **S3** Cloudflare
    Computer under celld gates only the code-tools phase —
    **reframed 2026-08-10**: it's an in-DO npm package, and only
    its container backend needs Cloudflare proper.
  - Framework dependencies, each independently justified:
    proxies-manifest tooling (RG.5's reviewed-contract test),
    `ProvisionedSearch.schedule.notifications` (needed by P3.1),
    InvestigatorChat view/driver split (needed by P4.1's
    server-runtime migration). PRs 2–5 (injection seams, flag
    plumbing, manifest tooling) are valuable even if the celld bet
    dies — the only write-offs on a failed spike are `cell/` and
    the UI transport shim.

- **P4.4 Incidents & investigation lifecycle** (XL — design complete,
  2026-08-18) — introduce a first-class **Incident** above investigations
  to solve two problems: old investigations never close (need an
  "Archived" shelf — hidden by default, still searchable), and one root
  cause trips alerts across many services (today would spawn N redundant
  investigations against the `MAX_CONCURRENT=1` search pool). An Incident
  is a lightweight **warroom**: a state machine (`open → investigating →
  identified → mitigated → resolved → closed`), a severity, a
  timestamped timeline that agent + humans append to, and an
  auto-generated markdown summary. **Cribl-Search-native and
  cell-independent** — incidents are event-sourced in the dataset
  (`record_kind:'incident'`), grouped by a saved search (window + service
  graph → deterministic `incident_id`), and managed entirely by the app,
  so they work with the server investigator **off**. The investigator,
  when on, is pure enrichment: automated investigations become incident
  children and a supervisor agent authors the root cause. Alerts→incidents
  is standard aggregation (many alerts, one stateful incident;
  all-cleared → resolved; re-fire-while-open → reopen). Archival is lazy
  (a derived `WHERE`, zero background work) with a self-re-arming
  coordinator sweep alarm as "cron" until celld 0.3.0 lands; cron's real
  job is retention (drop transcripts, keep summaries). Coalescing is
  layered: (A) admission-time attach-vs-spawn using the dependency graph
  (`/config/graph`, mirror of `/config/repos`), then (B) an
  agent-of-agents supervisor that correlates concluded investigations into
  an incident-level root cause. Full design + 6-phase sequence (phases 1–3
  ship the cell-independent core; 4–6 are flag-on enrichment):
  `docs/research/server-investigations/incidents-and-lifecycle.md`.
  Cross-refs P4.1 (Investigator v2), P4.3 (server-side investigations),
  P3.1 (alert notifications).
  - **Progress (2026-08-19): Phase 1 started** — the incident event
    contract (`record_kind:'incident'`, `incidentEventCommitQuery`) landed
    in #143.
  - **Progress (2026-08-18 pm): Phase 1 COMPLETE (#146)** — the
    three-search pipeline is live: `criblapm__incident_grouper`
    (attach via lookup + graph adjacency, else open; deterministic
    event ids), `criblapm__incidents_state` (INCREMENTAL fold —
    $vt_results self-read + -1h delta + high-water dedup; derived
    status with debounce/close/reopen), `criblapm__incidents_export`
    (→ `criblapm_incidents` lookup). Read path:
    `listCachedIncidents()` + `Q.incidentEvents()`.
  - **Progress (2026-08-19 overnight): Phases 2A+2B COMPLETE, Phase
    4-lite + poll trigger (#147)** — Incidents section atop the Alerts
    page (no new nav concept; old table renamed Alert Episodes); rich
    `/incident/:id` page (summary narrative, correlated investigations
    with conclusions/transcripts, member episode stats, interleaved
    warroom timeline); human warroom writes (notes, status/severity,
    close/reopen — Playwright-validated round-trip); Investigate-from-
    incident seeds the agent with incident context and commits
    `investigation_linked`. Cell-side: coordinator now POLLS firing
    alerts via a durable alarm — Cribl's notification dispatch broke
    **workspace-wide** ~08-15 (confirmed: Clint's pre-existing ntfy
    notifications also dead; Search-team bug filed). When dispatch is
    fixed the webhook resumes as primary; the poll stays as a free
    dedup-safe backstop. **Poll deploy to celld still pending**
    (`f1be7c9`; handoff with the cell agent).
  - **Progress (2026-08-20): grouping hardened by live soak + eval**
    — adjacency attaches only to OPEN incidents within 60m of onset
    (window W); member refires own reopen; carried state authoritative
    for title/root/opened_at; derived resolution supersedes
    active-state human overrides; all current-state readers keep only
    the latest evaluator run (keepLastN=2 mixing). The 2026-08-20
    full-suite eval exercised the whole loop: cartFailure 0.95 with
    all five incident checks green; investigator root-caused 8/13.
    **Next: Phase 3** (archival polish + daily reconciliation fold),
    **Phase 4 proper** (cell stamps incident_id, attach-vs-spawn
    coalescing, /config/graph), Phases 5–6 (resolved notify,
    supervisor summary_md).

- **P4.5 Materialized read models for hot pages** (M — design 2026-08-18)
  — a perf/architecture principle the codebase is already halfway to
  (panel-cache lookups, the metrics-store migration): **events stay the
  write log / source of truth / audit; hot interactive pages read a
  materialized projection (a lookup), not a live search over history.**
  Classic CQRS read models. The split: *hot + bounded + current-state* →
  lookup (maintained by a scheduled search); *unbounded history / audit*
  → events, searched on demand; *ad-hoc exploration* (traces, logs) →
  live search; *numeric time series* → metrics store (done). This also
  **reduces search-pool load** — the saturation that flaked CI — by
  replacing many unpredictable page-load searches with a few schedulable
  maintainers.
  - **Alerts page** (investigated 2026-08-18): the active table already
    reads a cached scheduled result (`$vt_results`, `-1h`), but the
    "Alert incidents" **history timeline** (`Q.alertHistory`) and the
    investigation badges run **live over 24h of events** on every load.
    The **incident read model (P4.4) subsumes this** — the firing→resolved
    pairing becomes a lookup read. First payoff of P4.4.
  - **Errors page**: only `-1h` + stream-filter is cached; **every longer
    window runs `listErrorClasses` live over raw error spans** (heaviest
    of the lot). Fix: a scheduled **error-class rollup lookup** for the
    common windows (24h), live search only for custom ranges.
  - Guardrails: each maintainer is itself an `export to lookup` search —
    be selective (one lookup per genuinely-hot surface), mind the known
    `export to lookup` KQL traps (`(?i)`/mv-expand corruption, see the
    skill doc), and accept ~cadence staleness + lookup size limits (that's
    why history stays events).
  - **Progress (2026-08-19): Alerts history landed** (#144) — the
    `criblapm__alert_history` scheduled search + panel-cache read removed a
    live 24h search from every Alerts load. **Next:** investigation-events
    badge cache (flag-gated), and the Errors 24h rollup (raw spans →
    incremental / slower-cadence so it doesn't add pool load).

## P5 — Breadth

- **Dashboards** via saved-search composition ("Save this view" on
  Traces / Logs / Metrics / ServiceDetail; widgets composed into a
  page).
- **Service catalog / ownership** — team, oncall, runbook URL per
  service in KV; route alerts by ownership.
- **Database query performance** — top slow queries by fingerprint
  via `db.statement` / `db.system`, linked to traces.
- **Live tail** — streaming logs / spans on the Logs page.

## Future — new signal types

- **Continuous profiling** (eBPF / pprof) · **Real User Monitoring**
  (browser SDK, web vitals, session replay) · **Synthetics**
  (scheduled HTTP + browser checks). Deliberately parked until the
  core earns daily-driver trust.

---

## Blocked on Cribl

- **`(?i)` regex upstream of `| export to lookup` silently corrupts
  the write** — stats report success (`totalEventsOut`,
  `lookupFile`) but the CSV is unjoinable. Found 2026-06-09 via
  `criblapm_trace_originators`; cost us a day. Same family as the
  mv-expand/export incompatibility. Bug report pending; v0.10.0's
  provision guard fences against reintroduction on our side.
- **Lookup-join flap across consecutive queries** — found
  2026-06-23 via the post-reconcile canary. The same identical KQL
  against `criblapm_trace_originators` returns `joined=50` and
  then `joined=0` seconds apart, with no scheduled-search run in
  between. The write side reports success (`totalEventsOut: 6`,
  `totalEventsDropped: 0`). Suspected worker-cache or read-during-
  overwrite race on the lookup CSV. The canary correctly fires
  when this happens; users see the trace-originator-based error
  filter wash in and out. Bug report pending.
- **Metrics: `_metric_name` in wide-column format** — dimensions
  indistinguishable from metric values; we use a blocklist
  workaround. Feature request submitted.
- **`summarize → summarize max(iff(...))`** crashes on real data.
  Workaround: split into searches joined via lookups.
- **`lookup` returns one row per key** — blocks every
  "read a series from a lookup" pattern (drift, daily history,
  seasonality baselines → P2.2). Workaround: pack series into one
  row (N columns or JSON string). Real fix: return all matches.
- **Dynamic field access `attributes[col]` rejected** — forces
  per-attribute KQL generation at provision time (cardinality
  search). Fix: dynamic indexing or `bag_values`.
- **Long-window aggregations (-7d hourly) exceed the 60s job
  timeout** — affects every multi-day-trend feature.
- **Concurrent search queue (`max: 20`)** — improved by Lakehouse
  indexed fields + cadence tuning (shipped), but Investigator
  queries still queue behind scheduled searches at peak. Per-pack
  quota or scheduled-search worker sharing would help.

---

## Things we have that ARE competitive

- **Embedded agentic RCA (Copilot Investigator)** — root-cause-
  correct on 10/11 eval scenarios, pre-filled topology context,
  one click from every surface. Nobody at this price point has it.
  As of v0.10.0 the Investigator also reads recent deploys at
  preflight time so "what changed?" is automatic context.
- **Spotlight** — Honeycomb-BubbleUp-equivalent attribute analysis,
  embedded on Search, Errors, and Service Detail.
- **Server-side alert state machine** — debounce, history in the
  dataset, resolution events, opt-in low-volume mode for thin
  workloads (v0.10.0). Pure-TS extraction + transition tests pin
  the KQL behavior.
- **Messaging edges + edge-level health** on the architecture graph.
- **Noise filter** on trace aggregates (idle-wait / streaming spans).
- **Baseline delta chips**, configurable detection cadence,
  trace-origin classification feeding error filtering.
- **Platform integrity tripwires (v0.10.0)** — provisioning guard,
  post-reconcile canary, golden-file KQL tests on all 40+ query
  builders, framework SHA pin in CI. The June outage chain,
  replayed, fails the deploy loudly at the first step.

---

## Completed (historical reference — see git log / PRs)

### v0.10.0 (2026-06-23) — Platform integrity floor + adoption foundations

The roadmap-rewrite session that closed all of P0 and the first
half of P2 in one push. 12 PRs merged in a single loop. Master
went from 122 tests to 252; ~1,000 lines of dead code removed.

Platform integrity (the entire old P0):
- **Provisioning guard** (PR #72) — pre-reconcile invariant check
  refusing plans with empty datasets, `(?i)` upstream of
  export-to-lookup, or empty lookup names.
- **Post-reconcile canary** (PR #78) — verifies sentinel
  `$vt_results` has rows and a known lookup is joinable.
  **Caught a real Cribl-side lookup-flap bug** — documented in
  PR #82.
- **Golden-file KQL tests for all 42 builders** (PR #79) — snapshot
  drift + provision-guard invariants per builder + coverage
  meta-test that fails on unregistered new exports.
- **Alert state-machine extracted to pure TS** (PR #77) — 14
  transition tests pin the KQL `case()` behavior.
- **Framework SHA pin in CI** (PR #75) — `.framework-sha` recorded
  in-repo, deliberate bumps. Kills the PR #66-class silent
  framework break.

Detection quality:
- **Low-volume mode opt-in** (PR #81) — Settings toggle adds a 4th
  detection arm (`≥2 errors AND ≥1% rate`) for thin workloads.
  Restores llmRateLimit / recommendationCache without taxing busier
  services.
- **Alert noise-budget aggregation** (PR #83) — daily scheduled
  search counting per-(svc, day) fires + persistent vs noisy
  splits. Feeds the eval harness so threshold changes are
  evaluated on precision and recall.

Adoption — deploy / change correlation:
- **Deploy events pipeline** (PR #84) — `criblapm__deploy_events`
  scheduled search detects `(svc, version)` transitions every
  30 min and emits events via `| send` to the dataset.
- **Investigator deploy context** (PR #85) — preflight reads recent
  deploys (-2h) and seeds them as `knownSignals` so the LLM
  reasons about deploy correlation alongside silent / rate-drop /
  error-spike hypotheses.

Quick wins:
- **Surfaced 3 swallowed exceptions** (PR #74) — agentPreflight,
  agentTools.parseArgs, notificationTargets no longer fail silently.
- **Deleted dead `spanmetrics*` builders** (PR #76) — -198 lines,
  zero callers.
- **Deleted legacy `HomePage.tsx`** (PR #80) — -829 lines, never
  routed.
- **Documented lookup-flap as Blocked on Cribl** (PR #82).

### Detection-quality program, rounds 1–5 (v0.9.0 → v0.9.1) — DONE
The 2026-05-30 → 06-01 eval grind (old roadmap items 1a–1i): -15m
evaluator window with traffic normalization (PR #60), stable
alert_id so resolutions emit (PR #58), latency floor + absolute
error-count paths (PR #62), low-volume floor + badge polling
(PR #64), then the production reversal to precision-tuned
thresholds — ≥5% absolute, or ≥3× baseline at ≥2%, or ≥10 errors
on a previously-clean service (PRs #67/#69) after real-traffic
noise proved the eval-driven floors over-sensitive. Eval mean
0.66 → 0.78 reconstructed; fully-detected 1 → 6. Remaining gaps
(slope detection, low-volume) carried into P2. Session logs:
`docs/sessions/2026-05-30-eval-v0.9.0.md` through
`2026-05-31-eval-fourth.md`.

### Search-worker performance program — DONE
Lakehouse indexed fields provisioned (service_name, status_code,
kind, name, parent_span_id) + dataset-ruleset flattening, cadence
tuning, search consolidation. Queue waits no longer block the
Investigator in steady state. Plan:
`docs/research/search-perf-plan.md`.

### Framework extraction + outage hardening (2026-06) — DONE
Shared primitives moved to `cribl-search-app-framework`
(dataset store, provisioner, banners, deploy tooling; framework
PRs #9–#13, APM #66). The dataset="" outage chain diagnosed and
fixed: provision-time default (PR #68), browser-side race +
threshold re-apply (PR #69), (?i)-export corruption (PR #70).
v0.10.0's platform-integrity work exists so this class can't
recur silently.

### Faceted trace search + Spotlight (v0.9.0) — DONE
PRs #46–#55: typed filter builder, facets panel, Spotlight engine
(volume-weighted L∞ scoring), embedded SpotlightSection, KQL
escape hatch, streaming facet queries. Four visual iterations to
the final rate-bar design. `docs/sessions/2026-05-28-faceted-nav.md`.

### Settings reorganization (PR #56) · Navigation overhaul +
Overview/Errors/Alerts pages (PR #30) · AI Investigator (PR #14)
· Eval harness + 17-scenario matrix (PRs #19–#23) · Metrics
wide-column migration (PR #24) · Metrics explorer · Durable
baselines + panel caching · Core APM surfaces (catalog, search,
logs, compare, arch graph, service detail, trace detail) ·
Playwright e2e framework — all DONE; details in git history and
`docs/sessions/`.
