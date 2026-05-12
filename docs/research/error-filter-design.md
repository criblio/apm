# Error filter design — separating user-caused from service-caused errors

**Status:** Design — no code yet.
**Last updated:** 2026-05-12

## Problem statement

The Home page's "Error classes" panel shows raw spans where
`status.code == ERROR`. In practice this is dominated by two kinds
of noise:

1. **Caller-fault errors** that aren't actionable for operators — a
   user typing a bad URL, a request with an expired session, a
   missing-product lookup. The OTel/gRPC spec calls these out as
   client-side (HTTP 4xx, gRPC `INVALID_ARGUMENT`, `NOT_FOUND`,
   `UNAUTHENTICATED`, etc.).
2. **Error propagation up the call chain.** A single originating
   error in a leaf service becomes one row at every layer above
   it (CLIENT span on the caller, SERVER span on the proxy, etc.).
   Nine `Product Not Found` events became ~160 derived rows in a
   1-hour snapshot of staging.

Naive filtering by status code is wrong because **the same status
code means opposite things depending on who initiated the trace.**
A `404` from a user's browser is "user typed a bad URL." A `404`
from an internal cron job calling `GetProduct(stale_id)` is a
software bug — the cache or upstream sync is broken. A flat
"drop all 4xx" rule hides real incidents.

The filter has to be aware of whether the trace was originated
by a user or another service. None of this should be tied to the
OpenTelemetry demo specifically.

## Background — what exists today

- `src/api/queries.ts:565` — `Q.rawRecentErrorSpans()` selects
  spans where `status.code == "2"`. No semconv filtering.
- `src/api/search.ts:373` — `groupErrorClasses()` dedupes by
  `(service, operation, first-line-of-message)`. Pure function,
  no filter hook today.
- `src/routes/HomePage.tsx` — fetches via `listErrorClasses()`,
  renders in `TraceClassList` with `mode="errors"`.
- `src/api/provisionedSearches.ts` — declarative scheduled-search
  list; lookup tables are produced via `| export mode=overwrite
  to lookup <name>` (see the alert-prev and op-baseline searches
  for the canonical patterns).

## Goals

- Drop expected user-caused errors so the panel surfaces real
  problems by default.
- Keep service-caused errors visible — same status codes,
  different meaning.
- Zero required configuration on a new install: classification
  picks up trace originators automatically.
- Allow manual override when classification is wrong or when
  defaults need tuning per app.
- Stay generic — no OTel-demo-specific service names anywhere.

## Non-goals

- Propagation deduplication (the "9 → 160 rows" issue).
  Orthogonal to origin classification and likely much less
  urgent once originator noise is dropped — when the
  originating error is filtered, the propagation chain
  disappears with it.
- Per-trace root-cause analysis. The Investigator handles
  that.
- A general-purpose alerts/anomalies engine. This is a panel
  filter, nothing more.

## Design

The unit of classification is **the trace**, not the service.
Three pieces:

1. **A trace-originator classifier** — a scheduled search that
   inspects each captured trace's root span and decides whether
   the originator was a user (real or synthetic) or a service
   (cron job, queue consumer, scheduled task). Result lands in
   a lookup keyed by root-span service.
2. **A per-error tagging step** — at query time, every error
   span gets a `trace_origin` column derived from its trace's
   root, via a small in-query join.
3. **A filter-rules engine** — pure function that drops rows
   matching configured rules. Each rule is scoped to a
   `trace_origin` so a "drop HTTP 4xx" rule applies only to
   user-driven traces.

### Trace-originator classification

**Definition.** For each captured trace, find the *root span* —
the one with empty `parent_span_id`. The root span's
**service** is the trace originator. We classify each observed
originator service as one of:

- `user` — a real user, a synthetic user (load generator),
  or anything that emits user-like context into the root
  span. Errors in traces originating here are filtered using
  the user-fault rules.
- `service` — a scheduled task, queue consumer, cron job, or
  internal worker. Errors here are surfaced regardless.
- `unknown` — root span lacks distinguishing signals, or
  detection hasn't seen enough traffic from this originator.
  Surfaced (conservative).

**Classification signals**, in priority order (revised after
Phase 0 v2 validation against staging — the *value* of the
user-agent matters, not just its presence):

1. **`http.user_agent` matches a browser regex** —
   `Mozilla|Chrome|Safari|Firefox|Edge|Opera` ⇒ `user`.
   Strongest positive signal for real users; only browsers
   emit these strings.
