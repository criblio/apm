/**
 * Wire protocol between the investigator cell and the APM UI.
 *
 * The generic protocol — WireLoopEvent, ServerFrame, session
 * statuses — now lives in @criblio/agent-protocol (one source of
 * truth for the cell AND the UI transport; this file used to carry a
 * hand-maintained mirror). This module re-exports it under the
 * cell's established investigation-flavored names and keeps the
 * APM-specific trigger types that stay with this app's payload.
 *
 * The LoopEvent parity assertion the old mirror asked for lives in
 * __tests__/protocolParity.test.ts.
 */
export {
  PROTOCOL_VERSION,
  isTerminalStatus,
  titleFromPrompt,
} from '@criblio/agent-protocol';
export type {
  ServerFrame,
  SourceRepo,
  WireLoopEvent,
  WireToolCall,
  SessionStatus as InvestigationStatus,
  SessionMode as InvestigationMode,
  SessionSummaryRow as InvestigationSummaryRow,
  CreateSessionBody as CreateInvestigationBody,
} from '@criblio/agent-protocol';

// ── APM payload types (stay with this app) ─────────────────────────

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
 * Derived by the APM payload's triggerFacts(), so it lives next to
 * the type it reads rather than being spelled out at each call site.
 */
export function incidentKey(alert: FiringAlert): string {
  return `${alert.svc}:${alert.signal_type}`;
}
