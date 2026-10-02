/**
 * Metrics backfill — populate the fast store with history from raw spans so
 * panels work across ALL time ranges immediately, not just from emitter-start
 * forward. See docs/metrics-migration-plan.md and
 * docs/sessions/backfill-v2-design.md.
 *
 * The algorithm is the framework's `runMetricsBackfill`
 * (`@criblio/app-utils/metrics-backfill`): per-family coverage probed from
 * the store, only the gap below the forward-emit boundary filled,
 * newest→oldest, split-on-drop down to one minute. `npm run deploy` injects
 * Node deps (scripts/metricsBackfillDeps.ts); the Settings UI injects
 * browser deps (src/api/metricsBackfillBrowser.ts). Both run the identical
 * algorithm; only the transport differs.
 *
 * What stays APM's, here:
 *  - the emitter shape (`kind`, `sampleRate`) — see getMetricEmitters();
 *  - window planning by kind ({@link makeApmPlanWindows}): counters and the
 *    percentile gauges use big fixed windows; per-span histograms (none are
 *    emitted today, the planner is kept for when one is) are sized from a
 *    span-count pass so a sampled window stays under the per-export cap.
 *    Both tile the gap exactly, as the framework requires.
 */
import {
  DEFAULT_BACKFILL_WINDOW_SECONDS,
  SAFE_MAX_EXPORT_EVENTS,
  planDensityWindows,
  planFixedWindows,
  promSelector,
  type BackfillWindow,
  type MetricsBackfillDeps,
  type MetricsBackfillEmitter,
} from '@criblio/app-utils/metrics-backfill';
import { runSearchJob, type SearchHttpClient } from '@criblio/app-utils/search-job';
import { backfillSpanCounts } from './queries';

export {
  runMetricsBackfill,
  type EmitterBackfillResult,
  type MetricsBackfillResult,
} from '@criblio/app-utils/metrics-backfill';

/** Coarse bin for the span-count pass (histogram window sizing). */
export const COUNT_BIN_SECONDS = 300;

export interface SpanCountBin {
  tSec: number;
  count: number;
}

export interface BackfillEmitter extends MetricsBackfillEmitter {
  /** Aggregation shape — decides the window strategy and the coverage probe
   *  (`histogram` probes through `histogram_quantile(… by (le))`). Counters
   *  and the per-minute percentile gauges are both `counter`. */
  kind: 'counter' | 'histogram';
  /** Sample fraction the query applies (histograms). 1 = none. Sizes
   *  histogram windows: export events ≈ spans × sampleRate. */
  sampleRate?: number;
}

export type ApmBackfillDeps = MetricsBackfillDeps<BackfillEmitter>;

/**
 * APM's `planWindows` dep. Counters/gauges: contiguous fixed windows over
 * the gap (6h unless the emitter sets `windowSeconds`). Histograms: count
 * spans per {@link COUNT_BIN_SECONDS} over the gap (`countSpans`; default
 * runs `Q.backfillSpanCounts` through `http`) and pack the bins so each
 * window's expected export volume (spans × sampleRate) stays under the
 * per-export cap.
 */
export function makeApmPlanWindows(
  http: SearchHttpClient,
  countSpans: (earliestMs: number, latestMs: number) => Promise<SpanCountBin[]> = async (earliestMs, latestMs) =>
    spanCountBins(
      await runSearchJob(http, backfillSpanCounts(COUNT_BIN_SECONDS), {
        earliest: String(earliestMs),
        latest: String(latestMs),
        limit: 20_000,
        pageSize: 1_000,
        timeoutMs: 600_000,
      }),
    ),
): NonNullable<ApmBackfillDeps['planWindows']> {
  return async (emitter, gap: BackfillWindow) => {
    if (emitter.kind !== 'histogram') {
      return planFixedWindows(
        gap.earliestSec,
        gap.latestSec,
        emitter.windowSeconds ?? DEFAULT_BACKFILL_WINDOW_SECONDS,
      );
    }
    const rate = emitter.sampleRate && emitter.sampleRate > 0 ? emitter.sampleRate : 1;
    const bins = await countSpans(gap.earliestSec * 1000, gap.latestSec * 1000);
    // Passing the gap makes the framework tile it exactly, which
    // runMetricsBackfill requires of planWindows (0.12.4 fails an emitter
    // whose windows leave a hole or overlap): bins outside the gap are
    // ignored, windows are clamped to it — past the top is already-covered
    // data the store would double — and a bin with no spans joins its
    // neighbour instead of leaving a hole.
    return planDensityWindows(bins, COUNT_BIN_SECONDS, Math.floor(SAFE_MAX_EXPORT_EVENTS / rate), gap);
  };
}

/** Parse `Q.backfillSpanCounts()` result rows (`t`, `n`) into count bins. */
export function spanCountBins(rows: readonly Record<string, unknown>[]): SpanCountBin[] {
  return rows
    .filter((r) => r.t !== undefined)
    .map((r) => ({ tSec: Number(r.t), count: Number(r.n) }));
}

/** Display name for an emitter's family: the metric plus the label values
 *  its coverage is restricted to (one series of a shared family). */
export function emitterFamilyLabel(e: Pick<BackfillEmitter, 'metricName' | 'coverageLabels'>): string {
  return promSelector(e.metricName, e.coverageLabels);
}
