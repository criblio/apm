/**
 * Decision-tree tests for the post-reconcile canary (ROADMAP P0.2).
 *
 * Staging validation is the eventual gate, but the canary's
 * decision logic is exercised here against a fake HttpClient so
 * each branch is pinned. Mirrors the structure of the
 * provisionGuard tests: pure-input → expected-output, plus a few
 * stage-failure cases that mimic real API errors.
 */
import { describe, it, expect, vi } from 'vitest';
import type { HttpClient } from '@cribl/app-utils/provisioner';
import {
  runCanary,
  CANARY_SENTINEL_SEARCH_ID,
  CANARY_LOOKUP_NAME,
} from '../postReconcileCanary';

/**
 * Fake HttpClient that scripts responses by query-substring.
 * runCanary issues three queries per run (sentinel, probe-key
 * discovery, lookup-join probe). Each query goes through:
 *
 *   POST /m/default_search/search/jobs       → {items:[{id,status:"completed"}]}
 *   GET  /m/default_search/search/jobs/:id   → {items:[{status:"completed"}]}
 *   GET  /m/default_search/search/jobs/:id/results → NDJSON string
 *
 * The fake matches POST bodies by query substring and returns the
 * configured NDJSON text for that case. Job IDs are recycled per
 * query so we don't have to track them.
 */
function fakeHttp(
  rowsByQuerySubstring: Record<string, Record<string, unknown>[]>,
  opts: { throwOn?: string } = {},
): { http: HttpClient; calls: { method: string; path: string }[] } {
  const calls: { method: string; path: string }[] = [];
  let lastQuery = '';

  const findRowsFor = (q: string): Record<string, unknown>[] => {
    for (const [needle, rows] of Object.entries(rowsByQuerySubstring)) {
      if (q.includes(needle)) return rows;
    }
    return [];
  };

  const ndjsonFor = (rows: Record<string, unknown>[]): string => {
    // First line is the job-meta header that runCanaryQuery skips
    // (i=1.. in the parsing loop). Match the upstream format.
    const header = JSON.stringify({ isFinished: true, totalEventCount: rows.length });
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    return rows.length > 0 ? `${header}\n${body}\n` : `${header}\n`;
  };

  const http: HttpClient = {
    post: vi.fn(async (path, body) => {
      calls.push({ method: 'POST', path });
      if (opts.throwOn && path.includes(opts.throwOn)) {
        throw new Error(`fakeHttp scripted error on ${opts.throwOn}`);
      }
      const b = body as { query?: string };
      lastQuery = b?.query ?? '';
      return { items: [{ id: 'job-fake-1', status: 'completed' }] };
    }),
    get: vi.fn(async (path: string) => {
      calls.push({ method: 'GET', path });
      // Poll: return completed immediately.
      if (path.endsWith('/job-fake-1') || /\/jobs\/[^/]+$/.test(path)) {
        return { items: [{ status: 'completed' }] };
      }
      // Results endpoint.
      if (path.includes('/results')) {
        return ndjsonFor(findRowsFor(lastQuery));
      }
      return {};
    }),
    patch: vi.fn(async () => ({})),
    del: vi.fn(async () => ({})),
  };

  return { http, calls };
}

describe('runCanary — happy path', () => {
  it('passes when sentinel has rows and sampled lookup join finds non-null matches', async () => {
    const { http } = fakeHttp({
      [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }],
      // Sampled join probe: 50 sampled, 12 joined non-null
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 12 }],
    });
    const report = await runCanary(http);
    expect(report.ok).toBe(true);
    expect(report.sentinel.ok).toBe(true);
    expect(report.lookupJoin.ok).toBe(true);
    expect(report.lookupJoin.message).toContain('joinable');
    expect(report.lookupJoin.message).toContain('12/50');
  });
});

describe('runCanary — sentinel empty', () => {
  it('fails on empty sentinel without --first-install', async () => {
    const { http } = fakeHttp({
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 10 }],
    });
    const report = await runCanary(http);
    expect(report.ok).toBe(false);
    expect(report.sentinel.ok).toBe(false);
    expect(report.sentinel.message).toContain('ZERO');
  });

  it('tolerates empty sentinel under --first-install', async () => {
    const { http } = fakeHttp({
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 10 }],
    });
    const report = await runCanary(http, { firstInstall: true });
    expect(report.sentinel.ok).toBe(true);
    expect(report.sentinel.message).toContain('first-install');
  });
});

describe('runCanary — lookup join failure shapes', () => {
  it('FAILS when sampled rows joined zero times (June outage shape)', async () => {
    const { http } = fakeHttp({
      [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }],
      // 50 root spans sampled, zero joined cleanly — the (?i)+
      // export-to-lookup bug shape that PR #70 was meant to fix.
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 0 }],
    });
    const report = await runCanary(http);
    expect(report.ok).toBe(false);
    expect(report.lookupJoin.ok).toBe(false);
    expect(report.lookupJoin.message).toMatch(/ZERO joined|unjoinable/);
  });

  it('tolerates zero-joined under --first-install (search not yet populated)', async () => {
    const { http } = fakeHttp({
      [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }],
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 0 }],
    });
    const report = await runCanary(http, { firstInstall: true });
    expect(report.lookupJoin.ok).toBe(true);
    expect(report.lookupJoin.message).toContain('first-install');
  });

  it('FAILS on zero root spans without --first-install', async () => {
    const { http } = fakeHttp({
      [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }],
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 0, joined: 0 }],
    });
    const report = await runCanary(http);
    expect(report.lookupJoin.ok).toBe(false);
    expect(report.lookupJoin.message).toMatch(/zero root spans/);
  });

  it('FAILS gracefully when the probe query throws', async () => {
    const { http } = fakeHttp(
      { [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }] },
      { throwOn: '/jobs' },
    );
    const report = await runCanary(http);
    expect(report.ok).toBe(false);
    expect(report.sentinel.ok || report.lookupJoin.ok).toBe(false);
  });
});

describe('runCanary — sentinel override', () => {
  it('uses opts.sentinelSearchId when provided', async () => {
    const { http } = fakeHttp({
      'criblapm__custom_sentinel': [{ jobName: 'criblapm__custom_sentinel' }],
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 5 }],
    });
    const report = await runCanary(http, {
      sentinelSearchId: 'criblapm__custom_sentinel',
    });
    expect(report.sentinel.message).toContain('criblapm__custom_sentinel');
    expect(report.ok).toBe(true);
  });
});