2. **`http.user_agent` matches a known load-test regex** —
   `k6|locust|jmeter|gatling|wrk|ab/|loadgen` ⇒ `user`
   (synthetic).
3. **`http.user_agent` matches a probe regex** —
   `kube-probe|go-http-client|healthcheck|liveness|readiness`
   ⇒ `service` (infrastructure check, not a real user).
   This is the bite Phase 0 v2 found: image-provider has
   100% user-agent coverage on roots, but they're kubelet
   probes, not users.
4. **`messaging.system` populated** — root came from a queue
   (Kafka, RabbitMQ, etc.) ⇒ `service`.
5. **Span name patterns indicating synthetic-user
   instrumentation** — names matching
   `(?i)(^|_)(user|browse|view|checkout|cart|search)(_|$)`
   ⇒ `user`. Catches the OTel-demo load-generator pattern
   (`user_browse_product`, `user_view_cart`) and matches
   the conventions of typical custom user-flow instrumentation.
6. **Span name patterns indicating scheduled/worker code** —
   names matching `(?i)(^|_)(tick|cron|consume|process|poll|worker|job|task)(_|$)`
   ⇒ `service`.
7. **Fallback** — `unknown`. Surface a confirmation prompt in
   Settings ("Auto-detected `cart-worker` — confirm origin?")
   rather than guessing. Unknown stays unfiltered.

**Query sketch:**

```kql
dataset="otel"
| where isnotnull(end_time_unix_nano)
| where tostring(parent_span_id) == ""
| extend svc=tostring(resource.attributes['service.name']),
         ua=tostring(attributes['http.user_agent']),
         msg_sys=tostring(attributes['messaging.system']),
         span_name=tostring(name)
| extend ua_browser=(ua matches regex "(?i)(mozilla|chrome|safari|firefox|edge|opera)"),
         ua_loadtest=(ua matches regex "(?i)(k6|locust|jmeter|gatling|wrk|ab/|loadgen)"),
         ua_probe=(ua matches regex "(?i)(kube-probe|go-http-client|healthcheck|liveness|readiness)"),
         has_msg=isnotempty(msg_sys),
         name_user=(span_name matches regex "(?i)(^|_)(user|browse|view|checkout|cart|search)(_|$)"),
         name_service=(span_name matches regex "(?i)(^|_)(tick|cron|consume|process|poll|worker|job|task)(_|$)")
| summarize total=count(),
            n_browser=countif(ua_browser),
            n_loadtest=countif(ua_loadtest),
            n_probe=countif(ua_probe),
            n_msg=countif(has_msg),
            n_name_user=countif(name_user),
            n_name_service=countif(name_service)
      by svc
| extend type=case(
      todouble(n_browser+n_loadtest)/todouble(total) >= 0.5, "user",
      todouble(n_probe)/todouble(total) >= 0.5, "service",
      todouble(n_msg)/todouble(total) >= 0.5, "service",
      todouble(n_name_user)/todouble(total) >= 0.5, "user",
      todouble(n_name_service)/todouble(total) >= 0.5, "service",
      "unknown")
| where total >= 10
| project svc, type, total,
          n_browser, n_loadtest, n_probe, n_msg,
          n_name_user, n_name_service
| export mode=overwrite
         description="Cribl APM - auto-detected trace originators"
         to lookup criblapm_trace_originators
```

The lookup is keyed on `svc`, the root service. The signal-count
columns get displayed in Settings so the user can see *why*
something was classified the way it was — and override if the
classification doesn't fit their deployment.

