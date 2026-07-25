import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MetricSample } from '../metrics';

// Mock the cache layer (the seam metricsPanels actually calls) + the read
// gate so the dual-read logic is tested in isolation (no network, no
// cross-test cache state). The cache's own dedup/TTL behavior is covered
// in metricsCache.test.ts.
vi.mock('../metricsCache', () => ({ cachedQueryInstant: vi.fn(), cachedQueryRange: vi.fn() }));
vi.mock('../metricsRead', () => ({ getMetricsRead: vi.fn() }));

import { cachedQueryInstant as queryInstant } from '../metricsCache';
import { getMetricsRead } from '../metricsRead';
import {
  readServiceRedMetrics,
  redMetricsToServiceSummaries,
  listServiceSummariesViaMetrics,
} from '../metricsPanels';

const sample = (svc: string, v: number, outcome?: string): MetricSample => ({
  _time: 0,
  _value: v,
  labels: outcome ? { svc, outcome } : { svc },
});

beforeEach(() => {
  vi.mocked(queryInstant).mockReset();
  vi.mocked(getMetricsRead).mockReset();
});

describe('readServiceRedMetrics', () => {
  it('returns null (fall back) when metricsRead is off, without querying', async () => {
    vi.mocked(getMetricsRead).mockReturnValue(false);
    expect(await readServiceRedMetrics('-1h')).toBeNull();
    expect(queryInstant).not.toHaveBeenCalled();
  });

  it('merges per-svc samples and computes error rate when on', async () => {
    vi.mocked(getMetricsRead).mockReturnValue(true);
    vi.mocked(queryInstant)
      // combined counter: (svc, outcome) — a: 90 ok + 10 error, b: 50 ok
      .mockResolvedValueOnce([sample('a', 90, 'ok'), sample('a', 10, 'error'), sample('b', 50, 'ok')])
      .mockResolvedValueOnce([sample('a', 5)]) // p50
      .mockResolvedValueOnce([sample('a', 20)]) // p95
      .mockResolvedValueOnce([sample('a', 40)]); // p99

    const rows = await readServiceRedMetrics('-1h');
    expect(rows).not.toBeNull();
    const a = rows!.find((r) => r.svc === 'a')!;
    expect(a).toMatchObject({ requests: 100, errors: 10, errorRate: 0.1, p95Ms: 20 });
    const b = rows!.find((r) => r.svc === 'b')!;
    expect(b).toMatchObject({ requests: 50, errors: 0, errorRate: 0, p95Ms: null });
    // sorted by requests desc
    expect(rows![0].svc).toBe('a');
  });

  it('returns null when the request series is empty (miss, not empty table)', async () => {
    vi.mocked(getMetricsRead).mockReturnValue(true);
    vi.mocked(queryInstant).mockResolvedValue([]);
    expect(await readServiceRedMetrics('-1h')).toBeNull();
  });

  it('returns null (graceful) when a query throws', async () => {
    vi.mocked(getMetricsRead).mockReturnValue(true);
    vi.mocked(queryInstant).mockRejectedValue(new Error('boom'));
    expect(await readServiceRedMetrics('-1h')).toBeNull();
  });

  it('computes the PromQL window from [earliest, latest]', async () => {
    vi.mocked(getMetricsRead).mockReturnValue(true);
    vi.mocked(queryInstant).mockResolvedValue([sample('a', 1)]);
    await readServiceRedMetrics('-15m'); // latest defaults to now
    expect(vi.mocked(queryInstant).mock.calls[0][0]).toContain('[900s]'); // 15m
    // prior-comparison window: -2h..-1h spans 1h = 3600s
    vi.mocked(queryInstant).mockClear();
    await readServiceRedMetrics('-2h', '-1h');
    const call = vi.mocked(queryInstant).mock.calls[0];
    expect(call[0]).toContain('[3600s]');
    expect((call[1] as { earliest: string; latest: string }).latest).toBe('-1h');
  });
});

describe('redMetricsToServiceSummaries', () => {
  it('maps to ServiceSummary and converts ms → µs', () => {
    const [s] = redMetricsToServiceSummaries([
      { svc: 'a', requests: 100, errors: 3, errorRate: 0.03, p50Ms: 5, p95Ms: 20, p99Ms: 40 },
    ]);
    expect(s).toEqual({
      service: 'a', requests: 100, errors: 3, errorRate: 0.03,
      p50Us: 5000, p95Us: 20000, p99Us: 40000,
    });
  });
  it('treats null percentiles as 0µs', () => {
    const [s] = redMetricsToServiceSummaries([
      { svc: 'a', requests: 1, errors: 0, errorRate: 0, p50Ms: null, p95Ms: null, p99Ms: null },
    ]);
    expect(s.p95Us).toBe(0);
  });
});

describe('listServiceSummariesViaMetrics', () => {
  it('returns null (fall back) when metricsRead is off', async () => {
    vi.mocked(getMetricsRead).mockReturnValue(false);
    expect(await listServiceSummariesViaMetrics('-1h')).toBeNull();
  });
  it('returns mapped summaries when on', async () => {
    vi.mocked(getMetricsRead).mockReturnValue(true);
    vi.mocked(queryInstant)
      .mockResolvedValueOnce([sample('a', 95, 'ok'), sample('a', 5, 'error')]) // combined counter
      .mockResolvedValueOnce([sample('a', 5)]) // p50
      .mockResolvedValueOnce([sample('a', 20)]) // p95
      .mockResolvedValueOnce([sample('a', 40)]); // p99
    const rows = await listServiceSummariesViaMetrics('-1h');
    expect(rows).toEqual([
      { service: 'a', requests: 100, errors: 5, errorRate: 0.05, p50Us: 5000, p95Us: 20000, p99Us: 40000 },
    ]);
  });
});
