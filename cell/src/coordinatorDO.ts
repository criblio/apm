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
import { CriblClient } from './criblClient';
import {
  ALERT_EVENT_DATATYPE,
  STORED_DATATYPE_EXPR,
} from '../../src/api/generatedEventContract';
import {
  incidentKey,
  titleFromPrompt,
  type CreateInvestigationBody,
  type FiringAlert,
  type InvestigationMode,
  type InvestigationSummaryRow,
  type SourceRepo,
} from './protocol';

const MAX_CONCURRENT = 1;
const MAX_PER_HOUR = 10;
/** Poll cadence for the firing-alert pull loop (see alarm()). */
const POLL_INTERVAL_MS = 5 * 60_000;
/** Window for each poll — matches the notify search's -15m; event_id
 *  dedup absorbs the overlap between consecutive polls. */
const POLL_WINDOW = '-15m';
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
    // Any request arms the pull loop — a deploy's first health probe
    // or UI list call is enough to start polling forever after.
    await this.ensurePollAlarm();

    if (url.pathname === '/internal/fire' && request.method === 'POST') {
      const alerts = (await request.json()) as FiringAlert[];
      const accepted = this.admitAlerts(alerts);
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
        outcome: 'concluded' | 'failed' | 'idle' | 'resumed' | 'cancelled';
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

    // The provisioned default source repos for autonomous (alert-fired)
    // investigations. Written by the app (Settings Save) and by
    // `scripts/provision.ts` — the two places that can read the
    // app-settings repos list; the cell itself can't (empty KV
    // namespace under a machine token). Threaded into each autonomous
    // /start so an alert-fired run gets the same code tools an
    // interactive one carries.
    if (url.pathname === '/internal/config-repos') {
      if (request.method === 'POST') {
        const body = (await request.json()) as { repos?: unknown };
        const repos = Array.isArray(body?.repos)
          ? (body.repos as SourceRepo[]).filter(
              (r) => r && typeof (r as SourceRepo).url === 'string',
            )
          : [];
        await this.state.storage.put('defaultRepos', repos);
        return Response.json({ ok: true, count: repos.length });
      }
      const repos = await this.defaultRepos();
      return Response.json({ repos });
    }

    return new Response('not found', { status: 404 });
  }

  /** The provisioned default repos for autonomous runs (empty if never
   *  set). */
  private async defaultRepos(): Promise<SourceRepo[]> {
    return (await this.state.storage.get<SourceRepo[]>('defaultRepos')) ?? [];
  }

  /** Shared admission: dedupe on event_id (UNIQUE column — webhook
   *  retries, overlapping notify windows, and overlapping poll windows
   *  all collapse here) under the hourly runaway cap. Used by the
   *  /internal/fire push path and the alarm pull loop. */
  private admitAlerts(alerts: FiringAlert[]): number {
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
    return accepted;
  }

  // ── Pull-based trigger (replaces the Cribl notification webhook) ──
  //
  // Cribl's saved-search notification delivery to the cell webhook
  // stopped executing silently around 2026-08-15 (target, binding, and
  // search all verified healthy; multiple payload formats and fresh
  // bindings all failed to deliver; no log surface exists to see why).
  // Rather than depend on an opaque push, the coordinator PULLS: a
  // durable self-re-arming alarm polls the same firing-alert query the
  // notify search runs, through the same admission/dedup path. The
  // /alerts/fire webhook stays wired — if Cribl delivery comes back it
  // simply dedupes against what the poll already admitted.

  /** True while an alarm-poll is in flight. celld does NOT serialize
   *  DO alarms (learned the hard way in #131), so overlapping alarms
   *  must short-circuit rather than double-poll. */
  private pollInFlight = false;

  private async ensurePollAlarm(): Promise<void> {
    if ((await this.state.storage.getAlarm()) == null) {
      await this.state.storage.setAlarm(Date.now() + 5_000);
    }
  }

  async alarm(): Promise<void> {
    try {
      if (!this.pollInFlight) {
        this.pollInFlight = true;
        try {
          await this.pollFiringAlerts();
        } finally {
          this.pollInFlight = false;
        }
      }
    } catch {
      /* next tick retries; polling must never wedge the alarm chain */
    } finally {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }

  /** One poll: run the firing-alert selection (same shape as the app's
   *  Q.alertNotify()) and admit the rows. */
  private async pollFiringAlerts(): Promise<void> {
    if (this.env.DISABLED === 'true') return;
    const { CRIBL_BASE_URL, CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET } = this.env;
    if (!CRIBL_BASE_URL || (!this.env.CRIBL_DEV_TOKEN && (!CRIBL_CLIENT_ID || !CRIBL_CLIENT_SECRET))) {
      return; // no Cribl access configured (e.g. offline smoke) — poll is a no-op
    }
    const dataset = (this.env.CRIBL_DATASET || 'otel').replace(/[^a-zA-Z0-9_-]/g, '');
    const client = new CriblClient({
      baseUrl: CRIBL_BASE_URL,
      clientId: CRIBL_CLIENT_ID ?? '',
      clientSecret: CRIBL_CLIENT_SECRET ?? '',
      dataset,
      devToken: this.env.CRIBL_DEV_TOKEN,
    });
    // Keep in sync with Q.alertNotify() in src/api/queries.ts — the
    // app's queries module carries browser-coupled imports, so the
    // small stable KQL is built here from the shared contract pieces.
    const kql = `dataset="${dataset}"
      | where ${STORED_DATATYPE_EXPR} == "${ALERT_EVENT_DATATYPE}"
      | where record_kind == "evaluation"
      | where event_type == "firing"
      | where isnull(is_canary) or tostring(is_canary) != "true"
      | summarize _time=max(_time)
        by event_id, alert_id, svc, signal_type, curr_error_rate, fire_count
      | project event_id, alert_id, svc, signal_type, curr_error_rate, fire_count, _time
      | sort by _time desc
      | limit 50`;
    const rows = await client.runQuery(kql, POLL_WINDOW, 'now', 50);
    if (rows.length === 0) return;
    const alerts: FiringAlert[] = rows.map((r) => ({
      event_id: String(r.event_id ?? ''),
      alert_id: String(r.alert_id ?? ''),
      svc: String(r.svc ?? ''),
      signal_type: String(r.signal_type ?? ''),
      curr_error_rate: Number(r.curr_error_rate ?? 0),
      fire_count: Number(r.fire_count ?? 0),
      _time: Number(r._time ?? 0),
    }));
    if (this.admitAlerts(alerts) > 0) await this.pump();
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
              // Provisioned default repos so this alert-fired run can
              // check out the implicated service's source (empty → the
              // DO falls back to the cell's REPOS_JSON env).
              repos: await this.defaultRepos(),
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
