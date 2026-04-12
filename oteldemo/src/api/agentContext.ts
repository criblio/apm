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

### Example working queries (proven against this data)

**Service error-rate + latency breakdown:**
\`\`\`kql
dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
  | extend svc=tostring(resource.attributes['service.name']),
          dur_us=(toreal(end_time_unix_nano)-toreal(start_time_unix_nano))/1000.0,
          is_error=(tostring(status.code)=="2")
  | summarize requests=count(),
              errors=countif(is_error),
              p50=percentile(dur_us, 50),
              p95=percentile(dur_us, 95),
              p99=percentile(dur_us, 99)
    by svc
  | extend error_rate=round(100.0*errors/requests, 2)
  | sort by requests desc
\`\`\`

**Service-to-service dependency call graph (with error counts):**
\`\`\`kql
dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
  | extend svc=tostring(resource.attributes['service.name']),
          parent=tostring(parent_span_id),
          is_error=(tostring(status.code)=="2")
  | where parent != "" and isnotempty(parent)
  | project trace_id, parent, svc, is_error
  | join kind=inner (
      dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
      | extend psvc=tostring(resource.attributes['service.name']),
              psid=tostring(span_id)
      | project trace_id, psid, psvc
    ) on trace_id, $left.parent == $right.psid
  | where svc != psvc
  | summarize callCount=count(), errorCount=countif(is_error) by parent=psvc, child=svc
  | sort by callCount desc
\`\`\`

**Recent error spans for a specific service:**
\`\`\`kql
dataset="${datasetId}" | where isnotnull(end_time_unix_nano)
  | extend svc=tostring(resource.attributes['service.name']),
          is_error=(tostring(status.code)=="2")
  | where svc=="<SERVICE>" and is_error
  | project _time, trace_id, span_id, name, status.message, attributes
  | sort by _time desc
  | limit 50
\`\`\`
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

Use the field mappings and example queries above. Do NOT use regex
extraction on \`_raw\`. Do NOT call \`get_dataset_context\` — the
schema is already documented above. Bracket-quote all dotted field
names (e.g. \`["service.name"]\`). When you need to run a search,
use the \`run_search\` tool with the time range \`${earliest}\` to
\`${latest}\` unless you have reason to widen it.
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
