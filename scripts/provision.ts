#!/usr/bin/env tsx
/**
 * Reconcile scheduled searches against the provisioning plan.
 *
 * Wires the framework's reconcile() / planOnly() to a Node fetch
 * + Bearer token via createNodeHttpClient. Used by `npm run deploy`
 * after pack install, and runnable standalone.
 *
 * Usage:
 *   npx tsx scripts/provision.ts          # reconcile (create/update/delete)
 *   npx tsx scripts/provision.ts --dry    # show plan without applying
 *
 * APM_ALLOW_OFFLINE_DATAGEN=true temporarily waives only the
 * telemetry-dependent post-reconcile checks. The event contract remains
 * mandatory, and the waiver expires in code.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNodeHttpClient,
  listProvisioned,
  type HttpClient,
  type PlanAction,
} from '@criblio/app-utils/provisioner';
import { reconcile, planOnly } from '../src/api/provisioner.js';
import { validateProvisionPlan } from '../src/api/provisionGuard.js';
import { runCanary } from '../src/api/postReconcileCanary.js';
import {
  getProvisioningPlan,
  SEED_LOOKUPS,
  CELL_WEBHOOK_TARGET_ID,
  CRIBLAPM_PREFIX,
} from '../src/api/provisionedSearches.js';
import {
  ensureCellWebhookTarget,
  ensureAlertNotification,
  removeAlertNotification,
  ALERT_NOTIFY_SEARCH_ID,
} from '../src/api/cellProvisioning.js';
import {
  apply as applyDatasetProvisioning,
  getStatus as getDatasetStatus,
} from '../src/api/datasetProvisioner.js';
import { setSearchCadence } from '@criblio/app-utils/cadence';
import { setCurrentDataset } from '@criblio/app-utils/dataset';
import { setLowVolumeMode } from '../src/api/lowVolumeMode.js';
import { setMetricsEmit, getMetricsEmit } from '../src/api/metricsEmit.js';
import { getServerInvestigations, setServerInvestigations } from '../src/api/serverInvestigations.js';
import { getMetricEmitters } from '../src/api/provisionedSearches.js';
import { runMetricsBackfill } from '../src/api/metricsBackfill.js';
import { makeNodeBackfillDeps } from './metricsBackfillDeps.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const OFFLINE_DATAGEN_WAIVER_EXPIRES = Date.parse('2026-08-31T23:59:59Z');

function loadDotEnv(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return {};
  }
  const env: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

function actionLabel(a: PlanAction): string {
  if (a.kind === 'create') return `  + create ${a.want.id}`;
  if (a.kind === 'update') return `  ~ update ${a.want.id}`;
  if (a.kind === 'delete') return `  - delete ${a.current.id}`;
  if (a.kind === 'noop') return `  · noop   ${a.want.id}`;
  return `  · noop`;
}

async function loadAppSettingsFromKV(http: HttpClient): Promise<void> {
  // Default the dataset to 'otel' first so the in-memory store has
  // a value even when KV is unreachable. Without this, every saved
  // search gets `dataset=""` baked in at provision time and reads
  // produce zero rows — a complete outage of every panel.
  setCurrentDataset('otel');
  try {
    const raw = await http.get('/kvstore/settings/app');
    if (raw && typeof raw === 'object') {
      const settings = raw as Record<string, unknown>;
      if (settings.searchCadence && typeof settings.searchCadence === 'string') {
        setSearchCadence(settings.searchCadence);
      }
      if (settings.dataset && typeof settings.dataset === 'string' && settings.dataset.trim()) {
        setCurrentDataset(settings.dataset.trim());
      }
      if (settings.lowVolumeMode === true) {
        setLowVolumeMode(true);
      }
      if (typeof settings.metricsEmit === 'boolean') {
        setMetricsEmit(settings.metricsEmit);
      }
      if (typeof settings.serverInvestigations === 'boolean') {
        setServerInvestigations(settings.serverInvestigations);
      }
    }
  } catch {
    // KV not available or empty — defaults already applied above.
  }
}

/**
 * Wire the alert → cell trigger: the webhook target + the alert-notify
 * notification binding. Delegates to the shared cellProvisioning module
 * (the same code the Settings UI uses) so CLI and UI stay identical.
 * Must run AFTER the search reconcile so alert_notify exists before its
 * notification binds. No-op when server investigations are off.
 * CELL_URL / CELL_WEBHOOK_BEARER come from the environment/.env.
 */
