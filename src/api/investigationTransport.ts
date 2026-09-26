/**
 * UI transport for server-side investigations.
 *
 * This is now a thin adapter over `@criblio/app-utils/goattown`. The shared
 * client owns HTTP, the wire⇄LoopEvent mapping, polling, receipt-based
 * completion and the lifecycle calls. What stays here is only what is
 * genuinely APM's:
 *
 *  - the acting Cribl user (APM sessions are per signed-in user, not
 *    installation-wide — see the connected-app credential migration),
 *  - the `report_findings` → `present_investigation_summary` tool rename
 *    that gives a concluding call its "Preparing…" state,
 *  - the `APM: ` / `apm:` recall-panel filter and its pagination,
 *  - the full session record read, which the session protocol does not cover
 *    but replay and incident summaries need,
 *  - the investigation-flavoured names the rest of the UI imports.
 *
 * Completion semantics changed with this migration, and the difference
 * matters. The old loop stopped on a terminal session status, or on `idle`
 * when `stopOnIdle` was set. `idle` means "between turns" — a session is
 * idle before its first answer as well as after its last — so that could end
 * observation before the response was written, which read downstream as an
 * empty conclusion. Observation now follows the request receipt and drains
 * events through its `finalSeq`; a service without the `session-execution`
 * capability falls back to a terminal session status, never to idle.
 *
 * Transport remains short-poll over the platform fetch proxy: the sandboxed
 * iframe's CSP blocks raw WebSockets, but a proxied fetch is rewritten
 * same-origin. No `authorization` is set here — the proxy injects APM's
 * connected-app credential for the domain declared in `config/proxies.yml`
 * and strips any the page sets.
 */
import {
  GoatTownClient,
  conclusionFromEntries,
  observeSession,
  SessionDiagnostics,
  wireEventToLoopEvent as wireEventToLoopEventBase,
  isTerminalStatus,
  type MessageImage,
  type ObserveResult,
} from '@criblio/app-utils/goattown';
import { applyLoopEvent } from '@criblio/app-utils/investigator';
import type { LoopEvent } from '@criblio/app-utils/agent-loop';
import type {
  EventsResponse,
  SessionExecution,
  SessionLlmSettings,
  SessionMode,
  SessionStatus,
  SessionStatusResponse,
  SessionSummaryRow,
  SourceRepo,
  WireLoopEvent,
} from '@criblio/agent-protocol';
import { APM_INVESTIGATOR_AGENT } from './goatTownProvisioning';

export { isTerminalStatus };
export type { EventsResponse, SourceRepo, WireLoopEvent, SessionExecution, MessageImage };
export type InvestigationStatus = SessionStatus;
export type InvestigationMode = SessionMode;
/** One row of the recall panel. */
export type InvestigationSummary = SessionSummaryRow;
export type InvestigationStatusResponse = SessionStatusResponse;

/**
 * GoatTown's generic concluding tool is `report_findings`; the client-side
 * investigator's equivalent is `present_investigation_summary`.
 *
 * The rename is NOT needed to render the finished card: the transcript
 * dispatches a report on `ui.kind === 'report'`, which it checks before any
 * tool-name branch, and APM's own `renderApmToolCard` keys purely on
 * `ui.kind` too. What the rename buys is the state *before* the result
 * arrives — with no `ui` yet, the name branch is the only thing that
 * matches, and it renders "📋 Investigation summary — Preparing…". Without
 * it a concluding call renders nothing until its result lands, and the
 * summary appears abruptly. Keep it for that, not for card dispatch.
 */
function renameConcludingTool(ev: LoopEvent): LoopEvent {
  if (ev.kind !== 'toolCall' || ev.call.function.name !== 'report_findings') return ev;
  return {
    ...ev,
    call: {
      ...ev.call,
      function: { ...ev.call.function, name: 'present_investigation_summary' },
    },
  };
}

/**
 * Rehydrate one wire event into a framework LoopEvent.
 *
 * Delegates to the shared mapper — error→Error rehydration, wire-only
 * `userMessage` returning null, forward-compatible unknown kinds — and adds
 * APM's concluding-tool rename on top.
 */
export function wireEventToLoopEvent(ev: WireLoopEvent): LoopEvent | null {
  const loop = wireEventToLoopEventBase(ev);
  return loop ? renameConcludingTool(loop) : loop;
}

/**
 * Shared GoatTown's public host. MUST match the domain declared in
 * `config/proxies.yml` — the platform proxy only forwards fetches to
 * declared domains and injects APM's connected-app token there.
 */
export const SHARED_GOATTOWN_BASE_URL = 'https://goattown-shared.lab.cribl.io';

