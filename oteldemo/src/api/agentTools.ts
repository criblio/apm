/**
 * Client-side tool implementations for the Copilot Investigator
 * agent loop. When the agent emits a tool_call, agentLoop dispatches
 * to the matching function here, collects the result, and appends
 * a {role: 'tool'} message to the conversation before sending the
 * next POST.
 *
 * Tools that don't need data access (update_context,
 * present_investigation_summary, clickable_suggestion_button,
 * edit_notebook, show_exit) still need a registered handler so the
 * loop can acknowledge them — otherwise the agent gets no tool
 * result and spins.
 */
import { runQuery } from './cribl';

export interface ToolCallInvocation {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolExecutionResult {
  id: string;
  name: string;
  /** The tool result content sent back to the agent as a
   *  {role:'tool', tool_call_id, content} message. Freeform string
   *  (JSON-stringified for structured tools, markdown for summaries). */
  content: string;
  /** Optional UI metadata — query results table, rendered chart,
   *  etc. — that the chat UI can render inline beside the tool call
   *  card. Not sent back to the agent. */
  ui?: RunSearchUi;
}

/** UI payload for a run_search tool execution. */
export interface RunSearchUi {
  query: string;
  description?: string;
  earliest: string;
  latest: string;
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
  error?: string;
}

/** Arguments parsed out of a tool_call.function.arguments JSON string. */
interface RunSearchArgs {
  query: string;
  earliest?: string | number;
  latest?: string | number;
  limit?: number;
  description?: string;
  confirmBeforeRunning?: boolean;
}

interface UpdateContextArgs {
  key: string;
  value: unknown;
}

interface PresentInvestigationSummaryArgs {
  findings?: Array<{ category?: string; details?: string | string[] }>;
  conclusion?: string;
}

interface EditNotebookArgs {
  title?: string;
  preamble?: string;
  searchNarratives?: Array<{ jobId?: string; narrative?: string }>;
  conclusion?: string;
}

/**
 * Parse a tool_calls[i].function.arguments JSON string into a typed
 * object. Tool call arguments arrive as a stringified JSON blob in
 * the OpenAI function-calling convention.
 */
function parseArgs<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return {} as T;
  }
}

/**
 * Execute run_search: kick off a Cribl search job, wait for it,
 * return both the textual summary (for the agent) and the raw rows
 * (for the UI). Errors are caught and reported back to the agent so
 * it can self-correct rather than stalling the loop.
 */
async function runSearchTool(
  args: RunSearchArgs,
  signal?: AbortSignal,
): Promise<{ content: string; ui: RunSearchUi }> {
  const earliest = normalizeTimeArg(args.earliest ?? '-15m');
  const latest = normalizeTimeArg(args.latest ?? 'now');
  const limit = Math.min(Math.max(1, args.limit ?? 100), 1000);
  const description = args.description ?? '';

  const started = Date.now();
  try {
    if (signal?.aborted) throw new Error('aborted');
    const rows = await runQuery(args.query, earliest, latest, limit);
    const durationMs = Date.now() - started;

    const ui: RunSearchUi = {
      query: args.query,
      description,
      earliest,
      latest,
      rows,
      rowCount: rows.length,
      durationMs,
    };

    // Feed a compact textual representation back to the agent. It
    // doesn't need every row — the summary + first N rows is enough
    // to reason about. Full rows stay in the UI for the human.
    const content = formatRowsForAgent(rows, rowCap(limit));
    return { content, ui };
  } catch (err) {
    const durationMs = Date.now() - started;
    const msg = err instanceof Error ? err.message : String(err);
    const ui: RunSearchUi = {
      query: args.query,
      description,
      earliest,
      latest,
      rows: [],
      rowCount: 0,
      durationMs,
      error: msg,
    };
    return {
      content: `Search failed: ${msg}. The query was:\n\n${args.query}\n\nPlease revise and retry.`,
      ui,
    };
  }
}

/**
 * The agent gets a capped number of rows — enough to reason about
 * the result, not so many it blows the context window. Match the
 * native UI's behavior: top ~50 rows for aggregate queries.
 */
function rowCap(limit: number): number {
  return Math.min(50, limit);
}

/** Coerce a time arg that might be a number (unix seconds) into a
 *  relative/absolute string that runQuery accepts. */
function normalizeTimeArg(v: string | number): string {
  if (typeof v === 'number') return String(v);
  return v;
}

/**
 * Format query result rows for feeding back to the agent. This is
 * the only data the LLM sees from the search — it needs to be
 * compact, readable, and preserve the important structure.
 */
function formatRowsForAgent(
  rows: Record<string, unknown>[],
  cap: number,
): string {
  if (rows.length === 0) return 'Search returned no results.';
  const shown = rows.slice(0, cap);

  // Discover the union of keys to pick a consistent column order —
  // stable across rows, sorted by frequency then name.
  const keyCounts = new Map<string, number>();
  for (const r of shown) {
    for (const k of Object.keys(r)) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  }
  const keys = Array.from(keyCounts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([k]) => k);

  const header = `Result: ${rows.length} row${rows.length === 1 ? '' : 's'}${
    rows.length > cap ? ` (showing first ${cap})` : ''
  }`;

  // JSON-per-row keeps numbers as numbers and nested objects intact.
  // The LLM parses JSON far better than an ASCII table.
  const lines = shown.map((r) => {
    const ordered: Record<string, unknown> = {};
    for (const k of keys) {
      if (k in r) ordered[k] = r[k];
    }
    return JSON.stringify(ordered);
  });

  return [header, ...lines].join('\n');
}

