/**
 * Golden-file + invariant tests for every exported builder in
 * src/api/queries.ts (ROADMAP P0.3).
 *
 * Two things per builder:
 *   1. Snapshot the output string. Any change to the KQL needs an
 *      explicit `npx vitest -u` to regenerate — refactors that
 *      shift the output silently no longer slide past review.
 *   2. Apply the provision-guard invariants:
 *        - non-empty `dataset="…"` clause is present
 *        - no `(?i)` upstream of `export to lookup`
 *        - no `mv-expand` upstream of `export to lookup`
 *        - no empty `to lookup` name
 *      validateQuery() is the same code provision.ts runs over the
 *      plan; reusing it keeps the guard and the test fence in sync.
 *
 * Two negative regression tests at the end pin the June 2026
 * outage shapes (dataset="" + (?i) export) so they become a 3-line
 * test if they ever come back.
 *
 * Builders are called with sensible defaults — strings get a fake
 * "test-svc" / "test-op", limits stay at their defaults. The
 * snapshot's value is consistency over time; the invariant check
 * is what catches semantic regressions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as Q from '../queries';
import { validateQuery } from '../provisionGuard';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { setLowVolumeMode, getLowVolumeMode } from '../lowVolumeMode';

beforeAll(() => {
  // Anchor every builder against a known dataset name + lowVolume
  // off so snapshots don't depend on whatever state the framework
  // stores were left in by a prior test file.
  setCurrentDataset('otel');
  setLowVolumeMode(false);
});

/**
 * Registry of every exported builder in queries.ts with a
 * deterministic invocation. New exports must be added here or the
 * "every exported builder is covered" assertion at the end fails.
 *
 * Order matches the file for easy cross-reference.
 */
const BUILDERS: Array<{ id: string; call: () => string }> = [
  { id: 'errorPropagationRollup',        call: () => Q.errorPropagationRollup() },
  { id: 'services',                      call: () => Q.services() },
  { id: 'operations',                    call: () => Q.operations('test-svc') },
  { id: 'findTraces (no filters)',       call: () => Q.findTraces({}) },
  { id: 'findTraces (full filters)',     call: () => Q.findTraces({
      service: 'test-svc',
      operation: 'test-op',
      tags: 'error=true http.status_code=500',
      predicateKql: 'status_code == "2"',
      minDurationUs: 1000,
      maxDurationUs: 2_000_000,
      limit: 50,
    }) },
  { id: 'traceSpans',                    call: () => Q.traceSpans(['t1', 't2']) },
  { id: 'serviceSummary (all)',          call: () => Q.serviceSummary() },
  { id: 'serviceSummary (scoped)',       call: () => Q.serviceSummary('test-svc') },
  { id: 'prevWindowSummary',             call: () => Q.prevWindowSummary() },
  { id: 'alertEvaluator',                call: () => Q.alertEvaluator() },
  { id: 'alertEvaluatorExportState',     call: () => Q.alertEvaluatorExportState() },
  { id: 'alertHistorySend',              call: () => Q.alertHistorySend() },
  { id: 'noiseBudgetByService',          call: () => Q.noiseBudgetByService() },
  { id: 'serviceTimeSeries',             call: () => Q.serviceTimeSeries(60) },
  { id: 'serviceStatusCodeMix',          call: () => Q.serviceStatusCodeMix(60, 'test-svc') },
  { id: 'serviceOperations',             call: () => Q.serviceOperations('test-svc') },
  { id: 'serviceInstances',              call: () => Q.serviceInstances('test-svc') },
  { id: 'allServiceOperations',          call: () => Q.allServiceOperations() },
  { id: 'allOperationsSummary',          call: () => Q.allOperationsSummary() },
  { id: 'slowestTraces (all)',           call: () => Q.slowestTraces() },
  { id: 'slowestTraces (scoped)',        call: () => Q.slowestTraces('test-svc') },
  { id: 'rawSlowestTraces',              call: () => Q.rawSlowestTraces() },
  { id: 'rawRecentErrorSpans',           call: () => Q.rawRecentErrorSpans() },
  { id: 'podUptime',                     call: () => Q.podUptime('test-svc') },
  { id: 'errorRateHistory',              call: () => Q.errorRateHistory() },
  { id: 'attrCatalog',                   call: () => Q.attrCatalog() },
  { id: 'traceOriginators',              call: () => Q.traceOriginators() },
  { id: 'recentErrorTraces (all)',       call: () => Q.recentErrorTraces() },
  { id: 'recentErrorTraces (scoped)',    call: () => Q.recentErrorTraces('test-svc') },
  { id: 'searchLogs',                    call: () => Q.searchLogs({
      service: 'test-svc',
      minSeverity: 17,
      bodyContains: 'connection refused',
      limit: 100,
    }) },
  { id: 'logServices',                   call: () => Q.logServices() },
  { id: 'traceLogs',                     call: () => Q.traceLogs('t-abc') },
  { id: 'messagingDependencies',         call: () => Q.messagingDependencies() },
  { id: 'dependencies',                  call: () => Q.dependencies() },
  { id: 'attrValueDistribution',         call: () => Q.attrValueDistribution('http.method', 'status_code == "2"') },
  { id: 'spotlightAttrDiff',             call: () => Q.spotlightAttrDiff('http.method', 'status_code == "2"') },
  { id: 'listMetricNames',               call: () => Q.listMetricNames() },
  { id: 'metricSampleRecords',           call: () => Q.metricSampleRecords() },
  { id: 'metricServices',                call: () => Q.metricServices('http.server.request.duration') },
  { id: 'metricTimeSeries (basic)',      call: () => Q.metricTimeSeries({
      metric: 'http.server.request.duration',
      binSeconds: 60,
      agg: 'p95',
    }) },
  { id: 'metricTimeSeries (grouped)',    call: () => Q.metricTimeSeries({
      metric: 'http.server.request.duration',
      service: 'test-svc',
      binSeconds: 60,
      agg: 'rate',
      groupBy: 'http.route',
    }) },
  { id: 'metricSampleRow',               call: () => Q.metricSampleRow('http.server.request.duration') },
  { id: 'serviceMetricSampleRecords',    call: () => Q.serviceMetricSampleRecords('test-svc') },
  { id: 'serviceMetricLatest',           call: () => Q.serviceMetricLatest('test-svc', 'process.runtime.go.goroutines') },
  { id: 'serviceMetricDelta',            call: () => Q.serviceMetricDelta('test-svc', 'k8s.container.restarts') },
  { id: 'serviceMetricTimeSeries',       call: () => Q.serviceMetricTimeSeries('test-svc', 'http.server.request.duration', 60) },
  { id: 'operationAnomaliesFromLookup',  call: () => Q.operationAnomaliesFromLookup(3, 250000, 100, 50) },
  { id: 'serviceMetricsBatch',           call: () => Q.serviceMetricsBatch('test-svc', ['m.a', 'm.b'], 60) },
];

