/**
 * Decision-tree tests for the post-reconcile canary (ROADMAP P0.2).
 *
 * Staging validation is the eventual gate, but the canary's
 * decision logic is exercised here against a fake HttpClient so
 * each branch is pinned. Mirrors the structure of the
 * plan-guard tests: pure-input → expected-output, plus a few
 * stage-failure cases that mimic real API errors.
 */
import { beforeAll, describe, it, expect, vi } from 'vitest';
import type { HttpClient } from '@criblio/app-utils/provisioner';
import type { ProvisionCanaryReport, ProvisionProbeResult } from '@criblio/app-utils/provision-canary';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import {
  runCanary,
  CANARY_SENTINEL_SEARCH_ID,
  CANARY_LOOKUP_NAME,
  EVENT_CONTRACT_PROBE_NAME,
  eventContractProbe,
} from '../postReconcileCanary';

beforeAll(() => setCurrentDataset('otel'));

/** The report's probes, by role. The framework names them
 *  `sentinel <id>`, `lookup <name>`, and the extra probe's own name. */
function probes(report: ProvisionCanaryReport): {
  sentinel: ProvisionProbeResult;
  lookupJoin: ProvisionProbeResult;
  eventContract: ProvisionProbeResult;
} {
  const find = (pred: (name: string) => boolean) => {
    const p = report.probes.find((x) => pred(x.name));
    if (!p) throw new Error(`probe missing from ${JSON.stringify(report.probes.map((x) => x.name))}`);
    return p;
  };
  return {
    sentinel: find((n) => n.startsWith('sentinel ')),
    lookupJoin: find((n) => n === `lookup ${CANARY_LOOKUP_NAME}`),
    eventContract: find((n) => n === EVENT_CONTRACT_PROBE_NAME),
  };
}

