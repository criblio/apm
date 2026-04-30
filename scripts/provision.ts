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
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNodeHttpClient,
  type HttpClient,
  type PlanAction,
} from '@cribl/app-utils/provisioner';
import { reconcile, planOnly } from '../src/api/provisioner.js';
import { setSearchCadence } from '@cribl/app-utils/cadence';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

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

async function loadCadenceFromKV(http: HttpClient): Promise<void> {
  try {
    const raw = await http.get('/kvstore/settings/app');
    if (raw && typeof raw === 'object') {
      const settings = raw as Record<string, unknown>;
      if (settings.searchCadence && typeof settings.searchCadence === 'string') {
        setSearchCadence(settings.searchCadence);
      }
    }
  } catch {
    // KV not available or empty — use default cadence.
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
  const http = await createNodeHttpClient({ baseUrl, clientId, clientSecret });

  await loadCadenceFromKV(http);

  if (dryRun) {
    const { actions } = await planOnly(http);
    if (actions.length === 0) {
      console.log('▶ Provision: nothing to do (all searches up to date)');
    } else {
      console.log(`▶ Provision dry-run: ${actions.length} action(s)`);
      for (const a of actions) console.log(actionLabel(a));
    }
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
}

main().catch((err) => {
  console.error('Provision failed:', err.message);
  process.exit(1);
});
