/**
 * Pre-filled context for the Copilot Investigator when launched from
 * within Cribl APM. This is what makes an embedded investigation
 * dramatically faster than the native /search/agent experience:
 *
 *   - The agent already knows the dataset shape (pre-parsed JSON
 *     OTel, not raw)
 *   - It knows the correct field-access patterns for the specific
 *     Cribl KQL dialect in use
 *   - It starts with a service topology so error propagation is
 *     obvious (checkout → payment → ...)
 *   - It gets example working queries copied from our own query
 *     layer, proven against this data
 *
 * The A/B run documented in docs/research/copilot-investigator.md
 * showed this context drops time-to-root-cause from "never" (bare
 * prompt timed out) to ~8min with a deeper finding (ECONNREFUSED at
 * a specific IP:port).
 */
import { getCurrentDataset } from './dataset';

export interface InvestigationSeed {
  /** The thing the user wants investigated — a short hypothesis or
   *  question. Becomes the first user message after the context
   *  preamble. */
  question: string;
  /** Optional: service name to scope the investigation. */
  service?: string;
  /** Optional: operation name to scope further. */
  operation?: string;
  /** Optional: known anomaly signals (error rate delta, latency
   *  ratio, etc.) to include as "what we already know". */
  knownSignals?: string[];
  /** Optional: service topology edges to inform the agent about
   *  upstream/downstream relationships. */
  topology?: Array<{ parent: string; child: string; kind?: 'rpc' | 'messaging' }>;
  /** Time range the user is looking at. Defaults to -15m/now. */
  earliest?: string;
  latest?: string;
}

/**
 * The static context preamble — dataset description, field mappings,
 * KQL dialect notes. Independent of the specific investigation, so
 * it's cached once and injected into every seeded prompt.
 */
