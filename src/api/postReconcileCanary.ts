/**
 * Post-reconcile canary (ROADMAP P0.2).
 *
 * The provisioning guard (P0.1) catches static plan-text faults
 * (empty dataset clauses, (?i) upstream of export-to-lookup, etc.)
 * before reconcile applies. The canary catches the *runtime*
 * equivalents:
 *
 *   1. Sentinel scheduled search has produced rows in $vt_results
 *      recently. If a search ran but exported zero rows (the June
 *      outage shape — dataset="" baked into the query), the
 *      sentinel row count is 0 and the alarm fires.
 *
 *   2. A workspace lookup the app depends on still produces matches
 *      when joined against a known key. The June outage shipped an
 *      unjoinable CSV through `export to lookup` that reported
 *      success in every layer — the only way to catch this is to
 *      actually try the join.
 *
 * --first-install tolerance: on a brand-new pack install the
 * scheduled searches haven't had a chance to run yet, so $vt_results
 * is genuinely empty. The caller passes firstInstall: true in that
 * case and the empty-rows check is downgraded to a warning. The
 * join probe still runs because seed lookups are written by the
 * provisioner itself at install time.
 *
 * Lives in src/api/ (not scripts/) so it could in principle be
 * invoked from the browser sandbox too — e.g. an admin Settings
 * page button to re-run the canary on demand. The Node side just
 * passes a Node-backed HttpClient.
 */
import type { HttpClient } from '@criblio/app-utils/provisioner';
import { getCurrentDataset } from '@criblio/app-utils/dataset';
import { runSearchJob } from '@criblio/app-utils/search-job';
import {
  generatedEventContractCanaryRead,
  generatedEventContractCanarySend,
} from './generatedEventContract';
import { kqlDatasetId, kqlStringLiteral } from './kqlSafety';

/** Guard against injection when embedding the runtime dataset name
 *  in a literal query. Character-class matches the query builders'
 *  quoteDataset(). Callers must have set the dataset store upstream. */
