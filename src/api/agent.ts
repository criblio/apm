/**
 * Streaming client for the Cribl Copilot Investigation agent.
 *
 * Endpoint: POST /api/v1/ai/q/agents/local_search
 * Response: NDJSON stream, one JSON object per line. Each line is one of:
 *
 *   1. Text token:
 *        {"name":"agent:local_search","role":"assistant","content":"word"}
 *
 *   2. Tool call (may batch multiple calls in one frame):
 *        {"name":"agent:local_search","role":"assistant","content":null,
 *         "tool_calls":[{"id":"call_xxx","function":{"name":"...","arguments":"{...}"}}]}
 *
 *   3. Inline tool result (server-side tools like fetch_local_context):
 *        {"role":"tool","content":"..."}
 *
 *   4. UI notification (loading spinner, status):
 *        {"notificationMessageType":"loadingMessage","toolName":"...","content":[...]}
 *
 * The agent loop (see agentLoop.ts) consumes this stream, executes any
 * client-side tool calls, then sends the full updated message history
 * back in a fresh POST to continue the conversation.
 */

export interface AgentMessage {
  id?: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  reqId?: number;
  tool_calls?: AgentToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface AgentToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentContext {
  resources?: {
    availableDatasets?: Array<{ id: string; description?: string }>;
  };
  files?: Record<string, unknown>;
}

export interface AgentRequest {
  messages: AgentMessage[];
  stream: boolean;
  sessionId: string;
  context: AgentContext;
  tools?: AgentToolDefinition[];
}

export interface AgentToolDefinition {
  id: string;
  description: string;
  schema?: Record<string, unknown>;
}

/** A parsed frame from the streaming NDJSON response. */
export type AgentFrame =
  | { kind: 'text'; content: string }
  | { kind: 'toolCalls'; calls: AgentToolCall[] }
  | { kind: 'toolResult'; content: string }
  | { kind: 'notification'; toolName?: string; content: unknown }
  | { kind: 'unknown'; raw: unknown };

/** Raised when the agent endpoint returns a 5xx with a
 *  "Bearer Token has expired" reason. This is a Cribl platform-side
 *  problem with the AI bearer token cache (separate from the user's
 *  Cribl session cookie — other API calls keep working); no
 *  client-side action recovers it. Catch this at the UI layer and
 *  show a banner explaining the situation rather than treating it
 *  like a transient retry-able error. */
export class SessionExpiredError extends Error {
  readonly isSessionExpired = true as const;
  constructor(
    message = 'Cribl AI bearer token cache is in a broken state. Reloading the page will not help — the only known recoveries are a full Cribl logout/re-login or contacting Cribl support.',
  ) {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export function isSessionExpiredError(err: unknown): err is SessionExpiredError {
  return (
    err instanceof Error &&
    (err as { isSessionExpired?: boolean }).isSessionExpired === true
  );
}

/** Does a server error body look like an expired-token rejection?
 *  The agent endpoint returns `{"reason":"Bearer Token has expired"}`
 *  under a 5xx; future Cribl versions may use slightly different
 *  wording so we match permissively. */
function looksLikeSessionExpired(body: string): boolean {
  if (!body) return false;
  const lower = body.toLowerCase();
  return (
    lower.includes('bearer token has expired') ||
    lower.includes('token has expired') ||
    lower.includes('token expired')
  );
}

function apiUrl(): string {
  return window.CRIBL_API_URL ?? import.meta.env.VITE_CRIBL_API_URL ?? '/api/v1';
}

function agentUrl(): string {
  return `${apiUrl()}/ai/q/agents/local_search`;
}

/**
 * Parse one NDJSON line into an AgentFrame. Unknown shapes are
 * preserved for debugging rather than dropped on the floor.
 */
export function parseAgentFrame(line: string): AgentFrame | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Notification frames (loading spinners, status messages)
  if ('notificationMessageType' in obj) {
    return {
      kind: 'notification',
      toolName: typeof obj.toolName === 'string' ? obj.toolName : undefined,
      content: obj.content,
    };
  }

  // Server-side tool result frames (e.g. fetch_local_context)
  if (obj.role === 'tool') {
    return {
      kind: 'toolResult',
      content: typeof obj.content === 'string' ? obj.content : JSON.stringify(obj.content ?? ''),
    };
  }

  // Assistant frames — either text chunks or tool call batches
  if (obj.role === 'assistant') {
    const toolCalls = obj.tool_calls;
    if (Array.isArray(toolCalls) && toolCalls.length > 0) {
      return { kind: 'toolCalls', calls: toolCalls as AgentToolCall[] };
    }
    if (typeof obj.content === 'string') {
      return { kind: 'text', content: obj.content };
    }
  }

  return { kind: 'unknown', raw: obj };
}

/**
 * POST a request to the agent endpoint and yield parsed frames as
 * they arrive. The stream ends when the server closes the connection.
 *
 * AbortSignal support lets callers cancel in-flight investigations
 * (e.g. when the user navigates away or clicks a Stop button).
 *
 * Expired-token detection: if the response body contains
 * "Bearer Token has expired" (any case), throw a typed
 * `SessionExpiredError` so the UI can show a clear "Cribl AI token
 * cache is in a broken state" message instead of a raw 500. We
 * don't retry, warm up, or attempt automatic recovery — the failure
 * is server-side (the per-user AI bearer token cache is in a state
 * no client-side action can refresh; verified by reproducing the
 * exact same 500 in Cribl Search's own native `/search/agent`
 * Copilot UI on the same workspace, where the native UI's "Try
 * Again" button is a re-POST with no recovery either). The fix
 * lives on the platform side; the only known mitigations from a
 * client are a full Cribl logout/re-login or waiting for the
 * server-side cache to TTL out.
 */
export async function* streamAgent(
  req: AgentRequest,
  signal?: AbortSignal,
): AsyncGenerator<AgentFrame, void, void> {
  const resp = await fetch(agentUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    if (looksLikeSessionExpired(body)) {
      throw new SessionExpiredError();
    }
    throw new Error(`Agent request failed (${resp.status}): ${body}`);
  }
  if (!resp.body) {
    throw new Error('Agent response has no body');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  // Line buffer — NDJSON frames are newline-delimited, but a single
  // chunk from the reader can contain a partial line.
  let buf = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, newlineIdx);
        buf = buf.slice(newlineIdx + 1);
        const frame = parseAgentFrame(line);
        if (frame) yield frame;
      }
    }
    // Flush any trailing partial line (rare but possible)
    if (buf.trim()) {
      const frame = parseAgentFrame(buf);
      if (frame) yield frame;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Fire the lightweight analytics event the native UI sends alongside
 * each user query submission. The server appears to require it — the
 * conversation still runs without it, but we match the native UI
 * behavior to avoid divergence.
 */
export async function logAgentEvent(
  eventType: string,
  eventClass: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  try {
    await fetch(`${apiUrl()}/ai/event`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientTimestamp: Date.now(),
        eventType,
        eventClass,
        surface: 'criblApmInvestigation',
        ...payload,
      }),
    });
  } catch {
    /* analytics are best-effort */
  }
}