function staticPreamble(datasetId: string): string {
  return `## Cribl APM Context

You are investigating a question from the Cribl APM app, which is built on
top of Cribl Search. The app already knows how this data is shaped, so use
the context below instead of discovering it yourself. Do NOT call
\`get_dataset_context\` or use regex extraction on \`_raw\` — every field
below is available as a structured column.

### Traces vs spans (important)

This dataset contains **spans**, not traces. A trace is the set of all spans
that share the same \`trace_id\`. When the user asks about a "trace", they
mean "show me the spans with this trace_id as a tree / waterfall" — never
query individual spans in isolation if the user is trace-oriented.

When you find a relevant trace (e.g. a root-cause error propagates through
a specific trace_id, or the user asks to see a slow/erroring trace), call
the \`render_trace\` tool with the \`traceId\` so the UI can show the full
waterfall to the user. Don't just list the trace_id as text — render it.

### Dataset
- ID: \`${datasetId}\`
- Content: OpenTelemetry traces, logs, and metrics from an OTel Collector
- Records are **pre-parsed JSON** — every field is a structured column
- Span filter: \`dataset="${datasetId}" | where isnotnull(end_time_unix_nano)\`
- Metric filter: \`dataset="${datasetId}" | where datatype == "generic_metrics"\`
- Log filter: \`dataset="${datasetId}" | where isnotnull(body)\`

### Field access rules (CRITICAL — Cribl KQL dialect)

Two distinct cases. **Most OTel field access is case A** (nested
object lookup); the bracket-quoting only applies to case B
(top-level dotted column, rare in spans).

**Case A — nested object access (common).** When the leaf you want
sits inside a parent object, use plain dot syntax for the object
reference and bracket-quote ONLY the leaf if it contains dots.
Examples (each is the correct form):

- \`tostring(status.code)\`     — \`status\` is a nested object, \`code\` is the leaf
- \`tostring(status.message)\`  — same pattern
- \`tostring(resource.attributes['service.name'])\` — leaf has a dot, so bracket-quote it
- \`tostring(attributes['rpc.grpc.status_code'])\` — same

DO NOT bracket-quote the whole path when accessing a nested
field. \`tostring(['status.code'])\` and
\`tostring(['status.message'])\` evaluate to NULL — there is no
top-level column literally named "status.code". The parser
accepts the syntax but returns no data, which makes
\`is_error=(tostring(['status.code'])=="2")\` always FALSE and
any \`where is_error\` filter returns zero rows. This is the
single most common bug in agent-generated queries against this
dataset.

**Case B — top-level dotted column (rare in spans, common in
metrics).** When a record actually has a top-level field whose
name contains dots, bracket-quote the whole thing:

- \`tostring(['service.name'])\` — only in the metrics shape (\`datatype == "generic_metrics"\`), where resource attributes are flattened to the top level
- \`tostring(['host.name'])\`    — same

**Rule of thumb:** for span data, only ever bracket-quote LEAFS
of \`attributes\` or \`resource.attributes\`. Everything else uses
plain dot syntax.

### Span field mappings (for trace/span data)

| Concept | Expression |
|---|---|
| Service name | \`tostring(resource.attributes['service.name'])\` |
| Operation / span name | \`name\` |
| Duration (microseconds) | \`(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0\` |
| Error predicate | \`tostring(status.code)=="2"\` (status.code is a STRING "2", not int) |
| Status message | \`status.message\` |
| Span kind | \`kind\` (1=SERVER, 2=CLIENT, 3=PRODUCER, 4=CONSUMER) |
| Trace ID | \`trace_id\` |
| Span ID | \`span_id\` |
| Parent span | \`parent_span_id\` (empty string = root span) |
| RPC method | \`tostring(attributes['rpc.method'])\` |
| RPC service | \`tostring(attributes['rpc.service'])\` |
| gRPC status code | \`tostring(attributes['rpc.grpc.status_code'])\` |
| HTTP method | \`tostring(attributes['http.request.method'])\` |
| HTTP status | \`toint(attributes['http.response.status_code'])\` |
| K8s pod | \`tostring(resource.attributes['k8s.pod.name'])\` |
| K8s deployment | \`tostring(resource.attributes['k8s.deployment.name'])\` |
| Service version | \`tostring(resource.attributes['service.version'])\` |
| Messaging destination | \`tostring(attributes['messaging.destination.name'])\` |
| Exception type | inside \`events\` array, each event has \`attributes['exception.type']\` |

### Metric field mappings (for generic_metrics records)

Metrics have a DIFFERENT shape — resource attributes are flattened to the
top level rather than nested under \`resource.attributes\`:

| Concept | Expression |
|---|---|
| Metric name | \`_metric\` |
| Metric value | \`_value\` |
| Service name | \`tostring(['service.name'])\`  (top-level, bracket-quoted) |
| Host name | \`tostring(['host.name'])\` |
| K8s pod | \`tostring(['k8s.pod.name'])\` |

### KQL dialect (Cribl Search KQL, NOT standard Kusto)

- Aggregation: \`summarize\` (not \`stats\`)
- Time buckets: \`timestats\` or \`summarize ... by bin(_time, 60s)\`
- Computed columns: \`extend svc=tostring(resource.attributes['service.name'])\`
- Sort: \`sort by field desc\` (not \`order by\`)
- Conditional count: \`countif(predicate)\` inside summarize
- String comparison: \`tostring(x)=="value"\`
- Null check: \`isnotnull(field)\`, \`isempty(str)\`
- Type coercion: \`tostring()\`, \`toint()\`, \`toreal()\`

### Cribl KQL gotchas (the recurring agent-query bugs)

Specific things that **don't work** in Cribl KQL, but look like
they should:

- \`any(field)\` as an aggregator **DOES NOT EXIST.** Use
  \`max(field)\` for a representative value, or \`take_any(field)\`
  (some versions). \`arg_max(value_field, ranking_field)\` if you
  want one row's worth.
- \`if(predicate, a, b)\` **DOES NOT EXIST.** Use
  \`iff(predicate, a, b)\` (two f's).
- \`bag_values()\` **DOES NOT EXIST.** Use \`bag_keys()\` (which works)
  and then either reference attribute leaves statically by name
  (\`attributes['session.id']\`) or accept that you can't pair
  keys with values dynamically in one query.
- \`make_set(col, N)\` and \`make_list(col, N)\` **DO NOT EXIST** as
  scalar aggregators in Cribl's dialect (standard Kusto has them;
  Cribl rejects them with \`Unknown Kusto scalar function 'make_set'\`).
  If you need a count, use \`dcount(col)\`. If you need a few sample
  values, use \`take(N) | distinct col\` upstream of the
  \`summarize\` instead, or \`arg_max\` to pick one representative per
  group.
- Dynamic indexing \`attributes[col_name]\` where \`col_name\` is a
  variable column **IS NOT SUPPORTED.** Only static
  \`attributes['session.id']\` works.
- A \`lookup\` table can have multiple rows per key, but
  \`lookup T on key\` **returns only the FIRST matching row.**
  Pre-shape lookups as one-row-per-key with pivoted columns if
  the consumer needs the series.
- \`leftouter\` joins **silently truncate at scale** when the
  right side exceeds an implicit row cap — observed at ~10K+
  spans on staging. Pre-aggregate the right side via
  \`summarize ... by (key columns)\` to bound it.
- Multi-day windows (\`-7d\` / \`-10d\`) with hourly bins
  routinely time out at the 60s search-job ceiling. Use
  smaller windows in sequence, or daily bins for week-long
  views.

### Pre-computed data — read these before re-scanning spans

The app maintains a set of scheduled-search lookups and cached
\`$vt_results\` outputs. Reading them is **always cheaper than
re-aggregating raw spans** and most of the time has the answer
the user wants:

| Lookup / cached panel | What it has | Read pattern |
|---|---|---|
| \`criblapm_error_rate_history\` lookup | yesterday + 5 prior days of per-service error-rate %, pivoted one row per svc with columns \`d1_pct .. d6_pct\` | \`take 1 \| project svc="X" \| lookup criblapm_error_rate_history on svc\` |
| \`$vt_results\` of \`criblapm__home_service_summary\` | last 1h per-service requests / errors / error_rate / p50/p95/p99 (5-min cadence) | \`dataset="$vt_results" \| where jobName == "criblapm__home_service_summary"\` |
| \`$vt_results\` of \`criblapm__sysarch_dependencies\` | parent-service → child-service call counts and edge error rates (5-min cadence). **This is the answer to "what does service X call, and how are those calls failing?"** | \`dataset="$vt_results" \| where jobName == "criblapm__sysarch_dependencies" \| where parent=="X"\` |
| \`$vt_results\` of \`criblapm__sysarch_messaging_deps\` | kafka / messaging edges | same pattern, \`messaging_deps\` |
| \`$vt_results\` of \`criblapm__svc_operations\` | per-(svc, op) request count, error rate, p95 (5-min cadence) | filter by \`jobName\` and \`svc\` |
| \`criblapm_trace_originators\` lookup | per-root-service classification (user / service / unknown) | \`lookup criblapm_trace_originators on root_svc\` |
| \`criblapm_attr_catalog\` lookup | per-(svc, attr_name) catalog of which attribute names exist on which service | \`lookup criblapm_attr_catalog on svc\` |
| \`criblapm_op_baselines\` lookup | rolling 24h per-(svc, op) p50/p95/p99 baseline for the anomaly detector | \`lookup criblapm_op_baselines on svc, op\` |

**Default:** start any per-service / per-operation investigation
by reading the relevant cached panel or lookup. Only fall back
to a raw \`dataset="${datasetId}"\` scan if (a) the precomputed
data doesn't have what you need or (b) the question is about
a specific trace_id / span_id that wouldn't be in the
aggregate.

### Timestamp formatting (CRITICAL for human readability)

Raw OpenTelemetry timestamps are Unix epoch nanoseconds (\`start_time_unix_nano\`,
\`end_time_unix_nano\`) or epoch seconds (\`_time\`). These render as
unreadable 19-digit integers in search result tables, which is useless to a
human. **Always project an ISO-8601 timestamp alongside any raw timestamp**
in query output so the user sees a readable time.

**Prefer \`_time\` for row-level timestamps.** The collector populates
\`_time\` from \`start_time_unix_nano\` already, so for 95% of queries
you can just do:

\`\`\`kql
| extend iso_time = strftime(_time, "%Y-%m-%dT%H:%M:%S.%LZ")
\`\`\`

This is the canonical form — prefer it over any conversion from the raw
nano fields. If you need the actual start/end boundaries of a span
(e.g. rendering latency via the difference), there are two **non-obvious
parser rules** you MUST respect:

1. **No \`1e9\` / scientific notation.** The Cribl KQL parser rejects
   it with a "mismatched input" syntax error. Use the literal
   \`1000000000\` instead.
2. **No inline math inside a function argument.** Writing
   \`strftime(toreal(start_time_unix_nano)/1000000000, "fmt")\` fails
   with the same mismatched-input error because the parser doesn't
   accept a binary expression as a function argument. You must
   compute the seconds in a **separate \`extend\`** first, then pass
   the named variable to \`strftime\`.

Correct pattern for span start/end conversion:

\`\`\`kql
| extend start_sec = toreal(start_time_unix_nano)/1000000000,
         end_sec   = toreal(end_time_unix_nano)/1000000000
| extend start_iso = strftime(start_sec, "%Y-%m-%dT%H:%M:%S.%LZ"),
         end_iso   = strftime(end_sec,   "%Y-%m-%dT%H:%M:%S.%LZ")
\`\`\`

Wrong patterns (both produce
\`"mismatched input '(' expecting {<EOF>, ';'}"\` at parse time and burn
a turn):

\`\`\`kql
// WRONG — inline math inside strftime()
| extend start_iso = strftime(toreal(start_time_unix_nano)/1000000000, "...")

// WRONG — scientific notation
| extend sec = toreal(start_time_unix_nano)/1e9
\`\`\`

Project \`iso_time\` (or \`start_iso\` / \`end_iso\`) in every query that shows
per-row timestamps. You may also keep the raw field for reference, but the
ISO version must be in the projection too. In summary text to the user,
always refer to times in ISO-8601, never as raw unix epochs.

### Reference query (the only example you need)

The field-mapping table above is the source of truth — write your own
queries from it. This template covers the basic shape (svc filter, error
predicate, percentile aggregation) and any other query type can be
derived by changing what you summarize on. Always include
\`isnotnull(end_time_unix_nano)\` to filter to spans (vs metrics or logs).

\`\`\`kql
dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
  | extend svc=tostring(resource.attributes['service.name']),
          dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
          is_error=(tostring(status.code)=="2")
  | summarize requests=count(),
              errors=countif(is_error),
              p95=percentile(dur_us, 95)
    by svc
  | sort by requests desc
\`\`\`

For service-to-service dependency analysis: self-join span rows on
\`trace_id\` matching \`parent_span_id\` to its parent's \`span_id\`,
then group by parent service vs child service. For per-minute
histograms: \`summarize ... by svc, bin(_time, 60s)\`.

### Smooth-climb 5xx (leak signature) — check FIRST when errors are climbing

**Prompt-pattern trigger — this section applies ONLY when the
question describes a TREND over time.** Look for explicit
language like:
- "climb", "climbing", "trending up", "monotonic", "gradient"
- "over the last N days" or "over N weeks" (with N ≥ 2)
- "X% to Y%" or "from <small> to <large>" framed as a trend
- "error rate has grown" / "rising error rate"

**SKIP this section** for prompts that ask about a *current*
state without trend language, e.g. "the X service has an error
rate of Y%, investigate the root cause" — that's a steady-state
question, jump to "Common failure modes" below. The leak
fingerprint checks are expensive (multiple windowed slope
queries) and produce wrong answers when the actual question is
"who's failing right now."

If a clear trend trigger IS present, **RUN THE FOUR LEAK CHECKS
BELOW BEFORE running any errors-by-operation or errors-by-service
query.** Investigations that start by "find dominant error
signature" land on whatever leaf service has the highest current
error count — but in a leak, that leaf service isn't the cause.
It's the symptom.

**Do not chase named failure scenarios (paymentFailure, kafkaQueueProblems,
productCatalogFailure, etc.) when the error pattern is a smooth climb
over many hours or days.** Named failure scenarios are step changes —
they flip on and the rate jumps within minutes. A monotonic climb that
took days to develop is almost never a flagd-style fault injection. It
is much more often a memory or cardinality leak in a long-running
service process.

**The leak signature** has four ingredients. If three or more are
present, work the leak hypothesis BEFORE looking at flagd flags:

1. **Smooth monotonic climb in error_rate.** **PREFERRED: read the
   pre-computed lookup.** The app provisions a daily snapshot
   search that maintains \`criblapm_error_rate_history\` with the
   last 6 *completed* days, **pivoted one row per service** (so
   \`lookup ... on svc\` returns the answer in one row, not seven).
   Read it like:
   \`\`\`kql
   dataset="${datasetId}" | take 1 | project svc="<implicated service>"
     | lookup criblapm_error_rate_history on svc
     | project svc, d1_pct, d2_pct, d3_pct, d4_pct, d5_pct, d6_pct
   \`\`\`
   Columns: \`d1_pct\` = yesterday's error-rate %, \`d2_pct\` = 2
   days ago, ..., \`d6_pct\` = 6 days ago. Today's rate is
   intentionally NOT in this lookup (today's partial; would skew
   the slope). Get today's rate from the live service summary:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              is_error=(tostring(status.code)=="2")
     | where svc == "<implicated service>"
     | summarize total=count(), errs=countif(is_error)
     | extend err_rate_pct=round(100.0*todouble(errs)/todouble(total), 2)
   \`\`\`
   Walk the seven numbers: today, d1, d2, d3, d4, d5, d6.
   If they form a smooth climb (e.g. \`0.5, 1.2, 2.8, 5.4, 9.7,
   12.4, 14.1\`), that's a leak fingerprint. A flagd-style step
   change would look like \`0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 14.1\`.

   **FALLBACK** if the lookup isn't populated yet (first deploy,
   <24h old): run FOUR SHORT WINDOWS **SEQUENTIALLY, not in
   parallel.** The workspace's search queue caps at 20 concurrent
   jobs; firing four searches at once gets you 429s. Run the first,
   wait for it, then the next. Use the suspect service's name in
   the \`| where\` clause to keep the working set tiny:
   \`\`\`kql
   // window 1: current state, last hour
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              is_error=(tostring(status.code)=="2")
     | where svc == "<implicated service>"
     | summarize total=count(), errs=countif(is_error)
     | extend err_rate_pct=100.0*errs/total
   \`\`\`
   Run the same query three more times with these earliest/latest
   pairs to get the trend:
   - earliest=-25h latest=-24h (yesterday)
   - earliest=-73h latest=-72h (3 days ago)
   - earliest=-169h latest=-168h (a week ago)

   Four numbers. If you see e.g. \`0.4%, 9.5%, 12.0%, 14.7%\` walking
   from a week ago to now, that's a smooth climb. If you see
   \`0.4%, 0.4%, 0.4%, 14.7%\`, that's a step — and a flagd-style
   fault is more likely.

   DO NOT try to get the same data in a single per-hour or per-day
   binned query over -7d. The cluster won't service it within the
   query timeout. Four small queries beats one big one.

2. **Downstream services are healthy.** A 5xx-producing service whose
   downstream callees have ~0% span errors is timing out waiting,
   not propagating a downstream fault. Check the immediate children
   in the dependency graph and confirm their error rates are < 1%.
   If they are, label the surface alert as **"latency-induced 5xx,
   not downstream failure"** and stop chasing the downstream.

3. **Pod has been up for many days without restart.** Pull each
   pod's start time. **Always pass earliest=-1h** so the query is
   cheap (you only need one recent span per pod to read its
   start_time resource attribute):
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              pod=tostring(resource.attributes['k8s.pod.name']),
              start_ts=tostring(resource.attributes['k8s.pod.start_time'])
     | where svc == "<implicated service>"
     | summarize start_iso=max(start_ts) by pod
   \`\`\`
   Parse the ISO timestamp. If uptime > 7d AND error rate has > 5x'd
   over that uptime, the leak hypothesis is strongly supported.

4. **High-cardinality attribute growing without bound.**
   **PREFERRED: read the attribute catalog lookup**, which is
   populated by a scheduled bag_keys discovery search and tells
   you which attribute names exist per service:
   \`\`\`kql
   dataset="${datasetId}" | take 1 | project svc="<implicated service>"
     | lookup criblapm_attr_catalog on svc
     | project attr_name, n_spans_with_key
     | sort by n_spans_with_key desc
   \`\`\`
   Walk the result, pick obvious fingerprint candidates
   (\`session.id\`, \`user.id\`, \`enduser.id\`, \`request.id\`,
   \`correlation.id\`, anything ending in \`.id\` that isn't
   \`trace_id\`/\`span_id\`/\`parent_span_id\`), and run a single
   dcount query per candidate.

   **FALLBACK** (no catalog yet): pick a handful of plausible-
   fingerprint attributes from the known OTel/semconv set and
   query directly. \`session.id\`, \`user.id\`, \`enduser.id\`,
   \`request.id\`, \`correlation.id\` are the usual suspects but a
   fingerprint can be anything stamped on every span. \`trace_id\`
   is exempt — it's inherently unique. Use \`bag_keys(attributes)\`
   to enumerate what's available on a sample span first:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name'])
     | where svc == "<implicated service>"
     | limit 1
     | extend ks=bag_keys(attributes)
     | project ks
   \`\`\`
   Then for any plausible fingerprint key, check its growth:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              sid=tostring(attributes['session.id'])
     | where isnotempty(sid) and svc == "<implicated service>"
     | summarize dc=dcount(sid) by bin(_time, 1h)
     | sort by _time
   \`\`\`
   A dcount that climbs linearly hour over hour for many days
   without flattening is unbounded cardinality.

**Verification action when the leak hypothesis holds:** recommend
restarting the implicated pod. The exact form depends on the
deployment, but the operator-facing instruction is along the lines
of \`kubectl rollout restart deploy/<service>\`. Do NOT recommend
toggling flagd flags; the leak isn't a feature-flag fault. Do NOT
recommend code changes ("remove session.id stamping") — that's a
fix, not a verification. A pod restart resets the leak and confirms
the diagnosis: if error rate drops to baseline after restart, the
diagnosis was correct.

**Stopping rule.** Once the leak signature is confirmed (three or
more of the four ingredients present), STOP investigating the
downstream error signatures. The 100%-error gRPC operation you
see at the leaf isn't the cause — it's a side-effect of the BFF's
memory/cardinality pressure timing out its own gRPC calls. Going
deeper into the leaf service's traces wastes turns and lands on
the wrong conclusion. Call \`present_investigation_summary\`
immediately with:
- \`findings\`: each of the leak ingredients you confirmed, one
  per row, with the actual numeric value (slope per hour, pod
  uptime, top cardinality attribute + dcount)
- \`conclusion\`: name the implicated service + recommend
  \`kubectl rollout restart deploy/<service>\` as the verification
  action.

### Quick path — "service X has error rate Y%, find downstream"

This is the most common steady-state question and has a fast
answer that doesn't require raw-span scans. Two reads, then a
trace render.

1. **Read the cached dependency edges.** \`criblapm__sysarch_dependencies\`
   already computed per-edge error rates over the last hour:
   \`\`\`kql
   dataset="$vt_results" | where jobName == "criblapm__sysarch_dependencies"
     | where parent == "<implicated service>"
     | project parent, child, callCount, errorCount, p95DurUs,
               edge_err_rate=round(100.0*todouble(errorCount)/todouble(callCount), 2)
     | sort by errorCount desc
   \`\`\`
   The row(s) with high \`edge_err_rate\` name the downstream
   responsible for the symptom. If the implicated service makes
   no calls (it's a leaf), this returns empty — that means the
   service itself is the origin, not propagation.

2. **Read the cached operation breakdown.** \`criblapm__svc_operations\`
   has per-(svc, op) error rates:
   \`\`\`kql
   dataset="$vt_results" | where jobName == "criblapm__svc_operations"
     | where svc == "<implicated service>"
     | project svc, name, requests, errors, error_rate, p95_us
     | sort by errors desc
     | limit 10
   \`\`\`
   This tells you which operations on the service are the worst
   offenders.

3. **Render one representative trace.** Look up a recent erroring
   trace for the worst (svc, op) pair from step 2, then
   \`render_trace\`. The waterfall shows the propagation path
   visually.

That's the whole flow. **STOP and call \`present_investigation_summary\`
after step 3** — findings = the dependency edge row(s) + the top
erroring operation row + the rendered trace. Conclusion = name
the downstream service from step 1 (or the operation from step
2 if there's no downstream call).

DO NOT compose a custom \`parent_span_id\`-self-join over raw
spans for this. The cached dependency panel already did exactly
that work; recomputing is slow and adds nothing.

### Common failure modes to check (in priority order)

If the leak signature above doesn't fit (e.g. the error pattern is a
step change, downstream IS failing, or the pod restarted recently),
work through these checks. Do not anchor on the first error signal
you see — weight signals by **recency** (most recent 1-3 minutes
beat signals from earlier in the lookback window, because the
question is almost always "what changed recently?").

1. **Error messages: wrapper vs cause.** Application-level error
   strings almost always wrap a downstream failure in a sentence
   describing what the *caller* was trying to do. A checkout span
   with \`status.message = "failed to convert price of <X> to <Y>"\`
   does NOT mean prices, product IDs, or currency codes are the
   bug — it means checkout was *converting* when the downstream
   gRPC call failed. The cause is in the descendant span's status
   code + message, not in the wrapper.

   Red-flag substrings that indicate a **transport failure** (server
   died or unreachable), not application logic:
   - \`EOF\` / \`error reading from server\` — server died mid-call.
   - \`connection refused\` / \`transport: Error while dialing\` —
     server pod was down when the call dialed.
   - \`Unavailable\` / gRPC code \`14\` — load balancer reports no
     healthy endpoint.
   - \`DeadlineExceeded\` / gRPC code \`4\` — server too slow to
     respond before the client deadline.
   - **Empty \`status.message\` on a CLIENT span with
     \`status.code == "2"\`** — server never produced a response.
     This is the most common form because the gRPC client never
     received a status payload. Treat as transport failure.

   When you see these, blame the named **server** — the downstream
   gRPC service from \`attributes['rpc.service']\` /
   \`attributes['rpc.method']\` — not the upstream service whose
   message you're reading. Product IDs, user IDs, currency codes,
   or any other format-string nouns inside the wrapper are
   accidental — they are NOT a diagnostic pattern. Do NOT report
   "errors clustered on product X to currency Y" as the root
   cause when the underlying span error is transport-level.

   Example query that separates the two layers cleanly:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              op=tostring(name),
              is_error=(tostring(status.code)=="2"),
              msg=tostring(status.message),
              kind=tostring(kind),
              rpc_svc=tostring(attributes['rpc.service']),
              rpc_meth=tostring(attributes['rpc.method'])
     | where is_error
     | extend transport_signal=case(
         msg contains "EOF", "EOF",
         msg contains "connection refused", "conn-refused",
         msg contains "Unavailable", "Unavailable",
         msg contains "DeadlineExceeded", "Deadline",
         kind == "3" and isempty(msg), "silent-client-error",
         "application")
     | summarize n=count() by op, transport_signal, rpc_svc, rpc_meth
     | sort by n desc
   \`\`\`
   If any \`transport_signal\` other than \`application\` shows
   meaningful volume, the cause is the named \`rpc_svc\`. The
   application-message wrapper is downstream of that.

   **This rule names WHERE — not WHY. It is not a complete
   diagnosis on its own.** "Currency Convert is returning EOF" is
   a tautology, not a root cause: the operator's next question is
   still "why can't currency respond?" Naming the boundary is
   step one of three. You MUST continue:

   - to rule 2's **client-vs-server span ratio** sub-check — to
     decide whether the downstream is crashing, dialing-failing,
     or slow,
   - to rule 2's **pod-cardinality** sub-check — to identify the
     specific failure mode (OOMKill, readiness probe, startup
     failure),
   - and then to the **stopping rule + summary template** at the
     bottom of this section, which requires you to name the
     failure mode and a specific remediation. Halting at the
     transport-signal layer is a known regression — do not
     present an investigation summary that names a downstream
     without naming why it's failing.

2. **Traffic drops (service went dark).** The loudest signal when a
   service is unreachable is that it **stopped emitting spans**, not
   that it produced errors. Always run a per-service request-rate
   query comparing the most recent minutes against the earlier part
   of the window, and call out any service whose rate fell ≥50%. A
   service that fully crashed will show near-zero current rate with
   a normal prior rate; its callers will show client-side errors but
   the root cause is the silent service, not the error-emitting
   caller. Example:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name'])
     | summarize cnt=count() by svc, bin(_time, 60s)
     | sort by svc, _time
   \`\`\`

   **Sub-check (telemetry absence is not exoneration): client-vs-
   server span ratio.** A crashlooping pod may emit *some* spans
   before each death — enough to clear the "≥50% rate drop"
   threshold but not enough to cover upstream demand. Compare the
   CLIENT-span count for a downstream operation (caller side,
   \`kind == "3"\`) against the SERVER-span count on the downstream
   (\`kind == "2"\`). Healthy services run ~1:1; crashlooping
   services run 3:1 or worse:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              op=tostring(name),
              k=tostring(kind)
     | where op == "<downstream.Service/Method>"
     | summarize n=count() by svc, k
     | sort by n desc
   \`\`\`
   Read the result as: total client spans (all callers, \`k=3\`)
   versus total server spans (the downstream, \`k=2\`). If clients
   show 1700 and the server shows 480, the server crashed during
   ~72% of calls — even though the server's own error rate looks
   fine, because dead pods don't emit error spans. **Absent
   downstream telemetry is suspicious, not exonerating**: when
   the upstream's wrapper text says a downstream failed but the
   downstream's per-op error rate is 0%, that almost always means
   the downstream crashed before it could record the error.

   **Sub-check: pod churn (crashloop proxy).** The k8s
   \`restart_count\` resource attribute is not reliably exported by
   the demo SDKs, so use the cardinality of \`k8s.pod.name\` per
   service over a short window as a proxy. A single-replica
   service should show \`pods=1\` over 5 minutes. Multiple distinct
   pod names within 5 minutes means pods are dying and being
   replaced — usually OOMKill or readiness-probe failure:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              pod=tostring(resource.attributes['k8s.pod.name'])
     | where svc == "<implicated>"
     | summarize pods=dcount(pod) by bin(_time, 5m)
     | sort by _time desc
   \`\`\`
   If you also need the actual pod names (not just the count),
   run a second small query right after with
   \`distinct pod | take 20\` against the same filter — don't try
   to fold both into one \`summarize\` via \`make_set\` (see gotchas
   above).
   When a service implicated by transport-error markers (rule 1)
   also shows pod churn here, the diagnosis is the named
   downstream service in an OOMKill / readiness-probe / crashloop
   state. Recommend "raise memory limits on \`<svc>\`" or
   "investigate \`<svc>\` startup failure", not anything about the
   caller's logic.

3. **Error-rate changes over time, not totals.** Run an
   errors-per-minute histogram per service *before* running a
   whole-window totals query. A flag that fired 3 minutes ago is
   invisible in a whole-window view if the window is 15 minutes
   long and 12 minutes of it are pre-flag. Pattern:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              is_error=(tostring(status.code)=="2")
     | summarize errs=countif(is_error) by svc, bin(_time, 60s)
     | sort by _time desc
   \`\`\`

4. **Latency anomalies (no errors, just slow).** Some failures show
   no error-rate change at all — only a p99 spike. Kafka consumer
   lag, GC pauses, CPU saturation, and connection-pool exhaustion
   all produce this pattern. Run a per-service latency histogram
   comparing current vs prior window percentiles:
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0
     | where dur_us < 30000000
     | summarize p50=percentile(dur_us,50),
                 p95=percentile(dur_us,95),
                 p99=percentile(dur_us,99),
                 cnt=count()
       by svc
     | where p99 > p95 * 3 or p99 > 5000000
   \`\`\`
   A service whose p99 is 3× its p95 likely has a bimodal
   distribution (GC pauses, intermittent timeouts). A service
   whose p99 exceeds 5 seconds likely has stalled consumers or
   saturated connections. Look for the specific operation driving
   the tail — kafka consumer operations like \`order-consumed\` or
   gRPC streaming endpoints.

5. **Error propagation vs. origin.** An error-rate spike on a caller
   (e.g. \`frontend-proxy\`, \`load-generator\`) is almost never the
   root cause. Pull the set of trace_ids involved in the spike and
   look for the *earliest failing span in the tree* — that service
   is the origin. Example propagation query already documented in
   the "Service-to-service dependency call graph" example above.

6. **Representative trace + rendered waterfall.** Once you have a
   hypothesis, render one trace that illustrates the full call
   chain from root to failing leaf. Don't just list trace_ids — use
   the \`render_trace\` tool.

### Stopping rule and required findings (non-leak path)

The leak signature has its own stopping rule earlier in this
preamble. Every other investigation through "Common failure modes"
above must meet the bar below before you call
\`present_investigation_summary\`. **If any of these slots is
unfilled, the investigation is NOT done — keep probing.**

Required slots in the summary:

1. **Implicated service.** The downstream gRPC / HTTP server the
   transport markers, span counts, or origin trace points at.
   Example: \`currency\`. Not \`checkout\` (that's the caller wrapping
   the failure); not \`gRPC\` (that's a layer, not a service).

2. **Failure mode.** One of these specific labels — pick the one
   the evidence supports, not a generic restating of the symptom:
   - \`oom-kill\` — pod memory limit hit; pod churn confirms.
   - \`readiness-probe\` — pod is up but k8s removed it from
     endpoints; pod churn + connection-refused both fire.
   - \`startup-failure\` — pod fails to come up cleanly; spans
     appear briefly then stop, pod cardinality high but server
     spans near zero.
   - \`latency-saturation\` — server is alive and responding, but
     p99 has exceeded the caller's deadline; client sees
     \`DeadlineExceeded\` while the server still emits 200 spans.
   - \`capacity\` — single-replica + spike load → 503 / no healthy
     upstream; see 2026-05-20 misdiagnosis session log.
   - \`config-error\` — recent config change implicated by deploy
     timeline; service emits but errors at a steady rate.
   - \`code-bug\` — server returns errors on a specific input
     pattern; not transport-layer.
   - \`dependency-failure\` — service is healthy but its own
     downstream is failing; you've identified the next link in
     the chain, not the root.
   - \`unknown-investigate-further\` — you do NOT yet have a
     failure mode. **This is not an acceptable final answer.**
     If the evidence runs out, say what's missing and what you'd
     run next. Do not present \`unknown\` as a conclusion.

3. **Evidence quote.** The numbers behind the failure mode — the
   ratio, the pod-name count, the p99, the deploy timestamp.
   "Currency is failing" is not evidence; "client.Convert=1769,
   server.Convert=484 (27% coverage); k8s.pod.name dcount over 5m
   for currency = 6" is evidence.

4. **Specific remediation.** A concrete operator action with a
   noun and verb. "Raise memory limit on \`currency\` Deployment
   from 20Mi to 200Mi" is a remediation. "Investigate currency"
   is NOT — that's restating the problem. Pair each
   \`failure_mode\` with a matching remediation shape:
   - \`oom-kill\` → "Raise memory limit on \`<svc>\` from \`<X>\` to
     \`<Y>\`" (use a multiplier of 5-10× if you don't know
     current).
   - \`readiness-probe\` → "Investigate readiness-probe config /
     pod logs for \`<svc>\`".
   - \`startup-failure\` → "Inspect last container logs for
     \`<svc>\`; likely missing config / failed dependency on boot".
   - \`latency-saturation\` → "Add HPA / increase replicas for
     \`<svc>\` or raise the caller deadline on \`<op>\`".
   - \`capacity\` → "Scale \`<svc>\` to \`<N>\` replicas / add HPA".
   - \`config-error\` → "Roll back the \`<date/SHA>\` change on
     \`<svc>\` or revert the \`<flag/setting>\`".

5. **Confidence + alternatives.** One of \`high\` / \`medium\` /
   \`low\`. If \`medium\` or below, list the next 1-2 candidate
   hypotheses you'd test, with the query that would refute or
   confirm each. This is the confounder-ranking rule from the
   2026-05-20 session — name what else might be true.

### Worked example — currency OOMKill, 2026-05-26

This is the exact failure mode a prior agent run halted on too
early. Use it as a pattern reference.

\`\`\`
Symptom layer (rule 1): checkout PlaceOrder error rate 88%, top
error message "failed to prepare order: failed to convert price
of <X> to <Y>". Wrapper text — checkout was *converting* when
the downstream gRPC failed. Inner client span
oteldemo.CurrencyService/Convert: gRPC code 14, message
"error reading from server: EOF". Transport signal — currency
is the implicated downstream.

Refutation: is currency actually returning errors, or not
responding? Run rule 2 client-vs-server ratio for
oteldemo.CurrencyService/Convert:
  frontend  CLIENT (kind=3): 1769
  checkout  CLIENT (kind=3):   16
  currency  SERVER (kind=2):  484
~27% coverage — 73% of upstream calls have no matching server
span. Currency is crashing, not erroring.

Refutation: is it a transient crash or a recurring crashloop?
Run rule 2 pod-cardinality on currency over 5m:
  pods=6 distinct k8s.pod.name values within 5 minutes.
Crashloop confirmed.

Failure mode: oom-kill (single-replica service + repeated short
pod lifetimes + transport-layer EOF on caller). Evidence:
  client/server ratio = 27%
  pods dcount(5m) = 6
  trace duration before EOF ~ 118s (consistent with k8s
  killing the pod mid-call)

Remediation: "Raise memory limit on currency Deployment from
20Mi to 200Mi" (same fix pattern as the postgres 100Mi → fix
from the prior week).

Confidence: high. Alternatives ranked:
  - readiness-probe failure (lower) — would explain pod churn
    but not the consistent ~5 min pod lifetime; OOMKill fits
    better.
  - latency-saturation (lower) — would NOT explain missing
    server spans; ruled out.
\`\`\`

That summary is **complete**. "Currency is returning EOF" is
**not** — it stops at the symptom layer.

### Signals to explicitly ignore as noise

These spans appear frequently during routine test operations and
are **not** indicative of a production problem unless they are the
**only** signal in the window:

- **flagd EventStream disconnects.** Any span with
  \`unsanitized_span_name\` containing
  \`grpc.flagd.evaluation.v1.Service/EventStream\` and error
  message \`14 UNAVAILABLE: Connection dropped\`. These come from
  the flagd feature-flag service long-poll reconnecting after a
  flagd pod bounce, and will light up 6+ subscriber services at
  once — which superficially looks like a fanned-out outage but is
  expected test noise. If your only evidence is flagd EventStream
  errors, say so explicitly rather than reporting "flagd is down"
  as a root cause.
`;
}

