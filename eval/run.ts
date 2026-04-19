#!/usr/bin/env tsx
/**
 * Eval harness CLI — run via `npm run eval`.
 *
 * Usage:
 *   npm run eval                            # full scenario matrix
 *   npm run eval -- --scenario paymentFailure  # single scenario
 *   npm run eval -- --no-investigator       # skip Investigator step
 *
 * Requires the same .env vars as the Playwright tests:
 *   CRIBL_BASE_URL, CRIBL_CLIENT_ID, CRIBL_CLIENT_SECRET,
 *   CRIBL_TEST_EMAIL, CRIBL_TEST_PASSWORD, FLAGD_UI_URL
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { runScenario } from './engine.js';
import { printReport } from './report.js';
import type { ScenarioDeclaration, RunResult } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── Load .env ──────────────────────────────────────────────

function loadDotEnv(): void {
  let text: string;
  try {
    text = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

// ── Auth ───────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const baseUrl = process.env.CRIBL_BASE_URL!;
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
      client_id: process.env.CRIBL_CLIENT_ID,
      client_secret: process.env.CRIBL_CLIENT_SECRET,
      audience,
    }),
  });
  if (!resp.ok) throw new Error(`Token exchange failed: ${resp.status}`);
  const data = (await resp.json()) as { access_token: string };
  return data.access_token;
}

// ── Load scenarios ─────────────────────────────────────────

async function loadScenarios(
  filter?: string,
): Promise<ScenarioDeclaration[]> {
  const dir = resolve(__dirname, 'scenarios');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const all: ScenarioDeclaration[] = [];
  for (const file of files) {
    const mod = (await import(`./scenarios/${file}`)) as {
      default: ScenarioDeclaration;
    };
    all.push(mod.default);
  }
  if (filter) {
    const found = all.filter((s) => s.name === filter);
    if (found.length === 0) {
      console.error(
        `Scenario "${filter}" not found. Available: ${all.map((s) => s.name).join(', ')}`,
      );
      process.exit(1);
    }
    return found;
  }
  return all;
}

// ── Main ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const scenarioFilter = args.includes('--scenario')
    ? args[args.indexOf('--scenario') + 1]
    : undefined;
  const skipInvestigator = args.includes('--no-investigator');

  // Validate env
  for (const key of [
    'CRIBL_BASE_URL',
    'CRIBL_CLIENT_ID',
    'CRIBL_CLIENT_SECRET',
    'FLAGD_UI_URL',
  ]) {
    if (!process.env[key]) {
      console.error(`${key} not set — check .env`);
      process.exit(1);
    }
  }

  const baseUrl = process.env.CRIBL_BASE_URL!.replace(/\/$/, '');
  const apiUrl = baseUrl + '/api/v1';
  const appPath = '/app-ui/apm';

  const scenarios = await loadScenarios(scenarioFilter);
  console.log(
    `\nEval harness: ${scenarios.length} scenario(s)${skipInvestigator ? ' (no Investigator)' : ''}\n`,
  );

  // Git info
  let commitSha = 'unknown';
  let packVersion = 'unknown';
  try {
    commitSha = execSync('git rev-parse --short HEAD', { cwd: REPO_ROOT })
      .toString()
      .trim();
  } catch { /* */ }
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
    ) as { version?: string };
    packVersion = pkg.version ?? 'unknown';
  } catch { /* */ }

  const token = await getToken();

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    storageState: resolve(
      REPO_ROOT,
      'playwright/.auth/cribl-cloud.json',
    ),
  });
  await context.addInitScript(
    ([bp, api, tok]) => {
      (window as Record<string, unknown>).CRIBL_BASE_PATH = bp;
      (window as Record<string, unknown>).CRIBL_API_URL = api;
      const origFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
        const isApi = url.startsWith(api) || url.startsWith('/api/v1/');
        if (!isApi) return origFetch(input, init);
        const next: RequestInit = { ...(init ?? {}) };
        const h = new Headers(next.headers ?? {});
        if (!h.has('authorization')) h.set('authorization', `Bearer ${tok}`);
        next.headers = h;
        return origFetch(input, next);
      }) as typeof window.fetch;
    },
    [appPath, apiUrl, token],
  );

  const gotoApm = async (page: import('playwright-core').Page, inAppPath: string) => {
    const trimmed = inAppPath.replace(/^\//, '');
    const target = appPath.replace(/\/$/, '') + '/' + trimmed;
    await page.goto(baseUrl + target, { waitUntil: 'domcontentloaded' });
  };

  const runStart = Date.now();
  const results: import('./types.js').ScenarioResult[] = [];

  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    console.log(
      `\n[${i + 1}/${scenarios.length}] ${scenario.name}`,
    );
    const page = await context.newPage();
    try {
      const result = await runScenario(scenario, page, gotoApm, {
        skipInvestigator,
      });
      results.push(result);
    } catch (err) {
      console.error(`  FATAL: ${err}`);
      results.push({
        name: scenario.name,
        surfaces: [],
        score: 0,
        durationMs: 0,
      });
    } finally {
      await page.close();
    }
  }

  await browser.close();

  const meanScore =
    results.length > 0
      ? results.reduce((sum, r) => sum + r.score, 0) / results.length
      : 0;

  const runResult: RunResult = {
    runId: new Date().toISOString(),
    commitSha,
    packVersion,
    scenarios: results,
    meanScore: Math.round(meanScore * 100) / 100,
    durationMs: Date.now() - runStart,
  };

  printReport(runResult);
}

main().catch((err) => {
  console.error('Eval harness failed:', err);
  process.exit(1);
});
