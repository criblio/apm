/**
 * APM-specific dataset reconciliation. Defines what the app
 * expects on the `otel` dataset and delegates the read/diff/patch
 * shape to @cribl/app-utils.
 *
 * Two pieces:
 *
 *   1. A `dataset-rulesets/default` rule named `opentelemetry_demo`
 *      that adds an `extendExpression` flattening
 *      `resource.attributes['service.name']` → top-level
 *      `service_name` and `status.code` → top-level `status_code`.
 *
 *   2. An `acceleratedFields` array on the dataset itself listing
 *      the five fields that drive ~every query.
 *
 * Both pieces are idempotent — re-runs are noops.
 *
 * Used by:
 *   - Settings page "Dataset acceleration" panel (apply on click).
 *   - `scripts/provision.ts` (apply during `npm run deploy`).
 *   - Boot-time banner-detection logic (status only).
 */
import {
  datasetPath,
  rulesetPath,
  getAcceleratedFieldsStatus,
  getRulesetRuleStatus,
  ensureAcceleratedFields,
  ensureRulesetRule,
  type AcceleratedFieldsStatus,
  type AcceleratedFieldsResult,
  type DatasetRule,
  type RulesetRuleStatus,
  type RulesetRuleResult,
} from '@cribl/app-utils/dataset-provisioner';
import type { HttpClient } from '@cribl/app-utils/provisioner';

// ────────────────────────────────────────────────────────────────
// Expected state — APM/otel specifics
// ────────────────────────────────────────────────────────────────

export const DATASET_ID = 'otel';
export const RULESET_PATH = rulesetPath();
export const DATASET_PATH = datasetPath(DATASET_ID);

/** The rule id the app expects in the default ruleset. */
export const EXPECTED_RULE_ID = 'opentelemetry_demo';

export const EXPECTED_RULE: DatasetRule = {
  id: EXPECTED_RULE_ID,
  name: 'opentelemetry_demo',
  sendDataTo: 'destinationDataset',
  dataset: DATASET_ID,
  kustoExpression: '__inputId="open_telemetry:opentelemetry-demo"',
  extendExpressionEnabled: true,
  extendExpression:
    'service_name=coalesce(resource.attributes["service.name"], service.name),' +
    'status_code=status.code',
};

export const EXPECTED_ACCELERATED_FIELDS: readonly string[] = [
  'service_name',
  'status_code',
  'kind',
  'name',
  'parent_span_id',
] as const;

/**
 * Loose match against the rule's extend expression. Both
 * `service_name=` and `status_code=` assignments must be present
 * somewhere in the expression. Whitespace and exact RHS don't
 * matter — users may have customized the expression and we don't
 * want the reconciler reverting their tweaks.
 */
function hasFlatteningAssignments(rule: DatasetRule): boolean {
  const expr = rule.extendExpression;
  if (!expr) return false;
  const normalized = expr.replace(/\s+/g, '');
  return (
    normalized.includes('service_name=') &&
    normalized.includes('status_code=')
  );
}

// ────────────────────────────────────────────────────────────────
// Status (no writes)
// ────────────────────────────────────────────────────────────────

export interface DatasetProvisioningStatus {
  ruleset: RulesetRuleStatus;
  acceleratedFields: AcceleratedFieldsStatus;
}

export async function getStatus(
  http: HttpClient,
): Promise<DatasetProvisioningStatus> {
  const [ruleset, acceleratedFields] = await Promise.all([
    getRulesetRuleStatus(http, RULESET_PATH, EXPECTED_RULE_ID, hasFlatteningAssignments),
    getAcceleratedFieldsStatus(http, DATASET_PATH, EXPECTED_ACCELERATED_FIELDS),
  ]);
  return { ruleset, acceleratedFields };
}

// ────────────────────────────────────────────────────────────────
// Apply (writes; idempotent)
// ────────────────────────────────────────────────────────────────

export interface ApplyResult {
  ruleset: RulesetRuleResult;
  acceleratedFields: AcceleratedFieldsResult;
}

export async function apply(http: HttpClient): Promise<ApplyResult> {
  const [ruleset, acceleratedFields] = await Promise.all([
    ensureRulesetRule(http, RULESET_PATH, EXPECTED_RULE, {
      validate: hasFlatteningAssignments,
    }),
    ensureAcceleratedFields(http, DATASET_PATH, EXPECTED_ACCELERATED_FIELDS),
  ]);
  return { ruleset, acceleratedFields };
}
