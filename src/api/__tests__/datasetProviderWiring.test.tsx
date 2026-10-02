// @vitest-environment happy-dom
/**
 * App.tsx mounts the framework `DatasetProvider` (APM's own copy is gone)
 * with `defaultDataset="otel"` and `loadDataset={loadDatasetAndApplySettings}`.
 * What APM's provider guaranteed, and this pins on the framework one:
 *
 *  - the first child render already sees `otel` (a query built before the
 *    KV read would otherwise carry `dataset=""`);
 *  - ONE read of `settings/app` sets the dataset and every saved flag;
 *  - a failed read keeps the defaults, is recorded for
 *    `useDatasetLoadError()` and is passed to `onError`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatasetProvider } from '@criblio/app-utils/dataset-provider';
import { getCurrentDataset, getDatasetLoadError } from '@criblio/app-utils/dataset';
import { KvError } from '@criblio/app-utils/kv';
import { loadDatasetAndApplySettings } from '../appSettings';
import { getMetricsRead } from '../metricsRead';
import { getStreamFilterEnabled } from '../streamFilter';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function stubKv(response: () => Response) {
  window.CRIBL_API_URL = '/api/v1';
  const fetchMock = vi.fn(async () => response());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const firstRender: string[] = [];
function Child() {
  firstRender.push(getCurrentDataset());
  return null;
}

async function mount(onError?: (e: Error) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <DatasetProvider defaultDataset="otel" loadDataset={loadDatasetAndApplySettings} onError={onError}>
        <Child />
      </DatasetProvider>,
    );
  });
}

describe('framework DatasetProvider with APM settings', () => {
  it('a failed read keeps the defaults and is recorded and reported', async () => {
    stubKv(() => new Response('<!DOCTYPE html><html></html>', { status: 404, headers: { 'content-type': 'text/html' } }));
    const onError = vi.fn();
    await mount(onError);
    expect(firstRender[0]).toBe('otel');
    expect(getCurrentDataset()).toBe('otel');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(KvError);
    expect(getDatasetLoadError()).toBeInstanceOf(KvError);
  });

  it('one read of settings/app sets the dataset and the flags, and clears the error', async () => {
    const fetchMock = stubKv(() => new Response(
      JSON.stringify({ dataset: 'main', metricsRead: false, filterLongPollTraces: false }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await mount();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/kvstore/settings/app');
    expect(getCurrentDataset()).toBe('main');
    expect(getMetricsRead()).toBe(false);
    expect(getStreamFilterEnabled()).toBe(false);
    expect(getDatasetLoadError()).toBeNull();
  });
});
