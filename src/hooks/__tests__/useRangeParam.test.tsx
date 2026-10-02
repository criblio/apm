// @vitest-environment happy-dom
/**
 * System Architecture used to clear the legacy `?lookback=` param with
 * one setSearchParams write and then call setRange, which built its
 * write from the same render's (stale) params. React Router's setter
 * does not queue like React's setState — each call navigates to a URL
 * derived from the render's params — so the second write restored
 * `lookback`. Picking the default -1h then removed `range`, and the
 * restored legacy `lookback` won again: the picker could not get back
 * to 1h from a stale bookmark.
 */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { useRangeParam } from '../useRangeParam';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Probe {
  range: string;
  search: string;
  setRange: (r: string) => void;
}

// Module-level so the harness can publish into it without mutating props.
const probe: Probe = { range: '', search: '', setRange: () => {} };

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function Harness({ legacy }: { legacy?: string[] }) {
  const [range, setRange] = useRangeParam('-1h', legacy ? { legacy } : undefined);
  const location = useLocation();
  useEffect(() => {
    probe.range = range;
    probe.search = location.search;
    probe.setRange = setRange;
  });
  return null;
}

function mount(url: string, legacy?: string[]): Probe {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MemoryRouter initialEntries={[url]}>
        <Harness legacy={legacy} />
      </MemoryRouter>,
    );
  });
  return probe;
}

function pick(p: Probe, r: string) {
  act(() => p.setRange(r));
}

describe('useRangeParam', () => {
  it('reads ?range= and falls back to the default', () => {
    expect(mount('/arch?range=-15m').range).toBe('-15m');
    act(() => root?.unmount());
    expect(mount('/arch').range).toBe('-1h');
  });

  it('omits ?range= when the default is picked and keeps unrelated params', () => {
    const p = mount('/arch?range=-15m&view=isometric');
    pick(p, '-1h');
    expect(p.search).toBe('?view=isometric');
    expect(p.range).toBe('-1h');
  });

  describe('legacy keys', () => {
    it('falls back to a legacy key when ?range= is absent', () => {
      expect(mount('/arch?lookback=-15m', ['lookback']).range).toBe('-15m');
    });

    it('?range= wins over a legacy key', () => {
      expect(mount('/arch?range=-6h&lookback=-15m', ['lookback']).range).toBe('-6h');
    });

    it('picking the default from a legacy bookmark lands on the default (lost-update regression)', () => {
      const p = mount('/arch?lookback=-15m&view=isometric', ['lookback']);
      pick(p, '-1h');
      expect(p.search).toBe('?view=isometric');
      expect(p.range).toBe('-1h');
    });

    it('picking a non-default range drops the legacy key in the same write', () => {
      const p = mount('/arch?lookback=-15m', ['lookback']);
      pick(p, '-6h');
      expect(p.search).toBe('?range=-6h');
      expect(p.range).toBe('-6h');
    });

    it('drops every listed legacy key', () => {
      const p = mount('/arch?lookback=-15m&window=-5m&keep=1', ['lookback', 'window']);
      pick(p, '-24h');
      expect(p.search).toBe('?keep=1&range=-24h');
    });
  });
});
