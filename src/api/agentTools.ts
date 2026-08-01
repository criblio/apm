/**
 * APM's client-side tool implementations for the Copilot
 * Investigator agent loop. The generic plumbing (run_search
 * execution, native-UI tool acknowledgements, summary
 * normalization, arg parsing) lives in @cribl/app-utils/agent-tools
 * — this module wires it to APM's query layer and adds the one
 * genuinely APM-specific tool: render_trace, which fetches a full
 * trace and hands it to the UI as a SpanTree waterfall card.
 */
import { runQuery } from './cribl';
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import {
  createRunSearchTool,
  createRunMetricsQueryTool,
  executeCommonToolCall,
  parseArgs,
  type ToolCallInvocation,
  type ToolExecutionResult,
} from '@cribl/app-utils/agent-tools';
import { METRICS_DATASET } from '@cribl/app-utils/metrics';
import { assertReadOnlyKql } from './kqlSafety';
import { getTrace } from './search';
import type { JaegerTrace } from './types';
import { summarizeTrace } from './transform';

export {
  parseArgs,
  type RunSearchUi,
  type SummaryUi,
  type MetricsQueryUi,
  type ToolCallInvocation,
  type ToolExecutionResult,
  type ToolResultUi,
} from '@cribl/app-utils/agent-tools';

/** UI payload for a render_trace tool execution. */
export type RenderTraceUi = {
  kind: 'trace';
  traceId: string;
  description: string;
  trace?: JaegerTrace;
  error?: string;
};

interface RenderTraceArgs {
  traceId: string;
  description?: string;
}

/**
 * run_search executor with APM's dependencies injected: the shared
 * search-job runner, the read-only KQL safety gate, and the
 * currently-selected dataset as the only allowed scope.
 */
const runSearchTool = createRunSearchTool({
  runQuery,
  assertSafe: (query, allowedDatasets) => assertReadOnlyKql(query, allowedDatasets),
  datasetId: () => getCurrentDataset(),
});

/**
 * run_metrics_query executor: PromQL against the fast metrics store
 * (criblapm_* RED metrics + raw OTel metrics). Read-only by construction,
 * so it auto-runs with no approval. The shared factory lives in the
 * framework; APM just points it at the metrics dataset.
 */
const runMetricsQueryTool = createRunMetricsQueryTool({
  dataset: () => METRICS_DATASET,
});

/**
 * Fetch a full trace by trace_id and attach it as UI metadata. The
 * agent gets a textual summary back (span count, services, root
 * operation, duration, error count) so it can continue reasoning;
 * the UI displays the actual waterfall via the SpanTree component.
 */
async function renderTraceTool(
  args: RenderTraceArgs,
): Promise<{ content: string; ui: RenderTraceUi }> {
  const traceId = (args.traceId || '').trim();
  const description = args.description ?? '';
  if (!traceId) {
    const ui: RenderTraceUi = {
      kind: 'trace',
      traceId,
      description,
      error: 'No traceId provided',
    };
    return {
      content: 'render_trace failed: no traceId provided. Pass a hexadecimal trace_id string.',
      ui,
    };
  }

  try {
    // Widen to -24h here — traces can extend beyond the caller's
    // investigation window, and the trace lookup is cheap enough
    // to make the wider scan worth it for a single trace.
    const trace = await getTrace(traceId, '-24h', 'now');
    if (!trace) {
      const ui: RenderTraceUi = {
        kind: 'trace',
        traceId,
        description,
        error: 'Trace not found',
      };
      return {
        content: `Trace ${traceId} was not found in the last 24 hours. It may have expired from the dataset retention window, or the id may be wrong.`,
        ui,
      };
    }

    const summary = summarizeTrace(trace);
    const ui: RenderTraceUi = {
      kind: 'trace',
      traceId,
      description,
      trace,
    };

    // Give the agent a concise textual picture of the trace so it
    // can reason about it without the full span dump blowing out
    // its context window.
    const services = Array.from(new Set(summary.services)).join(', ');
    const durMs = (summary.duration / 1000).toFixed(1);
    const startIso = new Date(summary.startTime / 1000).toISOString();
    const content = [
      `Trace ${traceId} rendered to the user.`,
      `Root: ${summary.rootService}/${summary.rootOperation}`,
      `Start: ${startIso}`,
      `Duration: ${durMs}ms`,
      `Spans: ${summary.spanCount}`,
      `Error spans: ${summary.errorCount}`,
      `Services involved: ${services}`,
    ].join(' · ');

    return { content, ui };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const ui: RenderTraceUi = {
      kind: 'trace',
      traceId,
      description,
      error: msg,
    };
    return {
      content: `render_trace failed for ${traceId}: ${msg}`,
      ui,
    };
  }
}

/**
 * Main dispatcher. run_search and render_trace get real executors;
 * everything else — update_context, present_investigation_summary,
 * and the native UI's tool surface — falls through to the shared
 * acknowledgement handler so the loop keeps moving.
 */
export async function executeToolCall(
  call: ToolCallInvocation,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  switch (call.name) {
    case 'run_search':
      return runSearchTool(call, signal);

    case 'run_metrics_query':
      return runMetricsQueryTool(call, signal);

    case 'render_trace': {
      const args = parseArgs<RenderTraceArgs>(call.arguments);
      const { content, ui } = await renderTraceTool(args);
      return { id: call.id, name: call.name, content, ui };
    }

    default:
      return executeCommonToolCall(call, {
        embedLabel: 'the embedded Cribl APM investigation',
      });
  }
}

/**
 * The investigator runs queries without prompting. Both data tools are
 * read-only — run_search is guarded by assertReadOnlyKql and PromQL has
 * no mutating forms — so there's nothing to gate, and the mid-thought
 * approval pause just slowed investigations down. `confirmBeforeRunning`
 * (a model-supplied hint) is likewise ignored: no tool call needs
 * approval, so this always returns false.
 */
export function requiresApproval(): boolean {
  return false;
}