async function wireCellTrigger(
  http: HttpClient,
  flagExplicit: boolean,
  dryRun: boolean,
): Promise<void> {
  if (!getServerInvestigations()) return;
  if (dryRun) {
    console.log('▶ Cell trigger (dry-run): would ensure webhook target + alert notification');
    return;
  }
  const cellUrl = process.env.CELL_URL;
  const bearer = process.env.CELL_WEBHOOK_BEARER;
  if (cellUrl && bearer) {
    const t = await ensureCellWebhookTarget(http, { cellUrl, bearer });
    console.log(`▶ Notification target: ${t === 'created' ? '+ create' : '~ update'} ${CELL_WEBHOOK_TARGET_ID}`);
  } else if (flagExplicit) {
    // An explicit enable needs the target's config; a dangling target
    // ref would break the trigger. (When inferred-on, the target
    // already exists from a prior enable — don't hard-exit a routine run.)
    console.error(
      '✗ serverInvestigations is on but CELL_URL / CELL_WEBHOOK_BEARER are not set — ' +
        'set them in .env to provision the webhook target.',
    );
    process.exit(1);
  }
  // Bind alert_notify → target via the notifications resource (writing
  // it inline in the search body is silently dropped by the API).
  const n = await ensureAlertNotification(http);
  console.log(`▶ Alert notification: ${n === 'created' ? '+ create' : '~ update'} ${ALERT_NOTIFY_SEARCH_ID} → cell webhook`);

  // Push source repos to the cell so alert-fired (autonomous)
  // investigations get the code tools an interactive one carries.
  //
  // The CLI CANNOT read the repos the UI stores: the app-settings KV is
  // app-scoped and a machine token has no app context (GET
  // /kvstore/settings/app → 400 "App context required"). So the Settings
  // page is the source of truth (it pushes to the cell on Save), and the
  // CLI manages repos ONLY from an explicit CELL_REPOS_JSON env — the same
  // deterministic pattern as CELL_URL / the bearers. Absent that env, the
  // CLI never touches the cell's repo config (so a deploy can't wipe it).
  const uiBearer = process.env.CELL_UI_BEARER;
  const reposEnv = process.env.CELL_REPOS_JSON;
  if (!reposEnv) {
    console.log(
      '▶ Source repos: left to the UI (Settings → Source repositories → Save). ' +
        'Set CELL_REPOS_JSON to manage them from the CLI.',
    );
    return;
  }
  let repos: Array<{ url: string; name?: string; service?: string; ref?: string }> = [];
  try {
    const parsed = JSON.parse(reposEnv) as Array<Record<string, unknown>>;
    if (Array.isArray(parsed)) {
      repos = parsed
        .map((r) => ({
          url: typeof r.url === 'string' ? r.url.trim() : '',
          name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : undefined,
          service: typeof r.service === 'string' && r.service.trim() ? r.service.trim() : undefined,
          ref: typeof r.ref === 'string' && r.ref.trim() ? r.ref.trim() : undefined,
        }))
        .filter((r) => r.url);
    }
  } catch {
    console.error('✗ Source repos: CELL_REPOS_JSON is not valid JSON — leaving the cell config untouched.');
    return;
  }
  if (repos.length === 0) {
    console.log('▶ Source repos: CELL_REPOS_JSON has no valid repos — leaving the cell config untouched.');
  } else if (cellUrl && uiBearer) {
    const resp = await fetch(`${cellUrl.replace(/\/$/, '')}/config/repos`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${uiBearer}` },
      body: JSON.stringify({ repos }),
    });
    if (resp.ok) {
      console.log(`▶ Source repos → cell: ${repos.length} from CELL_REPOS_JSON for alert-fired runs`);
    } else {
      console.error(`✗ Source repos → cell failed (${resp.status}): ${(await resp.text()).slice(0, 160)}`);
    }
  } else {
    console.log('▶ Source repos: CELL_REPOS_JSON set but CELL_UI_BEARER missing — skipped push.');
  }
}

async function main(): Promise<void> {
  const env = loadDotEnv();
  for (const [k, v] of Object.entries(env)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  const baseUrl = process.env.CRIBL_BASE_URL;
  const clientId = process.env.CRIBL_CLIENT_ID;
  const clientSecret = process.env.CRIBL_CLIENT_SECRET;
  if (!baseUrl || !clientId || !clientSecret) {
    console.error(
      'CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET must be set.',
    );
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry');
  const firstInstall = process.argv.includes('--first-install');
  const http = await createNodeHttpClient({ baseUrl, clientId, clientSecret });

  await loadAppSettingsFromKV(http);

  // The `serverInvestigations` flag lives in APP-SCOPED KV, which this
  // CLI (a machine token on the unscoped path) can't read — so the
  // browser "Reconcile" sees it but `npm run provision` wouldn't.
  //
  // Explicit env wins: SERVER_INVESTIGATIONS=true provisions the trigger
  // search + webhook target; `false` forces it off (deletes them).
  //
  // When UNSET, do NOT default OFF — that would delete the flag-gated
  // `criblapm__alert_notify` search out from under a UI that has the
  // feature ON, and every routine `npm run deploy` would fight the user's
  // setting (the source of the "searches not provisioned" banner flapping).
  // Instead, infer the flag from the server's current state so an unset
  // deploy neither creates nor deletes it.
  const envFlag = process.env.SERVER_INVESTIGATIONS;
  const flagExplicit = envFlag === 'true' || envFlag === 'false';
  if (envFlag === 'true') setServerInvestigations(true);
  else if (envFlag === 'false') setServerInvestigations(false);
  else {
    const current = await listProvisioned(http, CRIBLAPM_PREFIX);
    const hasNotify = current.some((s) => s.id === `${CRIBLAPM_PREFIX}alert_notify`);
    setServerInvestigations(hasNotify);
    if (hasNotify) {
      console.log(
        '▶ serverInvestigations: inferred ON — preserving existing alert-notify search ' +
          '(set SERVER_INVESTIGATIONS=false to remove it)',
      );
    }
  }

  // P0.1 tripwire: refuse to push a corrupt plan to the server. The
  // June 2026 outage chain (dataset="" in 17 searches, unjoinable
  // lookup CSVs) shipped through a reconcile that reported success.
  const guardErrors = validateProvisionPlan([
    ...getProvisioningPlan().map((s) => ({ id: s.id, query: s.query, name: s.name })),
    ...SEED_LOOKUPS.map((l) => ({ id: `seed:${l.name}`, query: l.seedQuery })),
  ]);
  if (guardErrors.length > 0) {
    console.error(`✗ Provision guard: ${guardErrors.length} violation(s) — refusing to reconcile`);
    for (const e of guardErrors) console.error(`    ${e}`);
    process.exit(1);
  }
  console.log('▶ Provision guard: plan OK');

  if (dryRun) {
    const { actions } = await planOnly(http);
    if (actions.length === 0) {
      console.log('▶ Provision: nothing to do (all searches up to date)');
    } else {
      console.log(`▶ Provision dry-run: ${actions.length} action(s)`);
      for (const a of actions) console.log(actionLabel(a));
    }
    await wireCellTrigger(http, flagExplicit, true);
    // Dataset acceleration dry-run
    const status = await getDatasetStatus(http);
    console.log('▶ Dataset acceleration:');
    console.log(`   ruleset: ${status.ruleset.ok ? 'configured' : 'NOT configured'}`);
    console.log(
      `   acceleratedFields: ${status.acceleratedFields.ok ? 'all present' : `missing ${status.acceleratedFields.missing.join(', ')}`}`,
    );
    return;
  }

  const { actions, results } = await reconcile(http);
  if (actions.length === 0) {
    console.log('▶ Provision: nothing to do (all searches up to date)');
  } else {
    console.log(`▶ Provision: ${actions.length} action(s)`);
    for (let i = 0; i < actions.length; i++) {
      const r = results[i];
      const ok = r.ok ? '✓' : '✗';
      console.log(`${ok}${actionLabel(actions[i])}`);
      if (!r.ok) console.log(`    error: ${r.error}`);
    }
    const failed = results.filter((r) => !r.ok).length;
    if (failed > 0) {
      console.error(`▶ Provision: ${failed} action(s) failed`);
      process.exit(1);
    }
  }

  // Wire (or tear down) the alert → cell trigger, AFTER the search
  // reconcile so alert_notify exists before its notification binds.
  if (getServerInvestigations()) {
    await wireCellTrigger(http, flagExplicit, false);
  } else if (flagExplicit) {
    // Explicit disable: remove the notification binding (the search
    // itself is removed by the reconcile above).
    await removeAlertNotification(http);
    console.log(`▶ Alert notification: removed (server investigations off)`);
  }

  // Reconcile dataset acceleration (ruleset + acceleratedFields).
  // Independent of saved-search reconcile — runs even when the
  // search reconcile was all noops.
  const dsResult = await applyDatasetProvisioning(http);
  const rulesetIcon =
    dsResult.ruleset.action === 'noop'
      ? '·'
      : dsResult.ruleset.action === 'create'
      ? '+'
      : '~';
  const fieldsIcon =
    dsResult.acceleratedFields.action === 'noop'
      ? '·'
      : dsResult.acceleratedFields.action === 'create'
      ? '+'
      : '~';
  console.log('▶ Dataset acceleration:');
  console.log(`✓  ${rulesetIcon} ${dsResult.ruleset.action.padEnd(6)} dataset-ruleset.opentelemetry_demo`);
  console.log(
    `✓  ${fieldsIcon} ${dsResult.acceleratedFields.action.padEnd(6)} dataset.acceleratedFields${dsResult.acceleratedFields.added.length > 0 ? ` (added: ${dsResult.acceleratedFields.added.join(', ')})` : ''}`,
  );

  // P0.2 post-reconcile canary: verify a sentinel saved search
  // produces $vt_results rows and a workspace lookup is still
  // joinable. Catches the runtime equivalents of what the P0.1
  // guard catches statically (dataset="" wipeouts, unjoinable
  // lookup CSVs from the June (?i)-export bug).
  console.log('▶ Post-reconcile canary …');
  const canary = await runCanary(http, { firstInstall });
  const tickFor = (ok: boolean) => (ok ? '✓' : '✗');
  console.log(`${tickFor(canary.sentinel.ok)}   sentinel:    ${canary.sentinel.message}`);
  console.log(`${tickFor(canary.lookupJoin.ok)}   lookup-join: ${canary.lookupJoin.message}`);
  console.log(`${tickFor(canary.eventContract.ok)}   event-contract: ${canary.eventContract.message}`);
  if (!canary.ok) {
    const offlineDatagenWaiver = process.env.APM_ALLOW_OFFLINE_DATAGEN === 'true';
    const dataChecksOnly = !canary.sentinel.ok || !canary.lookupJoin.ok;
    const waiverValid = offlineDatagenWaiver
      && Date.now() <= OFFLINE_DATAGEN_WAIVER_EXPIRES
      && dataChecksOnly
      && canary.eventContract.ok;

    if (waiverValid) {
      console.warn(
        '⚠ Telemetry-dependent canary failures temporarily waived: datagen is offline. ' +
        'Waiver expires 2026-08-31T23:59:59Z.',
      );
    } else {
      if (offlineDatagenWaiver && Date.now() > OFFLINE_DATAGEN_WAIVER_EXPIRES) {
        console.error('▶ Offline-datagen canary waiver expired 2026-08-31T23:59:59Z.');
      }
      console.error('▶ Canary FAILED — reconcile applied but workspace is unhealthy.');
      process.exit(1);
    }
  }

  await maybeBackfillMetrics();
}

/**
 * Backfill the metrics store from raw spans so panels work across all
 * time ranges immediately, not just from emitter-start forward. Runs only
 * when metric emitters are provisioned (metricsEmit on).
 *
 * v2 (shared core, src/api/metricsBackfill.ts — same as the Settings UI):
 * per-metric idempotency (each family probes its own coverage and backfills
 * only its uncovered gap, so adding a NEW metric backfills ONLY that one),
 * newest→oldest, sampled histograms + big counter windows, zero-drop. See
 * docs/sessions/backfill-v2-design.md.
 */
async function maybeBackfillMetrics(): Promise<void> {
  if (!getMetricsEmit()) return;
  const horizonSec = Number(process.env.METRICS_BACKFILL_HORIZON_SEC ?? 86_400); // 24h default
  const nowSec = Math.floor(Date.now() / 1000);

  console.log(`▶ Metrics backfill (horizon ${Math.round(horizonSec / 3600)}h, per-metric idempotent, reverse) …`);
  const deps = await makeNodeBackfillDeps((m) => console.log(m));
  const res = await runMetricsBackfill(deps, getMetricEmitters(), { horizonSec, nowSec });

  for (const e of res.emitters) {
    if (e.skipped) {
      console.log(`✓  · ${e.id}: already covered`);
    } else {
      const cov = e.windowsCovered ? `, ${e.windowsCovered} window(s) already covered` : '';
      const drop = e.totalDropped ? `, ${e.totalDropped} DROPPED` : '';
      console.log(`✓  ~ ${e.id}: ${e.exportsRun} exports, ${e.totalOut} out${cov}${drop}`);
    }
  }
  const icon = res.totalDropped === 0 ? '✓' : '✗';
  console.log(`${icon}  backfill: ${res.exportsRun} exports total, ${res.totalOut} events out, ${res.totalDropped} dropped`);
  if (res.totalDropped > 0) {
    console.error('▶ Backfill had dropped events in dense minutes — history is incomplete for those.');
  }
}

main().catch((err) => {
  console.error('Provision failed:', err.message);
  process.exit(1);
});
