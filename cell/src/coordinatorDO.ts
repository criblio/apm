/**
 * Singleton coordinator (idFromName('main')).
 *
 * Owns everything cross-investigation:
 *   - exactly-once triggering: dedupe on the alert event's stable
 *    `event_id` (UNIQUE column; webhook retries and overlapping
 *     notify windows both collapse here),
 *   - the queue + global concurrency cap (start at 1 — the staging
 *     search pool is small and every investigation fires searches),
 *   - a per-hour admission cap as a runaway backstop,
 *   - the investigations index the UI lists.
 */
import type { Env } from './env';
import type { FiringAlert, InvestigationSummaryRow } from './protocol';

const MAX_CONCURRENT = 1;
const MAX_PER_HOUR = 10;

export class CoordinatorDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS investigations (
         id TEXT PRIMARY KEY,
         event_id TEXT NOT NULL UNIQUE,
         alert_id TEXT NOT NULL,
         incident_key TEXT NOT NULL,
         status TEXT NOT NULL,          -- queued|running|concluded|failed
         alert_json TEXT NOT NULL,
         created_at INTEGER NOT NULL,
         started_at INTEGER,
         concluded_at INTEGER
       )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/internal/fire' && request.method === 'POST') {
      const alerts = (await request.json()) as FiringAlert[];
      let accepted = 0;
      const admittedThisHour = Number(
        this.state.storage.sql
          .exec(
            `SELECT COUNT(*) AS n FROM investigations WHERE created_at > ?`,
            Date.now() - 3_600_000,
          )
          .one().n,
      );
      let hourBudget = MAX_PER_HOUR - admittedThisHour;

      for (const alert of alerts) {
        if (!alert?.event_id || !alert?.alert_id || !alert?.svc) continue;
        if (hourBudget <= 0) break;
        const dup = this.state.storage.sql
          .exec(`SELECT 1 FROM investigations WHERE event_id = ?`, alert.event_id)
          .toArray().length;
        if (dup > 0) continue;
        const id = `inv-${crypto.randomUUID()}`;
        this.state.storage.sql.exec(
          `INSERT INTO investigations
             (id, event_id, alert_id, incident_key, status, alert_json, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)`,
          id,
          alert.event_id,
          alert.alert_id,
          `${alert.svc}:${alert.signal_type}`,
          JSON.stringify(alert),
          Date.now(),
        );
        accepted++;
        hourBudget--;
      }

      await this.pump();
      return Response.json({ accepted });
    }

    if (url.pathname === '/internal/complete' && request.method === 'POST') {
      const { id, outcome } = (await request.json()) as {
        id: string;
        outcome: 'concluded' | 'failed';
      };
      this.state.storage.sql.exec(
        `UPDATE investigations SET status = ?, concluded_at = ? WHERE id = ?`,
        outcome,
        Date.now(),
        id,
      );
      await this.pump();
      return Response.json({ ok: true });
    }

    if (url.pathname === '/internal/list') {
      const rows = this.state.storage.sql
        .exec(
          `SELECT id, alert_id, incident_key, status, created_at, started_at, concluded_at
           FROM investigations ORDER BY created_at DESC LIMIT 100`,
        )
        .toArray()
        .map(
          (r): InvestigationSummaryRow => ({
            id: String(r.id),
            alertId: String(r.alert_id),
            incidentKey: String(r.incident_key),
            status: r.status as InvestigationSummaryRow['status'],
            createdAt: Number(r.created_at),
            startedAt: r.started_at == null ? null : Number(r.started_at),
            concludedAt: r.concluded_at == null ? null : Number(r.concluded_at),
          }),
        );
      return Response.json({ investigations: rows });
    }

    return new Response('not found', { status: 404 });
  }

  /** Start queued investigations while below the concurrency cap. */
  private async pump(): Promise<void> {
    const running = Number(
      this.state.storage.sql
        .exec(`SELECT COUNT(*) AS n FROM investigations WHERE status = 'running'`)
        .one().n,
    );
    let slots = MAX_CONCURRENT - running;

    while (slots > 0) {
      const next = this.state.storage.sql
        .exec(
          `SELECT id, alert_json FROM investigations
           WHERE status = 'queued' ORDER BY created_at LIMIT 1`,
        )
        .toArray()[0];
      if (!next) return;

      const id = String(next.id);
      const alert = JSON.parse(String(next.alert_json)) as FiringAlert;
      this.state.storage.sql.exec(
        `UPDATE investigations SET status = 'running', started_at = ? WHERE id = ?`,
        Date.now(),
        id,
      );
      const stub = this.env.INVESTIGATION.get(this.env.INVESTIGATION.idFromName(id));
      // PR 7: build the seed via the shared buildAlertSeed() +
      // preflight. The stub agent only needs the raw alert facts.
      const res = await stub.fetch('https://investigation.internal/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, alert, seed: null }),
      });
      if (!res.ok) {
        this.state.storage.sql.exec(
          `UPDATE investigations SET status = 'failed', concluded_at = ? WHERE id = ?`,
          Date.now(),
          id,
        );
        continue; // slot stays free for the next queued item
      }
      slots--;
    }
  }
}
