/**
 * UI transport for server-side investigations.
 *
 * Spike S1 established that the sandboxed iframe's CSP
 * (`connect-src 'self' …`) blocks raw WebSockets, so the transport
 * is short-poll over the platform fetch proxy: proxied fetches are
 * rewritten same-origin and are therefore CSP-clean. The cell's WS
 * surface exists for non-iframe clients but the app never uses it.
 *
 * The cell speaks a wire form of the framework's LoopEvent union
 * (error flattened to a message string so it survives JSON). This
 * module rehydrates each wire event back into a real LoopEvent and
 * hands it to the caller, which feeds it through the exact
 * `applyLoopEvent` reducer the client Investigator uses — so a
 * replayed transcript renders identically to a live one.
 *
 * The GoatTown base URL is resolved from `getCellBaseUrl()`; the
 * matching `config/proxies.yml` domain + `kv.sharedCellToken` header
 * injection land with the UI wiring PR once the cell host is known.
 */
import type { LoopEvent } from '@criblio/app-utils/agent-loop';
import type { ToolResultUi } from '@criblio/app-utils/agent-tools';
import { isTerminalStatus } from '@criblio/agent-protocol';
import type {
  EventsResponse,
  SessionMode,
  SessionStatus,
  SessionStatusResponse,
  SessionSummaryRow,
  SourceRepo,
  WireLoopEvent,
} from '@criblio/agent-protocol';
import { APM_INVESTIGATOR_AGENT } from './goatTownProvisioning';

// The wire shapes now come from @criblio/agent-protocol — the same
// module the cell imports, so the two sides can no longer drift (this
// file used to carry a hand-maintained mirror). Re-exported under the
// established investigation-flavored names the rest of the UI uses.
export { isTerminalStatus };
export type { EventsResponse, SourceRepo, WireLoopEvent };
export type InvestigationStatus = SessionStatus;
export type InvestigationMode = SessionMode;
/** One row of the recall panel. */
export type InvestigationSummary = SessionSummaryRow;
export type InvestigationStatusResponse = SessionStatusResponse;

/**
 * Rehydrate one wire event into a framework LoopEvent. Pure — the
 * only non-trivial case is `error`, which regains an Error instance
 * (applyLoopEvent + the error card read `ev.error.message`). Unknown
 * kinds return null so a forward-compatible cell can add event kinds
 * without breaking an older UI.
 */
export function wireEventToLoopEvent(ev: WireLoopEvent): LoopEvent | null {
  switch (ev.kind) {
    case 'assistantText':
      return { kind: 'assistantText', turnId: ev.turnId, chunk: ev.chunk };
    case 'assistantDone':
      return { kind: 'assistantDone', turnId: ev.turnId };
    case 'toolCall':
      return {
        kind: 'toolCall',
        turnId: ev.turnId,
        call: {
          id: ev.call.id,
          function: {
            ...ev.call.function,
            name: ev.call.function.name === 'report_findings'
              ? 'present_investigation_summary'
              : ev.call.function.name,
          },
        },
        needsApproval: ev.needsApproval,
      };
    case 'toolResult':
      // The wire form carries ui as `unknown` (it's just passed
      // through); the framework LoopEvent types it as ToolResultUi.
      // The cell produced it from the real executors, so the shape is
      // already correct — narrow it here.
      //
      // This used to also rewrite GoatTown's `kind: 'report'` into the
      // summary shape, because the framework transcript had no report
      // card and fell back to JSON.stringify. app-utils 0.8.6 renders
      // `report` natively (through the same `reportToSummary` mapping
      // that was lifted from this module), so the wire kind now reaches
      // the transcript unchanged and renders identically.
      return {
        kind: 'toolResult',
        turnId: ev.turnId,
        result: { ...ev.result, ui: ev.result.ui as ToolResultUi | undefined },
      };
    case 'notification':
      return { kind: 'notification', turnId: ev.turnId, content: ev.content };
    case 'error':
      return { kind: 'error', error: new Error(ev.message) };
    case 'done':
      return {
        kind: 'done',
        reason: ev.reason === 'aborted' ? 'aborted' : 'complete',
      };
    default:
      return null;
  }
}

/**
 * Shared GoatTown's public host. MUST match the domain declared in
 * `config/proxies.yml` — the platform proxy only forwards fetches to
 * declared domains and injects the installation token there.
 */
export const SHARED_GOATTOWN_BASE_URL = 'https://goattown-shared.lab.cribl.io';
export const GOATTOWN_OWNER = 'cribl-apm';

