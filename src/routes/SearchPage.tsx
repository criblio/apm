import { useEffect, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import SearchForm from '../components/SearchForm';
import { DEFAULT_SEARCH_STATE, type SearchFormState } from '../components/searchFormState';
import TraceTable from '../components/TraceTable';
import StatusBanner from '../components/StatusBanner';
import { findTraces } from '../api/search';
import type { TraceSummary } from '../api/types';
import s from './SearchPage.module.css';

function fromQueryString(params: URLSearchParams): SearchFormState {
  return {
    service: params.get('service') ?? '',
    operation: params.get('operation') ?? '',
    tags: params.get('tags') ?? '',
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
  if (state.tags) out.set('tags', state.tags);
  if (state.minDuration) out.set('minDuration', state.minDuration);
  if (state.maxDuration) out.set('maxDuration', state.maxDuration);
  if (state.limit !== DEFAULT_SEARCH_STATE.limit) out.set('limit', String(state.limit));
  if (state.lookback !== DEFAULT_SEARCH_STATE.lookback) out.set('lookback', state.lookback);
  return out;
}

export default function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [formState, setFormState] = useState<SearchFormState>(() => fromQueryString(searchParams));
  const [results, setResults] = useState<TraceSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);

  const runSearch = useCallback(async (state: SearchFormState) => {
    setLoading(true);
    setError(null);
    try {
      // Form inputs are in milliseconds (matches Jaeger UX); the KQL layer
      // expects microseconds because OTel nanosecond timestamps convert
      // cleanly to μs. Multiply here at the boundary.
      const minMs = state.minDuration.trim() ? Number(state.minDuration) : NaN;
      const maxMs = state.maxDuration.trim() ? Number(state.maxDuration) : NaN;
      const result = await findTraces(
        {
          service: state.service || undefined,
          operation: state.operation || undefined,
          tags: state.tags || undefined,
          minDurationUs: Number.isFinite(minMs) && minMs >= 0 ? minMs * 1000 : undefined,
          maxDurationUs: Number.isFinite(maxMs) && maxMs > 0 ? maxMs * 1000 : undefined,
          limit: state.limit,
        },
        state.lookback,
        'now',
      );
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

  function handleSubmit(next: SearchFormState) {
    setFormState(next);
    setSearchParams(toQueryString(next), { replace: false });
    void runSearch(next);
  }

  return (
    <div className={s.layout}>
      <aside className={s.sidebar}>
        <SearchForm state={formState} onSubmit={handleSubmit} loading={loading} />
      </aside>
      <main className={s.results}>
        {error && <StatusBanner kind="error">{error}</StatusBanner>}
        {hasSearched && !error && <TraceTable traces={results} />}
        {!hasSearched && !error && (
          <StatusBanner kind="info">
            Pick a service and click <strong>Find Traces</strong> to begin.
          </StatusBanner>
        )}
      </main>
    </div>
  );
}
