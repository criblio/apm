import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SearchForm from '../components/SearchForm';
import FilterBuilder from '../components/FilterBuilder';
import FacetPanel from '../components/FacetPanel';
import SpotlightPanel from '../components/SpotlightPanel';
import KqlEditor from '../components/KqlEditor';
import {
  DEFAULT_SEARCH_STATE,
  type SearchFormState,
} from '../components/searchFormState';
import {
  newFilterRow,
  rowsToKql,
  type FilterRow,
  type FilterOp,
  FILTER_OPS,
} from '../spotlight/filterModel';
import {
  SPOTLIGHT_ATTRIBUTES,
  SPOTLIGHT_ATTRIBUTES_SERVICE_DETAIL,
  type FindTracesParams,
} from '../api/queries';
import {
  findTraces,
  getFacetDistribution,
  getSpotlightDiff,
} from '../api/search';
import TraceTable from '../components/TraceTable';
import StatusBanner from '../components/StatusBanner';
import PartialFailureBanner from '../components/PartialFailureBanner';
import ResilienceBoundary from '../components/ResilienceBoundary';
import type {
  AttrValueBucket,
  SpotlightBucket,
  TraceSummary,
} from '../api/types';
import s from './SearchPage.module.css';
import { kqlStringLiteral } from '../api/kqlSafety';

const FILTER_OP_SET = new Set<FilterOp>(FILTER_OPS);

function isFilterOp(s: string): s is FilterOp {
  return FILTER_OP_SET.has(s as FilterOp);
}

/**
 * Encode a FilterRow as `attr:op:value` with the colon delimiter
 * URL-encoded inside attr/value so it can be round-tripped. Each row
 * becomes one `f=` query parameter so the order is preserved.
 */
function encodeFilter(r: FilterRow): string {
  return [r.attr, r.op, r.value]
    .map((p) => encodeURIComponent(p))
    .join(':');
}
function decodeFilter(encoded: string): FilterRow | null {
  const parts = encoded.split(':');
  if (parts.length !== 3) return null;
  const [attr, op, value] = parts.map((p) => decodeURIComponent(p));
  if (!isFilterOp(op)) return null;
  return newFilterRow({ attr, op, value });
}

function fromQueryString(params: URLSearchParams): SearchFormState {
  return {
    service: params.get('service') ?? '',
    operation: params.get('operation') ?? '',
    filters: params
      .getAll('f')
      .map(decodeFilter)
      .filter((r): r is FilterRow => r !== null),
    kqlPredicate: params.get('kql') ?? '',
    minDuration: params.get('minDuration') ?? '',
    maxDuration: params.get('maxDuration') ?? '',
    limit: Number(params.get('limit')) || DEFAULT_SEARCH_STATE.limit,
    lookback: params.get('lookback') ?? DEFAULT_SEARCH_STATE.lookback,
  };
}

function toQueryString(state: SearchFormState): URLSearchParams {
  const out = new URLSearchParams();
  if (state.service) out.set('service', state.service);
  if (state.operation) out.set('operation', state.operation);
  for (const f of state.filters) {
    if (f.attr.trim() && f.value.trim()) out.append('f', encodeFilter(f));
  }
  if (state.kqlPredicate.trim()) out.set('kql', state.kqlPredicate);
  if (state.minDuration) out.set('minDuration', state.minDuration);
  if (state.maxDuration) out.set('maxDuration', state.maxDuration);
  if (state.limit !== DEFAULT_SEARCH_STATE.limit) {
    out.set('limit', String(state.limit));
  }
  if (state.lookback !== DEFAULT_SEARCH_STATE.lookback) {
    out.set('lookback', state.lookback);
  }
  return out;
}

/** Compose typed-filter KQL + raw-KQL into a single predicate string. */
function combinedPredicate(state: SearchFormState): string {
  const typed = rowsToKql(state.filters);
  const raw = state.kqlPredicate.trim();
  if (typed && raw) return `(${typed}) and (${raw})`;
  return typed || raw;
}

