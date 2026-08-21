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
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import { RepoStore } from './workspace/repoStore';
import {
  createCodeToolExecutors,
  CODE_TOOL_DEFINITIONS,
  codeToolsAddendum,
} from './agent/codeTools';
import type { RepoConfig } from './workspace/checkout';
import type { Env } from './env';
import { payload, type CellTrigger } from './payload.instance';
import type { LifecycleEvent, ToolExecutors } from './payload';
import {
  PROTOCOL_VERSION,
  isTerminalStatus,
  titleFromPrompt,
  type CreateInvestigationBody,
  type InvestigationMode,
  type InvestigationStatus,
  type ServerFrame,
  type WireLoopEvent,
} from './protocol';
import { runRealTurn, type LlmConfig } from './agent/realTurn';
import type { Message, UserMessage } from '@earendil-works/pi-ai';

const TURN_DELAY_MS = 1_000;
const SCHEMA_VERSION = 1;
/** Parity with the client loop's cap (framework agent-loop.ts). */
const MAX_TURNS = 12;
/** Watchdog alarm delay — must exceed runRealTurn's whole-turn timeout
 *  (180s) plus margin, so it only fires when a turn's isolate died
 *  mid-run rather than racing a healthy turn. */
const TURN_WATCHDOG_MS = 240_000;

// Persisted-event size caps. Real staging metrics/search results are
// far larger than the stub's canned events, and every event is stored
// in SQLite + replayed. Cloudflare DO SQLite requires a query result
// to fit in memory, so an unbounded ui payload (a metrics range query
// carries every point of every series; a search carries every row)
// eventually makes reads throw "result set is too large to fit in
// memory" and wedges the whole DO. Cap what we persist: the agent
// already gets a bounded textual summary; the UI card only needs
// enough to be legible.
const MAX_UI_SERIES = 24;
const MAX_UI_POINTS_PER_SERIES = 400;
const MAX_UI_ROWS = 200;
/** Hard ceiling on a single stored event; beyond it, drop the ui and
 *  keep the (already-bounded) textual content. */
const MAX_EVENT_BYTES = 96 * 1024;

interface CappableUi {
  kind?: string;
  series?: Array<{ name?: string; points?: unknown[] }>;
  rows?: unknown[];
  spans?: unknown[];
  trace?: { spans?: unknown[] };
  [k: string]: unknown;
}

/** Return a size-bounded copy of a wire event for storage + fanout. */
export function capEvent(ev: WireLoopEvent): WireLoopEvent {
  if (ev.kind !== 'toolResult' || ev.result.ui == null) return ev;
  const ui = ev.result.ui as CappableUi;
  let next: CappableUi = ui;
  const clone = () => (next === ui ? (next = { ...ui }) : next);

  if (Array.isArray(ui.series) && ui.series.length > 0) {
    clone().series = ui.series.slice(0, MAX_UI_SERIES).map((s) => ({
      ...s,
      points: Array.isArray(s.points) ? s.points.slice(0, MAX_UI_POINTS_PER_SERIES) : s.points,
    }));
  }
  if (Array.isArray(ui.rows) && ui.rows.length > MAX_UI_ROWS) {
    clone().rows = ui.rows.slice(0, MAX_UI_ROWS);
  }
  if (Array.isArray(ui.spans) && ui.spans.length > MAX_UI_ROWS) {
    clone().spans = ui.spans.slice(0, MAX_UI_ROWS);
  }

  let out: WireLoopEvent = next === ui ? ev : { ...ev, result: { ...ev.result, ui: next } };
  // Final byte guard: if the card is still huge (e.g. a giant trace),
  // drop the ui entirely — the agent's textual content is what the
  // loop reasons over, and it's already bounded.
  if (JSON.stringify(out).length > MAX_EVENT_BYTES) {
    out = {
      ...ev,
      result: {
        ...ev.result,
        ui: { kind: (ui.kind as string) ?? 'unknown', truncated: true },
      },
    };
  }
  return out;
}

