/**
 * Persist the currently-selected lookback range in the URL as ?range=-15m.
 *
 * Motivation: before this hook, navigating from Home (15m) → Service
 * Detail reset the picker to the default 1h because each page owned its
 * own useState. Users would click into a service to drill down on a
 * fresh regression, then find themselves looking at a different window
 * and have to re-select 15m every time.
 *
 * Using a URL query param also makes browser back/forward work and
 * makes links shareable ("here's the problem at this range").
 *
 * Behavior:
 *  - Reads the current range from ?range=.
 *  - Falls back to `defaultRange` when the param is missing.
 *  - On set, updates the URL with { replace: true } so the history
 *    stack doesn't fill up with each picker change.
 *  - Omits the param when the value equals the default, to keep URLs
 *    clean when users haven't changed anything.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export function useRangeParam(
  defaultRange: string,
): [string, (r: string) => void] {
  const [params, setParams] = useSearchParams();
  const range = params.get('range') ?? defaultRange;

  const setRange = useCallback(
    (r: string) => {
      const next = new URLSearchParams(params);
      if (r === defaultRange) next.delete('range');
      else next.set('range', r);
      setParams(next, { replace: true });
    },
    [params, setParams, defaultRange],
  );

  return [range, setRange];
}
