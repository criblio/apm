/**
 * Shared types and defaults for the search form. Lives in its own module so
 * SearchForm.tsx can keep `react-refresh/only-export-components` happy.
 */

export interface SearchFormState {
  service: string;
  operation: string;
  tags: string;
  minDuration: string;
  maxDuration: string;
  limit: number;
  lookback: string;
}

export const DEFAULT_SEARCH_STATE: SearchFormState = {
  service: '',
  operation: '',
  tags: '',
  minDuration: '',
  maxDuration: '',
  limit: 20,
  lookback: '-1h',
};

export const LOOKBACK_OPTIONS: Array<{ label: string; value: string }> = [
  { label: 'Last 5 minutes', value: '-5m' },
  { label: 'Last 15 minutes', value: '-15m' },
  { label: 'Last 1 hour', value: '-1h' },
  { label: 'Last 6 hours', value: '-6h' },
  { label: 'Last 24 hours', value: '-24h' },
  { label: 'Last 7 days', value: '-7d' },
];
