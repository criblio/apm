/**
 * Scheduled-search provisioner.
 *
 * Reconciles the workspace's set of `criblapm__*` saved searches
 * with the declarative plan in `provisionedSearches.ts`. Used by:
 *
 *  - scripts/provision-searches.mjs at dev time (manual runs by
 *    humans against a staging deployment)
 *  - the in-app first-run / Settings "Re-provision" flow at
 *    runtime (planned — §2e in the ROADMAP)
 *
 * Safety model: we only ever look at rows whose `id` starts with
 * the `criblapm__` prefix. Everything else is invisible to this
 * module. A reconciliation run can create, update, or delete
 * prefixed rows; it will never touch a row a user created by
 * hand.
 *
 * The Cribl Search saved-search REST surface this module uses:
 *
 *   GET    /m/default_search/search/saved          (list)
 *   POST   /m/default_search/search/saved          (create)
 *   GET    /m/default_search/search/saved/:id      (get)
 *   PATCH  /m/default_search/search/saved/:id      (update)
 *   DELETE /m/default_search/search/saved/:id      (delete)
 *
 * All confirmed via the research pass in
 * `docs/research/cribl-saved-searches.md`. Auth comes from the
 * platform fetch proxy at app runtime, or from an explicit
 * Bearer token when invoked from the node-side script.
 */
import {
  getProvisioningPlan,
  CRIBLAPM_PREFIX,
  type ProvisionedSearch,
} from './provisionedSearches';

/** Minimal shape of a saved-search row as returned by the list
 * endpoint. We don't need the full schema here — just enough
 * to identify app-managed rows and diff against the plan. */
export interface SavedSearchRow {
  id: string;
  name?: string;
  description?: string;
  query?: string;
  earliest?: string | number;
  latest?: string | number;
  sampleRate?: number;
  schedule?: unknown;
}

interface SavedSearchListResponse {
  items?: SavedSearchRow[];
  count?: number;
}

/** Plan entry classified by what the reconciler needs to do. */
export type PlanAction =
  | { kind: 'create'; want: ProvisionedSearch }
  | { kind: 'update'; want: ProvisionedSearch; current: SavedSearchRow }
  | { kind: 'delete'; current: SavedSearchRow }
  | { kind: 'noop'; want: ProvisionedSearch; current: SavedSearchRow };

/** Abstract HTTP client so the same module can run inside the
 * browser (via `fetch`) and from a node-side driver (via a
 * fetch shim that injects a Bearer token). Both paths must
 * target the same endpoints and return parsed JSON. */
export interface HttpClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  patch(path: string, body: unknown): Promise<unknown>;
  del(path: string): Promise<unknown>;
}

/** Path builder — every saved-search URL is under this prefix. */
export function savedSearchesPath(id?: string): string {
  const base = '/m/default_search/search/saved';
  return id ? `${base}/${encodeURIComponent(id)}` : base;
}

/** Fetch every `criblapm__*` saved search currently on the
 * server. Pagination is not strictly necessary at our scale
 * (we have <10 managed rows) but we include it for safety
 * against a very large workspace. */
export async function listProvisioned(
  http: HttpClient,
): Promise<SavedSearchRow[]> {
  const out: SavedSearchRow[] = [];
  const pageSize = 200;
  let offset = 0;
  // Hard cap on loop iterations so a buggy server can't spin
  // us forever — 10k rows is already far beyond sensible.
  for (let page = 0; page < 50; page++) {
    const resp = (await http.get(
      `${savedSearchesPath()}?limit=${pageSize}&offset=${offset}`,
    )) as SavedSearchListResponse;
    const items = resp?.items ?? [];
    for (const row of items) {
      if (typeof row?.id === 'string' && row.id.startsWith(CRIBLAPM_PREFIX)) {
        out.push(row);
      }
    }
    if (items.length < pageSize) break;
    offset += items.length;
  }
  return out;
}

