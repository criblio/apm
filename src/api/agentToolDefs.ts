/**
 * Tool definitions sent to the agent endpoint in the `tools` field
 * of each POST. Without these, the agent falls back to text-only
 * mode and will refuse to run searches ("I can't execute searches
 * against your otel dataset from this chat session").
 *
 * The definitions are extracted from the native /search/agent UI's
 * captured request (see docs/research/investigator-spike/). The
 * server validates against this schema, so the shape here must
 * match what it expects.
 *
 * We deliberately ship a MINIMAL set — only the tools we actually
 * handle client-side. The native UI sends ~14 tools including
 * integrations we don't want (Firehydrant, Jira, Bitbucket,
 * notebook editing). Sending fewer tools makes the investigation
 * more focused and lets the agent converge on run_search →
 * present_investigation_summary.
 */
import type { AgentToolDefinition } from './agent';

export const APM_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    id: 'run_search',
    description: 'Use this tool to run a search',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The KQL query to execute. Should be a valid Cribl search query.',
          minLength: 1,
        },
        earliest: {
          type: ['string', 'number'],
          description:
            'Earliest time for the search. Can be a relative (e.g., "-1h", "-1d") or absolute timestamp as a unix time value in seconds (e.g. 1700511360).',
          default: '-1h',
        },
        latest: {
          type: ['string', 'number'],
          description:
            'Latest time for the search. Can be relative (e.g., "now", "-5m") or absolute timestamp as a unix time value in seconds (e.g. 1700511360).',
          default: 'now',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of events to return.',
          minimum: 1,
          maximum: 1000,
          default: 10,
        },
        description: {
          type: 'string',
          description: 'A description of the search that is about to be run',
          maxLength: 100,
        },
        confirmBeforeRunning: {
          type: 'boolean',
          description:
            'Compatibility hint only. Read-only queries run immediately in Cribl APM; the read-only guard is enforced independently.',
          default: false,
        },
      },
      required: ['query', 'description', 'confirmBeforeRunning'],
    },
  },
  {
    id: 'run_metrics_query',
    description:
      'Run a PromQL query against the fast Cribl APM metrics store. MUCH faster than run_search for RED numbers (rate, error rate, latency) — prefer it whenever a metric answers the question. Omit step for an instant snapshot; provide step (seconds) for a range/time-series. ' +
      'Span-derived RED metrics (all prefixed criblapm_): ' +
      'criblapm_requests_total{svc,operation,outcome} — DELTA counter, read with sum_over_time (NOT rate/increase), e.g. sum(sum_over_time(criblapm_requests_total[15m])) by (svc); error rate is the outcome="error" slice over the total. ' +
      'criblapm_request_latency_ms{svc,quantile} and criblapm_op_latency_ms{svc,operation,quantile} — precomputed latency GAUGES in ms labelled quantile=p50|p95|p99, read with avg_over_time, e.g. avg(avg_over_time(criblapm_request_latency_ms{svc="frontend",quantile="p95"}[15m])). ' +
      'criblapm_edge_calls_total{parent,child,outcome} + criblapm_edge_latency_ms{parent,child,quantile} for service→service RPC edges; criblapm_messaging_total + criblapm_msg_latency_ms for messaging; criblapm_status_class_total{svc,status_class} for HTTP/gRPC status mix. ' +
      'Raw OTel metrics (dotted names like process.runtime.go.goroutines, postgresql.backends) are also present — reach them with {__name__="the.dotted.name"}. Only core PromQL is supported (no label_replace, no vector `or`).',
    schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'PromQL expression, e.g. sum(sum_over_time(criblapm_requests_total[15m])) by (svc)',
          minLength: 1,
        },
        earliest: {
          type: ['string', 'number'],
          description: 'Earliest time. Relative ("-1h") or absolute unix seconds.',
          default: '-1h',
        },
        latest: {
          type: ['string', 'number'],
          description: 'Latest time. Relative ("now", "-5m") or absolute unix seconds.',
          default: 'now',
        },
        step: {
          type: 'number',
          description:
            'Range-query step in seconds. Omit for an instant query (one sample per series at latest).',
          minimum: 15,
        },
        description: {
          type: 'string',
          description: 'A short description of the metrics query about to run',
          maxLength: 100,
        },
      },
      required: ['query', 'description'],
    },
  },
  {
    id: 'render_trace',
    description:
      'Display a distributed trace (span waterfall) to the user. Call this when you want to show a specific trace — for example, an erroring trace, a slow trace, or a trace the user asked about by id. The UI fetches and renders the full span tree from the provided trace_id.',
    schema: {
      type: 'object',
      properties: {
        traceId: {
          type: 'string',
          description: 'The trace_id to render. Must be a hexadecimal trace_id from the otel dataset.',
          minLength: 1,
        },
        description: {
          type: 'string',
          description:
            'A short (one sentence) description of why this trace is being shown — e.g. "Slowest payment Charge trace in the window" or "Representative failing checkout flow".',
          maxLength: 200,
        },
      },
      required: ['traceId', 'description'],
    },
  },
  {
    id: 'update_context',
    description: 'Update the context',
    schema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The key to update in the context.',
        },
        value: {
          type: ['string', 'number', 'boolean', 'object'],
          description: 'The value to update the key to.',
        },
      },
      required: ['key', 'value'],
    },
  },
  {
    id: 'present_investigation_summary',
    description:
      'Present the final investigation summary with structured findings and conclusion. Call this tool ONLY when the investigation is complete and you are ready to present results.',
    schema: {
      type: 'object',
      properties: {
        findings: {
          type: 'array',
          description:
            'Investigation findings grouped by evidence category. Each entry has a category name and detailed findings with specific metrics (counts, timestamps, error codes).',
          items: {
            type: 'object',
            properties: {
              category: {
                type: 'string',
                description:
                  'Descriptive evidence category name (e.g., "Error Scope", "Dependency Failure", "Affected Pod").',
              },
              details: {
                type: 'string',
                description:
                  'Markdown-formatted findings for this category. Include specific metrics, field values, counts, and timestamps.',
              },
            },
            required: ['category', 'details'],
          },
          minItems: 1,
        },
        conclusion: {
          type: 'string',
          description:
            'Root cause hypothesis or conclusion. 1-3 sentences explaining what happened and why the evidence supports it. If stuck/blocked, explain the blocker.',
        },
      },
      required: ['findings', 'conclusion'],
    },
  },
];
