/**
 * Conversation orchestrator for the Copilot Investigator agent loop.
 *
 * The agent protocol is a classic OpenAI tool-use loop:
 *
 *   1. Client sends {messages, stream:true} to /api/v1/ai/q/agents/local_search
 *   2. Server streams an assistant response (text tokens, then a
 *      tool_calls frame) as NDJSON
 *   3. Client executes each tool call locally, appends the tool
 *      results to the message history, and POSTs again
 *   4. Repeat until the assistant replies with text and no tool calls
 *
 * This module wraps that loop in an event-emitter style interface
 * the React chat UI consumes. It owns no rendering state — it just
 * emits typed events as the conversation progresses, so the UI can
 * re-render from its own reducer.
 */
import {
  streamAgent,
  logAgentEvent,
  type AgentMessage,
  type AgentRequest,
  type AgentToolCall,
} from './agent';
import {
  executeToolCall,
  requiresApproval,
  type ToolCallInvocation,
  type ToolExecutionResult,
} from './agentTools';
import { buildAgentContext } from './agentContext';
import { APM_TOOL_DEFINITIONS } from './agentToolDefs';
import { getCurrentDataset } from './dataset';

/**
 * Events emitted by the loop. The UI subscribes to these and
 * transforms them into its message timeline.
 */
export type LoopEvent =
  | {
      kind: 'assistantText';
      turnId: string;
      chunk: string;
    }
  | {
      kind: 'assistantDone';
      turnId: string;
    }
  | {
      kind: 'toolCall';
      turnId: string;
      call: AgentToolCall;
      needsApproval: boolean;
    }
  | {
      kind: 'toolResult';
      turnId: string;
      result: ToolExecutionResult;
    }
  | {
      kind: 'notification';
      turnId: string;
      toolName?: string;
      content: unknown;
    }
  | {
      kind: 'error';
      error: Error;
    }
  | {
      kind: 'done';
      reason: 'complete' | 'aborted';
    };

export interface RunLoopOptions {
  sessionId: string;
  /** Messages to seed the conversation with — typically one user
   *  message whose content is built via buildSeedPrompt(). */
  initialMessages: AgentMessage[];
  /** Called for each loop event. The UI reducer consumes these. */
  onEvent: (ev: LoopEvent) => void;
  /** Approval gate for tool calls that need it (run_search with
   *  confirmBeforeRunning:true). Return true to run the query, false
   *  to skip it. If omitted, auto-approves everything — fine for
   *  the first cut, later we'll wire a UI prompt. */
  approveToolCall?: (call: ToolCallInvocation) => Promise<boolean>;
  /** Abort the whole investigation. */
  signal?: AbortSignal;
  /** Max number of agent round-trips before giving up — safety net
   *  against runaway loops. Default 30. */
  maxTurns?: number;
}

let turnCounter = 0;

function newTurnId(): string {
  turnCounter += 1;
  return `turn-${Date.now()}-${turnCounter}`;
}

function newMessageId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Run a complete investigation loop: send the seed messages,
 * consume the stream, execute tools, repeat until the assistant
 * stops calling tools. Returns when the loop terminates (either
 * because the agent produced a final text-only response, hit the
 * turn cap, or the caller aborted).
 */
