/**
 * Human warroom writes (P4.4 Phase 2B): notes, status/severity
 * overrides, close/reopen, and investigation links — appended to the
 * incident's event log through the same pinned commit KQL the grouper
 * uses (`incidentEventCommitQuery` + `export tee=true to search`).
 * No cell involved: this is the Cribl-Search-native write path, so
 * the warroom works with the investigator off.
 *
 * Read-your-write semantics: the EVENT is durable and readable the
 * moment the commit search completes (the timeline shows it on the
 * next fetch), but the incident's folded STATE (status/severity in
 * the list + lookup) updates on the next fold cadence (≤5 min).
 * Callers should update local state optimistically and say so.
 */
import { getCurrentDataset } from '@cribl/app-utils/dataset';
import { runQuery } from './cribl';
import {
  INCIDENT_APP_PRODUCER,
  incidentEventCommitQuery,
  type IncidentSeverity,
  type IncidentStatus,
} from './generatedEventContract';

/** Human actions the warroom UI can take. `reopen` is sugar for a
 *  status_change back to `open`. */
export type HumanIncidentAction =
  | { kind: 'note'; note: string }
  | { kind: 'status'; status: IncidentStatus }
  | { kind: 'severity'; severity: IncidentSeverity }
  | { kind: 'close' }
  | { kind: 'reopen' };

/** Commit one human warroom action. Resolves when the commit search
 *  job has completed (the event is durably in the dataset). */
export async function commitHumanIncidentAction(
  incidentId: string,
  action: HumanIncidentAction,
): Promise<void> {
  if (!incidentId) throw new Error('incidentId required');
  // Human events need uniqueness, not idempotent determinism — a
  // person adding two identical notes wants two notes.
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const base = {
    producer: INCIDENT_APP_PRODUCER,
    incident_id: incidentId,
    author: 'human' as const,
  };

  let kql: string;
  switch (action.kind) {
    case 'note': {
      const note = action.note.trim();
      if (!note) throw new Error('note is empty');
      kql = incidentEventCommitQuery(
        { ...base, event_id: `${incidentId}:note:${nonce}`, event_type: 'note', note },
        getCurrentDataset(),
      );
      break;
    }
    case 'status':
      kql = incidentEventCommitQuery(
        {
          ...base,
          event_id: `${incidentId}:status:${nonce}`,
          event_type: 'status_change',
          status: action.status,
        },
        getCurrentDataset(),
      );
      break;
    case 'severity':
      kql = incidentEventCommitQuery(
        {
          ...base,
          event_id: `${incidentId}:severity:${nonce}`,
          event_type: 'severity_change',
          severity: action.severity,
        },
        getCurrentDataset(),
      );
      break;
    case 'close':
      kql = incidentEventCommitQuery(
        {
          ...base,
          event_id: `${incidentId}:closed:${nonce}`,
          event_type: 'closed',
          status: 'closed',
        },
        getCurrentDataset(),
      );
      break;
    case 'reopen':
      kql = incidentEventCommitQuery(
        {
          ...base,
          event_id: `${incidentId}:reopen:${nonce}`,
          event_type: 'status_change',
          status: 'open',
        },
        getCurrentDataset(),
      );
      break;
  }

  await runQuery(kql, '-1m', 'now', 5);
}

/**
 * Record that an investigation belongs to this incident (Phase 4-lite:
 * the human launched it from the incident page, so the link is known
 * app-side; the cell learns to stamp incident_id itself in Phase 4).
 */
export async function commitInvestigationLink(
  incidentId: string,
  investigationId: string,
): Promise<void> {
  if (!incidentId || !investigationId) throw new Error('incidentId and investigationId required');
  const kql = incidentEventCommitQuery(
    {
      producer: INCIDENT_APP_PRODUCER,
      incident_id: incidentId,
      author: 'human',
      // Deterministic: linking the same investigation twice is a no-op
      // at read time (readers dedupe by event_id).
      event_id: `${incidentId}:link:${investigationId}`,
      event_type: 'investigation_linked',
      investigation_id: investigationId,
    },
    getCurrentDataset(),
  );
  await runQuery(kql, '-1m', 'now', 5);
}
