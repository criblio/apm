/**
 * Regression tests for the framework's lookup seeding.
 *
 * These live in APM rather than the framework because the framework
 * has no test harness, and APM is the app whose lookups the bug
 * destroyed. Every seed query is `print … | export mode=overwrite to
 * lookup <name>`, so seeding a lookup that already holds real data
 * replaces it with a single sentinel row — 24h of op baselines, the
 * alert state machine's consecutive_bad / fire_count counters, the
 * attribute catalog. Seeding is only ever safe on a lookup that
 * genuinely does not exist.
 *
 * Two defects made that guarantee fail, both verified against the
 * staging API on 2026-07-14:
 *
 *   1. POST /search/jobs returns `{items:[{id}]}`, but the job id was
 *      read from a top-level `.id`. It came back undefined, so the
 *      "wait for the job" path bailed out immediately and every job
 *      reported "unknown".
 *   2. The existence probe ended in `| limit 0`, which Cribl rejects
 *      outright ("Limit value outside of supported range"), so the
 *      probe 400d whether or not the lookup existed.
 *
 * Together they meant no probe ever said "exists" and every reconcile
 * re-seeded — and so wiped — every lookup.
 */
import { describe, it, expect } from 'vitest';
import { seedLookups, type HttpClient } from '@cribl/app-utils/provisioner';

const LOOKUP = 'criblapm_op_baselines';
const SEED = `print svc="__init__" | export mode=overwrite to lookup ${LOOKUP}`;

/** Error shape both real HTTP clients throw: status + response body. */
function httpError(status: number, body: string): Error {
  return new Error(`POST /m/default_search/search/jobs failed (${status}): ${body}`);
}

/** Records every search-job query, and answers probes however the
 * test tells it to. Mirrors the real Cribl response shapes. */
function fakeHttp(onProbe: () => unknown): { http: HttpClient; queries: string[] } {
  const queries: string[] = [];
  const http: HttpClient = {
    get: async () => ({ status: 'completed' }),
    post: async (path: string, body: unknown) => {
      const query = (body as { query?: string })?.query ?? '';
      if (!path.includes('/search/jobs')) return {};
      queries.push(query);
      if (query.includes('export')) return { items: [{ id: 'seed-job' }] };
      const result = onProbe();
      if (result instanceof Error) throw result;
      return result;
    },
    patch: async () => ({}),
    del: async () => ({}),
  };
  return { http, queries };
}

const didSeed = (queries: string[]) => queries.some((q) => q.includes('export'));

describe('seedLookups', () => {
  it('leaves an existing lookup alone (Cribl planned the probe)', async () => {
    // A lookup that resolves => the probe job is created successfully.
    const { http, queries } = fakeHttp(() => ({ items: [{ id: 'probe-job' }] }));
    await seedLookups(http, [{ name: LOOKUP, seedQuery: SEED }]);
    expect(didSeed(queries)).toBe(false);
  });

  it('seeds a lookup Cribl explicitly reports as unknown', async () => {
    const { http, queries } = fakeHttp(() =>
      httpError(400, `{"message":"Unknown lookup table name: ${LOOKUP}: lookup"}`),
    );
    await seedLookups(http, [{ name: LOOKUP, seedQuery: SEED }]);
    expect(didSeed(queries)).toBe(true);
  });

  it('does NOT seed when the probe fails for any other reason', async () => {
    // Fail-safe: a transport error is not a verdict that the lookup is
    // missing. Seeding here would overwrite live data on a blip.
    for (const failure of [
      new TypeError('fetch failed'),
      httpError(500, '{"message":"internal error"}'),
      httpError(401, 'Unauthorized'),
    ]) {
      const { http, queries } = fakeHttp(() => failure);
      await seedLookups(http, [{ name: LOOKUP, seedQuery: SEED }]);
      expect(didSeed(queries), `seeded after ${failure.message}`).toBe(false);
    }
  });

  it('probes with a query Cribl actually accepts', async () => {
    const { http, queries } = fakeHttp(() => ({ items: [{ id: 'probe-job' }] }));
    await seedLookups(http, [{ name: LOOKUP, seedQuery: SEED }]);
    const probe = queries[0];
    // `limit 0` is rejected by Cribl ("Limit value outside of supported
    // range"), which is what made the old probe 400 unconditionally.
    expect(probe).not.toMatch(/limit\s+0/);
    expect(probe).toContain(`lookup ${LOOKUP}`);
    // The probe must not depend on any particular dataset existing.
    expect(probe).not.toContain('dataset=');
  });
});
