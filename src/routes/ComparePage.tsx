import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { getTrace } from '../api/search';
import { diffTraces, type DiffRow } from '../utils/diff';
import { formatDurationUs, serviceColor } from '../utils/spans';
import StatusBanner from '../components/StatusBanner';
import type { JaegerTrace } from '../api/types';
import s from './ComparePage.module.css';

interface LoadedPair {
  left: JaegerTrace;
  right: JaegerTrace;
}

export default function ComparePage() {
  const { idA, idB } = useParams();
  const navigate = useNavigate();

  // Draft inputs are keyed off the URL params so navigating to a fresh
  // /compare/:a/:b URL re-initializes them; the user can then edit freely
  // without re-pushing to the URL until they click Compare again.
  const draftKey = `${idA ?? ''}|${idB ?? ''}`;
  const [a, setA] = useState(idA ?? '');
  const [b, setB] = useState(idB ?? '');
  const [lastDraftKey, setLastDraftKey] = useState(draftKey);
  if (lastDraftKey !== draftKey) {
    // Derive-during-render pattern (the React-recommended alternative to
    // setState-in-effect) — see https://react.dev/reference/react/useState
    setLastDraftKey(draftKey);
    setA(idA ?? '');
    setB(idB ?? '');
  }

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pair, setPair] = useState<LoadedPair | null>(null);

  // Fetch both traces whenever the URL params change. The cancelled flag
  // neutralizes React StrictMode double-mounting (which would otherwise
  // fire two parallel pairs of trace fetches and race to set state).
  useEffect(() => {
    if (!idA || !idB) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPair(null);
    Promise.all([getTrace(idA, '-24h', 'now'), getTrace(idB, '-24h', 'now')])
      .then(([leftTrace, rightTrace]) => {
        if (cancelled) return;
        if (!leftTrace) throw new Error(`Trace ${idA} not found`);
        if (!rightTrace) throw new Error(`Trace ${idB} not found`);
        setPair({ left: leftTrace, right: rightTrace });
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [idA, idB]);

  function handleCompare() {
    if (!a.trim() || !b.trim()) return;
    navigate(`/compare/${a.trim()}/${b.trim()}`);
  }

  const diff: DiffRow[] = useMemo(() => {
    if (!pair) return [];
    return diffTraces(pair.left, pair.right);
  }, [pair]);

  const stats = useMemo(() => {
    let bothCount = 0,
      leftOnly = 0,
      rightOnly = 0;
    for (const r of diff) {
      if (r.mark === 'both') bothCount++;
      else if (r.mark === 'left') leftOnly++;
      else rightOnly++;
    }
    return { bothCount, leftOnly, rightOnly };
  }, [diff]);

  return (
    <div className={s.page}>
      <div className={s.pickers}>
        <div className={s.pickerCol}>
          <label className={s.pickerLabel}>Trace A (left)</label>
          <input
            className={s.input}
            type="text"
            placeholder="trace id"
            value={a}
            onChange={(e) => setA(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCompare()}
          />
        </div>
        <div className={s.pickerCol}>
          <label className={s.pickerLabel}>Trace B (right)</label>
          <input
            className={s.input}
            type="text"
            placeholder="trace id"
            value={b}
            onChange={(e) => setB(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleCompare()}
          />
        </div>
        <div className={s.actions}>
          <button
            className={s.compareBtn}
            onClick={handleCompare}
            disabled={loading || !a.trim() || !b.trim()}
          >
            {loading ? 'Loading…' : 'Compare'}
          </button>
          <div className={s.legend}>
            <span>
              <span className={s.legendDot} style={{ background: 'rgba(229,72,77,0.4)' }} />
              Only in A
            </span>
            <span>
              <span className={s.legendDot} style={{ background: 'rgba(48,164,108,0.4)' }} />
              Only in B
            </span>
            {pair && (
              <span>
                <strong>{stats.bothCount}</strong> shared ·{' '}
                <strong>{stats.leftOnly}</strong> only-A · <strong>{stats.rightOnly}</strong> only-B
              </span>
            )}
          </div>
        </div>
      </div>

      {error && <StatusBanner kind="error">{error}</StatusBanner>}
      {!error && !pair && !loading && (
        <div className={s.empty}>Paste two trace IDs and click <strong>Compare</strong>.</div>
      )}

      {pair && diff.length > 0 && (
        <div className={s.diff}>
          <div className={s.diffHeader}>
            <div>Service / Operation</div>
            <div className={s.num}>A duration</div>
            <div className={s.num}>B duration</div>
          </div>
          {diff.map((row, i) => {
            const rowClass =
              row.mark === 'both' ? s.rowBoth : row.mark === 'left' ? s.rowLeft : s.rowRight;
            const markClass =
              row.mark === 'both' ? s.markBoth : row.mark === 'left' ? s.markLeft : s.markRight;
            const markChar = row.mark === 'both' ? '=' : row.mark === 'left' ? '−' : '+';
            return (
              <div key={i} className={`${s.row} ${rowClass}`}>
                <div className={s.label} style={{ paddingLeft: `${8 + row.depth * 18}px` }}>
                  <span className={`${s.markChip} ${markClass}`}>{markChar}</span>
                  <span className={s.serviceDot} style={{ background: serviceColor(row.service) }} />
                  <span className={s.svc}>{row.service}</span>
                  <span className={s.op}>{row.operationName}</span>
                </div>
                <div className={s.dur}>
                  {row.leftDurationUs != null ? (
                    formatDurationUs(row.leftDurationUs)
                  ) : (
                    <span className={s.durMissing}>—</span>
                  )}
                </div>
                <div className={s.dur}>
                  {row.rightDurationUs != null ? (
                    formatDurationUs(row.rightDurationUs)
                  ) : (
                    <span className={s.durMissing}>—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