/** Compare the expected plan against the current server state
 * and classify every row into one of four actions. Comparison
 * semantics:
 *
 *   - A row in the plan with no server counterpart → create.
 *   - A row on the server whose `id` doesn't appear in the plan
 *     → delete (stale / removed from a previous pack version).
 *   - A row in both → check whether the interesting fields
 *     (query, earliest, latest, schedule, description, name)
 *     match. If any differ → update. If all match → noop.
 *
 * The noop branch lets the provisioner be idempotent: running
 * it repeatedly when nothing has changed produces zero writes.
 */
export function diffProvisioned(
  plan: ProvisionedSearch[],
  current: SavedSearchRow[],
): PlanAction[] {
  const byId = new Map<string, SavedSearchRow>();
  for (const row of current) byId.set(row.id, row);

  const actions: PlanAction[] = [];
  const planIds = new Set<string>();

  for (const want of plan) {
    planIds.add(want.id);
    const cur = byId.get(want.id);
    if (!cur) {
      actions.push({ kind: 'create', want });
      continue;
    }
    if (isSameAsPlan(want, cur)) {
      actions.push({ kind: 'noop', want, current: cur });
    } else {
      actions.push({ kind: 'update', want, current: cur });
    }
  }

  for (const row of current) {
    if (!planIds.has(row.id)) {
      actions.push({ kind: 'delete', current: row });
    }
  }

  return actions;
}

/** Strict-ish equality check between a planned row and the
 * server's current copy. Normalizes types where the server
 * echoes them back differently (e.g., `earliest` can be a
 * number when the plan uses a relative string; we compare
 * stringified forms to keep the check tolerant). */
function isSameAsPlan(want: ProvisionedSearch, cur: SavedSearchRow): boolean {
  if (want.name !== cur.name) return false;
  if (want.description !== cur.description) return false;
  if (want.query !== cur.query) return false;
  if (String(want.earliest) !== String(cur.earliest)) return false;
  if (String(want.latest) !== String(cur.latest)) return false;
  if ((want.sampleRate ?? 1) !== (cur.sampleRate ?? 1)) return false;
  // schedule is a nested object — compare by JSON serialization.
  // Overkill compared to a deep-equal, but stable enough for a
  // small object and saves a dependency.
  const serverSchedule =
    cur.schedule && typeof cur.schedule === 'object'
      ? (cur.schedule as Record<string, unknown>)
      : {};
  const wantSchedule: Record<string, unknown> = {
    enabled: want.schedule.enabled,
    cronSchedule: want.schedule.cronSchedule,
    tz: want.schedule.tz,
    keepLastN: want.schedule.keepLastN,
  };
  for (const key of Object.keys(wantSchedule)) {
    if (wantSchedule[key] !== serverSchedule[key]) return false;
  }
  return true;
}

/** POST / PATCH / DELETE executor. Returns a per-action result
 * so the caller can print a summary and detect partial failure. */
export interface ActionResult {
  action: PlanAction;
  ok: boolean;
  error?: string;
}

