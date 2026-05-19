# Search performance plan — reclaiming worker headroom

**Status:** Investigation + plan, no code yet.
**Last updated:** 2026-05-19

## Why this is priority #1

The 2026-05-12 / 2026-05-19 sessions made the failure mode
unambiguous: live Investigator queries against staging routinely
wait ~56-57s for the cluster to dequeue them — and many time out
before completing. Every multi-turn investigation runs out of
per-turn budget before reaching a conclusion. The
`leakFingerprint` eval transcripts (see
`docs/sessions/2026-05-12-...md`) are the concrete evidence: the
agent followed the playbook precisely and still couldn't get data
back.

The proximate cause is the workspace's `max: 20` concurrent
search-job quota, combined with this pack's 16 scheduled
searches. The deeper cause is that every span-scanning query
parses JSON-nested fields to evaluate filters and group-by keys
— there is no top-level column shortcut available. That makes
each query expensive in worker-time, so even at modest cadence
the queue stays full.

Two orthogonal wins are available. The plan below sequences them.

## What Cribl actually offers (as of May 2026)

- **Dataset Acceleration (the prescan feature)** — **deprecated**;
  removed from 4.12.2. Was an opt-in metadata prescan. Not the
  long-term answer.
- **Cribl Lakehouse + Indexed Fields** — the supported successor.
  Each Lake Dataset can have **up to 5 Lakehouse-indexed fields**
  and **up to 3 partitions**. Indexed fields get extra metadata
  that the search planner uses to prune Parquet files and column
  chunks.
- **Parquet predicate pushdown** — independent of Lakehouse. When
  events arrive at Lake as parsed, structured data with multiple
  **top-level** fields (not buried inside `_raw` or nested
  objects), the Parquet writer stores min/max statistics per
  column per row group. The search planner uses those to skip
  row groups whose statistics rule out a match. The effect is
  most visible on filters and high-selectivity group-bys.

These two features compose. Indexed fields are a stricter subset
of "top-level fields" (5 of them, plus extra metadata).
Predicate-pushdown wins are unbounded by count — every top-level
field benefits.

