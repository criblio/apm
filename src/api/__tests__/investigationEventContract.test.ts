/**
 * The investigation lifecycle commit is the durable record the
 * Alerts page renders from — pin its KQL shape and its escaping so
 * neither the cell (writer) nor Q.investigationEvents (reader) can
 * drift silently.
 */
import { describe, expect, it } from 'vitest';
import {
  INVESTIGATION_CONCLUSION_MAX,
  investigationEventCommitQuery,
} from '../generatedEventContract';
import { validateQuery } from '../provisionGuard';

const BASE = {
  event_id: 'inv-abc:investigated',
  event_type: 'investigated' as const,
  alert_id: 'auto:health:payment',
  investigation_id: 'inv-abc',
  trigger_event_id: 'criblapm:alert:criblapm-eval:123:auto:health:payment',
  svc: 'payment',
  signal_type: 'error_rate',
};

describe('investigationEventCommitQuery', () => {
  it('produces the pinned commit shape', () => {
    const q = investigationEventCommitQuery(
      { ...BASE, conclusion: 'Root cause: bad deploy.' },
      'otel',
    );
    expect(q).toMatchSnapshot();
    // The load-bearing pieces, asserted directly so a snapshot
    // refresh can't silently drop them.
    expect(q).toContain('datatype="criblapm_alert"');
    expect(q).toContain('record_kind="investigation"');
    expect(q).toContain('producer="criblapm_cell_investigator"');
    expect(q).toContain('export tee=true to search "otel"');
  });

  it('escapes quotes and backslashes in string fields', () => {
    const q = investigationEventCommitQuery(
      { ...BASE, conclusion: 'said "boom" at C:\\path' },
      'otel',
    );
    expect(q).toContain('conclusion="said \\"boom\\" at C:\\\\path"');
  });

  it('truncates the conclusion to the stored cap', () => {
    const q = investigationEventCommitQuery(
      { ...BASE, conclusion: 'x'.repeat(INVESTIGATION_CONCLUSION_MAX * 2) },
      'otel',
    );
    const m = q.match(/conclusion="(x+)"/);
    expect(m?.[1]?.length).toBe(INVESTIGATION_CONCLUSION_MAX);
  });

  it('rejects empty identifying fields', () => {
    expect(() =>
      investigationEventCommitQuery({ ...BASE, event_id: '' }, 'otel'),
    ).toThrow(/event_id/);
  });

  it('passes the provision guard (no mutating verbs beyond the export)', () => {
    const q = investigationEventCommitQuery(BASE, 'otel');
    expect(validateQuery('investigation-commit', q)).toEqual([]);
  });

  it('canary rows carry is_canary', () => {
    const q = investigationEventCommitQuery(
      { ...BASE, is_canary: true },
      'otel',
    );
    expect(q).toContain('is_canary=true');
  });
});
