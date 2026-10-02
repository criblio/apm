/**
 * APM's settings live at `settings/app` (not the framework `/settings`
 * module's fixed `settings` key) and are read through the framework's
 * strict `/kv` client.
 *
 * A 404 from the KV store and a 404 from an unmatched route mean opposite
 * things, and only one of them is absence. `saveAppSettings` merges onto
 * whatever is stored, so if a misroute read as "nothing stored yet" the
 * next save would replace every persisted setting — dataset, cadence,
 * filter rules, source repos — with whatever partial was in flight. The
 * response shapes below are what Cribl staging actually returns.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KvError } from '@criblio/app-utils/kv';
import { getCurrentDataset, getDatasetLoadError, setDatasetLoadError } from '@criblio/app-utils/dataset';
import { getSearchCadence } from '@criblio/app-utils/cadence';
import {
  SETTINGS_KEY,
  applyAppSettings,
  loadAppSettings,
  saveAppSettings,
  syncAppSettings,
} from '../appSettings';
import { getStreamFilterEnabled, setStreamFilterEnabled } from '../streamFilter';
import { getLowVolumeMode, setLowVolumeMode } from '../lowVolumeMode';
import { getMetricsRead, setMetricsRead } from '../metricsRead';
import { getMetricsEmit, setMetricsEmit } from '../metricsEmit';
import { getServerInvestigations, setServerInvestigations } from '../serverInvestigations';

const KEY_MISSING = () => new Response(JSON.stringify({ message: 'Key not found' }), {
  status: 404,
  headers: { 'content-type': 'application/json' },
});
const HTML_404 = () => new Response('<!DOCTYPE html><html><head><title>Error</title></head></html>', {
  status: 404,
  headers: { 'content-type': 'text/html; charset=utf-8' },
});
const json = (v: unknown) => new Response(JSON.stringify(v), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

function stubFetch(...responses: Array<() => Response>) {
  vi.stubGlobal('window', { CRIBL_API_URL: '/api/v1' });
  const fetchMock = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('unexpected fetch');
    return next();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadAppSettings', () => {
  it('reads settings/app, not the framework settings key', async () => {
    const fetchMock = stubFetch(() => json({ dataset: 'main' }));
    await expect(loadAppSettings()).resolves.toEqual({ dataset: 'main' });
    expect(SETTINGS_KEY).toBe('settings/app');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/kvstore/settings/app');
  });

  it('treats the store\'s own not-found as absence', async () => {
    stubFetch(KEY_MISSING);
    await expect(loadAppSettings()).resolves.toBeNull();
  });

  it('throws a routing-failure KvError on an HTML 404 from the web shell', async () => {
    stubFetch(HTML_404);
    const err = await loadAppSettings().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(KvError);
    expect((err as KvError).isRoutingFailure).toBe(true);
    expect((err as KvError).key).toBe('settings/app');
  });

  it('throws on a JSON 404 whose message is not the store\'s', async () => {
    stubFetch(() => new Response(JSON.stringify({ message: 'Not Found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(loadAppSettings()).rejects.toBeInstanceOf(KvError);
  });
});

describe('saveAppSettings', () => {
  it('merges the partial over what is stored and writes it back as text/plain JSON', async () => {
    const fetchMock = stubFetch(
      () => json({ dataset: 'main', searchCadence: '10m', alertNotificationTargets: ['x'] }),
      () => new Response('', { status: 200 }),
    );
    await saveAppSettings({ lowVolumeMode: true });
    const [url, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(url).toBe('/api/v1/kvstore/settings/app');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>)['content-type']).toBe('text/plain');
    // Retired pre-v0.12 keys are dropped on the way through.
    expect(JSON.parse(init.body as string)).toEqual({
      dataset: 'main',
      searchCadence: '10m',
      lowVolumeMode: true,
    });
  });

  it('writes just the partial when nothing is stored yet', async () => {
    const fetchMock = stubFetch(KEY_MISSING, () => new Response('', { status: 200 }));
    await saveAppSettings({ dataset: 'otel' });
    const init = fetchMock.mock.calls[1][1] as unknown as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({ dataset: 'otel' });
  });

  it('aborts without writing when the read was misrouted', async () => {
    const fetchMock = stubFetch(HTML_404);
    await expect(saveAppSettings({ dataset: 'otel' })).rejects.toBeInstanceOf(KvError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws when the write is rejected', async () => {
    stubFetch(KEY_MISSING, () => new Response('nope', { status: 500, headers: { 'content-type': 'text/plain' } }));
    await expect(saveAppSettings({ dataset: 'otel' })).rejects.toBeInstanceOf(KvError);
  });
});

describe('applyAppSettings', () => {
  it('applies all seven settings', () => {
    applyAppSettings({
      dataset: '  main ',
      filterLongPollTraces: false,
      searchCadence: '10m',
      lowVolumeMode: true,
      metricsRead: false,
      metricsEmit: false,
      serverInvestigations: true,
    });
    expect(getCurrentDataset()).toBe('main');
    expect(getStreamFilterEnabled()).toBe(false);
    expect(getSearchCadence()).toBe('10m');
    expect(getLowVolumeMode()).toBe(true);
    expect(getMetricsRead()).toBe(false);
    expect(getMetricsEmit()).toBe(false);
    expect(getServerInvestigations()).toBe(true);
  });

  it('leaves each default alone when a field is missing or not the opt-in value', () => {
    setStreamFilterEnabled(true);
    setLowVolumeMode(false);
    setMetricsRead(true);
    setMetricsEmit(true);
    setServerInvestigations(false);
    applyAppSettings({ dataset: '   ', filterLongPollTraces: true, lowVolumeMode: false });
    expect(getCurrentDataset()).toBe('main'); // unchanged from the test above
    expect(getStreamFilterEnabled()).toBe(true);
    expect(getLowVolumeMode()).toBe(false);
    expect(getMetricsRead()).toBe(true);
    expect(getMetricsEmit()).toBe(true);
    expect(getServerInvestigations()).toBe(false);
    applyAppSettings(null);
    expect(getMetricsRead()).toBe(true);
  });
});

describe('syncAppSettings (DatasetProvider mount)', () => {
  it('records a load failure for useDatasetLoadError and reports it', async () => {
    stubFetch(HTML_404);
    const onError = vi.fn();
    await syncAppSettings({ onError });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(KvError);
    expect(getDatasetLoadError()).toBeInstanceOf(KvError);
  });

  it('warns when no onError is given', async () => {
    stubFetch(HTML_404);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(syncAppSettings()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('clears a recorded failure and applies settings on success', async () => {
    setDatasetLoadError(new Error('earlier'));
    stubFetch(() => json({ dataset: 'default_spans' }));
    await syncAppSettings();
    expect(getDatasetLoadError()).toBeNull();
    expect(getCurrentDataset()).toBe('default_spans');
  });

  it('does nothing once cancelled', async () => {
    setDatasetLoadError(null);
    stubFetch(HTML_404);
    const onError = vi.fn();
    await syncAppSettings({ isCancelled: () => true, onError });
    expect(onError).not.toHaveBeenCalled();
    expect(getDatasetLoadError()).toBeNull();
  });
});
