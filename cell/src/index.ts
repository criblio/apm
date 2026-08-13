/**
 * Investigator cell — public HTTP surface.
 *
 *   POST /alerts/fire            bearer WEBHOOK_BEARER; body = firing
 *                                alert rows (raw array, {items:[…]} or
 *                                {results:[…]} — the notification
 *                                target's exact envelope is pinned in
 *                                spike S4). Always answers fast; work
 *                                runs async in the DOs.
 *   GET  /investigations         bearer UI_BEARER; index for the UI.
 *   GET  /investigations/:id/events?since=N   bearer UI_BEARER; poll
 *                                transport.
 *   GET  /investigations/:id/status           bearer UI_BEARER.
 *   GET  /ws-ticket?investigation=:id         bearer UI_BEARER; mints
 *                                a 60s HMAC ticket for the WS URL.
 *   GET  /investigations/:id/ws?since=N&ticket=T   WebSocket upgrade;
 *                                ticket-authed (the iframe cannot put
 *                                a header on a WS upgrade).
 *   GET  /healthz                unauthenticated liveness probe.
 */
import type { Env } from './env';
import { CoordinatorDO } from './coordinatorDO';
import { InvestigationDO } from './investigationDO';
import { CriblClient } from './criblClient';
import { mintTicket, verifyTicket } from './tickets';
import type { FiringAlert } from './protocol';

export { CoordinatorDO, InvestigationDO };

/**
 * KV kill-switch cache. The app's `serverInvestigations` Settings
 * toggle must stop new investigations within ~a minute even before a
 * re-provision removes the trigger search. Posture on unknown:
 * serve the last-known value through transient KV failures, but if
 * the flag has NEVER been readable, fail closed — matching the
 * feature's off-by-default contract.
 */
const FLAG_TTL_MS = 60_000;
let flagCache: { value: boolean; at: number } | null = null;

async function serverInvestigationsEnabled(env: Env): Promise<boolean> {
  const { CRIBL_BASE_URL, CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET, CRIBL_DEV_TOKEN } = env;
  if (!CRIBL_BASE_URL || (!CRIBL_DEV_TOKEN && (!CRIBL_CLIENT_ID || !CRIBL_CLIENT_SECRET))) {
    // No Cribl wiring at all (local scaffold/dev) — nothing to
    // consult; the DISABLED env var remains the only switch.
    return true;
  }
  if (flagCache && Date.now() - flagCache.at < FLAG_TTL_MS) {
    return flagCache.value;
  }
  const cribl = new CriblClient({
    baseUrl: CRIBL_BASE_URL,
    clientId: CRIBL_CLIENT_ID ?? '',
    clientSecret: CRIBL_CLIENT_SECRET ?? '',
    dataset: env.CRIBL_DATASET ?? 'otel',
    devToken: CRIBL_DEV_TOKEN,
  });
  const flag = await cribl.readServerInvestigationsFlag();
  if (flag !== null) {
    flagCache = { value: flag, at: Date.now() };
    return flag;
  }
  if (flagCache) return flagCache.value; // stale-but-known beats guessing
  return false; // never readable → closed
}

function unauthorized(): Response {
  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

function bearerOk(request: Request, expected: string | undefined): boolean {
  if (!expected) return false; // no secret configured ⇒ closed, not open
  const header = request.headers.get('authorization') ?? '';
  return header === `Bearer ${expected}`;
}

/** Accept the payload shapes a webhook target might send. */
function extractAlerts(body: unknown): FiringAlert[] {
  if (Array.isArray(body)) return body as FiringAlert[];
  if (body && typeof body === 'object') {
    const o = body as Record<string, unknown>;
    for (const key of ['items', 'results', 'resultSet', 'events']) {
      if (Array.isArray(o[key])) return o[key] as FiringAlert[];
    }
  }
  return [];
}

const INV_PATH = /^\/investigations\/([A-Za-z0-9-]+)\/(events|status|ws)$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const coordinator = () =>
      env.COORDINATOR.get(env.COORDINATOR.idFromName('main'));

    if (url.pathname === '/healthz') {
      return Response.json({ ok: true, disabled: env.DISABLED === 'true' });
    }

    if (url.pathname === '/alerts/fire' && request.method === 'POST') {
      if (!bearerOk(request, env.WEBHOOK_BEARER)) return unauthorized();
      // Kill switches: acknowledge and drop. 202 keeps the
      // notification target from retrying a delivery we intend to
      // ignore. DISABLED (env) is checked first, then the app's KV
      // serverInvestigations flag (~60s cache).
      if (env.DISABLED === 'true') {
        return Response.json({ accepted: 0, disabled: true }, { status: 202 });
      }
      if (!(await serverInvestigationsEnabled(env))) {
        return Response.json({ accepted: 0, disabled: true }, { status: 202 });
      }
      let alerts: FiringAlert[];
      try {
        alerts = extractAlerts(await request.json());
      } catch {
        return Response.json({ error: 'invalid JSON' }, { status: 400 });
      }
      if (alerts.length === 0) {
        return Response.json({ accepted: 0 }, { status: 202 });
      }
      const res = await coordinator().fetch('https://coordinator.internal/internal/fire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(alerts),
      });
      const out = await res.json();
      return Response.json(out, { status: 202 });
    }

    if (url.pathname === '/investigations' && request.method === 'GET') {
      if (!bearerOk(request, env.UI_BEARER)) return unauthorized();
      const res = await coordinator().fetch('https://coordinator.internal/internal/list');
      return Response.json(await res.json());
    }

    if (url.pathname === '/ws-ticket' && request.method === 'GET') {
      if (!bearerOk(request, env.UI_BEARER)) return unauthorized();
      const id = url.searchParams.get('investigation') ?? '';
      if (!id || !env.TICKET_SECRET) {
        return Response.json({ error: 'missing investigation or ticket secret' }, { status: 400 });
      }
      const ticket = await mintTicket(env.TICKET_SECRET, id, Date.now());
      return Response.json({ ticket, investigation: id });
    }

    const m = INV_PATH.exec(url.pathname);
    if (m && request.method === 'GET') {
      const [, id, verb] = m;
      if (verb === 'ws') {
        const ticket = url.searchParams.get('ticket') ?? '';
        if (
          !env.TICKET_SECRET ||
          !(await verifyTicket(env.TICKET_SECRET, id, ticket, Date.now()))
        ) {
          return unauthorized();
        }
      } else if (!bearerOk(request, env.UI_BEARER)) {
        return unauthorized();
      }
      const stub = env.INVESTIGATION.get(env.INVESTIGATION.idFromName(id));
      return stub.fetch(request);
    }

    return new Response('not found', { status: 404 });
  },
};