/**
 * Fake HttpClient that scripts responses by query-substring.
 * runCanary issues one query each for the sentinel and the
 * lookup-join probe, then the event-contract send + read. Each query goes through:
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
    if (q.includes('event_id in ("criblapm-')) {
      return [{ rows: 2, types: 2, versions: 1, canaries: 2 }];
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
    const report = await runCanary(http, { contractPollAttempts: 1, contractPollMs: 0 });
    expect(probes(report).eventContract.message).toBe('generated-event round trip passed (2 rows, 2 datatypes, schema v1)');
    expect(report.ok).toBe(true);
    expect(probes(report).sentinel.ok).toBe(true);
    expect(probes(report).lookupJoin.ok).toBe(true);
    expect(probes(report).lookupJoin.message).toContain('joinable');
    expect(probes(report).lookupJoin.message).toContain('12/50');
    expect(probes(report).eventContract.ok).toBe(true);
  });
});

describe('runCanary — sentinel empty', () => {
  it('fails on empty sentinel without --first-install', async () => {
    const { http } = fakeHttp({
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 10 }],
    });
    const report = await runCanary(http, { contractPollAttempts: 1, contractPollMs: 0 });
    expect(report.ok).toBe(false);
    expect(probes(report).sentinel.ok).toBe(false);
    expect(probes(report).sentinel.message).toContain('ZERO');
  });

  it('tolerates empty sentinel under --first-install', async () => {
    const { http } = fakeHttp({
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 10 }],
    });
    const report = await runCanary(http, { firstInstall: true, contractPollAttempts: 1, contractPollMs: 0 });
    expect(probes(report).sentinel.ok).toBe(true);
    expect(probes(report).sentinel.tolerated).toBe(true);
    expect(probes(report).sentinel.message).toContain('first install');
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
    const report = await runCanary(http, { contractPollAttempts: 1, contractPollMs: 0 });
    expect(report.ok).toBe(false);
    expect(probes(report).lookupJoin.ok).toBe(false);
    expect(probes(report).lookupJoin.message).toMatch(/ZERO joined|unjoinable/);
  });

  it('tolerates zero-joined under --first-install (search not yet populated)', async () => {
    const { http } = fakeHttp({
      [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }],
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 50, joined: 0 }],
    });
    const report = await runCanary(http, { firstInstall: true, contractPollAttempts: 1, contractPollMs: 0 });
    expect(probes(report).lookupJoin.ok).toBe(true);
    expect(probes(report).lookupJoin.tolerated).toBe(true);
    expect(probes(report).lookupJoin.message).toContain('first install');
  });

  it('FAILS on zero root spans without --first-install', async () => {
    const { http } = fakeHttp({
      [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }],
      [`lookup ${CANARY_LOOKUP_NAME}`]: [{ total: 0, joined: 0 }],
    });
    const report = await runCanary(http, { contractPollAttempts: 1, contractPollMs: 0 });
    expect(probes(report).lookupJoin.ok).toBe(false);
    expect(probes(report).lookupJoin.message).toMatch(/no keys to sample/);
  });

  it('FAILS gracefully when the probe query throws', async () => {
    const { http } = fakeHttp(
      { [CANARY_SENTINEL_SEARCH_ID]: [{ jobName: CANARY_SENTINEL_SEARCH_ID }] },
      { throwOn: '/jobs' },
    );
    const report = await runCanary(http, { contractPollAttempts: 1, contractPollMs: 0 });
    expect(report.ok).toBe(false);
    expect(probes(report).sentinel.ok || probes(report).lookupJoin.ok).toBe(false);
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
      contractPollAttempts: 1,
      contractPollMs: 0,
    });
    expect(probes(report).sentinel.name).toBe('sentinel criblapm__custom_sentinel');
    expect(probes(report).sentinel.ok).toBe(true);
    expect(report.ok).toBe(true);
  });
});

describe('eventContractProbe — framework generated-event canary', () => {
  it('writes one sentinel per APM datatype through export, then reads it back', async () => {
    const queries: string[] = [];
    const probe = eventContractProbe({ contractPollAttempts: 1, contractPollMs: 0 });
    const result = await probe.run({
      query: async (kql) => {
        queries.push(kql);
        return kql.includes('summarize rows=count()') ? [{ rows: 2, types: 2, versions: 1, canaries: 2 }] : [];
      },
    } as Parameters<typeof probe.run>[0]);
    expect(result.ok).toBe(true);
    const [send, read] = queries;
    expect(send).toContain('print datatype="criblapm_alert"');
    expect(send).toContain('| union (print datatype="criblapm_deploy"');
    expect(send).toContain('producer="criblapm_contract_canary"');
    expect(send).toContain('record_kind="evaluation"');
    expect(send).toMatch(/event_id="criblapm-[a-z0-9]+-[a-z0-9]+:criblapm_alert"/);
    expect(send).toContain('| export tee=true to search "otel"');
    // The per-run columns of a real evaluation / deploy row: the canary id
    // as evaluation_id / version, and now() (raw KQL, not the string).
    const id = /event_id="(criblapm-[a-z0-9]+-[a-z0-9]+):criblapm_alert"/.exec(send)![1];
    expect(send).toContain(`evaluation_id="${id}", evaluated_at=now()`);
    expect(send).toContain(`version="${id}", first_seen=now()`);
    expect(send).not.toContain('"now()"');
    expect(read).toContain('coalesce(tostring(data_datatype), tostring(datatype)) in ("criblapm_alert", "criblapm_deploy")');
  });

  it('reports drift with the counts that explain it', async () => {
    const probe = eventContractProbe({ contractPollAttempts: 1, contractPollMs: 0 });
    const result = await probe.run({
      query: async (kql) => (kql.includes('summarize rows=count()') ? [{ rows: 1, types: 1, versions: 1, canaries: 1 }] : []),
    } as Parameters<typeof probe.run>[0]);
    expect(result.ok).toBe(false);
    expect(result.tolerated).toBe(false);
    expect(result.message).toContain('rows=1, types=1');
  });
});
