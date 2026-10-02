import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import StatusBanner from '../components/StatusBanner';
import ProvisioningPanel from '@criblio/app-utils/provisioning-panel';
import DatasetProvisioningPanel from '../components/DatasetProvisioningPanel';
import MetricsBackfillPanel from '../components/MetricsBackfillPanel';
import SettingsSetupStatus from './SettingsSetupStatus';
import SettingsNav, { type NavGroup } from './SettingsNav';
import { loadAppSettings, saveAppSettings } from '../api/appSettings';
import { setCurrentDataset, useDataset, useDatasetLoadError } from '@criblio/app-utils/dataset';
import { setStreamFilterEnabled } from '../api/streamFilter';
import { setLowVolumeMode } from '../api/lowVolumeMode';
import { setSearchCadence, CADENCE_OPTIONS, type CadenceOption } from '@criblio/app-utils/cadence';
import { DEFAULT_FILTER_RULES } from '../api/errorFilter';
import { listTraceOriginators, type TraceOriginatorRow } from '../api/search';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
import { useLowVolumeMode } from '../hooks/useLowVolumeMode';
import { useServerInvestigations } from '../hooks/useServerInvestigations';
import { setServerInvestigations, getServerInvestigations } from '../api/serverInvestigations';
import {
  canFireAlerts,
  getCellBaseUrl,
  sessionDiagnosticsText,
  SHARED_GOATTOWN_BASE_URL,
  verifyGoatTownConnection,
} from '../api/investigationTransport';
import { kvGetText, kvPutText } from '@criblio/app-utils/kv';
import { stageApmInvestigatorConfiguration } from '../api/goatTownProvisioning';
import { pushGoatTownRepos } from '../api/investigationTransport';
import { removeSavedSearchNotification } from '@criblio/app-utils/notifications';
import { ALERT_NOTIFY_BINDING, settingsCellWebhookTargets } from '../api/cellProvisioning';
import { APM_PROVISIONER_CONFIG, type HttpClient } from '../api/provisioner';
import type { ProvisionerConfig } from '@criblio/app-utils/provisioner';
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

/** KV key GoatTown's console delivers APM's connected-app credential to. */
const GOATTOWN_CREDENTIAL_KEY = 'goattownEmbedToken';

