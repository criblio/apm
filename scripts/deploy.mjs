#!/usr/bin/env node
//
// Build, package, and deploy the app to Cribl Cloud in one shot.
//
// Reads CRIBL_BASE_URL / CRIBL_CLIENT_ID / CRIBL_CLIENT_SECRET from the
// project root .env (the same file the Cribl MCP server uses) and:
//
//   1. Runs `npm run package` to build a fresh tgz
//   2. Exchanges the client credentials for a Cribl Cloud bearer token
//   3. PUT /api/v1/packs?filename=… (raw tgz body) → upload, returns source
//   4. POST /api/v1/packs { source, force: true } → install / replace
//
// Endpoint references: criblio/cribl-control-plane-sdk-typescript
//   src/funcs/packsUpload.ts (PUT /packs)
//   src/funcs/packsInstall.ts (POST /packs)
//
// Run from the repo root: `npm run deploy`

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const REPO_ROOT = resolve(APP_ROOT, '..');

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
  const url = `${baseUrl}/api/v1/packs?filename=${encodeURIComponent(filename)}`;
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

async function installPack({ baseUrl, token, source, displayName, version }) {
  const url = `${baseUrl}/api/v1/packs`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ source, force: true, displayName, version }),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`Install failed (${resp.status}): ${text}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return parsed;
}

async function main() {
  const env = await loadDotEnv(join(REPO_ROOT, '.env')).catch((err) => {
    throw new Error(`Failed to read ${join(REPO_ROOT, '.env')}: ${err.message}`);
  });
  for (const v of ['CRIBL_BASE_URL', 'CRIBL_CLIENT_ID', 'CRIBL_CLIENT_SECRET']) {
    if (!env[v]) throw new Error(`${v} is not set in ${join(REPO_ROOT, '.env')}`);
  }
  const baseUrl = env.CRIBL_BASE_URL.replace(/\/$/, '');
  const { tokenUrl, audience } = oauthEndpoints(baseUrl);

  console.log('▶ Building & packaging…');
  await runCommand('npm', ['run', 'package'], APP_ROOT);

  // Locate the freshly-built tgz from package.json {name,version}
  const pkg = JSON.parse(await readFile(join(APP_ROOT, 'package.json'), 'utf8'));
  const filename = `${pkg.name}-${pkg.version}.tgz`;
  const tgzPath = join(APP_ROOT, 'build', filename);
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

  console.log('▶ Installing pack (force=true) …');
  const installResp = await installPack({
    baseUrl,
    token,
    source,
    displayName: pkg.displayName,
    version: pkg.version,
  });
  console.log('▶ Install OK');
  console.log(JSON.stringify(installResp, null, 2));
}

main().catch((err) => {
  console.error('✖', err.message);
  process.exit(1);
});
