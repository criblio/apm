import { describe, it, expect, afterEach } from 'vitest';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
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

/**
 * Every emitter in the provisioning plan, not just the two built directly
 * above. On 2026-10-04 Cribl Search removed the `export to metrics`
 * `typeField` parameter; all 13 scheduled emitters carried it, so each one
 * began failing at parse time with "unknown parameter for export operator:
 * typeField" and the metrics store went silent for 31 hours. Nothing caught
 * it: the per-emitter tests only covered two builders, and a failing
 * scheduled search is invisible from inside the app.
 *
 * Asserting across the plan is what makes this a family-wide guard. It
 * cannot detect the platform changing the contract again — only a live
 * export can — but it does stop an emitter being added or reverted with a
 * parameter the operator no longer accepts.
 */
describe('every metric emitter in the provisioning plan', () => {
  setMetricsEmit(true);
  const emitters = getProvisioningPlan().filter((s) => s.query.includes('export to metrics'));
  setMetricsEmit(false);

  it('includes the whole emitter family', () => {
    expect(emitters.length).toBeGreaterThanOrEqual(12);
  });

  it.each(emitters.map((e) => [e.id, e.query] as const))(
    '%s declares its kind with the literal type= and no typeField',
    (_id, query) => {
      expect(query).not.toContain('typeField');
      expect(query).toMatch(/export to metrics type=(counter|gauge|histogram)\b/);
    },
  );

  // Rule 1 from the emitter comment: binning INSIDE the `summarize … by`
  // clause names the column `bin_time_1m`, and an export that keeps that
  // name drops every event WITHOUT erroring — the other way these go quiet.
  // Emitters that bin in an earlier `extend` already group by `_time` and
  // need no rename, so only the `by bin(...)` form is checked.
  it.each(
    emitters
      .filter((e) => /by [^|]*bin\(_time, 1m\)/.test(e.query))
      .map((e) => [e.id, e.query] as const),
  )('%s renames the bin column back to _time', (_id, query) => {
    expect(query).toContain('project-rename _time=bin_time_1m');
  });

  // Whichever form it uses, the exported timeField must exist as `_time`.
  it.each(emitters.map((e) => [e.id, e.query] as const))(
    '%s exports timeField=_time and actually produces that column',
    (_id, query) => {
      expect(query).toContain('timeField=_time');
      expect(
        /project-rename _time=bin_time_1m/.test(query) || /_time=bin\(_time, 1m\)/.test(query),
      ).toBe(true);
    },
  );
});

describe('metricRequestsExport (counter emitter)', () => {
  const q = metricRequestsExport();
  it('renames the summarize bin column to _time (else export drops all events)', () => {
    expect(q).toContain('project-rename _time=bin_time_1m');
  });
  // Cribl Search removed `typeField` on 2026-10-04 and every emitter began
  // failing with "unknown parameter for export operator: typeField". The
  // literal now accepts counter/gauge/histogram, so no emitter may carry a
  // field reference — this asserts the whole family, not just this one.
  it('declares the counter kind with the literal type= param, never typeField', () => {
    expect(q).toContain('export to metrics type=counter');
    expect(q).not.toContain('typeField');
  });
  it('labels by svc and outcome, names the metric criblapm_requests_total', () => {
    expect(q).toContain('labelFields=[svc, operation, outcome]');
    expect(q).toContain(`name="${METRIC_REQUESTS_TOTAL}"`);
    expect(q).toContain('outcome=iff(tostring(status.code)=="2", "error", "ok")');
  });
});

describe('metricDurationExport (histogram emitter)', () => {
  const q = metricDurationExport();
  it('uses the LITERAL type=histogram param', () => {
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
