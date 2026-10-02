/**
 * Read a raw-text KV value — the one read the framework's `/kv` does not
 * offer.
 *
 * `kv.goattownEmbedToken` (APM's GoatTown connected-app credential) is
 * stored as raw text, not JSON: the platform proxy injects it verbatim as
 * a header value (`config/proxies.yml`), GoatTown's console delivers it
 * that way, and Settings writes it with `kvPutText`. `kvGetJson` rejects
 * such a body as "not JSON", and `/kv` is write-only for text by design.
 * APM must still read it back once, to inline it in the alert webhook
 * target (Cribl's target schema cannot reference a secret).
 *
 * Same contract as `kvGetJson`: only the store's own
 * `{"message":"Key not found"}` 404 — or an empty body — is absence
 * (null); an HTML body, any other non-OK status, or a network failure
 * throws the framework's `KvError`. The value never appears in a message.
 */
import { KvError } from '@criblio/app-utils/kv';
import { apiUrl } from '@criblio/app-utils/search';

function isHtml(text: string, contentType: string | null): boolean {
  if (contentType?.includes('html')) return true;
  const head = text.trimStart().slice(0, 64).toLowerCase();
  return head.startsWith('<!doctype html') || head.startsWith('<html');
}

function isKeyMissing(status: number, text: string, contentType: string | null): boolean {
  if (status !== 404 || !contentType?.includes('json')) return false;
  try {
    const message = (JSON.parse(text) as { message?: unknown } | null)?.message;
    return typeof message === 'string' && /^key not found$/i.test(message.trim());
  } catch {
    return false;
  }
}

export async function kvGetText(key: string, signal?: AbortSignal): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(`${apiUrl()}/kvstore/${key}`, { signal });
  } catch (error) {
    throw new KvError(
      `KV read of ${key} failed before reaching the store: ${error instanceof Error ? error.message : String(error)}`,
      { key },
    );
  }
  const contentType = response.headers.get('content-type');
  const text = await response.text().catch(() => '');
  if (isHtml(text, contentType)) {
    throw new KvError(
      `KV read of ${key} returned HTML (${response.status}), so it never reached the KV store.`,
      { key, status: response.status, contentType, bodyKind: 'html' },
    );
  }
  if (!response.ok) {
    if (isKeyMissing(response.status, text, contentType)) return null;
    throw new KvError(`KV read of ${key} failed with ${response.status}`, {
      key,
      status: response.status,
      contentType,
    });
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A value someone stored JSON-encoded ("\"gt_a1_…\"") reads back as the
  // string inside, as the old APM client did.
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === 'string') return parsed;
  } catch {
    /* raw text — the normal case */
  }
  return trimmed;
}