References:
- [Cribl docs — Manage Lake Datasets (Lakehouse)](https://docs.cribl.io/lake/managing-datasets/)
- [Cribl docs — Structure Events for Cribl Lake](https://docs.cribl.io/lake/structuring-events/)
- [Cribl blog — Parquet Pushdowns: Smooth Like Butter](https://cribl.io/blog/cribl-search-parquet-pushdowns-smooth-like-butter/)
- [Cribl docs — Dataset Acceleration (deprecated)](https://docs.cribl.io/search/acceleration/)

## Today's predicate inventory (from `src/api/queries.ts`)

Counts are uses per file (predicate, group-by, project-as-rename
all aggregated):

| Field path today | Uses | Used as predicate / group-by? |
|---|---:|---|
| `resource.attributes['service.name']` | 28 | yes — almost every query filters or groups by service |
| `name` (span name / operation) | ~10 as predicate, ~160 projections | yes — grouping, sorting, error-class signature |
| `status.code` | many | yes — `== "2"` is the universal error predicate |
| `trace_id` | 23 | yes — trace scoping, self-join keys |
| `kind` | 19 | yes — server/client/internal filtering |
| `end_time_unix_nano` | 19 | yes — `isnotnull(...)` is the "is this a span?" filter |
| `parent_span_id` | 12 | yes — root-detection, propagation walk |
| `span_id` | 9 | yes — self-join keys |
| `attributes['rpc.grpc.status_code']` | 3 | yes — error-class filter rules |
| `attributes['http.response.status_code']` | 3 | yes — error-class filter rules |
| `resource.attributes['k8s.pod.name']` | 2 | yes — pod-uptime, instance metrics |
| `attributes['messaging.system']` | 2 | yes — trace-originator classifier |
| `resource.attributes['k8s.pod.start_time']` | 1 | yes — leak-fingerprint uptime |

The top five by predicate weight are `service.name`,
`status.code`, `kind`, `name`, and `parent_span_id`. Those are
the indexed-fields picks if/when we move `otel` onto a Lakehouse.

## The plan

### Phase 1 — instrument the load (no code change)

Before we move anything, get baseline numbers. Cribl Search has a
metrics page that should show the search queue depth and per-job
timings; pull a 24h sample and identify the top 3 worst
offenders. Probable suspects from inspection:
- `criblapm__op_baselines` — runs hourly over **-24h**, daily
  bins. Expensive.
- `criblapm__error_rate_daily` — runs hourly over **-7d**, daily
  bins. Confirmed ~60-70s observed.
- `criblapm__home_alerts` group — three searches running every 5m
  on -1h, joining lookups.

Deliverable: a small `docs/research/search-perf-baseline.md`
snapshot listing the queue-depth distribution and the top 10
heaviest scheduled searches over a 24h window. The phases below
get scored against this baseline.

### Phase 2 — cadence + window audit (in-repo change, no Cribl change)

Cheapest win. Edit `getProvisioningPlan()` in
`src/api/provisionedSearches.ts`:

| Search | Today | Proposed | Reason |
|---|---|---|---|
| `criblapm__trace_originators` | every 5m, -5m window | **hourly**, -15m window | Originator type changes ~never; 5m updates are wasted work. |
| `criblapm__metric_catalog` | every 5m, -1h | **hourly**, -1h | Metric names rarely appear/disappear within the hour. |
| `criblapm__svc_operations` | every 5m, -1h | **every 15m**, -15m | Op list moves slowly, panel reads tolerate 15m staleness. |
| `criblapm__attr_catalog` | hourly, -5m | keep | Already hourly. |
| `criblapm__op_baselines` | hourly, -24h | keep | Rolling baseline is the point. |
| `criblapm__error_rate_daily` | hourly, -7d | **every 6h**, -7d | Daily history only needs ~daily refresh; 6h covers same-day deploys. |
| `criblapm__home_alerts*` (3 searches) | every 5m, -1h | keep | Alert latency is the headline UX. |

Expected impact:
- Cuts steady-state cadence load by ~50% for the three slowed-down
  panels (they were each firing 12× per hour; would fire 1× per
  hour combined).
- Frees ~3 worker-slots per minute for ad-hoc / Investigator use.

Risk: panels become up-to-15m-stale instead of up-to-5m-stale. For
operator-facing dashboards that's fine; the alert pipeline doesn't
slow.

Implementation: bounded edit, single PR, deployable today.

### Phase 3 — consolidate searches that share input

Today these scheduled searches all scan the -1h span window every
5 minutes and each emits ONE lookup:
- `home_service_summary` → service-level aggregate
- `sysarch_dependencies` → parent→child edge counts
- `sysarch_messaging_deps` → messaging edges
- `svc_operations` → per-(svc, op) summaries

They all read the same input but the `| export` operator consumes
rows, so we can't naively merge them. Two consolidation paths:

**A. Wide aggregation → cached $vt_results → emit searches.**
Land all the aggregations the panels need in **one** search
output stored in `$vt_results` (Cribl's per-search-cache). Then
the lookups become small derived emit-only searches that read
from `$vt_results` rather than spans. This pattern already exists
in the alert pipeline (`alertEvaluator` reads from
`$vt_results` of `home_service_summary`). Apply to the rest.

**B. Where multiple lookups must be maintained**, accept the
duplication but cache the heavy aggregation. The lookup-emit
searches join the cache rather than re-scanning.

The candidate cluster (4 searches → 1 scan + 4 emit-only
searches) saves 3 full span scans every 5 minutes — that's the
biggest single load reduction available without changing the
dataset.

Implementation: one PR per consolidation cluster (alert pipeline
already proves the pattern works). Per-cluster effort: small.

### Phase 4 — Parquet top-level fields at ingest

Coordinate with whoever owns the Cribl Stream ingest pipeline
for the `otel` dataset:

- Today: events arrive with `service.name` etc. nested under
  `resource.attributes`. Filters in queries.ts have to walk into
  that nested object every time.
- Proposed: a Stream pipeline that promotes the predicate-hot
  fields to top-level columns at ingest time. Per Cribl's
  guidance, Parquet pushdown only fires when the field is a
  top-level column in the parquet schema.

The fields to promote (matching the predicate inventory above):
`svc` (from `resource.attributes['service.name']`),
`error_status` (from `status.code`),
`span_kind` (from `kind` — already mostly top-level),
`op` (from `name` — already top-level),
`parent_span_id` (already top-level).

The other JSON-nested fields stay nested; they're either
infrequently filtered (`http_status`, `grpc_status`) or
already-top-level (`trace_id`, `span_id`, the time fields).

Implementation: Stream pipeline change, not in this repo. Out of
scope for the APM team to write, but blockable on Cribl-side
work. Track as a coordinated task.

Once the promoted fields exist, **Phase 5** changes the queries
to reference them by their top-level path. Most of the
`tostring(resource.attributes['...'])` boilerplate disappears.

### Phase 5 — query refactor to use top-level fields

Once the ingest pipeline promotes the chosen fields:

- `src/api/queries.ts` gets a `fieldRef('service.name')`-style
  resolver that returns either `svc` (when promoted) or
  `tostring(resource.attributes['service.name'])` (legacy
  fallback). The resolver reads a config that says which fields
  are promoted for the current deployment.
- Heavy queries get rewritten to use the resolver. Reduces
  per-row CPU and unlocks predicate pushdown.

Implementation: bigger PR; touches every query builder. Worth
doing in one shot since the test surface is broad.

### Phase 6 — Lakehouse migration with 5 indexed fields

After Phase 5 lands and queries reference top-level fields,
migrate the `otel` Lake Dataset to a Lakehouse and configure
indexed fields:

1. `svc` (was `service.name`) — primary
2. `error_status` (was `status.code`) — error predicate
3. `span_kind` (was `kind`) — span-kind filter
4. `op` (was `name`) — operation grouping
5. `parent_span_id` — root detection + propagation walk

Three partitions are also available; the obvious candidates are
`svc`, and the resource-level `k8s.namespace.name` (low
cardinality, frequent operator filter when running multi-tenant).
Third partition is open — possibly `service.instance.id` for
per-pod queries, but pod cardinality grows.

Implementation: Cribl-side migration; pack ships a doc + a
provisioning checklist.

### Phase 7 — re-measure

After each phase ships, re-run the baseline measurement from
Phase 1 and update `docs/research/search-perf-baseline.md`. The
real success metric is **the leakFingerprint eval reaching ≥ 0.85
without playbook changes** — meaning the Investigator gets its
queries through. Today it's 0.70 because the agent can't pull
data; the playbook is already correct.

## What we explicitly chose not to pursue

- **In-app query cache.** Tempting (cache Investigator-issued
  queries by hash + window) but adds a stale-data foot-gun and
  doesn't fix the underlying expense. The Cribl-side wins are
  bigger.
- **Sharding the workspace.** Splitting the cluster into two
  workspaces lets us trade one queue for two — but the operator
  experience is one workspace per environment, and splitting
  breaks federated queries. Last resort.
- **Replacing Cribl Search.** Out of scope; this is the platform
  the app runs on. The plan is to use it efficiently, not
  replace it.

## Sequencing call

Phases 1–3 are in-repo and ship in days. They reclaim enough
queue headroom that Phase 4–6 (Cribl-side changes) become
optional rather than urgent — which matters because Cribl-side
changes need coordination outside the team. Recommendation:

1. Phase 1 (instrument) — this week.
2. Phase 2 (cadence audit) — same PR or stacked behind it.
3. Phase 3 (consolidate scans) — within two weeks.
4. Re-measure. If the eval reaches ≥ 0.85, hold Phases 4–6.
5. If still queue-bound, schedule the Cribl-side work.
