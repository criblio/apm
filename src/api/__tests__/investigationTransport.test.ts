/**
 * The wire→LoopEvent rehydration is what makes a server-replayed
 * transcript feed the same `applyLoopEvent` reducer the live client
 * uses. Pin every case, especially the error rehydration (the wire
 * form flattens Error to a message string) and unknown-kind
 * forward-compat.
 */
import { describe, expect, it } from 'vitest';
import {
  wireEventToLoopEvent,
  isTerminalStatus,
  type WireLoopEvent,
} from '../investigationTransport';

describe('wireEventToLoopEvent', () => {
  it('passes through assistant text and done', () => {
    expect(wireEventToLoopEvent({ kind: 'assistantText', turnId: 't1', chunk: 'hi' })).toEqual({
      kind: 'assistantText',
      turnId: 't1',
      chunk: 'hi',
    });
    expect(wireEventToLoopEvent({ kind: 'assistantDone', turnId: 't1' })).toEqual({
      kind: 'assistantDone',
      turnId: 't1',
    });
  });

  it('maps toolCall, dropping the wire-only type field', () => {
    const loop = wireEventToLoopEvent({
      kind: 'toolCall',
      turnId: 't1',
      call: { id: 'c1', type: 'function', function: { name: 'run_search', arguments: '{}' } },
      needsApproval: false,
    });
    expect(loop).toEqual({
      kind: 'toolCall',
      turnId: 't1',
      call: { id: 'c1', function: { name: 'run_search', arguments: '{}' } },
      needsApproval: false,
    });
  });

  it('preserves the toolResult ui payload (cards depend on it)', () => {
    const ui = { kind: 'search', rows: [{ n: 1 }] };
    const loop = wireEventToLoopEvent({
      kind: 'toolResult',
      turnId: 't1',
      result: { id: 'c1', name: 'run_search', content: 'ok', ui },
    });
    expect(loop).toEqual({
      kind: 'toolResult',
      turnId: 't1',
      result: { id: 'c1', name: 'run_search', content: 'ok', ui },
    });
  });

  it('rehydrates error message into an Error instance', () => {
    const loop = wireEventToLoopEvent({ kind: 'error', message: 'boom' });
    expect(loop?.kind).toBe('error');
    if (loop?.kind === 'error') {
      expect(loop.error).toBeInstanceOf(Error);
      expect(loop.error.message).toBe('boom');
    }
  });

  it('normalizes done reason to complete/aborted', () => {
    expect(wireEventToLoopEvent({ kind: 'done', reason: 'complete' })).toEqual({
      kind: 'done',
      reason: 'complete',
    });
    expect(wireEventToLoopEvent({ kind: 'done', reason: 'aborted' })).toEqual({
      kind: 'done',
      reason: 'aborted',
    });
    // Any other reason string collapses to 'complete'.
    expect(wireEventToLoopEvent({ kind: 'done', reason: 'whatever' })).toEqual({
      kind: 'done',
      reason: 'complete',
    });
  });

  it('returns null for an unknown kind (forward compat)', () => {
    expect(
      wireEventToLoopEvent({ kind: 'future_kind' } as unknown as WireLoopEvent),
    ).toBeNull();
  });
});

describe('isTerminalStatus', () => {
  it('classifies terminal vs live', () => {
    expect(isTerminalStatus('concluded')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
    expect(isTerminalStatus('running')).toBe(false);
    expect(isTerminalStatus('queued')).toBe(false);
  });
});
