# Cribl APM — Roadmap

This document is the canonical priority list for the Cribl APM
Search App. Rewritten 2026-06-11 from the full repo audit
(`docs/sessions/` has the history) plus the competitive gap analysis
against Datadog, New Relic, Dynatrace, Honeycomb, and Grafana Cloud.

> **Refer to this doc as `ROADMAP.md`** (or `/ROADMAP.md` from the repo
> root). Companion docs: `FAILURE-SCENARIOS.md` for the flagd flag
> catalog and test plan; `CLAUDE.md` for repo-wide coding rules;
> `AGENTS.md` for the Cribl App Platform developer guide.

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

## Strategic posture

Three moves, in order:

1. **Tripwires first (P0)** — one focused effort so silent outages
   stop burning days.
2. **Adoption features (P1–P2)** — detection quality measured on
   both precision and recall, then user alerts, SLOs, and change
   correlation. These convert "impressive demo" into "daily driver"
   for the first external users (arriving soon).
3. **Moat (P3)** — the Investigator and Cribl-native capabilities
   (field mapping, telemetry cost analytics) that competitors
   structurally cannot copy because they don't sit on the pipeline.

---

## P0 — Platform integrity (do first, ~1 week)

Rationale: the 2026-06-09/10 outage chain. A latent framework change
(dataset store defaulting to `""`) shipped through green CI, the
provisioner pushed `dataset=""` into 17 saved searches and reported
success, `mode=overwrite` exports wiped two lookups, and a separate
latent bug (`(?i)` regex upstream of `export to lookup` writes an
unjoinable CSV while reporting success) prevented self-healing.
Three silent-failure layers, zero tripwires, all found in production.

- **P0.1 Provisioning guard** (S) — before reconcile, assert every
  plan query: non-empty `dataset="…"` clause, no `(?i)` upstream of
  `export to lookup`, non-empty lookup names. Exit 1 loudly.
  `scripts/provision.ts`; upstream to `@cribl/app-utils` after.
- **P0.2 Post-reconcile canary** (M) — after apply, read one row
  from `$vt_results` for sentinel searches and join-test one lookup.
  Tolerate empty only with `--first-install`.
- **P0.3 Golden-file KQL tests** (M) — snapshot every exported
  builder in `src/api/queries.ts` (40+, zero tests today) with
  invariant assertions (dataset clause present, escaping applied,
  no `(?i)` in export queries). The June outages become 3-line
  negative tests. Also regression-tests the dataset-default bug.
- **P0.4 Alert state-machine tests** (M) — extract the transition
  table (`ok → pending → firing → resolving → ok`, FIRE_AFTER=2,
  CLEAR_AFTER=3) to a pure TS function mirroring the KQL `case()`;
  test all transitions; keep KQL in sync via snapshot.
- **P0.5 Framework SHA pin** (S) — CI clones
  `cribl-search-app-framework` at a SHA recorded in-repo, bumped
  deliberately. PR #66's latent break is the rationale.

Quick wins alongside: delete dead `spanmetrics*` builders
(queries.ts ~1739-1962) and legacy `HomePage.tsx` (~1,000 lines
total); surface the three swallowed exceptions
(`agentPreflight.ts:102`, `agentTools.ts:107`,
`notificationTargets.ts:32`); add a check for backticks inside
template-literal comments (bit us twice).

**Done =** the June outage chain, replayed, fails the deploy loudly
at the first step.

## P1 — Detection quality, two-sided

