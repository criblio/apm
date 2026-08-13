/**
 * Table tests for the pi-ai → LoopEvent mapping — the seam that
 * makes a server-run investigation render identically in the UI.
 */
import { describe, expect, it } from 'vitest';
import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import { mapPiEvent, toolCallsOf } from '../loopEventMap';

const partial: AssistantMessage = {
  role: 'assistant',
  content: [],
  api: 'openai-completions',
  provider: 'openai-compatible',
  model: 'test',
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'pending',
  timestamp: 0,
};

const T = 'turn-3';

const CASES: Array<{
  name: string;
  ev: AssistantMessageEvent;
  expected: unknown[];
}> = [
  {
    name: 'text_delta → assistantText chunk',
    ev: { type: 'text_delta', contentIndex: 0, delta: 'hello', partial },
    expected: [{ kind: 'assistantText', turnId: T, chunk: 'hello' }],
  },
  {
    name: 'empty text_delta → nothing',
    ev: { type: 'text_delta', contentIndex: 0, delta: '', partial },
    expected: [],
  },
  {
    name: 'thinking_end → single notification',
    ev: { type: 'thinking_end', contentIndex: 0, content: ' plan ', partial },
    expected: [{ kind: 'notification', turnId: T, content: 'Thinking: plan' }],
  },
  {
    name: 'blank thinking_end → nothing',
    ev: { type: 'thinking_end', contentIndex: 0, content: '  ', partial },
    expected: [],
  },
  {
    name: 'toolcall_end → OpenAI-style toolCall with stringified args',
    ev: {
      type: 'toolcall_end',
      contentIndex: 0,
      toolCall: {
        type: 'toolCall',
        id: 'call-9',
        name: 'run_search',
        arguments: { query: 'dataset="otel" | limit 1', limit: 5 },
      },
      partial,
    },
    expected: [
      {
        kind: 'toolCall',
        turnId: T,
        call: {
          id: 'call-9',
          type: 'function',
          function: {
            name: 'run_search',
            arguments: JSON.stringify({ query: 'dataset="otel" | limit 1', limit: 5 }),
          },
        },
        needsApproval: false,
      },
    ],
  },
  {
    name: 'error → error with message',
    ev: {
      type: 'error',
      reason: 'error',
      error: { ...partial, stopReason: 'error', errorMessage: 'rate limited' },
    },
    expected: [{ kind: 'error', message: 'rate limited' }],
  },
  {
    name: 'aborted without message → fallback text',
    ev: {
      type: 'error',
      reason: 'aborted',
      error: { ...partial, stopReason: 'aborted' },
    },
    expected: [{ kind: 'error', message: 'LLM stream aborted' }],
  },
  // Structural events carry no transcript payload.
  { name: 'start → nothing', ev: { type: 'start', partial }, expected: [] },
  {
    name: 'text_start → nothing',
    ev: { type: 'text_start', contentIndex: 0, partial },
    expected: [],
  },
  {
    name: 'thinking_delta → nothing (compact transcripts)',
    ev: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm', partial },
    expected: [],
  },
  {
    name: 'toolcall_delta → nothing (emitted whole at end)',
    ev: { type: 'toolcall_delta', contentIndex: 0, delta: '{"qu', partial },
    expected: [],
  },
  {
    name: 'done → nothing (terminal handling is the loop, not the map)',
    ev: { type: 'done', reason: 'toolUse', message: partial },
    expected: [],
  },
];

describe('mapPiEvent', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(mapPiEvent(c.ev, T)).toEqual(c.expected);
    });
  }
});

describe('toolCallsOf', () => {
  it('filters tool calls in content order', () => {
    const calls = toolCallsOf([
      { type: 'text' },
      { type: 'toolCall', id: 'a', name: 'run_search', arguments: {} } as never,
      { type: 'thinking' },
      { type: 'toolCall', id: 'b', name: 'render_trace', arguments: {} } as never,
    ]);
    expect(calls.map((c) => c.id)).toEqual(['a', 'b']);
  });
});
