/**
 * Dataset-level provisioner for the `otel` dataset's two
 * acceleration prerequisites:
 *
 *   1. A `dataset-rulesets/default` rule named `opentelemetry_demo`
 *      that adds an `extendExpression` flattening
 *      `resource.attributes['service.name']` → top-level
 *      `service_name`, and `status.code` → top-level `status_code`.
 *      Without this rule, the data lands in the dataset with only
 *      the nested forms — every query has to deserialize the
 *      whole record to evaluate predicates.
 *
 *   2. An `acceleratedFields` array on the dataset itself
 *      configuring the five fields that drive ~every query
 *      (service_name, status_code, kind, name, parent_span_id).
 *      Cribl Lakehouse Indexed Fields hoist those columns to
 *      top-level so filter/group-by pushdown can fire.
 *
 * Both pieces are idempotent. The reconcile API reads current
 * state, diffs against expected, and only PATCHes when something
 * has drifted. Re-runs are noops.
 *
 * Used by:
 *   - The Settings page "Dataset acceleration" panel (apply on
 *     button click).
 *   - `scripts/provision.ts` (apply during `npm run deploy`).
 *   - Boot-time banner-detection logic in App.tsx (status only,
 *     no apply — shows a persistent banner pointing the user at
 *     Settings when not configured).
 */
import type { HttpClient } from '@cribl/app-utils/provisioner';

// ────────────────────────────────────────────────────────────────
// Expected state
// ────────────────────────────────────────────────────────────────

export const DATASET_ID = 'otel';
export const RULESET_PATH =
  '/m/default_search/search/local_search/dataset-rulesets/default';
export const DATASET_PATH = `/m/default_search/search/datasets/${DATASET_ID}`;

/** The rule id the app expects in the default ruleset. Used for
 * matching against current state — don't change without a
 * migration plan because users may have edited the rule body. */
export const EXPECTED_RULE_ID = 'opentelemetry_demo';

/** The expected extend expression. We match meaningfully (presence
 * of both flattening assignments) rather than literal-equality, so
 * users can add their own assignments to the rule without our
 * reconciler reverting them. */
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

/** The five fields the app expects accelerated on the dataset.
 * Order doesn't matter on the server side; this is just the set
 * we want present. We never remove fields — users may have added
 * their own. */
export const EXPECTED_ACCELERATED_FIELDS: readonly string[] = [
  'service_name',
  'status_code',
  'kind',
  'name',
  'parent_span_id',
] as const;

// ────────────────────────────────────────────────────────────────
// Wire types — what the Cribl API returns
// ────────────────────────────────────────────────────────────────

export interface DatasetRule {
  id: string;
  name?: string;
  description?: string;
  sendDataTo: string;
  dataset: string;
  kustoExpression: string;
  extendExpressionEnabled?: boolean;
  extendExpression?: string;
  disabled?: boolean;
}

interface RulesetObject {
  id: string;
  rules: DatasetRule[];
}

interface RulesetResponse {
  items?: RulesetObject[];
}

interface AcceleratedField {
  id: string;
  createdAt?: number;
}

interface DatasetObject {
  id: string;
  acceleratedFields?: AcceleratedField[];
  /** Cribl returns the full dataset config; we don't need to model
   * everything, but we PATCH with only the field we want to
   * change, leaving the rest alone. */
  [key: string]: unknown;
}

interface DatasetResponse {
  items?: DatasetObject[];
}

// ────────────────────────────────────────────────────────────────
// Status check (no writes)
// ────────────────────────────────────────────────────────────────

export interface DatasetProvisioningStatus {
  ruleset: {
    /** Present and looks correct. */
    ok: boolean;
    /** Why it's not ok (UI display). */
    reason?: 'missing-rule' | 'missing-extend-expression' | 'fetch-failed';
  };
  acceleratedFields: {
    ok: boolean;
    /** Field names we expect but don't see on the dataset. */
    missing: string[];
    reason?: 'fetch-failed';
  };
}

/**
 * Read both pieces of state and report whether each is configured
 * as the app expects. Never throws — fetch failures degrade to
 * `ok: false` with a reason. The banner and the Settings panel
 * both call this.
 */
