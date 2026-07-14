#!/usr/bin/env node
//
// Validate and deploy an exact app artifact to Cribl Cloud.
//
// Reads CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET from the
// project root .env (the same file the Cribl MCP server uses) and:
//
//   1. Uses --artifact as-is, or verifies and builds once when omitted
//   2. Inspects the tgz locally and runs the server preinstall policy check
//   3. Exchanges the client credentials for a Cribl Cloud bearer token
//   4. Installs a missing app or upgrades the exact existing app without force
//   5. Reconciles scheduled searches and runs post-reconcile canaries
//
// Run from the repo root: `npm run deploy`

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectPack } from './inspect-pack.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
// After the flatten PR the app IS the repo root — there's no enclosing
// monorepo directory anymore.
const REPO_ROOT = APP_ROOT;

/**
 * Cribl Cloud has two environments — production and staging — with separate
 * OAuth domains. Pick the right one from the workspace URL the user provided.
 */
function oauthEndpoints(baseUrl) {
  const isStaging = /cribl-staging\.cloud/.test(baseUrl);
  return isStaging
    ? {
        tokenUrl: 'https://login.cribl-staging.cloud/oauth/token',
        audience: 'https://api.cribl-staging.cloud',
      }
    : {
        tokenUrl: 'https://login.cribl.cloud/oauth/token',
        audience: 'https://api.cribl.cloud',
      };
}

/** Parse a dotenv-style file and return a key→value map. */
async function loadDotEnv(path) {
  const text = await readFile(path, 'utf8');
  const env = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function runCommand(cmd, args, cwd) {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.once('error', rejectFn);
    child.once('close', (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

async function getBearerToken({ tokenUrl, audience, clientId, clientSecret }) {
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
  if (!resp.ok) {
    throw new Error(`OAuth token exchange failed (${resp.status}): ${await resp.text()}`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`OAuth response missing access_token: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

async function uploadPack({ baseUrl, token, filename, body }) {
  const url = `${baseUrl}/api/v1/apps?filename=${encodeURIComponent(filename)}`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
      accept: 'application/json',
    },
    body,
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Upload failed (${resp.status}): ${text}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Upload response was not JSON: ${text.slice(0, 200)}`);
  }
  // Source can live at top level or inside items[0]
  const source = parsed.source ?? parsed.items?.[0]?.source ?? parsed.id ?? parsed.items?.[0]?.id;
  if (!source) {
    throw new Error(`Upload response missing source/id field: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  return { source, raw: parsed };
}

async function apiJson({ baseUrl, token, path, method = 'GET', body }) {
  const resp = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`${method} ${path} failed (${resp.status}): ${text.slice(0, 500)}`);
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${method} ${path} returned non-JSON: ${text.slice(0, 200)}`);
  }
}

async function preinstallCheck({ baseUrl, token, source }) {
  const result = await apiJson({
    baseUrl,
    token,
    path: '/apps/preinstall-check',
    method: 'POST',
    body: { source },
  });
  const item = result.items?.[0] ?? result;
  const dangerous = item.dangerousFileTypes ?? item.dangerousFiles ?? [];
  const proxies = item.proxies ?? {};
  const policies = item.policies ?? {};
  if ((Array.isArray(dangerous) && dangerous.length > 0) || Object.keys(proxies).length > 0) {
    throw new Error(
      `Preinstall check rejected candidate: dangerous=${JSON.stringify(dangerous)}, proxies=${JSON.stringify(proxies)}`,
    );
  }
  if (policies && Object.keys(policies).length > 0) {
    throw new Error(`Preinstall check found undeclared policies: ${JSON.stringify(policies)}`);
  }
}

async function findInstalledApp({ baseUrl, token, appId }) {
  const result = await apiJson({ baseUrl, token, path: '/apps' });
  return (result.items ?? []).find((item) => item.id === appId || item.name === appId) ?? null;
}

async function installPack({ baseUrl, token, source, displayName, version, appId }) {
  const installed = await findInstalledApp({ baseUrl, token, appId });
  if (installed) {
    // CI, master, and a retried tag may validate the same release candidate in
    // the shared workspace. Cribl correctly rejects a same-version PATCH; the
    // package was already installed by the first serialized validation run, so
    // make those later runs idempotent and continue through reconcile/canaries.
    if (installed.version === version) {
      console.log(`▶ ${appId} ${version} is already installed; skipping same-version upgrade`);
      return { items: [installed], count: 1, unchanged: true };
    }
    return apiJson({
      baseUrl,
      token,
      path: `/apps/${encodeURIComponent(appId)}`,
      method: 'PATCH',
      body: { source, displayName, version },
    });
  }
  return apiJson({
    baseUrl,
    token,
    path: '/apps',
    method: 'POST',
    body: { source, displayName, version },
  });
}

async function main() {
  const fileEnv = await loadDotEnv(join(REPO_ROOT, '.env')).catch(() => ({}));
  const env = { ...fileEnv, ...process.env };
  for (const v of ['CRIBL_BASE_URL', 'CRIBL_CLIENT_ID', 'CRIBL_CLIENT_SECRET']) {
    if (!env[v]) throw new Error(`${v} is not set in ${join(REPO_ROOT, '.env')}`);
  }
  const baseUrl = env.CRIBL_BASE_URL.replace(/\/$/, '');
  const { tokenUrl, audience } = oauthEndpoints(baseUrl);

  const pkg = JSON.parse(await readFile(join(APP_ROOT, 'package.json'), 'utf8'));
  const artifactIndex = process.argv.indexOf('--artifact');
  const artifactArg = artifactIndex >= 0 ? process.argv[artifactIndex + 1] : undefined;
  let tgzPath;
  if (artifactArg) {
    tgzPath = resolve(APP_ROOT, artifactArg);
    console.log(`▶ Using prebuilt candidate ${tgzPath}`);
  } else {
    console.log('▶ Verifying, building, and packaging…');
    await runCommand('npm', ['run', 'verify'], APP_ROOT);
    await runCommand('npm', ['run', 'package'], APP_ROOT);
    tgzPath = join(APP_ROOT, 'build', `${pkg.name}-${pkg.version}.tgz`);
  }
  await inspectPack(tgzPath);
  const filename = tgzPath.split('/').pop();
  const body = await readFile(tgzPath);
  console.log(`▶ Read ${filename} (${body.length} bytes)`);

  console.log(`▶ Exchanging client credentials for bearer token at ${tokenUrl} …`);
  const token = await getBearerToken({
    tokenUrl,
    audience,
    clientId: env.CRIBL_CLIENT_ID,
    clientSecret: env.CRIBL_CLIENT_SECRET,
  });

  console.log(`▶ Uploading to ${baseUrl} …`);
  const { source } = await uploadPack({ baseUrl, token, filename, body });
  console.log(`▶ Upload OK — source: ${source}`);

  console.log('▶ Running server-side preinstall policy check …');
  await preinstallCheck({ baseUrl, token, source });
  console.log('▶ Preinstall policy check OK');

  console.log('▶ Installing or upgrading exact candidate …');
  const installResp = await installPack({
    baseUrl,
    token,
    source,
    displayName: pkg.displayName,
    version: pkg.version,
    appId: pkg.name,
  });
  console.log('▶ Install OK');
  console.log(JSON.stringify(installResp, null, 2));

  console.log('▶ Reconciling scheduled searches …');
  await runCommand('npx', ['tsx', 'scripts/provision.ts'], APP_ROOT);
}

main().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
