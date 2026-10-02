/**
 * Post-reconcile canary (ROADMAP P0.2) — APM's configuration of the
 * framework's `runProvisionCanary` (`@criblio/app-utils/provision-canary`).
 *
 * The plan guard catches static plan-text faults before apply; the
 * canary catches their runtime equivalents, which every API layer
 * reports as success:
 *
 *   1. Sentinel — `criblapm__home_service_summary` has `$vt_results`
 *      rows in -2h. A search wiped to `dataset=""` runs on schedule and
 *      writes nothing (the June 2026 outage shape).
 *   2. Lookup join — 50 sampled root spans joined against
 *      `criblapm_trace_originators` must match at least once. The June
 *      outage shipped an unjoinable CSV (`(?i)` upstream of `export to
 *      lookup`) that reported success everywhere.
 *   3. Generated-event contract (APM probe) — emit one alert and one
 *      deploy sentinel, then read both back through the same normalized
 *      datatype expression every consumer uses (framework
 *      `runGeneratedEventCanary`).
 *
 * `firstInstall` tolerates empty sentinel/lookup results (the searches
 * have not run yet). It never tolerates the event-contract probe: that
 * round trip does not depend on any scheduled search.
 *
 * Lives in src/api/ so the browser could run it too; the Node side passes
 * a Node-backed HttpClient.
 */
import type { HttpClient } from '@criblio/app-utils/provisioner';
import { getCurrentDataset } from '@criblio/app-utils/dataset';
import {
  runProvisionCanary,
  type ProvisionCanaryProbe,
  type ProvisionCanaryReport,
} from '@criblio/app-utils/provision-canary';
import { runGeneratedEventCanary } from '@criblio/app-utils/generated-events';
import { GENERATED_EVENTS } from './generatedEventContract';
import { kqlDatasetId } from './kqlSafety';

/** Guard against injection when embedding the runtime dataset name in a
 *  literal query. Callers must have set the dataset store upstream. */
function safeDataset(): string {
  return kqlDatasetId(getCurrentDataset());
}

/**
 * Sentinel scheduled search: runs every cadence tick over a -1h window,
 * the highest-volume search in the plan, so it is the first to show a
 * broken pipeline. Change only if that search is renamed or retired.
 */
export const CANARY_SENTINEL_SEARCH_ID = 'criblapm__home_service_summary';

/**
 * Lookup we join-probe. trace_originators is the one the June outage
 * silently corrupted, so probing it closes that exact regression hole.
 */
export const CANARY_LOOKUP_NAME = 'criblapm_trace_originators';

/** Probe name of the generated-event round trip in the report. */
export const EVENT_CONTRACT_PROBE_NAME = 'generated-event contract';

export interface CanaryOpts {
  firstInstall?: boolean;
  /** Override the sentinel search ID — defaults to the constant. */
  sentinelSearchId?: string;
  /** Test hooks; production defaults tolerate normal ingest propagation. */
  contractPollAttempts?: number;
  contractPollMs?: number;
}

/**
 * Sampled join: root spans from the probe window, joined to the lookup.
 * No static service name is guaranteed to be in the lookup on every
 * workspace (trace_originators keeps roots with `total >= 10`), so the
 * keys are sampled from live data.
 */
function lookupProbeKql(): string {
  return `dataset="${safeDataset()}"
    | where tostring(parent_span_id) == ""
    | extend root_svc=tostring(resource.attributes['service.name'])
    | take 50
    | lookup ${CANARY_LOOKUP_NAME} on root_svc
    | summarize total=count(), joined=countif(isnotnull(type))`;
}

/** The generated-event send → storage → read round trip — the framework's
 *  `runGeneratedEventCanary` over APM's {@link GENERATED_EVENTS}. */
export function eventContractProbe(
  opts: Pick<CanaryOpts, 'contractPollAttempts' | 'contractPollMs'> = {},
): ProvisionCanaryProbe {
  return {
    name: EVENT_CONTRACT_PROBE_NAME,
    async run({ query }) {
      const verdict = await runGeneratedEventCanary(GENERATED_EVENTS, query, {
        dataset: safeDataset(),
        canaryId: `criblapm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        attempts: opts.contractPollAttempts,
        pollMs: opts.contractPollMs,
      });
      return { ok: verdict.ok, tolerated: false, rowCount: verdict.rows, message: verdict.message };
    },
  };
}

/**
 * Run every probe. Never throws for a failed probe; the caller decides
 * how to surface failures (exit code in provision.ts).
 */
export function runCanary(
  http: HttpClient,
  opts: CanaryOpts = {},
): Promise<ProvisionCanaryReport> {
  return runProvisionCanary(http, {
    sentinelSearchId: opts.sentinelSearchId ?? CANARY_SENTINEL_SEARCH_ID,
    lookupProbe: { name: CANARY_LOOKUP_NAME, kql: lookupProbeKql() },
    extraProbes: [eventContractProbe(opts)],
    firstInstall: opts.firstInstall,
  });
}
