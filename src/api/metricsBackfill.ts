/**
 * Metrics backfill (v2) — populate the fast store with history from raw
 * spans so panels work across ALL time ranges immediately, not just from
 * emitter-start forward. See docs/metrics-migration-plan.md and
 * docs/sessions/backfill-v2-design.md.
 *
 * This module is PURE + deps-injected: the caller supplies `countSpans`,
 * `runExport`, and `earliestCoveredSec`. `npm run deploy` injects Node
 * deps (search-job API, scripts/metricsBackfillDeps.ts); the Settings UI
 * injects browser deps (src/api/metricsBackfillBrowser.ts). Both run the
 * IDENTICAL algorithm below.
 *
 * Design:
 *  1. **Per-metric idempotency.** For each emitter's metric, probe
 *     `earliestCoveredSec` — the earliest time the metric already has data
 *     (from forward emit or a prior backfill). Backfill only the gap
 *     `[fromSec, earliestCoveredSec)`. A NEW metric has no data → full
 *     horizon; an already-covered metric → empty gap → skipped. So adding
 *     a new metric family backfills ONLY that family.
 *  2. **No double-count.** The store is NOT idempotent (re-emitting a bin
 *     doubles it). The gap's upper bound is the forward-emit boundary, so
 *     backfill windows never straddle already-written minutes. Each window
 *     is also coverage-checked before emit, so an interrupted prior run
 *     resumes without re-emitting completed windows.
 *  3. **Reverse order.** Windows run newest→oldest, extending coverage
 *     contiguously backward — an interruption leaves a clean boundary.
 *  4. **Per-type windows.** Counters emit few aggregated rows per minute →
 *     big fixed windows. Histograms emit per-span → sampled query + span-
 *     count chunking (the caller passes the sampled `backfillQuery`).
 *  5. **Zero drops.** If an export reports `eventsDropped > 0`, split the
 *     window and retry until clean (or the 1-minute floor).
 */

/** Under the observed ~50k per-export cap, with headroom. */
export const SAFE_MAX_EXPORT_EVENTS = 40_000;
/** Don't split a window below this — a single minute that still drops is
 *  too dense to emit losslessly and is logged/skipped instead. */
export const MIN_CHUNK_SECONDS = 60;
/** Coarse bin for the count pass (histogram window sizing). */
export const COUNT_BIN_SECONDS = 300;
/** Counters emit aggregated rows, so cover them in big windows. */
export const COUNTER_WINDOW_SECONDS = 6 * 3600;

export interface BackfillWindow {
  earliestSec: number;
  latestSec: number;
}

export interface SpanCountBin {
  tSec: number;
  count: number;
}

export interface BackfillEmitter {
  id: string;
  /** Metric family name in the fast store (for the coverage probe). */
  metricName: string;
  /** Aggregation shape — decides the window strategy. */
  kind: 'counter' | 'histogram';
  /** Query to RUN for backfill. Counters: the live query. Histograms: the
   *  SAMPLED variant (fewer per-span events, same percentile shape). */
  backfillQuery: string;
  /** Sample fraction the backfillQuery applies (histograms). 1 = none.
   *  Used to size histogram windows (export events ≈ spans × sampleRate). */
  sampleRate?: number;
}

export interface BackfillDeps {
  /** Count spans per COUNT_BIN_SECONDS bin over [earliestMs, latestMs). */
  countSpans(earliestMs: number, latestMs: number): Promise<SpanCountBin[]>;
  /** Run an emitter export over [earliestMs, latestMs); return export stats. */
  runExport(
    query: string,
    earliestMs: number,
    latestMs: number,
  ): Promise<{ eventsOut: number; eventsDropped: number }>;
  /** Earliest epoch-SECONDS a metric already has a sample within
   *  [earliestMs, latestMs], or null if it has none. Drives per-metric
   *  idempotency (the store is the source of truth for coverage). `kind`
   *  selects the probe query — histograms need `histogram_quantile(… by
   *  (le))`, counters use `count()` (see coverageProbeQuery). */
  earliestCoveredSec(
    metricName: string,
    kind: 'counter' | 'histogram',
    earliestMs: number,
    latestMs: number,
  ): Promise<number | null>;
  log?(msg: string): void;
}

