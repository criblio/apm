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
import {
  incidentKey,
  titleFromPrompt,
  type CreateInvestigationBody,
  type FiringAlert,
  type InvestigationMode,
  type InvestigationSummaryRow,
} from './protocol';

const MAX_CONCURRENT = 1;
const MAX_PER_HOUR = 10;
/** A 'running' investigation older than this is treated as orphaned
 *  (its node died) and reclaimed so it can't wedge the queue. Well
 *  above any real run: the InvestigationDO caps itself at MAX_TURNS. */
const ORPHAN_RECLAIM_MS = 20 * 60_000;

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
         status TEXT NOT NULL,          -- queued|running|idle|concluded|failed
         alert_json TEXT NOT NULL,      -- FiringAlert (autonomous) | {prompt,context} (interactive)
         created_at INTEGER NOT NULL,
         started_at INTEGER,
         concluded_at INTEGER
       )`,
    );
    // Additive columns for interactive investigations + the recall
    // panel. Idempotent: SQLite has no `ADD COLUMN IF NOT EXISTS`, so
    // a duplicate-column error on an already-migrated DO is swallowed.
    this.addColumn('mode', `TEXT NOT NULL DEFAULT 'autonomous'`);
    this.addColumn('title', 'TEXT');
  }

  private addColumn(name: string, decl: string): void {
    try {
      this.state.storage.sql.exec(
        `ALTER TABLE investigations ADD COLUMN ${name} ${decl}`,
      );
    } catch {
      /* column already exists on a previously-migrated object */
    }
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
        const id = `inv-${crypto.randomUUID()}`;
        // event_id is UNIQUE, so let the insert do the dedupe. The
        // separate SELECT this replaces cost a second statement per
        // alert and left a gap between the check and the write.
        const written = this.state.storage.sql.exec(
          `INSERT INTO investigations
             (id, event_id, alert_id, incident_key, status, alert_json, created_at)
           VALUES (?, ?, ?, ?, 'queued', ?, ?)
           ON CONFLICT(event_id) DO NOTHING`,
          id,
          alert.event_id,
          alert.alert_id,
          incidentKey(alert),
          JSON.stringify(alert),
          Date.now(),
        ).rowsWritten;
        if (written === 0) continue; // already admitted
        accepted++;
        hourBudget--;
      }

      await this.pump();
      return Response.json({ accepted });
    }

    if (url.pathname === '/internal/create' && request.method === 'POST') {
      const body = (await request.json()) as CreateInvestigationBody;
      const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) {
        return Response.json({ error: 'prompt required' }, { status: 400 });
      }
      const id = `inv-${crypto.randomUUID()}`;
      // Synthetic event_id keeps the UNIQUE-column dedupe path intact
      // for interactive rows (they have no alert to dedupe on).
      const eventId = `ui-${crypto.randomUUID()}`;
      const title = (body.title?.trim() || titleFromPrompt(prompt)).slice(0, 120);
      this.state.storage.sql.exec(
        `INSERT INTO investigations
           (id, event_id, alert_id, incident_key, status, alert_json, created_at, mode, title)
         VALUES (?, ?, '', 'interactive', 'queued', ?, ?, 'interactive', ?)`,
        id,
        eventId,
        JSON.stringify({ prompt, context: body.context ?? null, repos: body.repos ?? null }),
        Date.now(),
        title,
      );
      await this.pump();
      return Response.json({ id, title }, { status: 202 });
    }

    if (url.pathname === '/internal/complete' && request.method === 'POST') {
      const { id, outcome } = (await request.json()) as {
        id: string;
        outcome: 'concluded' | 'failed' | 'idle' | 'resumed';
      };
      if (outcome === 'idle') {
        // Interactive turn finished; the run is parked awaiting the
        // next user message. Free its slot (status is no longer
        // 'running') without marking it concluded, then let a queued
        // investigation take the slot.
        this.state.storage.sql.exec(
          `UPDATE investigations SET status = 'idle' WHERE id = ?`,
          id,
        );
        await this.pump();
      } else if (outcome === 'resumed') {
        // A parked (or reopened concluded) investigation got a new
        // message and is running again — and is now conversational, so
        // reflect that in the index. v1: this re-enters 'running'
        // without going back through the queue's slot gate (see the
        // interactive-and-recall design note); runs are human-paced.
        this.state.storage.sql.exec(
          `UPDATE investigations SET status = 'running', started_at = ?, mode = 'interactive' WHERE id = ?`,
          Date.now(),
          id,
        );
      } else {
        this.state.storage.sql.exec(
          `UPDATE investigations SET status = ?, concluded_at = ? WHERE id = ?`,
          outcome,
          Date.now(),
          id,
        );
        await this.pump();
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === '/internal/list') {
      const q = (url.searchParams.get('q') ?? '').trim();
      const limit = Math.min(
        Math.max(Number(url.searchParams.get('limit') ?? 30) || 30, 1),
        100,
      );
      // Keyset pagination: rows are newest-first, so "older page" is
      // everything created before the last row the client holds.
      const before = Number(url.searchParams.get('before') ?? 0) || 0;

      const clauses: string[] = [];
      const args: Array<string | number> = [];
      if (before > 0) {
        clauses.push('created_at < ?');
        args.push(before);
      }
      if (q) {
        clauses.push('(title LIKE ? OR incident_key LIKE ?)');
        args.push(`%${q}%`, `%${q}%`);
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      args.push(limit);

      const rows = this.state.storage.sql
        .exec(
          `SELECT id, alert_id, incident_key, status, created_at, started_at,
                  concluded_at, mode, title
           FROM investigations ${where} ORDER BY created_at DESC LIMIT ?`,
          ...args,
        )
        .toArray()
        .map(
          (r): InvestigationSummaryRow => ({
            id: String(r.id),
            alertId: String(r.alert_id),
            incidentKey: String(r.incident_key),
            status: r.status as InvestigationSummaryRow['status'],
            title: String(r.title ?? '') || String(r.incident_key),
            mode: (r.mode as InvestigationMode) ?? 'autonomous',
            createdAt: Number(r.created_at),
            startedAt: r.started_at == null ? null : Number(r.started_at),
            concludedAt: r.concluded_at == null ? null : Number(r.concluded_at),
          }),
        );
      return Response.json({ investigations: rows });
    }

    return new Response('not found', { status: 404 });
  }

  /**
   * Start queued investigations. Interactive runs start immediately and
   * in parallel — they're user-initiated, human-paced, and each caps its
   * own searches, so several at once won't storm the search pool.
   * Autonomous (alert-triggered) runs stay gated by MAX_CONCURRENT, which
   * is the actual storm risk (a burst of firing alerts).
   */
  private async pump(): Promise<void> {
    // Reclaim orphaned slots: a node that dies mid-investigation leaves
    // its row 'running' forever. An investigation 'running' longer than
    // any real run could take is treated as dead and freed.
    this.state.storage.sql.exec(
      `UPDATE investigations SET status = 'failed', concluded_at = ?
       WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`,
      Date.now(),
      Date.now() - ORPHAN_RECLAIM_MS,
    );

    // Interactive: start every queued one now (no global gate).
    const interactive = this.state.storage.sql
      .exec(
        `SELECT id, alert_json, mode, title FROM investigations
         WHERE status = 'queued' AND mode = 'interactive' ORDER BY created_at`,
      )
      .toArray();
    for (const row of interactive) await this.dispatchQueued(row);

    // Autonomous: gate on MAX_CONCURRENT (counting only autonomous runs).
    const runningAutonomous = Number(
      this.state.storage.sql
        .exec(
          `SELECT COUNT(*) AS n FROM investigations WHERE status = 'running' AND mode = 'autonomous'`,
        )
        .one().n,
    );
    let slots = MAX_CONCURRENT - runningAutonomous;
    while (slots > 0) {
      const next = this.state.storage.sql
        .exec(
          `SELECT id, alert_json, mode, title FROM investigations
           WHERE status = 'queued' AND mode = 'autonomous' ORDER BY created_at LIMIT 1`,
        )
        .toArray()[0];
      if (!next) return;
      if (await this.dispatchQueued(next)) slots--;
    }
  }

  /** Mark a queued row running and dispatch it to its DO. Returns true
   *  if it started, false if the DO refused (row marked failed). */
  private async dispatchQueued(next: Record<string, unknown>): Promise<boolean> {
    const id = String(next.id);
    const mode = (next.mode as InvestigationMode) ?? 'autonomous';
    this.state.storage.sql.exec(
      `UPDATE investigations SET status = 'running', started_at = ? WHERE id = ?`,
      Date.now(),
      id,
    );
    const stub = this.env.INVESTIGATION.get(this.env.INVESTIGATION.idFromName(id));
    // Autonomous → /start with the raw alert facts (the DO builds the
    // seed via buildAlertSeed + preflight). Interactive → /create with
    // the user's prompt + context + repos.
    const res =
      mode === 'interactive'
        ? await (() => {
            const payload = JSON.parse(String(next.alert_json)) as CreateInvestigationBody;
            return stub.fetch('https://investigation.internal/create', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                id,
                prompt: payload.prompt,
                context: payload.context ?? null,
                title: String(next.title ?? ''),
                repos: payload.repos ?? null,
              }),
            });
          })()
        : await stub.fetch('https://investigation.internal/start', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              id,
              alert: JSON.parse(String(next.alert_json)) as FiringAlert,
              seed: null,
            }),
          });
    if (!res.ok) {
      this.state.storage.sql.exec(
        `UPDATE investigations SET status = 'failed', concluded_at = ? WHERE id = ?`,
        Date.now(),
        id,
      );
      return false;
    }
    return true;
  }
}
