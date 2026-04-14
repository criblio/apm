/**
 * Settings-page section that reconciles Cribl APM's scheduled
 * saved searches against the workspace. Three states:
 *
 *   idle      — nothing loaded yet; "Preview plan" button visible.
 *   preview   — fetched the plan + diff; shows a list of
 *               Create/Update/Delete/Noop actions. "Apply" button
 *               becomes live.
 *   applying  — reconcile in progress.
 *   results   — each action's ok/error rendered inline.
 *
 * The same component is the skeleton for the §2e first-run
 * provisioning dialog: the preview → apply flow is the thing the
 * user sees once on install, and it lives here permanently for
 * re-provisioning after a dataset change or a pack upgrade.
 *
 * There's also an "Unprovision all" escape hatch for dev / reset
 * scenarios. Requires a confirmation click because it deletes
 * every `criblapm__*` saved search on the workspace.
 */
import { useState } from 'react';
import {
  createBrowserHttpClient,
  planOnly,
  applyProvisioningPlan,
  unprovisionAll,
  type PlanAction,
  type ActionResult,
  type SavedSearchRow,
} from '../api/provisioner';
import type { ProvisionedSearch } from '../api/provisionedSearches';
import s from './ProvisioningPanel.module.css';

type PanelState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | {
      kind: 'preview';
      plan: ProvisionedSearch[];
      current: SavedSearchRow[];
      actions: PlanAction[];
    }
  | {
      kind: 'applying';
      actions: PlanAction[];
    }
  | {
      kind: 'results';
      results: ActionResult[];
    }
  | {
      kind: 'error';
      error: string;
    };

function countByKind(actions: PlanAction[]): Record<PlanAction['kind'], number> {
  const counts: Record<PlanAction['kind'], number> = {
    create: 0,
    update: 0,
    delete: 0,
    noop: 0,
  };
  for (const a of actions) counts[a.kind]++;
  return counts;
}

function actionLabel(action: PlanAction): string {
  switch (action.kind) {
    case 'create':
      return action.want.id;
    case 'update':
      return action.want.id;
    case 'delete':
      return action.current.id;
    case 'noop':
      return action.want.id;
  }
}

