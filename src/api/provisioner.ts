/**
 * APM-specific binding for the framework provisioner.
 *
 * The reconciliation logic itself lives in @criblio/app-utils. This
 * module supplies APM's prefix, plan, and lookup seeds as ONE config
 * object that the CLI (`scripts/provision.ts`), the Settings
 * `<ProvisioningPanel>` and the plan-guard CI test all share.
 *
 * The plan guard is the framework's (`@criblio/app-utils/provision-guard`),
 * on by default on every apply path: `reconcile()`, `planOnly()` and the
 * panel's Apply (`applyProvisioningActions`) all refuse a bad plan with a
 * `ProvisionPlanError` before anything is written. APM has no rules beyond
 * the built-ins (dataset-missing/-empty, `(?i)` or mv-expand before an
 * export, overwrite without a leading sentinel, empty lookup name, invalid
 * name, duplicate id, id prefix), so there is no `validate`.
 */
import {
  reconcile as fwReconcile,
  planOnly as fwPlanOnly,
  unprovisionAll as fwUnprovisionAll,
  type HttpClient,
  type ProvisionerConfig,
} from '@criblio/app-utils/provisioner';
import {
  CRIBLAPM_PREFIX,
  SEED_LOOKUPS,
  getProvisioningPlan,
} from './provisionedSearches';

export const APM_PROVISIONER_CONFIG: ProvisionerConfig = {
  prefix: CRIBLAPM_PREFIX,
  plan: getProvisioningPlan,
  seedLookups: SEED_LOOKUPS,
};

export const reconcile = (http: HttpClient) => fwReconcile(http, APM_PROVISIONER_CONFIG);
export const planOnly = (http: HttpClient) => fwPlanOnly(http, APM_PROVISIONER_CONFIG);
export const unprovisionAll = (http: HttpClient) =>
  fwUnprovisionAll(http, CRIBLAPM_PREFIX);

export {
  applyProvisioningPlan,
  createBrowserHttpClient,
  validateProvisionerPlan,
} from '@criblio/app-utils/provisioner';
export type {
  HttpClient,
  PlanAction,
  ActionResult,
  SavedSearchRow,
  ProvisionedSearch,
} from '@criblio/app-utils/provisioner';
