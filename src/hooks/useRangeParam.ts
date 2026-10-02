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
 *  - Optional `legacy` keys are read as fallbacks and removed by the
 *    same single write that sets or omits ?range=.
 */
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface RangeParamOptions {
  /**
   * Older query-param names for the same value (e.g. System
   * Architecture's `?lookback=`). Read as a fallback when `?range=` is
   * absent, and always dropped by the setter in the same write as the
   * canonical `?range=` update.
   */
  legacy?: readonly string[];
}

const NO_LEGACY: readonly string[] = [];

export function useRangeParam(
  defaultRange: string,
  options?: RangeParamOptions,
): [string, (r: string) => void] {
  const [params, setParams] = useSearchParams();
  const legacy = options?.legacy ?? NO_LEGACY;

  let range = params.get('range');
  for (const key of legacy) range ??= params.get(key);

  const setRange = useCallback(
    (r: string) => {
      // One write. React Router's setter does not queue the way React's
      // setState does — each call navigates from the render's params —
      // so a separate write to drop legacy keys would be overwritten
      // (or would overwrite this one).
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const key of legacy) next.delete(key);
          if (r === defaultRange) next.delete('range');
          else next.set('range', r);
          return next;
        },
        { replace: true },
      );
    },
    [setParams, defaultRange, legacy],
  );

  return [range ?? defaultRange, setRange];
}
