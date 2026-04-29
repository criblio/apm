/**
 * APM-specific binding for the framework provisioner.
 *
 * The reconciliation logic itself lives in @cribl/app-utils. This
 * module supplies APM's prefix, plan, and lookup seeds, and exposes
 * thin wrappers that callers can invoke without repeating config.
 */
import {
  reconcile as fwReconcile,
  planOnly as fwPlanOnly,
  unprovisionAll as fwUnprovisionAll,
  type HttpClient,
  type ProvisionerConfig,
} from '@cribl/app-utils/provisioner';
import {
  CRIBLAPM_PREFIX,
  SEED_LOOKUPS,
  getProvisioningPlan,
} from './provisionedSearches';

const CONFIG: ProvisionerConfig = {
  prefix: CRIBLAPM_PREFIX,
  plan: getProvisioningPlan,
  seedLookups: SEED_LOOKUPS,
};

export const reconcile = (http: HttpClient) => fwReconcile(http, CONFIG);
export const planOnly = (http: HttpClient) => fwPlanOnly(http, CONFIG);
export const unprovisionAll = (http: HttpClient) =>
  fwUnprovisionAll(http, CRIBLAPM_PREFIX);

export {
  applyProvisioningPlan,
  createBrowserHttpClient,
} from '@cribl/app-utils/provisioner';
export type {
  HttpClient,
  PlanAction,
  ActionResult,
  SavedSearchRow,
  ProvisionedSearch,
} from '@cribl/app-utils/provisioner';
