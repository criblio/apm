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

**Dotted field names must be bracket-quoted.** Fields like \`rpc.method\`,
\`service.name\`, \`k8s.pod.name\` are NOT valid as bare identifiers in
Cribl KQL. You MUST wrap them in bracket-quotes:

- CORRECT:   \`["rpc.method"]\`, \`["service.name"]\`, \`["k8s.pod.name"]\`
- WRONG:     \`rpc.method\`, \`service.name\` (KQL parser will reject)

This rule applies EVERYWHERE you reference a dotted field: in \`where\`
clauses, \`extend\` expressions, \`project\` lists, \`summarize by\` keys,
and \`sort by\` fields.

The one exception: when reaching into a nested object, you can use
regular dot syntax for the object name, then bracket-quote the leaf
key — e.g. \`resource.attributes['service.name']\` is valid because
\`resource.attributes\` is a nested object.

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

### Common failure modes to check (in priority order)

Do not anchor on the first error signal you see. Work through these
four checks before committing to a root-cause hypothesis, and weight
their **recency** — signals in the most recent 1-3 minutes beat
signals from earlier in the lookback window, because the question is
almost always "what changed recently?".

1. **Traffic drops (service went dark).** The loudest signal when a
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

2. **Error-rate changes over time, not totals.** Run an
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

3. **Error propagation vs. origin.** An error-rate spike on a caller
   (e.g. \`frontend-proxy\`, \`load-generator\`) is almost never the
   root cause. Pull the set of trace_ids involved in the spike and
   look for the *earliest failing span in the tree* — that service
   is the origin. Example propagation query already documented in
   the "Service-to-service dependency call graph" example above.

4. **Representative trace + rendered waterfall.** Once you have a
   hypothesis, render one trace that illustrates the full call
   chain from root to failing leaf. Don't just list trace_ids — use
   the \`render_trace\` tool.

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
