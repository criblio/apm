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
 * The cell base URL is resolved from `getCellBaseUrl()`; the
 * matching `config/proxies.yml` domain + `kv.cellToken` header
 * injection land with the UI wiring PR once the cell host is known.
 */
import type { LoopEvent } from '@cribl/app-utils/agent-loop';
import type { ToolResultUi } from '@cribl/app-utils/agent-tools';

/** Wire form of a single LoopEvent (error carries a message, not an
 *  Error instance). Mirrors cell/src/protocol.ts WireLoopEvent. */
export type WireLoopEvent =
  // A user's turn — rendered as a user bubble, not a framework LoopEvent.
  | { kind: 'userMessage'; turnId: string; content: string }
  | { kind: 'assistantText'; turnId: string; chunk: string }
  | { kind: 'assistantDone'; turnId: string }
  | {
      kind: 'toolCall';
      turnId: string;
      call: { id: string; type?: string; function: { name: string; arguments: string } };
      needsApproval: boolean;
    }
  | {
      kind: 'toolResult';
      turnId: string;
      result: { id: string; name: string; content: string; ui?: unknown };
    }
  | { kind: 'notification'; turnId: string; content: unknown }
  | { kind: 'error'; message: string }
  | { kind: 'done'; reason: string };

export type InvestigationStatus =
  | 'queued'
  | 'running'
  // Interactive investigations only: answered the current user turn,
  // awaiting the next message. Non-terminal.
  | 'idle'
  | 'concluded'
  | 'failed'
  | 'cancelled';

export type InvestigationMode = 'autonomous' | 'interactive';

/** One row of the recall panel — mirrors the cell's
 *  InvestigationSummaryRow. */
export interface InvestigationSummary {
  id: string;
  alertId: string;
  incidentKey: string;
  status: InvestigationStatus;
  title: string;
  mode: InvestigationMode;
  createdAt: number;
  startedAt: number | null;
  concludedAt: number | null;
}

export interface EventsResponse {
  protocolVersion: number;
  status: InvestigationStatus;
  latestSeq: number;
  frames: Array<{ seq: number; ev: WireLoopEvent }>;
}

export interface InvestigationStatusResponse {
  id: string;
  status: InvestigationStatus;
  mode?: InvestigationMode;
  title?: string | null;
  alertId: string;
  incidentKey: string;
  createdAt: number;
  startedAt: number | null;
  concludedAt: number | null;
  /** The small InvestigationSeed (carries the opening `question`). */
  seed?: { question?: string } | null;
  conclusion: unknown | null;
  latestSeq: number;
}

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
        call: { id: ev.call.id, function: ev.call.function },
        needsApproval: ev.needsApproval,
      };
    case 'toolResult':
      // The wire form carries ui as `unknown` (it's just passed
      // through); the framework LoopEvent types it as ToolResultUi.
      // The cell produced it from the real executors, so the shape is
      // already correct — narrow it here.
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

/** Terminal states stop polling. */
export function isTerminalStatus(status: InvestigationStatus): boolean {
  return status === 'concluded' || status === 'failed' || status === 'cancelled';
}

/**
 * The cell's public host. MUST match the domain declared in
 * `config/proxies.yml` — the platform proxy only forwards fetches to
 * declared domains, and injects the `cellToken` bearer there. If the
 * cell is redeployed under a new host, update this default (or the
 * `cellUrl` app setting) and proxies.yml together.
 */
const DEFAULT_CELL_BASE_URL = 'https://54-71-34-177.sslip.io';

let cellBaseUrlOverride: string | null = null;

/** Set the cell base URL from the `cellUrl` app setting (hydrated at
 *  boot). Null/empty clears the override, restoring the default. */
export function setCellBaseUrl(url: string | null | undefined): void {
  cellBaseUrlOverride = url && url.trim() ? url.trim().replace(/\/$/, '') : null;
}

/**
 * Resolve the investigator cell's base URL: the `cellUrl` app setting
 * if set, else a host global / build env, else the pinned default
 * that matches proxies.yml.
 */
export function getCellBaseUrl(): string {
  if (cellBaseUrlOverride) return cellBaseUrlOverride;
  const w = window as unknown as { CRIBL_APM_CELL_URL?: string };
  return (
    w.CRIBL_APM_CELL_URL ??
    (import.meta.env?.VITE_APM_CELL_URL as string | undefined) ??
    DEFAULT_CELL_BASE_URL
  ).replace(/\/$/, '');
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  // No Authorization header on purpose: in the iframe the platform
  // fetch proxy injects the cell bearer via proxies.yml
  // `headers.inject`. Setting it here would be stripped anyway (the
  // proxy always strips `authorization` from the original request).
  const resp = await fetch(url, { signal, headers: { accept: 'application/json' } });
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
  return getJson<InvestigationStatusResponse>(
    `${base}/investigations/${encodeURIComponent(id)}/status`,
    signal,
  );
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
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!resp.ok) {
    throw new Error(`investigator cell ${resp.status}: ${await resp.text()}`);
  }
  return (await resp.json()) as T;
}

/** A source repo the agent may check out. `service` maps it to a
 *  telemetry service; `*`/omitted = monorepo catch-all. Mirrors the
 *  cell's protocol SourceRepo. */
export interface SourceRepo {
  url: string;
  name?: string;
  service?: string;
  ref?: string;
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
  return postJson<{ id: string; title?: string }>(
    `${base}/investigations`,
    input,
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
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.limit != null) params.set('limit', String(query.limit));
  if (query.before != null) params.set('before', String(query.before));
  const qs = params.toString();
  const data = await getJson<{ investigations: InvestigationSummary[] }>(
    `${base}/investigations${qs ? `?${qs}` : ''}`,
    signal,
  );
  return data.investigations ?? [];
}
