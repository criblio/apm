/**
 * The GoatTown credential is stored as raw text (the proxy injects it
 * verbatim as a header), which the framework's `kvGetJson` rejects. The
 * absence/misroute contract must match `/kv` all the same.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KvError } from '@criblio/app-utils/kv';
import { kvGetText } from '../kvText';

afterEach(() => vi.unstubAllGlobals());

function stub(status: number, body: string, contentType: string | null) {
  vi.stubGlobal('window', { CRIBL_API_URL: '/api/v1' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, {
    status,
    headers: contentType ? { 'content-type': contentType } : {},
  })));
}

describe('kvGetText', () => {
  it('returns a raw-text value as-is', async () => {
    stub(200, 'gt_a1_opaque-credential', 'text/plain');
    await expect(kvGetText('goattownEmbedToken')).resolves.toBe('gt_a1_opaque-credential');
  });

  it('unwraps a JSON-encoded string', async () => {
    stub(200, '"gt_a1_opaque-credential"', 'text/plain');
    await expect(kvGetText('goattownEmbedToken')).resolves.toBe('gt_a1_opaque-credential');
  });

  it('treats the store\'s own not-found, and an empty body, as absence', async () => {
    stub(404, JSON.stringify({ message: 'Key not found' }), 'application/json');
    await expect(kvGetText('goattownEmbedToken')).resolves.toBeNull();
    stub(200, '', null);
    await expect(kvGetText('goattownEmbedToken')).resolves.toBeNull();
  });

  it('throws a routing failure on HTML, whatever the status', async () => {
    stub(404, '<!DOCTYPE html><html></html>', 'text/html');
    const err = await kvGetText('goattownEmbedToken').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KvError);
    expect((err as KvError).isRoutingFailure).toBe(true);
    stub(200, '<!doctype html><html></html>', null);
    await expect(kvGetText('goattownEmbedToken')).rejects.toBeInstanceOf(KvError);
  });

  it('throws on a 404 that is not the store\'s, and on other rejections, without echoing the body', async () => {
    stub(404, '', null);
    await expect(kvGetText('goattownEmbedToken')).rejects.toBeInstanceOf(KvError);
    stub(403, 'forbidden: token gt_a1_should-not-leak', 'text/plain');
    const err = await kvGetText('goattownEmbedToken').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KvError);
    expect((err as KvError).status).toBe(403);
    expect((err as Error).message).not.toContain('gt_a1_should-not-leak');
  });
});