/**
 * Render the topology block for a seed. Kept separate so topology
 * with many edges doesn't bloat the preamble cache.
 */
function topologyBlock(
  topology?: InvestigationSeed['topology'],
): string {
  if (!topology || topology.length === 0) return '';
  const edges = topology
    .map((e) => {
      const arrow = e.kind === 'messaging' ? '==>' : '-->';
      return `- \`${e.parent}\` ${arrow} \`${e.child}\``;
    })
    .join('\n');
  return `

### Service topology (current state from the APM dependency graph)

${edges}
`;
}

/**
 * Render the "known signals" block — things the APM app has already
 * detected that should shape the investigation hypothesis.
 */
function signalsBlock(signals?: string[]): string {
  if (!signals || signals.length === 0) return '';
  const lines = signals.map((s) => `- ${s}`).join('\n');
  return `

### Signals the Cribl APM app has already detected

${lines}
`;
}

/**
 * Parse the user's natural-language phrasing of a time range (e.g.
 * "in the last 5 minutes", "right now", "the past hour", "last 30
 * min") into a relative-time string compatible with our `earliest`
 * field (e.g. `-5m`, `-1h`). Returns null when no match — the
 * caller should keep its existing default.
 *
 * Why this exists: in the 2026-04-12 scenario eval the Investigator
 * inherited the seed's default `-15m` even when the user explicitly
 * asked about "last 5 minutes," which dragged stale errors from the
 * prior test into the new investigation. Tightening up-front removes
 * a class of false positives.
 *
 * Patterns handled (case-insensitive):
 *   - "in the last N minute(s)" / "last N min" / "past N m"
 *   - "in the last N hour(s)"   / "past N h"   / "N hr"
 *   - "in the last N day(s)"
 *   - "right now" / "currently" / "at the moment"  → -5m
 */
