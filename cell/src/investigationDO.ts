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
import { setCurrentDataset } from '@cribl/app-utils/dataset';
import {
  buildAlertSeed,
  buildSeedPrompt,
  type InvestigationSeed,
} from '../../src/api/agentContext';
import {
  runPreflight,
  formatPreflightSignals,
} from '../../src/api/agentPreflight';
import { createApmToolExecutors, type ApmToolExecutors } from '../../src/api/agentTools';
import type { AgentToolDefinition } from '@cribl/app-utils/agent';
import { RepoStore } from './workspace/repoStore';
import {
  createCodeToolExecutors,
  CODE_TOOL_DEFINITIONS,
  codeToolsAddendum,
} from './agent/codeTools';
import type { RepoConfig } from './workspace/checkout';
import type { Env } from './env';
import { CriblClient } from './criblClient';
import { createCellSearchClient, createCellMetricsTransport } from './cellSearchClient';
import {
  PROTOCOL_VERSION,
  incidentKey,
  titleFromPrompt,
  type CreateInvestigationBody,
  type FiringAlert,
  type InvestigationMode,
  type InvestigationStatus,
  type ServerFrame,
  type WireLoopEvent,
} from './protocol';
import { runRealTurn, type LlmConfig } from './agent/realTurn';
import { stubTurnEvents } from './stubAgent';
import type { Message, UserMessage } from '@earendil-works/pi-ai';

const TURN_DELAY_MS = 1_000;
const SCHEMA_VERSION = 1;
/** Parity with the client loop's cap (framework agent-loop.ts). */
const MAX_TURNS = 12;

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
  alert: FiringAlert;
  seed: unknown;
}

