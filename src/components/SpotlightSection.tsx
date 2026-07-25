import { useCallback, useEffect, useRef, useState } from 'react';
import SpotlightPanel from './SpotlightPanel';
import PartialFailureBanner from './PartialFailureBanner';
import { SPOTLIGHT_ATTRIBUTES } from '../api/queries';
import { getSpotlightDiff } from '../api/search';
import type { SpotlightBucket } from '../api/types';
import s from './SpotlightSection.module.css';

interface Props {
  /** KQL predicate that defines the selection (the "interesting"
   *  spans — usually the failing ones). */
  selectionKql: string;
  /**
   * Optional scope predicate. When set, BOTH the selection and the
   * baseline are restricted to spans matching it. The differential
   * compares selection-within-scope vs (scope minus selection), so
   * embedded surfaces can ask "what's different about errors vs
   * healthy spans of THIS SERVICE" instead of the broader (and far
   * less useful) "vs everything else in the window."
   *
   * Without a scope, the Traces-page-style "selection vs rest of
   * window" comparison is used.
   */
  scopeKql?: string;
  earliest: string;
  latest?: string;
  /** Override the SpotlightPanel caption with one that matches the
   *  embedding context (e.g., "what's different about this error"). */
  caption?: string;
  /** Optional header text rendered above the panel for non-Traces
   *  surfaces that need to label the section themselves. */
  title?: string;
  /** Pass-through to the panel; lets embedders click a value to do
   *  something context-specific (e.g., add to filters, drill into a
   *  trace search). Defaults to a no-op. */
  onPickValue?: (attr: string, value: string) => void;
  /**
   * Attribute list to probe. Defaults to `SPOTLIGHT_ATTRIBUTES` (the
   * broad ~27-attr set used by the Traces page rail). Pages that
   * embed this alongside other heavy data fetches (Service Detail,
   * Errors) should pass a curated 6–10 attr subset so the parallel
   * fan-out doesn't compete with the rest of the page for the
   * cluster's concurrent-job slots. */
  attributes?: readonly string[];
  /**
   * One-word noun for what's in the selection. e.g. "errors" on
   * Service Detail (selection = error spans), "matching" on Traces
   * (selection = user's filter). Used in the UI copy so users see
   * "98% errors" instead of generic "98% selection".
   */
  selectionNoun?: string;
}

/**
 * SpotlightSection — embed Spotlight in any page. Owns the per-section
 * data fetch, streams in per-attribute results, and renders the panel.
 *
 * Built so Errors page, Service Detail, and any future surface can
 * drop in a Spotlight strip without reimplementing the streaming
 * fetch + state-shape plumbing the Traces page worked out.
 */
export default function SpotlightSection({
  selectionKql,
  scopeKql,
  earliest,
  latest = 'now',
  caption,
  title,
  onPickValue,
  attributes = SPOTLIGHT_ATTRIBUTES,
  selectionNoun,
}: Props) {
  const [diff, setDiff] = useState<Map<string, SpotlightBucket[]>>(new Map());
  const [loading, setLoading] = useState(false);
  const [failures, setFailures] = useState<Record<string, string>>({});
  const [retryNonce, setRetryNonce] = useState(0);

  // LAZY: Spotlight fires ~18 live KQL span-scans. Firing them eagerly on
  // every Service Detail load saturated the worker pool (measured: 45 jobs
  // / 12s to settle). Only fetch once the section has scrolled into view.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el || visible) return;
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setVisible(true); obs.disconnect(); }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    // OWN cancellation scope — NOT the global nav generation. As a child
    // component, Spotlight's effect runs before the parent page's fetch;
    // using the generation signal would let the parent's
    // `newQueryGeneration()` abort these queries the instant it fetched
    // (that was the "Spotlight completely broken" bug). This controller
    // aborts only when Spotlight itself re-runs or unmounts (nav-away).
    const controller = new AbortController();
    let cancelled = false;
    setDiff(new Map());
    setLoading(true);
    setFailures({});
    getSpotlightDiff(attributes, selectionKql, earliest, latest, {
      scopeKql,
      signal: controller.signal,
      onAttr: (attr, rows) => {
        if (cancelled) return;
        if (rows.length > 0) setLoading(false);
        setDiff((prev) => {
          if (rows.length === 0) return prev;
          const next = new Map(prev);
          next.set(attr, rows);
          return next;
        });
      },
      onError: (attr, error) => {
        if (cancelled) return;
        setFailures((cur) => ({
          ...cur,
          [attr]: error instanceof Error ? error.message : String(error),
        }));
      },
    })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [visible, selectionKql, scopeKql, earliest, latest, attributes, retryNonce]);

  const handlePick = useCallback(
    (attr: string, value: string) => onPickValue?.(attr, value),
    [onPickValue],
  );

  return (
    <div className={s.section} ref={containerRef}>
      {title && <h4 className={s.title}>{title}</h4>}
      <PartialFailureBanner
        failures={failures}
        onRetry={() => setRetryNonce((value) => value + 1)}
      />
      <SpotlightPanel
        diff={diff}
        onPickValue={handlePick}
        loading={loading}
        caption={caption}
        selectionNoun={selectionNoun}
      />
    </div>
  );
}
