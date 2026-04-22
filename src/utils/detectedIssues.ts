import { MIN_BASELINE_REQUESTS } from './health';
import type { CachedAlertRow } from '../api/panelCache';
import type {
  ServiceSummary,
  DependencyEdge,
  OperationAnomaly,
  DetectedIssue,
} from '../api/types';
import { serviceHealth } from './health';

const SEVERITY_ORDER: Record<DetectedIssue['signalType'], number> = {
  error_rate_critical: 0,
  silent: 1,
  traffic_drop: 2,
  latency_anomaly: 3,
  error_rate_warn: 4,
};

function fmtPct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function fmtUs(us: number): string {
  if (us < 1000) return `${us.toFixed(0)}us`;
  if (us < 1_000_000) return `${(us / 1000).toFixed(1)}ms`;
  return `${(us / 1_000_000).toFixed(2)}s`;
}

function fmtRate(requests: number, rangeMinutes: number): string {
  const rpm = rangeMinutes > 0 ? requests / rangeMinutes : 0;
  if (rpm >= 1000) return `${(rpm / 1000).toFixed(1)}k/min`;
  if (rpm >= 10) return `${rpm.toFixed(0)}/min`;
  return `${rpm.toFixed(1)}/min`;
}

export function buildDetectedIssues(
  summaries: ServiceSummary[],
  prevByService: Map<string, ServiceSummary>,
  edges: DependencyEdge[],
  anomalies: OperationAnomaly[],
  anomalousServices: Set<string>,
  rangeMinutes: number,
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  // Root-cause hints from dependency edges
  const rootCauseByParent = new Map<string, string>();
  const byParent = new Map<string, Array<{ child: string; calls: number; errors: number }>>();
  for (const e of edges) {
    if ((e.kind ?? 'rpc') !== 'rpc') continue;
    if (e.parent === e.child || e.callCount < 5) continue;
    const list = byParent.get(e.parent) ?? [];
    list.push({ child: e.child, calls: e.callCount, errors: e.errorCount });
    byParent.set(e.parent, list);
  }
  for (const [parent, edgeList] of byParent) {
    let best: { child: string; errorRate: number } | null = null;
    for (const ed of edgeList) {
      if (ed.errors === 0) continue;
      const rate = ed.errors / ed.calls;
      if (rate < 0.005) continue;
      if (!best || rate > best.errorRate) {
        best = { child: ed.child, errorRate: rate };
      }
    }
    if (best) rootCauseByParent.set(parent, best.child);
  }

  for (const svc of summaries) {
    const prev = prevByService.get(svc.service);
    const health = serviceHealth(svc, prev, anomalousServices);
    const hint = rootCauseByParent.get(svc.service);

    switch (health.bucket) {
      case 'critical': {
        const prevRate = prev ? fmtPct(prev.errorRate) : '0.0%';
        issues.push({
          service: svc.service,
          signalType: 'error_rate_critical',
          severity: 'critical',
          detail: `Error rate ${fmtPct(svc.errorRate)} (was ${prevRate})`,
          rootCauseHint: hint ? `errors on calls to ${hint}` : undefined,
        });
        break;
      }
      case 'warn': {
        const prevRate = prev ? fmtPct(prev.errorRate) : '0.0%';
        issues.push({
          service: svc.service,
          signalType: 'error_rate_warn',
          severity: 'warn',
          detail: `Error rate ${fmtPct(svc.errorRate)} (was ${prevRate})`,
          rootCauseHint: hint ? `errors on calls to ${hint}` : undefined,
        });
        break;
      }
      case 'watch':
        // Stable baseline error rate — serviceHealth downgraded to
        // watch because previous window had similar errors. Not a
        // new issue, don't surface in detected issues panel.
        break;
      case 'traffic_drop': {
        const ratio = prev ? Math.round((1 - svc.requests / prev.requests) * 100) : 0;
        issues.push({
          service: svc.service,
          signalType: 'traffic_drop',
          severity: 'critical',
          detail: `Request rate dropped ${ratio}% (was ${fmtRate(prev?.requests ?? 0, rangeMinutes)})`,
          rootCauseHint: hint ? `errors on calls to ${hint}` : undefined,
        });
        break;
      }
      case 'latency_anomaly':
        // Individual anomaly rows added below
        break;
      default:
        break;
    }
  }

  // Silent services: present in prev window but absent or zero in current
  const currentServices = new Set(summaries.filter((s) => s.requests > 0).map((s) => s.service));
  for (const [svcName, prev] of prevByService) {
    if (currentServices.has(svcName)) continue;
    if (prev.requests < MIN_BASELINE_REQUESTS) continue;
    issues.push({
      service: svcName,
      signalType: 'silent',
      severity: 'critical',
      detail: `No traffic (was ${fmtRate(prev.requests, rangeMinutes)})`,
    });
  }

  // Latency anomalies — one row per anomalous operation
  for (const a of anomalies) {
    issues.push({
      service: a.service,
      signalType: 'latency_anomaly',
      severity: 'warn',
      detail: `${a.operation} p95 ${fmtUs(a.currP95Us)} (baseline ${fmtUs(a.prevP95Us)}, ${a.ratio.toFixed(0)}x)`,
      operation: a.operation,
    });
  }

  // Sort: severity tier first, then magnitude within tier
  issues.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.signalType];
    const sb = SEVERITY_ORDER[b.signalType];
    if (sa !== sb) return sa - sb;
    return 0;
  });

  return issues;
}

