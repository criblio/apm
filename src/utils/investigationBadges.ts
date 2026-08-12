/**
 * Join server-side investigation lifecycle events onto alert
 * incidents for the Alerts page badges.
 *
 * The cell commits `record_kind:'investigation'` events (started /
 * investigated / investigation_failed) keyed by alert_id. An
 * incident (a firing→resolved window for a service+signal) matches
 * the latest investigation whose alert_id equals the incident's
 * alert_id AND whose event time falls within the incident window
 * (start .. end-or-now). Pure so it's unit-tested without the page.
 */

export interface InvestigationEventRow {
  timeMs: number;
  eventType: 'started' | 'investigated' | 'investigation_failed' | string;
  alertId: string;
  investigationId: string;
  svc: string;
  conclusion: string;
}

export interface IncidentKeyable {
  service: string;
  signalType: string;
  startTime: number;
  endTime: number | null;
  /** The evaluator's alert_id is signal-agnostic for health
   *  (`auto:health:<svc>`) and op-scoped for latency
   *  (`auto:latency:<svc>:<op>`). AlertsPage incidents don't carry
   *  it, so we reconstruct the health form from the service — the
   *  common case — and fall back to a service match. */
  alertId?: string;
}

export type InvestigationBadgeState = 'investigating' | 'investigated' | 'failed';

export interface InvestigationBadge {
  state: InvestigationBadgeState;
  investigationId: string;
  conclusion: string;
}

const EVENT_RANK: Record<string, number> = {
  started: 1,
  investigation_failed: 2,
  investigated: 3,
};

function badgeState(eventType: string): InvestigationBadgeState | null {
  switch (eventType) {
    case 'started':
      return 'investigating';
    case 'investigated':
      return 'investigated';
    case 'investigation_failed':
      return 'failed';
    default:
      return null;
  }
}

/**
 * Reduce lifecycle events to the latest per investigation_id, then
 * index them by alert_id. "Latest" prefers a terminal event over a
 * `started` from the same run (investigations conclude, they don't
 * un-conclude), then most recent time.
 */
export function indexInvestigations(
  rows: InvestigationEventRow[],
): Map<string, InvestigationEventRow[]> {
  const latestPerRun = new Map<string, InvestigationEventRow>();
  for (const row of rows) {
    const prev = latestPerRun.get(row.investigationId);
    if (!prev) {
      latestPerRun.set(row.investigationId, row);
      continue;
    }
    const better =
      (EVENT_RANK[row.eventType] ?? 0) > (EVENT_RANK[prev.eventType] ?? 0) ||
      ((EVENT_RANK[row.eventType] ?? 0) === (EVENT_RANK[prev.eventType] ?? 0) &&
        row.timeMs > prev.timeMs);
    if (better) latestPerRun.set(row.investigationId, row);
  }
  const byAlert = new Map<string, InvestigationEventRow[]>();
  for (const row of latestPerRun.values()) {
    const list = byAlert.get(row.alertId) ?? [];
    list.push(row);
    byAlert.set(row.alertId, list);
  }
  return byAlert;
}

/** Match one incident to its investigation badge, or null. */
export function badgeForIncident(
  incident: IncidentKeyable,
  byAlert: Map<string, InvestigationEventRow[]>,
): InvestigationBadge | null {
  const candidates: InvestigationEventRow[] = [];
  const healthId = `auto:health:${incident.service}`;
  for (const key of [incident.alertId, healthId]) {
    if (key && byAlert.has(key)) candidates.push(...byAlert.get(key)!);
  }
  if (candidates.length === 0) return null;

  // A small grace window on each side absorbs the ~minutes of skew
  // between the evaluator's firing time and the cell's event time.
  const GRACE_MS = 10 * 60_000;
  const lo = incident.startTime - GRACE_MS;
  const hi = (incident.endTime ?? Date.now()) + GRACE_MS;

  const inWindow = candidates
    .filter((c) => c.timeMs >= lo && c.timeMs <= hi)
    .sort((a, b) => b.timeMs - a.timeMs);
  const chosen = inWindow[0];
  if (!chosen) return null;

  const state = badgeState(chosen.eventType);
  if (!state) return null;
  return {
    state,
    investigationId: chosen.investigationId,
    conclusion: chosen.conclusion,
  };
}
