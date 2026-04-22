import { useEffect, useState } from 'react';
import StatusBanner from '../components/StatusBanner';
import ProvisioningPanel from '../components/ProvisioningPanel';
import { saveAppSettings } from '../api/appSettings';
import { setCurrentDataset } from '../api/dataset';
import { setStreamFilterEnabled } from '../api/streamFilter';
import { setSearchCadence, CADENCE_OPTIONS, type CadenceOption } from '../api/searchCadence';
import { useDataset } from '../hooks/useDataset';
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

  return (
    <div className={s.page}>
      <div>
        <h1 className={s.title}>Settings</h1>
        <p className={s.subtitle}>
          App-level configuration stored in the Cribl pack-scoped key-value store.
        </p>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className={s.card}>
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

      <div className={s.card}>
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

      <div className={s.card}>
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

      <ProvisioningPanel />
    </div>
  );
}
