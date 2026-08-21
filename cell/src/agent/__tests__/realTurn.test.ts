/**
 * Unit tests for the pi-agent-core turn runner, driven through the
 * `streamFn` test seam with scripted streams — no network, no LLM.
 * Each scripted stream mimics pi-ai's AssistantMessageEventStream
 * surface the loop actually consumes: an async iterator of events
 * (each carrying the running `partial` message) plus `result()` for
 * the final message.
 */
import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import type { WireLoopEvent } from '../../protocol';
import { runRealTurn } from '../realTurn';

const LLM = { baseUrl: 'http://unused', apiKey: 'k', model: 'test' };

const TOOLS: AgentToolDefinition[] = [
  {
    id: 'run_search',
    description: 'Run a search',
    schema: { type: 'object', properties: { query: { type: 'string' } } },
  },
  {
    id: 'present_investigation_summary',
    description: 'Conclude',
    schema: { type: 'object', properties: { conclusion: { type: 'string' } } },
  },
];

function assistantMessage(
  content: AssistantMessage['content'],
  stopReason: AssistantMessage['stopReason'] = 'stop',
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: 'assistant',
    content,
    stopReason,
    usage: { input: 1, output: 1 },
    provider: 'test',
    model: 'test',
    api: 'openai-completions',
    timestamp: 1,
    ...extra,
  } as AssistantMessage;
}

/** Scripted stream: `events` are yielded in order (each already
 *  carrying `partial`); `result()` resolves the final message. */
function scriptedStreamFn(
  events: Array<Record<string, unknown>>,
  finalMessage: AssistantMessage,
): StreamFn {
  return (() => ({
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    result: async () => finalMessage,
    abort: () => {},
  })) as unknown as StreamFn;
}

const passthroughExecutors = (ui?: { kind: string } & Record<string, unknown>) => {
  const calls: Array<{ name: string; arguments: string }> = [];
  return {
    calls,
    executeToolCall: async (call: { id: string; name: string; arguments: string }) => {
      calls.push({ name: call.name, arguments: call.arguments });
      return { id: call.id, name: call.name, content: `result of ${call.name}`, ui };
    },
  };
};

const history = () => [{ role: 'user' as const, content: 'seed prompt', timestamp: 0 }];

