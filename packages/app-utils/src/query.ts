/**
 * Thin KQL query runner. Executes a query against the Cribl Search
 * API and returns parsed JSON rows. Uses the platform fetch proxy
 * for auth when running inside a pack iframe.
 */

function apiUrl(): string {
  return (globalThis as Record<string, unknown>).CRIBL_API_URL as string
    ?? '/api/v1';
}

function searchBase(): string {
  return `${apiUrl()}/m/default_search/search`;
}

export async function runQuery(
  query: string,
  earliest: string = '-1h',
  latest: string = 'now',
  limit: number = 200,
): Promise<Record<string, unknown>[]> {
  const resp = await fetch(`${searchBase()}/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, earliest, latest }),
  });
  if (!resp.ok) throw new Error(`Search job creation failed: ${resp.status}`);
  const job = (await resp.json()) as { id: string };

  // Poll until complete
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const statusResp = await fetch(`${searchBase()}/jobs/${job.id}`);
    const statusData = (await statusResp.json()) as { status: string };
    if (statusData.status === 'completed') break;
    if (statusData.status === 'failed') {
      throw new Error(`Search job ${job.id} ended with status: failed`);
    }
  }

  // Fetch results
  const resultsResp = await fetch(
    `${searchBase()}/jobs/${job.id}/results?offset=0&limit=${limit}`,
    { headers: { accept: 'application/x-ndjson' } },
  );
  const text = await resultsResp.text();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
