// Service Detail load-budget guard.
//
// Service Detail once fired ~45 live KQL search jobs on a single load
// (~15s to settle) because two below-the-fold sections fetched eagerly:
//   - Spotlight ran ~27 attribute span-scans on mount, AND its queries
//     were aborted by the page's nav-generation controller (child effects
//     run before the parent's fetch) — so it was both slow and broken.
//   - The runtime/container metric cards fired ~20 OTel-lakehouse probes
//     (one per metric row) on mount. Those metrics aren't in the fast
//     PromQL store, so they can't move to metrics — they must stay lazy.
//
// Fix: both sections are now lazy (fetch on scroll-into-view), Spotlight
// owns its abort scope + uses a curated attribute subset, and the page's
// heavy KQL panels are deferred until the fast metric summary lands.
// This spec asserts the initial (pre-scroll) KQL job count stays bounded.

import { test, expect } from '@playwright/test';
import { installCriblHostGlobals, gotoApm, apmFrame, dismissHostAnnouncements } from './helpers/apmSession';

test('Service Detail initial load stays within a KQL job budget', async ({ page }) => {
  test.setTimeout(120_000);

  let started = 0, finished = 0, jobPosts = 0;
  const isApi = (u: string) => /\/api\/v1\/|\/m\/default_search\/|\/search\//.test(u);
  page.on('request', (r) => {
    if (!isApi(r.url())) return;
    started++;
    if (r.method() === 'POST' && /\/jobs$/.test(r.url())) jobPosts++;
  });
  page.on('requestfinished', (r) => { if (isApi(r.url())) finished++; });
  page.on('requestfailed', (r) => { if (isApi(r.url())) finished++; });
  const pending = () => started - finished;

  await installCriblHostGlobals(page);
  await gotoApm(page, '/?range=-15m');
  const apm = apmFrame(page);
  await dismissHostAnnouncements(page);

  await apm.getByText('Services', { exact: true }).first().click();
  await apm.getByText(/^Services \(\d+\)/).first().waitFor({ state: 'visible', timeout: 60_000 });

  // Open the first service. Time-to-first-content should be metric-fast.
  const t0 = Date.now();
  const jobsBefore = jobPosts;
  await apm.locator('table tbody tr a, table tbody tr [role="link"]').first().click().catch(async () => {
    await apm.locator('table tbody tr td').first().click();
  });
  const firstContentMs = await apm.getByText(/^Top operations/).first()
    .waitFor({ state: 'visible', timeout: 60_000 }).then(() => Date.now() - t0).catch(() => -1);

  // Let the initial (pre-scroll) fan-out settle: pending <=2 for 800ms.
  const cap = Date.now() + 30_000;
  let quiet = 0;
  while (Date.now() < cap) {
    await page.waitForTimeout(200);
    if (pending() <= 2) { if (!quiet) quiet = Date.now(); else if (Date.now() - quiet > 800) break; }
    else quiet = 0;
  }
  const initialJobs = jobPosts - jobsBefore;

  console.log(`Service Detail: firstContentMs=${firstContentMs} initialKqlJobs=${initialJobs}`);

  // First content comes from the fast metric store — must be quick.
  expect(firstContentMs, 'first content is metric-backed').toBeLessThan(3000);
  // Below-the-fold Spotlight (~9-27 jobs) and metric cards (~20 jobs) must
  // NOT fire until scrolled into view. Budget covers the legitimately-KQL
  // panels (status mix, error traces, instances, uptime, alerts, catalog,
  // feature-detect) with headroom; a regression that re-eager-loads either
  // deferred section blows past it.
  expect(initialJobs, 'initial KQL job count is bounded (no eager Spotlight/cards)').toBeLessThan(16);
});