describe('queries.ts — golden snapshots + invariants', () => {
  for (const { id, call } of BUILDERS) {
    describe(id, () => {
      it('snapshot stable', () => {
        expect(call()).toMatchSnapshot();
      });
      it('passes provision-guard invariants', () => {
        expect(validateQuery(id, call())).toEqual([]);
      });
    });
  }

  it('covers every exported function in queries.ts', async () => {
    // Lightweight reflection — if a new builder is added but not
    // registered above, this fails so the author has to add a row.
    const mod = await import('../queries');
    const exported = Object.entries(mod)
      .filter(([, v]) => typeof v === 'function')
      .map(([k]) => k);
    const covered = new Set(BUILDERS.map((b) => b.id.split(' ')[0]));
    const missing = exported.filter((name) => !covered.has(name));
    expect(missing).toEqual([]);
  });
});

describe('queries.ts — June 2026 outage regressions', () => {
  it('FAILS validation when the dataset store is empty (dataset="" wipeout shape)', () => {
    setCurrentDataset('');
    const errs = validateQuery('serviceSummary', Q.serviceSummary());
    setCurrentDataset('otel'); // restore for following tests
    expect(errs.some((e) => e.includes('empty dataset'))).toBe(true);
  });

  it('rejects a hand-rolled (?i)+export-to-lookup query', () => {
    // Demonstrates the validator catches the specific shape that
    // shipped through PR #66 → silently broke trace_originators.
    const broken = `dataset="otel" | where _raw matches regex "(?i)consume"
      | export mode=overwrite to lookup criblapm_trace_originators`;
    const errs = validateQuery('hand-rolled-bad', broken);
    expect(errs.some((e) => e.includes('(?i)'))).toBe(true);
  });

  it('low-volume mode (P1.2) injects a 4th detection arm when on', () => {
    expect(getLowVolumeMode()).toBe(false);
    const off = Q.alertEvaluator();
    expect(off.includes('curr_errors >= 2 and curr_err_pct >= 1')).toBe(false);
    setLowVolumeMode(true);
    try {
      const on = Q.alertEvaluator();
      expect(on.includes('curr_errors >= 2 and curr_err_pct >= 1')).toBe(true);
      // Invariants still hold with the extra arm
      expect(validateQuery('alertEvaluator (low-vol)', on)).toEqual([]);
    } finally {
      setLowVolumeMode(false);
    }
  });

  it('current traceOriginators builder does NOT regress the (?i) shape', () => {
    // The character-class rewrite landed in PR #70. This test pins
    // that the live builder stays compliant — any future revert
    // shows up here as a red test.
    expect(validateQuery('traceOriginators', Q.traceOriginators())).toEqual([]);
  });
});