describe('runRealTurn (pi-agent-core)', () => {
  it('coalesces streamed text into one event and concludes a call-free reply', async () => {
    const msg = assistantMessage([{ type: 'text', text: 'Hello world.' }]);
    const partial = assistantMessage([], 'stop');
    const streamFn = scriptedStreamFn(
      [
        { type: 'start', partial },
        { type: 'text_delta', delta: 'Hello ', partial },
        { type: 'text_delta', delta: 'world.', partial },
        { type: 'done', reason: 'stop', partial },
      ],
      msg,
    );
    const events: WireLoopEvent[] = [];
    const result = await runRealTurn({
      llm: LLM,
      history: history(),
      turnIndex: 0,
      executors: passthroughExecutors(),
      tools: TOOLS,
      concludingTool: 'present_investigation_summary',
      emit: (ev) => events.push(ev),
      streamFn,
    });

    expect(events.map((e) => e.kind)).toEqual(['assistantText', 'assistantDone']);
    expect(events[0]).toMatchObject({ chunk: 'Hello world.', turnId: 'turn-0' });
    expect(result.done).toBe(true);
    expect(result.conclusion).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.newMessages.map((m) => m.role)).toEqual(['assistant']);
  });

  it('executes tool calls, emits toolCall/toolResult with ui, and continues', async () => {
    const call = {
      type: 'toolCall' as const,
      id: 'tc1',
      name: 'run_search',
      arguments: { query: 'errors' },
    };
    const msg = assistantMessage([call], 'toolUse');
    const partial = assistantMessage([], 'toolUse');
    const streamFn = scriptedStreamFn(
      [
        { type: 'start', partial },
        { type: 'toolcall_end', toolCall: call, partial },
        { type: 'done', reason: 'toolUse', partial },
      ],
      msg,
    );
    const executors = passthroughExecutors({ kind: 'search', query: 'errors' });
    const events: WireLoopEvent[] = [];
    const result = await runRealTurn({
      llm: LLM,
      history: history(),
      turnIndex: 2,
      executors,
      tools: TOOLS,
      concludingTool: 'present_investigation_summary',
      emit: (ev) => events.push(ev),
      streamFn,
    });

    expect(events.map((e) => e.kind)).toEqual(['toolCall', 'assistantDone', 'toolResult']);
    const toolCall = events[0] as Extract<WireLoopEvent, { kind: 'toolCall' }>;
    expect(toolCall.call.function).toEqual({
      name: 'run_search',
      arguments: JSON.stringify({ query: 'errors' }),
    });
    const toolResult = events[2] as Extract<WireLoopEvent, { kind: 'toolResult' }>;
    expect(toolResult.result).toMatchObject({
      id: 'tc1',
      name: 'run_search',
      content: 'result of run_search',
      ui: { kind: 'search', query: 'errors' },
    });
    expect(executors.calls).toEqual([
      { name: 'run_search', arguments: JSON.stringify({ query: 'errors' }) },
    ]);
    expect(result.done).toBe(false);
    expect(result.conclusion).toBeNull();
    // The turn persists the assistant message AND the tool result, so
    // the next alarm's history ends on toolResult (continue()-ready).
    expect(result.newMessages.map((m) => m.role)).toEqual(['assistant', 'toolResult']);
  });

  it('suppresses wrap-up text beside the concluding tool and returns its ui as the conclusion', async () => {
    const call = {
      type: 'toolCall' as const,
      id: 'tc9',
      name: 'present_investigation_summary',
      arguments: { conclusion: 'root cause found' },
    };
    const msg = assistantMessage(
      [{ type: 'text', text: 'Wrapping up…' }, call],
      'toolUse',
    );
    const partial = assistantMessage([], 'toolUse');
    const streamFn = scriptedStreamFn(
      [
        { type: 'start', partial },
        { type: 'text_delta', delta: 'Wrapping up…', partial },
        { type: 'toolcall_end', toolCall: call, partial },
        { type: 'done', reason: 'toolUse', partial },
      ],
      msg,
    );
    const summaryUi = { kind: 'summary', conclusion: 'root cause found' };
    const events: WireLoopEvent[] = [];
    const result = await runRealTurn({
      llm: LLM,
      history: history(),
      turnIndex: 5,
      executors: passthroughExecutors(summaryUi),
      tools: TOOLS,
      concludingTool: 'present_investigation_summary',
      emit: (ev) => events.push(ev),
      streamFn,
    });

    // No assistantText: the summary card IS the final report.
    expect(events.map((e) => e.kind)).toEqual(['toolCall', 'assistantDone', 'toolResult']);
    expect(result.conclusion).toEqual(summaryUi);
    expect(result.done).toBe(true);
    expect(result.errorMessage).toBeNull();
  });

  it('reports a failed stream as errorMessage without concluding', async () => {
    const errMsg = assistantMessage([], 'error', { errorMessage: 'upstream exploded' });
    const partial = assistantMessage([], 'error');
    const streamFn = scriptedStreamFn(
      [
        { type: 'start', partial },
        { type: 'error', reason: 'error', error: errMsg, partial },
      ],
      errMsg,
    );
    const events: WireLoopEvent[] = [];
    const result = await runRealTurn({
      llm: LLM,
      history: history(),
      turnIndex: 1,
      executors: passthroughExecutors(),
      tools: TOOLS,
      concludingTool: 'present_investigation_summary',
      emit: (ev) => events.push(ev),
      streamFn,
    });

    // No assistantDone on a failed turn; the DO appends the error
    // event from errorMessage.
    expect(events.map((e) => e.kind)).toEqual([]);
    expect(result.errorMessage).toBe('upstream exploded');
    expect(result.done).toBe(false);
    expect(result.conclusion).toBeNull();
    // The errored assistant message is still persisted (parity with
    // the previous runner) so a parked interactive run keeps context.
    expect(result.newMessages.map((m) => m.role)).toEqual(['assistant']);
  });
});
