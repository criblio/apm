/**
 * The incident pipeline (P4.4 Phase 1) is three cooperating scheduled
 * searches whose KQL shapes must not drift: the grouper's emitted rows
 * are IncidentEvent contract rows, the fold is what the Incidents list
 * reads, and the export is the grouper's own join surface. Pin the
 * shapes, the idempotency joins, and the provisioning wiring.
 */
import { describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import * as Q from '../queries';
import { validateQuery } from '../provisionGuard';
import {
  getProvisioningPlan,
  INCIDENTS_LOOKUP,
  SEED_LOOKUPS,
} from '../provisionedSearches';
import { INCIDENT_GROUPER_PRODUCER } from '../generatedEventContract';

setCurrentDataset('otel');

describe('incidentGrouper', () => {
  const q = Q.incidentGrouper();

  it('matches the pinned shape', () => {
    expect(q).toMatchSnapshot();
  });

  it('selects firing evaluation transitions and excludes canaries', () => {
    expect(q).toContain('record_kind == "evaluation" and event_type == "firing"');
    expect(q).toContain('tostring(is_canary) != "true"');
  });

  it('attaches via the incidents lookup and graph adjacency', () => {
    expect(q).toContain(`lookup ${INCIDENTS_LOOKUP} on svc`);
    expect(q).toContain('criblapm__sysarch_dependencies');
    // Ignores the seed sentinel row.
    expect(q).toContain('tostring(incident_id) != "__init__"');
  });

  it('adjacency attaches only to OPEN incidents (member refire owns reopen)', () => {
    const adj = q.slice(q.indexOf('criblapm__sysarch_dependencies'), q.indexOf('adj_incident_id=max'));
    expect(adj).toContain('tostring(status) == "open"');
  });

  it('adjacency attaches only within the onset window W', () => {
    const adj = q.slice(q.indexOf('criblapm__sysarch_dependencies'), q.indexOf('adj_incident_id=max'));
    expect(adj).toContain(`toreal(opened_at) >= toreal(now()) - ${60 * 60}`);
  });

  it('is idempotent: leftanti dedup on already-committed event ids', () => {
    expect(q).toContain('join kind=leftanti');
    expect(q).toContain('record_kind == "incident"');
  });

  it('emits IncidentEvent contract rows through export tee', () => {
    expect(q).toContain(`producer="${INCIDENT_GROUPER_PRODUCER}"`);
    expect(q).toContain('record_kind="incident"');
    expect(q).toContain('author="system"');
    for (const field of [
      'event_id', 'event_type', 'incident_id', 'status', 'severity',
      'root_service', 'services', 'note', 'investigation_id',
      'alert_event_id', 'title',
    ]) {
      expect(q, `projects contract field ${field}`).toMatch(
        new RegExp(`[,\\s]${field}[=,\\s]`),
      );
    }
    expect(q).toContain('export tee=true to search "otel"');
  });

  it('passes the provision guard', () => {
    expect(validateQuery('criblapm__incident_grouper', q)).toEqual([]);
  });
});

describe('incidentStateFold', () => {
  const q = Q.incidentStateFold();

  it('matches the pinned shape', () => {
    expect(q).toMatchSnapshot();
  });

  it('folds incident events only, excluding canaries', () => {
    expect(q).toContain('record_kind == "incident"');
    expect(q).toContain('tostring(is_canary) != "true"');
  });

  it('derives liveness from the evaluator panel cache, not a -7d scan', () => {
    expect(q).toContain('jobName == "criblapm__home_alerts"');
    expect(q).toContain('"pending", "firing", "resolving"');
  });

  it('lets human status/severity events win', () => {
    expect(q).toContain('"status_change", "closed"');
    expect(q).toContain('event_type == "severity_change"');
    expect(q).toContain('o_status_time >= inc_last_fire');
  });

  it('emits one row per (incident_id, svc) with the read-model columns', () => {
    for (const field of [
      'incident_id', 'svc', 'status', 'severity', 'opened_at',
      'first_seen', 'last_fire_at', 'fire_n', 'n_svcs', 'inc_last_fire',
      'title',
    ]) {
      expect(q, `projects ${field}`).toContain(field);
    }
  });

  it('passes the provision guard', () => {
    expect(validateQuery('criblapm__incidents_state', q)).toEqual([]);
  });
});

describe('incidentEvents reader', () => {
  it('filters to one incident and escapes the id', () => {
    const q = Q.incidentEvents('inc:17\'"x');
    expect(q).toContain('record_kind == "incident"');
    expect(q).toContain('incident_id == "inc:17\'\\"x"');
    // Newest-first before the limit so a capped incident drops its
    // OLDEST events; readers re-sort ascending client-side.
    expect(q).toContain('sort by _time desc');
  });

  it('caps the limit', () => {
    expect(Q.incidentEvents(undefined, 99_999)).toContain('limit 2000');
  });
});

describe('provisioning wiring', () => {
  const plan = getProvisioningPlan();
  const byId = new Map(plan.map((s) => [s.id, s]));

  it('provisions grouper, fold, and export', () => {
    expect(byId.has('criblapm__incident_grouper')).toBe(true);
    expect(byId.has('criblapm__incidents_state')).toBe(true);
    expect(byId.has('criblapm__incidents_export')).toBe(true);
  });

  it('orders the pipeline within one cadence: evaluator → grouper → fold → export', () => {
    // Default 5m cadence: evaluator at +1, grouper at +3, fold at +4,
    // export on the base cadence (fires 1 min after the fold).
    expect(byId.get('criblapm__incident_grouper')!.schedule.cronSchedule).toMatch(/^3-59\//);
    expect(byId.get('criblapm__incidents_state')!.schedule.cronSchedule).toMatch(/^4-59\//);
  });

  it('export reads only the latest fold run and drops closed incidents', () => {
    const q = byId.get('criblapm__incidents_export')!.query;
    expect(q).toContain('jobName == "criblapm__incidents_state"');
    expect(q).toContain('summarize jobId=max(tostring(jobId))');
    expect(q).toContain('tostring(status) != "closed"');
    expect(q).toContain(`to lookup ${INCIDENTS_LOOKUP}`);
    expect(validateQuery('criblapm__incidents_export', q)).toEqual([]);
  });

  it('seeds the incidents lookup before the grouper can reference it', () => {
    const seed = SEED_LOOKUPS.find((s) => s.name === INCIDENTS_LOOKUP);
    expect(seed).toBeDefined();
    // Seed schema must match the export schema so the grouper's
    // lookup join sees the same columns before and after first export.
    for (const col of [
      'incident_id', 'svc', 'status', 'severity', 'root_service',
      'opened_at', 'last_fire_at', 'title',
    ]) {
      expect(seed!.seedQuery, `seed column ${col}`).toContain(col);
    }
    expect(validateQuery(`seed:${INCIDENTS_LOOKUP}`, seed!.seedQuery)).toEqual([]);
  });
});
