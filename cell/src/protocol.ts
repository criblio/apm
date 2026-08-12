/**
 * Wire protocol between the investigator cell and the APM UI.
 *
 * WireLoopEvent structurally mirrors the framework's LoopEvent union
 * (@cribl/app-utils agent-loop.ts) with one difference: `error`
 * carries a plain message string instead of an Error instance so it
 * survives JSON. The UI rehydrates it and feeds every event through
 * its existing `applyLoopEvent` reducer, which is what makes a
 * server-run transcript render identically to a client-run one.
 *
 * PR-7 note: once the cell imports shared modules from ../../src/api
 * (real agent loop), converge these types with the framework union
 * via a type-level assertion test so drift is caught at build time.
 */

export const PROTOCOL_VERSION = 1;

/** Structural mirror of the framework ToolResultUi payloads. The
 *  cell only needs to pass them through, so `unknown` is fine. */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type WireLoopEvent =
  | { kind: 'assistantText'; turnId: string; chunk: string }
  | { kind: 'assistantDone'; turnId: string }
  | {
      kind: 'toolCall';
      turnId: string;
      call: WireToolCall;
      needsApproval: boolean;
    }
  | {
      kind: 'toolResult';
      turnId: string;
      result: { id: string; name: string; content: string; ui?: unknown };
    }
  | { kind: 'notification'; turnId: string; content: string }
  | { kind: 'error'; message: string }
  | { kind: 'done'; reason: string };

export type InvestigationStatus =
  | 'queued'
  | 'running'
  | 'concluded'
  | 'failed'
  | 'cancelled';

/** The alert facts the trigger passes in — matches the columns the
 *  criblapm__alert_notify search projects (which are a superset of
 *  what buildAlertSeed() in src/api/agentContext.ts needs). */
export interface FiringAlert {
  event_id: string;
  alert_id: string;
  svc: string;
  signal_type: string;
  curr_error_rate?: number;
  fire_count?: number;
  _time?: number;
}

/**
 * The key that groups investigations for the same ongoing problem.
 * Both Durable Objects derive it, so it lives next to the type it
 * reads rather than being spelled out at each call site.
 */
export function incidentKey(alert: FiringAlert): string {
  return `${alert.svc}:${alert.signal_type}`;
}

export interface InvestigationSummaryRow {
  id: string;
  alertId: string;
  incidentKey: string;
  status: InvestigationStatus;
  createdAt: number;
  startedAt: number | null;
  concludedAt: number | null;
}

export type ServerFrame =
  | {
      type: 'hello';
      protocolVersion: number;
      investigation: {
        id: string;
        status: InvestigationStatus;
        seed: unknown;
        alertId: string;
        createdAt: number;
        concludedAt: number | null;
      };
      latestSeq: number;
    }
  | { type: 'event'; seq: number; ev: WireLoopEvent }
  | { type: 'status'; status: InvestigationStatus }
  | { type: 'ping' };