let cellBaseUrlOverride: string | null = null;

/** Test/development override. Production uses the package-pinned shared host. */
export function setCellBaseUrl(url: string | null | undefined): void {
  cellBaseUrlOverride = url && url.trim() ? url.trim().replace(/\/$/, '') : null;
  cachedClient = null;
}

/**
 * Resolve GoatTown's base URL: an explicit test/development override, then a
 * host global/build env, then the package-pinned shared service.
 */
export function getCellBaseUrl(): string {
  if (cellBaseUrlOverride) return cellBaseUrlOverride;
  const w = window as unknown as { CRIBL_APM_CELL_URL?: string };
  return (
    w.CRIBL_APM_CELL_URL ??
    (import.meta.env?.VITE_APM_CELL_URL as string | undefined) ??
    SHARED_GOATTOWN_BASE_URL
  ).replace(/\/$/, '');
}

async function currentUserId(): Promise<string> {
  try {
    const getCriblUser = (window as unknown as {
      getCriblUser?: () => Promise<{ id?: unknown }>;
    }).getCriblUser;
    const user = typeof getCriblUser === 'function' ? await getCriblUser() : null;
    if (typeof user?.id === 'string' && user.id) return user.id;
  } catch { /* surface the actionable error below */ }
  throw new Error('GoatTown requires a signed-in Cribl user, but getCriblUser() returned no id.');
}

let cachedClient: GoatTownClient | null = null;
let cachedBaseUrl = '';

/**
 * The shared client, rebuilt when the base URL changes.
 *
 * Cached rather than per-call because the client memoises `/protocol`, and
 * capability lookups sit on the send and observe paths.
 */
export function goatTownClient(): GoatTownClient {
  const baseUrl = getCellBaseUrl();
  if (!cachedClient || cachedBaseUrl !== baseUrl) {
    cachedClient = new GoatTownClient({ baseUrl, userId: currentUserId });
    cachedBaseUrl = baseUrl;
  }
  return cachedClient;
}

/**
 * Read the full session record.
 *
 * Deliberately not the client's `status()`: that returns the observation
 * snapshot (status, cursor, receipt), while replay and incident summaries
 * need the stored record — `seed.question` to rebuild the opening user turn,
 * `mode` to pick interactive vs read-only, `conclusion` for the summary. No
 * `authorization` here either; the header is only the acting user, which the
 * client resolves.
 */
