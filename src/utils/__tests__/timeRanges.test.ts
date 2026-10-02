/**
 * APM's range math now comes from `@criblio/app-utils/time`. These pin
 * the behaviour APM depends on, including the deliberate differences
 * from the deleted local helpers (src/components/timeRanges.ts,
 * src/utils/timeRange.ts).
 */
import { describe, expect, it } from 'vitest';
import { TIME_RANGES, binSecondsFor, previousWindow, relativeTimeMs } from '@criblio/app-utils/time';

describe('APM time ranges (framework /time)', () => {
  it('the picker catalog and its bin widths are unchanged', () => {
    expect(TIME_RANGES.map((r) => [r.value, r.binSeconds])).toEqual([
      ['-15m', 30], ['-1h', 60], ['-6h', 300], ['-24h', 900],
    ]);
    for (const r of TIME_RANGES) expect(binSecondsFor(r.value)).toBe(r.binSeconds);
  });

  it('off-catalog ranges get a computed bin width (was a flat 60s)', () => {
    // Only reachable via a hand-edited ?range=. -7d at 60s was 10 080 points.
    expect(binSecondsFor('-7d')).toBe(10_800);
    expect(binSecondsFor('-2h')).toBe(300);
    expect(binSecondsFor('garbage')).toBe(60);
  });

  it('previous window shifts the bounds and keeps the unit', () => {
    expect(previousWindow('-1h')).toEqual({ earliest: '-2h', latest: '-1h' });
    expect(previousWindow('-15m')).toEqual({ earliest: '-30m', latest: '-15m' });
    expect(previousWindow('-7d')).toEqual({ earliest: '-14d', latest: '-7d' });
  });

  it('unparseable input is null, not an assumed 1h — callers skip the comparison', () => {
    expect(previousWindow('-1d@d')).toBeNull();
    expect(relativeTimeMs('-1d@d')).toBeNull();
  });
});
