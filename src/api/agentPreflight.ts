/**
 * Client-side anomaly preflight for the Copilot Investigator.
 *
 * Why this exists: in the 2026-04-12 scenario eval
 * (`docs/sessions/2026-04-12-scenario-evaluation.md`) the Investigator
 * cleanly missed `paymentUnreachable` because it only ran error-rate
 * queries — the loudest signal was that payment's request rate had
 * collapsed 94%, which the agent never noticed. The Home page's
 * existing health logic *does* catch this (the `traffic_drop` and
 * `silent` buckets), but only because the UI runs current vs prior
 * window summaries on every page load.
 *
 * The preflight runs the same comparison in the browser before the
 * first LLM turn, then injects the findings into the seed prompt as
 * known signals. This way the agent starts with the right
 * hypothesis instead of having to discover it (or, in the bad cases,
 * not discovering it at all). It costs two `serviceSummary` queries
 * — both already heavily cached server-side — and ~1 second wall
 * clock, vs. dozens of agent turns it can save.
 *
 * What it surfaces, ordered by impact:
 *
 *   1. **Silent services**: services that emitted ≥50 spans in the
 *      prior window and zero (or near-zero) spans now. This is the
 *      `paymentUnreachable` shape — the service crashed or got
 *      isolated and stopped reporting entirely. The most actionable
 *      signal we can give the agent.
 *   2. **Rate drops**: services whose request rate fell ≥50% vs the
 *      prior window with at least 50 prior samples. Usually upstream
 *      kafka lag, stuck consumers, or partial isolation.
 *   3. **Error spikes**: services whose error-rate delta jumped by
 *      ≥1pp vs the prior window. Already part of the seeded button
 *      flow but worth surfacing in free-form prompts too.
 *
 * The output is a list of plain-string lines that slot into the
 * existing `signalsBlock` in `agentContext.ts` — no schema changes
 * to InvestigationSeed required.
 */
import { listServiceSummaries } from './search';
import { previousWindow } from '../utils/timeRange';
import { MIN_BASELINE_REQUESTS } from '../utils/health';
import type { ServiceSummary } from './types';

export interface PreflightResult {
  /** Services that produced ≥MIN_BASELINE_REQUESTS spans in the prior
   *  window and effectively zero now. Most-actionable bucket. */
  silent: Array<{ service: string; priorRequests: number }>;
  /** Services with a meaningful rate drop (≥50% decline) but not
   *  fully silent. */
  rateDrops: Array<{
    service: string;
    currentRequests: number;
    priorRequests: number;
    dropPct: number;
  }>;
  /** Services whose error-rate jumped by ≥1pp vs the prior window. */
  errorSpikes: Array<{
    service: string;
    currentErrorRate: number;
    priorErrorRate: number;
    deltaPp: number;
  }>;
}

/**
 * Threshold for the rateDrops bucket. Mirrors the value
 * `utils/health.ts` uses for the `traffic_drop` row tint so the UI
 * and the agent agree on what "dropped" means.
 */
const RATE_DROP_THRESHOLD = 0.5;

/**
 * Threshold for the errorSpikes bucket — absolute percentage points
 * change vs prior window.
 */
const ERROR_SPIKE_PP = 1.0;

/**
 * Run the preflight queries against the given range. Returns an
 * empty result on any failure (the investigation should still run
 * even if the preflight is degraded). Caller is expected to pass
 * the same `earliest` it'll use for the LLM seed.
 */
