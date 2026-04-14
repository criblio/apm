/**
 * Floating stat card rendered on top of the dependency graph when the
 * user hovers or pins a service node. Shares layout with the Home
 * catalog row + Service detail hero but in a compact, positioned form.
 *
 * Lazy-loaded details: in addition to the aggregate stats + sparklines
 * that SystemArchPage pre-fetches for every service, this component
 * fetches per-service operation breakdowns (top calls + erroring ops)
 * on-demand when the tooltip opens. Fetches are debounced by 150 ms
 * so quick mouse sweeps across the graph don't spam the backend, and
 * results are cached in a module-level Map keyed by (service, lookback)
 * so repeated hovers on the same node are instant. The cache is capped
 * by an LRU-ish length check to bound memory on long sessions.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Sparkline from './Sparkline';
import InvestigateButton from './InvestigateButton';
import type { InvestigationSeed } from '../api/agentContext';
import { serviceHealth } from '../utils/health';
import type {
  ServiceSummary,
  ServiceBucket,
  OperationSummary,
} from '../api/types';
import s from './NodeTooltip.module.css';

interface Props {
  service: string;
  summary: ServiceSummary | undefined;
  /** Previous-window summary used to detect traffic drops. When
   * present and significant, the tooltip's health label is promoted
   * to "Traffic down NN%" and a delta row is shown under Rate. */
  prevSummary?: ServiceSummary;
  buckets: ServiceBucket[];
  pinned: boolean;
  left: number;
  top: number;
  onClose: () => void;
  /**
   * Callback to load per-service operation summaries. The parent
   * pre-binds the current lookback range so the tooltip doesn't need
   * to know about time windows. Returning an empty array is fine and
   * renders "no operations".
   */
  loadOperations?: (service: string) => Promise<OperationSummary[]>;
  /**
   * The current lookback (e.g. "-15m"). Used only as a cache key —
   * when the user changes the range, the cache key changes and the
   * tooltip re-fetches on next hover.
   */
  lookback: string;
}

/** Shared across all NodeTooltip instances — a tooltip mount for the
 * same service+lookback uses the cached result instead of refetching. */
interface CacheEntry {
  ops: OperationSummary[] | null;
  error: string | null;
  loading: boolean;
  /** Promise for in-flight loads so multiple mounts await the same fetch. */
  inflight?: Promise<void>;
}
const opsCache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 64;

function cacheKey(service: string, lookback: string): string {
  return `${service}\u0000${lookback}`;
}

/** Drop the oldest entries until we're under the cap. Map iteration
 * order is insertion order so the first N are the oldest. */
function trimCache() {
  if (opsCache.size <= CACHE_LIMIT) return;
  const excess = opsCache.size - CACHE_LIMIT;
  let i = 0;
  for (const key of opsCache.keys()) {
    if (i >= excess) break;
    opsCache.delete(key);
    i++;
  }
}

/** How many rows to show in each of the two sections. */
const TOP_CALLS_LIMIT = 5;
const TOP_ERROR_LIMIT = 3;
/** Delay before firing the fetch. Cancelled on unmount so a quick
 * mouseover → mouseout doesn't kick off a query. Kept very small so
 * the tooltip feels responsive; a hover that lasts ≥50ms is almost
 * certainly intentional. */
const FETCH_DELAY_MS = 50;

function fmtRate(perMin: number): string {
  if (perMin >= 1000) return `${(perMin / 1000).toFixed(1)}k/min`;
  if (perMin >= 10) return `${perMin.toFixed(0)}/min`;
  return `${perMin.toFixed(1)}/min`;
}

