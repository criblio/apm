/**
 * Browser deps for the metrics backfill (src/api/metricsBackfill.ts) — the
 * Settings UI path. Runs the IDENTICAL core algorithm as `npm run deploy`
 * (scripts/metricsBackfillDeps.ts); only the transport differs:
 *   - countSpans / runExport → KQL search jobs via the app's `runQuery`
 *   - earliestCoveredSec      → the fast metrics store via `queryRange`
 *
 * Backfill exports MUST run to completion, so they use a never-aborting
 * signal — a navigation away must not cancel an in-flight export (a
 * half-written window would leave a gap). The per-window coverage check in
 * the core still makes a resumed run safe.
 */
import { runQuery } from './cribl';
import { queryRange } from './metrics';
import { backfillSpanCounts } from './queries';
import { coverageProbeQuery } from './metricNames';
import type { BackfillDeps, SpanCountBin } from './metricsBackfill';

/** Never aborts — opts backfill jobs out of nav-scoped cancellation. */
const NEVER_ABORT = new AbortController().signal;

export function makeBrowserBackfillDeps(log?: (msg: string) => void): BackfillDeps {
  return {
    log,
    async countSpans(earliestMs: number, latestMs: number): Promise<SpanCountBin[]> {
      const rows = await runQuery(backfillSpanCounts(300), String(earliestMs), String(latestMs), 20_000, NEVER_ABORT);
      return rows
        .filter((r) => r.t !== undefined)
        .map((r) => ({ tSec: Number(r.t), count: Number(r.n) }));
    },
    async runExport(query: string, earliestMs: number, latestMs: number) {
      const rows = await runQuery(query, String(earliestMs), String(latestMs), 10, NEVER_ABORT);
      const done = (rows.find((r) => /Exporting complete/.test(String((r as { status?: unknown }).status))) ?? {}) as {
        eventsOut?: unknown;
        eventsDropped?: unknown;
      };
      return {
        eventsOut: Number(done.eventsOut ?? 0),
        eventsDropped: Number(done.eventsDropped ?? 0),
      };
    },
    async earliestCoveredSec(
      metric: string,
      kind: 'counter' | 'histogram',
      earliestMs: number,
      latestMs: number,
    ): Promise<number | null> {
      // Histograms probe via histogram_quantile(rate[5m]); pad the start by
      // 5m so the first step's rate window has its samples.
      const startMs = kind === 'histogram' ? earliestMs - 300_000 : earliestMs;
      const series = await queryRange(coverageProbeQuery(metric, kind), {
        earliest: startMs,
        latest: latestMs,
        step: 300,
      });
      // Presence of a finite sample = coverage (a histogram quantile can be
      // a legitimate 0, so don't gate on value > 0).
      let min: number | null = null;
      for (const s of series) {
        for (const p of s.points) {
          if (Number.isFinite(p.v) && (min == null || p.t < min)) min = p.t;
        }
      }
      return min;
    },
  };
}