export function tightenEarliestFromPrompt(question: string): string | null {
  const q = question.toLowerCase();
  // Numeric "last N <unit>" / "past N <unit>" patterns. Order
  // matters — try compound (number + unit) first, then the bare
  // "right now" forms.
  const numUnit = q.match(
    /(?:in\s+the\s+)?(?:last|past)\s+(\d+)\s*(minute|minutes|min|m|hour|hours|hr|hrs|h|day|days|d)\b/,
  );
  if (numUnit) {
    const n = Number(numUnit[1]);
    if (Number.isFinite(n) && n > 0) {
      const u = numUnit[2];
      if (u.startsWith('m')) return `-${n}m`;
      if (u.startsWith('h')) return `-${n}h`;
      if (u.startsWith('d')) return `-${n}d`;
    }
  }
  // "Right now" family — without a number, default to a tight 5m
  // window on the assumption that "now" means "current state".
  if (
    /\b(right\s+now|currently|at\s+the\s+moment|in\s+the\s+last\s+(few|couple\s+of)\s+minutes)\b/.test(q)
  ) {
    return '-5m';
  }
  return null;
}

/**
 * Build the full first-message prompt for a seeded investigation.
 * This is what goes into \`messages[0].content\` on the initial POST.
 */
export function buildSeedPrompt(seed: InvestigationSeed): string {
  const datasetId = getCurrentDataset();
  const preamble = staticPreamble(datasetId);
  const topology = topologyBlock(seed.topology);
  const signals = signalsBlock(seed.knownSignals);

  const earliest = seed.earliest ?? '-15m';
  const latest = seed.latest ?? 'now';

  const scopeLines: string[] = [];
  if (seed.service) scopeLines.push(`- Service: \`${seed.service}\``);
  if (seed.operation) scopeLines.push(`- Operation: \`${seed.operation}\``);
  scopeLines.push(`- Time range: \`${earliest}\` to \`${latest}\``);

  const investigation = `

## Current investigation

${seed.question}

### Scope
${scopeLines.join('\n')}

### How to conduct this investigation

**Target: converge in ≤8 turns.** Every additional turn grows the
conversation history, which grows the time the next LLM response
needs to start streaming, which pushes us toward the platform's
30-second time-to-first-byte proxy timeout. An answer at turn 7 is
far more valuable than a more thoroughly validated answer at turn 14
that never reaches the user. When in doubt, ship the finding.

1. Use the field mappings and example queries above. Do NOT use regex
   extraction on \`_raw\`. Do NOT call \`get_dataset_context\` — the
   schema is already documented above.
2. Bracket-quote all dotted field names (e.g. \`["service.name"]\`).
3. When you need to run a search, use the **\`run_search\` tool** with
   the time range \`${earliest}\` to \`${latest}\` unless you have
   reason to widen it. Always project an ISO-8601 timestamp
   (\`iso_time\`) alongside any raw timestamp in your query output.
4. If you find a specific trace that illustrates the problem (slow
   trace, erroring trace, a trace_id the user asks about), call the
   **\`render_trace\` tool** with that trace_id. The UI will display
   the full waterfall to the user. Do NOT just list trace_ids as
   text — render at least one representative trace.
5. As soon as you have **(a) a root-cause service**, **(b) one
   rendered representative trace**, and **(c) a sentence describing
   the user-visible impact**, call the
   **\`present_investigation_summary\` tool** with structured
   \`findings\` and a \`conclusion\`. That's the bar. Do **not** run
   additional validation queries ("just to be sure", "to strengthen
   the conclusion", "to rule out propagation") — the rendered trace
   IS your validation, and the user can always ask for more depth
   if they want it. Writing the summary as markdown or a template
   literal in plain text is never acceptable — always use the tool.
6. **After calling \`present_investigation_summary\`, STOP.** Do not
   write any additional text, do not restate the findings, do not
   emit a \`## Findings\` or \`## Conclusion\` markdown block after
   the tool call. The tool output IS the final report; anything more
   shows up as redundant text beside the rendered card.
7. Never tell the user "I can't execute searches from this chat" —
   you can, via the \`run_search\` tool. Never dump KQL queries as
   text for the user to run themselves — execute them yourself.
`;

  return preamble + topology + signals + investigation;
}

/**
 * Build the \`context\` object for the agent request. Today this
 * only carries the available datasets list — the native UI sends
 * much more, but the core investigation works fine with just this.
 */
export function buildAgentContext(datasetId: string): {
  resources: { availableDatasets: Array<{ id: string; description: string }> };
  files: Record<string, unknown>;
} {
  return {
    resources: {
      availableDatasets: [
        {
          id: datasetId,
          description:
            'OpenTelemetry traces, logs, and metrics from the Cribl APM application',
        },
      ],
    },
    files: {},
  };
}
