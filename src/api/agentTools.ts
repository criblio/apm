/**
 * APM's tool implementations for the Copilot Investigator agent
 * loop. The generic plumbing (run_search execution, native-UI tool
 * acknowledgements, summary normalization, arg parsing) lives in
 * @cribl/app-utils/agent-tools — this module wires it to APM's
 * query layer and adds the one genuinely APM-specific tool:
 * render_trace, which fetches a full trace and hands it to the UI
 * as a SpanTree waterfall card.
 *
 * The executors are built by `createApmToolExecutors`, which takes
 * the host environment (SearchClient, dataset resolution) as
 * injected dependencies so a non-browser host can run the same
 * tools. The module-level `executeToolCall`/`requiresApproval`
 * exports are the browser-wired instance the client loop imports.
 */
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import {
  createRunSearchTool,
  createRunMetricsQueryTool,
  executeCommonToolCall,
  parseArgs,
  type ToolCallInvocation,
  type ToolExecutionResult,
} from '@cribl/app-utils/agent-tools';
import type { MetricsTransport } from '@cribl/app-utils/metrics';
import { assertReadOnlyKql } from './kqlSafety';
import { getTrace } from './search';
import { browserSearchClient, type SearchClient } from './searchClient';
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
 * Everything the APM tool executors need from their host
 * environment. Defaults reproduce the browser wiring exactly; a
 * non-browser host (server-side investigation runtime, Node
 * harness) supplies its own SearchClient and dataset resolution.
 */
export interface ApmToolExecutorDeps {
  /** Query execution + environment probes. */
  client?: SearchClient;
  /** The dataset id the investigation is scoped to. */
  dataset?: () => string;
  /** The metrics-store dataset for run_metrics_query. */
  metricsDataset?: () => string;
  /**
   * How run_metrics_query reaches the metrics store. Omit in the
   * browser (the framework default reads `window.CRIBL_API_URL` +
   * the iframe proxy). A non-browser host injects a transport that
   * targets its own base URL with auth — the metrics parallel to the
   * injected `client` used for run_search.
   */
  metricsTransport?: MetricsTransport;
}

export interface ApmToolExecutors {
  executeToolCall(
    call: ToolCallInvocation,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

/**
 * The investigator runs queries without prompting. Both data tools
 * are read-only — run_search is guarded by assertReadOnlyKql and
 * PromQL has no mutating forms — so there's nothing to gate, and
 * the mid-thought approval pause just slowed investigations down.
 * `confirmBeforeRunning` (a model-supplied hint) is likewise
 * ignored: no tool call needs approval, so this always returns
 * false.
 *
 * Host-independent by construction: it reads nothing from the
 * executor deps, so it stays a module function rather than a
 * closure that every executor set has to carry.
 */
export function requiresApproval(): boolean {
  return false;
}

/**
 * Fetch a full trace by trace_id and attach it as UI metadata. The
 * agent gets a textual summary back (span count, services, root
 * operation, duration, error count) so it can continue reasoning;
 * the UI displays the actual waterfall via the SpanTree component.
 */
async function renderTraceTool(
  args: RenderTraceArgs,
  client: SearchClient,
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
    const trace = await getTrace(traceId, '-24h', 'now', client);
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
 * Build the APM tool executors with the host environment injected.
 *
 * run_search gets the shared search-job runner via the client, the
 * read-only KQL safety gate, and the resolved dataset as the only
 * allowed scope. run_metrics_query points at the metrics store.
 * render_trace fetches through the same client. Everything else —
 * update_context, present_investigation_summary, and the native
 * UI's tool surface — falls through to the shared acknowledgement
 * handler so the loop keeps moving.
 */
export function createApmToolExecutors(deps: ApmToolExecutorDeps = {}): ApmToolExecutors {
  const client = deps.client ?? browserSearchClient;
  const dataset = deps.dataset ?? (() => getCurrentDataset());

  const runSearchTool = createRunSearchTool({
    runQuery: (kql, earliest, latest, limit) => client.runQuery(kql, earliest, latest, limit),
    assertSafe: (query, allowedDatasets) => assertReadOnlyKql(query, allowedDatasets),
    datasetId: dataset,
  });

  // PromQL against the fast metrics store (criblapm_* RED metrics +
  // raw OTel metrics). Read-only by construction, so it auto-runs
  // with no approval. The shared factory lives in the framework and
  // already falls back to METRICS_DATASET, so pass the override
  // straight through rather than re-stating that default here.
  const runMetricsQueryTool = createRunMetricsQueryTool({
    dataset: deps.metricsDataset,
    transport: deps.metricsTransport,
  });

  async function executeToolCall(
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
        const { content, ui } = await renderTraceTool(args, client);
        return { id: call.id, name: call.name, content, ui };
      }

      default:
        return executeCommonToolCall(call, {
          embedLabel: 'the embedded Cribl APM investigation',
        });
    }
  }

  return { executeToolCall };
}

/** The browser-wired executors, matching the app's historical
 *  module-level surface. The agent loop imports these directly. */
export const { executeToolCall } = createApmToolExecutors();
