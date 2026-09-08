import { describe, it, expect } from 'vitest';
import { MetricsQueryError, runMetricsQuery, stepForRange } from '../metrics';

describe('stepForRange', () => {
  it('targets ~60 buckets across a relative range', () => {
    expect(stepForRange('-1h')).toBe(60); // 3600s / 60
    expect(stepForRange('-15m')).toBe(15); // 900s / 60
    expect(stepForRange('-24h')).toBe(1440); // 86400s / 60
    expect(stepForRange('-7d')).toBe(10080); // 604800s / 60
  });

  it('honors a custom bucket target', () => {
    expect(stepForRange('-1h', 30)).toBe(120);
  });

  it('never returns a step below 1 second', () => {
    expect(stepForRange('-30s', 60)).toBe(1);
  });

  it('falls back to 60s on an unparseable range', () => {
    expect(stepForRange('now')).toBe(60);
    expect(stepForRange('-1w')).toBe(60);
    expect(stepForRange('')).toBe(60);
  });
});

/**
 * The NDJSON framing contract moved into @criblio/app-utils 0.8.3, which
 * unit-tests it directly (`metrics-response.test.ts`). These stay as
 * consumer-side guards on the two behaviours APM actually depends on, so a
 * framework regression fails here rather than silently emptying a chart.
 */
describe('metrics NDJSON compatibility', () => {
  const sample = '{"_kind":"sample","svc":"checkout","_time":123,"_value":7}';

  it('accepts responses with inline rows while the header still says running', async () => {
    const body = `{"isFinished":false,"totalEventCount":1,"job":{"id":"mq-1","status":"running"}}\n${sample}\n`;
    await expect(runMetricsQuery('up', { transport: async () => body })).resolves.toEqual([{
      _time: 123,
      _value: 7,
      labels: { svc: 'checkout' },
    }]);
  });

  it('keeps accepting completed responses and bare sample streams', async () => {
    for (const body of [`{"isFinished":true,"totalEventCount":1,"job":{"status":"completed"}}\n${sample}`, sample]) {
      await expect(runMetricsQuery('up', { transport: async () => body })).resolves.toHaveLength(1);
    }
  });

  it('rejects explicit terminal failure states', async () => {
    await expect(runMetricsQuery('up', {
      transport: async () => '{"isFinished":false,"job":{"id":"mq-2","status":"failed"}}',
    })).rejects.toMatchObject({ code: 'query-failed' });
  });

  it('reports a truncated body instead of silently returning short data', async () => {
    await expect(runMetricsQuery('up', {
      transport: async () => `{"isFinished":false,"totalEventCount":2,"job":{"status":"running"}}\n${sample}`,
    })).rejects.toBeInstanceOf(MetricsQueryError);
  });
});
