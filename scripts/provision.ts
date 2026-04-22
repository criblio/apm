#!/usr/bin/env tsx
/**
 * Reconcile scheduled searches against the provisioning plan.
 *
 * Imports the same reconcile() + HttpClient interface the Settings
 * UI uses, but wires it to a Node fetch + Bearer token instead of
 * the browser's cookie-authenticated fetch proxy. This lets
 * `npm run deploy` call `npm run provision` automatically after
 * pack install, and it can also be run standalone.
 *
 * Usage:
 *   npx tsx scripts/provision.ts          # reconcile (create/update/delete)
 *   npx tsx scripts/provision.ts --dry    # show plan without applying
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  reconcile,
  planOnly,
  type HttpClient,
  type PlanAction,
} from '../src/api/provisioner.js';
import { setSearchCadence } from '../src/api/searchCadence.js';

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

async function getToken(
  baseUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const isStaging = /cribl-staging\.cloud/.test(baseUrl);
  const tokenUrl = isStaging
    ? 'https://login.cribl-staging.cloud/oauth/token'
    : 'https://login.cribl.cloud/oauth/token';
  const audience = isStaging
    ? 'https://api.cribl-staging.cloud'
    : 'https://api.cribl.cloud';
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      audience,
    }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

function makeHttpClient(baseUrl: string, token: string): HttpClient {
  const apiBase = baseUrl.replace(/\/$/, '') + '/api/v1';
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };

  async function request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const url = `${apiBase}${path}`;
    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`${method} ${path} failed (${resp.status}): ${text}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
  };
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
    // KV not available or empty — use default cadence
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
  const token = await getToken(baseUrl, clientId, clientSecret);
  const http = makeHttpClient(baseUrl, token);

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