**Cadence.** Every 5 minutes over a rolling 5-minute window —
small enough that the query stays fast even with no `leftouter`
joins, and frequent enough that brand-new originators get
classified within minutes. (Earlier sketches used a wider
window; see "Design history" at the bottom for why we don't.)

**Seed.** A `seedQuery` entry in `SEED_LOOKUPS` so the lookup
exists before consumers join to it. Initial row is a sentinel
(`svc="__init__", type="unknown"`).

### Per-error tagging at query time

`Q.rawRecentErrorSpans()` evolves to two-step: pre-compute the
per-trace originator, then left-join to errors.

```kql
let trace_origins = dataset="otel"
    | where isnotnull(end_time_unix_nano)
    | where tostring(parent_span_id) == ""
    | extend root_svc=tostring(resource.attributes['service.name'])
    | project trace_id, root_svc
    | lookup criblapm_trace_originators on root_svc;

dataset="otel"
| where isnotnull(end_time_unix_nano)
| extend svc=tostring(resource.attributes['service.name']),
         span_kind=tostring(kind),
         msg=tostring(status.message),
         http_status=toint(attributes['http.response.status_code']),
         grpc_status=toint(attributes['rpc.grpc.status_code']),
         is_error=(tostring(status.code)=="2")
| where is_error
| join kind=leftouter trace_origins on trace_id
| extend trace_origin=coalesce(type, "unknown")
| sort by _time desc
| project _time, svc, name, span_kind, http_status, grpc_status,
          msg, trace_id, trace_origin, root_svc
| limit 300
```

The right side of the join is one row per trace, not per
span — small enough to avoid the `leftouter` truncation that
defeated the earlier topology approach.

### Per-row classifier

`src/api/errorFilter.ts` (new file):

```ts
export type TraceOrigin = 'user' | 'service' | 'unknown';

export interface ErrorRow {
  service: string;
  operation: string;
  message: string;
  trace_id: string;
  span_kind: string;
  http_status?: number;
  grpc_status?: number;
  trace_origin: TraceOrigin;
  root_svc?: string;
}
```

`trace_origin` arrives pre-computed from the query. The
classifier function is trivial in this design — the heavy
lifting moved to the scheduled search. The TS file's real
job is housing the filter-rules engine and the pure-function
matchers.

### Filter-rules engine

```ts
export interface ErrorFilterRule {
  id: string;
  description: string;
  scope: TraceOrigin | 'any';
  match: ErrorRowMatcher;  // attribute equals/in, message regex, etc.
}

export function applyFilterRules(
  rows: ErrorRow[],
  rules: ErrorFilterRule[],
): { kept: ErrorRow[]; droppedBy: Record<string, number> }
```

**Default rules shipped:**

| `id` | `scope` | `match` | Reason |
|---|---|---|---|
| `user-trace-http-4xx` | `user` | `http.response.status_code` ∈ [400, 499] | Real or synthetic user got a 4xx — typo, expired session, missing page. Filter. |
| `user-trace-grpc-client-fault` | `user` | `rpc.grpc.status_code` ∈ {3, 5, 6, 7, 11, 16} | gRPC-spec client faults — INVALID_ARGUMENT, NOT_FOUND, ALREADY_EXISTS, PERMISSION_DENIED, OUT_OF_RANGE, UNAUTHENTICATED. Same logic at the user edge. |
| _(no defaults at `scope: 'service'`)_ | | | Every error in a service-initiated trace is signal — broken cache, stale config, mesh-auth failure. Surface them. |
| _(no defaults at `scope: 'unknown'`)_ | | | Don't filter what we can't classify. |

User-authored rules can target `scope: 'any'` for explicit
cross-cutting patterns (e.g. an allowlist by message regex
applied regardless of origin).

### Persistence + override

Filter rules and originator overrides live in the same app-config
KV namespace as the dataset name. Override knobs:

- **`forceUserOriginators: string[]`** — services to treat as
  user-origin regardless of detection. For brand-new
  originators detection hasn't seen yet, or auto-detection
  borderline cases.
- **`forceServiceOriginators: string[]`** — services to treat
  as service-origin. Use cases: a synthetic monitor that emits
  `http.user_agent` but represents service traffic from the
  team's perspective; a deployment-shape-specific signal that
  detection can't see.

Resolution: lookup row → KV override (if present, wins).
Stored as small lists, applied client-side after the join.

## Integration plan

1. **Classification search** — author the originator KQL, run
   it ad-hoc via the Cribl MCP, hand-verify the output
   (load-generator → user, future cron jobs → service). Tune
   thresholds before declaring stable.
2. **Provisioned search + seed** — register
   `criblapm__trace_originators` in `provisionedSearches.ts` and
   add `criblapm_trace_originators` to `SEED_LOOKUPS`.
3. **Query change** — `Q.rawRecentErrorSpans()` becomes the
   two-step query above. Returns rows with `trace_origin` and
   `root_svc` columns. The unit-tested grouping logic in
   `groupErrorClasses` stays the same.
4. **Pure classifier + filter** — `src/api/errorFilter.ts`,
   fully unit-tested without any I/O. Rules engine accepts
   `ErrorRow[]` and a rules list.
5. **Wire into `groupErrorClasses`** — apply filter before
   the existing aggregation. Filtered counts surface via a
   "N hidden" affordance in the panel.
6. **Settings UI** — list of auto-detected originators
   (showing type + sample user-agent for context) with
   override toggles, plus a rules editor. Last to land
   because the data-model work above is unblocking on its own.
7. **Eval scenario** — `eval/scenarios/error-filter.ts` that
   verifies (a) baseline → `Product Not Found` from
   load-generator-rooted traces drops out, (b) with a flag
   that simulates a service-rooted "Product Not Found" (or
   the `productCatalogFailure` flag's actual outage signal),
   real service-to-service errors stay surfaced.

## Tradeoffs & decisions

### Why trace-origin classification, not service-edge classification

The first design version classified services by whether their
SERVER spans appeared as trace roots — calling that the
"edge service." Phase 0 validation against staging proved this
was wrong-shaped: `image-provider` got flagged as an edge
because the browser fetches images directly, but `frontend-proxy`
did not because the demo's `load-generator` is instrumented
and shows up upstream. The heuristic answered "where does the
trace enter our instrumentation?" — but the question that
matters for filtering is "what kind of actor sat at the top
of the call chain?" Same `Product Not Found` in a
load-generator-rooted trace = user fault; same error in a
hypothetical inventory-sync-rooted trace = software bug.
The unit of classification is the trace's origin, not the
service. See "Design history" for the rejected approach.

### Why `http.user_agent` is the primary signal

It's emitted by every real web user, every load generator
worth using, and nothing else. Cron jobs don't have a
browser. Queue consumers don't have a browser. Internal
services calling each other via gRPC don't set
`http.user_agent`. The signal cleanly separates "trace
started outside our backends" from "trace started inside
our backends." It's also defined in OTel semconv — not a
quirk of a specific instrumentation library.

The `messaging.system` and span-name pattern signals are
fallbacks for INTERNAL-kind roots that don't go over HTTP.

### Why classify originator *services*, not individual traces

Two reasons. First, a per-trace classifier would have to
look at every trace's root every time the panel loads —
expensive. Caching the classification at the service level
means one small lookup, joined cheaply. Second, the
originator-type for a given service is stable: load-generator
is *always* a synthetic user, the daily-rollup-job is
*always* a service. Classification doesn't change minute to
minute, only when deployment shape changes.

### Why a short window for the classification search

Cribl KQL `leftouter` joins truncate at scale — discovered
during Phase 0 validation of the now-rejected edge-service
heuristic. The classification search in this revision
doesn't use `leftouter` (it does a `summarize` of root
spans, no join), so it's not subject to the same limit.
But running over a short window keeps the query fast and
keeps "brand-new originator" classification latency low.
We can revisit if hourly turns out to be enough.

### Why `| export` to a lookup, not `| send` to a dataset

`| export mode=overwrite to lookup` is the right operator
for data that's read by joining, gets atomically replaced
each run, and is bounded in size. `| send` is for streaming
events into a dataset where they accumulate over time —
appropriate for alert history (the alert-state machine in
`alertEvaluatorExportState`), wrong here. See
`Q.serviceSummaryPrev` and `opBaselineQuery` for the lookup
pattern this follows.

### Why `scope` on rules, not just `match`

A rule like "drop HTTP 4xx" written without scope is the
exact mistake the design exists to prevent. Making `scope`
required (typed enum, no default `'any'` on the built-ins)
forces every rule author to answer "for whom?" up front.
`scope: 'any'` is available for explicit cross-cutting
patterns but it's a deliberate choice, not the path of
least resistance.

### Default rules ship enabled

Day-one value over Day-one configurability. Users overwhelmed
by the panel today get an immediately quieter view without
needing to learn the rules engine first. The "show
unfiltered" toggle is there for power users and debugging.

### Why `unknown` doesn't get filtered

Conservative bias. If we can't classify, we surface — the
failure mode of misfiltering a real error is worse than the
failure mode of showing a few extra rows. The Settings UI
should show the count of unknown-origin errors so the user
notices "hey, my classification coverage is low" and
investigates.

### Confidence in classification

The detection heuristic is good but not perfect. Worst case
it misclassifies a service and the user fixes it via override
in 30 seconds. The override knobs exist exactly because no
auto-detection is going to be right 100% of the time, and
the failure mode (some service-origin errors get filtered, or
some user-origin errors stay visible) is graceful — degraded
panel, not broken.

### Synthetic users and the gray zone

A synthetic monitor that pings a health endpoint via
`curl` will emit `http.user_agent: curl/8.0` — classified
`user`. That's correct: 4xx from a health probe is a user
fault (the URL is wrong) more often than a software bug.
A team that wants those errors surfaced anyway can flip the
service into `forceServiceOriginators`.

## Open questions

- Should the rules engine support **suppression with TTL**
  (drop these errors for the next 1h, then re-evaluate)?
  Useful for known incidents. Defer to v2 unless someone asks.
- Should there be a "show what's being filtered" detail view,
  or just an aggregate count? Start with aggregate, add detail
  if the count is the most-clicked element of the panel.
- Should `trace_origin` be exposed as a column in the panel
  itself (small chip on each row)? Useful for trust-building
  in the first few weeks; probably remove once defaults are
  trusted.
- Worth surfacing classification confidence (ua_ratio,
  msg_ratio) in Settings so users can spot borderline cases?
  Probably yes — cheap to add.

## Things explicitly rejected

- **Hard-coded service lists.** Tried this in an early draft
  ("`frontend`, `frontend-proxy`, `nginx`"). Doesn't survive
  contact with any system that isn't the OTel demo.
- **Edge-service classification by trace-root SERVER spans.**
  Validated against staging in Phase 0; got the wrong answer
  because the question itself was wrong (trace-data edge ≠
  user-vs-service originator). See "Design history" below.
- **Filter at fetch time inside `groupErrorClasses` with no
  data-model changes.** Possible but the classifier needs
  `trace_origin` and semconv columns on every row, so the
  query has to change anyway. Doing the classification
  client-side keeps the query simple and pushes the policy
  knobs into TypeScript where they're testable.
- **One big regex-based exclusion list.** Easy to build, hard
  to reason about, can't express "for users only." Scoped
  rules are barely more code and dramatically more
  understandable.
- **Pure-topology classification at query time** (no lookup).
  Anti-join semantics require `leftouter`, which truncates at
  scale in Cribl KQL — discovered the hard way in Phase 0.
  Even if it didn't truncate, paying that cost on every page
  load is wasteful when the answer barely changes.

## Phasing

| Phase | Scope | Verifiable signal |
|---|---|---|
| 0 | Run the (originator) classification KQL ad-hoc via the Cribl MCP. | Hand-verify originator classifications look right: load-generator → user, no false-positive `service` for actual users. |
| 1 | Provision the scheduled search + seed lookup. | Lookup populates, has expected services with expected types. |
| 2 | Query change (two-step originator-join query) + pure classifier + filter engine. Defaults off. | Unit tests pass. Existing UI unchanged. |
| 3 | Wire filter into `groupErrorClasses` with defaults on. Add "show unfiltered" toggle and "N hidden" affordance. | Visual: noise drops on Home, real errors stay. |
| 4 | Settings UI for rules + originator overrides. | User can flip a classification, see the panel update. |
| 5 | Eval scenario locks in the behavior. | `error-filter` eval green on baseline + scenarios. |

Each phase reverts cleanly if it goes wrong. No phase requires
the next to be useful.

## Phase 0 v2 findings (2026-05-12, staging)

Validated the trace-originator classifier against staging
via `mcp__cribl__cribl_runSearchQuery`. Distinct services
emitting root spans in a 15-minute window:

| service | roots | dominant signal | classification | correct? |
|---|---:|---|---|---|
| `load-generator` | 2951 | 93% INTERNAL with `user_*` names, no user-agent | `user` (via name pattern) | ✓ |
| `image-provider` | 90 | 100% SERVER, 100% user-agent = `Go-http-client/1.1` (kubelet probe) | `service` (via probe regex) | ✓ — these are k8s health checks, not users |
| `frontend-proxy` | 15 | 100% SERVER, no user-agent, no name signal | `unknown` | conservative; would be `user` in prod with real browsers |
| `flagd` | 6 | 100% SERVER, no signals | `unknown` | mostly orphaned spans from broken context propagation |
| `fraud-detection`, `product-reviews`, `ad`, `recommendation` | 1–4 each | CLIENT orphans | `unknown` | unclassifiable; manual override covers if needed |

**Three things this proves:**

1. **The earlier "user-agent presence" signal was wrong.**
   image-provider would have been classified `user` under
   the v1 signal (100% of its roots have user-agent). It's
   actually service-origin — those are kubelet probes. The
   *value* matters, not the presence. The corrected priority
   above (browser/load-test/probe regex on the value) gets
   it right.

2. **Span-name patterns are the dominant signal for the
   synthetic-user case.** The OTel-demo load-generator emits
   INTERNAL roots named `user_browse_product`,
   `user_view_cart`, etc. — no user-agent involved.
   Real-world synthetic users (locust, k6 with named
   scenarios, custom Python instrumentation) usually emit
   similar patterns. The regex catches them all without
   knowing about OTel demo specifics.

3. **Conservative-unknown is doing real work.**
   frontend-proxy / flagd / orphaned CLIENT spans fall to
   `unknown` and stay unfiltered. We genuinely *cannot*
   classify those from data alone — frontend-proxy's 15
   un-parented SERVER spans could be lost-context load-gen
   traffic, k8s probes, or real broken-context user calls.
   Surfacing them is the right failure mode; the manual
   override list converts them to `user` when the deployment
   shape says so.

**Limitation flagged for production validation:** in this
staging dataset every service has either a unanimous origin
(load-generator = user, image-provider = service) or
near-zero classifiable roots. Real production deployments
might have services with *mixed* root origins — e.g. an API
service that handles browser traffic AND queue messages —
where classifying per-service with a majority signal could
filter the wrong half. If that turns out to matter, the
v3 design switches to per-trace classification (the lookup
becomes keyed on `(trace_id)` or built per-batch via a
broader join). Defer until evidence shows we need it.

## Design history

The history matters because the wrong-shaped version is an
easy place to land independently — keeping the postmortem
visible saves the next reviewer from rediscovering it.

### v1 — edge-service classification (rejected, 2026-05-12)

Original design classified *services* by whether their
SERVER spans frequently appeared as trace roots, persisting
the result as `criblapm_edge_services`. The reasoning: if a
SERVER span has no captured parent, the request came from
outside our instrumentation, which (in 99% of setups) means
a user.

Validated against staging (5-minute window):

| service | edge_spans | total | edge_ratio |
|---|---:|---:|---:|
| `image-provider` | 30 | 30 | 1.00 |
| `frontend` | 169 | 1763 | 0.10 |
| `recommendation` | 4 | 93 | 0.04 |
| `flagd` | 2 | 73 | 0.03 |
| `product-catalog` | 23 | 897 | 0.03 |
| `frontend-proxy` | 9 | 1064 | 0.01 |
| `ad` | 0 | 98 | 0.00 |
| `currency` | 0 | 10 | 0.00 |
| `cart` | 0 | 174 | 0.00 |
| `checkout` | 0 | 11 | 0.00 |

**Why this is the wrong question.** The result looks
defensible on first read — `image-provider` is at 1.0 because
the browser fetches images directly. But it conflates two
different questions:

1. "Where does the trace enter our instrumentation?" —
   answered by edge_ratio.
2. "What kind of actor initiated the trace?" — the question
   the filter actually needs.

In this dataset, `image-provider`'s un-parented SERVER spans
*are* user-driven (browser → image). But `frontend-proxy` at
0.01 is *also* mostly user-driven (load-generator → proxy);
the difference is just that load-generator is instrumented
and the browser isn't. A future cron job calling
product-catalog directly would *also* register near zero,
even though its traces are service-driven and any `4xx`
inside is a real software bug.

Same edge_ratio (~0), three different correct
classifications, the heuristic can't distinguish them. The
design changed direction here.

### v1 — discovered limitation: `leftouter` truncates at scale

Even setting aside the conceptual error, the v1 query
relied on `leftouter` self-joins for anti-join semantics
("parent_span_id is *not* in the captured trace"). At a 1h
window the join silently dropped matches when the right
side exceeded an implicit row cap — every service came
back at ~0.6 edge_ratio regardless of topology. Hand-checked
several "unmatched" rows and confirmed the parents *did*
exist in the captured trace.

`kind=inner` joins are unaffected (which is why the existing
`dependencies()` query in `src/api/queries.ts` works at
production scale), but anti-join needs `leftouter`.

The v2 design avoids this entirely: the classification
search aggregates root spans without a join, and the
per-error tagging query joins to a *small* trace-origins
right side (one row per trace, not per span).