let cellBaseUrlOverride: string | null = null;

/** Test/development override. Production uses the package-pinned shared host. */
export function setCellBaseUrl(url: string | null | undefined): void {
  cellBaseUrlOverride = url && url.trim() ? url.trim().replace(/\/$/, '') : null;
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

function goatTownHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init);
  // Shared GoatTown requires an owner claim on UI routes. APM intentionally
  // uses one installation-wide owner so responders share incident sessions.
  headers.set('x-goattown-user', GOATTOWN_OWNER);
  return headers;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  // No Authorization header on purpose: in the iframe the platform
  // fetch proxy injects the cell bearer via proxies.yml
  // `headers.inject`. Setting it here would be stripped anyway (the
  // proxy always strips `authorization` from the original request).
  const resp = await fetch(url, {
    signal,
    headers: goatTownHeaders({ accept: 'application/json' }),
  });
  if (!resp.ok) {
    throw new Error(`investigator cell ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

export async function fetchInvestigationStatus(
  id: string,
  signal?: AbortSignal,
): Promise<InvestigationStatusResponse> {
  const base = getCellBaseUrl();
  await claimUnownedInvestigations(base, signal);
  return getJson<InvestigationStatusResponse>(
    `${base}/investigations/${encodeURIComponent(id)}/status`,
    signal,
  );
}

/** Read the latest report_findings headline from a persisted transcript.
 * Interactive GoatTown sessions remain idle and intentionally keep the status
 * response's conclusion null, so incident summaries must read the report card. */
export async function fetchInvestigationReportHeadline(
  id: string,
  signal?: AbortSignal,
): Promise<string> {
  const base = getCellBaseUrl();
  await claimUnownedInvestigations(base, signal);
  const data = await getJson<EventsResponse>(
    `${base}/investigations/${encodeURIComponent(id)}/events?since=0`,
    signal,
  );
  for (let i = data.frames.length - 1; i >= 0; i -= 1) {
    const ev = data.frames[i].ev;
    if (ev.kind !== 'toolResult' || !ev.result.ui || typeof ev.result.ui !== 'object') continue;
    const ui = ev.result.ui as { kind?: unknown; headline?: unknown; conclusion?: unknown };
    if (ui.kind === 'report' && typeof ui.headline === 'string') return ui.headline;
    if (ui.kind === 'summary' && typeof ui.conclusion === 'string') return ui.conclusion;
  }
  return '';
}

async function claimUnownedInvestigations(base: string, signal?: AbortSignal): Promise<void> {
  await postJson<{ ok: boolean }>(`${base}/admin/claim-sessions`, {}, signal);
}

export interface SubscribeOptions {
  /** Poll cadence while running (ms). */
  intervalMs?: number;
  /** Called with each new LoopEvent in seq order. */
  onEvent: (ev: LoopEvent, seq: number) => void;
  /** Called for each user-message frame (the user's own turns) in seq
   *  order. These aren't framework LoopEvents — the caller renders them
   *  as user bubbles. */
  onUserMessage?: (content: string, seq: number) => void;
  /** Called whenever the investigation status changes. */
  onStatus?: (status: InvestigationStatus) => void;
  /** Called on a transport error (polling continues unless stopped). */
  onError?: (err: unknown) => void;
  /** Also stop polling when the investigation parks at `idle`. Used by
   *  the interactive session (a follow-up message re-subscribes) so an
   *  idle conversation isn't polled forever. */
  stopOnIdle?: boolean;
}

/**
 * Poll an investigation's events from `sinceSeq`, emitting each new
 * event as a rehydrated LoopEvent. Returns an unsubscribe function.
 * Polling stops on its own when the investigation reaches a terminal
 * status; the returned function cancels an in-flight poll and stops
 * the loop early (e.g. on unmount or navigation).
 */
export function subscribeInvestigation(
  id: string,
  sinceSeq: number,
  opts: SubscribeOptions,
): () => void {
  const interval = opts.intervalMs ?? 2500;
  let since = sinceSeq;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const controller = new AbortController();
  let lastStatus: InvestigationStatus | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const base = getCellBaseUrl();
      const data = await getJson<EventsResponse>(
        `${base}/investigations/${encodeURIComponent(id)}/events?since=${since}`,
        controller.signal,
      );
      if (stopped) return;
      for (const frame of data.frames) {
        if (frame.ev.kind === 'userMessage') {
          opts.onUserMessage?.(frame.ev.content, frame.seq);
        } else {
          const loop = wireEventToLoopEvent(frame.ev);
          if (loop) opts.onEvent(loop, frame.seq);
        }
        since = Math.max(since, frame.seq);
      }
      if (data.status !== lastStatus) {
        lastStatus = data.status;
        opts.onStatus?.(data.status);
      }
      if (
        isTerminalStatus(data.status) ||
        (opts.stopOnIdle && data.status === 'idle')
      ) {
        stopped = true;
        return;
      }
    } catch (err) {
      if (stopped || controller.signal.aborted) return;
      opts.onError?.(err);
    }
    if (!stopped) timer = setTimeout(() => void tick(), interval);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    controller.abort();
  };
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  // As with getJson: no Authorization header — the platform proxy
  // injects the cell bearer, and strips any we set.
  const resp = await fetch(url, {
    method: 'POST',
    signal,
    headers: goatTownHeaders({ accept: 'application/json', 'content-type': 'application/json' }),
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    throw new Error(`investigator cell ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as T;
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
 * Start a UI-initiated interactive investigation on the cell. Returns
 * the new investigation id; the caller opens it in the interactive
 * view and streams via subscribeInvestigation.
 */
export async function createInvestigation(
  input: CreateInvestigationInput,
  signal?: AbortSignal,
): Promise<{ id: string; title?: string }> {
  const base = getCellBaseUrl();
  const title = `APM: ${(input.title ?? input.prompt).replace(/\s+/g, ' ').trim()}`.slice(0, 80);
  return postJson<{ id: string; title?: string }>(
    `${base}/investigations`,
    {
      ...input,
      title,
      agent: APM_INVESTIGATOR_AGENT,
    },
    signal,
  );
}

/** Append a follow-up user turn to an interactive investigation and
 *  resume its loop. */
export async function sendInvestigationMessage(
  id: string,
  content: string,
  signal?: AbortSignal,
): Promise<void> {
  const base = getCellBaseUrl();
  await postJson<{ ok: boolean }>(
    `${base}/investigations/${encodeURIComponent(id)}/messages`,
    { content },
    signal,
  );
}

/**
 * Push the provisioned default source repos to the cell. Autonomous
 * (alert-fired) investigations read this list — the alert webhook
 * carries no repos and the cell can't read the app-settings KV, so this
 * is how the Settings repos reach an alert-fired run. Interactive
 * investigations still thread their repos at create time; this only
 * feeds the autonomous path. Called on Settings Save and by
 * `scripts/provision.ts` (UI == CLI).
 */
export async function pushCellRepos(
  repos: SourceRepo[],
  signal?: AbortSignal,
): Promise<{ count: number }> {
  const base = getCellBaseUrl();
  return postJson<{ count: number }>(`${base}/config/repos`, { repos }, signal);
}

/** Read the provisioned default repos currently stored on the cell. */
export async function getCellRepos(signal?: AbortSignal): Promise<SourceRepo[]> {
  const base = getCellBaseUrl();
  const data = await getJson<{ repos: SourceRepo[] }>(`${base}/config/repos`, signal);
  return data.repos ?? [];
}

/** Stop an in-progress investigation. The cell aborts the running turn
 *  (LLM stream + any tool/checkout) and marks it `cancelled`. Idempotent
 *  — cancelling an already-terminal run is a no-op success. */
export async function cancelInvestigation(
  id: string,
  signal?: AbortSignal,
): Promise<{ status: InvestigationStatus }> {
  const base = getCellBaseUrl();
  return postJson<{ status: InvestigationStatus }>(
    `${base}/investigations/${encodeURIComponent(id)}/cancel`,
    {},
    signal,
  );
}

export interface ListInvestigationsQuery {
  /** Substring match on title / incident key. */
  q?: string;
  /** Page size (cell clamps to [1, 100], default 30). */
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
  const base = getCellBaseUrl();
  // Alert-triggered sessions have no browser owner. Adopt them into APM's
  // installation-wide owner before listing so every responder can see them.
  await claimUnownedInvestigations(base, signal);
  const wanted = Math.max(1, Math.min(100, query.limit ?? 30));
  const matches: InvestigationSummary[] = [];
  let before = query.before;
  let scanned = 0;
  while (matches.length < wanted && scanned < 500) {
    const params = new URLSearchParams({
      limit: '100',
      agent: APM_INVESTIGATOR_AGENT,
    });
    if (query.q) params.set('q', query.q);
    if (before != null) params.set('before', String(before));
    const data = await getJson<{ investigations: InvestigationSummary[] }>(
      `${base}/investigations?${params.toString()}`,
      signal,
    );
    const page = data.investigations ?? [];
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