function fmtUs(us: number): string {
  if (!Number.isFinite(us) || us === 0) return '—';
  if (us < 1000) return `${us.toFixed(0)} μs`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)} ms`;
  return `${(us / 1_000_000).toFixed(2)} s`;
}

export default function NodeTooltip({
  service,
  summary,
  prevSummary,
  buckets,
  pinned,
  left,
  top,
  onClose,
  loadOperations,
  lookback,
}: Props) {
  const health = serviceHealth(summary, prevSummary);

  // Lazy-loaded operations breakdown. Cached at the module level so
  // re-hovering the same node is instant; debounced with a small
  // delay so quick mouse sweeps across the graph don't fire.
  const key = cacheKey(service, lookback);
  const [ops, setOps] = useState<OperationSummary[] | null>(
    () => opsCache.get(key)?.ops ?? null,
  );
  const [loading, setLoading] = useState<boolean>(
    () => !opsCache.has(key),
  );
  const [loadErr, setLoadErr] = useState<string | null>(
    () => opsCache.get(key)?.error ?? null,
  );

  useEffect(() => {
    if (!loadOperations) {
      setLoading(false);
      return;
    }
    const entry = opsCache.get(key);
    if (entry && !entry.loading) {
      // Already resolved in cache — use it directly.
      setOps(entry.ops);
      setLoadErr(entry.error);
      setLoading(false);
      return;
    }
    if (entry?.inflight) {
      // Another tooltip mount already kicked off the fetch; await it.
      setLoading(true);
      let cancelled = false;
      entry.inflight.then(() => {
        if (cancelled) return;
        const e2 = opsCache.get(key);
        setOps(e2?.ops ?? null);
        setLoadErr(e2?.error ?? null);
        setLoading(false);
      });
      return () => {
        cancelled = true;
      };
    }

    // No cached entry — schedule a delayed fetch.
    setLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const promise = loadOperations(service)
        .then((result) => {
          opsCache.set(key, { ops: result, error: null, loading: false });
          trimCache();
          if (!cancelled) {
            setOps(result);
            setLoadErr(null);
            setLoading(false);
          }
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          opsCache.set(key, { ops: null, error: msg, loading: false });
          trimCache();
          if (!cancelled) {
            setOps(null);
            setLoadErr(msg);
            setLoading(false);
          }
        });
      opsCache.set(key, {
        ops: null,
        error: null,
        loading: true,
        inflight: promise,
      });
    }, FETCH_DELAY_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [key, service, loadOperations]);

  // Partition the loaded operations into "top calls" (by volume) and
  // "erroring calls" (any with errorRate > 0, sorted by error count).
  const topCalls = ops ? ops.slice(0, TOP_CALLS_LIMIT) : [];
  const erroringCalls = ops
    ? ops
        .filter((op) => op.errors > 0)
        .sort((a, b) => b.errors - a.errors || b.errorRate - a.errorRate)
        .slice(0, TOP_ERROR_LIMIT)
    : [];

  // Compute req/min assuming buckets cover the full window
  let reqPerMin = 0;
  let rangeMs = 0;
  if (buckets.length >= 2) {
    rangeMs = buckets[buckets.length - 1].bucketMs - buckets[0].bucketMs;
  }
  if (summary && rangeMs > 0) {
    reqPerMin = summary.requests / (rangeMs / 60_000);
  }

  const reqSpark = buckets.map((b) => ({ t: b.bucketMs, v: b.requests }));
  const p95Spark = buckets.map((b) => ({ t: b.bucketMs, v: b.p95Us }));
  const errSpark = buckets.map((b) => ({
    t: b.bucketMs,
    v: b.requests > 0 ? (b.errors / b.requests) * 100 : 0,
  }));

  return (
    <div
      className={`${s.card} ${pinned ? s.cardPinned : ''}`}
      style={{ left, top }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={s.header}>
        <span className={s.healthDot} style={{ background: health.color }} />
        <span className={s.name}>{service}</span>
        {pinned && (
          <button
            type="button"
            className={s.closeBtn}
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>

      <div className={s.statusLine}>{health.label}</div>

      {!summary ? (
        <div className={s.missing}>No traffic for this service in the selected range.</div>
      ) : (
        <>
          <div className={s.stats}>
            <span className={s.statLabel}>Requests</span>
            <span className={s.statValue}>{summary.requests.toLocaleString()}</span>
            <span className={s.statLabel}>Rate</span>
            <span className={s.statValue}>
              {fmtRate(reqPerMin)}
              {prevSummary && prevSummary.requests > 0 && (
                <span
                  className={
                    summary.requests / prevSummary.requests <= 0.5
                      ? s.statDeltaBad
                      : s.statDelta
                  }
                >
                  {' '}
                  {(() => {
                    const pct = Math.round(
                      ((summary.requests - prevSummary.requests) /
                        prevSummary.requests) *
                        100,
                    );
                    return `${pct >= 0 ? '+' : ''}${pct}% vs prior`;
                  })()}
                </span>
              )}
            </span>
            <span className={s.statLabel}>Errors</span>
            <span
              className={`${s.statValue} ${summary.errorRate > 0 ? s.statValueErr : ''}`}
            >
              {(summary.errorRate * 100).toFixed(2)}%
            </span>
            <span className={s.statLabel}>p50</span>
            <span className={s.statValue}>{fmtUs(summary.p50Us)}</span>
            <span className={s.statLabel}>p95</span>
            <span className={s.statValue}>{fmtUs(summary.p95Us)}</span>
            <span className={s.statLabel}>p99</span>
            <span className={s.statValue}>{fmtUs(summary.p99Us)}</span>
          </div>

          {reqSpark.length >= 2 && (
            <div className={s.sparkBlock}>
              <div className={s.sparkLabel}>
                <span>Requests over time</span>
              </div>
              <div className={s.sparkSvgWrap}>
                <Sparkline
                  data={reqSpark}
                  width={272}
                  height={28}
                  color={health.color}
                  fill
                  ariaLabel={`${service} request rate sparkline`}
                />
              </div>
            </div>
          )}

          {p95Spark.length >= 2 && (
            <div className={s.sparkBlock}>
              <div className={s.sparkLabel}>
                <span>p95 latency over time</span>
              </div>
              <div className={s.sparkSvgWrap}>
                <Sparkline
                  data={p95Spark}
                  width={272}
                  height={28}
                  color="#6366f1"
                  strokeWidth={1.5}
                  ariaLabel={`${service} p95 sparkline`}
                />
              </div>
            </div>
          )}

          {summary.errorRate > 0 && errSpark.length >= 2 && (
            <div className={s.sparkBlock}>
              <div className={s.sparkLabel}>
                <span>Error rate over time</span>
              </div>
              <div className={s.sparkSvgWrap}>
                <Sparkline
                  data={errSpark}
                  width={272}
                  height={28}
                  color="#dc2626"
                  fill
                  ariaLabel={`${service} error rate sparkline`}
                />
              </div>
            </div>
          )}

          {/* Lazy-loaded operation breakdown. Renders nothing until
           * data arrives; shows a skeleton line while loading so the
           * tooltip doesn't jump in height when the fetch lands. */}
          {loadOperations && (
            <div className={s.opsSection}>
              <div className={s.opsHeader}>Top API calls</div>
              {loading && <div className={s.opsLoading}>Loading…</div>}
              {loadErr && <div className={s.opsError}>{loadErr}</div>}
              {!loading && !loadErr && topCalls.length === 0 && (
                <div className={s.opsEmpty}>No operations recorded.</div>
              )}
              {!loading && !loadErr && topCalls.length > 0 && (
                <ul className={s.opsList}>
                  {topCalls.map((op) => (
                    <li key={op.operation} className={s.opsRow}>
                      <span className={s.opsName} title={op.operation}>
                        {op.operation}
                      </span>
                      <span className={s.opsCount}>
                        {op.requests.toLocaleString()}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {loadOperations && erroringCalls.length > 0 && (
            <div className={s.opsSection}>
              <div className={`${s.opsHeader} ${s.opsHeaderErr}`}>
                Erroring calls
              </div>
              <ul className={s.opsList}>
                {erroringCalls.map((op) => (
                  <li key={op.operation} className={s.opsRow}>
                    <span className={s.opsName} title={op.operation}>
                      {op.operation}
                    </span>
                    <span className={`${s.opsCount} ${s.opsCountErr}`}>
                      {op.errors.toLocaleString()} ·{' '}
                      {(op.errorRate * 100).toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}

      <div className={s.tooltipActions}>
        <Link to={`/service/${encodeURIComponent(service)}`} className={s.openLink}>
          View service detail →
        </Link>
        <InvestigateButton
          seed={buildNodeSeed(service, summary, prevSummary, ops, lookback)}
          title={`Investigate ${service}`}
        />
      </div>

      {!pinned && <div className={s.pinHint}>Click the node to pin this card</div>}
    </div>
  );
}

/**
 * Seed for "Investigate this service" triggered from the System
 * Architecture node tooltip. Threads the same lazy-loaded operation
 * data the tooltip shows so the agent starts with the same picture
 * the user sees.
 */
function buildNodeSeed(
  service: string,
  summary: ServiceSummary | undefined,
  prevSummary: ServiceSummary | undefined,
  ops: OperationSummary[] | null,
  lookback: string,
): InvestigationSeed {
  const signals: string[] = [];
  if (summary) {
    signals.push(`Error rate: ${(summary.errorRate * 100).toFixed(2)}%`);
    signals.push(`p95: ${summary.p95Us >= 1000 ? (summary.p95Us / 1000).toFixed(1) + 'ms' : summary.p95Us.toFixed(0) + 'μs'}`);
    signals.push(`Requests: ${summary.requests.toLocaleString()} in ${lookback}`);
  }
  if (prevSummary && summary) {
    const delta = (summary.errorRate - prevSummary.errorRate) * 100;
    if (Math.abs(delta) >= 0.5) {
      signals.push(
        `Error rate delta: ${delta >= 0 ? '▲' : '▼'}${Math.abs(delta).toFixed(2)}pp vs prior window`,
      );
    }
  }
  if (ops && ops.length > 0) {
    const erroring = ops
      .filter((o) => o.errorRate > 0)
      .sort((a, b) => b.errors - a.errors)
      .slice(0, 3);
    if (erroring.length > 0) {
      signals.push(
        `Top erroring operations: ${erroring.map((o) => `${o.operation} (${(o.errorRate * 100).toFixed(1)}%)`).join(', ')}`,
      );
    }
  }
  return {
    question: `Investigate the current state of the ${service} service (triggered from the System Architecture graph). Look at error rates, latency anomalies, and upstream/downstream dependencies.`,
    service,
    knownSignals: signals,
    earliest: lookback,
    latest: 'now',
  };
}
