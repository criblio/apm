// Nav-escalation regression guard.
//
// Boots the APM app ONCE, then drives the in-app sidebar (React Router
// SPA nav, no reload) through a sequence that repeatedly returns to the
// heaviest page (Services), measuring time-to-content on each transition.
//
// Why a dedicated spec: baseline-ui-timing does a fresh `gotoApm` per
// page, resetting the iframe JS context each time — so it cannot catch
// regressions that only appear when navs ACCUMULATE state in one context.
// Two such regressions shipped and were caught here:
//   0.13.4 — a cancelled metrics read fell back to a live (uncancellable)
//            KQL span scan, so each nav spawned ~20 jobs that piled up.
//   0.13.5 — cancelling idempotent metrics GETs and re-firing them next
//            visit piled abandoned-but-still-running histogram_quantile
//            computations onto the metrics engine (server-side backlog).
// Both showed the same signature: Services nav latency climbing across
// repeat visits (1.1s → 4.5s) while client-side pending requests stayed
// flat. The fix (0.13.6) dedupes + briefly caches metrics reads instead
// of cancelling them; this spec asserts the climb does not return.
//
// Run: npx playwright test tests/nav-escalation.spec.ts --project=chromium

import { test, expect } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { FrameLocator, Page } from '@playwright/test';
import { installCriblHostGlobals, gotoApm, apmFrame, dismissHostAnnouncements } from './helpers/apmSession';

const OUT_DIR = 'test-results';
const OUT = `${OUT_DIR}/nav-escalation.json`;
const STEP_TIMEOUT_MS = 60_000;

interface Step { label: string; navText: string; marker: (apm: FrameLocator) => Promise<unknown>; }

const markers = {
  services: (apm: FrameLocator) => apm.getByText(/^Services \(\d+\)/).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }),
  map: (apm: FrameLocator) => apm.locator('svg').first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }),
  overview: (apm: FrameLocator) => apm.getByText(/detected issues/i).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS }),
};

const sequence: Step[] = [
  { label: 'Services #1', navText: 'Services', marker: markers.services },
  { label: 'Service Map', navText: 'Service Map', marker: markers.map },
  { label: 'Services #2', navText: 'Services', marker: markers.services },
  { label: 'Overview', navText: 'Overview', marker: markers.overview },
  { label: 'Services #3', navText: 'Services', marker: markers.services },
  { label: 'Service Map #2', navText: 'Service Map', marker: markers.map },
  { label: 'Services #4', navText: 'Services', marker: markers.services },
  { label: 'Overview #2', navText: 'Overview', marker: markers.overview },
  { label: 'Services #5', navText: 'Services', marker: markers.services },
];

async function clickNav(page: Page, apm: FrameLocator, navText: string): Promise<void> {
  await dismissHostAnnouncements(page);
  // Sidebar items are the first occurrences of the label in DOM order
  // (AppShell renders Sidebar before <main>). Exact match on the label.
  await apm.getByText(navText, { exact: true }).first().click({ timeout: STEP_TIMEOUT_MS });
}

test('Services SPA nav does not escalate across repeat visits', async ({ page }) => {
  test.setTimeout(sequence.length * STEP_TIMEOUT_MS + 120_000);

  // Diagnostic: track in-flight API request depth. A healthy run keeps
  // this bounded; an accumulation regression makes it climb.
  let started = 0, finished = 0, peakPending = 0;
  const isApi = (u: string) => /\/api\/v1\/|\/m\/default_search\/|\/search\//.test(u);
  page.on('request', (r) => { if (isApi(r.url())) { started++; peakPending = Math.max(peakPending, started - finished); } });
  page.on('requestfinished', (r) => { if (isApi(r.url())) finished++; });
  page.on('requestfailed', (r) => { if (isApi(r.url())) finished++; });

  await installCriblHostGlobals(page);
  await gotoApm(page, '/?range=-15m');
  const apm = apmFrame(page);
  await markers.overview(apm).catch(() => {});

  const results: Array<{ label: string; ms: number; ok: boolean; pending: number; err?: string }> = [];
  for (const step of sequence) {
    const t0 = Date.now();
    let ok = false;
    let err: string | undefined;
    try {
      await clickNav(page, apm, step.navText);
      await step.marker(apm);
      ok = true;
    } catch (e) {
      err = e instanceof Error ? e.message.split('\n')[0] : String(e);
    }
    const ms = Date.now() - t0;
    results.push({ label: step.label, ms, ok, pending: started - finished, err });
    console.log(`STEP ${step.label.padEnd(16)} ${ok ? 'OK ' : 'ERR'} ${String(ms).padStart(5)}ms  pending=${started - finished} peak=${peakPending}${err ? '  ' + err : ''}`);
  }
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify(results, null, 2));

  const svc = results.filter((r) => r.label.startsWith('Services') && r.ok).map((r) => r.ms);
  console.log('Services nav ms:', svc.join(', '), ' peakPending:', peakPending);
  expect(svc.length, 'at least 4 Services navs succeeded').toBeGreaterThanOrEqual(4);
  const first = svc[0];
  const last = svc[svc.length - 1];
  // Escalation guard. Fixed builds hold Services flat at ~200ms; the
  // pre-fix builds climbed to 4.5s. Allow generous headroom for staging
  // noise while still catching a real climb.
  expect(last, `last Services nav (${last}ms) must not blow past first (${first}ms)`).toBeLessThan(Math.max(first * 2.5, 2500));
});
