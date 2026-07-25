/**
 * Node job-runner deps for the metrics backfill (src/api/metricsBackfill.ts).
 * Mints its own Bearer token (client-credentials, same flow as
 * tests/helpers/criblSearch.ts) and runs Cribl Search jobs, reading the
 * NDJSON results the framework HttpClient can't (it JSON-parses whole
 * bodies). Used by scripts/provision.ts on `npm run deploy`.
 */
import { backfillSpanCounts } from '../src/api/queries.js';
import { coverageProbeQuery } from '../src/api/metricNames.js';
import type { BackfillDeps, SpanCountBin } from '../src/api/metricsBackfill.js';

interface JobRow {
  status?: string;
  [k: string]: unknown;
}

async function getToken(): Promise<{ token: string; base: string }> {
  const base = (process.env.CRIBL_BASE_URL ?? '').replace(/\/$/, '');
  const clientId = process.env.CRIBL_CLIENT_ID;
  const clientSecret = process.env.CRIBL_CLIENT_SECRET;
  if (!base || !clientId || !clientSecret) {
    throw new Error('CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET required for backfill');
  }
  const isStaging = /cribl-staging\.cloud/.test(base);
  const tokenUrl = isStaging
    ? 'https://login.cribl-staging.cloud/oauth/token'
    : 'https://login.cribl.cloud/oauth/token';
  const audience = isStaging ? 'https://api.cribl-staging.cloud' : 'https://api.cribl.cloud';
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience }),
  });
  if (!resp.ok) throw new Error(`backfill token exchange failed (${resp.status})`);
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('backfill token response missing access_token');
  return { token: data.access_token, base };
}

/** Run a job to completion and return its result rows (NDJSON parsed). */
async function runJob(
  base: string,
  token: string,
  query: string,
  earliest: string,
  latest: string,
  limit = 5000,
): Promise<JobRow[]> {
  const sb = `${base}/api/v1/m/default_search/search`;
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const create = await fetch(`${sb}/jobs`, { method: 'POST', headers, body: JSON.stringify({ query, earliest, latest }) });
  if (!create.ok) throw new Error(`job create failed (${create.status}): ${(await create.text()).slice(0, 300)}`);
  const job = ((await create.json()) as { items?: Array<{ id: string; status?: string }> }).items?.[0];
  if (!job?.id) throw new Error('job create: missing id');
  let status = job.status ?? 'queued';
  for (let i = 0; i < 600 && !['completed', 'failed', 'canceled'].includes(status); i++) {
    await new Promise((r) => setTimeout(r, 500));
    const poll = await fetch(`${sb}/jobs/${job.id}`, { headers });
    status = (((await poll.json()) as { items?: Array<{ status?: string }> }).items?.[0]?.status) ?? status;
  }
  if (status !== 'completed') throw new Error(`job ${job.id} ended: ${status}`);
  const res = await fetch(`${sb}/jobs/${job.id}/results?offset=0&limit=${limit}`, { headers });
  if (!res.ok) throw new Error(`job results failed (${res.status})`);
  const lines = (await res.text()).split('\n').filter((l) => l.trim());
  const rows: JobRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    try { rows.push(JSON.parse(lines[i]) as JobRow); } catch { /* skip */ }
  }
  return rows;
}

/**
 * Earliest epoch-SECONDS `metric` has a sample within [earliestMs,
 * latestMs], or null if none. A coarse-step range query over the metrics
 * engine (no search job); the backfill uses this to find the forward-emit /
 * prior-backfill boundary per metric and to skip already-covered windows.
 * Coarse precision is fine — the backfill's per-window coverage check
 * backstops any boundary imprecision against double-counting.
 */
export async function earliestCoveredSec(
  base: string,
  token: string,
  metric: string,
  kind: 'counter' | 'histogram',
  earliestMs: number,
  latestMs: number,
): Promise<number | null> {
  // Histograms probe via histogram_quantile(rate[5m]); pad the start by 5m
  // so the first step's rate window has its samples (else a small window
  // reads as uncovered — a false negative that would re-emit).
  const startMs = kind === 'histogram' ? earliestMs - 300_000 : earliestMs;
  const params = new URLSearchParams({
    query: coverageProbeQuery(metric, kind),
    earliest: String(startMs),
    latest: String(latestMs),
    step: '300',
    searchJobSource: 'metrics',
    datasetId: 'metrics',
  });
  const resp = await fetch(`${base}/api/v1/m/default_search/search/query?${params}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!resp.ok) return null;
  const lines = (await resp.text()).split('\n').filter((l) => l.trim());
  let min: number | null = null;
  for (let i = 1; i < lines.length; i++) {
    try {
      const row = JSON.parse(lines[i]) as { _kind?: string; _time?: number; _value?: number };
      // Presence of a finite sample = coverage (a histogram quantile can be
      // a legitimate 0, so don't gate on value > 0).
      if (row._kind === 'sample' && Number.isFinite(Number(row._value)) && row._time != null) {
        const t = Number(row._time);
        if (min == null || t < min) min = t;
      }
    } catch { /* skip */ }
  }
  return min;
}

/** Build the injected BackfillDeps backed by the Search job API. */
export async function makeNodeBackfillDeps(
  log: (msg: string) => void,
): Promise<BackfillDeps> {
  const { token, base } = await getToken();
  return {
    log,
    async countSpans(earliestMs: number, latestMs: number): Promise<SpanCountBin[]> {
      const rows = await runJob(base, token, backfillSpanCounts(300), String(earliestMs), String(latestMs), 20_000);
      return rows
        .filter((r) => r.t !== undefined)
        .map((r) => ({ tSec: Number(r.t), count: Number(r.n) }));
    },
    async runExport(query: string, earliestMs: number, latestMs: number) {
      const rows = await runJob(base, token, query, String(earliestMs), String(latestMs), 10);
      const done = rows.find((r) => /Exporting complete/.test(String(r.status))) ?? {};
      return {
        eventsOut: Number((done as { eventsOut?: unknown }).eventsOut ?? 0),
        eventsDropped: Number((done as { eventsDropped?: unknown }).eventsDropped ?? 0),
      };
    },
    earliestCoveredSec(metric: string, kind: 'counter' | 'histogram', earliestMs: number, latestMs: number) {
      return earliestCoveredSec(base, token, metric, kind, earliestMs, latestMs);
    },
  };
}
