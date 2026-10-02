/**
 * The framework plan guard over APM's REAL provisioning plan.
 *
 * `validateProvisionerPlan(APM_PROVISIONER_CONFIG)` is exactly what
 * `reconcile()`, `planOnly()` and the Settings panel's Apply run before
 * writing anything, so a plan that fails here would be refused on every
 * apply path. Running it in CI at every cadence × flag combination puts
 * the failure in a PR instead of in a user's browser at provision time
 * (v0.10.0 shipped two names Cribl 400s on; June 2026 shipped
 * `dataset=""` into 17 searches).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import {
  CADENCE_OPTIONS,
  DEFAULT_CADENCE,
  setSearchCadence,
} from '@criblio/app-utils/cadence';
import {
  applyProvisioningActions,
  type HttpClient,
} from '@criblio/app-utils/provisioner';
import { ProvisionPlanError } from '@criblio/app-utils/provision-guard';
import { APM_PROVISIONER_CONFIG, validateProvisionerPlan } from '../provisioner';
import { getProvisioningPlan } from '../provisionedSearches';
import { setServerInvestigations } from '../serverInvestigations';
import { setMetricsEmit } from '../metricsEmit';
import { setLowVolumeMode } from '../lowVolumeMode';

setCurrentDataset('otel');

afterEach(() => {
  setCurrentDataset('otel');
  setSearchCadence(DEFAULT_CADENCE);
  setServerInvestigations(false);
  setMetricsEmit(false);
  setLowVolumeMode(false);
});

const BOOLS = [false, true] as const;

describe('APM provisioning plan passes the framework guard', () => {
  for (const { value: cadence } of CADENCE_OPTIONS) {
    for (const serverInvestigations of BOOLS) {
      for (const metricsEmit of BOOLS) {
        for (const lowVolume of BOOLS) {
          const label = `cadence=${cadence} serverInvestigations=${serverInvestigations} metricsEmit=${metricsEmit} lowVolume=${lowVolume}`;
          it(label, () => {
            setSearchCadence(cadence);
            setServerInvestigations(serverInvestigations);
            setMetricsEmit(metricsEmit);
            setLowVolumeMode(lowVolume);
            expect(validateProvisionerPlan(APM_PROVISIONER_CONFIG).problems).toEqual([]);
          });
        }
      }
    }
  }

  it('refuses to build the plan at all when the dataset store is empty', () => {
    setCurrentDataset('');
    expect(() => getProvisioningPlan()).toThrow('dataset ID');
  });
});

describe('the guard is on for APM (not disabled by config)', () => {
  const bad = () => [
    { ...getProvisioningPlan()[0], query: 'dataset="" | limit 1' },
    { ...getProvisioningPlan()[1], name: 'Cribl APM - deploy/change (bad)' },
  ];

  it('flags a dataset="" search and a name Cribl 400s on', () => {
    const { ok, problems } = validateProvisionerPlan({ ...APM_PROVISIONER_CONFIG, plan: bad });
    expect(ok).toBe(false);
    expect(problems.map((p) => p.rule).sort()).toEqual(['dataset-empty', 'invalid-name']);
  });

  it('the Apply path (applyProvisioningActions, used by the Settings panel) refuses before writing', async () => {
    const writes: string[] = [];
    const http: HttpClient = {
      get: async () => ({ items: [], count: 0 }),
      post: async (p) => void writes.push(`POST ${p}`),
      patch: async (p) => void writes.push(`PATCH ${p}`),
      del: async (p) => void writes.push(`DELETE ${p}`),
    };
    const actions = bad().map((want) => ({ kind: 'create' as const, want }));
    await expect(applyProvisioningActions(http, APM_PROVISIONER_CONFIG, actions)).rejects.toBeInstanceOf(
      ProvisionPlanError,
    );
    expect(writes).toEqual([]);
  });
});
