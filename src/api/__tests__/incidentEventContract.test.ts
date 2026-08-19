/**
 * The incident lifecycle commit is the append-only log the incidents
 * lookup + timeline render from — pin its KQL shape and escaping so
 * neither the app (writer) nor the grouping/fold readers drift silently.
 */
import { describe, expect, it } from 'vitest';
import {
  INCIDENT_APP_PRODUCER,
  INCIDENT_NOTE_MAX,
  incidentEventCommitQuery,
} from '../generatedEventContract';
import { validateQuery } from '../provisionGuard';

const BASE = {
  event_id: 'incident-abc:note:1',
  producer: INCIDENT_APP_PRODUCER,
  incident_id: 'incident-abc',
  event_type: 'note' as const,
  author: 'human' as const,
};

describe('incidentEventCommitQuery', () => {
  it('produces the pinned commit shape', () => {
    const q = incidentEventCommitQuery(
      { ...BASE, note: 'payment looks like the root; checkout is downstream.' },
      'otel',
    );
    expect(q).toMatchSnapshot();
    expect(q).toContain('datatype="criblapm_alert"');
    expect(q).toContain('record_kind="incident"');
    expect(q).toContain('producer="criblapm_app_incidents"');
    expect(q).toContain('incident_id="incident-abc"');
    expect(q).toContain('event_type="note"');
    expect(q).toContain('export tee=true to search "otel"');
  });

  it('emits status/severity for a status_change from the grouper', () => {
    const q = incidentEventCommitQuery(
      {
        event_id: 'incident-abc:status:2',
        producer: 'criblapm_incident_grouper',
        incident_id: 'incident-abc',
        event_type: 'status_change',
        author: 'system',
        status: 'resolved',
        severity: 'sev2',
        root_service: 'payment',
        services: 'payment,checkout,frontend',
      },
      'otel',
    );
    expect(q).toContain('status="resolved"');
    expect(q).toContain('severity="sev2"');
    expect(q).toContain('root_service="payment"');
    expect(q).toContain('services="payment,checkout,frontend"');
  });

  it('escapes quotes and backslashes in string fields', () => {
    const q = incidentEventCommitQuery(
      { ...BASE, note: 'said "boom" at C:\\path' },
      'otel',
    );
    expect(q).toContain('note="said \\"boom\\" at C:\\\\path"');
  });

  it('truncates the note to the stored cap', () => {
    const q = incidentEventCommitQuery(
      { ...BASE, note: 'x'.repeat(INCIDENT_NOTE_MAX * 2) },
      'otel',
    );
    const m = q.match(/note="(x+)"/);
    expect(m?.[1]?.length).toBe(INCIDENT_NOTE_MAX);
  });

  it('rejects empty identifying fields', () => {
    expect(() =>
      incidentEventCommitQuery({ ...BASE, incident_id: '' }, 'otel'),
    ).toThrow(/incident_id/);
    expect(() =>
      incidentEventCommitQuery({ ...BASE, producer: '' }, 'otel'),
    ).toThrow(/producer/);
  });

  it('passes the provision guard (no mutating verbs beyond the export)', () => {
    const q = incidentEventCommitQuery(BASE, 'otel');
    expect(validateQuery('incident-commit', q)).toEqual([]);
  });

  it('canary rows carry is_canary', () => {
    const q = incidentEventCommitQuery({ ...BASE, is_canary: true }, 'otel');
    expect(q).toContain('is_canary=true');
  });
});
