/**
 * One real agent turn — the unit an InvestigationDO alarm runs.
 *
 * Built on @earendil-works/pi-agent-core's Agent: a fresh Agent is
 * rebuilt from the DO's persisted messages each turn, run with
 * `shouldStopAfterTurn: () => true` so one invocation is exactly one
 * LLM call plus its tool executions, then thrown away. The caller
 * (the DO) owns persistence, scheduling the next alarm, and the
 * conclusion commit — this module never touches storage directly.
 * pi-agent-core supports this alarm-per-turn shape natively (spike:
 * docs/research/cell-harness-extraction/spike-pi-agent-core.mjs) and
 * replaces the hand-rolled stream loop this module used to carry; its
 * steering/follow-up queues and compaction become available to later
 * phases without rearchitecting.
 *
 * Turn boundaries are the design's durability boundary: each turn
 * fits comfortably inside celld's 300s handler budget, and a node
 * death between turns resumes from the persisted messages.
 */
import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import type {
  Api,
  AssistantMessage,
  Message,
  Model,
} from '@earendil-works/pi-ai';
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import type { ToolExecutors } from '../payload';
import type { WireLoopEvent } from '../protocol';
import { mapPiEvent, toolCallsOf } from './loopEventMap';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Hard cap on a single coalesced assistant-text event (chars). */
const MAX_TEXT_CHARS = 16 * 1024;

/** Whole-turn budget (LLM stream + tool calls). A hung model or stalled
 *  tool aborts here so the investigation can't wedge at "thinking"
 *  forever — well under celld's ~300s handler budget. */
const TURN_TIMEOUT_MS = 180_000;

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
  /** The conclusion ui payload if the concluding tool ran this turn. */
  conclusion: unknown | null;
  /** True when the loop should stop (conclusion presented, or a plain
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

/** The production stream function: pi-ai's OpenAI-completions API.
 *  The loop passes {apiKey, signal} through in options. */
const openAiCompletionsStream: StreamFn = (model, context, options) =>
  stream(model as Model<'openai-completions'>, context, options);

/**
 * Run one turn. `emit` fires for every wire event as it happens so
 * the DO can append+fanout live (streaming text reaches a polling
 * client mid-turn).
 */