export interface EmitterBackfillResult {
  id: string;
  metricName: string;
  /** True when the whole horizon was already covered (nothing to do). */
  skipped: boolean;
  windows: number;
  windowsCovered: number;
  exportsRun: number;
  totalOut: number;
  totalDropped: number;
  gapFromSec: number;
  gapToSec: number;
}

export interface BackfillResult {
  emitters: EmitterBackfillResult[];
  exportsRun: number;
  totalOut: number;
  totalDropped: number;
  droppedWindows: BackfillWindow[];
  coveredFromSec: number;
  coveredToSec: number;
}

/** Floor an epoch-seconds value to a minute boundary. */
export function floorToMinute(sec: number): number {
  return Math.floor(sec / 60) * 60;
}

/**
 * Pack ascending, evenly-spaced count bins into aligned non-overlapping
 * windows, each with an expected export-event total <= maxPerChunk. A
 * single bin over the cap becomes its own window (the runner splits it
 * further on a drop). Windows are contiguous so no history is skipped.
 */
export function planBackfillWindows(
  bins: SpanCountBin[],
  binSeconds: number,
  maxPerChunk: number = SAFE_MAX_EXPORT_EVENTS,
): BackfillWindow[] {
  const windows: BackfillWindow[] = [];
  let start: number | null = null;
  let acc = 0;
  let end = 0;
  for (const b of bins) {
    if (start === null) start = b.tSec;
    if (acc > 0 && acc + b.count > maxPerChunk) {
      windows.push({ earliestSec: start, latestSec: end });
      start = b.tSec;
      acc = 0;
    }
    acc += b.count;
    end = b.tSec + binSeconds;
  }
  if (start !== null) windows.push({ earliestSec: start, latestSec: end });
  return windows;
}

/**
 * Contiguous fixed-size windows covering [fromSec, toSec). The last window
 * is clamped to toSec. Used for counters, whose emit volume is small and
 * roughly proportional to duration (not span count).
 */
export function planFixedWindows(
  fromSec: number,
  toSec: number,
  windowSeconds: number = COUNTER_WINDOW_SECONDS,
): BackfillWindow[] {
  const windows: BackfillWindow[] = [];
  for (let s = fromSec; s < toSec; s += windowSeconds) {
    windows.push({ earliestSec: s, latestSec: Math.min(s + windowSeconds, toSec) });
  }
  return windows;
}

/**
 * Run one emitter over one window, splitting on drops until clean or the
 * minute floor is hit. Accumulates stats into `acc`.
 */
async function runWindowLossless(
  deps: BackfillDeps,
  query: string,
  w: BackfillWindow,
  acc: { exportsRun: number; totalOut: number; totalDropped: number; droppedWindows: BackfillWindow[] },
): Promise<void> {
  const { eventsOut, eventsDropped } = await deps.runExport(
    query,
    w.earliestSec * 1000,
    w.latestSec * 1000,
  );
  acc.exportsRun += 1;
  acc.totalOut += eventsOut;
  if (eventsDropped <= 0) return;

  const span = w.latestSec - w.earliestSec;
  if (span <= MIN_CHUNK_SECONDS) {
    acc.totalDropped += eventsDropped;
    acc.droppedWindows.push(w);
    deps.log?.(`⚠ backfill: ${eventsDropped} dropped in dense minute ${w.earliestSec}-${w.latestSec}`);
    return;
  }
  const mid = floorToMinute(w.earliestSec + Math.floor(span / 2));
  const lo = { earliestSec: w.earliestSec, latestSec: Math.max(mid, w.earliestSec + MIN_CHUNK_SECONDS) };
  const hi = { earliestSec: lo.latestSec, latestSec: w.latestSec };
  deps.log?.(`  split dense window ${w.earliestSec}-${w.latestSec} → 2`);
  await runWindowLossless(deps, query, lo, acc);
  if (hi.latestSec > hi.earliestSec) await runWindowLossless(deps, query, hi, acc);
}

