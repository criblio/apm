// Minimal Cribl Search client for scenario tests. Mirrors the pack's
// src/api/cribl.ts runQuery shape but runs in Node with a Bearer token
// minted via client credentials (same OAuth flow the apmSession helper
// uses to authenticate in-browser fetches). Keeps the helper surface
// small so scenario specs can import runQuery without knowing anything
// about Cribl Cloud's job API.
//
// Requires CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET in
// .env — the same credentials scripts/deploy.mjs uses.
//
// Search endpoints are served under the default_search worker group
// (/api/v1/m/default_search/search/...), which is the config-group
// contextual path documented in AGENTS.md. Non-search endpoints would
// use the plain /api/v1/... path.

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}
let tokenCache: CachedToken | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.accessToken;
  }
  const baseUrl = process.env.CRIBL_BASE_URL;
  const clientId = process.env.CRIBL_CLIENT_ID;
  const clientSecret = process.env.CRIBL_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) {
    throw new Error(
      'CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET must be set in .env — ' +
        'criblSearch needs them to mint a Bearer token for search API calls.',
    );
  }
  const isStaging = /cribl-staging\.cloud/.test(baseUrl);
  const tokenUrl = isStaging
    ? 'https://login.cribl-staging.cloud/oauth/token'
    : 'https://login.cribl.cloud/oauth/token';
  const audience = isStaging
    ? 'https://api.cribl-staging.cloud'
    : 'https://api.cribl.cloud';
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
    }),
  });
  if (!resp.ok) {
    throw new Error(
      `OAuth token exchange failed (${resp.status}): ${await resp.text()}`,
    );
  }
  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error(`OAuth response missing access_token`);
  }
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
  return data.access_token;
}

function searchBase(): string {
  const url = process.env.CRIBL_BASE_URL;
  if (!url) throw new Error('CRIBL_BASE_URL is not set');
  return url.replace(/\/$/, '') + '/api/v1/m/default_search/search';
}

interface JobItem {
  id: string;
  status?: string;
}
interface JobListResponse {
  items?: JobItem[];
}

/**
 * Run a KQL query against the default Cribl Search worker group and
 * return parsed result rows. Blocks until the job completes (or the
 * poll budget is exhausted).
 *
 * Job lifecycle: POST /jobs → poll GET /jobs/:id until completed →
 * GET /jobs/:id/results (NDJSON where the first line is metadata).
 * Mirrors the shape in src/api/cribl.ts::runQuery so both the pack
 * and the test harness agree on how rows come back.
 */
export async function runQuery(
  kql: string,
  earliest: string = '-1h',
  latest: string = 'now',
  limit: number = 200,
): Promise<Record<string, unknown>[]> {
  const token = await getToken();
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };

  const createResp = await fetch(`${searchBase()}/jobs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query: kql, earliest, latest }),
  });
  if (!createResp.ok) {
    throw new Error(
      `Search job creation failed (${createResp.status}): ${await createResp.text()}`,
    );
  }
  const createBody = (await createResp.json()) as JobListResponse;
  const job = createBody.items?.[0];
  if (!job?.id) {
    throw new Error(`Search job creation: missing items[0].id in response`);
  }
  const jobId = job.id;

  // Poll ≤ 60s (120 × 500ms). Most scenario queries finish in <2s;
  // this budget only matters when the cluster is under load.
  let status = job.status ?? 'queued';
  for (
    let i = 0;
    i < 120 &&
    status !== 'completed' &&
    status !== 'failed' &&
    status !== 'canceled';
    i++
  ) {
    await new Promise((r) => setTimeout(r, 500));
    const pollResp = await fetch(`${searchBase()}/jobs/${jobId}`, { headers });
    if (!pollResp.ok) {
      throw new Error(`Job poll failed (${pollResp.status})`);
    }
    const pollBody = (await pollResp.json()) as JobListResponse;
    status = pollBody.items?.[0]?.status ?? status;
  }
  if (status !== 'completed') {
    throw new Error(`Search job ${jobId} ended with status: ${status}`);
  }

  // NDJSON: first line is a metadata header, subsequent lines are
  // one event per line.
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  while (rows.length < limit) {
    const pageSize = Math.min(200, limit - rows.length);
    const res = await fetch(
      `${searchBase()}/jobs/${jobId}/results?offset=${offset}&limit=${pageSize}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`Results fetch failed (${res.status})`);
    }
    const text = await res.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) break;
    const events: Record<string, unknown>[] = [];
    for (let i = 1; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]) as Record<string, unknown>);
      } catch {
        /* skip malformed */
      }
    }
    rows.push(...events);
    if (events.length < pageSize) break;
    offset += events.length;
  }
  return rows;
}
