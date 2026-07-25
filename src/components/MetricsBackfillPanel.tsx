/**
 * Settings UI for the metrics backfill. Runs the SAME core
 * (src/api/metricsBackfill.ts) that `npm run deploy` runs — only the deps
 * (transport) differ (src/api/metricsBackfillBrowser.ts). Per-metric
 * idempotent: re-running only backfills families that aren't yet covered,
 * so it's safe to click repeatedly and adding a new metric backfills only
 * the new one.
 */
import { useCallback, useRef, useState } from 'react';
import { Button } from '@capra/core';
import { runMetricsBackfill, type BackfillResult } from '../api/metricsBackfill';
import { makeBrowserBackfillDeps } from '../api/metricsBackfillBrowser';
import { getMetricEmitters } from '../api/provisionedSearches';
import { getMetricsEmit } from '../api/metricsEmit';
import s from './DatasetProvisioningPanel.module.css';

const HORIZON_SEC = 24 * 3600;
const mono: React.CSSProperties = {
  fontFamily: 'var(--cds-font-family-mono, monospace)',
  fontSize: '12px',
  whiteSpace: 'pre-wrap',
  maxHeight: '220px',
  overflowY: 'auto',
  background: 'var(--cds-color-bg-subtle)',
  padding: 'var(--cds-space-sm)',
  borderRadius: '4px',
  marginTop: 'var(--cds-space-sm)',
};

export default function MetricsBackfillPanel() {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [result, setResult] = useState<BackfillResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<string[]>([]);

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setResult(null);
    logRef.current = [];
    setLines([]);
    const log = (msg: string) => {
      logRef.current = [...logRef.current, msg];
      setLines(logRef.current);
    };
    try {
      const deps = makeBrowserBackfillDeps(log);
      const nowSec = Math.floor(Date.now() / 1000);
      const res = await runMetricsBackfill(deps, getMetricEmitters(), {
        horizonSec: HORIZON_SEC,
        nowSec,
      });
      setResult(res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }, []);

  const emitOn = getMetricsEmit();

  return (
    <div className={s.panel}>
      <p className={s.subtitle}>
        Populate the fast metrics store with the last 24h of history from raw
        spans, so the RED panels work across all time ranges immediately (not
        just from when emitting started). Runs newest→oldest and is per-metric
        idempotent — safe to re-run, and adding a new metric only backfills
        the new one. Histograms are sampled for speed (percentiles preserved).
      </p>
      {!emitOn && (
        <p className={s.error}>
          Metric emit is off — enable it first (the emitters must exist before
          backfilling into them).
        </p>
      )}
      <div className={s.actions}>
        <Button variant="primary" onClick={() => void run()} disabled={running || !emitOn}>
          {running ? 'Backfilling…' : 'Backfill last 24h'}
        </Button>
      </div>

      {error && <p className={s.error}>Backfill failed: {error}</p>}

      {result && (
        <table style={{ width: '100%', marginTop: 'var(--cds-space-sm)', fontSize: '13px' }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th>Metric</th><th>Status</th><th>Exports</th><th>Events</th>
            </tr>
          </thead>
          <tbody>
            {result.emitters.map((e) => (
              <tr key={e.id}>
                <td>{e.metricName}</td>
                <td>{e.skipped ? 'already covered' : e.totalDropped > 0 ? `${e.totalDropped} DROPPED` : 'backfilled'}</td>
                <td>{e.exportsRun}</td>
                <td>{e.totalOut.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {lines.length > 0 && <div style={mono}>{lines.slice(-40).join('\n')}</div>}
    </div>
  );
}
