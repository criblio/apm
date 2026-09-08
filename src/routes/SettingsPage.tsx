import { useCallback, useEffect, useState } from 'react';
import StatusBanner from '../components/StatusBanner';
import ProvisioningPanel from '@criblio/app-utils/provisioning-panel';
import DatasetProvisioningPanel from '../components/DatasetProvisioningPanel';
import MetricsBackfillPanel from '../components/MetricsBackfillPanel';
import SettingsSetupStatus from './SettingsSetupStatus';
import SettingsNav, { type NavGroup } from './SettingsNav';
import { loadAppSettings, saveAppSettings } from '../api/appSettings';
import { setCurrentDataset, useDataset } from '@criblio/app-utils/dataset';
import { setStreamFilterEnabled } from '../api/streamFilter';
import { setLowVolumeMode } from '../api/lowVolumeMode';
import { setSearchCadence, CADENCE_OPTIONS, type CadenceOption } from '@criblio/app-utils/cadence';
import {
  CRIBLAPM_PREFIX,
  SEED_LOOKUPS,
  getProvisioningPlan,
} from '../api/provisionedSearches';
import { DEFAULT_FILTER_RULES } from '../api/errorFilter';
import { listTraceOriginators, type TraceOriginatorRow } from '../api/search';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
import { useLowVolumeMode } from '../hooks/useLowVolumeMode';
import { useServerInvestigations } from '../hooks/useServerInvestigations';
import { setServerInvestigations, getServerInvestigations } from '../api/serverInvestigations';
import {
  getCellBaseUrl,
  pushCellRepos,
  SHARED_GOATTOWN_BASE_URL,
} from '../api/investigationTransport';
import { kvGet, kvPut } from '../api/kvstore';
import {
  ensureCellWebhookTarget,
  ensureAlertNotification,
  removeAlertNotification,
} from '../api/cellProvisioning';
import { stageApmInvestigatorConfiguration } from '../api/goatTownProvisioning';
import type { HttpClient } from '../api/provisioner';
import type { SourceRepo } from '../api/investigationTransport';
import type { ProvisioningExtraStep } from '@criblio/app-utils/provisioning-panel';
import { useSearchCadence } from '../hooks/useSearchCadence';
import s from './SettingsPage.module.css';

/**
 * Common Cribl Cloud dataset names surfaced as quick-pick suggestions.
 * These are the dataset IDs that ship with a typical Cribl deployment.
 * Users can still type any dataset name — the list is just a shortcut.
 */
const DATASET_SUGGESTIONS = [
  'otel',
  'main',
  'default_events',
  'default_logs',
  'default_metrics',
  'default_spans',
  'cribl_logs',
  'cribl_metrics',
];

const DATASET_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

