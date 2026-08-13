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
  | 'concluded'
  | 'failed'
  | 'cancelled';

export interface EventsResponse {
  protocolVersion: number;
  status: InvestigationStatus;
  latestSeq: number;
  frames: Array<{ seq: number; ev: WireLoopEvent }>;
}

export interface InvestigationStatusResponse {
  id: string;
  status: InvestigationStatus;
  alertId: string;
  incidentKey: string;
  createdAt: number;
  startedAt: number | null;
  concludedAt: number | null;
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
 * Resolve the investigator cell's base URL. Read from the injected
 * host global (set alongside the proxies.yml wiring) with an env
 * fallback for local dev. Empty string ⇒ the feature's transport is
 * not configured; callers should treat that as "no server
 * investigations reachable".
 */
export function getCellBaseUrl(): string {
  const w = window as unknown as { CRIBL_APM_CELL_URL?: string };
  return (
    w.CRIBL_APM_CELL_URL ??
    (import.meta.env?.VITE_APM_CELL_URL as string | undefined) ??
    ''
  );
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
  /** Called whenever the investigation status changes. */
  onStatus?: (status: InvestigationStatus) => void;
  /** Called on a transport error (polling continues unless stopped). */
  onError?: (err: unknown) => void;
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
        const loop = wireEventToLoopEvent(frame.ev);
        if (loop) opts.onEvent(loop, frame.seq);
        since = Math.max(since, frame.seq);
      }
      if (data.status !== lastStatus) {
        lastStatus = data.status;
        opts.onStatus?.(data.status);
      }
      if (isTerminalStatus(data.status)) {
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
