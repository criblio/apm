import { useCallback, useEffect, useState } from 'react';
import SpotlightPanel from './SpotlightPanel';
import { SPOTLIGHT_ATTRIBUTES } from '../api/queries';
import { getSpotlightDiff } from '../api/search';
import type { SpotlightBucket } from '../api/types';
import s from './SpotlightSection.module.css';

interface Props {
  /** KQL predicate that defines the selection. The rest of the
   *  lookback window is the baseline. */
  selectionKql: string;
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
   * broad ~22-attr set used by the Traces page rail). Pages that
   * embed this alongside other heavy data fetches (Service Detail,
   * Errors) should pass a curated 6–10 attr subset so the parallel
   * fan-out doesn't compete with the rest of the page for the
   * cluster's concurrent-job slots. */
  attributes?: readonly string[];
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
  earliest,
  latest = 'now',
  caption,
  title,
  onPickValue,
  attributes = SPOTLIGHT_ATTRIBUTES,
}: Props) {
  const [diff, setDiff] = useState<Map<string, SpotlightBucket[]>>(new Map());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDiff(new Map());
    setLoading(true);
    getSpotlightDiff(
      attributes,
      selectionKql,
      earliest,
      latest,
      20,
      (attr, rows) => {
        if (cancelled) return;
        if (rows.length > 0) setLoading(false);
        setDiff((prev) => {
          if (rows.length === 0) return prev;
          const next = new Map(prev);
          next.set(attr, rows);
          return next;
        });
      },
    )
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectionKql, earliest, latest, attributes]);

  const handlePick = useCallback(
    (attr: string, value: string) => onPickValue?.(attr, value),
    [onPickValue],
  );

  return (
    <div className={s.section}>
      {title && <h4 className={s.title}>{title}</h4>}
      <SpotlightPanel
        diff={diff}
        onPickValue={handlePick}
        loading={loading}
        caption={caption}
      />
    </div>
  );
}
