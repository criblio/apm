/**
 * Stub agent: emits a canned but shape-faithful investigation so the
 * whole pipe (fire → dedupe → queue → alarm-driven turns → transcript
 * → WS/poll replay → conclusion) is testable end-to-end with no LLM
 * and no Cribl credentials.
 *
 * Each "turn" mirrors the real loop's event cadence: assistant text,
 * a tool call + result (with a `ui` payload shaped like the
 * framework's RunSearchUi), and on the final turn a
 * present_investigation_summary result (SummaryUi shape) before
 * `done`. PR 7 replaces this module with the pi-agent-core loop; the
 * DO's alarm machinery does not change.
 */
import type { FiringAlert, WireLoopEvent } from './protocol';

export const STUB_TURNS = 4;

export function stubTurnEvents(
  turnIndex: number,
  alert: FiringAlert,
): { events: WireLoopEvent[]; done: boolean } {
  const turnId = `turn-${turnIndex}`;
  const svc = alert.svc || 'unknown';

  if (turnIndex === 0) {
    return {
      done: false,
      events: [
        {
          kind: 'assistantText',
          turnId,
          chunk: `Investigating the ${alert.signal_type} alert on ${svc}. I'll start with the error breakdown.`,
        },
        { kind: 'assistantDone', turnId },
      ],
    };
  }

  if (turnIndex < STUB_TURNS - 1) {
    const callId = `call-${turnIndex}`;
    const query = `dataset="otel" | where service_name == "${svc}" | summarize n=count() by status_code`;
    return {
      done: false,
      events: [
        {
          kind: 'toolCall',
          turnId,
          call: {
            id: callId,
            type: 'function',
            function: {
              name: 'run_search',
              arguments: JSON.stringify({
                query,
                earliest: '-1h',
                latest: 'now',
                description: `Status-code breakdown for ${svc} (stub turn ${turnIndex})`,
                confirmBeforeRunning: false,
              }),
            },
          },
          needsApproval: false,
        },
        {
          kind: 'toolResult',
          turnId,
          result: {
            id: callId,
            name: 'run_search',
            content: '{"status_code":"ERROR","n":42}\n{"status_code":"OK","n":958}',
            ui: {
              kind: 'search',
              query,
              earliest: '-1h',
              latest: 'now',
              description: `Status-code breakdown for ${svc} (stub turn ${turnIndex})`,
              rows: [
                { status_code: 'ERROR', n: 42 },
                { status_code: 'OK', n: 958 },
              ],
              rowCount: 2,
              elapsedMs: 1200,
            },
          },
        },
        {
          kind: 'assistantText',
          turnId,
          chunk: `Turn ${turnIndex}: ${svc} shows a 4.2% error rate in the stub window. Digging further.`,
        },
        { kind: 'assistantDone', turnId },
      ],
    };
  }

  // Final turn: summary + done.
  const callId = `call-summary`;
  return {
    done: true,
    events: [
      {
        kind: 'toolCall',
        turnId,
        call: {
          id: callId,
          type: 'function',
          function: {
            name: 'present_investigation_summary',
            arguments: JSON.stringify({
              findings: [
                {
                  category: 'Root cause (stub)',
                  details: `${svc} error rate elevated; stub investigation concluded after ${STUB_TURNS} turns.`,
                },
              ],
              conclusion: `Stub conclusion for the ${alert.signal_type} alert on ${svc}.`,
            }),
          },
        },
        needsApproval: false,
      },
      {
        kind: 'toolResult',
        turnId,
        result: {
          id: callId,
          name: 'present_investigation_summary',
          content: 'Summary presented to the user.',
          ui: {
            kind: 'summary',
            findings: [
              {
                category: 'Root cause (stub)',
                details: `${svc} error rate elevated; stub investigation concluded after ${STUB_TURNS} turns.`,
              },
            ],
            conclusion: `Stub conclusion for the ${alert.signal_type} alert on ${svc}.`,
          },
        },
      },
      { kind: 'done', reason: 'complete' },
    ],
  };
}
