/**
 * The wire→LoopEvent rehydration is what makes a server-replayed
 * transcript feed the same `applyLoopEvent` reducer the live client
 * uses. Pin every case, especially the error rehydration (the wire
 * form flattens Error to a message string) and unknown-kind
 * forward-compat.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInvestigation,
  fetchInvestigationReportHeadline,
  GOATTOWN_OWNER,
  SHARED_GOATTOWN_BASE_URL,
  listInvestigations,
  setCellBaseUrl,
  wireEventToLoopEvent,
  isTerminalStatus,
  type WireLoopEvent,
} from '../investigationTransport';
afterEach(() => {
  vi.unstubAllGlobals();
  setCellBaseUrl(null);
});

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

describe('GoatTown compatibility', () => {
  it('defaults to the shared GoatTown service', () => {
    expect(SHARED_GOATTOWN_BASE_URL).toBe('https://goattown-shared.lab.cribl.io');
  });

  // The report -> summary mapping moved into app-utils 0.8.6, whose
  // transcript renders `kind: 'report'` through the same `reportToSummary`
  // that was lifted from this module. The transport's job is now only to
  // hand the wire payload over untouched.
  it('passes a report tool result through for the framework to render', () => {
    const ui = {
      kind: 'report',
      headline: 'Payment is timing out',
      report: '## Dependency failure\nThe payment dependency exceeded its deadline.',
      disposition: 'act',
    };
    const loop = wireEventToLoopEvent({
      kind: 'toolResult',
      turnId: 't1',
      result: { id: 'c1', name: 'report_findings', content: '', ui },
    } as WireLoopEvent);
    expect(loop).toMatchObject({ kind: 'toolResult', result: { ui } });
  });

  it('maps the GoatTown concluding call to the existing summary renderer', () => {
    const loop = wireEventToLoopEvent({
      kind: 'toolCall',
      turnId: 't1',
      call: {
        id: 'c1',
        type: 'function',
        function: { name: 'report_findings', arguments: '{}' },
      },
      needsApproval: false,
    });
    expect(loop).toMatchObject({
      kind: 'toolCall',
      call: { function: { name: 'present_investigation_summary' } },
    });
  });

  it('selects the registered APM agent for interactive sessions', async () => {
    setCellBaseUrl('https://goatfarm.example');
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ id: 'inv-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    await createInvestigation({ prompt: 'Investigate checkout' });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      prompt: 'Investigate checkout',
      title: 'APM: Investigate checkout',
      agent: 'apm-investigator',
    });
    expect(new Headers(init.headers).get('x-goattown-user')).toBe(GOATTOWN_OWNER);
  });

  it('reads an interactive report headline from persisted transcript events', async () => {
    setCellBaseUrl('https://goattown.example');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, claimed: 0 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        protocolVersion: 1,
        status: 'idle',
        latestSeq: 3,
        frames: [{
          seq: 3,
          ev: {
            kind: 'toolResult',
            turnId: 't1',
            result: {
              id: 'c1',
              name: 'report_findings',
              content: 'recorded',
              ui: { kind: 'report', headline: 'Checkout retries caused the spike', report: 'Details' },
            },
          },
        }],
      })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchInvestigationReportHeadline('inv-1'))
      .resolves.toBe('Checkout retries caused the spike');
    expect(String(fetchMock.mock.calls[1][0])).toContain('/investigations/inv-1/events?since=0');
  });

  it('filters shared GoatTown sessions and scans past a full unrelated page', async () => {
    setCellBaseUrl('https://goatfarm.example');
    const unrelated = Array.from({ length: 100 }, (_, index) => ({
      id: `other-${index}`,
      alertId: '',
      incidentKey: 'goattown',
      status: 'idle',
      title: `Other session ${index}`,
      mode: 'interactive',
      createdAt: 1_000 - index,
      startedAt: 1_000 - index,
      concludedAt: null,
    }));
    const apm = {
      id: 'apm-1',
      alertId: '',
      incidentKey: 'goattown',
      status: 'idle',
      title: 'APM: Checkout errors',
      mode: 'interactive',
      createdAt: 800,
      startedAt: 800,
      concludedAt: null,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, claimed: 1 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ investigations: unrelated })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ investigations: [apm] })));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listInvestigations({ limit: 30 })).resolves.toEqual([apm]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/admin/claim-sessions');
    expect(String(fetchMock.mock.calls[1][0])).toContain('agent=apm-investigator');
    expect(String(fetchMock.mock.calls[2][0])).toContain('before=901');
  });
});
