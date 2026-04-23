/**
 * Map a service's recent stats into a health bucket + display color.
 *
 * Two independent signals feed the bucket:
 *
 *  - Error rate (primary): countif(status=error) / count(). Error-
 *    rate bucketing stays as-is — watch / warn / critical thresholds
 *    at 0 / 1% / 5%. Always-slow is not the same as unhealthy (the
 *    workload may just be compute-heavy), so latency doesn't drive
 *    color.
 *  - Traffic-drop: a significant fall in request rate vs the
 *    immediately-previous window of the same length. Catches the
 *    class of outages where a service is quietly starving for work
 *    (upstream kafka lag, stuck consumer, failed job runner) —
 *    error rate stays at 0, latency is fine, but requests just
 *    stop arriving. Error rate alone would keep the service green.
 *
 * Bucket precedence: if error rate is already at `warn`/`critical`
 * severity the error bucket wins (an erroring service is still
 * erroring regardless of volume). Below that, a significant traffic
 * drop promotes to `traffic_drop` so the signal doesn't get lost
 * among the green rows.
 */
import type { ServiceSummary } from '../api/types';

export type HealthBucket =
  | 'healthy'
  | 'watch'
  | 'warn'
  | 'critical'
  | 'idle'
  | 'silent'
  | 'traffic_drop'
  | 'latency_anomaly';

export interface HealthInfo {
  bucket: HealthBucket;
  color: string;
  label: string;
}

const HEALTH: Record<HealthBucket, { color: string; label: string }> = {
  healthy: { color: '#10b981', label: 'Healthy (0 errors)' },
  watch: { color: '#eab308', label: 'Watch (<1% errors)' },
  warn: { color: '#f59e0b', label: 'Warn (1–5% errors)' },
  critical: { color: '#dc2626', label: 'Critical (>5% errors)' },
  idle: { color: '#9ca3af', label: 'No recent traffic' },
  silent: {
    color: '#dc2626',
    label: 'Was busy in the prior window, fully silent now (likely down)',
  },
  traffic_drop: {
    color: '#a855f7',
    label: 'Traffic drop vs prior window',
  },
  latency_anomaly: {
    color: '#06b6d4',
    label: 'Latency anomaly vs prior window',
  },
};

/** Very subtle row-background tint for a health bucket, matched to
 * Cribl's semantic-token palette. Used by the Home catalog to scan
 * for issues without overpowering the identity color dots. */
const HEALTH_BG: Record<HealthBucket, string> = {
  healthy: 'transparent',
  watch: 'rgba(234, 179, 8, 0.08)',
  warn: 'rgba(245, 158, 11, 0.12)',
  critical: 'rgba(220, 38, 38, 0.12)',
  idle: 'transparent',
  silent: 'rgba(220, 38, 38, 0.12)',
  traffic_drop: 'rgba(168, 85, 247, 0.12)',
  latency_anomaly: 'rgba(6, 182, 212, 0.12)',
};

export function healthRowBg(bucket: HealthBucket): string {
  return HEALTH_BG[bucket];
}

export const HEALTH_LEGEND: Array<{ bucket: HealthBucket; color: string; label: string }> = [
  { bucket: 'healthy', ...HEALTH.healthy },
  { bucket: 'watch', ...HEALTH.watch },
  { bucket: 'warn', ...HEALTH.warn },
  { bucket: 'critical', ...HEALTH.critical },
  { bucket: 'silent', ...HEALTH.silent },
  { bucket: 'latency_anomaly', ...HEALTH.latency_anomaly },
  { bucket: 'traffic_drop', ...HEALTH.traffic_drop },
  { bucket: 'idle', ...HEALTH.idle },
];

/**
 * Minimum prior-window request count for the traffic-drop rule to
 * fire. Tuned to keep late-night troughs and synthetic traffic gaps
 * from misfiring — with fewer than this many samples in the prior
 * window, rate ratios are too noisy to trust.
 */
export const MIN_BASELINE_REQUESTS = 50;

/** Traffic-drop triggers when the current window has fallen to
 * this fraction (or below) of the prior window. 50% is the point
 * where the drop is meaningful enough to flag but large enough
 * to avoid false positives during routine minute-to-minute jitter. */
const TRAFFIC_DROP_THRESHOLD = 0.5;

export function serviceHealth(
  summary: ServiceSummary | undefined,
  prev?: ServiceSummary,
  /** Set of service names with at least one operation latency
   * anomaly in the current window. Optional so callers that don't
   * fetch anomaly data (SystemArchPage, etc.) keep working
   * unchanged. */
  anomalousServices?: Set<string>,
): HealthInfo {
  if (!summary || summary.requests === 0) {
    // "Was busy in the prior window, fully silent now" is materially
    // different from "always idle" — it usually means the service
    // crashed or got isolated. Promote those to the `silent` bucket
    // so the System Architecture graph can render them as ghost
    // nodes and the row tint matches a critical signal. Falls back
    // to `idle` (gray dashed) when there's no prior baseline either.
    if (prev && prev.requests >= MIN_BASELINE_REQUESTS) {
      return { bucket: 'silent', ...HEALTH.silent };
    }
    return { bucket: 'idle', ...HEALTH.idle };
  }
  const errInfo = healthFromRate(summary.errorRate);
  // Errors dominate when they're already significant — an erroring
  // service is still erroring. A persistent 25% error rate is still
  // a real problem that should be visible. Notification suppression
  // for persistent issues happens at the alert layer, not here.
  if (errInfo.bucket === 'critical' || errInfo.bucket === 'warn') {
    return errInfo;
  }
  // Latency anomaly beats traffic-drop in precedence — a specific
  // operation that's 5×+ slower than baseline is the more actionable
  // signal (it points at a named op), while traffic-drop is usually
  // a symptom of something upstream.
  if (anomalousServices?.has(summary.service)) {
    return { bucket: 'latency_anomaly', ...HEALTH.latency_anomaly };
  }
  // Traffic-drop rule. Requires a prior window with enough samples
  // to trust the ratio.
  if (prev && prev.requests >= MIN_BASELINE_REQUESTS) {
    const ratio = summary.requests / prev.requests;
    if (ratio <= TRAFFIC_DROP_THRESHOLD) {
      const dropPct = Math.round((1 - ratio) * 100);
      return {
        bucket: 'traffic_drop',
        color: HEALTH.traffic_drop.color,
        label: `Traffic down ${dropPct}% vs prior window`,
      };
    }
  }
  return errInfo;
}

/** Same bucketing logic, usable for anything with an error rate: edges, operations, ... */
export function healthFromRate(errorRate: number, requests: number = 1): HealthInfo {
  if (requests === 0) return { bucket: 'idle', ...HEALTH.idle };
  const errPct = errorRate * 100;
  if (errPct >= 5) return { bucket: 'critical', ...HEALTH.critical };
  if (errPct >= 1) return { bucket: 'warn', ...HEALTH.warn };
  if (errPct > 0) return { bucket: 'watch', ...HEALTH.watch };
  return { bucket: 'healthy', ...HEALTH.healthy };
}
