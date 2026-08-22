/**
 * Human warroom writes must produce contract-shaped incident events
 * that the state fold actually consumes: status-bearing events carry
 * `status`, severity events carry `severity`, and every commit goes
 * through the pinned incidentEventCommitQuery shape.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';

const ran: string[] = [];
vi.mock('../cribl', () => ({
  runQuery: (kql: string) => {
    ran.push(kql);
    return Promise.resolve([]);
  },
}));

import { commitHumanIncidentAction, commitInvestigationLink } from '../incidents';

setCurrentDataset('otel');

beforeEach(() => { ran.length = 0; });

describe('commitHumanIncidentAction', () => {
  it('note → note event with the body, author=human', async () => {
    await commitHumanIncidentAction('inc:123', { kind: 'note', note: 'suspect payment deploy' });
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain('record_kind="incident"');
    expect(ran[0]).toContain('event_type="note"');
    expect(ran[0]).toContain('author="human"');
    expect(ran[0]).toContain('note="suspect payment deploy"');
    expect(ran[0]).toContain('producer="criblapm_app_incidents"');
    expect(ran[0]).toContain('export tee=true to search "otel"');
  });

  it('status → status_change carrying the status (fold requirement)', async () => {
    await commitHumanIncidentAction('inc:123', { kind: 'status', status: 'mitigated' });
    expect(ran[0]).toContain('event_type="status_change"');
    expect(ran[0]).toContain('status="mitigated"');
  });

  it('severity → severity_change carrying the severity', async () => {
    await commitHumanIncidentAction('inc:123', { kind: 'severity', severity: 'sev1' });
    expect(ran[0]).toContain('event_type="severity_change"');
    expect(ran[0]).toContain('severity="sev1"');
  });

  it('close → closed event with status="closed"', async () => {
    await commitHumanIncidentAction('inc:123', { kind: 'close' });
    expect(ran[0]).toContain('event_type="closed"');
    expect(ran[0]).toContain('status="closed"');
  });

  it('reopen → status_change back to open', async () => {
    await commitHumanIncidentAction('inc:123', { kind: 'reopen' });
    expect(ran[0]).toContain('event_type="status_change"');
    expect(ran[0]).toContain('status="open"');
  });

  it('rejects empty notes and missing ids', async () => {
    await expect(commitHumanIncidentAction('inc:123', { kind: 'note', note: '   ' }))
      .rejects.toThrow(/empty/);
    await expect(commitHumanIncidentAction('', { kind: 'close' }))
      .rejects.toThrow(/incidentId/);
  });

  it('two identical notes get distinct event ids (uniqueness over idempotence)', async () => {
    await commitHumanIncidentAction('inc:123', { kind: 'note', note: 'x' });
    await commitHumanIncidentAction('inc:123', { kind: 'note', note: 'x' });
    const id = (q: string) => /event_id="([^"]+)"/.exec(q)?.[1];
    expect(id(ran[0])).not.toBe(id(ran[1]));
  });
});

describe('commitInvestigationLink', () => {
  it('deterministic link event carrying the investigation id', async () => {
    await commitInvestigationLink('inc:123', 'inv-abc');
    expect(ran[0]).toContain('event_type="investigation_linked"');
    expect(ran[0]).toContain('investigation_id="inv-abc"');
    expect(ran[0]).toContain('event_id="inc:123:link:inv-abc"');
  });
});