export async function getStatus(
  http: HttpClient,
): Promise<DatasetProvisioningStatus> {
  const status: DatasetProvisioningStatus = {
    ruleset: { ok: false },
    acceleratedFields: { ok: false, missing: [] },
  };

  // Ruleset check
  try {
    const resp = (await http.get(RULESET_PATH)) as RulesetResponse;
    const ruleset = resp?.items?.[0];
    const rules = ruleset?.rules ?? [];
    const rule = rules.find((r) => r.id === EXPECTED_RULE_ID);
    if (!rule) {
      status.ruleset = { ok: false, reason: 'missing-rule' };
    } else if (!hasFlatteningAssignments(rule.extendExpression)) {
      status.ruleset = { ok: false, reason: 'missing-extend-expression' };
    } else {
      status.ruleset = { ok: true };
    }
  } catch {
    status.ruleset = { ok: false, reason: 'fetch-failed' };
  }

  // AcceleratedFields check
  try {
    const resp = (await http.get(DATASET_PATH)) as DatasetResponse;
    const dataset = resp?.items?.[0];
    const present = new Set(
      (dataset?.acceleratedFields ?? []).map((f) => f.id),
    );
    const missing = EXPECTED_ACCELERATED_FIELDS.filter(
      (f) => !present.has(f),
    );
    status.acceleratedFields = { ok: missing.length === 0, missing };
  } catch {
    status.acceleratedFields = {
      ok: false,
      missing: [...EXPECTED_ACCELERATED_FIELDS],
      reason: 'fetch-failed',
    };
  }

  return status;
}

/**
 * Loose match against the rule's extend expression. Both
 * `service_name=` and `status_code=` assignments must be present
 * somewhere in the expression. Whitespace and exact RHS don't
 * matter — users may have customized the expression and we don't
 * want the reconciler reverting their tweaks.
 */
function hasFlatteningAssignments(extendExpression?: string): boolean {
  if (!extendExpression) return false;
  const normalized = extendExpression.replace(/\s+/g, '');
  return (
    normalized.includes('service_name=') &&
    normalized.includes('status_code=')
  );
}

// ────────────────────────────────────────────────────────────────
// Apply (writes; idempotent)
// ────────────────────────────────────────────────────────────────

export type ActionKind = 'noop' | 'create' | 'update';

export interface ApplyResult {
  ruleset: { action: ActionKind; reason?: string };
  acceleratedFields: { action: ActionKind; added: string[]; reason?: string };
}

/**
 * Reconcile both pieces against the expected state. Idempotent —
 * already-configured installs return all-noops. Throws only when
 * the underlying HTTP fails after we attempted the change; status
 * fetch failures are surfaced as the action 'noop' with a reason.
 */
export async function apply(http: HttpClient): Promise<ApplyResult> {
  const result: ApplyResult = {
    ruleset: { action: 'noop' },
    acceleratedFields: { action: 'noop', added: [] },
  };

  // ── Ruleset reconcile ──
  let currentRuleset: RulesetObject | undefined;
  try {
    const resp = (await http.get(RULESET_PATH)) as RulesetResponse;
    currentRuleset = resp?.items?.[0];
  } catch (err) {
    result.ruleset = {
      action: 'noop',
      reason: `fetch failed: ${(err as Error).message}`,
    };
  }

  if (currentRuleset) {
    const rules = currentRuleset.rules ?? [];
    const idx = rules.findIndex((r) => r.id === EXPECTED_RULE_ID);
    let nextRules = rules;
    let action: ActionKind = 'noop';
    if (idx < 0) {
      // Insert before the default catch-all so our rule matches
      // first (catch-all has id 'default' and should remain last).
      const insertAt = rules.findIndex((r) => r.id === 'default');
      const at = insertAt < 0 ? rules.length : insertAt;
      nextRules = [...rules.slice(0, at), EXPECTED_RULE, ...rules.slice(at)];
      action = 'create';
    } else if (!hasFlatteningAssignments(rules[idx].extendExpression)) {
      nextRules = [
        ...rules.slice(0, idx),
        { ...rules[idx], ...EXPECTED_RULE },
        ...rules.slice(idx + 1),
      ];
      action = 'update';
    }
    if (action !== 'noop') {
      await http.patch(RULESET_PATH, {
        id: currentRuleset.id,
        rules: nextRules,
      });
    }
    result.ruleset = { action };
  }

  // ── AcceleratedFields reconcile ──
  let currentDataset: DatasetObject | undefined;
  try {
    const resp = (await http.get(DATASET_PATH)) as DatasetResponse;
    currentDataset = resp?.items?.[0];
  } catch (err) {
    result.acceleratedFields = {
      action: 'noop',
      added: [],
      reason: `fetch failed: ${(err as Error).message}`,
    };
  }

  if (currentDataset) {
    const present = new Set(
      (currentDataset.acceleratedFields ?? []).map((f) => f.id),
    );
    const missing = EXPECTED_ACCELERATED_FIELDS.filter((f) => !present.has(f));
    if (missing.length === 0) {
      result.acceleratedFields = { action: 'noop', added: [] };
    } else {
      const nextFields: AcceleratedField[] = [
        ...(currentDataset.acceleratedFields ?? []),
        ...missing.map((id) => ({ id })),
      ];
      // PATCH only the field we're changing. Cribl's PATCH merges
      // at the top level — sending just `{ acceleratedFields }`
      // leaves the rest of the dataset config untouched.
      await http.patch(DATASET_PATH, {
        acceleratedFields: nextFields,
      });
      result.acceleratedFields = {
        action: present.size === 0 ? 'create' : 'update',
        added: missing,
      };
    }
  }

  return result;
}
