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
  // A user's turn (interactive investigations): the opening prompt or a
  // follow-up message. Recorded as a transcript event so a reopened
  // session replays the user's side of the conversation, not just the
  // assistant's. Not a framework LoopEvent — the UI renders it as a
  // user bubble directly.
  | { kind: 'userMessage'; turnId: string; content: string }
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
  // Interactive investigations only: the loop answered the current
  // user turn and is waiting for the next message. Non-terminal — a
  // new message flips it back to 'running'.
  | 'idle'
  | 'concluded'
  | 'failed'
  | 'cancelled';

/** How an investigation was started. `autonomous` = an alert trigger
 *  drove it to a conclusion; `interactive` = a user started it from
 *  the UI and can keep chatting (see the 'idle' status). */
export type InvestigationMode = 'autonomous' | 'interactive';

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
  /** Human-readable label for the recall panel. For interactive
   *  investigations it's derived from the user's opening prompt; for
   *  autonomous ones it falls back to the incident key. */
  title: string;
  mode: InvestigationMode;
  createdAt: number;
  startedAt: number | null;
  concludedAt: number | null;
}

/** A source repo the agent may check out. `service` maps it to a
 *  telemetry service; `*`/undefined = monorepo catch-all. */
export interface SourceRepo {
  url: string;
  name?: string;
  service?: string;
  ref?: string;
}

/** Body for a UI-initiated (interactive) investigation. */
export interface CreateInvestigationBody {
  prompt: string;
  context?: { service?: string; earliest?: string; latest?: string } | null;
  title?: string;
  /** Repos the agent may check out (from app Settings). Falls back to
   *  the cell's REPOS_JSON env when absent. */
  repos?: SourceRepo[];
}

/** Derive a short recall-panel title from a free-form prompt. */
export function titleFromPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 79)}…` : oneLine || 'Investigation';
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