export async function fetchInvestigationStatus(
  id: string,
  signal?: AbortSignal,
): Promise<InvestigationStatusResponse> {
  const client = goatTownClient();
  const resp = await fetch(
    `${client.baseUrl}/investigations/${encodeURIComponent(id)}/status`,
    {
      signal,
      headers: {
        accept: 'application/json',
        'x-goattown-user': await client.actingUser(),
      },
    },
  );
  if (!resp.ok) {
    throw new Error(`investigator session ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as InvestigationStatusResponse;
}

/**
 * Read an investigation's final answer from its persisted transcript.
 *
 * Folds the stored events through the same `applyLoopEvent` reducer the
 * transcript renders with, then asks the shared `conclusionFromEntries`. The
 * previous implementation scanned raw frames for a report/summary tool
 * result and returned `''` for anything else — so an investigation that
 * concluded in assistant prose reported no conclusion at all. The shared
 * helper reads tool results first and prose second, rather than one instead
 * of the other.
 */
export async function fetchInvestigationReportHeadline(
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const snapshot = await goatTownClient().events(id, 0, { signal });
  let entries: ReturnType<typeof applyLoopEvent> = [];
  for (const frame of snapshot.frames) {
    const loop = wireEventToLoopEvent(frame.ev);
    if (loop) entries = applyLoopEvent(entries, loop);
  }
  const conclusion = conclusionFromEntries(entries);
  return conclusion.headline || conclusion.text;
}

export interface SubscribeOptions {
  /** Poll cadence while work is in flight (ms). */
  intervalMs?: number;
  /** Called with each new LoopEvent in seq order. */
  onEvent: (ev: LoopEvent, seq: number) => void;
  /** Called for each user-message frame (the user's own turns) in seq
   *  order. These aren't framework LoopEvents — the caller renders them
   *  as user bubbles. */
  onUserMessage?: (content: string, seq: number) => void;
  /** Called whenever the investigation status changes. */
  onStatus?: (status: InvestigationStatus) => void;
  /** Called with each request receipt seen. Completion is a terminal
   *  receipt AND a cursor that has reached its `finalSeq`. */
  onExecution?: (execution: SessionExecution) => void;
  /** Called on a transport error (polling continues unless stopped). */
  onError?: (err: unknown) => void;
  /**
   * Called for every consumed frame, including the wire-only `userMessage`
   * frames that never reach `onEvent`.
   *
   * This is the resume position. Deriving it from `onEvent` alone skips user
   * turns, and deriving it from either callback loses the frames consumed
   * before a throw — `onCursor` stays accurate through both.
   */
  onCursor?: (seq: number) => void;
  /**
   * How observation ended.
   *
   * Only `drained` means the response was fully consumed. `stalled` is a
   * failure: a terminal receipt promised events through `finalSeq` that never
   * arrived. Without this the caller cannot tell a completed answer from a
   * transport failure — both simply stop producing events.
   */
  onOutcome?: (result: ObserveResult) => void;
  /** Follow one specific request receipt rather than the latest accepted
   *  one, so a caller can know that *its* message finished. */
  requestId?: string;
}

/**
 * Observe an investigation from `sinceSeq`, emitting each new event as a
 * rehydrated LoopEvent. Returns an unsubscribe function.
 *
 * The shared observer owns the hard parts: serialised polls, seq dedupe,
 * draining paginated final events, `Retry-After` on 429, pausing while the
 * page is hidden, and — the reason this migration exists — ending on a
 * drained request receipt rather than on a session status that reads `idle`
 * between every turn.
 *
 * The promise is deliberately not returned: callers keep the unsubscribe in
 * a ref and abort on unmount or navigation, which is the shape the previous
 * polling loop had.
 */
export function subscribeInvestigation(
  id: string,
  sinceSeq: number,
  opts: SubscribeOptions,
): () => void {
  const controller = new AbortController();
  void observeSession(goatTownClient(), id, {
    since: sinceSeq,
    intervalMs: opts.intervalMs,
    requestId: opts.requestId,
    signal: controller.signal,
    onEvent: (ev, seq) => opts.onEvent(renameConcludingTool(ev), seq),
    onUserMessage: (content, seq) => opts.onUserMessage?.(content, seq),
    onCursor: (seq) => opts.onCursor?.(seq),
    onStatus: (status) => opts.onStatus?.(status),
    onExecution: (execution) => opts.onExecution?.(execution),
    onError: (err) => opts.onError?.(err),
  }).then((result) => {
    if (!controller.signal.aborted) opts.onOutcome?.(result);
  }).catch((err) => {
    // Since 0.9.0 the observer throws rather than retrying on 401/403 and on
    // a malformed body, so this is now a real terminal path, not just a
    // programming-error backstop.
    if (!controller.signal.aborted) opts.onError?.(err);
  });

  return () => controller.abort();
}

export interface CreateInvestigationInput {
  /** The user's opening question. */
  prompt: string;
  context?: { service?: string; earliest?: string; latest?: string } | null;
  title?: string;
  /** Repos (from app Settings) the agent may check out for this run. */
  repos?: SourceRepo[];
}

/**
 * Start a UI-initiated interactive investigation. Returns the new
 * investigation id plus its `requestId` receipt — pass that to
 * `subscribeInvestigation` to follow this specific opening turn.
 */
export async function createInvestigation(
  input: CreateInvestigationInput,
  signal?: AbortSignal,
): Promise<{ id: string; title?: string; requestId?: string }> {
  const title = `APM: ${(input.title ?? input.prompt).replace(/\s+/g, ' ').trim()}`.slice(0, 80);
  const receipt = await goatTownClient().createSession({
    prompt: input.prompt,
    context: input.context,
    repos: input.repos,
    title,
    agent: APM_INVESTIGATOR_AGENT,
  }, signal);
  return { id: receipt.id, title: receipt.title, requestId: receipt.requestId };
}

/** Append a follow-up user turn and resume the loop. Returns the receipt so
 *  the caller can observe this specific message through to completion. */
export async function sendInvestigationMessage(
  id: string,
  content: string,
  signal?: AbortSignal,
): Promise<{ requestId: string }> {
  const receipt = await goatTownClient().sendMessage(id, content, signal);
  return { requestId: receipt.requestId };
}

/**
 * Append a follow-up turn carrying images.
 *
 * Validated locally against the service's advertised base64-character
 * ceilings before upload, and a 422 `image_input_unavailable` is surfaced
 * rather than quietly retried as text — a text retry produces a confident
 * answer about an image the model never received.
 */
export async function sendInvestigationImageMessage(
  id: string,
  content: string,
  images: MessageImage[],
  signal?: AbortSignal,
): Promise<{ requestId: string }> {
  const receipt = await goatTownClient().sendImageMessage(id, content, images, signal);
  return { requestId: receipt.requestId };
}

/** The session's LLM settings. `effective.vision` is the image send
 *  preflight — an agent's advertised readiness is configuration discovery,
 *  not a verified vision capability. */
export async function readInvestigationLlm(
  id: string,
  signal?: AbortSignal,
): Promise<SessionLlmSettings> {
  return goatTownClient().readSessionLlm(id, signal);
}

/** Verify the proxy credential and requested agent without creating a session. */
export async function verifyGoatTownConnection(signal?: AbortSignal): Promise<void> {
  const client = goatTownClient();
  await client.listSessions({ limit: 1 }, signal);
  const agents = await client.listAgents(signal);
  if (!agents.some((agent) => agent.slug === APM_INVESTIGATOR_AGENT)) {
    throw new Error(`GoatTown connected, but agent "${APM_INVESTIGATOR_AGENT}" is not available.`);
  }
}

/** Abort the running turn. The session stays resumable. */
export async function stopInvestigation(
  id: string,
  signal?: AbortSignal,
): Promise<{ status: InvestigationStatus }> {
  return goatTownClient().stop(id, signal);
}

/** Cancel the investigation outright (terminal). Idempotent — cancelling an
 *  already-terminal run is a no-op success. */
export async function cancelInvestigation(
  id: string,
  signal?: AbortSignal,
): Promise<{ status: InvestigationStatus }> {
  return goatTownClient().cancel(id, signal);
}

/** Close a concluded investigation. */
export async function closeInvestigation(
  id: string,
  signal?: AbortSignal,
): Promise<{ status: InvestigationStatus }> {
  return goatTownClient().close(id, signal);
}

/** Reopen a closed investigation for another turn. */
export async function reopenInvestigation(
  id: string,
  signal?: AbortSignal,
): Promise<{ status: InvestigationStatus }> {
  return goatTownClient().reopen(id, signal);
}

/** Recover an investigation whose run was interrupted. */
export async function recoverInvestigation(
  id: string,
  signal?: AbortSignal,
): Promise<{ status: InvestigationStatus }> {
  return goatTownClient().recover(id, signal);
}

/** Archive an investigation out of the recall panel. */
export async function archiveInvestigation(
  id: string,
  signal?: AbortSignal,
): Promise<{ ok?: boolean }> {
  return goatTownClient().archive(id, signal);
}

/**
 * A bounded, redacted capture of what a session actually returned.
 *
 * Feeds the Settings diagnostics disclosure so "the answer was empty but
 * GoatTown looks fine" can be settled from the raw frames. Credentials and
 * image bytes are redacted by the shared recorder before anything is shown.
 */
export function createSessionDiagnostics(limit?: number): SessionDiagnostics {
  return new SessionDiagnostics(limit);
}

export interface ListInvestigationsQuery {
  /** Substring match on title / incident key. */
  q?: string;
  /** Page size (service clamps to [1, 100], default 30). */
  limit?: number;
  /** Keyset cursor: return rows created before this epoch-ms. */
  before?: number;
}

/** Fetch the recall-panel index (newest-first) with optional search
 *  and keyset pagination. */
export async function listInvestigations(
  query: ListInvestigationsQuery = {},
  signal?: AbortSignal,
): Promise<InvestigationSummary[]> {
  const client = goatTownClient();
  const wanted = Math.max(1, Math.min(100, query.limit ?? 30));
  const matches: InvestigationSummary[] = [];
  let before = query.before;
  let scanned = 0;
  while (matches.length < wanted && scanned < 500) {
    const page = await client.listSessions({
      limit: 100,
      agent: APM_INVESTIGATOR_AGENT,
      ...(query.q ? { q: query.q } : {}),
      ...(before != null ? { before } : {}),
    }, signal);
    scanned += page.length;
    matches.push(...page.filter((row) =>
      row.title.startsWith('APM: ') || row.incidentKey.startsWith('apm:'),
    ));
    if (page.length < 100) break;
    const next = page.at(-1)?.createdAt;
    if (next == null || next === before) break;
    before = next;
  }
  return matches.slice(0, wanted);
}

/** Read several index pages for alert/incident correlation. The server caps
 * each request at 100 rows; callers that need a time window must not silently
 * treat the first global page as complete. */
export async function listRecentInvestigations(
  maxRows = 500,
  signal?: AbortSignal,
): Promise<InvestigationSummary[]> {
  const rows: InvestigationSummary[] = [];
  let before: number | undefined;
  while (rows.length < maxRows) {
    const page = await listInvestigations({
      limit: Math.min(100, maxRows - rows.length),
      before,
    }, signal);
    rows.push(...page);
    if (page.length < 100) break;
    const next = page.at(-1)?.createdAt;
    if (next == null || next === before) break;
    before = next;
  }
  return rows;
}