export async function applyProvisioningPlan(
  http: HttpClient,
  actions: PlanAction[],
): Promise<ActionResult[]> {
  const results: ActionResult[] = [];
  for (const action of actions) {
    try {
      await executeAction(http, action);
      results.push({ action, ok: true });
    } catch (err) {
      results.push({
        action,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

async function executeAction(
  http: HttpClient,
  action: PlanAction,
): Promise<void> {
  switch (action.kind) {
    case 'create': {
      const body = planToBody(action.want);
      await http.post(savedSearchesPath(), body);
      return;
    }
    case 'update': {
      const body = planToBody(action.want);
      await http.patch(savedSearchesPath(action.want.id), body);
      return;
    }
    case 'delete': {
      await http.del(savedSearchesPath(action.current.id));
      return;
    }
    case 'noop':
      return;
  }
}

/** Convert a plan entry into the JSON body the server wants.
 * The server auto-populates `user` and `displayUsername` on
 * create, so we deliberately omit them. */
function planToBody(want: ProvisionedSearch): Record<string, unknown> {
  return {
    id: want.id,
    name: want.name,
    description: want.description,
    query: want.query,
    earliest: want.earliest,
    latest: want.latest,
    sampleRate: want.sampleRate ?? 1,
    schedule: {
      enabled: want.schedule.enabled,
      cronSchedule: want.schedule.cronSchedule,
      tz: want.schedule.tz,
      keepLastN: want.schedule.keepLastN,
      // emptyNotifications / emptyAdvanced / notifications stay
      // absent — we aren't attaching alerts to these background
      // maintenance searches, just running them on a cron so the
      // panel caches stay warm.
    },
  };
}

/** Top-level orchestrator: load the plan, list current rows,
 * diff, apply. Returns a structured summary the caller can
 * render however it likes. */
/**
 * Seed lookup tables that must exist before scheduled searches
 * referencing them can be created. Cribl validates lookup names
 * at search creation time, so we need the lookup to exist first.
 */
async function seedLookups(http: HttpClient): Promise<void> {
  const LOOKUPS_TO_SEED = [
    {
      name: 'criblapm_alert_states',
      seedQuery: 'dataset="otel" | limit 1 | project alert_id="__init__", alert_status="ok", consecutive_bad=0, consecutive_good=0, first_fired_at="", fire_count=0 | export mode=overwrite description="Cribl APM - alert state init" to lookup criblapm_alert_states',
    },
  ];

  for (const lookup of LOOKUPS_TO_SEED) {
    try {
      // Check if the lookup exists by trying to use it
      await http.post('/m/default_search/search/jobs', {
        query: `dataset="otel" | limit 1 | project x=1 | lookup ${lookup.name} on x | limit 0`,
        earliest: '-5m',
        latest: 'now',
      });
    } catch {
      // Lookup doesn't exist — seed it
      try {
        await http.post('/m/default_search/search/jobs', {
          query: lookup.seedQuery,
          earliest: '-5m',
          latest: 'now',
        });
      } catch {
        // Best effort — if it fails, the search creation will also fail
        // and surface the error there.
      }
    }
  }
}

export async function reconcile(http: HttpClient): Promise<{
  plan: ProvisionedSearch[];
  current: SavedSearchRow[];
  actions: PlanAction[];
  results: ActionResult[];
}> {
  await seedLookups(http);
  const plan = getProvisioningPlan();
  const current = await listProvisioned(http);
  const actions = diffProvisioned(plan, current);
  const results = await applyProvisioningPlan(http, actions);
  return { plan, current, actions, results };
}

/** Dangerous: delete every `criblapm__*` saved search on the
 * server, no questions asked. Kept separate from `reconcile()`
 * so it can't be confused for an innocent "update". Used
 * during dev cleanup and by a future Settings > Reset action. */
export async function unprovisionAll(
  http: HttpClient,
): Promise<ActionResult[]> {
  const current = await listProvisioned(http);
  const actions: PlanAction[] = current.map((row) => ({
    kind: 'delete' as const,
    current: row,
  }));
  return applyProvisioningPlan(http, actions);
}

/** Dry-run helper: return the actions without applying them.
 * Used by the script's --dry-run mode and by the eventual
 * first-run dialog to show the user what the provisioner
 * would do before they click Confirm. */
export async function planOnly(http: HttpClient): Promise<{
  plan: ProvisionedSearch[];
  current: SavedSearchRow[];
  actions: PlanAction[];
}> {
  const plan = getProvisioningPlan();
  const current = await listProvisioned(http);
  const actions = diffProvisioned(plan, current);
  return { plan, current, actions };
}

/** Factory for the in-app HTTP client: wraps the browser's
 * `fetch` against the platform-injected CRIBL_API_URL. The
 * platform fetch proxy handles auth automatically. Thrown
 * errors include the HTTP status and response body on
 * non-2xx to make debugging saner. */
export function createBrowserHttpClient(): HttpClient {
  const base = (window.CRIBL_API_URL ?? '/api/v1').replace(/\/$/, '');
  async function call(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const resp = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`${method} ${path} failed (${resp.status}): ${text.slice(0, 400)}`);
    }
    const ct = resp.headers.get('content-type') || '';
    if (ct.includes('json')) return resp.json();
    return resp.text();
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
    del: (p) => call('DELETE', p),
  };
}