export class InvestigationDO {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private criblRef: CriblClient | null = null;
  /** Re-entrancy guard for alarm(). Cloudflare serializes DO alarms;
   *  celld does not, so a turn whose LLM stream outlasts the 1s
   *  reschedule interval would otherwise overlap with the next
   *  alarm — spawning many concurrent LLM calls, racing the turn
   *  counter, and flooding the transcript. Set synchronously at the
   *  top of alarm() before any await so a later invocation bails. */
  private turnInFlight = false;

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
      this.state.storage.sql.exec(
        `INSERT INTO investigation
           (id, alert_id, trigger_event_id, incident_key, status, seed_json, created_at, schema_version)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`,
        body.id,
        body.alert.alert_id,
        body.alert.event_id,
        incidentKey(body.alert),
        JSON.stringify(body.seed ?? null),
        Date.now(),
        SCHEMA_VERSION,
      );
      await this.state.storage.put('alert', body.alert);
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
      });
      this.setStatus('running', { started_at: Date.now() });
      await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      return Response.json({ ok: true });
    }

    if (url.pathname.endsWith('/messages') && request.method === 'POST') {
      const row = this.row();
      if (!row) return Response.json({ error: 'not found' }, { status: 404 });
      if (row.mode !== 'interactive') {
        return Response.json({ error: 'not an interactive investigation' }, { status: 400 });
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
      // whole-conversation turn count.
      this.state.storage.sql.exec(
        `UPDATE investigation SET turn_budget = ?`,
        turn + MAX_TURNS,
      );
      this.setStatus('running', { started_at: Date.now() });
      await this.notifyCoordinator('resumed');
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

  private cribl(): CriblClient | null {
    if (this.criblRef) return this.criblRef;
    const { CRIBL_BASE_URL, CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET } = this.env;
    if (!CRIBL_BASE_URL || (!this.env.CRIBL_DEV_TOKEN && (!CRIBL_CLIENT_ID || !CRIBL_CLIENT_SECRET))) {
      return null;
    }
    this.criblRef = new CriblClient({
      baseUrl: CRIBL_BASE_URL,
      clientId: CRIBL_CLIENT_ID ?? '',
      clientSecret: CRIBL_CLIENT_SECRET ?? '',
      dataset: this.env.CRIBL_DATASET ?? 'otel',
      devToken: this.env.CRIBL_DEV_TOKEN,
    });
    return this.criblRef;
  }

  /**
   * First-alarm setup for real mode: build the seed exactly like the
   * Alerts page does, enrich it with the preflight (same signals the
   * browser injects), render the seed prompt, and persist it as
   * history[0]. Idempotent — keyed on the stored prompt.
   */
  /** Server-only code-tools guidance appended to the seed prompt when
   *  the cell has source repos configured (empty otherwise). */
  private codeAddendum(): string {
    const repos = parseReposConfig(this.env.REPOS_JSON);
    return repos.length ? codeToolsAddendum(repos) : '';
  }

  private async ensureSeeded(alert: FiringAlert, cribl: CriblClient): Promise<void> {
    const existing = await this.state.storage.get<string>('seedPromptDone');
    if (existing) return;

    setCurrentDataset(cribl.dataset);
    const seed: InvestigationSeed = buildAlertSeed({
      service: alert.svc,
      signalType: alert.signal_type,
      errorRate: Number(alert.curr_error_rate ?? 0),
    });

    // Preflight parity with InvestigatePage.enrichSeed(): silent
    // services, rate drops, error spikes, recent deploys — injected
    // as known signals. Best-effort by construction (runPreflight
    // swallows failures into an empty result).
    const client = createCellSearchClient(cribl);
    const preflight = await runPreflight(seed.earliest ?? '-1h', seed.latest ?? 'now', client);
    seed.knownSignals = [
      ...(seed.knownSignals ?? []),
      ...formatPreflightSignals(preflight),
    ];

    const prompt = buildSeedPrompt(seed) + this.codeAddendum();
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
   * The user's opening prompt becomes the seed question, run through
   * the same buildSeedPrompt() preamble the browser and the alert path
   * use — so the agent has the identical dataset schema + KQL guidance.
   * No preflight: the user drives the question directly, and skipping
   * it keeps the first response fast.
   */
  private async ensureSeededInteractive(cribl: CriblClient): Promise<void> {
    const existing = await this.state.storage.get<string>('seedPromptDone');
    if (existing) return;
    const payload = await this.state.storage.get<{
      prompt: string;
      context?: { service?: string; earliest?: string; latest?: string } | null;
    }>('interactivePayload');
    const prompt = payload?.prompt ?? '';

    setCurrentDataset(cribl.dataset);
    const seed: InvestigationSeed = {
      question: prompt,
      service: payload?.context?.service,
      earliest: payload?.context?.earliest,
      latest: payload?.context?.latest,
    };
    const seedPrompt = buildSeedPrompt(seed) + this.codeAddendum();
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
    eventType: 'started' | 'investigated' | 'investigation_failed',
    conclusionText?: string,
  ): Promise<void> {
    const cribl = this.cribl();
    const row = this.row();
    if (!cribl || !row) return;
    const alert = await this.state.storage.get<FiringAlert>('alert');
    try {
      await cribl.commitInvestigationEvent({
        event_id: `${row.id}:${eventType}`,
        event_type: eventType,
        alert_id: String(row.alert_id),
        investigation_id: String(row.id),
        trigger_event_id: String(row.trigger_event_id),
        svc: alert?.svc ?? '',
        signal_type: alert?.signal_type ?? '',
        conclusion: conclusionText,
      });
    } catch (err) {
      // The commit is the durable record for the Alerts page, but a
      // Cribl outage must not fail the investigation itself. The
      // transcript notes the gap instead.
      this.append({
        kind: 'notification',
        turnId: 'lifecycle',
        content: `Could not commit '${eventType}' event to the dataset: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  /** Extract a ≤1KB text snippet from a SummaryUi-shaped conclusion. */
  private conclusionSnippet(conclusion: unknown): string {
    if (conclusion && typeof conclusion === 'object') {
      const c = conclusion as { conclusion?: unknown };
      if (typeof c.conclusion === 'string') return c.conclusion;
    }
    return '';
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
    // Autonomous investigations carry the alert facts; interactive ones
    // don't (they seed from the user's prompt).
    const alert = interactive
      ? null
      : (await this.state.storage.get<FiringAlert>('alert'))!;
    const turn = Number(row.turn ?? 0);
    const llm = this.llmConfig();
    const cribl = this.cribl();

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

      if (llm && cribl) {
        // ── real mode: one pi turn per alarm ──
        if (interactive) await this.ensureSeededInteractive(cribl);
        else await this.ensureSeeded(alert!, cribl);
        const apmExecutors = createApmToolExecutors({
          client: createCellSearchClient(cribl),
          dataset: () => cribl.dataset,
          metricsTransport: createCellMetricsTransport(cribl),
        });
        // Server-only code tools, offered only when repos are configured.
        const repos = parseReposConfig(this.env.REPOS_JSON);
        let executors: ApmToolExecutors = apmExecutors;
        let extraTools: AgentToolDefinition[] | undefined;
        if (repos.length > 0) {
          const codeExec = createCodeToolExecutors({
            store: new RepoStore(this.state.storage.sql),
            repos,
            token: this.env.GITHUB_TOKEN,
            targetService: alert?.svc,
          });
          executors = {
            executeToolCall: (call, signal) =>
              codeExec.names.has(call.name)
                ? codeExec.executeToolCall(call)
                : apmExecutors.executeToolCall(call, signal),
          };
          extraTools = CODE_TOOL_DEFINITIONS;
        }
        const result = await runRealTurn({
          llm,
          history: await this.history(),
          turnIndex: turn,
          executors,
          extraTools,
          emit: (ev) => this.append(ev),
        });
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
      } else {
        // ── autonomous stub (no LLM configured): scaffold behavior ──
        const stub = stubTurnEvents(turn, alert!);
        for (const ev of stub.events) {
          if (
            ev.kind === 'toolResult' &&
            ev.result.name === 'present_investigation_summary'
          ) {
            conclusion = ev.result.ui ?? null;
          }
          this.append(ev);
        }
        done = stub.done;
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
          await this.commitLifecycle('investigated', this.conclusionSnippet(conclusion));
          await this.notifyCoordinator('concluded');
        }
      } else {
        await this.state.storage.setAlarm(Date.now() + TURN_DELAY_MS);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.append({ kind: 'error', message });
      // Interactive: park so the conversation survives a transient
      // error; autonomous: fail the run.
      if (interactive) await this.parkIdle();
      else await this.failRun(message);
    }
  }

  /** Park an interactive investigation: loop yielded, awaiting the next
   *  user message. Non-terminal — no concluded_at, no lifecycle commit. */
  private async parkIdle(): Promise<void> {
    this.setStatus('idle');
    await this.notifyCoordinator('idle');
  }

  /** Fail an autonomous investigation and record it for the Alerts page. */
  private async failRun(message: string): Promise<void> {
    this.setStatus('failed', { concluded_at: Date.now(), error: message });
    await this.commitLifecycle('investigation_failed');
    await this.notifyCoordinator('failed');
  }

  private async notifyCoordinator(
    outcome: 'concluded' | 'failed' | 'idle' | 'resumed',
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
