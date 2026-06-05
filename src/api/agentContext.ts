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
import { getCurrentDataset } from '@cribl/app-utils/dataset';

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
- Content: OpenTelemetry telemetry from an OTel Collector — **four**
  record types in one dataset, distinguishable by which fields are
  populated. Do not assume "the otel dataset" means "spans only";
  many root causes show up in logs or metrics before spans tell
  you anything.

| Record type | Identifier | Filter |
|---|---|---|
| **Spans** | \`span_id\` + \`end_time_unix_nano\` | \`where isnotnull(end_time_unix_nano)\` |
| **Metrics** (wide-column) | \`_metric_type\` present; no \`span_id\` | \`where isnotnull(_metric_type)\` |
| **Logs** (pure) | \`severity_number\` + \`body\`; no \`span_id\` | \`where isnotnull(severity_number) and isnotnull(body) and isnull(span_id)\` |
| **Span events** | \`span_id\` + \`body\` + \`severity_number\` | \`where isnotnull(span_id) and isnotnull(body)\` |

All four share \`resource.attributes['service.name']\` so you can
join across record types on service identity. Records are
**pre-parsed JSON** — every field is a structured column, no
regex on \`_raw\` needed.

**When to query each type:**
- Latency / error rate / call-graph questions → spans.
- "How is metric X trending?" / resource utilization → metrics.
- "What did service X actually say while it was failing?" → logs.
- "What happened inside this specific span?" (DB call, kafka commit,
  exception breadcrumb) → span events.

**Log-silence is a signal too.** A service that's processing
requests (server spans appear) but emitting suspiciously low log
volume relative to that request rate may have its logger
back-pressured by its own SDK. See "Common failure modes" rule on
log-volume vs request-volume comparison.

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

### Log field mappings (for log records + span events with body)

Logs share the nested-object shape with spans — resource attributes
live under \`resource.attributes\`. Pure log records have no
\`span_id\`; span events have \`span_id\` (they belong to a parent
span) plus the same body / severity fields.

| Concept | Expression |
|---|---|
| Service name | \`tostring(resource.attributes['service.name'])\` |
| Severity (numeric) | \`severity_number\` (1=TRACE … 9=INFO … 13=WARN … 17=ERROR … 21=FATAL) |
| Severity (text) | \`tostring(severity_text)\` (e.g. \`"INFO"\`, \`"WARN"\`, \`"ERROR"\`) |
| Message body | \`tostring(body)\` (the actual log line; sometimes structured JSON) |
| Trace correlation | \`trace_id\`, \`span_id\` (present on span events; null on pure logs) |
| Log attributes | \`attributes\` (varies by SDK; common keys: \`code.namespace\`, \`code.function\`, \`exception.type\`) |
| K8s pod | \`tostring(resource.attributes['k8s.pod.name'])\` |
| K8s deployment | \`tostring(resource.attributes['k8s.deployment.name'])\` |

Quick scan for warnings/errors from one service:

\`\`\`kql
dataset="${datasetId}"
  | where isnotnull(severity_number) and isnotnull(body)
  | extend svc=tostring(resource.attributes['service.name']),
           sev=tostring(severity_text),
           msg=tostring(body)
  | where svc == "<service>"
    and sev in ("WARN", "WARNING", "ERROR", "FATAL")
  | summarize n=count() by msg
  | sort by n desc
  | limit 20
\`\`\`

Read the top messages by frequency. Repeated occurrences of the
same stack-trace fragment, GC pause warning, exporter back-pressure
notice, or downstream-error log are usually the smoking gun the
trace shape alone can't deliver.

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
- \`countif(not <bool>)\` and \`countif(! <bool>)\` are **rejected
  by the parser** with \`mismatched input '(' expecting EOF or ';'\`.
  Use explicit boolean comparison instead:
  \`countif(myflag == false)\` works. Affects any inverse-of-flag
  aggregate inside summarize. \`not(expr)\` with parens works fine
  outside countif — it's specifically the unparenthesized form
  inside the aggregator that fails.
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
| \`criblapm_error_rate_history\` lookup | yesterday + 5 prior days of per-service error-rate %, pivoted one row per svc with columns \`d1_pct .. d6_pct\` | \`take 1 | project svc="X" | lookup criblapm_error_rate_history on svc\` |
| \`$vt_results\` of \`criblapm__home_service_summary\` | last 1h per-service requests / errors / error_rate / p50/p95/p99 (5-min cadence) | \`dataset="$vt_results" | where jobName == "criblapm__home_service_summary"\` |
| \`$vt_results\` of \`criblapm__sysarch_dependencies\` | parent-service → child-service call counts and edge error rates (5-min cadence). **This is the answer to "what does service X call, and how are those calls failing?"** | \`dataset="$vt_results" | where jobName == "criblapm__sysarch_dependencies" | where parent=="X"\` |
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

   **Capacity-vs-crashloop disambiguation.** Both patterns can
   produce slow client-side responses and a climbing client error
   rate. Three asymmetries separate them:

   1. **Client error message.**
      - **Crashing** servers DIE mid-call — clients see \`EOF\`,
        \`connection refused\`, \`transport: Error while dialing\`,
        or empty \`status.message\` on a CLIENT span.
        Capacity-saturated services don't disconnect mid-response.
      - **Capacity-saturated** servers RESPOND, just slowly —
        clients see \`DeadlineExceeded\` (gRPC code 4),
        \`Unavailable: no healthy upstream\` (envoy 503 when the
        load balancer marks endpoints unhealthy), or rising p99
        latency on server-side spans. The server still emits a
        status payload.

   2. **Server's own error rate.** Capacity-saturated servers
      produce errors *on themselves*: their SERVER spans show
      \`DeadlineExceeded\`, \`Unavailable\`, 503, or queue-overflow
      messages. Crashing servers produce **zero server errors**
      because they die before they can write one. If you see a
      high client error rate (e.g. 70%+) and a near-zero server
      error rate on the same operation, that asymmetry is
      decisive crash evidence — the server didn't refuse, it
      didn't time out, it ceased to exist mid-handshake.

   3. **Server-side latency interpretation.** High server p95 is
      NOT a clean capacity signal. A pod accumulating memory
      pressure, GC churn, or swap thrashing before OOMKill emits
      server spans that get progressively slower as resources
      exhaust — a "death-spiral" tail. Currency \`Convert\` at
      p95 = 179s is not a saturation tail (the operation is
      microsecond-scale by design); it's a process that's
      becoming non-responsive before the kubelet kills it.
      Treat extreme server latency relative to the operation's
      expected baseline as a crash precursor, not capacity.

   **When you see \`EOF\` or \`connection refused\` on N≥5 client
   spans, it is a crash, not capacity — regardless of pod
   cardinality, regardless of how slow the server's surviving
   spans are.** A single pod can crashloop in place (see rule 2's
   span-emission-gap probe for why \`dcount(pod) == 1\` does NOT
   rule out OOMKill on a Deployment). Do not flip to a capacity
   diagnosis because pod churn was absent — that flip is a
   labeled known regression (see counterexample at the end of
   this section).

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

   **L7 proxy attribution illusion.** When the service emitting
   the transport markers is itself an L7 proxy (envoy, nginx,
   traefik, ALB / GCLB / cloud load balancer), the "blame the
   named upstream" rule above is **incomplete**. Envoy's
   \`response_flags\` attribute carries upstream-blame semantics
   that look like downstream failures but can equally indicate
   the proxy itself ran out of resources:

   | Flag | Envoy meaning | Can ALSO mean (proxy-side) |
   |---|---|---|
   | \`UT\` | upstream request timeout | proxy CPU saturation, proxy GC pause, worker pool full |
   | \`UC\` | upstream connection terminated | proxy OOM unable to allocate sockets, fd-limit hit |
   | \`UR\` | upstream remote reset | proxy dropped connection from its own side |
   | \`UH\` | no healthy upstream hosts | proxy fd exhaustion + healthcheck-write failure |
   | \`UF\` | upstream connection failure | proxy can't open new sockets |

   All five flags get *attributed to the upstream cluster* in the
   span. Following the attribution naively walks you "deeper into
   the upstream" when the actual problem is in the proxy that
   emitted the flag.

   **The disambiguation probe**: pull the NAMED UPSTREAM'S OWN
   server spans (kind=2 on the service envoy thinks is failing).
   If the upstream's server spans are healthy — normal p95
   latency for the operation type, near-zero server-side error
   rate, span volume that tracks the proxy's request rate — then
   **the upstream is fine and the proxy is the broken layer**.
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              kind=tostring(kind),
              is_error=(tostring(status.code)=="2"),
              dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
              op=tostring(name),
              resp_flags=tostring(attributes['response_flags'])
     | where svc == "<named upstream>" and kind == "2"
     | summarize requests=count(),
                 errors=countif(is_error),
                 p50_ms=percentile(dur_us, 50)/1000.0,
                 p95_ms=percentile(dur_us, 95)/1000.0,
                 max_ms=max(dur_us)/1000.0
       by op
     | extend err_pct=round(100.0*errors/requests, 2)
     | sort by requests desc
   \`\`\`
   Compare to the proxy's reported request volume. If the proxy
   says it sent 3000 requests with 2000 UT/UC errors but the
   upstream's own server spans show 3000 requests at normal p95
   with 0% errors — the upstream is doing its job, the proxy is
   shedding connections before they ever get there.

   **When the disambiguation says "proxy is the cause":**

   - The failure mode is \`proxy-resource-exhaustion\` (a flavor of
     OOMKill, fd-exhaustion, or CPU saturation that lives ON THE
     PROXY, not on the named upstream).
   - Use rule 2's existing sub-checks against THE PROXY'S service
     name (not the upstream): client-vs-server ratio, span-
     emission-gap probe, pod cardinality, log scan.
   - The remediation is on the proxy: raise its memory / fd / CPU
     limits, scale its replicas, tune worker thread pool, NOT on
     the upstream. Do not recommend changes to the upstream's
     code or scale; it isn't the problem.
   - Counter-pattern to flag: "envoy says upstream X is slow, so
     let's investigate upstream X." That cascading inference is
     the exact regression we're trying to prevent — envoy's
     attribution is one *suspect*, not a verdict.

   This rule applies to ANY L7 proxy emitting transport-blame
   flags toward an apparently-healthy upstream. Service-name
   heuristics that suggest you're looking at a proxy:
   \`frontend-proxy\`, \`*-gateway\`, \`*-ingress\`, \`envoy-*\`,
   \`*-lb\`, \`nginx*\`. When the proxy's spans carry a
   \`response_flags\` attribute at all (envoy-specific), assume
   this rule applies.

   **This rule names WHERE — not WHY. It is not a complete
   diagnosis on its own.** "Currency Convert is returning EOF" is
   a tautology, not a root cause: the operator's next question is
   still "why can't currency respond?" Naming the boundary is
   step one of three. You MUST continue:

   - to rule 2's **client-vs-server span ratio** sub-check — to
     decide whether the downstream is crashing, dialing-failing,
     or slow,
   - to rule 2's **pod-cardinality AND span-emission-gap**
     sub-checks together — to distinguish between-pod replacement
     (high pod cardinality) from in-place container restart (pod
     cardinality 1 + repeating span-emission gaps). Either pattern
     points at OOMKill / readiness probe / startup failure; the
     absence of pod churn alone is NOT exoneration,
   - and then to the **stopping rule + summary template** at the
     bottom of this section, which requires you to name the
     failure mode and a specific remediation. Halting at the
     transport-signal layer is a known regression — do not
     present an investigation summary that names a downstream
     without naming why it's failing. Diagnosing "capacity" on
     the basis of \`dcount(pod) == 1\` while transport markers say
     EOF / connection-refused is a second known regression —
     don't make that flip; see rule 1's capacity-vs-crashloop
     disambiguation.

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

   **Sub-check: span-emission gaps (the PRIMARY crashloop probe —
   run this FIRST before pod cardinality).** When a container
   restarts in place — the default Kubernetes Deployment behavior
   on OOMKill — the service can't emit spans during the boot
   window (typically 5-60s depending on language runtime). Plot
   per-pod span count by minute and look for short, repeating
   gaps. Steady-state services show non-zero spans every minute.
   A crashlooping container shows blocks of non-zero minutes
   separated by 1-3 minute zero blocks at a repeating cadence
   (every ~5 min for the OOMKill pattern):
   \`\`\`kql
   dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
     | extend svc=tostring(resource.attributes['service.name']),
              pod=tostring(resource.attributes['k8s.pod.name'])
     | where svc == "<implicated>"
     | summarize spans=count() by pod, bin(_time, 60s)
     | sort by pod asc, _time asc
   \`\`\`
   Read the result row by row in time order. Repeating
   start-stop blocks (live, live, live, live, GAP, live, live,
   live, live, GAP) at a consistent period is the kubelet
   restart pattern on OOMKill or readiness-probe failure. **When
   you find repeating gaps, the diagnosis is container-level
   crashloop. Do NOT then proceed to declare "capacity" because
   pod cardinality is 1.** The gap pattern is what catches the
   in-place restart that pod cardinality cannot.

   **Sub-check: pod churn (a SECONDARY probe — only catches
   between-pod replacement).** The k8s \`restart_count\` resource
   attribute is not reliably exported by the demo SDKs. Pod-name
   cardinality catches pod-level replacements: Job-style pods,
   evicted pods, node failures, \`restartPolicy: Never\`. **It
   does NOT catch the most common OOMKill case** — a Kubernetes
   Deployment with the default \`restartPolicy: Always\` restarts
   the *container* in place: same pod, same name, same UID, only
   the container's internal restart counter ticks. A service can
   be OOMKill-crashlooping every 5 minutes for weeks with
   \`dcount(pod) == 1\`. So: high cardinality CONFIRMS pod-level
   replacement; **low cardinality is silence, not a verdict**.
   Always run the span-emission-gap probe above before drawing
   any conclusion from pod cardinality.
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
   also shows EITHER pod churn (between-pod replacement) OR
   span-emission gaps (in-place container restart), the diagnosis
   is the named downstream in an OOMKill / readiness-probe /
   startup-failure state. Recommend "raise memory limits on
   \`<svc>\`" or "investigate \`<svc>\` startup failure" — not
   anything about the caller's logic, and not "scale replicas"
   alone (that absorbs symptoms without fixing the per-pod cause).

   **Sub-check: read the service's own logs.** Spans tell you the
   shape of the failure; logs often tell you the cause in plain
   text. The implicated service may be emitting explicit warnings
   — GC long-pause events, exporter back-pressure notices, panic
   stack traces, "connection pool exhausted", config-parse errors
   on boot — that the span layer can't surface. Always pull the
   implicated service's warnings before declaring a failure mode:
   \`\`\`kql
   dataset="${datasetId}"
     | where isnotnull(severity_number) and isnotnull(body)
     | extend svc=tostring(resource.attributes['service.name']),
              sev=tostring(severity_text),
              msg=tostring(body)
     | where svc == "<implicated>"
       and sev in ("WARN", "WARNING", "ERROR", "FATAL")
     | summarize n=count() by msg
     | sort by n desc
     | limit 20
   \`\`\`
   Read the top messages by frequency. A repeated WARN about
   "BatchLogRecordProcessor queue is full" / "OTLP exporter
   timeout" / "GC pause %ds" / "circuit breaker open" / "config
   reload failed" is usually the smoking gun the trace shape
   doesn't deliver. If the top message is application-level
   nonsense, the cause is *probably* in the spans / k8s layer
   instead — but you've ruled out the cheap log answer.

   **Sub-check: log silence relative to request volume (self-
   silencing failures).** Some failure modes cause the service's
   logger ITSELF to stall — the canonical case is the OTel SDK's
   log exporter back-pressuring on a full queue. The SDK then
   blocks new log writes, including its own warnings about being
   blocked. From the outside this looks like "service is handling
   traffic, no errors logged" — which the agent will read as
   healthy. **It is not.** Absence of log messages from a busy
   service is itself a signal.

   Compare per-minute log volume to per-minute span volume from
   the same service. Healthy services emit logs at a steady rate
   tracking request volume; logger-stalled services show requests
   continuing while log emission collapses toward zero:
   \`\`\`kql
   dataset="${datasetId}"
     | where isnotnull(end_time_unix_nano)
        or (isnotnull(severity_number) and isnotnull(body))
     | extend svc=tostring(resource.attributes['service.name']),
              kind=iff(isnotnull(span_id) and isnotnull(end_time_unix_nano),
                       "span",
                       iff(isnotnull(severity_number) and isnotnull(body),
                           "log",
                           "other"))
     | where svc == "<implicated>" and kind in ("span", "log")
     | summarize n=count() by kind, bin(_time, 60s)
     | sort by _time asc
   \`\`\`
   Eyeball the two series side-by-side. If the span line stays
   roughly constant while the log line drops to near-zero (or to
   exactly the same low number every minute, suggesting only the
   most-throttled message is getting through), the service's
   logger is stalled — the failure mode is at the SDK / exporter
   layer, not the application. This is the diagnostic you would
   NEVER reach by querying only spans.

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
   - \`oom-kill\` — container memory limit hit. The DEFAULT
     Kubernetes Deployment restarts the container in place on
     OOMKill, so the pod stays alive (same name, same UID) and
     \`dcount(pod) == 1\` is normal — do not interpret it as
     ruling OOMKill out. Confirmation comes from transport
     markers on the caller (EOF, connection refused, empty
     status.message) PLUS one of: span-emission gaps in the
     server's pod at a repeating cadence (in-place restart),
     OR pod-name churn (between-pod replacement, only happens
     for Jobs, evictions, restartPolicy:Never, or node failures).
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
   - \`proxy-resource-exhaustion\` — an L7 PROXY (envoy / nginx /
     ALB / etc.) is emitting upstream-blame flags (UT, UC, UR,
     UH, UF) toward a named upstream, but the named upstream's
     own server spans show healthy latency and near-zero error
     rate. The proxy itself is OOM / fd-exhausted / CPU-saturated
     / worker-pool-full and shedding connections before they
     reach the upstream. Remediation lands on the proxy
     (memory / fd / CPU / replicas), NOT the named upstream.
     See rule 1's "L7 proxy attribution illusion" disambiguation
     — this failure mode is specifically there to break the
     "envoy blames upstream → investigate upstream" regression.
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
   - \`proxy-resource-exhaustion\` → "Raise memory / fd limits on
     \`<proxy>\` from \`<X>\` to \`<Y>\`" or "Scale \`<proxy>\` to
     \`<N>\` replicas" or "Tune \`<proxy>\` worker thread pool".
     Remediation MUST name the proxy (e.g. \`frontend-proxy\`,
     \`*-gateway\`), NOT the named upstream that envoy's
     attribution pointed at.

5. **Confidence + alternatives.** One of \`high\` / \`medium\` /
   \`low\`. If \`medium\` or below, list the next 1-2 candidate
   hypotheses you'd test, with the query that would refute or
   confirm each. This is the confounder-ranking rule from the
   2026-05-20 session — name what else might be true.

### Worked example — currency OOMKill, 2026-05-26

This is the exact failure mode a prior agent run halted on too
early. Use it as a pattern reference.

\`\`\`
Symptom layer (rule 1): checkout PlaceOrder error rate ~90%,
top error message "failed to prepare order: failed to convert
price of <X> to <Y>". Wrapper text — checkout was *converting*
when the downstream gRPC failed. Inner client span
oteldemo.CurrencyService/Convert: gRPC code 14, message
"error reading from server: EOF" (plus a "connection refused"
sibling). Transport signal — currency is the implicated
downstream.

Rule 1 capacity-vs-crashloop disambiguation: client messages
are EOF and connection-refused, NOT DeadlineExceeded or
Unavailable-no-healthy-upstream. That is a crash signature,
not capacity. Hold that conclusion through the next checks
even if pod cardinality looks quiet.

Refutation: is currency actually returning errors, or not
responding? Run rule 2 client-vs-server ratio for
oteldemo.CurrencyService/Convert:
  frontend  CLIENT (kind=3): 3899
  checkout  CLIENT (kind=3):   16
  currency  SERVER (kind=2): 1035
~26% coverage — about 74% of upstream calls have no matching
server span. Currency is crashing, not erroring.

Rule 2 pod-cardinality on currency over 5m:
  dcount(pod) = 1 — same pod name throughout the hour.
**This does NOT rule out OOMKill.** A Deployment with the
default restartPolicy:Always restarts the container in place;
pod name doesn't change. Continue to the span-emission-gap
sub-check.

Rule 2 span-emission gaps on the currency pod (per-minute
span count):
  spans non-zero from 04:06–04:10, then 04:11–04:12 zero,
  04:13–04:17 non-zero, 04:18–04:19 zero, 04:20–04:24 non-zero…
A ~1-2 minute gap every ~5 minutes for the entire hour.
That is the kubelet restart cadence — container is dying and
being restarted in place.

Failure mode: oom-kill (in-place container restart pattern +
transport-layer EOF/connection-refused on caller). Evidence:
  client/server ratio = 26%
  dcount(pod) = 1 (in-place restart, not pod replacement)
  span-emission gaps at ~5min cadence (container restart
    cycle)
  trace duration before EOF ~118s on the representative trace
    (caller queuing while container is dead)

Remediation: "Raise memory limit on currency Deployment from
20Mi to 200Mi" (same fix pattern as the postgres 100Mi → fix
from the prior week). NOT "scale replicas" alone — that
absorbs symptoms but every replica will still OOMKill on the
same cadence.

Confidence: high. Alternatives ranked:
  - readiness-probe failure (lower) — would produce similar
    span-emission gaps, but readiness failures don't produce
    EOF mid-call; they produce Unavailable from the LB before
    the call reaches the pod. EOF is post-handshake.
  - capacity-saturation (ruled out) — would produce
    DeadlineExceeded with server spans completing slowly, not
    EOF with missing server spans.
  - dependency-failure (ruled out) — currency has no
    significant downstreams in the topology.
\`\`\`

That summary is **complete**. "Currency is returning EOF" is
**not** — it stops at the symptom layer. "Currency is
capacity-saturated because pod count is 1" is also **not** —
that's the 2026-05-27 known regression (see counterexample
immediately below); the EOF marker plus zero server errors
plus span-emission gaps override pod-count.

### Counterexample — labeled WRONG answer (2026-05-27 regression)

The pattern below is a real Investigator transcript that flipped
to the wrong failure mode. Use it as a negative pattern: when
you find yourself walking this path, stop and re-read rule 1's
capacity-vs-crashloop disambiguation.

\`\`\`
WRONG conclusion shape:

  Evidence the agent gathered:
    frontend  CLIENT spans: 3919 calls, 2808 errors (72% errs)
    checkout  CLIENT spans: 41 calls, 24 errors, 22 of which
                            are EOF
    currency  SERVER spans: 1128 calls, 0 errors,
                            p95 = 179.09s, p99 = 216.51s
    currency  dcount(pod) over 5m = 1 for the full hour

  Wrong reasoning (the regression):
    "Server coverage 28.5%, server errors 0, pod cardinality 1.
     Server is alive but slow. Conclusion: capacity / latency-
     saturation. Recommend: scale replicas / add HPA."

  Why this is wrong:
  1. 22 EOF errors on the client side is a CRASH signal per
     rule 1. EOF means the server died mid-call. The number is
     well above the N≥5 threshold for "crash, not capacity."
  2. **Zero server errors with 72% client error rate** is the
     decisive asymmetry. Capacity-saturated servers produce
     errors on themselves (DeadlineExceeded, 503, Unavailable).
     The server died before it could record errors.
  3. **p95 = 179 seconds for currency.Convert** is biologically
     impossible for a microsecond-scale operation. That's a
     death-spiral latency (GC churn, swap thrash before OOM),
     not a capacity tail.
  4. **\`dcount(pod) == 1\`** says nothing about in-place
     container restart, which is what a Deployment does by
     default on OOMKill. The pod-cardinality probe was not
     designed to catch this case. The span-emission-gap probe
     was not run; if it had been, it would have shown ~5-minute
     restart cadence.

  Correct conclusion:
    Failure mode = oom-kill (in-place container restart).
    Remediation = Raise currency memory limit (20Mi → 200Mi),
    NOT scale replicas. Scaling absorbs symptoms; every replica
    will OOMKill on the same cadence until the limit is fixed.
\`\`\`

If you find yourself about to conclude \`capacity\` or
\`latency-saturation\` while transport markers say \`EOF\` /
\`connection refused\` and the server's own error rate is near
zero, stop. Run the span-emission-gap probe. Reread rule 1's
capacity-vs-crashloop disambiguation. The right answer is in
the crash family.

### Counterexample — labeled WRONG answer (L7 proxy attribution illusion)

A second regression class, distinct from the OOMKill capacity-flip
above. The pattern: a long-running chronic 5xx baseline at the
\`frontend-proxy\` (envoy) where the proxy itself was memory-
constrained, but the failures presented as upstream-cluster
errors (UT, UC on cluster \`frontend\`). The Investigator chased
the upstream service through multiple rounds because envoy's
attribution pointed there.

\`\`\`
WRONG conclusion shape:

  Evidence the agent gathered:
    frontend-proxy emits ~20% errors at cluster boundary
                  attributes['response_flags'] in (UT, UC)
                  rpc.service / upstream cluster = "frontend"
    frontend (the BFF) server spans: handlers run in <62ms,
                  near-zero error rate at the application layer

  Wrong reasoning (the regression):
    "The proxy is reporting UT/UC on the frontend cluster.
     Frontend must be slow or unreachable. Conclusion:
     latency-saturation on frontend BFF.
     Recommend: scale BFF replicas / raise BFF deadlines."

  Why this is wrong:
  1. The BFF's own server spans show healthy latency
     (<62ms median, ~normal). A truly slow upstream would
     have inflated server-side p95 to match the proxy's
     reported wait.
  2. The BFF's own error rate is near zero. A truly failing
     upstream would have BFF server errors matching the
     proxy's reported error volume.
  3. UT/UC on envoy can be proxy-side as much as upstream-
     side: proxy OOM unable to allocate sockets emits UC;
     proxy CPU/worker saturation emits UT.
  4. The proxy itself is memory-constrained — it sheds
     connections before they reach the BFF. The
     attribution is a side-effect, not a verdict.

  Correct conclusion:
    Failure mode = proxy-resource-exhaustion (envoy / L7 proxy
    layer).
    Remediation = Raise frontend-proxy memory limit (or
    fd-limit / replicas, depending on the resource that's
    constrained). DO NOT touch the BFF; it is innocent.
\`\`\`

If envoy emits \`UT\` / \`UC\` / \`UR\` / \`UH\` / \`UF\` against a
named upstream and that upstream's own server spans look fine,
**the proxy is the failing layer**. Following envoy's
attribution down into a healthy upstream is the cascading-
inference regression — apply rule 1's L7 proxy attribution
illusion disambiguation instead.

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