export default function ProvisioningPanel() {
  const [state, setState] = useState<PanelState>({ kind: 'idle' });
  const [confirmUnprovision, setConfirmUnprovision] = useState(false);

  async function handlePreview() {
    setState({ kind: 'loading' });
    try {
      const http = createBrowserHttpClient();
      const { plan, current, actions } = await planOnly(http);
      setState({ kind: 'preview', plan, current, actions });
    } catch (err) {
      setState({
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleApply() {
    if (state.kind !== 'preview') return;
    const actions = state.actions;
    setState({ kind: 'applying', actions });
    try {
      const http = createBrowserHttpClient();
      const results = await applyProvisioningPlan(http, actions);
      setState({ kind: 'results', results });
    } catch (err) {
      setState({
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleUnprovision() {
    if (!confirmUnprovision) {
      setConfirmUnprovision(true);
      return;
    }
    setConfirmUnprovision(false);
    setState({ kind: 'loading' });
    try {
      const http = createBrowserHttpClient();
      const results = await unprovisionAll(http);
      setState({ kind: 'results', results });
    } catch (err) {
      setState({
        kind: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return (
    <div className={s.card}>
      <h2 className={s.sectionTitle}>Scheduled searches</h2>
      <p className={s.sectionHelp}>
        Cribl APM caches its expensive panel queries (Home catalog,
        sparklines, slow trace classes, error classes, dependency
        graph, latency baselines) as scheduled Cribl Saved Searches
        that run every few minutes. Pages then read the cached rows
        via <code>$vt_results</code> / lookup joins, which is ~10×
        faster than running the underlying queries live on every
        load. Re-run the preview after changing the{' '}
        <strong>Dataset</strong> or <strong>Noise filters</strong>{' '}
        setting so the cached queries pick up the new values.
      </p>

      {state.kind === 'idle' && (
        <div className={s.actions}>
          <button type="button" className={s.primaryBtn} onClick={handlePreview}>
            Preview plan
          </button>
        </div>
      )}

      {state.kind === 'loading' && (
        <div className={s.statusLine}>Loading plan…</div>
      )}

      {state.kind === 'error' && (
        <>
          <div className={s.errorBox}>
            <strong>Error:</strong> {state.error}
          </div>
          <div className={s.actions}>
            <button
              type="button"
              className={s.secondaryBtn}
              onClick={() => setState({ kind: 'idle' })}
            >
              Dismiss
            </button>
          </div>
        </>
      )}

      {state.kind === 'preview' && <PreviewView state={state} onApply={handleApply} onCancel={() => setState({ kind: 'idle' })} />}

      {state.kind === 'applying' && (
        <div className={s.statusLine}>
          Applying {state.actions.filter((a) => a.kind !== 'noop').length} change(s)…
        </div>
      )}

      {state.kind === 'results' && (
        <ResultsView
          results={state.results}
          onDone={() => setState({ kind: 'idle' })}
        />
      )}

      {/* Danger zone: always visible so it's accessible from any state,
          but gated by a two-click confirmation to make it impossible
          to delete everything by accident. */}
      <div className={s.dangerZone}>
        <div className={s.dangerTitle}>Danger zone</div>
        <p className={s.dangerHelp}>
          Deletes every <code>criblapm__*</code> saved search from the
          workspace. Page loads revert to live queries (slower). Use
          before reinstalling the pack or to fully reset state.
        </p>
        <button
          type="button"
          className={confirmUnprovision ? s.dangerBtnConfirm : s.dangerBtn}
          onClick={handleUnprovision}
        >
          {confirmUnprovision ? 'Click again to confirm' : 'Unprovision all'}
        </button>
        {confirmUnprovision && (
          <button
            type="button"
            className={s.secondaryBtn}
            onClick={() => setConfirmUnprovision(false)}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}

function PreviewView({
  state,
  onApply,
  onCancel,
}: {
  state: { plan: ProvisionedSearch[]; current: SavedSearchRow[]; actions: PlanAction[] };
  onApply: () => void;
  onCancel: () => void;
}) {
  const counts = countByKind(state.actions);
  const hasChanges = counts.create + counts.update + counts.delete > 0;
  return (
    <div>
      <div className={s.summary}>
        <SummaryChip kind="create" count={counts.create} label="Create" />
        <SummaryChip kind="update" count={counts.update} label="Update" />
        <SummaryChip kind="delete" count={counts.delete} label="Delete" />
        <SummaryChip kind="noop" count={counts.noop} label="Unchanged" />
      </div>

      <ul className={s.actionList}>
        {state.actions.map((action) => (
          <li key={actionLabel(action)} className={s.actionRow}>
            <span className={`${s.actionKind} ${s[`actionKind_${action.kind}`]}`}>
              {action.kind}
            </span>
            <span className={s.actionId}>{actionLabel(action)}</span>
          </li>
        ))}
      </ul>

      <div className={s.actions}>
        <button
          type="button"
          className={s.primaryBtn}
          onClick={onApply}
          disabled={!hasChanges}
        >
          {hasChanges ? 'Apply' : 'Nothing to do'}
        </button>
        <button type="button" className={s.secondaryBtn} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function SummaryChip({
  kind,
  count,
  label,
}: {
  kind: PlanAction['kind'];
  count: number;
  label: string;
}) {
  return (
    <span className={`${s.summaryChip} ${s[`summaryChip_${kind}`]}`}>
      <span className={s.summaryCount}>{count}</span>
      <span className={s.summaryLabel}>{label}</span>
    </span>
  );
}

function ResultsView({
  results,
  onDone,
}: {
  results: ActionResult[];
  onDone: () => void;
}) {
  const failures = results.filter((r) => !r.ok);
  const okCount = results.filter((r) => r.ok).length;
  return (
    <div>
      <div className={s.statusLine}>
        {failures.length === 0 ? (
          <>All {okCount} action(s) applied cleanly.</>
        ) : (
          <>
            {okCount} succeeded, <strong className={s.errText}>{failures.length} failed</strong>.
          </>
        )}
      </div>
      <ul className={s.actionList}>
        {results.map((r) => (
          <li key={actionLabel(r.action)} className={s.actionRow}>
            <span
              className={`${s.actionKind} ${
                r.ok ? s.actionKind_noop : s.actionKind_delete
              }`}
            >
              {r.ok ? 'ok' : 'fail'}
            </span>
            <span className={s.actionId}>
              {r.action.kind}: {actionLabel(r.action)}
            </span>
            {r.error && <span className={s.errText}>{r.error}</span>}
          </li>
        ))}
      </ul>
      <div className={s.actions}>
        <button type="button" className={s.primaryBtn} onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}
