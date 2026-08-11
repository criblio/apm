/**
 * Guard: the modules a non-browser host (server-side investigation
 * runtime, Node harness) must be able to import stay importable in a
 * plain Node environment — no DOM, no window — and their injection
 * seams stay injectable.
 *
 * These tests run in vitest's default node environment on purpose.
 * If someone adds a top-level `window`/`document` dereference to any
 * module in this closure, the import itself throws and this file
 * fails before any assertion runs. (Lazy, call-time browser access —
 * like the browser SearchClient's query runner — is fine; it's the
 * import-time coupling that would break a Worker bundle.)
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import { buildAlertSeed, buildSeedPrompt } from '../agentContext';
import { APM_TOOL_DEFINITIONS } from '../agentToolDefs';
import { runPreflight, formatPreflightSignals } from '../agentPreflight';
import { assertReadOnlyKql } from '../kqlSafety';
import { createApmToolExecutors } from '../agentTools';
import { browserSearchClient, type SearchClient } from '../searchClient';
import { getTrace, listRecentDeploys, listServiceSummaries } from '../search';

describe('browser-free import surface', () => {
  // The query builders embed the current dataset id; give them a
  // valid one the same way queries.golden.test.ts does.
  beforeAll(() => setCurrentDataset('otel'));

  it('loads the shared agent modules without a DOM', () => {
    // Reaching this line at all proves the imports above evaluated
    // cleanly in node. Touch each so bundlers can't tree-shake them
    // out of the test.
    expect(typeof buildAlertSeed).toBe('function');
    expect(typeof buildSeedPrompt).toBe('function');
    expect(typeof runPreflight).toBe('function');
    expect(typeof formatPreflightSignals).toBe('function');
    expect(typeof assertReadOnlyKql).toBe('function');
    expect(typeof createApmToolExecutors).toBe('function');
    expect(typeof getTrace).toBe('function');
    expect(typeof listServiceSummaries).toBe('function');
    expect(typeof listRecentDeploys).toBe('function');
    expect(APM_TOOL_DEFINITIONS.length).toBeGreaterThan(0);
    expect(typeof browserSearchClient.runQuery).toBe('function');
  });

  it('runs the query verbs against an injected client, never the browser', async () => {
    const queries: string[] = [];
    const client: SearchClient = {
      runQuery: async (kql) => {
        queries.push(kql);
        return [];
      },
      flatFields: async () => false,
      serviceSummariesViaMetrics: async () => null,
      metricsReadEnabled: () => false,
    };

    // Each verb must complete using only the injected client. If any
    // of them still reached for the browser runtime, these calls
    // would throw in node instead of resolving.
    await expect(getTrace('deadbeefdeadbeef', '-1h', 'now', client)).resolves.toBeNull();
    await expect(listServiceSummaries('-1h', 'now', undefined, client)).resolves.toEqual([]);
    await expect(listRecentDeploys('-2h', 'now', client)).resolves.toEqual([]);
    expect(queries.length).toBe(3);
  });

  it('preflight completes on an injected client and reports the no-signal case', async () => {
    const client: SearchClient = {
      runQuery: async () => [],
      flatFields: async () => false,
      serviceSummariesViaMetrics: async () => null,
      metricsReadEnabled: () => false,
    };
    const result = await runPreflight('-1h', 'now', client);
    expect(result.silent).toEqual([]);
    expect(result.rateDrops).toEqual([]);
    expect(result.errorSpikes).toEqual([]);
    const lines = formatPreflightSignals(result);
    expect(lines.join('\n')).toMatch(/No traffic-drop/);
  });

  it('tool executors dispatch through the injected client', async () => {
    const queries: string[] = [];
    const client: SearchClient = {
      runQuery: async (kql) => {
        queries.push(kql);
        return [];
      },
      flatFields: async () => false,
      serviceSummariesViaMetrics: async () => null,
      metricsReadEnabled: () => false,
    };
    const executors = createApmToolExecutors({
      client,
      dataset: () => 'otel',
      metricsDataset: () => 'metrics',
    });
    expect(executors.requiresApproval()).toBe(false);

    // render_trace exercises getTrace through the client.
    const result = await executors.executeToolCall({
      id: 'call-1',
      name: 'render_trace',
      arguments: JSON.stringify({ traceId: 'deadbeefdeadbeef', description: 'test' }),
    });
    expect(result.id).toBe('call-1');
    expect(queries.length).toBe(1);
    expect((result.ui as { kind?: string } | undefined)?.kind).toBe('trace');
  });
});