/**
 * Acknowledge update_context calls — the native UI stores these in
 * a session-scoped key/value bag. We don't need the state to drive
 * anything in our embedded UI, but we must reply with a tool result
 * so the agent loop advances.
 */
function updateContextTool(args: UpdateContextArgs): string {
  const keyStr = args.key ?? '(missing)';
  const valStr =
    typeof args.value === 'string'
      ? args.value
      : JSON.stringify(args.value ?? null);
  return `The context was updated with the key: ${keyStr} and value: ${valStr}`;
}

/**
 * Format the final investigation summary for display. The agent
 * calls this with a structured findings array + conclusion; we
 * stitch them into markdown that the chat UI renders as a final
 * summary card.
 */
function formatInvestigationSummary(args: PresentInvestigationSummaryArgs): string {
  const parts: string[] = [];
  if (args.findings && Array.isArray(args.findings) && args.findings.length > 0) {
    parts.push('## Findings');
    for (const f of args.findings) {
      const category = f.category ?? 'Finding';
      parts.push(`### ${category}`);
      const details = f.details;
      if (Array.isArray(details)) {
        for (const d of details) parts.push(`- ${d}`);
      } else if (typeof details === 'string') {
        parts.push(details);
      }
    }
  }
  if (args.conclusion) {
    parts.push('## Conclusion');
    parts.push(args.conclusion);
  }
  return parts.join('\n\n');
}

/**
 * Main dispatcher. Matches tool call name → handler and returns a
 * ToolExecutionResult. Unknown tool names get a generic
 * acknowledgement so the loop keeps moving.
 */
export async function executeToolCall(
  call: ToolCallInvocation,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  switch (call.name) {
    case 'run_search': {
      const args = parseArgs<RunSearchArgs>(call.arguments);
      const { content, ui } = await runSearchTool(args, signal);
      return { id: call.id, name: call.name, content, ui };
    }

    case 'update_context': {
      const args = parseArgs<UpdateContextArgs>(call.arguments);
      return {
        id: call.id,
        name: call.name,
        content: updateContextTool(args),
      };
    }

    case 'get_dataset_context': {
      // We told the agent not to call this, but if it does anyway,
      // reply with a pointer back to the context in the first
      // message so it doesn't waste a round trip on the 5MB
      // fieldStats fetch.
      return {
        id: call.id,
        name: call.name,
        content:
          'Dataset context is already provided in the initial user message above. See the "Field access rules" and "Span field mappings" sections. Do not call this tool again — use the documented field expressions directly.',
      };
    }

    case 'sample_events': {
      // Same principle — we've already handed over the shape.
      return {
        id: call.id,
        name: call.name,
        content:
          'Sample events are not needed: the dataset shape is documented in the initial user message. Use the field mappings provided there instead of sampling.',
      };
    }

    case 'fetch_local_context': {
      // Server-side tool; we should never see this as a client-
      // dispatched call because the backend handles it. If we do,
      // acknowledge so the loop doesn't stall.
      return {
        id: call.id,
        name: call.name,
        content: 'Local context retrieval is handled server-side.',
      };
    }

    case 'get_lookup_content_sample': {
      return {
        id: call.id,
        name: call.name,
        content:
          'Lookup content sampling is not enabled in this embedded investigation. Query the lookup directly with `| lookup <id> on <key>` if you need the data.',
      };
    }

    case 'present_investigation_summary': {
      const args = parseArgs<PresentInvestigationSummaryArgs>(call.arguments);
      const markdown = formatInvestigationSummary(args);
      return {
        id: call.id,
        name: call.name,
        content: markdown || 'Investigation summary presented.',
      };
    }

    case 'edit_notebook': {
      // Notebook creation is a future enhancement — acknowledge so
      // the agent can wrap up cleanly.
      const args = parseArgs<EditNotebookArgs>(call.arguments);
      const title = args.title ?? 'Untitled investigation';
      return {
        id: call.id,
        name: call.name,
        content: `Notebook "${title}" saved. (Note: embedded investigations don't yet write notebooks to Cribl Search; the chat transcript is the record.)`,
      };
    }

    case 'clickable_suggestion_button':
    case 'show_exit':
    case 'display_incident_overview':
    case 'select_alert':
    case 'selectFirehydrantIncident':
    case 'get_jira_context':
    case 'get_bitbucket_context':
      // UI-only or integration-only tools we don't support in the
      // embedded experience. Acknowledge and move on.
      return {
        id: call.id,
        name: call.name,
        content: `Tool ${call.name} is not available in the embedded Cribl APM investigation.`,
      };

    default:
      return {
        id: call.id,
        name: call.name,
        content: `Unknown tool: ${call.name}. Please use a different approach.`,
      };
  }
}

/**
 * Is this tool call subject to "Run Query" approval in the UI?
 * Only run_search with confirmBeforeRunning:true pauses the loop —
 * everything else executes immediately.
 */
export function requiresApproval(call: ToolCallInvocation): boolean {
  if (call.name !== 'run_search') return false;
  const args = parseArgs<RunSearchArgs>(call.arguments);
  return args.confirmBeforeRunning === true;
}
