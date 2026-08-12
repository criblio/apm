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
import type { ApmToolExecutors } from '../../../src/api/agentTools';
import type { WireLoopEvent } from '../protocol';
import { mapPiEvent, toolCallsOf } from './loopEventMap';

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
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

function piTools(): Tool[] {
  // AgentToolDefinition {id, description, schema} → pi Tool. The
  // schemas are plain JSON Schema objects, which is what typebox's
  // TSchema is structurally; the cast is the seam between the two
  // type systems, not a data conversion.
  return APM_TOOL_DEFINITIONS.map((def) => ({
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
  emit: (ev: WireLoopEvent) => void;
  signal?: AbortSignal;
}): Promise<RealTurnResult> {
  const { llm, history, turnIndex, executors, emit, signal } = opts;
  const turnId = `turn-${turnIndex}`;

  const context: Context = {
    messages: history,
    tools: piTools(),
  };

  let final: AssistantMessage | null = null;
  let streamFailed: string | null = null;

  const events = stream(piModel(llm), context, { apiKey: llm.apiKey, signal });
  for await (const ev of events) {
    for (const wire of mapPiEvent(ev, turnId)) emit(wire);
    if (ev.type === 'done') final = ev.message;
    if (ev.type === 'error') {
      final = ev.error;
      streamFailed =
        ev.error.errorMessage ??
        (ev.reason === 'aborted' ? 'LLM stream aborted' : 'LLM stream error');
    }
  }

  if (!final || streamFailed) {
    return {
      newMessages: final ? [final] : [],
      conclusion: null,
      done: false,
      errorMessage: streamFailed ?? 'LLM stream ended without a message',
    };
  }

  emit({ kind: 'assistantDone', turnId });
  const newMessages: Message[] = [final];

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
