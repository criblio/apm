/**
 * A 404 from the KV store and a 404 from an unmatched route mean opposite
 * things, and only one of them is absence.
 *
 * The distinction is not cosmetic. `saveAppSettings` merges onto
 * `(await loadAppSettings()) ?? {}`, so if a misroute reads as "nothing
 * stored yet" the next save replaces every persisted setting — dataset,
 * cadence, filter rules, source repos — with whatever partial was in flight.
 * The shapes below are what Cribl staging actually returns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { kvGet, kvPut, KvStoreError } from '../kvstore';

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: string, contentType: string | null) {
  vi.stubGlobal('window', { CRIBL_API_URL: '/api/v1' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
    status,
    headers: contentType ? { 'content-type': contentType } : {},
  })));
}

describe('kvGet absence', () => {
  it('treats the store\'s own not-found as absence', async () => {
    stub(404, JSON.stringify({ message: 'Key not found' }), 'application/json');
    await expect(kvGet('settings/app')).resolves.toBeNull();
  });

  it('reads a stored JSON value back', async () => {
    stub(200, JSON.stringify({ dataset: 'otel' }), 'application/json');
    await expect(kvGet<{ dataset: string }>('settings/app'))
      .resolves.toEqual({ dataset: 'otel' });
  });

  it('returns a non-JSON value as the raw string', async () => {
    stub(200, 'gt_a1_opaque-credential', 'text/plain');
    await expect(kvGet('goattownEmbedToken')).resolves.toBe('gt_a1_opaque-credential');
  });
});

describe('kvGet routing failures are not absence', () => {
  it('throws on an HTML 404 from the web shell', async () => {
    stub(404, '<!DOCTYPE html><html><head><title>Error</title></head></html>', 'text/html');
    await expect(kvGet('settings/app')).rejects.toBeInstanceOf(KvStoreError);
  });

  it('flags an HTML 404 as a routing failure rather than a store answer', async () => {
    stub(404, '<!DOCTYPE html><html></html>', 'text/html; charset=utf-8');
    const err = await kvGet('settings/app').catch((e) => e);
    expect(err).toBeInstanceOf(KvStoreError);
    expect((err as KvStoreError).isRoutingFailure).toBe(true);
    expect((err as KvStoreError).key).toBe('settings/app');
  });

  it('throws on a 404 carrying no content type at all', async () => {
    stub(404, '', null);
    await expect(kvGet('settings/app')).rejects.toBeInstanceOf(KvStoreError);
  });

  it('throws on a JSON 404 whose message is not the store\'s', async () => {
    stub(404, JSON.stringify({ message: 'Not Found' }), 'application/json');
    await expect(kvGet('settings/app')).rejects.toBeInstanceOf(KvStoreError);
  });

  it('throws on other rejections, and keeps the body out of the message', async () => {
    stub(403, 'forbidden: token gt_a1_should-not-leak', 'text/plain');
    const err = await kvGet('goattownEmbedToken').catch((e) => e);
    expect(err).toBeInstanceOf(KvStoreError);
    expect((err as KvStoreError).status).toBe(403);
    expect((err as Error).message).not.toContain('gt_a1_should-not-leak');
  });
});

describe('kvPut', () => {
  it('resolves on a successful write', async () => {
    stub(200, '', null);
    await expect(kvPut('settings/app', { dataset: 'otel' })).resolves.toBeUndefined();
  });

  it('throws without echoing the body, which may be a credential', async () => {
    stub(500, 'rejected value gt_a1_should-not-leak', 'text/plain');
    const err = await kvPut('goattownEmbedToken', 'gt_a1_x').catch((e) => e);
    expect(err).toBeInstanceOf(KvStoreError);
    expect((err as Error).message).not.toContain('gt_a1_should-not-leak');
  });
});
