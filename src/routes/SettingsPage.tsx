import { useCallback, useEffect, useState } from 'react';
import StatusBanner from '../components/StatusBanner';
import ProvisioningPanel from '@cribl/app-utils/provisioning-panel';
import DatasetProvisioningPanel from '../components/DatasetProvisioningPanel';
import SettingsSetupStatus from './SettingsSetupStatus';
import SettingsNav, { type NavGroup } from './SettingsNav';
import { loadAppSettings, saveAppSettings } from '../api/appSettings';
import { listNotificationTargets, type NotificationTarget } from '../api/notificationTargets';
import { setCurrentDataset, useDataset } from '@cribl/app-utils/dataset';
import { setStreamFilterEnabled } from '../api/streamFilter';
import { setSearchCadence, CADENCE_OPTIONS, type CadenceOption } from '@cribl/app-utils/cadence';
import {
  CRIBLAPM_PREFIX,
  SEED_LOOKUPS,
  getProvisioningPlan,
} from '../api/provisionedSearches';
import { DEFAULT_FILTER_RULES } from '../api/errorFilter';
import { listTraceOriginators, type TraceOriginatorRow } from '../api/search';
import { useStreamFilterEnabled } from '../hooks/useStreamFilter';
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
  const currentCadence = useSearchCadence();
  const [draft, setDraft] = useState<string>(currentDataset);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [streamFilterSaving, setStreamFilterSaving] = useState(false);
  const [cadenceSaving, setCadenceSaving] = useState(false);
  const [notifTargets, setNotifTargets] = useState<NotificationTarget[]>([]);
  const [selectedTargets, setSelectedTargets] = useState<string[]>([]);
  const [notifSaving, setNotifSaving] = useState(false);
  const [disabledRules, setDisabledRules] = useState<Record<string, boolean>>({});
  const [rulesSaving, setRulesSaving] = useState(false);
  const [originators, setOriginators] = useState<TraceOriginatorRow[]>([]);
  const [originatorsLoading, setOriginatorsLoading] = useState(true);
  const [originatorsOpen, setOriginatorsOpen] = useState(false);

  // Load notification targets + saved selection on mount
  useEffect(() => {
    listNotificationTargets().then(setNotifTargets).catch(() => {});
    loadAppSettings().then((s) => {
      if (s?.alertNotificationTargets) {
        setSelectedTargets(s.alertNotificationTargets);
      }
      if (s?.disabledFilterRules) {
        setDisabledRules(s.disabledFilterRules);
      }
    }).catch(() => {});
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

  const handleTargetToggle = useCallback(async (targetId: string) => {
    const next = selectedTargets.includes(targetId)
      ? selectedTargets.filter((t) => t !== targetId)
      : [...selectedTargets, targetId];
    setSelectedTargets(next);
    setNotifSaving(true);
    try {
      await saveAppSettings({ alertNotificationTargets: next });
      setFlash(`Alert targets updated.`);
      setTimeout(() => setFlash(null), 4000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setNotifSaving(false);
    }
  }, [selectedTargets]);

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

  async function handleStreamFilterToggle(next: boolean) {
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
        { id: 'notifications', label: 'Notification targets' },
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

      <div id="notifications" className={s.card}>
        <h2 className={s.sectionTitle}>Alert notification targets</h2>
        <p className={s.sectionHelp}>
          Auto-detected issues will send notifications to the selected targets
          when they fire and when they resolve. Select one or more targets below.
          Targets are configured in Cribl under Notification Targets.
        </p>

        {notifTargets.length === 0 ? (
          <div className={s.fieldHelp}>
            No notification targets configured in this workspace.
            Configure them in Cribl under Settings → Notification Targets.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {notifTargets.map((t) => (
              <label key={t.id} className={s.toggleRow}>
                <input
                  type="checkbox"
                  checked={selectedTargets.includes(t.id)}
                  disabled={notifSaving}
                  onChange={() => void handleTargetToggle(t.id)}
                />
                <div>
                  <div className={s.toggleTitle}>{t.name ?? t.id}</div>
                  <div className={s.toggleSub}>{t.type} — {t.id}</div>
                </div>
              </label>
            ))}
          </div>
        )}
        {flash && <span className={s.successFlash}>{flash}</span>}
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