/** Parse the cell's REPOS_JSON env into a repo list (empty on any
 *  problem — code tools just aren't offered). */
function parseReposConfig(json: string | undefined): RepoConfig[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is RepoConfig =>
        !!r && typeof (r as RepoConfig).url === 'string',
    );
  } catch {
    return [];
  }
}

interface StartBody {
  id: string;
  alert: CellTrigger;
  seed: unknown;
  /** Default source repos for this autonomous run, threaded from the
   *  coordinator's provisioned default (Settings → provisioning →
   *  /config/repos). The alert webhook carries no repos itself, and the
   *  cell can't read the app-settings KV, so this is how Settings repos
   *  reach an alert-fired investigation. */
  repos?: RepoConfig[] | null;
}

export class InvestigationDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  /** Re-entrancy guard for alarm(). Cloudflare serializes DO alarms;
   *  celld does not, so a turn whose LLM stream outlasts the 1s
   *  reschedule interval would otherwise overlap with the next
   *  alarm — spawning many concurrent LLM calls, racing the turn
   *  counter, and flooding the transcript. Set synchronously at the
   *  top of alarm() before any await so a later invocation bails. */
  private turnInFlight = false;

  /** Aborts the in-flight turn when the user cancels. celld serializes
   *  fetch + alarm on the DO's single thread, but a fetch can interleave
   *  at the turn's await points — so POST /cancel can abort the LLM
   *  stream (and the checkout store loop) mid-turn. Null when no turn is
   *  running. */
  private turnAbort: AbortController | null = null;
  /** Set by POST /cancel so the interleaving turn, when it unwinds, does
   *  NOT overwrite the terminal 'cancelled' status with idle/failed. */
  private cancelRequested = false;

  /**
   * Next transcript seq to hand out. Seeded lazily from the table on
   * first append after a hydration, then kept in memory: a Durable
   * Object is single-threaded and is the only writer to this table,
   * so nothing else can take a seq between the read and the insert.
   *
   * This exists so append() costs one statement. It used to INSERT
   * and then scan MAX(seq) to learn what the insert had allocated,
   * which is two statements per transcript event — and once the real
   * agent loop streams assistant text, an event is roughly a token.
   */
  private nextSeq: number | null = null;

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
    // Interactive-mode columns. Idempotent (SQLite lacks ADD COLUMN IF
    // NOT EXISTS): a duplicate-column error on a migrated DO is ignored.
    // `turn_budget` is the absolute turn index at which the current
    // user-message batch must stop — reset on every /messages so the
    // MAX_TURNS cap applies per message, not per whole conversation.
    this.addColumn('mode', `TEXT NOT NULL DEFAULT 'autonomous'`);
    this.addColumn('title', 'TEXT');
    this.addColumn('turn_budget', 'INTEGER');
  }

  private addColumn(name: string, decl: string): void {
    try {
      this.state.storage.sql.exec(
        `ALTER TABLE investigation ADD COLUMN ${name} ${decl}`,
      );
    } catch {
      /* column already exists on a previously-migrated object */
    }
  }

  // ── row helpers ────────────────────────────────────────────────

  // Small, hot-path columns only. `SELECT *` pulls seed_json and
  // conclusion_json — the seed prompt and the summary payload can be
  // tens of KB, and celld caps a single SQL result's in-memory size,
  // so `SELECT *` on the per-alarm read threw "result set is too
  // large to fit in memory". The big JSON columns are read on demand
  // by seedJson()/conclusionJson() only where they're actually
  // rendered (the /ws hello and /status endpoints).
  private row(): Record<string, unknown> | null {
    const rows = this.state.storage.sql
      .exec(
        `SELECT id, alert_id, trigger_event_id, incident_key, status,
                error, created_at, started_at, concluded_at, turn, schema_version,
                mode, turn_budget
         FROM investigation LIMIT 1`,
      )
      .toArray();
    return rows[0] ?? null;
  }

  private seedJson(): string | null {
    const r = this.state.storage.sql
      .exec(`SELECT seed_json FROM investigation LIMIT 1`)
      .toArray()[0];
    return r ? String(r.seed_json) : null;
  }

  private conclusionJson(): string | null {
    const r = this.state.storage.sql
      .exec(`SELECT conclusion_json FROM investigation LIMIT 1`)
      .toArray()[0];
    return r && r.conclusion_json != null ? String(r.conclusion_json) : null;
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
    if (this.nextSeq === null) this.nextSeq = this.latestSeq() + 1;
    const seq = this.nextSeq++;
    const capped = capEvent(ev);
    this.state.storage.sql.exec(
      `INSERT INTO transcript_events (seq, ev_json, created_at) VALUES (?, ?, ?)`,
      seq,
      JSON.stringify(capped),
      Date.now(),
    );
    this.fanout({ type: 'event', seq, ev: capped });
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
      const facts = payload.triggerFacts(body.alert);
      this.state.storage.sql.exec(
        `INSERT INTO investigation
           (id, alert_id, trigger_event_id, incident_key, status, seed_json, created_at, schema_version)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        body.id,
        facts.subjectId,
        facts.dedupeKey,
        facts.groupKey,
        JSON.stringify(body.seed ?? null),
        Date.now(),
        SCHEMA_VERSION,
      );
      await this.state.storage.put('alert', body.alert);
      // The coordinator's provisioned default repos (may be null). Read
      // by ensureSeeded() and every turn so an alert-fired investigation
      // gets the same code tools an interactive one carries from Settings.
      await this.state.storage.put('autonomousRepos', body.repos ?? null);
      this.setStatus('running', { started_at: Date.now() });
      // The 'started' commit powers the Alerts page's "Investigating…"
      // badge. Fire-and-forget: commitLifecycle never throws, and the
      // coordinator's pump must not wait on a search job.
      const startCommit = this.commitLifecycle('started');
      if (typeof this.state.waitUntil === 'function') {
        this.state.waitUntil(startCommit);
      }
      await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/create') && request.method === 'POST') {
      const body = (await request.json()) as CreateInvestigationBody & { id: string };
      if (this.row()) {
        return Response.json({ ok: true, already: true });
      }
      const prompt = typeof body?.prompt === 'string' ? body.prompt : '';
      if (!prompt.trim()) {
        return Response.json({ error: 'prompt required' }, { status: 400 });
      }
      const title = (body.title?.trim() || titleFromPrompt(prompt)).slice(0, 120);
      this.state.storage.sql.exec(
        `INSERT INTO investigation
           (id, alert_id, trigger_event_id, incident_key, status, seed_json,
            created_at, schema_version, mode, title, turn_budget)
         VALUES (?, '', ?, 'interactive', 'queued', 'null', ?, ?, 'interactive', ?, ?)`,
        body.id,
        body.id,
        Date.now(),
        SCHEMA_VERSION,
        title,
        MAX_TURNS,
      );
      // The opening prompt + context; consumed once by
      // ensureSeededInteractive() on the first alarm.
      await this.state.storage.put('interactivePayload', {
        prompt,
        context: body.context ?? null,
        repos: body.repos ?? null,
      });
      this.setStatus('running', { started_at: Date.now() });
      await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/messages') && request.method === 'POST') {
      const row = this.row();
      if (!row) return Response.json({ error: 'not found' }, { status: 404 });
      // Any investigation can take a follow-up — including a concluded
      // autonomous one. Reject only while it's actively working (a
      // message mid-run would race the loop).
      if (row.status === 'running' || row.status === 'queued') {
        return Response.json({ error: 'investigation is still running' }, { status: 409 });
      }
      const { content } = (await request.json()) as { content?: string };
      if (!content || !content.trim()) {
        return Response.json({ error: 'content required' }, { status: 400 });
      }
      // Append the user's turn to the pi history and resume the loop.
      const userMsg: UserMessage = { role: 'user', content, timestamp: Date.now() };
      this.state.storage.sql.exec(
        `INSERT INTO agent_messages (message_json) VALUES (?)`,
        JSON.stringify(userMsg),
      );
      const turn = Number(row.turn ?? 0);
      // Also record it as a transcript event (ordered before the assistant's
      // reply) so a reopened session replays the user's message, not just the
      // agent's response.
      this.append({ kind: 'userMessage', turnId: `user-${turn}`, content });
      // Fresh per-message turn budget so a long chat isn't killed by the
      // whole-conversation turn count. Reopening a concluded/failed run
      // also flips it to interactive (so the next answer PARKS at idle
      // rather than re-concluding + re-committing a lifecycle event) and
      // clears its terminal fields.
      this.state.storage.sql.exec(
        `UPDATE investigation
           SET turn_budget = ?, mode = 'interactive', concluded_at = NULL, error = NULL`,
        turn + MAX_TURNS,
      );
      this.setStatus('running', { started_at: Date.now() });
      await this.notifyCoordinator('resumed');
      await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/cancel') && request.method === 'POST') {
      const row = this.row();
      if (!row) return Response.json({ error: 'not found' }, { status: 404 });
      // Idempotent: cancelling an already-terminal run is a no-op success.
      if (isTerminalStatus(row.status as InvestigationStatus)) {
        return Response.json({ ok: true, status: row.status });
      }
      // Own the terminal state before aborting the turn: the guard flag
      // stops the interleaving turn from reparking/failing as it unwinds.
      this.cancelRequested = true;
      this.turnAbort?.abort();
      // Drop the watchdog/next-turn alarm so nothing re-fires the loop.
      await this.state.storage.deleteAlarm();
      this.append({ kind: 'notification', turnId: 'system', content: 'Investigation cancelled by the user.' });
      this.append({ kind: 'done', reason: 'aborted' });
      this.setStatus('cancelled', { concluded_at: Date.now() });
      // An autonomous run records the outcome for the Alerts page; an
      // interactive one has no badge, so skip the lifecycle commit.
      if ((row.mode as InvestigationMode) !== 'interactive') {
        await this.commitLifecycle('failed');
      }
      await this.notifyCoordinator('cancelled');
      return Response.json({ ok: true, status: 'cancelled' });
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
        mode: (row.mode as InvestigationMode) ?? 'autonomous',
        title: row.title ?? null,
        alertId: row.alert_id,
        incidentKey: row.incident_key,
        createdAt: row.created_at,
        startedAt: row.started_at,
        concludedAt: row.concluded_at,
        // The small InvestigationSeed (not the ~75KB prompt, which lives
        // in a separate KV entry). Lets the UI show the opening question
        // when replaying a past interactive conversation.
        seed: (() => {
          const s = this.seedJson();
          return s ? JSON.parse(s) : null;
        })(),
        conclusion: (() => {
          const c = this.conclusionJson();
          return c ? JSON.parse(c) : null;
        })(),
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
          seed: (() => {
            const sj = this.seedJson();
            return sj ? JSON.parse(sj) : null;
          })(),
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

  // ── agent-mode wiring ──────────────────────────────────────────

  private llmConfig(): LlmConfig | null {
    if (!this.env.LLM_BASE_URL) return null;
    return {
      baseUrl: this.env.LLM_BASE_URL,
      apiKey: this.env.LLM_API_KEY ?? '',
      model: this.env.LLM_MODEL ?? 'gpt-4.1',
    };
  }

  /** Server-only code-tools guidance appended to the seed prompt when
   *  source repos are configured (empty otherwise). */
  private codeAddendum(repos: RepoConfig[]): string {
    return repos.length ? codeToolsAddendum(repos) : '';
  }

  /** The repos the agent may check out: the investigation's own (from
   *  app Settings — interactive payload, or an autonomous run's
   *  coordinator-provisioned default) if present, else the cell's
   *  REPOS_JSON env fallback. */
  private effectiveRepos(payloadRepos?: RepoConfig[] | null): RepoConfig[] {
    return payloadRepos && payloadRepos.length
      ? payloadRepos
      : parseReposConfig(this.env.REPOS_JSON);
  }

  /** Autonomous run's default repos, stored at /start from the
   *  coordinator's provisioned default. Null for older runs / when
   *  provisioning never pushed a list. */
  private async autonomousRepos(): Promise<RepoConfig[] | null> {
    return (
      (await this.state.storage.get<RepoConfig[] | null>('autonomousRepos')) ?? null
    );
  }

  /**
   * First-alarm setup for real mode: the payload builds the seed
   * (for APM: buildAlertSeed + preflight parity with the browser's
   * InvestigatePage.enrichSeed()), and the harness appends its own
   * code-tools addendum. Idempotent — keyed on the stored prompt.
   */
  private async ensureSeeded(trigger: CellTrigger): Promise<void> {
    const existing = await this.state.storage.get<string>('seedPromptDone');
    if (existing) return;

    const { prompt: seedPrompt, seed } = await payload.buildSeed(trigger, this.env);
    const prompt =
      seedPrompt +
      this.codeAddendum(this.effectiveRepos(await this.autonomousRepos()));
    // The seed prompt is ~75 KB (the dataset-schema preamble). Keep it
    // OUT of the agent_messages SQLite table — history() reads that
    // whole table every turn, and a 75 KB constant row pushes the DO's
    // SQLite over celld's in-memory read cap. Store it as a single
    // DO key-value entry instead (read by key, never scanned), and
    // prepend it as history[0] at loop time.
    await this.state.storage.put('seedPrompt', prompt);
    this.state.storage.sql.exec(
      `UPDATE investigation SET seed_json = ?`,
      JSON.stringify(seed),
    );
    await this.state.storage.put('seedPromptDone', true);
  }

  /**
   * First-alarm setup for an interactive (UI-started) investigation.
   * The payload turns the user's opening prompt into the seed (for
   * APM: the same buildSeedPrompt() preamble the browser and the
   * alert path use, no preflight — the user drives the question
   * directly, and skipping it keeps the first response fast).
   */
  private async ensureSeededInteractive(): Promise<void> {
    const existing = await this.state.storage.get<string>('seedPromptDone');
    if (existing) return;
    const stored = await this.state.storage.get<{
      prompt: string;
      context?: { service?: string; earliest?: string; latest?: string } | null;
      repos?: RepoConfig[] | null;
    }>('interactivePayload');

    const { prompt: base, seed } = await payload.buildInteractiveSeed(
      { prompt: stored?.prompt ?? '', context: stored?.context ?? null },
      this.env,
    );
    const seedPrompt = base + this.codeAddendum(this.effectiveRepos(stored?.repos));
    await this.state.storage.put('seedPrompt', seedPrompt);
    this.state.storage.sql.exec(
      `UPDATE investigation SET seed_json = ?`,
      JSON.stringify(seed),
    );
    await this.state.storage.put('seedPromptDone', true);
  }

  /** The full pi conversation: the seed prompt (history[0], stored as
   *  a DO KV entry, not in SQLite) followed by the accumulated
   *  assistant + tool-result messages. */
  private async history(): Promise<Message[]> {
    const prompt = (await this.state.storage.get<string>('seedPrompt')) ?? '';
    const seedMsg: UserMessage = { role: 'user', content: prompt, timestamp: 0 };
    const stored = this.state.storage.sql
      .exec(`SELECT message_json FROM agent_messages ORDER BY seq`)
      .toArray()
      .map((r) => JSON.parse(String(r.message_json)) as Message);
    return [seedMsg, ...stored];
  }

  private async commitLifecycle(
    type: LifecycleEvent<CellTrigger>['type'],
    conclusionText?: string,
  ): Promise<void> {
    if (!payload.commitLifecycle) return;
    const row = this.row();
    if (!row) return;
    const trigger =
      (await this.state.storage.get<CellTrigger>('alert')) ?? null;
    try {
      await payload.commitLifecycle(this.env, {
        type,
        sessionId: String(row.id),
        subjectId: String(row.alert_id),
        triggerDedupeKey: String(row.trigger_event_id),
        trigger,
        conclusionText,
      });
    } catch (err) {
      // The commit is the payload's durable record (for APM, the
      // Alerts page badges), but an outage there must not fail the
      // investigation itself. The transcript notes the gap instead.
      this.append({
        kind: 'notification',
        turnId: 'lifecycle',
        content: `Could not commit '${type}' lifecycle event: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // ── the alarm-driven loop ──────────────────────────────────────

  async alarm(): Promise<void> {
    // Serialize turns: celld can dispatch the next alarm before this
    // handler's LLM stream returns. Without this guard those overlap
    // into many concurrent LLM calls that race the turn counter and
    // flood the transcript. The in-flight turn reschedules the next
    // alarm when it finishes, so bailing here loses nothing.
    if (this.turnInFlight) return;
    this.turnInFlight = true;
    // Watchdog: the per-turn timeout in runRealTurn recovers a hung LLM
    // or tool while THIS isolate lives, but if celld evicts the isolate
    // mid-turn (e.g. the handler exceeds its budget), the run is left
    // 'running' with no pending alarm. Set a durable alarm now so a fresh
    // isolate re-fires and re-runs the turn (turnInFlight resets per
    // isolate; runTurn no-ops if the row is no longer 'running'). A normal
    // turn reschedules its own next alarm on completion, replacing this.
    await this.state.storage.setAlarm(Date.now() + TURN_WATCHDOG_MS);
    try {
      await this.runTurn();
    } finally {
      this.turnInFlight = false;
    }
  }

  private async runTurn(): Promise<void> {
    const row = this.row();
    if (!row || row.status !== 'running') return;

    const mode = (row.mode as InvestigationMode) ?? 'autonomous';
    const interactive = mode === 'interactive';
    // Autonomous investigations carry the trigger facts; interactive
    // ones don't (they seed from the user's prompt).
    const trigger = interactive
      ? null
      : (await this.state.storage.get<CellTrigger>('alert'))!;
    const turn = Number(row.turn ?? 0);
    const llm = this.llmConfig();
    const backendReady = payload.ready(this.env);

    try {
      // Turn cap. Interactive uses a per-message budget and PARKS
      // (stays resumable) when it's hit; autonomous fails the run.
      const cap = interactive ? Number(row.turn_budget ?? MAX_TURNS) : MAX_TURNS;
      if (turn >= cap) {
        if (interactive) {
          this.append({
            kind: 'notification',
            turnId: 'system',
            content: `Reached the ${MAX_TURNS}-step limit for this message. Ask a follow-up to continue.`,
          });
          this.append({ kind: 'done', reason: 'complete' });
          await this.parkIdle();
          return;
        }
        const message = `Investigation hit the ${MAX_TURNS}-turn cap without concluding.`;
        this.append({ kind: 'error', message });
        await this.failRun(message);
        return;
      }

      let done: boolean;
      let conclusion: unknown = null;

      if (llm && backendReady) {
        // ── real mode: one pi turn per alarm ──
        if (interactive) await this.ensureSeededInteractive();
        else await this.ensureSeeded(trigger!);
        const domain = payload.createTools(this.env);
        // Server-only code tools, offered only when repos are configured.
        // Interactive investigations carry their own repos (from app
        // Settings); autonomous ones fall back to the cell's REPOS_JSON.
        const sessionRepos = interactive
          ? (await this.state.storage.get<{ repos?: RepoConfig[] | null }>('interactivePayload'))
              ?.repos
          : await this.autonomousRepos();
        const repos = this.effectiveRepos(sessionRepos);
        let executors: ToolExecutors = domain.executors;
        let tools: AgentToolDefinition[] = domain.definitions;
        if (repos.length > 0) {
          const codeExec = createCodeToolExecutors({
            store: new RepoStore(this.state.storage.sql),
            repos,
            token: this.env.GITHUB_TOKEN,
            targetService: payload.targetService?.(trigger),
          });
          executors = {
            executeToolCall: (call, signal) =>
              codeExec.names.has(call.name)
                ? codeExec.executeToolCall(call, signal)
                : domain.executors.executeToolCall(call, signal),
          };
          tools = [...domain.definitions, ...CODE_TOOL_DEFINITIONS];
        }
        this.turnAbort = new AbortController();
        const result = await runRealTurn({
          llm,
          history: await this.history(),
          turnIndex: turn,
          tools,
          executors,
          concludingTool: payload.concludingToolName,
          emit: (ev) => this.append(ev),
          signal: this.turnAbort.signal,
        });
        // A concurrent POST /cancel aborted this turn and already set the
        // terminal state; don't reschedule or override it.
        if (this.cancelRequested) return;
        for (const m of result.newMessages) {
          this.state.storage.sql.exec(
            `INSERT INTO agent_messages (message_json) VALUES (?)`,
            JSON.stringify(m),
          );
        }
        if (result.errorMessage) {
          this.append({ kind: 'error', message: result.errorMessage });
          // Interactive: park so the user can retry; autonomous: fail.
          if (interactive) await this.parkIdle();
          else await this.failRun(result.errorMessage);
          return;
        }
        done = result.done;
        conclusion = result.conclusion;
        if (done) this.append({ kind: 'done', reason: 'complete' });
      } else if (interactive) {
        // ── interactive stub (no LLM): echo a canned reply, then park. ──
        this.append({
          kind: 'assistantText',
          turnId: `turn-${turn}`,
          chunk: 'Interactive investigation stub: no LLM configured on this cell.',
        });
        this.append({ kind: 'assistantDone', turnId: `turn-${turn}` });
        this.append({ kind: 'done', reason: 'complete' });
        done = true;
      } else if (payload.stubTurn) {
        // ── autonomous stub (no LLM configured): scaffold behavior ──
        const stub = payload.stubTurn(turn, trigger!);
        for (const ev of stub.events) this.append(ev);
        conclusion = stub.conclusion ?? null;
        done = stub.done;
      } else {
        // Payload ships no stub: conclude immediately rather than
        // burning turns emitting nothing.
        this.append({
          kind: 'notification',
          turnId: `turn-${turn}`,
          content: 'No LLM configured on this cell and the payload has no stub agent.',
        });
        this.append({ kind: 'done', reason: 'complete' });
        done = true;
      }

      this.state.storage.sql.exec(`UPDATE investigation SET turn = ?`, turn + 1);

      if (done) {
        if (interactive) {
          // Interactive runs never auto-conclude — they park awaiting
          // the next user message. No lifecycle commit (the cell's own
          // list is the record; there's no Alerts-page badge for these).
          await this.parkIdle();
        } else {
          this.setStatus('concluded', {
            concluded_at: Date.now(),
            conclusion_json: conclusion == null ? null : JSON.stringify(conclusion),
          });
          await this.commitLifecycle(
            'concluded',
            payload.conclusionSnippet?.(conclusion) ?? '',
          );
          await this.notifyCoordinator('concluded');
        }
      } else {
        await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      }
    } catch (err) {
      // A cancel aborted the turn — the /cancel handler owns the
      // terminal state; swallow the abort without reparking/failing.
      if (this.cancelRequested) return;
      const message = err instanceof Error ? err.message : String(err);
      this.append({ kind: 'error', message });
      // Interactive: park so the conversation survives a transient
      // error; autonomous: fail the run.
      if (interactive) await this.parkIdle();
      else await this.failRun(message);
    } finally {
      this.turnAbort = null;
    }
  }

  /** Park an interactive investigation: loop yielded, awaiting the next
   *  user message. Non-terminal — no concluded_at, no lifecycle commit. */
  private async parkIdle(): Promise<void> {
    this.setStatus('idle');
    await this.notifyCoordinator('idle');
  }

  /** Fail an autonomous investigation and record it durably. */
  private async failRun(message: string): Promise<void> {
    this.setStatus('failed', { concluded_at: Date.now(), error: message });
    await this.commitLifecycle('failed');
    await this.notifyCoordinator('failed');
  }

  private async notifyCoordinator(
    outcome: 'concluded' | 'failed' | 'idle' | 'resumed' | 'cancelled',
  ): Promise<void> {
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
