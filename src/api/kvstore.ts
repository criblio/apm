/**
 * Thin client for the scoped Key-Value store the Cribl App Platform
 * exposes at CRIBL_API_URL + /kvstore/... Each app gets its own
 * namespace, so keys here don't collide with other packs.
 *
 * Per AGENTS.md:
 *   GET  CRIBL_API_URL + '/kvstore/the/path/to/key'
 *   PUT  CRIBL_API_URL + '/kvstore/the/path/to/key'  (body = value)
 *   DELETE CRIBL_API_URL + '/kvstore/the/path/to/key'
 *
 * The underlying storage is pack-scoped — we can write arbitrary string
 * or JSON values.
 *
 * A missing key returns null, but "missing" is deliberately narrow: only a
 * 404 that the KV store itself produced. An unmatched route or a rejected
 * credential also answers 404, with the web shell's HTML rather than the
 * store's JSON, and treating that as absence is actively destructive —
 * `saveAppSettings` merges onto `(await loadAppSettings()) ?? {}`, so a
 * misroute read as "nothing stored yet" replaces every persisted setting
 * with whatever partial was being saved. Confirmed against Cribl staging: a
 * genuinely absent key answers 404 `application/json`
 * `{"message":"Key not found"}`, an unmatched route answers 404 `text/html`.
 */

/** A KV read or write that never reached the store, as distinct from a key
 *  that is genuinely absent. Callers may substitute defaults for absence and
 *  must not for this. */
export class KvStoreError extends Error {
  readonly key: string;
  readonly status: number;
  readonly contentType: string | null;

  constructor(message: string, key: string, status: number, contentType: string | null) {
    super(message);
    this.name = 'KvStoreError';
    this.key = key;
    this.status = status;
    this.contentType = contentType;
  }

  /** The body was HTML, so the request fell through to the web shell instead
   *  of reaching the KV store — a routing or auth problem, never absence. */
  get isRoutingFailure(): boolean {
    return (this.contentType ?? '').includes('text/html');
  }
}

function apiUrl(): string {
  return window.CRIBL_API_URL ?? import.meta.env.VITE_CRIBL_API_URL ?? '/api/v1';
}

function kvUrl(key: string): string {
  return `${apiUrl()}/kvstore/${encodeURI(key)}`;
}

/**
 * Read a key from the pack-scoped KV store. Returns null if the key
 * doesn't exist. Throws on unexpected HTTP errors.
 *
 * Implementation notes: Cribl's KV store treats the value as opaque bytes
 * when you PUT with content-type text/plain (see kvPut below), so on
 * read we always get text back and try to JSON.parse it.
 */
export async function kvGet<T = unknown>(key: string): Promise<T | null> {
  const resp = await fetch(kvUrl(key));
  const contentType = resp.headers.get('content-type');
  if (resp.status === 404) {
    // Only the store's own "not found" counts as absence. Read the body to
    // tell them apart rather than trusting the status alone.
    const body = (await resp.text()).trim();
    if ((contentType ?? '').includes('application/json')) {
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { parsed = null; }
      const message = (parsed as { message?: unknown } | null)?.message;
      if (typeof message === 'string' && /key not found/i.test(message)) return null;
    }
    throw new KvStoreError(
      `kvGet(${key}) got a 404 that did not come from the KV store `
      + `(content-type ${contentType ?? 'none'}). Treating this as a missing key `
      + 'would let a routing or auth failure look like an empty store.',
      key,
      404,
      contentType,
    );
  }
  if (!resp.ok) {
    throw new KvStoreError(
      `kvGet(${key}) failed: ${resp.status}`,
      key,
      resp.status,
      contentType,
    );
  }
  const text = (await resp.text()).trim();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Stored value wasn't JSON — return the raw string as-is.
    return text as unknown as T;
  }
}

/**
 * Write a value to the KV store.
 *
 * We send the JSON-encoded body with content-type text/plain on purpose:
 * if you use application/json, Cribl parses the body into an object and
 * later serves it back via obj.toString() → "[object Object]", losing
 * the data. Treating the value as opaque text preserves the exact bytes
 * we wrote so kvGet can JSON.parse them back.
 */
export async function kvPut<T = unknown>(key: string, value: T): Promise<void> {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  const resp = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body,
  });
  if (!resp.ok) {
    // No body in the message: a KV value can be a credential, and a failed
    // write is diagnosable from status and content type alone.
    throw new KvStoreError(
      `kvPut(${key}) failed: ${resp.status}`,
      key,
      resp.status,
      resp.headers.get('content-type'),
    );
  }
}
