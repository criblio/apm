/**
 * One investigation = one Durable Object.
 *
 * The agent loop is ALARM-DRIVEN: each alarm() invocation runs
 * exactly one agent turn, appends the turn's transcript events, and
 * schedules the next alarm. This is required by celld's 300s
 * JavaScript handler budget (a whole investigation can exceed it; a
 * single turn cannot) and gives per-turn durability + automatic
 * resumption on another node if this one dies — both verified in the
 * 2026-08-10 S2 spike (docs/research/server-investigations/design.md,
 * "Spike results").
 *
 * Transcript events are append-only rows with a monotonic seq;
 * live WebSockets get every append fanned out, and any client can
 * (re)connect with ?since=N to replay from where it left off. The
 * poll fallback (GET /events?since=N) reads the same rows.
 */
import type { Env } from './env';
import {
  PROTOCOL_VERSION,
  type FiringAlert,
  type InvestigationStatus,
  type ServerFrame,
  type WireLoopEvent,
} from './protocol';
import { stubTurnEvents } from './stubAgent';

const TURN_DELAY_MS = 1_000;
const SCHEMA_VERSION = 1;

interface StartBody {
  id: string;
  alert: FiringAlert;
  seed: unknown;
}

export class InvestigationDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS investigation (
         id TEXT PRIMARY KEY,
         alert_id TEXT NOT NULL,
         trigger_event_id TEXT NOT NULL,
         incident_key TEXT NOT NULL,
         status TEXT NOT NULL,
         seed_json TEXT NOT NULL,
         conclusion_json TEXT,
         error TEXT,
         created_at INTEGER NOT NULL,
         started_at INTEGER,
         concluded_at INTEGER,
         turn INTEGER NOT NULL DEFAULT 0,
         schema_version INTEGER NOT NULL
       )`,
    );
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS transcript_events (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         ev_json TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
    );
    // Raw agent message history (pi messages in PR 7). Stored now so
    // "continue asking questions on a finished investigation" needs
    // no schema migration later.
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS agent_messages (
         seq INTEGER PRIMARY KEY AUTOINCREMENT,
         message_json TEXT NOT NULL
       )`,
    );
  }

  // ── row helpers ────────────────────────────────────────────────

  private row(): Record<string, unknown> | null {
    const rows = this.state.storage.sql
      .exec(`SELECT * FROM investigation LIMIT 1`)
      .toArray();
    return rows[0] ?? null;
  }

  private setStatus(status: InvestigationStatus, patch: Record<string, number | string | null> = {}): void {
    const sets = ['status = ?'];
    const args: (string | number | null)[] = [status];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      args.push(v);
    }
    this.state.storage.sql.exec(
      `UPDATE investigation SET ${sets.join(', ')}`,
      ...args,
    );
    this.fanout({ type: 'status', status });
  }

  private append(ev: WireLoopEvent): number {
    this.state.storage.sql.exec(
      `INSERT INTO transcript_events (ev_json, created_at) VALUES (?, ?)`,
      JSON.stringify(ev),
      Date.now(),
    );
    const seq = Number(
      this.state.storage.sql
        .exec(`SELECT MAX(seq) AS seq FROM transcript_events`)
        .one().seq,
    );
    this.fanout({ type: 'event', seq, ev });
    return seq;
  }

  private latestSeq(): number {
    const r = this.state.storage.sql
      .exec(`SELECT MAX(seq) AS seq FROM transcript_events`)
      .one();
    return Number(r.seq ?? 0) || 0;
  }

  private eventsSince(since: number, limit = 500): Array<{ seq: number; ev: WireLoopEvent }> {
    return this.state.storage.sql
      .exec(
        `SELECT seq, ev_json FROM transcript_events WHERE seq > ? ORDER BY seq LIMIT ?`,
        since,
        limit,
      )
      .toArray()
      .map((r) => ({
        seq: Number(r.seq),
        ev: JSON.parse(String(r.ev_json)) as WireLoopEvent,
      }));
  }

  private fanout(frame: ServerFrame): void {
    const text = JSON.stringify(frame);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(text);
      } catch {
        /* a dead socket must not block the others */
      }
    }
  }

  // ── HTTP surface (reached via the worker router) ───────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith('/start') && request.method === 'POST') {
      const body = (await request.json()) as StartBody;
      if (this.row()) {
        // Idempotent: a retried start must not reset a live run.
        return Response.json({ ok: true, already: true });
      }
      this.state.storage.sql.exec(
        `INSERT INTO investigation
           (id, alert_id, trigger_event_id, incident_key, status, seed_json, created_at, schema_version)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        body.id,
        body.alert.alert_id,
        body.alert.event_id,
        `${body.alert.svc}:${body.alert.signal_type}`,
        JSON.stringify(body.seed ?? null),
        Date.now(),
        SCHEMA_VERSION,
      );
      await this.state.storage.put('alert', body.alert);
      this.setStatus('running', { started_at: Date.now() });
      await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/events')) {
      const row = this.row();
      if (!row) return Response.json({ error: 'not found' }, { status: 404 });
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      return Response.json({
        protocolVersion: PROTOCOL_VERSION,
        status: row.status,
        latestSeq: this.latestSeq(),
        frames: this.eventsSince(since),
      });
    }

    if (url.pathname.endsWith('/status')) {
      const row = this.row();
      if (!row) return Response.json({ error: 'not found' }, { status: 404 });
      return Response.json({
        id: row.id,
        status: row.status,
        alertId: row.alert_id,
        incidentKey: row.incident_key,
        createdAt: row.created_at,
        startedAt: row.started_at,
        concludedAt: row.concluded_at,
        conclusion: row.conclusion_json ? JSON.parse(String(row.conclusion_json)) : null,
        latestSeq: this.latestSeq(),
      });
    }

    if (url.pathname.endsWith('/ws')) {
      const row = this.row();
      if (!row) return new Response('not found', { status: 404 });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('websocket upgrade required', { status: 426 });
      }
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[0]);
      const hello: ServerFrame = {
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        investigation: {
          id: String(row.id),
          status: row.status as InvestigationStatus,
          seed: row.seed_json ? JSON.parse(String(row.seed_json)) : null,
          alertId: String(row.alert_id),
          createdAt: Number(row.created_at),
          concludedAt: row.concluded_at == null ? null : Number(row.concluded_at),
        },
        latestSeq: this.latestSeq(),
      };
      pair[0].send(JSON.stringify(hello));
      for (const f of this.eventsSince(since)) {
        pair[0].send(JSON.stringify({ type: 'event', ...f } satisfies ServerFrame));
      }
      return new Response(null, { status: 101, webSocket: pair[1] });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket): Promise<void> {
    // Read-only transport in v1: clients only listen. Answer pings so
    // naive keepalives don't error.
    ws.send(JSON.stringify({ type: 'ping' } satisfies ServerFrame));
  }

  // ── the alarm-driven loop ──────────────────────────────────────

  async alarm(): Promise<void> {
    const row = this.row();
    if (!row || row.status !== 'running') return;

    const alert = (await this.state.storage.get<FiringAlert>('alert'))!;
    const turn = Number(row.turn ?? 0);

    try {
      // PR 7 replaces stubTurnEvents with one real pi-agent-core turn
      // (LLM call + tool execution). The machinery around it — one
      // turn per alarm, persist, reschedule — stays exactly this.
      const { events, done } = stubTurnEvents(turn, alert);
      let conclusion: unknown = null;
      for (const ev of events) {
        if (
          ev.kind === 'toolResult' &&
          ev.result.name === 'present_investigation_summary'
        ) {
          conclusion = ev.result.ui ?? null;
        }
        this.append(ev);
      }
      this.state.storage.sql.exec(`UPDATE investigation SET turn = ?`, turn + 1);

      if (done) {
        this.setStatus('concluded', {
          concluded_at: Date.now(),
          conclusion_json: conclusion == null ? null : JSON.stringify(conclusion),
        });
        // PR 7: commit the `investigated` event to the Cribl dataset
        // here (the durable record). PR 6 keeps the cell offline.
        await this.notifyCoordinator('concluded');
      } else {
        await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.append({ kind: 'error', message });
      this.setStatus('failed', { concluded_at: Date.now(), error: message });
      await this.notifyCoordinator('failed');
    }
  }

  private async notifyCoordinator(outcome: 'concluded' | 'failed'): Promise<void> {
    // The coordinator enforces global concurrency; it must hear about
    // completions to start the next queued investigation. Reached via
    // the DO binding, not the public router.
    const row = this.row();
    if (!row) return;
    const coordinator = this.env.COORDINATOR.get(
      this.env.COORDINATOR.idFromName('main'),
    );
    await coordinator.fetch('https://coordinator.internal/internal/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: row.id, outcome }),
    });
  }
}