/**
 * Build detected issues from the cached alert rows (from the
 * criblapm__home_alerts scheduled search). The server-side query
 * already computed is_bad and signal_type, so we use those directly
 * instead of re-deriving client-side. Also includes alertStatus
 * from the server-side state machine.
 */
export function buildDetectedIssuesFromCache(
  rows: CachedAlertRow[],
  rangeMinutes: number,
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];

  for (const r of rows) {
    if (!r.isBad) continue;

    const signalMap: Record<string, DetectedIssue['signalType']> = {
      error_rate: r.currErrorRate * 100 >= 5 ? 'error_rate_critical' : 'error_rate_warn',
      traffic_drop: 'traffic_drop',
      silent: 'silent',
    };
    const signalType = signalMap[r.signalType];
    if (!signalType) continue;

    const severityMap: Record<DetectedIssue['signalType'], DetectedIssue['severity']> = {
      error_rate_critical: 'critical',
      error_rate_warn: 'warn',
      traffic_drop: 'critical',
      latency_anomaly: 'warn',
      silent: 'critical',
    };

    let detail: string;
    switch (r.signalType) {
      case 'error_rate':
        detail = `Error rate ${fmtPct(r.currErrorRate)} (was ${fmtPct(r.prevErrorRate)})`;
        break;
      case 'traffic_drop': {
        const dropPct = Math.round((1 - r.currRequests / r.prevRequests) * 100);
        detail = `Request rate dropped ${dropPct}% (was ${fmtRate(r.prevRequests, rangeMinutes)})`;
        break;
      }
      case 'silent':
        detail = `No traffic (was ${fmtRate(r.prevRequests, rangeMinutes)})`;
        break;
      default:
        continue;
    }

    const alertStatus = (['ok', 'pending', 'firing', 'resolving'].includes(r.alertStatus)
      ? r.alertStatus
      : 'ok') as DetectedIssue['alertStatus'];

    issues.push({
      service: r.service,
      signalType,
      severity: severityMap[signalType],
      detail,
      alertStatus,
    });
  }

  issues.sort((a, b) => {
    const sa = SEVERITY_ORDER[a.signalType];
    const sb = SEVERITY_ORDER[b.signalType];
    if (sa !== sb) return sa - sb;
    return 0;
  });

  return issues;
}
