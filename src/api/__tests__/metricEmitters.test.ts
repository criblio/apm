import { describe, it, expect, afterEach } from 'vitest';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { metricRequestsExport, metricDurationExport } from '../queries';
import {
  promServiceRequests,
  promServiceErrors,
  promServiceLatencyQuantile,
  METRIC_REQUESTS_TOTAL,
  METRIC_REQUEST_DURATION_MS,
} from '../metricNames';
import { getProvisioningPlan } from '../provisionedSearches';
import { setMetricsEmit } from '../metricsEmit';

// Set before the describe bodies below call the builders (which quote the
// dataset id at build time and reject an empty one).
setCurrentDataset('otel');
afterEach(() => setMetricsEmit(false));

describe('metricRequestsExport (counter emitter)', () => {
  const q = metricRequestsExport();
  it('renames the summarize bin column to _time (else export drops all events)', () => {
    expect(q).toContain('project-rename _time=bin_time_1m');
  });
  it('emits a counter via typeField (not the literal type= param)', () => {
    expect(q).toContain('typeField=type');
    expect(q).toContain('type="counter"');
    expect(q).not.toMatch(/export to metrics[^|]*\btype=counter\b/);
  });
  it('labels by svc and outcome, names the metric criblapm_requests_total', () => {
    expect(q).toContain('labelFields=[svc, operation, outcome]');
    expect(q).toContain(`name="${METRIC_REQUESTS_TOTAL}"`);
    expect(q).toContain('outcome=iff(tostring(status.code)=="2", "error", "ok")');
  });
});

describe('metricDurationExport (histogram emitter)', () => {
  const q = metricDurationExport();
  it('uses the LITERAL type=histogram param (typeField would drop as invalid_type)', () => {
    expect(q).toContain('export to metrics type=histogram');
    expect(q).not.toContain('typeField');
  });
  it('emits raw per-span dur_ms (not an aggregate) so the store can bucket it', () => {
    expect(q).toContain('valueField=dur_ms');
    expect(q).toContain('project _time, svc, operation, dur_ms');
    expect(q).not.toContain('percentile(');
  });
});

describe('promServiceRequests / Errors / LatencyQuantile (read builders)', () => {
  it('reads counters with sum_over_time, NOT rate (delta storage)', () => {
    expect(promServiceRequests('1h')).toBe(
      `sum(sum_over_time(${METRIC_REQUESTS_TOTAL}[1h])) by (svc)`,
    );
    expect(promServiceRequests()).toContain('[5m]'); // default window
  });
  it('slices errors by the outcome label', () => {
    expect(promServiceErrors('15m')).toContain('{outcome="error"}');
  });
  it('reads latency via histogram_quantile and clamps q to [0,1]', () => {
    expect(promServiceLatencyQuantile(0.95, '1h')).toBe(
      `histogram_quantile(0.95, sum(rate(${METRIC_REQUEST_DURATION_MS}[1h])) by (le, svc))`,
    );
    expect(promServiceLatencyQuantile(9)).toContain('histogram_quantile(1,');
  });
});

describe('getProvisioningPlan metrics-emit gating', () => {
  const metricIds = ['criblapm__metric_requests', 'criblapm__metric_req_lat_p95'];
  it('excludes the emitters when metricsEmit is off', () => {
    setMetricsEmit(false);
    const ids = getProvisioningPlan().map((s) => s.id);
    for (const id of metricIds) expect(ids).not.toContain(id);
  });
  it('includes the emitters when metricsEmit is on', () => {
    setMetricsEmit(true);
    const plan = getProvisioningPlan();
    const ids = plan.map((s) => s.id);
    for (const id of metricIds) expect(ids).toContain(id);
    // non-overlapping minute-aligned window
    const req = plan.find((s) => s.id === 'criblapm__metric_requests')!;
    expect(req.latest).toBe('@m');
    expect(req.earliest).toMatch(/^-\d+[smhd]@m$/);
  });
});