type FacetMode = 'facets' | 'spotlight';

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [formState, setFormState] = useState<SearchFormState>(() =>
    fromQueryString(searchParams),
  );
  const [results, setResults] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  // Facet/Spotlight rail state. Kept independent of the form so the
  // user can browse facets without firing a search every keystroke.
  //
  // Default to Spotlight: it's the higher-value primitive when the
  // user is actually debugging ("what's unique about my selection?"),
  // and Facets is one click away if they want the simpler distribution
  // view.
  const [facetMode, setFacetMode] = useState<FacetMode>('spotlight');
  const [facetDist, setFacetDist] = useState<Map<string, AttrValueBucket[]>>(
    new Map(),
  );
  const [spotlightDiff, setSpotlightDiff] = useState<
    Map<string, SpotlightBucket[]>
  >(new Map());
  const [facetLoading, setFacetLoading] = useState(false);
  const [facetFailures, setFacetFailures] = useState<Record<string, string>>({});
  const [facetRetry, setFacetRetry] = useState(0);

  // The facet/Spotlight rail fans out ~9 live KQL span-scans. Gate it on
  // scroll-into-view so it doesn't fire (and contend with the primary
  // trace search) until the rail is actually visible — matching the
  // SpotlightSection / metric-card lazy pattern used elsewhere.
  const railRef = useRef<HTMLElement | null>(null);
  const [railVisible, setRailVisible] = useState(false);
  useEffect(() => {
    const el = railRef.current;
    if (!el || railVisible) return;
    if (typeof IntersectionObserver === 'undefined') { setRailVisible(true); return; }
    const obs = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { setRailVisible(true); obs.disconnect(); }
    }, { rootMargin: '200px' });
    obs.observe(el);
    return () => obs.disconnect();
  }, [railVisible]);

  const runSearch = useCallback(async (state: SearchFormState) => {
    setLoading(true);
    setError(null);
    try {
      const minMs = state.minDuration.trim() ? Number(state.minDuration) : NaN;
      const maxMs = state.maxDuration.trim() ? Number(state.maxDuration) : NaN;
      const params: FindTracesParams = {
        service: state.service || undefined,
        operation: state.operation || undefined,
        predicateKql: combinedPredicate(state) || undefined,
        minDurationUs:
          Number.isFinite(minMs) && minMs >= 0 ? minMs * 1000 : undefined,
        maxDurationUs:
          Number.isFinite(maxMs) && maxMs > 0 ? maxMs * 1000 : undefined,
        limit: state.limit,
      };
      const result = await findTraces(params, state.lookback, 'now');
      setResults(result.summaries);
      setHasSearched(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-run if URL has a service param on initial mount
  useEffect(() => {
    if (formState.service && !hasSearched) {
      void runSearch(formState);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fetch facet / spotlight data whenever the rail changes mode or the
  // active filter predicate changes. Decoupled from runSearch so the
  // user can explore facets without re-running the (slower) traces
  // query.
  //
  // Gated on "is there ANY filter signal" — service, operation, a
  // FilterRow, or a raw KQL clause. Without that gate the panel fans
  // out 22 parallel queries against the entire lookback window on
  // every page load, which both wastes cluster resources and gives
  // the user a useless "everything is everything" view. The panel
  // renders an instructional placeholder while gated.
  const predicate = useMemo(() => combinedPredicate(formState), [formState]);
  const lookback = formState.lookback;
  const hasSignal =
    !!formState.service ||
    !!formState.operation ||
    predicate.length > 0;

  useEffect(() => {
    if (!hasSignal) {
      setFacetDist(new Map());
      setSpotlightDiff(new Map());
      setFacetLoading(false);
      setFacetFailures({});
      return;
    }
    // Defer the rail fan-out until (a) it's scrolled into view and (b) the
    // primary trace search isn't mid-flight — so the trace results paint
    // first and the ~9 rail jobs don't contend for worker slots on load.
    if (!railVisible || loading) return;
    let cancelled = false;
    setFacetLoading(true);
    setFacetFailures({});
    const recordFacetFailure = (attr: string, value: unknown) => {
      if (cancelled) return;
      setFacetFailures((cur) => ({
        ...cur,
        [attr]: value instanceof Error ? value.message : String(value),
      }));
    };
    // Compose the per-span scope from service/operation + predicate
    // so the facet/spotlight queries see the same span set the trace
    // search does. The facet queries insert the predicate BEFORE the
    // `extend svc=...` step, so we have to reference the underlying
    // resource attribute / span column directly here — not the `svc`
    // shorthand that findTraces uses post-extend.
    const scope: string[] = [];
    if (formState.service) {
      scope.push(
        `tostring(resource.attributes['service.name'])==${kqlStringLiteral(formState.service)}`,
      );
    }
    if (formState.operation) {
      scope.push(`name==${kqlStringLiteral(formState.operation)}`);
    }
    if (predicate) scope.push(`(${predicate})`);
    const scopedPredicate = scope.join(' and ');

    // Reset to empty so streaming additions show the panel populating
    // rather than retaining stale entries from the previous predicate.
    if (facetMode === 'facets') setFacetDist(new Map());
    else setSpotlightDiff(new Map());

    const work =
      facetMode === 'facets'
        ? getFacetDistribution(
            SPOTLIGHT_ATTRIBUTES_SERVICE_DETAIL,
            scopedPredicate,
            lookback,
            'now',
            20,
            (attr, rows) => {
              if (cancelled) return;
              // Drop loading on first non-empty result so the panel
              // becomes useful immediately; keep filling in as more
              // queries finish.
              if (rows.length > 0) setFacetLoading(false);
              setFacetDist((prev) => {
                if (rows.length === 0) return prev;
                const next = new Map(prev);
                next.set(attr, rows);
                return next;
              });
            },
            recordFacetFailure,
          )
        : getSpotlightDiff(
            SPOTLIGHT_ATTRIBUTES_SERVICE_DETAIL,
            scopedPredicate,
            lookback,
            'now',
            {
              onAttr: (attr, rows) => {
                if (cancelled) return;
                if (rows.length > 0) setFacetLoading(false);
                setSpotlightDiff((prev) => {
                  if (rows.length === 0) return prev;
                  const next = new Map(prev);
                  next.set(attr, rows);
                  return next;
                });
              },
              onError: recordFacetFailure,
            },
          );
    work
      .catch((err: unknown) => {
        recordFacetFailure('Facet analysis', err);
      })
      .finally(() => {
        if (!cancelled) setFacetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    facetMode,
    predicate,
    lookback,
    formState.service,
    formState.operation,
    hasSignal,
    railVisible,
    loading,
    facetRetry,
  ]);

  // Build a per-attribute value-suggestions function for the
  // FilterBuilder, drawn from the current facet distribution. Returns
  // undefined for attributes we have no data for; the FilterBuilder
  // omits the datalist in that case.
  const valueSuggestionsFor = useCallback(
    (attr: string): readonly string[] | undefined => {
      const rows = facetDist.get(attr);
      if (!rows || rows.length === 0) return undefined;
      return rows.map((r) => r.attrValue);
    },
    [facetDist],
  );

  function handleSubmit(next: SearchFormState) {
    setFormState(next);
    setSearchParams(toQueryString(next), { replace: false });
    void runSearch(next);
  }

  function handleFiltersChange(next: FilterRow[]) {
    setFormState((s) => ({ ...s, filters: next }));
  }

  function handleKqlChange(next: string) {
    setFormState((s) => ({ ...s, kqlPredicate: next }));
  }

  function handleApplyKql() {
    const next = { ...formState };
    setFormState(next);
    setSearchParams(toQueryString(next), { replace: false });
    void runSearch(next);
  }

  function handlePickValue(attr: string, value: string) {
    // Add the new filter row, run the search immediately so the user
    // sees the picked value applied without clicking "Find Traces".
    const next: SearchFormState = {
      ...formState,
      filters: [...formState.filters, newFilterRow({ attr, op: '=', value })],
    };
    setFormState(next);
    setSearchParams(toQueryString(next), { replace: false });
    void runSearch(next);
  }

  // Sample-filter chips shown on the empty-state rail. Each clicks
  // into a pre-built filter row so a brand-new user can see the
  // panel light up without knowing what attributes to type.
  function applySampleFilter(rows: FilterRow[]) {
    const next: SearchFormState = { ...formState, filters: rows };
    setFormState(next);
    setSearchParams(toQueryString(next), { replace: false });
  }

  return (
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <SearchForm
          state={formState}
          onSubmit={handleSubmit}
          loading={loading}
        />
        <section className={s.sidebarSection} aria-label="Filters">
          <h3 className={s.sidebarSectionTitle}>Filters</h3>
          <p className={s.sidebarSectionHint}>
            Narrow the spans your search and the side rail will
            analyze. Suggestions appear as you type.
          </p>
          <FilterBuilder
            rows={formState.filters}
            onChange={handleFiltersChange}
            attrSuggestions={SPOTLIGHT_ATTRIBUTES}
            valueSuggestionsFor={valueSuggestionsFor}
            disabled={loading}
          />
        </section>
        <section className={s.sidebarSection} aria-label="Raw KQL">
          <KqlEditor
            value={formState.kqlPredicate}
            onChange={handleKqlChange}
            onApply={handleApplyKql}
            disabled={loading}
          />
        </section>
      </aside>

      <main className={s.results}>
        {error && <StatusBanner kind="error">{error}</StatusBanner>}
        <PartialFailureBanner
          failures={facetFailures}
          onRetry={() => setFacetRetry((value) => value + 1)}
        />
        {hasSearched && !error && (
          <ResilienceBoundary title="Trace results are unavailable">
            <TraceTable traces={results} />
          </ResilienceBoundary>
        )}
        {!hasSearched && !error && (
          <StatusBanner kind="info">
            <p style={{ margin: 0 }}>
              <strong>Pick a service or add a filter</strong>, then
              click <strong>Find Traces</strong> to see matching traces
              here.
            </p>
            <p
              style={{
                margin: '6px 0 0',
                fontSize: '12px',
                opacity: 0.85,
              }}
            >
              The <strong>Spotlight</strong> rail on the right works
              independently — it explains what makes your filtered
              spans unusual without needing the trace list to load.
            </p>
          </StatusBanner>
        )}
      </main>

      <aside className={s.facetRail} ref={railRef}>
        <div className={s.facetTabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={facetMode === 'spotlight'}
            className={`${s.facetTab} ${facetMode === 'spotlight' ? s.facetTabActive : ''}`}
            onClick={() => setFacetMode('spotlight')}
          >
            Spotlight
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={facetMode === 'facets'}
            className={`${s.facetTab} ${facetMode === 'facets' ? s.facetTabActive : ''}`}
            onClick={() => setFacetMode('facets')}
          >
            Facets
          </button>
        </div>
        {!hasSignal ? (
          <div className={s.facetEmpty}>
            <h4 className={s.facetEmptyTitle}>
              Start narrowing down to see what stands out
            </h4>
            <p className={s.facetEmptyBody}>
              This rail explains what your search is made of —{' '}
              <strong>Facets</strong> lists the most common values for
              each attribute, and <strong>Spotlight</strong> highlights
              the attributes whose values are over- or under-represented
              vs the rest of the time window. Both need at least one
              filter before they can compute anything.
            </p>
            <div className={s.facetEmptyExamples}>
              <span className={s.facetEmptyExamplesLabel}>
                Try a sample filter:
              </span>
              <button
                type="button"
                className={s.facetExampleChip}
                onClick={() =>
                  applySampleFilter([
                    newFilterRow({
                      attr: 'http.response.status_code',
                      op: '>=',
                      value: '500',
                    }),
                  ])
                }
              >
                HTTP 5xx errors
              </button>
              <button
                type="button"
                className={s.facetExampleChip}
                onClick={() =>
                  applySampleFilter([
                    newFilterRow({
                      attr: 'http.request.method',
                      op: '=',
                      value: 'POST',
                    }),
                  ])
                }
              >
                POST requests
              </button>
              <button
                type="button"
                className={s.facetExampleChip}
                onClick={() =>
                  applySampleFilter([
                    newFilterRow({
                      attr: 'rpc.system',
                      op: '=',
                      value: 'grpc',
                    }),
                  ])
                }
              >
                gRPC calls
              </button>
            </div>
            <p className={s.facetEmptyHint}>
              Or pick a service in the <strong>Search</strong> sidebar.
            </p>
          </div>
        ) : facetMode === 'facets' ? (
          <FacetPanel
            distribution={facetDist}
            onPickValue={handlePickValue}
            loading={facetLoading}
            hideSingletons
          />
        ) : (
          <SpotlightPanel
            diff={spotlightDiff}
            onPickValue={handlePickValue}
            loading={facetLoading}
          />
        )}
      </aside>
    </div>
  );
}