/** Plan a single emitter's windows over its gap, by kind. */
function planEmitterWindows(
  e: BackfillEmitter,
  bins: SpanCountBin[],
  countBin: number,
  gapFromSec: number,
  gapToSec: number,
): BackfillWindow[] {
  if (e.kind === 'counter') {
    return planFixedWindows(gapFromSec, gapToSec, COUNTER_WINDOW_SECONDS);
  }
  // Histogram: sampled — export events ≈ spans × sampleRate, so a window
  // may hold up to SAFE_MAX / sampleRate raw spans.
  const rate = e.sampleRate && e.sampleRate > 0 ? e.sampleRate : 1;
  const cap = Math.floor(SAFE_MAX_EXPORT_EVENTS / rate);
  const inGap = bins.filter((b) => b.tSec >= gapFromSec && b.tSec < gapToSec);
  return planBackfillWindows(inGap, countBin, cap);
}

/**
 * Backfill all emitters over the last `horizonSec` seconds (up to
 * `floor(nowSec)@m`). Per emitter: probe existing coverage, backfill only
 * the uncovered gap, newest→oldest, zero-drop. `nowSec` is injected
 * (clocks differ; keeps tests deterministic).
 */
export async function runMetricsBackfill(
  deps: BackfillDeps,
  emitters: BackfillEmitter[],
  opts: { horizonSec: number; nowSec: number; countBinSeconds?: number },
): Promise<BackfillResult> {
  const countBin = opts.countBinSeconds ?? COUNT_BIN_SECONDS;
  const toSec = floorToMinute(opts.nowSec);
  const fromSec = floorToMinute(toSec - opts.horizonSec);

  // One count pass over the whole horizon feeds every histogram emitter's
  // window sizing (counters ignore it).
  const needCounts = emitters.some((e) => e.kind === 'histogram');
  const bins = needCounts ? await deps.countSpans(fromSec * 1000, toSec * 1000) : [];

  const acc = { exportsRun: 0, totalOut: 0, totalDropped: 0, droppedWindows: [] as BackfillWindow[] };
  const emitterResults: EmitterBackfillResult[] = [];

  for (const e of emitters) {
    // Per-metric idempotency: find the forward-emit / prior-backfill
    // boundary and backfill only what's below it.
    const covFrom = await deps.earliestCoveredSec(e.metricName, e.kind, fromSec * 1000, toSec * 1000);
    const gapToSec = covFrom == null ? toSec : Math.min(floorToMinute(covFrom), toSec);
    const before = { exportsRun: acc.exportsRun, totalOut: acc.totalOut, totalDropped: acc.totalDropped };

    if (gapToSec <= fromSec) {
      deps.log?.(`  ${e.id}: already covered — skipping`);
      emitterResults.push({
        id: e.id, metricName: e.metricName, skipped: true,
        windows: 0, windowsCovered: 0, exportsRun: 0, totalOut: 0, totalDropped: 0,
        gapFromSec: fromSec, gapToSec,
      });
      continue;
    }

    const planned = planEmitterWindows(e, bins, countBin, fromSec, gapToSec);
    // Reverse: newest→oldest, so coverage extends contiguously backward.
    planned.sort((a, b) => b.latestSec - a.latestSec);
    deps.log?.(`  ${e.id}: gap ${fromSec}-${gapToSec}, ${planned.length} window(s), newest→oldest`);

    // Every window sits inside the uncovered gap [fromSec, gapToSec), whose
    // upper bound IS the first already-covered bin — so windows never
    // overlap existing data and we emit them all. (An earlier per-window
    // re-probe caused a boundary false-positive: the newest window's last
    // bin coincided with the first covered bin, so the whole window was
    // wrongly skipped, leaving a hole. Resume-safety instead comes from the
    // gap itself — a re-run re-derives earliestCovered and only fills what's
    // still missing.)
    for (const w of planned) {
      await runWindowLossless(deps, e.backfillQuery, w, acc);
    }

    emitterResults.push({
      id: e.id, metricName: e.metricName, skipped: false,
      windows: planned.length, windowsCovered: 0,
      exportsRun: acc.exportsRun - before.exportsRun,
      totalOut: acc.totalOut - before.totalOut,
      totalDropped: acc.totalDropped - before.totalDropped,
      gapFromSec: fromSec, gapToSec,
    });
  }

  return {
    emitters: emitterResults,
    exportsRun: acc.exportsRun,
    totalOut: acc.totalOut,
    totalDropped: acc.totalDropped,
    droppedWindows: acc.droppedWindows,
    coveredFromSec: fromSec,
    coveredToSec: toSec,
  };
}
