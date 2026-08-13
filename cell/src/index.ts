/**
 * Investigator cell — public HTTP surface.
 *
 *   POST /alerts/fire            bearer WEBHOOK_BEARER; body = firing
 *                                alert rows (raw array, {items:[…]} or
 *                                {results:[…]} — the notification
 *                                target's exact envelope is pinned in
 *                                spike S4). Always answers fast; work
 *                                runs async in the DOs.
 *   POST /investigations         bearer UI_BEARER; body =
 *                                {prompt, context?, title?}. Starts a
 *                                UI-initiated interactive investigation;
 *                                returns {id}.
 *   GET  /investigations         bearer UI_BEARER; index for the UI.
 *                                ?q= / ?limit= / ?before= for the recall
 *                                panel (search + keyset pagination).
 *   POST /investigations/:id/messages  bearer UI_BEARER; body =
 *                                {content}. Appends a follow-up user turn
 *                                to an interactive investigation and
 *                                resumes its loop.
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
import { mintTicket, verifyTicket } from './tickets';
import type { FiringAlert } from './protocol';

export { CoordinatorDO, InvestigationDO };

/**
 * The `serverInvestigations` flag is enforced where it belongs — the
 * app side — not here. When it's off, `getProvisioningPlan()` doesn't
 * create the notify search, so no webhook ever fires at the cell; and
 * the UI hides the badges/replay. A trigger arriving at `/alerts/fire`
 * therefore already means the feature is on. The cell doesn't (and
 * can't: a machine token resolves the unscoped, empty KV namespace)
 * read the flag. `DISABLED` remains a per-node operator kill switch.
 */

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
const INV_MESSAGES_PATH = /^\/investigations\/([A-Za-z0-9-]+)\/messages$/;

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
      // Per-node operator kill switch: acknowledge and drop. 202
      // keeps the notification target from retrying a delivery we
      // intend to ignore. (The feature-level on/off is enforced app
      // side by whether the notify search exists at all.)
      if (env.DISABLED === 'true') {
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

    // UI-initiated (interactive) investigation. The app POSTs the
    // user's opening prompt; the coordinator queues it like any other.
    if (url.pathname === '/investigations' && request.method === 'POST') {
      if (!bearerOk(request, env.UI_BEARER)) return unauthorized();
      if (env.DISABLED === 'true') {
        return Response.json({ error: 'cell disabled' }, { status: 503 });
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'invalid JSON' }, { status: 400 });
      }
      const res = await coordinator().fetch('https://coordinator.internal/internal/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return Response.json(await res.json(), { status: res.status });
    }

    if (url.pathname === '/investigations' && request.method === 'GET') {
      if (!bearerOk(request, env.UI_BEARER)) return unauthorized();
      // Pass the recall-panel query params (q / limit / before) through
      // to the coordinator's index.
      const listUrl = new URL('https://coordinator.internal/internal/list');
      for (const k of ['q', 'limit', 'before']) {
        const v = url.searchParams.get(k);
        if (v != null) listUrl.searchParams.set(k, v);
      }
      const res = await coordinator().fetch(listUrl.toString());
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

    // Follow-up user turn on an interactive investigation.
    const msg = INV_MESSAGES_PATH.exec(url.pathname);
    if (msg && request.method === 'POST') {
      if (!bearerOk(request, env.UI_BEARER)) return unauthorized();
      if (env.DISABLED === 'true') {
        return Response.json({ error: 'cell disabled' }, { status: 503 });
      }
      const stub = env.INVESTIGATION.get(env.INVESTIGATION.idFromName(msg[1]));
      return stub.fetch(request);
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