The eval harness optimizes recall on chaos scenarios; production
needs precision on real traffic. Thresholds whiplashed from
"fires at 1% background noise" to production-tuned (PR #67/#69)
because only one side was measured. Detection changes now ship with
both numbers.

- **P1.1 Noise budget** (M) — scheduled search counting
  firing-hours per service per week on flag-off traffic; publish
  alongside eval recall in every eval report. This is the
  acceptance metric for all threshold changes.
- **P1.2 Low-volume mode** (S) — Settings toggle re-enabling the
  ≥2-error path per service, for low-traffic environments where
  chaos-level sensitivity is wanted. Off by default. Restores
  llmRateLimit / recommendationCache detection without taxing
  everyone (the old 1f debate, resolved as opt-in).
- **P1.3 Slope-based latency detection** (L) — the real fix for
  gradual-onset scenarios (emailMemoryLeak stuck at 0.30 across
  four evals; threshold loosening provably insufficient). Alert
  when p95 is above baseline AND the slope over the last 3-5
  buckets is positive.
- **P1.4 Seasonality-aware baselines** (L) — day-of-week /
  hour-of-day baselines instead of fixed prior-window. Needs the
  packed-row workaround for the lookup one-row-per-key limit
  (see Blocked on Cribl).
- **P1.5 CI live smoke** (M) — on master merge: deploy to a
  workspace, run `apm-smoke.spec.ts` + the P0.2 canary.
  **Cribl will provision a dedicated CI workspace for this** —
  isolates CI from the demo cluster and unblocks eval-in-CI later.
- **P1.6 Learned noise baseline (research)** — identify
  (svc, op, status, message-fingerprint) tuples that are a
  steady-state minority over N days and treat them as expected.
  Feeds both alert precision and the Investigator's "we're done"
  stopping rule. Design doc first; the space is large.

## P2 — Adoption: the three trust gaps + trace depth

Table-stakes features every competitor has, each a thin layer over
Cribl primitives we already use. Ordered for the first external
users.

- **P2.1 User-created alerts + notification dispatch** (XL —
  break down) — "Create alert" persists a saved search + alert
  definition with notification targets (Slack/PagerDuty/email via
  the product-level targets API). Design:
  `docs/research/alerting-design.md`.
- **P2.2 Deployment / change correlation** (L) — "what changed?"
  is the first RCA question and we have nothing; `service.version`
  is already on resource attributes. MVP: scheduled search detects
  version transitions per service → `criblapm_deploy` events via
  `| send` (same pattern as alert history) → markers on Service
  Detail RED charts, "deployed 12m before this alert" chip in
  Detected Issues, and injection into Investigator `knownSignals`.
  No SCM integration needed for v1.
- **P2.3 SLO budgets** (L) — SLO = saved search tracking
  success/total over 28 days + burn-rate alerts at 1h/6h/24h
  windows. The lingua franca of reliability conversations.
- **P2.4 Flame graph + critical path** (L) — icicle/self-time view
  and critical-path highlighting on Trace detail; latency histogram
  per operation. Client-side over span data we already fetch.

## P3 — Moat: what only Cribl can build

- **P3.1 Field mapping + per-signal datasets** (near-term, elevated)
  — two forcing functions arrived: (a) metrics support is landing
  now and **metrics and logs may live in different datasets than
  traces**, (b) schema-agnostic APM (the long-term vision) starts
  with the same abstraction. Step 1: replace the single
  `getCurrentDataset()` with per-signal resolution
  (`datasetFor('traces' | 'logs' | 'metrics')`) threaded through
  queries.ts and the provisioner; Settings grows one field per
  signal type. Step 2: `fieldResolver(signal, 'service.name')`
  behind one query builder to validate the abstraction. Step 3:
  mapping editor UI + LLM-assisted mapping suggestions + an
  Investigator `create_field_mapping` tool. Full vision retained
  from the prior roadmap §11 — incremental rollout, one builder at
  a time.
- **P3.2 Investigator v2** (L) — auto-seed `knownSignals` when a
  prompt mentions a service (today only Service Detail's button
  seeds them); a "done" criterion using the P1.6 noise baseline so
  the agent can conclude "remaining errors are background";
  deployment events (P2.2) injected as context. **Design note:
  Cribl's AI Platform will ship a server-side agent runtime soon —
  keep the tool definitions and context builder
  (`agentTools.ts`, `agentContext.ts`) transport-agnostic so the
  loop can migrate from the client to the platform runtime without
  a rewrite.**
- **P3.3 Telemetry cost & noise analytics** (L) — we sit ON the
  pipeline; Datadog sits at the end of it. Page answering: which
  services emit the most span volume, what fraction is idle-wait /
  health-check noise (we already classify it), and what the
  Cribl Stream pipeline change to trim it would be. No competitor
  can close that loop.

## P4 — Breadth

- **Dashboards** via saved-search composition ("Save this view" on
  Traces/Logs/Metrics/ServiceDetail; widgets composed into a page).
- **Service catalog / ownership** — team, oncall, runbook URL per
  service in KV; route alerts by ownership.
- **Database query performance** — top slow queries by fingerprint
  via `db.statement` / `db.system`, linked to traces.
- **Live tail** — streaming logs/spans on the Logs page.

## Future — new signal types

- **Continuous profiling** (eBPF/pprof) · **Real User Monitoring**
  (browser SDK, web vitals, session replay) · **Synthetics**
  (scheduled HTTP + browser checks). Deliberately parked until the
  core earns daily-driver trust.

---

## Blocked on Cribl

- **`(?i)` regex upstream of `| export to lookup` silently corrupts
  the write** — stats report success (`totalEventsOut`,
  `lookupFile`) but the CSV is unjoinable. Found 2026-06-09 via
  `criblapm_trace_originators`; cost us a day. Same family as the
  mv-expand/export incompatibility. Bug report pending; P0.1 guards
  against reintroduction on our side.
- **Lookup-join flap across consecutive queries** — found 2026-06-23
  via the P0.2 canary. The same identical KQL against
  `criblapm_trace_originators` returns `joined=50` and then
  `joined=0` seconds apart, with no scheduled-search run in between.
  The write side reports success (`totalEventsOut: 6`,
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
  seasonality baselines → P1.4). Workaround: pack series into one
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
- **Spotlight** — Honeycomb-BubbleUp-equivalent attribute analysis,
  embedded on Search, Errors, and Service Detail.
- **Server-side alert state machine** — debounce, history in the
  dataset, resolution events. Most cheaper APMs don't have this.
- **Messaging edges + edge-level health** on the architecture graph.
- **Noise filter** on trace aggregates (idle-wait/streaming spans).
- **Baseline delta chips**, configurable detection cadence,
  trace-origin classification feeding error filtering.

---

## Completed (historical reference — see git log / PRs)

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
(slope detection, low-volume) carried into P1. Session logs:
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
P0 exists so this class can't recur silently.

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
