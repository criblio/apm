/**
 * Shared lookback constants and helpers. Separated from TimeRangePicker
 * so react-refresh/only-export-components stays happy — Fast Refresh only
 * works when a file exports one component.
 */

export const TIME_RANGES: Array<{ label: string; value: string; binSeconds: number }> = [
  { label: 'Last 15 minutes', value: '-15m', binSeconds: 30 },
  { label: 'Last 1 hour', value: '-1h', binSeconds: 60 },
  { label: 'Last 6 hours', value: '-6h', binSeconds: 300 },
  { label: 'Last 24 hours', value: '-24h', binSeconds: 900 },
];

/** Look up the bin width for a relative-time value; defaults to 1m. */
export function binSecondsFor(range: string): number {
  return TIME_RANGES.find((r) => r.value === range)?.binSeconds ?? 60;
}