function safeDataset(): string {
  return kqlDatasetId(getCurrentDataset());
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sentinel scheduled search ID. Picked because it runs every 5
 * minutes and aggregates over a -1h window — both the search
 * itself and the data it reads are highest-volume in the plan, so
 * if anything is broken, this is the one that catches it first.
 *
 * Stable across the lifetime of the deploy. Change here only if
 * the home service summary search is renamed or retired.
 */
export const CANARY_SENTINEL_SEARCH_ID = 'criblapm__home_service_summary';

/**
 * Lookup we'll join-probe. trace_originators was specifically the
 * one that got silently corrupted in the June outage when (?i)
 * upstream of `export to lookup` wrote an unjoinable CSV — picking
 * it for the canary closes that exact regression hole.
 */
export const CANARY_LOOKUP_NAME = 'criblapm_trace_originators';

export interface CanaryOpts {
  firstInstall?: boolean;
  /** Override the sentinel search ID — defaults to the constant. */
  sentinelSearchId?: string;
  /** Test hooks; production defaults tolerate normal ingest propagation. */
  contractPollAttempts?: number;
  contractPollMs?: number;
}

export interface CanaryReport {
  ok: boolean;
  sentinel: { ok: boolean; rowCount: number; message: string };
  lookupJoin: { ok: boolean; rowCount: number; message: string };
  eventContract: { ok: boolean; rowCount: number; message: string };
}

async function runCanaryQuery(
  http: HttpClient,
  kql: string,
  earliest: string,
  latest: string,
): Promise<Record<string, unknown>[]> {
  return runSearchJob(http, kql, {
    earliest,
    latest,
    limit: 100,
    timeoutMs: 45_000,
  });
}

/**
 * Run both probes. Returns a structured report; the caller decides
 * how to surface failures (exit code in provision.ts, future UI
 * banner if invoked from the browser).
 */
export async function runCanary(
  http: HttpClient,
  opts: CanaryOpts = {},
): Promise<CanaryReport> {
  const sentinelId = opts.sentinelSearchId ?? CANARY_SENTINEL_SEARCH_ID;

  // ── Probe 1: sentinel $vt_results has rows ──────────────────
  // -2h window — enough to span the 5-min scheduled-search cadence
  // a couple times over, so a transient miss doesn't flap the canary.
  const sentinelKql = `dataset="$vt_results"
    | where jobName == ${kqlStringLiteral(sentinelId)}
    | limit 1`;
  let sentinelRows: Record<string, unknown>[] = [];
  let sentinelErr: unknown = null;
  try {
    sentinelRows = await runCanaryQuery(http, sentinelKql, '-2h', 'now');
  } catch (e) {
    sentinelErr = e;
  }

  const sentinel: CanaryReport['sentinel'] = (() => {
    if (sentinelErr) {
      return {
        ok: false,
        rowCount: 0,
        message: `sentinel query failed: ${(sentinelErr as Error).message ?? String(sentinelErr)}`,
      };
    }
    if (sentinelRows.length > 0) {
      return {
        ok: true,
        rowCount: sentinelRows.length,
        message: `sentinel ${sentinelId} has $vt_results rows (≥1 row in -2h)`,
      };
    }
    // No rows. First-install is tolerant; otherwise fail.
    if (opts.firstInstall) {
      return {
        ok: true,
        rowCount: 0,
        message: `sentinel ${sentinelId} has no $vt_results yet — tolerated under --first-install`,
      };
    }
    return {
      ok: false,
      rowCount: 0,
      message: `sentinel ${sentinelId} produced ZERO $vt_results rows in -2h (was the search wiped to dataset=""? — re-run plan validation)`,
    };
  })();

  // ── Probe 2: sampled lookup-join ratio ──────────────────────
  //
  // Take 50 root spans (parent_span_id == "") from the last 15
  // minutes, join each to the lookup, count how many produced a
  // non-null `type` column. If joined == 0 across 50 samples,
  // either no recent root_svc made the lookup's threshold (very
  // unlikely on real traffic — load-generator alone produces 100+
  // root spans in -15m and is always in the lookup) or the lookup
  // CSV is unjoinable (the June 2026 (?i)+export bug shape). Both
  // failure modes warrant alerting — a healthy workspace must have
  // at least one root_svc that joins.
  //
  // Why sampling beats "pick a known key": there's no static
  // service name that's guaranteed to be in the lookup across
  // deployments. The trace_originators search filters
  // `total >= 10` so low-volume roots get dropped. Sampling lets
  // the canary work against any workspace that has enough traffic
  // to populate the lookup at all.
  const lookupKql = `dataset="${safeDataset()}"
    | where tostring(parent_span_id) == ""
    | extend root_svc=tostring(resource.attributes['service.name'])
    | take 50
    | lookup ${CANARY_LOOKUP_NAME} on root_svc
    | summarize total=count(), joined=countif(isnotnull(type))`;
  let lookupRows: Record<string, unknown>[] = [];
  let lookupErr: unknown = null;
  try {
    lookupRows = await runCanaryQuery(http, lookupKql, '-15m', 'now');
  } catch (e) {
    lookupErr = e;
  }

  const lookupJoin: CanaryReport['lookupJoin'] = (() => {
    if (lookupErr) {
      return {
        ok: false,
        rowCount: 0,
        message: `lookup probe query failed: ${(lookupErr as Error).message ?? String(lookupErr)}`,
      };
    }
    const row = lookupRows[0];
    if (!row) {
      if (opts.firstInstall) {
        return {
          ok: true,
          rowCount: 0,
          message: `lookup ${CANARY_LOOKUP_NAME} probe returned no rows — tolerated under --first-install (no root spans in -15m yet)`,
        };
      }
      return {
        ok: false,
        rowCount: 0,
        message: `lookup ${CANARY_LOOKUP_NAME} probe returned no rows (no root spans found in -15m — check telemetry pipeline)`,
      };
    }
    const total = Number(row['total'] ?? 0);
    const joined = Number(row['joined'] ?? 0);
    if (total === 0) {
      if (opts.firstInstall) {
        return {
          ok: true,
          rowCount: 1,
          message: `lookup ${CANARY_LOOKUP_NAME}: zero root spans in sample window — tolerated under --first-install`,
        };
      }
      return {
        ok: false,
        rowCount: 1,
        message: `lookup ${CANARY_LOOKUP_NAME}: zero root spans found in -15m (telemetry pipeline issue?)`,
      };
    }
    if (joined > 0) {
      return {
        ok: true,
        rowCount: 1,
        message: `lookup ${CANARY_LOOKUP_NAME} joinable (${joined}/${total} sampled root spans matched)`,
      };
    }
    // total > 0 and joined == 0: lookup is unjoinable. Either the
    // June 2026 (?i)+export corruption, or the lookup hasn't been
    // populated yet (search hasn't run). First-install path is the
    // documented escape hatch for the second case.
    if (opts.firstInstall) {
      return {
        ok: true,
        rowCount: 1,
        message: `lookup ${CANARY_LOOKUP_NAME}: ${total} root spans sampled, 0 joined — tolerated under --first-install (search hasn't populated yet)`,
      };
    }
    return {
      ok: false,
      rowCount: 1,
      message: `lookup ${CANARY_LOOKUP_NAME}: ${total} sampled root spans, ZERO joined — lookup is unjoinable (the June 2026 (?i)+export bug shape) OR no root_svc cleared the search's count threshold`,
    };
  })();

  // ── Probe 3: generated-event send/storage/read contract ─────────
  // Emit one alert and one deploy sentinel through Local Search, then read
  // both back through the platform-normalized data_datatype expression used
  // by every consumer. This catches routing/normalization drift that static
  // query validation cannot see.
  const canaryId = `criblapm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  let eventContractRows: Record<string, unknown>[] = [];
  let eventContractErr: unknown = null;
  try {
    await runCanaryQuery(
      http,
      generatedEventContractCanarySend(canaryId, safeDataset()),
      '-1m',
      'now',
    );
    const attempts = Math.max(1, opts.contractPollAttempts ?? 8);
    const pollMs = Math.max(0, opts.contractPollMs ?? 1_000);
    for (let attempt = 0; attempt < attempts; attempt++) {
      eventContractRows = await runCanaryQuery(
        http,
        generatedEventContractCanaryRead(canaryId, safeDataset()),
        '-15m',
        'now',
      );
      const row = eventContractRows[0];
      if (Number(row?.['rows'] ?? 0) >= 2) break;
      if (attempt + 1 < attempts) await delay(pollMs);
    }
  } catch (e) {
    eventContractErr = e;
  }

  const eventContract: CanaryReport['eventContract'] = (() => {
    if (eventContractErr) {
      return {
        ok: false,
        rowCount: 0,
        message: `generated-event contract probe failed: ${(eventContractErr as Error).message ?? String(eventContractErr)}`,
      };
    }
    const row = eventContractRows[0];
    const rows = Number(row?.['rows'] ?? 0);
    const types = Number(row?.['types'] ?? 0);
    const versions = Number(row?.['versions'] ?? 0);
    const canaries = Number(row?.['canaries'] ?? 0);
    const ok = rows >= 2 && types === 2 && versions === 1 && canaries >= 2;
    return {
      ok,
      rowCount: rows,
      message: ok
        ? `generated-event contract round-trip passed (${rows} rows, ${types} datatypes, schema v1)`
        : `generated-event contract drift: expected 2 canary rows across 2 datatypes at one schema version; got rows=${rows}, types=${types}, versions=${versions}, canaries=${canaries}`,
    };
  })();

  return {
    ok: sentinel.ok && lookupJoin.ok && eventContract.ok,
    sentinel,
    lookupJoin,
    eventContract,
  };
}
