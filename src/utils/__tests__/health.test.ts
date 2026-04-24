import { describe, it, expect } from 'vitest';
import { serviceHealth, healthFromRate, MIN_BASELINE_REQUESTS } from '../health';
import type { ServiceSummary } from '../../api/types';

function makeSummary(overrides: Partial<ServiceSummary> = {}): ServiceSummary {
  return {
    service: 'test',
    requests: 1000,
    errors: 0,
    errorRate: 0,
    p50Us: 1000,
    p95Us: 5000,
    p99Us: 10000,
    ...overrides,
  };
}

describe('healthFromRate', () => {
  it('0% → healthy', () => {
    expect(healthFromRate(0).bucket).toBe('healthy');
  });

  it('0.5% → watch', () => {
    expect(healthFromRate(0.005).bucket).toBe('watch');
  });

  it('1% → warn', () => {
    expect(healthFromRate(0.01).bucket).toBe('warn');
  });

  it('5% → critical', () => {
    expect(healthFromRate(0.05).bucket).toBe('critical');
  });

  it('0 requests → idle', () => {
    expect(healthFromRate(0, 0).bucket).toBe('idle');
  });
});

describe('serviceHealth', () => {
  it('no summary → idle', () => {
    expect(serviceHealth(undefined).bucket).toBe('idle');
  });

  it('zero requests, no prev → idle', () => {
    expect(serviceHealth(makeSummary({ requests: 0 })).bucket).toBe('idle');
  });

  it('zero requests, prev had traffic → silent', () => {
    const prev = makeSummary({ requests: 100 });
    expect(serviceHealth(makeSummary({ requests: 0 }), prev).bucket).toBe('silent');
  });

  it('zero requests, prev had low traffic → idle (not silent)', () => {
    const prev = makeSummary({ requests: MIN_BASELINE_REQUESTS - 1 });
    expect(serviceHealth(makeSummary({ requests: 0 }), prev).bucket).toBe('idle');
  });

  it('high error rate → critical', () => {
    expect(serviceHealth(makeSummary({ errorRate: 0.06 })).bucket).toBe('critical');
  });

  it('medium error rate → warn', () => {
    expect(serviceHealth(makeSummary({ errorRate: 0.02 })).bucket).toBe('warn');
  });

  it('low error rate → watch', () => {
    expect(serviceHealth(makeSummary({ errorRate: 0.001 })).bucket).toBe('watch');
  });

  it('error rate dominates over traffic drop', () => {
    const curr = makeSummary({ requests: 20, errorRate: 0.06 });
    const prev = makeSummary({ requests: 100 });
    expect(serviceHealth(curr, prev).bucket).toBe('critical');
  });

  it('traffic drop detected when error rate is low', () => {
    const curr = makeSummary({ requests: 20, errorRate: 0 });
    const prev = makeSummary({ requests: 100 });
    expect(serviceHealth(curr, prev).bucket).toBe('traffic_drop');
  });

  it('latency anomaly detected', () => {
    const anomalous = new Set(['test']);
    expect(serviceHealth(makeSummary(), undefined, anomalous).bucket).toBe('latency_anomaly');
  });

  it('error rate dominates over latency anomaly', () => {
    const anomalous = new Set(['test']);
    expect(serviceHealth(makeSummary({ errorRate: 0.06 }), undefined, anomalous).bucket).toBe('critical');
  });

  it('latency anomaly dominates over traffic drop', () => {
    const curr = makeSummary({ requests: 20 });
    const prev = makeSummary({ requests: 100 });
    const anomalous = new Set(['test']);
    expect(serviceHealth(curr, prev, anomalous).bucket).toBe('latency_anomaly');
  });
});