export default function SettingsPage() {
  const currentDataset = useDataset();
  const settingsLoadError = useDatasetLoadError();
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
  const [goatTownConfigurationStaging, setGoatTownConfigurationStaging] = useState(false);
  /**
   * Outcome of the last staging attempt, rendered next to the button.
   *
   * Deliberately NOT the page-level `flash`/`error` pair. Those paint at the
   * top of the page, hundreds of pixels above this control, and `flash`
   * self-clears on a timer — so a staging failure was indistinguishable from
   * the button doing nothing. This state persists until the next attempt.
   */
  const [goatTownStaging, setGoatTownStaging] = useState<{
    kind: 'working' | 'ok' | 'nochange' | 'error';
    message: string;
  } | null>(null);
  const [cellTokenSaving, setCellTokenSaving] = useState(false);
  /**
   * `needs-agent` is deliberately NOT an error. The credential is good and the
   * agent simply has not been activated yet, which is the expected state on a
   * fresh tenant — and treating it as a failure is what made setup impossible
   * to complete, since it disabled the very button that stages the agent.
   */
  const [goatTownConnection, setGoatTownConnection] = useState<{
    kind: 'checking' | 'connected' | 'needs-agent' | 'error';
    message: string;
  } | null>(null);
  const [sourceRepos, setSourceRepos] = useState<SourceRepo[]>([]);
  const [sourceReposSaving, setSourceReposSaving] = useState(false);
  const [cadenceSaving, setCadenceSaving] = useState(false);
  const [disabledRules, setDisabledRules] = useState<Record<string, boolean>>({});
  const [rulesSaving, setRulesSaving] = useState(false);
  const [originators, setOriginators] = useState<TraceOriginatorRow[]>([]);
  const [originatorsLoading, setOriginatorsLoading] = useState(true);
  const [originatorsOpen, setOriginatorsOpen] = useState(false);
  const [goatTownRawOpen, setGoatTownRawOpen] = useState(false);
  const [goatTownRaw, setGoatTownRaw] = useState('');

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
    // Test unconditionally: GoatTown's console can deliver the credential
    // directly to KV without setting any app-local sentinel.
    void testGoatTownConnection(true);
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
    if (!/^gt_a1_[A-Za-z0-9_-]{43}$/.test(token)) {
      setGoatTownConnection({
        kind: 'error',
        message: /^gt_[iw]1_/.test(token)
          ? 'That is a GoatTown installation token (gt_i1_ / gt_w1_). This field takes '
            + 'the per-app connected-app credential — gt_a1_ followed by 43 characters — '
            + "issued under Connections → Connected apps in GoatTown's console."
          : 'Enter a connected-app token in the form gt_a1_ followed by 43 characters. '
            + 'You may not need to at all: GoatTown can deliver the credential straight '
            + 'to kv.goattownEmbedToken, and this field is only the manual fallback.',
      });
      return;
    }
    setCellTokenSaving(true);
    setError(null);
    try {
      await kvPutText(GOATTOWN_CREDENTIAL_KEY, token);
      setCellToken('');
      setGoatTownConnection({ kind: 'checking', message: 'Token saved. Testing GoatTown…' });
      await testGoatTownConnection();
    } catch (err) {
      setCellTokenConfigured(false);
      setGoatTownConnection({
        kind: 'error',
        message: `Could not save or verify the token: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      setCellTokenSaving(false);
    }
  }

  async function testGoatTownConnection(silent = false) {
    if (!silent) setGoatTownConnection({ kind: 'checking', message: 'Testing GoatTown connection…' });
    try {
      const { agentAvailable } = await verifyGoatTownConnection();
      // Gate on the CREDENTIAL alone. The agent cannot exist until a revision
      // staged from this page has been activated, so gating staging on the
      // agent's presence is a loop with no way out.
      setCellTokenConfigured(true);
      setGoatTownConnection(agentAvailable
        ? {
          kind: 'connected',
          message: 'Connected. GoatTown accepted this app credential and the APM Investigator is available.',
        }
        : {
          kind: 'needs-agent',
          message: 'Credential accepted, but the APM Investigator agent is not in GoatTown\'s '
            + 'catalog yet. Stage a revision above, then have a tenant administrator activate '
            + 'it; this check turns green once the agent appears. Investigations cannot run '
            + 'until then.',
        });
    } catch (err) {
      setCellTokenConfigured(false);
      setGoatTownConnection({
        kind: 'error',
        message: `Not connected: ${err instanceof Error ? err.message : String(err)}`,
      });
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
      // Also push to GoatTown so alert-fired (autonomous) investigations get
      // the same repos. Interactive runs thread them at create time, so app
      // settings alone would leave only the autonomous path without code
      // tools. Best-effort: the save above is the source of truth, and Apply
      // re-pushes, so a transient failure here is reported, not fatal.
      let pushNote = '';
      try {
        const { count } = await pushGoatTownRepos(cleaned);
        pushNote = ` Pushed ${count} to GoatTown for alert-fired runs.`;
      } catch (err) {
        pushNote = ` (Could not reach GoatTown to update alert-fired runs: ${
          err instanceof Error ? err.message : String(err)
        } — re-provision to retry.)`;
      }
      setFlash(`Source repositories saved.${pushNote}`);
      setTimeout(() => setFlash(null), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSourceReposSaving(false);
    }
  }

  // The webhook target is ensured by the framework apply itself (after the
  // searches, before the alert_notify binding in APM_PROVISIONER_CONFIG),
  // from the connected-app credential GoatTown's console delivers to KV —
  // which the CLI cannot see, so Settings is the supported way to provision
  // it. Reasons it was skipped are collected here and reported by
  // handleProvisionCellTrigger, which runs after the apply.
  const targetSkipsRef = useRef<ProvisioningExtraStep[]>([]);
  const provisionerConfig = useMemo<ProvisionerConfig>(() => ({
    ...APM_PROVISIONER_CONFIG,
    notificationTargets: () => {
      targetSkipsRef.current = [];
      return settingsCellWebhookTargets({
        cellUrl: getCellBaseUrl,
        canFireAlerts: () => canFireAlerts(),
        readCredential: () => kvGetText(GOATTOWN_CREDENTIAL_KEY),
        credentialKey: GOATTOWN_CREDENTIAL_KEY,
        report: (step) => targetSkipsRef.current.push(step),
      });
    },
  }), []);

  // Runs on the shared ProvisioningPanel's "Apply", after the search
  // reconcile and the notification target/binding. When server
  // investigations is off it makes sure the notification is gone; when on
  // it stages the agent configuration and pushes the source repos.
  async function handleProvisionCellTrigger(
    http: HttpClient,
  ): Promise<ProvisioningExtraStep[]> {
    const steps: ProvisioningExtraStep[] = [...targetSkipsRef.current];
    targetSkipsRef.current = [];
    if (!getServerInvestigations()) {
      // The apply already unbinds alert_notify when it deletes the search;
      // this also clears a binding left behind by an earlier, partial
      // teardown. A failed unbind is reported, not swallowed.
      try {
        const outcome = await removeSavedSearchNotification(http, ALERT_NOTIFY_BINDING);
        steps.push({ label: `Alert trigger: ${outcome === 'deleted' ? 'removed' : 'already absent'} (server investigations off)`, ok: true });
      } catch (err) {
        steps.push({
          label: 'Alert trigger: removal failed',
          ok: false,
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      return steps;
    }
    const url = getCellBaseUrl();
    // Stage the agent configuration with the same Apply that wires the
    // trigger — the workflow the CLI's `wireCellTrigger` performs, kept
    // identical between UI and CLI.
    //
    // Unlike the pre-SDK version this does NOT abort the rest on failure.
    // Staging can fail for a legitimate, unrelated reason (the app
    // connection has not been granted proposal rights). The step is still
    // reported not-ok, so the failure stays visible.
    try {
      const registration = await stageApmInvestigatorConfiguration(url, currentDataset);
      steps.push({
        label: `APM configuration revision staged (${registration.skills} skills)`,
        ok: !registration.hasConflicts,
        detail:
          `Revision ${registration.revisionId}; ${registration.changes} proposed change(s). ` +
          (registration.hasConflicts ? 'Resolve conflicts, then review' : 'Review') +
          ` and activate producer ${registration.producer} at ${registration.reviewPath}.`,
      });
    } catch (err) {
      steps.push({
        label: 'APM configuration staging: failed',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    // Re-push the configured repos so alert-fired investigations check out
    // code. Interactive runs thread their own at create time; this is the only
    // way the autonomous path gets them.
    try {
      const { count } = await pushGoatTownRepos(sourceRepos);
      steps.push({ label: `Source repos → GoatTown: ${count} for alert-fired runs`, ok: true });
    } catch (err) {
      steps.push({
        label: 'Source repos → GoatTown: failed',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    return steps;
  }

  /**
   * Stage the agent configuration on demand.
   *
   * The same call Apply makes, exposed on its own because the configuration
   * changes whenever the skills, the instructions, or the dataset change —
   * none of which necessarily coincides with a search needing reconciliation.
   */
  async function handleStageGoatTownConfiguration() {
    if (goatTownConfigurationStaging) return;
    setGoatTownConfigurationStaging(true);
    setGoatTownStaging({
      kind: 'working',
      message: 'Validating the configuration and storing a revision…',
    });
    try {
      const result = await stageApmInvestigatorConfiguration(getCellBaseUrl(), currentDataset);
      const where = `Producer ${result.producer}; review at ${result.reviewPath}.`;
      // A revision is stored on EVERY stage, including when the source already
      // matches what is active — `changes: 0` means there is nothing to
      // activate, not that nothing was sent. Spelling that out is the
      // difference between trusting the result and hunting GoatTown for a
      // revision that is sitting right there.
      if (result.changes === 0 && !result.hasConflicts) {
        setGoatTownStaging({
          kind: 'nochange',
          message:
            `Revision ${result.revisionId} stored with no changes: this configuration already ` +
            `matches the active one, so there is nothing to activate. ${where}`,
        });
      } else {
        setGoatTownStaging({
          kind: 'ok',
          message:
            `Revision ${result.revisionId} staged with ${result.changes} proposed change(s) ` +
            `across ${result.skills} skills` +
            `${result.hasConflicts ? '. It reports conflicts to resolve before activation' : ''}. ` +
            `${where}`,
        });
      }
    } catch (err) {
      setGoatTownStaging({
        kind: 'error',
        message: `Staging failed: ${err instanceof Error ? err.message : String(err)}`,
      });
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
      items: [
        { id: 'originators', label: 'Trace originators' },
        { id: 'goattown-raw', label: 'GoatTown raw events' },
      ],
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
      {settingsLoadError && (
        <StatusBanner kind="error">
          Saved settings could not be loaded, so the app is running on defaults:{' '}
          {settingsLoadError.message}
        </StatusBanner>
      )}

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
              config={provisionerConfig}
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
          drill into the finished transcript. Connect this app to a GoatTown
          tenant before starting interactive investigations.
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
            Validate and stage this app&apos;s <code>goattown.config.yaml</code> — the
            investigator agent, its skills, and the telemetry-reader profile — as an
            immutable revision. This does not activate the agent: a tenant administrator
            reviews the diff and activates it in GoatTown. Re-provisioning stages it as
            well, so this is only needed when the configuration changes on its own.
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
          </div>
          {/* Say why the button is inert. A disabled control with no
              explanation is the same dead end as a silent failure. */}
          {!cellTokenConfigured && (
            <div className={s.fieldHelp}>
              Unavailable until GoatTown accepts this app&apos;s credential. Save the
              connected-app token below; staging needs only a working credential,
              not an installed agent.
            </div>
          )}
          {(goatTownStaging?.kind === 'working' || goatTownStaging?.kind === 'nochange') && (
            <StatusBanner kind="info">{goatTownStaging.message}</StatusBanner>
          )}
          {goatTownStaging?.kind === 'error' && (
            <StatusBanner kind="error">{goatTownStaging.message}</StatusBanner>
          )}
          {goatTownStaging?.kind === 'ok' && (
            <div role="status" className={s.successFlash}>{goatTownStaging.message}</div>
          )}
        </div>

        <div className={s.field} style={{ marginTop: 16 }}>
          <div className={s.label}>Shared GoatTown service</div>
          <div className={s.fieldHelp}>
            <code>{SHARED_GOATTOWN_BASE_URL}</code>. In GoatTown&apos;s hosted console,
            select the Workspace, then open <strong>Connections → Connected apps → Add app</strong>.
            Use App ID <code>apm</code> and KV key <code>goattownEmbedToken</code>.
            Copy the generated token below or choose <strong>Update app KV</strong>.
          </div>
        </div>

        <div className={s.field} style={{ marginTop: 16 }}>
          <label className={s.label} htmlFor="cell-token-input">
            GoatTown connected-app token
          </label>
          <input
            id="cell-token-input"
            className={s.input}
            type="password"
            value={cellToken}
            onChange={(e) => setCellToken(e.target.value)}
            placeholder={cellTokenConfigured ? 'Connected - paste a replacement token if needed' : 'Paste the gt_a1_ connected-app token'}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
          />
          <div className={s.fieldHelp}>
            Paste the credential issued for the APM connected app.
            It is stored write-only for the platform proxy as{' '}
            <code>kv.goattownEmbedToken</code> and is never read back into the app.
          </div>
          {goatTownConnection?.kind === 'error' && (
            <StatusBanner kind="error">{goatTownConnection.message}</StatusBanner>
          )}
          {goatTownConnection?.kind === 'checking' && (
            <StatusBanner kind="info">{goatTownConnection.message}</StatusBanner>
          )}
          {goatTownConnection?.kind === 'needs-agent' && (
            <StatusBanner kind="info">{goatTownConnection.message}</StatusBanner>
          )}
          {goatTownConnection?.kind === 'connected' && (
            <div role="status" className={s.successFlash}>{goatTownConnection.message}</div>
          )}
          <div className={s.actions} style={{ marginTop: 8 }}>
            <button
              type="button"
              className={s.primaryBtn}
              onClick={() => void handleSaveCellToken()}
              disabled={cellTokenSaving || !cellToken.trim()}
            >
              {cellTokenSaving ? 'Saving…' : cellTokenConfigured ? 'Replace token' : 'Save token'}
            </button>
            <button
              type="button"
              className={s.secondaryBtn}
              onClick={() => void testGoatTownConnection()}
              disabled={goatTownConnection?.kind === 'checking'}
            >
              Test connection
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
            default branch. These are threaded into interactive investigations
            started from APM.
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

      <div id="goattown-raw" className={s.card}>
        <button
          type="button"
          className={s.diagnosticToggle}
          onClick={() => {
            const next = !goatTownRawOpen;
            setGoatTownRawOpen(next);
            // Snapshot on open so the view is a stable moment rather than
            // something that shifts while it is being read or copied.
            if (next) setGoatTownRaw(sessionDiagnosticsText());
          }}
          aria-expanded={goatTownRawOpen}
        >
          <span className={s.sectionTitle}>GoatTown raw events</span>
          <span className={s.diagnosticChevron} aria-hidden>
            {goatTownRawOpen ? '▾' : '▸'}
          </span>
        </button>
        {goatTownRawOpen && (
          <>
            <p className={s.sectionHelp}>
              A bounded, rolling record of what the GoatTown service actually
              returned — route shapes, status codes, content types, which event
              collection each response carried, and the request receipt with its
              cursor and <code>finalSeq</code>. This is what settles &ldquo;the
              answer came back empty but GoatTown looks fine&rdquo;: an HTML
              content type on a JSON route is a proxy misroute, and{' '}
              <code>collection: absent</code> means that route served no events
              at all.
            </p>
            <p className={s.fieldHelp}>
              Safe to paste into a bug report. Query values, credentials and
              image bytes are stripped by the recorder, and failures are
              recorded as a category rather than exception text — a thrown
              network error carries the request URL, and a URL can carry a
              token. Empty until an investigation has run in this browser
              session.
            </p>
            <pre className={s.rawEvents}>{goatTownRaw || 'No GoatTown interactions recorded yet.'}</pre>
          </>
        )}
      </div>

        </div>{/* contentCol */}
      </div>{/* layout */}
    </div>
  );
}