export default function SettingsPage() {
  const currentDataset = useDataset();
  const currentStreamFilter = useStreamFilterEnabled();
  const currentLowVolume = useLowVolumeMode();
  const currentCadence = useSearchCadence();
  const [draft, setDraft] = useState<string>(currentDataset);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamFilterSaving, setStreamFilterSaving] = useState(false);
  const [lowVolumeSaving, setLowVolumeSaving] = useState(false);
  const currentServerInvestigations = useServerInvestigations();
  const [serverInvestigationsSaving, setServerInvestigationsSaving] = useState(false);
  const [cellToken, setCellToken] = useState('');
  const [cellTokenConfigured, setCellTokenConfigured] = useState(false);
  const [cellTokenSaving, setCellTokenSaving] = useState(false);
  const [cellWebhookBearer, setCellWebhookBearer] = useState('');
  const [cellWebhookBearerSaving, setCellWebhookBearerSaving] = useState(false);
  const [goatTownConfigurationStaging, setGoatTownConfigurationStaging] = useState(false);
  const [sourceRepos, setSourceRepos] = useState<SourceRepo[]>([]);
  const [sourceReposSaving, setSourceReposSaving] = useState(false);
  const [cadenceSaving, setCadenceSaving] = useState(false);
  const [disabledRules, setDisabledRules] = useState<Record<string, boolean>>({});
  const [rulesSaving, setRulesSaving] = useState(false);
  const [originators, setOriginators] = useState<TraceOriginatorRow[]>([]);
  const [originatorsLoading, setOriginatorsLoading] = useState(true);
  const [originatorsOpen, setOriginatorsOpen] = useState(false);

  // Load persisted settings and diagnostic context on mount.
  useEffect(() => {
    loadAppSettings().then((s) => {
      if (s?.disabledFilterRules) {
        setDisabledRules(s.disabledFilterRules);
      }
      if (s?.lowVolumeMode === true) {
        setLowVolumeMode(true);
      }
      if (typeof s?.serverInvestigations === 'boolean') {
        setServerInvestigations(s.serverInvestigations);
      }
      if (Array.isArray(s?.sourceRepos)) {
        setSourceRepos(s.sourceRepos as SourceRepo[]);
      }
    }).catch(() => {});
    // Installation tokens are write-only. The sentinel only controls UI state;
    // proxies.yml reads the secret directly from `kv.sharedCellToken`.
    kvGet<string>('sharedCellTokenSet')
      .then((value) => setCellTokenConfigured(value === 'true'))
      .catch(() => {});
    // The installation webhook token is stored separately from the UI token
    // so browser provisioning can create the Cribl notification target.
    kvGet<string>('goatTownWebhookToken')
      .then((t) => { if (typeof t === 'string') setCellWebhookBearer(t); })
      .catch(() => {});
    listTraceOriginators()
      .then(setOriginators)
      .catch(() => setOriginators([]))
      .finally(() => setOriginatorsLoading(false));
  }, []);

  const handleRuleToggle = useCallback(async (ruleId: string, disabled: boolean) => {
    const next = { ...disabledRules, [ruleId]: disabled };
    // Drop falsy entries so the stored map stays minimal.
    if (!disabled) delete next[ruleId];
    setDisabledRules(next);
    setRulesSaving(true);
    try {
      await saveAppSettings({ disabledFilterRules: next });
      setFlash(`Filter rule ${disabled ? 'disabled' : 'enabled'}. Reload Home to see the change; alerts/metrics need a redeploy.`);
      setTimeout(() => setFlash(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRulesSaving(false);
    }
  }, [disabledRules]);

  // Sync draft when the current dataset updates externally (e.g. first
  // KV load finishes after page mount).
  useEffect(() => {
    setDraft(currentDataset);
  }, [currentDataset]);

  const trimmed = draft.trim();
  const dirty = trimmed !== currentDataset;
  const valid = trimmed.length > 0 && DATASET_NAME_PATTERN.test(trimmed);

  async function handleSave() {
    if (!valid || saving) return;
    setSaving(true);
    setError(null);
    setFlash(null);
    try {
      // Apply locally first so the UI updates immediately; persist in the
      // background. If the PUT fails, surface the error and roll back
      // the in-memory change to what was last loaded.
      setCurrentDataset(trimmed);
      await saveAppSettings({ dataset: trimmed });
      setFlash(`Saved. Queries now target "${trimmed}".`);
      setTimeout(() => setFlash(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Roll back: reset the draft to the previous current value and
      // re-apply that through the module so all listeners re-sync.
      setCurrentDataset(currentDataset);
      setDraft(currentDataset);
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setDraft(currentDataset);
    setError(null);
    setFlash(null);
  }

  async function handleLowVolumeToggle(next: boolean) {
    if (lowVolumeSaving) return;
    setLowVolumeSaving(true);
    setError(null);
    try {
      setLowVolumeMode(next);
      await saveAppSettings({ lowVolumeMode: next });
      setFlash(`Low-volume mode ${next ? 'on' : 'off'}. Re-provision below to apply the new alert thresholds.`);
      setTimeout(() => setFlash(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setLowVolumeMode(!next);
    } finally {
      setLowVolumeSaving(false);
    }
  }

  async function handleServerInvestigationsToggle(next: boolean) {
    if (serverInvestigationsSaving) return;
    setServerInvestigationsSaving(true);
    setError(null);
    try {
      setServerInvestigations(next);
      await saveAppSettings({ serverInvestigations: next });
      setFlash(
        next
          ? 'Server-side investigations on. Re-provision below to create the alert trigger.'
          : 'Server-side investigations off. Re-provision below to remove the alert trigger and stop new runs.',
      );
      setTimeout(() => setFlash(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setServerInvestigations(!next);
    } finally {
      setServerInvestigationsSaving(false);
    }
  }

  async function handleSaveCellToken() {
    if (cellTokenSaving) return;
    const token = cellToken.trim();
    if (!token.startsWith('gt_i1_')) {
      setError('Enter the installation UI token issued by shared GoatTown.');
      return;
    }
    setCellTokenSaving(true);
    setError(null);
    try {
      await kvPut('sharedCellToken', token);
      await kvPut('sharedCellTokenSet', 'true');
      setCellToken('');
      setCellTokenConfigured(true);
      setFlash('Shared GoatTown installation token saved.');
      setTimeout(() => setFlash(null), 8000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCellTokenSaving(false);
    }
  }

  async function handleSaveCellWebhookBearer() {
    if (cellWebhookBearerSaving) return;
    const token = cellWebhookBearer.trim();
    if (!token.startsWith('gt_w1_')) {
      setError('Enter the installation webhook token issued by shared GoatTown.');
      return;
    }
    setCellWebhookBearerSaving(true);
    setError(null);
    try {
      await kvPut('goatTownWebhookToken', token);
      setCellWebhookBearer(token);
      setFlash('Shared GoatTown webhook token saved. Re-run Provision to update the alert target.');
      setTimeout(() => setFlash(null), 8000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCellWebhookBearerSaving(false);
    }
  }

  function updateRepo(i: number, patch: Partial<SourceRepo>) {
    setSourceRepos((prev) => prev.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRepo() {
    setSourceRepos((prev) => [...prev, { url: '', service: '*' }]);
  }
  function removeRepo(i: number) {
    setSourceRepos((prev) => prev.filter((_, idx) => idx !== i));
  }
  async function handleSaveSourceRepos() {
    if (sourceReposSaving) return;
    setSourceReposSaving(true);
    setError(null);
    try {
      // Drop empty rows and trim; `service` empty ⇒ omit (monorepo
      // catch-all); `ref` empty ⇒ omit (checkout uses the default branch).
      const cleaned = sourceRepos
        .map((r) => ({
          url: r.url.trim(),
          name: r.name?.trim() || undefined,
          service: r.service?.trim() || undefined,
          ref: r.ref?.trim() || undefined,
        }))
        .filter((r) => r.url);
      await saveAppSettings({ sourceRepos: cleaned });
      setSourceRepos(cleaned);
      // Push the list to the cell so alert-fired (autonomous)
      // investigations get the same repos — interactive ones already
      // thread them at create time. Best-effort: the save above is the
      // source of truth, and `npm run provision` re-pushes regardless.
      let cellNote = '';
      try {
        const { count } = await pushCellRepos(cleaned);
        cellNote = ` Pushed ${count} to the investigator cell for alert-fired runs.`;
      } catch (err) {
        cellNote = ` (Could not reach the cell to update alert-fired runs: ${
          err instanceof Error ? err.message : String(err)
        } — re-run provisioning to retry.)`;
      }
      setFlash(`Source repositories saved.${cellNote}`);
      setTimeout(() => setFlash(null), 8000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceReposSaving(false);
    }
  }

  // Runs on the shared ProvisioningPanel's "Apply", after the search
  // reconcile — the SAME GoatTown trigger wiring scripts/provision.ts does,
  // so UI and CLI provisioning are identical. When server investigations
  // is off it tears the notification down; when on it ensures the webhook
  // target (needs the installation webhook token above) and binds the
  // alert-notify notification.
  async function handleProvisionCellTrigger(
    http: HttpClient,
  ): Promise<ProvisioningExtraStep[]> {
    const steps: ProvisioningExtraStep[] = [];
    if (!getServerInvestigations()) {
      await removeAlertNotification(http);
      steps.push({ label: 'Alert trigger: removed (server investigations off)', ok: true });
      return steps;
    }
    const url = getCellBaseUrl();
    const bearer = cellWebhookBearer.trim();
    try {
      const registration = await stageApmInvestigatorConfiguration(url, currentDataset);
      steps.push({
        label: `APM configuration revision staged (${registration.skills} skills)`,
        ok: !registration.hasConflicts,
        detail:
          `Revision ${registration.revisionId}; ${registration.changes} proposed change(s). ` +
          (registration.hasConflicts
            ? 'Resolve conflicts, review, and activate it in GoatTown.'
            : 'Review and activate it in GoatTown.'),
      });
    } catch (err) {
      steps.push({
        label: 'APM configuration staging: failed',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return steps;
    }
    if (url && bearer) {
      const t = await ensureCellWebhookTarget(http, { cellUrl: url, bearer });
      steps.push({ label: `Webhook target: ${t} (${url})`, ok: true });
    } else {
      steps.push({
        label: 'Webhook target: skipped',
        ok: false,
        detail: 'Set the shared GoatTown webhook token above; the alert trigger cannot fire without it.',
      });
    }
    const n = await ensureAlertNotification(http);
    steps.push({ label: `Alert notification: ${n} (alert_notify → cell)`, ok: true });
    // Re-push the configured source repos so alert-fired investigations
    // check out code (interactive ones thread their own at create time).
    try {
      const { count } = await pushCellRepos(sourceRepos);
      steps.push({ label: `Source repos → cell: ${count} for alert-fired runs`, ok: true });
    } catch (err) {
      steps.push({
        label: 'Source repos → cell: failed',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return steps;
  }

  async function handleStageGoatTownConfiguration() {
    if (goatTownConfigurationStaging) return;
    setGoatTownConfigurationStaging(true);
    setError(null);
    try {
      const result = await stageApmInvestigatorConfiguration(getCellBaseUrl(), currentDataset);
      setFlash(
        `GoatTown revision ${result.revisionId} staged with ${result.changes} proposed change(s). ` +
        `In GoatTown, open Configurations, load producer cribl-apm, review the diff, and activate it.` +
        (result.hasConflicts ? ' Resolve the reported conflicts before activation.' : ''),
      );
      setTimeout(() => setFlash(null), 15_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGoatTownConfigurationStaging(false);
    }
  }

  async function handleStreamFilterToggle(next: boolean) {
    if (streamFilterSaving) return;
    if (streamFilterSaving) return;
    setStreamFilterSaving(true);
    setError(null);
    try {
      // Apply locally first so the page re-fetches immediately; persist
      // in the background. If the PUT fails, roll back the in-memory
      // state to match what was last loaded.
      setStreamFilterEnabled(next);
      await saveAppSettings({ filterLongPollTraces: next });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStreamFilterEnabled(!next);
    } finally {
      setStreamFilterSaving(false);
    }
  }

  async function handleCadenceChange(next: CadenceOption) {
    if (cadenceSaving || next === currentCadence) return;
    setCadenceSaving(true);
    setError(null);
    try {
      setSearchCadence(next);
      await saveAppSettings({ searchCadence: next });
      setFlash(`Detection cadence set to ${next}. Re-provision below to apply.`);
      setTimeout(() => setFlash(null), 6000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSearchCadence(currentCadence);
    } finally {
      setCadenceSaving(false);
    }
  }

  const cadenceInfo = CADENCE_OPTIONS.find((o) => o.value === currentCadence);

  const navGroups: readonly NavGroup[] = [
    {
      title: 'Setup',
      items: [
        { id: 'provisioning', label: 'Provisioning' },
        { id: 'dataset-acceleration', label: 'Dataset acceleration' },
      ],
    },
    {
      title: 'Workspace',
      items: [
        { id: 'dataset', label: 'Dataset' },
        { id: 'cadence', label: 'Detection cadence' },
        { id: 'low-volume', label: 'Low-volume mode' },
        { id: 'server-investigations', label: 'Server-side investigations' },
      ],
    },
    {
      title: 'Filtering & heuristics',
      items: [
        { id: 'noise-filters', label: 'Noise filters' },
        { id: 'error-filtering', label: 'Error filtering' },
      ],
    },
    {
      title: 'Diagnostics',
      items: [{ id: 'originators', label: 'Trace originators' }],
    },
  ];

  return (
    <div className={s.page}>
      <div>
        <h1 className={s.title}>Settings</h1>
        <p className={s.subtitle}>
          App-level configuration stored in the Cribl pack-scoped key-value store.
        </p>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <SettingsSetupStatus />

      <div className={s.layout}>
        <aside className={s.navCol}>
          <SettingsNav groups={navGroups} />
        </aside>

        <div className={s.contentCol}>
          {/* ── Setup ────────────────────────────────────────── */}
          <h2 className={s.groupHeading}>Setup</h2>
          <p className={s.groupHelp}>
            One-time install actions. Both must succeed before the
            rest of the app reads cached data instead of running
            queries live.
          </p>

          <div id="provisioning" className={s.card}>
            <ProvisioningPanel
              config={{
                prefix: CRIBLAPM_PREFIX,
                plan: getProvisioningPlan,
                seedLookups: SEED_LOOKUPS,
              }}
              afterReconcile={handleProvisionCellTrigger}
              helpText={
                <>
                  Cribl APM caches its expensive panel queries (Home catalog,
                  sparklines, slow trace classes, error classes, dependency graph,
                  latency baselines) as scheduled Cribl Saved Searches that run
                  every few minutes. Pages then read the cached rows via{' '}
                  <code>$vt_results</code> / lookup joins, which is ~10× faster
                  than running the underlying queries live on every load. Re-run
                  the preview after changing the <strong>Dataset</strong> or{' '}
                  <strong>Noise filters</strong> setting so the cached queries
                  pick up the new values.
                </>
              }
              dangerHelpText={
                <>
                  Deletes every <code>criblapm__*</code> saved search from the
                  workspace. Page loads revert to live queries (slower). Use
                  before reinstalling the pack or to fully reset state.
                </>
              }
            />
          </div>

          <div id="dataset-acceleration" className={s.card}>
            <DatasetProvisioningPanel />
          </div>

          <div id="metrics-backfill" className={s.card}>
            <h2 className={s.sectionTitle}>Metrics backfill</h2>
            <MetricsBackfillPanel />
          </div>

          {/* ── Workspace ────────────────────────────────────── */}
          <h2 className={s.groupHeading}>Workspace</h2>
          <p className={s.groupHelp}>
            Settings the operator adjusts day-to-day — the dataset
            being read from, how often detection refreshes, and where
            alerts get delivered.
          </p>

          <div id="dataset" className={s.card}>
        <h2 className={s.sectionTitle}>Dataset</h2>
        <p className={s.sectionHelp}>
          All Cribl APM queries run against this Cribl Search dataset.
          It should contain OpenTelemetry span + log events (i.e. the same
          schema produced by the OpenTelemetry Collector's OTLP pipeline).
          Defaults to <code>otel</code>.
        </p>

        <div className={s.currentRow}>
          <span className={s.currentLabel}>Active</span>
          <span className={s.currentValue}>{currentDataset}</span>
        </div>

        <div className={s.field}>
          <label className={s.label} htmlFor="dataset-input">
            Dataset name
          </label>
          <input
            id="dataset-input"
            className={s.input}
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="otel"
            spellCheck={false}
            autoCapitalize="none"
            autoComplete="off"
            list="dataset-suggestions"
          />
          <datalist id="dataset-suggestions">
            {DATASET_SUGGESTIONS.map((d) => (
              <option key={d} value={d} />
            ))}
          </datalist>
          {!valid && trimmed.length > 0 && (
            <div className={s.fieldHelp} style={{ color: 'var(--cds-color-danger)' }}>
              Only letters, numbers, underscore, and hyphen are allowed.
            </div>
          )}
        </div>

        <div className={s.suggestions}>
          {DATASET_SUGGESTIONS.map((d) => (
            <button
              key={d}
              type="button"
              className={`${s.suggestion} ${draft === d ? s.suggestionActive : ''}`}
              onClick={() => setDraft(d)}
            >
              {d}
            </button>
          ))}
        </div>

        <div className={s.actions}>
          <button
            type="button"
            className={s.primaryBtn}
            onClick={handleSave}
            disabled={!dirty || !valid || saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            className={s.secondaryBtn}
            onClick={handleReset}
            disabled={!dirty || saving}
          >
            Reset
          </button>
          {flash && <span className={s.successFlash}>{flash}</span>}
        </div>
      </div>

      <div id="cadence" className={s.card}>
        <h2 className={s.sectionTitle}>Detection cadence</h2>
        <p className={s.sectionHelp}>
          How often scheduled searches run to refresh the Home page panels
          and the Detected Issues alerts. Lower values detect problems faster
          but use more Cribl Search worker time.
        </p>

        <div className={s.currentRow}>
          <span className={s.currentLabel}>Current</span>
          <span className={s.currentValue}>{cadenceInfo?.label ?? currentCadence}</span>
          <span className={s.cadenceLag}>
            Detection lag: <strong>{cadenceInfo?.lagLabel ?? '~5 minutes'}</strong>
          </span>
        </div>

        <div className={s.field}>
          <label className={s.label} htmlFor="cadence-select">
            Refresh interval
          </label>
          <select
            id="cadence-select"
            className={s.input}
            value={currentCadence}
            onChange={(e) => void handleCadenceChange(e.target.value as CadenceOption)}
            disabled={cadenceSaving}
          >
            {CADENCE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label} — detection lag {opt.lagLabel}
              </option>
            ))}
          </select>
        </div>

        {flash && <span className={s.successFlash}>{flash}</span>}
      </div>

      <div id="low-volume" className={s.card}>
        <h2 className={s.sectionTitle}>Low-volume mode</h2>
        <p className={s.sectionHelp}>
          The default alert thresholds are tuned for production-shaped
          traffic — ≥5% error rate with ≥20 spans, or a 3× deviation
          above a stable baseline with ≥100 prior requests, or a
          catastrophic ramp on a previously-clean service. Services
          with very thin traffic (homelab, demo workloads, rarely-called
          endpoints) won't clear those thresholds even when broken.
          Enabling this restores an older arm that fires on as little as
          2 errors at ≥1% rate — useful for catching things like an LLM
          rate-limit blowup on a low-RPS endpoint at the cost of more
          background noise on noisier workloads.
        </p>

        <label className={s.toggleRow}>
          <input
            type="checkbox"
            checked={currentLowVolume}
            disabled={lowVolumeSaving}
            onChange={(e) => void handleLowVolumeToggle(e.target.checked)}
          />
          <div>
            <div className={s.toggleTitle}>Enable low-volume detection arm (≥2 errors AND ≥1% rate)</div>
            <div className={s.toggleSub}>
              Off by default. Toggling requires a re-provision below to
              take effect — the alert search bakes in its KQL at
              scheduled-search creation time, so the new arm only
              becomes active after the next deploy or "Reconcile".
            </div>
          </div>
        </label>
      </div>

      <div id="server-investigations" className={s.card}>
        <h2 className={s.sectionTitle}>Server-side investigations</h2>
        <p className={s.sectionHelp}>
          When enabled, firing alerts trigger an autonomous Investigator
          run in GoatTown — no browser needed.
          The Alerts page then shows investigation badges and lets you
          drill into the finished transcript. Stage the configuration below,
          then approve it in GoatTown before enabling the alert trigger.
        </p>

        <label className={s.toggleRow}>
          <input
            type="checkbox"
            checked={currentServerInvestigations}
            disabled={serverInvestigationsSaving}
            onChange={(e) => void handleServerInvestigationsToggle(e.target.checked)}
          />
          <div>
            <div className={s.toggleTitle}>Investigate firing alerts automatically on the server</div>
            <div className={s.toggleSub}>
              Off by default. Turning on requires a re-provision below to
              create the alert trigger search. Turning off removes the
              trigger on the next re-provision, so no new investigations
              fire; re-provision after toggling either way.
            </div>
          </div>
        </label>

        <div className={s.field} style={{ marginTop: 16 }}>
          <div className={s.label}>GoatTown agent configuration</div>
          <div className={s.fieldHelp}>
            Validate and stage this app&apos;s <code>goattown.config.yaml</code> as
            an immutable revision. This does not activate the agent. In GoatTown,
            open <strong>Configurations</strong>, load producer <code>cribl-apm</code>,
            review the diff, and activate it explicitly.
          </div>
          <div className={s.actions} style={{ marginTop: 8 }}>
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => void handleStageGoatTownConfiguration()}
              disabled={goatTownConfigurationStaging || !cellTokenConfigured}
            >
              {goatTownConfigurationStaging ? 'Staging…' : 'Stage GoatTown revision'}
            </button>
            {flash && <span className={s.successFlash}>{flash}</span>}
          </div>
        </div>

        <div className={s.field} style={{ marginTop: 16 }}>
          <div className={s.label}>Shared GoatTown service</div>
          <div className={s.fieldHelp}>
            <code>{SHARED_GOATTOWN_BASE_URL}</code>. Enrollment and tokens are
            installation-scoped; sessions and configuration are isolated from
            other Workspaces by the shared service.
          </div>
        </div>

        <div className={s.field} style={{ marginTop: 16 }}>
          <label className={s.label} htmlFor="cell-token-input">
            Shared GoatTown installation token
          </label>
          <input
            id="cell-token-input"
            className={s.input}
            type="password"
            value={cellToken}
            onChange={(e) => setCellToken(e.target.value)}
            placeholder={cellTokenConfigured ? 'Configured - paste a new token to replace it' : 'Paste the gt_i1_ installation token'}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
          />
          <div className={s.fieldHelp}>
            Paste the one-time UI token issued during shared GoatTown enrollment.
            It is stored write-only for the platform proxy as{' '}
            <code>kv.sharedCellToken</code> and is never read back into the app.
          </div>
          <div className={s.actions} style={{ marginTop: 8 }}>
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => void handleSaveCellToken()}
              disabled={cellTokenSaving || !cellToken.trim()}
            >
              {cellTokenSaving ? 'Saving…' : cellTokenConfigured ? 'Replace token' : 'Save token'}
            </button>
          </div>
        </div>

        <div className={s.field} style={{ marginTop: 16 }}>
          <label className={s.label} htmlFor="cell-webhook-bearer-input">
            Shared GoatTown webhook token (alert trigger)
          </label>
          <input
            id="cell-webhook-bearer-input"
            className={s.input}
            type="password"
            value={cellWebhookBearer}
            onChange={(e) => setCellWebhookBearer(e.target.value)}
            placeholder="Paste the gt_w1_ webhook token"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
          />
          <div className={s.fieldHelp}>
            The installation-scoped webhook token for <code>/alerts/fire</code>,
            distinct from the UI token above. Stored in the app KV
            store so <strong>Provision</strong> below can create the webhook
            notification target that starts an investigation when alerts fire.
          </div>
          <div className={s.actions} style={{ marginTop: 8 }}>
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => void handleSaveCellWebhookBearer()}
              disabled={cellWebhookBearerSaving || !cellWebhookBearer.trim()}
            >
              {cellWebhookBearerSaving ? 'Saving…' : 'Save webhook bearer'}
            </button>
          </div>
        </div>

        <div className={s.field} style={{ marginTop: 16 }}>
          <label className={s.label}>Source repositories</label>
          <div className={s.fieldHelp}>
            Repos the investigator may check out to read code once telemetry
            narrows to a service. <strong>Service</strong> maps a repo to a
            telemetry service; leave it <code>*</code> for a monorepo that
            backs every service (e.g. the OTel Demo). <strong>Ref</strong> pins
            a branch, tag, or commit SHA to check out; leave it empty for the
            default branch. Threaded into investigations you start from the
            Investigate button, and into alert-fired ones after Save.
          </div>
          {sourceRepos.length === 0 && (
            <div className={s.fieldHelp} style={{ opacity: 0.8 }}>
              No repositories configured.
            </div>
          )}
          {sourceRepos.map((repo, i) => (
            <div
              key={i}
              style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}
            >
              <input
                className={s.input}
                type="text"
                value={repo.url}
                placeholder="github.com/org/repo"
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                onChange={(e) => updateRepo(i, { url: e.target.value })}
                style={{ flex: 2 }}
              />
              <input
                className={s.input}
                type="text"
                value={repo.service ?? ''}
                placeholder="service (or *)"
                spellCheck={false}
                autoComplete="off"
                onChange={(e) => updateRepo(i, { service: e.target.value })}
                style={{ flex: 1 }}
              />
              <input
                className={s.input}
                type="text"
                value={repo.ref ?? ''}
                placeholder="branch/tag/SHA"
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                onChange={(e) => updateRepo(i, { ref: e.target.value })}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className={s.secondaryBtn}
                onClick={() => removeRepo(i)}
                title="Remove"
                aria-label="Remove repository"
              >
                ✕
              </button>
            </div>
          ))}
          <div className={s.actions} style={{ marginTop: 8 }}>
            <button type="button" className={s.secondaryBtn} onClick={addRepo}>
              + Add repository
            </button>
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => void handleSaveSourceRepos()}
              disabled={sourceReposSaving}
            >
              {sourceReposSaving ? 'Saving…' : 'Save repositories'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Filtering & heuristics ───────────────────────── */}
      <h2 className={s.groupHeading}>Filtering &amp; heuristics</h2>
      <p className={s.groupHelp}>
        Heuristic rules that decide what counts as noise or as a real
        error. Affect what shows up on Home; alert pipeline picks them
        up at next deploy.
      </p>

      <div id="noise-filters" className={s.card}>
        <h2 className={s.sectionTitle}>Noise filters</h2>
        <p className={s.sectionHelp}>
          Heuristics that keep streaming / idle-wait traces from distorting
          aggregate statistics — persistent gRPC streams (e.g.
          flagd.evaluation <code>/EventStream</code>), SSE / websocket
          long-polls, and kafka-consumer idle-wait loops. Default on.
        </p>

        <label className={s.toggleRow}>
          <input
            type="checkbox"
            checked={currentStreamFilter}
            disabled={streamFilterSaving}
            onChange={(e) => void handleStreamFilterToggle(e.target.checked)}
          />
          <div>
            <div className={s.toggleTitle}>Hide long-poll / idle-wait traces from aggregates</div>
            <div className={s.toggleSub}>
              Drops individual spans longer than 30s from service percentiles,
              top-operations, and dependency-edge stats, and hides trace-level
              stream/idle-wait patterns from the Home "Slowest trace classes"
              panel. <strong>Search is unaffected</strong> — explicit trace
              searches always return whatever matches.
            </div>
          </div>
        </label>
      </div>

      <div id="error-filtering" className={s.card}>
        <h2 className={s.sectionTitle}>Error filtering</h2>
        <p className={s.sectionHelp}>
          Rules that decide which error spans the Home "Error classes" panel
          surfaces. Disabling a rule shows the rows it was dropping;
          re-enabling re-applies the filter. See{' '}
          <code>HEURISTICS.md</code> for the design and the
          consistency principle.
        </p>
        <div className={s.fieldHelp} style={{ marginBottom: 'var(--cds-space-md)' }}>
          Toggles affect the Home panel on the next reload. The metric layer
          feeding alerts uses the default rules until you redeploy
          (<code>npm run deploy</code>) — the alert pipeline rebuilds its
          KQL at provision time. Mismatch is logged here so you can audit.
        </div>

        {DEFAULT_FILTER_RULES.map((rule) => {
          const isDisabled = !!disabledRules[rule.id];
          return (
            <label key={rule.id} className={s.toggleRow}>
              <input
                type="checkbox"
                checked={!isDisabled}
                disabled={rulesSaving}
                onChange={(e) => void handleRuleToggle(rule.id, !e.target.checked)}
              />
              <div>
                <div className={s.toggleTitle}>
                  <code>{rule.id}</code>{' '}
                  <span className={s.subtitle} style={{ fontWeight: 'normal' }}>
                    scope: {rule.scope}
                  </span>
                </div>
                <div className={s.toggleSub}>{rule.description}</div>
              </div>
            </label>
          );
        })}
      </div>

      {/* ── Diagnostics ──────────────────────────────────── */}
      <h2 className={s.groupHeading}>Diagnostics</h2>
      <p className={s.groupHelp}>
        Read-only audit views. Operators rarely need these — the
        section is collapsed by default; expand on demand.
      </p>

      <div id="originators" className={s.card}>
        <button
          type="button"
          className={s.diagnosticToggle}
          onClick={() => setOriginatorsOpen((o) => !o)}
          aria-expanded={originatorsOpen}
        >
          <span className={s.sectionTitle}>Trace originators</span>
          <span className={s.diagnosticChevron} aria-hidden>
            {originatorsOpen ? '▾' : '▸'}
          </span>
        </button>
        {originatorsOpen && (
          <>
        <p className={s.sectionHelp}>
          Auto-detected from each captured trace's root span by the
          <code> criblapm__trace_originators </code> scheduled search.
          Classifications drive the user-trace filter rules above. See{' '}
          <code>HEURISTICS.md</code> for the signal priority.
        </p>
        {originatorsLoading ? (
          <div className={s.fieldHelp}>Loading classifications…</div>
        ) : originators.length === 0 ? (
          <div className={s.fieldHelp}>
            No root spans observed in the last 15 minutes. The classifier
            needs ≥ 10 root spans per service to commit a classification.
          </div>
        ) : (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Root service</th>
                <th>Type</th>
                <th style={{ textAlign: 'right' }}>Roots</th>
                <th>Dominant signal</th>
              </tr>
            </thead>
            <tbody>
              {originators.map((o) => {
                const sig =
                  o.signals.browser > 0 ? `${o.signals.browser} browser UA`
                  : o.signals.loadtest > 0 ? `${o.signals.loadtest} load-test UA`
                  : o.signals.probe > 0 ? `${o.signals.probe} k8s-probe UA`
                  : o.signals.messaging > 0 ? `${o.signals.messaging} messaging.system`
                  : o.signals.nameUser > 0 ? `${o.signals.nameUser} user_* span names`
                  : o.signals.nameService > 0 ? `${o.signals.nameService} cron/worker names`
                  : '—';
                return (
                  <tr key={o.rootService}>
                    <td><code>{o.rootService}</code></td>
                    <td>
                      <span className={`${s.originatorChip} ${s[`originatorChip_${o.type}`] ?? ''}`}>
                        {o.type}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{o.total}</td>
                    <td>{sig}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
          </>
        )}
      </div>

        </div>{/* contentCol */}
      </div>{/* layout */}
    </div>
  );
}
