/**
 * Dependent scheduled searches (evaluator +1, notify +2, incident
 * grouper +3, incident fold +4) derive their cron from the panel
 * cadence. The previous inline `.replace(/^\* /, '1 ')` turned the 1m
 * cadence `* * * * *` into `1 * * * *` — every dependent ran HOURLY.
 * These tests pin offsetCron for every cadence the framework can
 * return, and the resulting plan crons.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import {
  CADENCE_OPTIONS,
  DEFAULT_CADENCE,
  cadenceToCron,
  setSearchCadence,
} from '@criblio/app-utils/cadence';
import { offsetCron } from '../cronOffset';
import { getProvisioningPlan } from '../provisionedSearches';
import { setServerInvestigations } from '../serverInvestigations';

setCurrentDataset('otel');

afterEach(() => {
  setSearchCadence(DEFAULT_CADENCE);
  setServerInvestigations(false);
});

/** Expected dependent crons per cadence, offsets 1..4. */
const EXPECTED: Record<string, [string, string, string, string]> = {
  // Every minute: no later phase exists; stay every minute.
  '1m': ['* * * * *', '* * * * *', '* * * * *', '* * * * *'],
  // Offsets wrap modulo 2: odd minutes, even minutes, odd, even.
  '2m': ['1-59/2 * * * *', '*/2 * * * *', '1-59/2 * * * *', '*/2 * * * *'],
  '5m': ['1-59/5 * * * *', '2-59/5 * * * *', '3-59/5 * * * *', '4-59/5 * * * *'],
  '10m': ['1-59/10 * * * *', '2-59/10 * * * *', '3-59/10 * * * *', '4-59/10 * * * *'],
};

/** Minutes of the hour a cron's minute field fires on. */
function firingMinutes(cron: string): number[] {
  const f = cron.split(' ')[0];
  const all = Array.from({ length: 60 }, (_, i) => i);
  if (f === '*') return all;
  const step = /^(?:\*|(\d+)-59)\/(\d+)$/.exec(f);
  if (step) {
    const start = Number(step[1] ?? 0);
    const n = Number(step[2]);
    return all.filter((m) => m >= start && (m - start) % n === 0);
  }
  return [Number(f)];
}

describe('offsetCron', () => {
  it('covers every cadence the framework offers', () => {
    expect(CADENCE_OPTIONS.map((o) => o.value).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const { value } of CADENCE_OPTIONS) {
    const base = cadenceToCron(value);
    it(`${value} (${base}) → offsets 1..4`, () => {
      expect([1, 2, 3, 4].map((k) => offsetCron(base, k))).toEqual(EXPECTED[value]);
    });

    it(`${value}: every offset keeps the base cadence's run count`, () => {
      const runs = firingMinutes(base).length;
      for (const k of [1, 2, 3, 4]) {
        expect(firingMinutes(offsetCron(base, k))).toHaveLength(runs);
      }
    });
  }

  it('never turns the 1m cadence into an hourly schedule (regression)', () => {
    for (const k of [1, 2, 3, 4]) expect(offsetCron('* * * * *', k)).toBe('* * * * *');
  });

  it('k = 0 (offset a multiple of the step) leaves */N unchanged', () => {
    expect(offsetCron('*/5 * * * *', 0)).toBe('*/5 * * * *');
    expect(offsetCron('*/5 * * * *', 5)).toBe('*/5 * * * *');
    expect(offsetCron('*/5 * * * *', 7)).toBe('2-59/5 * * * *');
  });

  it('shifts a literal minute modulo 60', () => {
    expect(offsetCron('0 * * * *', 3)).toBe('3 * * * *');
    expect(offsetCron('58 * * * *', 4)).toBe('2 * * * *');
    expect(offsetCron('15 6 * * *', 1)).toBe('16 6 * * *');
  });

  it('leaves shapes it does not understand unchanged', () => {
    for (const c of ['0,30 * * * *', '5-10 * * * *', '1-59/5 * * * *', '* 5 * * *', '']) {
      expect(offsetCron(c, 2)).toBe(c);
    }
  });
});

describe('dependent search crons in the provisioning plan', () => {
  const DEPENDENTS: Array<[string, number]> = [
    ['criblapm__home_alerts', 1],
    ['criblapm__alert_notify', 2],
    ['criblapm__incident_grouper', 3],
    ['criblapm__incidents_state', 4],
  ];

  for (const { value } of CADENCE_OPTIONS) {
    it(`${value}: evaluator/notify/grouper/fold get offsets +1..+4`, () => {
      setSearchCadence(value);
      setServerInvestigations(true); // notify only exists when on
      const byId = new Map(getProvisioningPlan().map((s) => [s.id, s.schedule.cronSchedule]));
      for (const [id, k] of DEPENDENTS) {
        expect(byId.get(id), id).toBe(EXPECTED[value][k - 1]);
      }
      // The panels and the incidents export stay on the base cadence.
      expect(byId.get('criblapm__home_service_summary')).toBe(cadenceToCron(value));
      expect(byId.get('criblapm__incidents_export')).toBe(cadenceToCron(value));
    });
  }

  it('orders dependents strictly after their producer when the cadence has room (5m, 10m)', () => {
    for (const value of ['5m', '10m']) {
      setSearchCadence(value);
      setServerInvestigations(true);
      const byId = new Map(getProvisioningPlan().map((s) => [s.id, s.schedule.cronSchedule]));
      const first = (id: string) => firingMinutes(byId.get(id)!)[0];
      const chain = [
        'criblapm__home_service_summary',
        ...DEPENDENTS.map(([id]) => id),
      ].map(first);
      expect(chain).toEqual([0, 1, 2, 3, 4]);
    }
  });
});
