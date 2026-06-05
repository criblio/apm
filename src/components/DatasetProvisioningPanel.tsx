/**
 * Settings UI for the dataset acceleration provisioner.
 *
 * Mirrors the visual shape of the shared @cribl/app-utils
 * ProvisioningPanel (used for saved searches) but reconciles a
 * different set of resources: the otel dataset's `dataset-ruleset`
 * extend expression that flattens service_name / status_code, and
 * the `acceleratedFields` array on the dataset itself. See
 * src/api/datasetProvisioner.ts for the API-side logic.
 *
 * Behavior:
 *   - On mount, reads current status (no writes).
 *   - Shows ✓ / ✗ per piece with the reason inline.
 *   - "Apply" button is enabled when at least one piece is out of
 *     date; running it PATCHes the missing/drifted state.
 *   - Re-reads status after apply so the UI updates without a
 *     page reload.
 *   - Resets the feature-detect cache after apply so the query
 *     builders pick up the new state on the next call.
 */
import { useCallback, useEffect, useState } from 'react';
import { createBrowserHttpClient } from '@cribl/app-utils/provisioner';
import {
  apply as applyDatasetProvisioning,
  getStatus as getDatasetStatus,
  EXPECTED_ACCELERATED_FIELDS,
  type ApplyResult,
  type DatasetProvisioningStatus,
} from '../api/datasetProvisioner';
import { resetFlatFieldsCache } from '../api/featureDetect';
import s from './DatasetProvisioningPanel.module.css';

export default function DatasetProvisioningPanel() {
  const [status, setStatus] = useState<DatasetProvisioningStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ApplyResult | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const http = createBrowserHttpClient();
      setStatus(await getDatasetStatus(http));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allOk = !!(status?.ruleset.ok && status?.acceleratedFields.ok);
  const canApply = !loading && !applying && status != null && !allOk;

  const onApply = useCallback(async () => {
    setApplying(true);
    setError(null);
    setLastResult(null);
    try {
      const http = createBrowserHttpClient();
      const result = await applyDatasetProvisioning(http);
      setLastResult(result);
      // Re-read status so the UI reflects what's now on the server,
      // and clear the feature-detect cache so the next query in
      // the session picks the flat path.
      resetFlatFieldsCache();
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApplying(false);
    }
  }, [refresh]);

  return (
    <div className={s.panel}>
      <div className={s.header}>
        <h2 className={s.title}>Dataset acceleration</h2>
        <p className={s.subtitle}>
          Cribl Lakehouse can accelerate filters and group-bys when
          the indexed fields are top-level columns. The dataset
          provisioner installs a ruleset that flattens{' '}
          <code>resource.attributes['service.name']</code> →{' '}
          <code>service_name</code> and <code>status.code</code> →{' '}
          <code>status_code</code> on ingest, then declares the five
          fields APM queries hit most as accelerated. Net effect on
          staging is roughly 1.5–2.3× faster queries on the hot path
          (Service Detail, alerts, panel cache refreshes).
        </p>
      </div>

      {loading && <div className={s.status}>Checking current state…</div>}

      {!loading && status && (
        <div className={s.statusList}>
          <StatusRow
            label="Dataset-ruleset extend expression"
            ok={status.ruleset.ok}
            detail={describeRulesetState(status)}
          />
          <StatusRow
            label="Accelerated fields"
            ok={status.acceleratedFields.ok}
            detail={describeAcceleratedFieldsState(status)}
          />
        </div>
      )}

      {error && (
        <div className={s.error}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {lastResult && !error && (
        <div className={s.result}>
          <strong>Applied:</strong>
          <ul>
            <li>Ruleset: {describeApplyAction(lastResult.ruleset.action)}</li>
            <li>
              Accelerated fields:{' '}
              {describeApplyAction(lastResult.acceleratedFields.action)}
              {lastResult.acceleratedFields.added.length > 0 && (
                <> (added: <code>{lastResult.acceleratedFields.added.join(', ')}</code>)</>
              )}
            </li>
          </ul>
        </div>
      )}

      <div className={s.actions}>
        <button
          type="button"
          className={s.applyButton}
          onClick={() => void onApply()}
          disabled={!canApply}
        >
          {applying ? 'Applying…' : 'Provision dataset'}
        </button>
        {allOk && !applying && (
          <span className={s.allOk}>All set — no changes needed.</span>
        )}
      </div>
    </div>
  );
}

interface StatusRowProps {
  label: string;
  ok: boolean;
  detail: string;
}
function StatusRow({ label, ok, detail }: StatusRowProps) {
  return (
    <div className={`${s.row} ${ok ? s.rowOk : s.rowMissing}`}>
      <span className={s.rowIcon} aria-hidden>
        {ok ? '✓' : '✗'}
      </span>
      <div className={s.rowMain}>
        <div className={s.rowLabel}>{label}</div>
        <div className={s.rowDetail}>{detail}</div>
      </div>
    </div>
  );
}

function describeRulesetState(status: DatasetProvisioningStatus): string {
  const r = status.ruleset;
  if (r.ok) return 'Configured.';
  switch (r.reason) {
    case 'missing-rule':
      return 'Rule "opentelemetry_demo" not present in the default ruleset.';
    case 'invalid':
      return 'Rule present but missing the service_name / status_code extend expression.';
    case 'fetch-failed':
      return 'Could not read current state from the Cribl API.';
    default:
      return 'Not configured.';
  }
}

function describeAcceleratedFieldsState(
  status: DatasetProvisioningStatus,
): string {
  const f = status.acceleratedFields;
  if (f.ok) {
    return `All ${EXPECTED_ACCELERATED_FIELDS.length} fields accelerated.`;
  }
  if (f.reason === 'fetch-failed') {
    return 'Could not read current state from the Cribl API.';
  }
  return `${f.missing.length} of ${EXPECTED_ACCELERATED_FIELDS.length} fields missing: ${f.missing.join(', ')}.`;
}

function describeApplyAction(action: 'noop' | 'create' | 'update'): string {
  switch (action) {
    case 'noop':
      return 'no change needed';
    case 'create':
      return 'created';
    case 'update':
      return 'updated';
  }
}