export async function runRealTurn(opts: {
  llm: LlmConfig;
  /** Full pi conversation so far. history[0] is the seed prompt as a
   *  user message — the exact parity point with the browser loop,
   *  which sends buildSeedPrompt() output as messages[0]. Always ends
   *  on a user or toolResult message at a turn boundary, which is
   *  exactly what Agent.continue() requires. */
  history: Message[];
  turnIndex: number;
  executors: ToolExecutors;
  /** Every tool offered this turn: the payload's domain tools plus
   *  any harness tools (the code tools when a repo is configured). */
  tools: AgentToolDefinition[];
  /** The tool whose call concludes the session (its result `ui` is
   *  the conclusion). Absent ⇒ only a call-free reply concludes. */
  concludingTool?: string;
  emit: (ev: WireLoopEvent) => void;
  signal?: AbortSignal;
  /** Test seam: replaces the OpenAI-completions stream. */
  streamFn?: StreamFn;
}): Promise<RealTurnResult> {
  const { llm, history, turnIndex, executors, tools, concludingTool, emit, signal } = opts;
  const turnId = `turn-${turnIndex}`;

  // Executor results by tool call id: the loop's tool_execution_end
  // event carries pi's view of the result; the wire event needs the
  // executor's `ui` payload too, so the execute() wrapper stashes the
  // full result here for the event handler.
  const executed = new Map<string, { name: string; content: string; ui?: unknown }>();

  const agentTools: AgentTool[] = tools.map((def) => ({
    name: def.id,
    label: def.id,
    description: def.description,
    // Plain JSON Schema is what typebox's TSchema is structurally;
    // the cast is the seam between the two type systems, not a data
    // conversion.
    parameters: (def.schema ?? { type: 'object', properties: {} }) as AgentTool['parameters'],
    execute: async (toolCallId, params, execSignal) => {
      // App executors report failures as explanatory content the model
      // can react to — they never throw, so neither does this wrapper.
      const result = await executors.executeToolCall(
        {
          id: toolCallId,
          name: def.id,
          arguments: JSON.stringify(params ?? {}),
        },
        execSignal,
      );
      executed.set(toolCallId, { name: result.name, content: result.content, ui: result.ui });
      return { content: [{ type: 'text', text: result.content }], details: undefined };
    },
  }));

  // Coalesce streaming text into ONE persisted event per turn instead
  // of one per token. Each transcript event is a SQLite row + a
  // fanout, and a runaway model response (deepseek-v4-flash was
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

  let final: AssistantMessage | null = null;
  let conclusion: unknown | null = null;
  let thrown: string | null = null;

  const agent = new Agent({
    initialState: {
      // The seed prompt is history[0] (parity with the browser loop),
      // not a system prompt.
      systemPrompt: '',
      model: piModel(llm) as Model<Api>,
      tools: agentTools,
      messages: history,
    },
    streamFn: opts.streamFn ?? openAiCompletionsStream,
    getApiKey: () => llm.apiKey,
    // One LLM call + its tool executions per alarm — the DO owns the
    // loop across turns.
    shouldStopAfterTurn: () => true,
    // Execute tool calls in assistant source order, one at a time —
    // the executors share the DO's single thread and the transcript
    // expects source-ordered toolResult events.
    toolExecution: 'sequential',
  });

  agent.subscribe((ev) => {
    switch (ev.type) {
      case 'message_update': {
        const ame = ev.assistantMessageEvent;
        // Text deltas accumulate into the single per-turn event; every
        // other stream event maps through the shared table (thinking
        // notifications, completed tool calls, stream errors).
        if (ame.type === 'text_delta') {
          if (textBuf.length < MAX_TEXT_CHARS) textBuf += ame.delta ?? '';
          return;
        }
        if (ame.type === 'text_start' || ame.type === 'text_end') return;
        for (const wire of mapPiEvent(ame, turnId)) emit(wire);
        return;
      }
      case 'message_end': {
        if (ev.message.role !== 'assistant') return;
        const msg = ev.message as AssistantMessage;
        final = msg;
        if (msg.stopReason === 'error' || msg.stopReason === 'aborted') {
          // Failed turn: keep whatever text streamed, no assistantDone
          // (the DO appends the error event from errorMessage).
          flushText();
          return;
        }
        const calls = toolCallsOf(msg.content);
        const concluding =
          concludingTool != null && calls.some((c) => c.name === concludingTool);
        // The concluding tool's card IS the final report. Drop any
        // wrap-up text the model emits alongside it — the seed prompt
        // says STOP after the summary, but deepseek routinely adds a
        // redundant sentence beside the card. Suppressing it here keeps
        // the transcript clean regardless.
        if (concluding) textBuf = '';
        else flushText();
        emit({ kind: 'assistantDone', turnId });
        return;
      }
      case 'tool_execution_end': {
        const stashed = executed.get(ev.toolCallId);
        emit({
          kind: 'toolResult',
          turnId,
          result: stashed
            ? { id: ev.toolCallId, ...stashed }
            : {
                // A call the wrapper never saw (e.g. argument
                // validation failed before execute) — surface pi's
                // own result text so the transcript shows why.
                id: ev.toolCallId,
                name: ev.toolName,
                content: typeof ev.result === 'string' ? ev.result : JSON.stringify(ev.result ?? null),
              },
        });
        if (concludingTool != null && ev.toolName === concludingTool) {
          conclusion = stashed?.ui ?? null;
        }
        return;
      }
      default:
        return;
    }
  });

  // Bound the whole turn: a timeout (combined with any caller signal)
  // aborts the LLM stream AND the tool calls, so a hung model or a
  // stalled tool fails the turn instead of wedging it at "thinking".
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    agent.abort();
  }, TURN_TIMEOUT_MS);
  if (signal) {
    if (signal.aborted) agent.abort();
    else signal.addEventListener('abort', () => agent.abort(), { once: true });
  }

  try {
    // history always ends on user/toolResult at a turn boundary (seed,
    // follow-up message, or the previous turn's tool results), which is
    // Agent.continue()'s precondition — no new message this turn.
    await agent.continue();
  } catch (err) {
    thrown = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
  }

  const newMessages: Message[] = (agent.state.messages as Message[])
    .slice(history.length)
    .map((m) => (m.role === 'assistant' ? capMessage(m as AssistantMessage) : m));

  // TS can't see the closure assignment in subscribe(); rebind wide.
  const finalMsg = final as AssistantMessage | null;
  let errorMessage = agent.state.errorMessage ?? thrown ?? null;
  if (timedOut) {
    errorMessage = `LLM turn timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s`;
  }
  if (!finalMsg && !errorMessage) {
    errorMessage = 'LLM stream ended without a message';
  }
  if (!finalMsg || errorMessage) {
    return { newMessages, conclusion: null, done: false, errorMessage };
  }

  // Terminal conditions mirror the client loop: the concluding tool
  // concludes; an assistant message with no tool calls is the model's
  // final answer.
  const calls = toolCallsOf(finalMsg.content);
  const done = conclusion != null || calls.length === 0;
  return { newMessages, conclusion, done, errorMessage: null };
}