export async function runPreflight(
  earliest: string,
  latest: string,
): Promise<PreflightResult> {
  const empty: PreflightResult = {
    silent: [],
    rateDrops: [],
    errorSpikes: [],
  };

  let current: ServiceSummary[];
  let prior: ServiceSummary[];
  try {
    const prev = previousWindow(earliest);
    [current, prior] = await Promise.all([
      listServiceSummaries(earliest, latest),
      listServiceSummaries(prev.earliest, prev.latest),
    ]);
  } catch {
    return empty;
  }

  const curByName = new Map<string, ServiceSummary>();
  for (const sv of current) curByName.set(sv.service, sv);
  const priorByName = new Map<string, ServiceSummary>();
  for (const sv of prior) priorByName.set(sv.service, sv);

  const result: PreflightResult = {
    silent: [],
    rateDrops: [],
    errorSpikes: [],
  };

  // Silent + rate drops are computed by walking the union of names —
  // a service that disappeared completely won't show up in `current`
  // at all, so iterating only `current` would miss the most
  // important bucket.
  const allNames = new Set<string>([
    ...curByName.keys(),
    ...priorByName.keys(),
  ]);

  for (const name of allNames) {
    const cur = curByName.get(name);
    const pre = priorByName.get(name);
    if (!pre || pre.requests < MIN_BASELINE_REQUESTS) continue;

    const curReqs = cur?.requests ?? 0;

    // Silent: was busy, now near-zero. The cutoff is intentionally
    // strict (< 5% of prior) so a service that's just degraded
    // doesn't get bucketed as "down".
    if (curReqs <= pre.requests * 0.05) {
      result.silent.push({
        service: name,
        priorRequests: pre.requests,
      });
      continue;
    }

    // Rate drop (but not fully silent): below the 50% threshold.
    const ratio = curReqs / pre.requests;
    if (ratio <= RATE_DROP_THRESHOLD) {
      result.rateDrops.push({
        service: name,
        currentRequests: curReqs,
        priorRequests: pre.requests,
        dropPct: Math.round((1 - ratio) * 100),
      });
    }
  }

  // Error spikes — only meaningful when the current window has a
  // service summary at all.
  for (const cur of current) {
    const pre = priorByName.get(cur.service);
    if (!pre) continue;
    const curPct = cur.errorRate * 100;
    const prePct = pre.errorRate * 100;
    const deltaPp = curPct - prePct;
    if (deltaPp >= ERROR_SPIKE_PP) {
      result.errorSpikes.push({
        service: cur.service,
        currentErrorRate: cur.errorRate,
        priorErrorRate: pre.errorRate,
        deltaPp,
      });
    }
  }

  // Sort each bucket so the most-impactful entries come first. The
  // agent reads the signals top-down so order matters.
  result.silent.sort((a, b) => b.priorRequests - a.priorRequests);
  result.rateDrops.sort((a, b) => b.dropPct - a.dropPct);
  result.errorSpikes.sort((a, b) => b.deltaPp - a.deltaPp);

  return result;
}

/**
 * Format a PreflightResult as plain-string signal lines that slot
 * into the existing `InvestigationSeed.knownSignals` array. Each
 * line stands on its own and includes the service name, the
 * comparison, and an action hint where appropriate.
 */
export function formatPreflightSignals(p: PreflightResult): string[] {
  const lines: string[] = [];

  if (p.silent.length > 0) {
    lines.push(
      `**Silent services (likely down)**: the following services emitted spans in the prior window but are now silent — start the investigation here:`,
    );
    for (const s of p.silent.slice(0, 5)) {
      lines.push(
        `  - \`${s.service}\` — ${s.priorRequests.toLocaleString()} requests in prior window, ~0 now. Highly likely the root cause; do not pursue downstream error chains until you have ruled this out.`,
      );
    }
  }

  if (p.rateDrops.length > 0) {
    lines.push(
      `**Traffic drops (≥50% vs prior window)**: services whose rate collapsed but are still emitting some traffic. Often upstream kafka/queue lag or partial isolation:`,
    );
    for (const d of p.rateDrops.slice(0, 5)) {
      lines.push(
        `  - \`${d.service}\` — ${d.currentRequests.toLocaleString()} requests now vs ${d.priorRequests.toLocaleString()} prior (▼${d.dropPct}%).`,
      );
    }
  }

  if (p.errorSpikes.length > 0) {
    lines.push(
      `**Error-rate spikes (Δ≥1pp vs prior window)**: services whose error rate jumped recently:`,
    );
    for (const e of p.errorSpikes.slice(0, 5)) {
      lines.push(
        `  - \`${e.service}\` — ${(e.currentErrorRate * 100).toFixed(2)}% errors now vs ${(e.priorErrorRate * 100).toFixed(2)}% prior (▲${e.deltaPp.toFixed(2)}pp).`,
      );
    }
  }

  if (lines.length === 0) {
    lines.push(
      'No traffic-drop, silent-service, or error-spike anomalies detected in the current window vs the prior window. The user-reported problem (if any) may be subtle — proceed with per-minute histograms and edge-level inspection.',
    );
  }

  return lines;
}
