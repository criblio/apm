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
          description: 'Whether to confirm with the user before running the search.',
          default: true,
        },
      },
      required: ['query', 'description', 'confirmBeforeRunning'],
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