export async function runInvestigation(opts: RunLoopOptions): Promise<void> {
  const {
    sessionId,
    initialMessages,
    onEvent,
    approveToolCall,
    signal,
    maxTurns = 30,
  } = opts;

  const messages: AgentMessage[] = [...initialMessages];
  const datasetId = getCurrentDataset();
  const context = buildAgentContext(datasetId);

  // Log the initial submission as an analytics event, matching the
  // native UI's behavior. Best-effort — errors are swallowed.
  const userMsg = initialMessages.find((m) => m.role === 'user');
  if (userMsg) {
    logAgentEvent('UserQuery', 'submit', {
      conversationId: sessionId,
      userQuery: userMsg.content ?? '',
    });
  }

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) {
        onEvent({ kind: 'done', reason: 'aborted' });
        return;
      }

      const turnId = newTurnId();
      const req: AgentRequest = {
        messages,
        stream: true,
        sessionId,
        context,
        tools: APM_TOOL_DEFINITIONS,
      };

      // Accumulate the assistant response across streamed frames.
      let textContent = '';
      let pendingToolCalls: AgentToolCall[] | null = null;

      for await (const frame of streamAgent(req, signal)) {
        if (signal?.aborted) {
          onEvent({ kind: 'done', reason: 'aborted' });
          return;
        }

        switch (frame.kind) {
          case 'text':
            textContent += frame.content;
            onEvent({ kind: 'assistantText', turnId, chunk: frame.content });
            break;

          case 'toolCalls':
            // Tool call frames arrive as a batch after all text
            // for this turn is streamed. Record them and stop
            // consuming the stream — the server closes it right
            // after emitting tool calls anyway, but being explicit
            // keeps the flow obvious.
            pendingToolCalls = frame.calls;
            break;

          case 'toolResult':
            // Server-side tool (e.g. fetch_local_context). Not
            // something we executed — just surface to the UI in
            // case we want to show a debug pane.
            onEvent({
              kind: 'notification',
              turnId,
              toolName: 'fetch_local_context',
              content: frame.content,
            });
            break;

          case 'notification':
            onEvent({
              kind: 'notification',
              turnId,
              toolName: frame.toolName,
              content: frame.content,
            });
            break;

          case 'unknown':
            // Keep unknown frames for debugging but don't stall.
            break;
        }
      }

      // Emit the final assistant text as one atomic message in the
      // transcript (in addition to the streamed chunks).
      onEvent({ kind: 'assistantDone', turnId });

      // Append the assistant message to history for the next round.
      const assistantMsg: AgentMessage = {
        id: newMessageId(),
        role: 'assistant',
        content: textContent,
      };
      if (pendingToolCalls && pendingToolCalls.length > 0) {
        assistantMsg.tool_calls = pendingToolCalls;
      }
      messages.push(assistantMsg);

      // If there are no tool calls, the investigation is over.
      if (!pendingToolCalls || pendingToolCalls.length === 0) {
        onEvent({ kind: 'done', reason: 'complete' });
        return;
      }

      // Execute each tool call and append its result to history.
      for (const call of pendingToolCalls) {
        if (signal?.aborted) {
          onEvent({ kind: 'done', reason: 'aborted' });
          return;
        }

        const invocation: ToolCallInvocation = {
          id: call.id,
          name: call.function.name,
          arguments: call.function.arguments,
        };
        const needsApproval = requiresApproval(invocation);

        onEvent({ kind: 'toolCall', turnId, call, needsApproval });

        // Gate search execution on user approval if requested.
        if (needsApproval && approveToolCall) {
          const approved = await approveToolCall(invocation);
          if (!approved) {
            const skipResult: ToolExecutionResult = {
              id: call.id,
              name: call.function.name,
              content: 'User chose to skip this query. Try a different approach or ask for guidance.',
            };
            onEvent({ kind: 'toolResult', turnId, result: skipResult });
            messages.push({
              id: newMessageId(),
              role: 'tool',
              tool_call_id: call.id,
              content: skipResult.content,
            });
            continue;
          }
        }

        let result: ToolExecutionResult;
        try {
          result = await executeToolCall(invocation, signal);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result = {
            id: call.id,
            name: call.function.name,
            content: `Tool execution failed: ${msg}`,
          };
        }

        onEvent({ kind: 'toolResult', turnId, result });
        messages.push({
          id: newMessageId(),
          role: 'tool',
          tool_call_id: call.id,
          content: result.content,
        });
      }
    }

    // Hit the turn cap without converging — surface as an error so
    // the UI can show a retry affordance.
    onEvent({
      kind: 'error',
      error: new Error(`Investigation exceeded ${maxTurns} turns without completing`),
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    // AbortError is expected when the user navigates away — don't
    // surface it as an error.
    if (error.name === 'AbortError') {
      onEvent({ kind: 'done', reason: 'aborted' });
      return;
    }
    onEvent({ kind: 'error', error });
  }
}
