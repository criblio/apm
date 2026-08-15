/**
 * One real agent turn — the unit an InvestigationDO alarm runs.
 *
 * Rebuilds the pi conversation from the DO's `agent_messages` table,
 * streams one assistant message from the OpenAI-compatible endpoint
 * via pi-ai, executes any tool calls through the app's shared
 * executors, and reports everything as wire LoopEvents. The caller
 * (the DO) owns persistence, scheduling the next alarm, and the
 * conclusion commit — this module never touches storage directly.
 *
 * Turn boundaries are the design's durability boundary: each turn
 * fits comfortably inside celld's 300s handler budget, and a node
 * death between turns resumes from the persisted messages.
 */
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Tool,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import { APM_TOOL_DEFINITIONS } from '../../../src/api/agentToolDefs';
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import type { ApmToolExecutors } from '../../../src/api/agentTools';
import type { WireLoopEvent } from '../protocol';
import { mapPiEvent, toolCallsOf } from './loopEventMap';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Hard cap on a single coalesced assistant-text event (chars). */
const MAX_TEXT_CHARS = 16 * 1024;

/**
 * Bound a stored assistant message so a runaway response can't grow
 * the per-turn pi history (which `history()` reloads in full every
 * turn) without limit. Truncates oversized text/thinking content; a
 * repetitive 75 KB answer carries no extra signal past the cap.
 */
function capMessage(msg: AssistantMessage): AssistantMessage {
  let changed = false;
  const content = msg.content.map((c) => {
    if (c.type === 'text' && c.text.length > MAX_TEXT_CHARS) {
      changed = true;
      return { ...c, text: c.text.slice(0, MAX_TEXT_CHARS) };
    }
    if (c.type === 'thinking' && c.thinking.length > MAX_TEXT_CHARS) {
      changed = true;
      return { ...c, thinking: c.thinking.slice(0, MAX_TEXT_CHARS) };
    }
    return c;
  });
  return changed ? { ...msg, content } : msg;
}

function capText(text: string): string {
  return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
}

export interface RealTurnResult {
  /** New pi messages to append to agent_messages (assistant + tool results). */
  newMessages: Message[];
  /** The conclusion ui payload if present_investigation_summary ran this turn. */
  conclusion: unknown | null;
  /** True when the loop should stop (summary presented, or a plain
   *  assistant reply with no tool calls). */
  done: boolean;
  /** Set when the LLM stream itself failed; the DO fails the run. */
  errorMessage: string | null;
}

function piModel(cfg: LlmConfig): Model<'openai-completions'> {
  return {
    id: cfg.model,
    name: cfg.model,
    api: 'openai-completions',
    provider: 'openai-compatible',
    baseUrl: cfg.baseUrl,
    reasoning: false,
    input: ['text'],
    // Cost accounting is not meaningful against arbitrary
    // OpenAI-compatible endpoints; zeros keep pi's usage math inert.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 16_384,
  };
}

function piTools(extra: AgentToolDefinition[]): Tool[] {
  // AgentToolDefinition {id, description, schema} → pi Tool. The
  // schemas are plain JSON Schema objects, which is what typebox's
  // TSchema is structurally; the cast is the seam between the two
  // type systems, not a data conversion. `extra` carries the
  // server-only code tools when a repo is configured.
  return [...APM_TOOL_DEFINITIONS, ...extra].map((def) => ({
    name: def.id,
    description: def.description,
    parameters: (def.schema ?? { type: 'object', properties: {} }) as Tool['parameters'],
  }));
}

/**
 * Run one turn. `emit` fires for every wire event as it happens so
 * the DO can append+fanout live (streaming text reaches a polling
 * client mid-turn).
 */
export async function runRealTurn(opts: {
  llm: LlmConfig;
  /** Full pi conversation so far. history[0] is the seed prompt as a
   *  user message — the exact parity point with the browser loop,
   *  which sends buildSeedPrompt() output as messages[0]. */
  history: Message[];
  turnIndex: number;
  executors: ApmToolExecutors;
  /** Server-only tool definitions to offer alongside the APM tools
   *  (the code tools when a repo is configured). */
  extraTools?: AgentToolDefinition[];
  emit: (ev: WireLoopEvent) => void;
  signal?: AbortSignal;
}): Promise<RealTurnResult> {
  const { llm, history, turnIndex, executors, extraTools, emit, signal } = opts;
  const turnId = `turn-${turnIndex}`;

  const context: Context = {
    messages: history,
    tools: piTools(extraTools ?? []),
  };

  let final: AssistantMessage | null = null;
  let streamFailed: string | null = null;

  // Coalesce streaming text into ONE persisted event per text block
  // instead of one per token. Each transcript event is a SQLite row +
  // a fanout, and a runaway model response (deepseek-v4-flash was
  // observed emitting 75 KB of repeated text) becomes thousands of
  // rows, which eventually trips celld's "result set too large" cap on
  // any subsequent read and wedges the DO. The poll transport reads
  // persisted events every ~2.5s, so per-token granularity buys the UI
  // nothing here anyway. Text is also hard-capped so one pathological
  // response can't bloat the store.
  let textBuf = '';
  const flushText = () => {
    if (!textBuf) return;
    emit({ kind: 'assistantText', turnId, chunk: capText(textBuf) });
    textBuf = '';
  };

  const events = stream(piModel(llm), context, { apiKey: llm.apiKey, signal });
  for await (const ev of events) {
    // Accumulate ALL of a turn's text (across text blocks) and flush
    // it as a SINGLE event at the end — one transcript row per turn,
    // not one per token or per block. A repetitive model can emit many
    // text blocks; without this the row count still explodes.
    if (ev.type === 'text_delta') {
      if (textBuf.length < MAX_TEXT_CHARS) textBuf += ev.delta ?? '';
      continue;
    }
    if (ev.type === 'text_start' || ev.type === 'text_end') continue;
    for (const wire of mapPiEvent(ev, turnId)) emit(wire);
    if (ev.type === 'done') final = ev.message;
    if (ev.type === 'error') {
      final = ev.error;
      streamFailed =
        ev.error.errorMessage ??
        (ev.reason === 'aborted' ? 'LLM stream aborted' : 'LLM stream error');
    }
  }
  flushText();

  if (!final || streamFailed) {
    return {
      newMessages: final ? [final] : [],
      conclusion: null,
      done: false,
      errorMessage: streamFailed ?? 'LLM stream ended without a message',
    };
  }

  emit({ kind: 'assistantDone', turnId });
  const newMessages: Message[] = [capMessage(final)];

  const calls = toolCallsOf(final.content);
  let conclusion: unknown | null = null;

  for (const call of calls) {
    const result = await executors.executeToolCall(
      {
        id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.arguments ?? {}),
      },
      signal,
    );
    emit({
      kind: 'toolResult',
      turnId,
      result: {
        id: result.id,
        name: result.name,
        content: result.content,
        ui: result.ui,
      },
    });
    if (call.name === 'present_investigation_summary') {
      conclusion = result.ui ?? null;
    }
    const toolResult: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: 'text', text: result.content }],
      // App executors report failures as explanatory content the
      // model can react to, never as thrown errors.
      isError: false,
      timestamp: Date.now(),
    };
    newMessages.push(toolResult);
  }

  // Terminal conditions mirror the client loop: the summary tool
  // concludes; an assistant message with no tool calls is the
  // model's final answer.
  const done = conclusion != null || calls.length === 0;
  return { newMessages, conclusion, done, errorMessage: null };
}
