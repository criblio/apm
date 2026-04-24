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
 * or JSON values. Missing keys return 404; we normalize that to null.
 */

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
  if (resp.status === 404) return null;
  if (!resp.ok) {
    throw new Error(`kvGet(${key}) failed: ${resp.status} ${await resp.text()}`);
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
    throw new Error(`kvPut(${key}) failed: ${resp.status} ${await resp.text()}`);
  }
}
