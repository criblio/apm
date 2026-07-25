// Cross-page load-budget guard.
//
// Every page should render primary content fast and keep the number of
// live-KQL search jobs it fires on initial load bounded — heavy or
// below-the-fold work (facet/Spotlight rails, metric cards, alert history,
// dropdown catalogs) is deferred behind primary content or lazy-loaded on
// scroll. This spec SPA-navigates to each page in ONE context and asserts a
// per-page KQL-job budget so an eager-fetch regression (e.g. the Traces
// facet rail firing its ~24-job fan-out on load again) fails CI.

import { test, expect } from '@playwright/test';
import type { FrameLocator } from '@playwright/test';
import { installCriblHostGlobals, gotoApm, apmFrame, dismissHostAnnouncements } from './helpers/apmSession';

interface PageDef { nav: string; budget: number; marker: (a: FrameLocator) => Promise<unknown> }

const TIMEOUT = 40_000;
const pages: PageDef[] = [
  { nav: 'Overview', budget: 6, marker: (a) => a.getByText(/detected issues/i).first().waitFor({ state: 'visible', timeout: TIMEOUT }) },
  { nav: 'Traces', budget: 8, marker: (a) => a.getByText(/^Search$/).first().waitFor({ state: 'visible', timeout: TIMEOUT }) },
  { nav: 'Alerts', budget: 6, marker: (a) => a.getByRole('heading', { name: /alert/i }).first().waitFor({ state: 'visible', timeout: TIMEOUT }) },
  { nav: 'Logs', budget: 6, marker: (a) => a.getByRole('heading', { name: /log/i }).first().waitFor({ state: 'visible', timeout: TIMEOUT }) },
  { nav: 'Errors', budget: 6, marker: (a) => a.locator('table tbody tr, [class*=empty]').first().waitFor({ state: 'visible', timeout: TIMEOUT }) },
];

test('every page stays within its initial KQL-job budget', async ({ page }) => {
  test.setTimeout(300_000);
  let started = 0, finished = 0, jobPosts = 0;
  const isApi = (u: string) => /\/api\/v1\/|\/m\/default_search\/|\/search\//.test(u);
  page.on('request', (r) => { if (isApi(r.url())) { started++; if (r.method() === 'POST' && /\/jobs$/.test(r.url())) jobPosts++; } });
  page.on('requestfinished', (r) => { if (isApi(r.url())) finished++; });
  page.on('requestfailed', (r) => { if (isApi(r.url())) finished++; });
  const pending = () => started - finished;
  async function settle(cap: number) {
    const t = Date.now(); let quiet = 0;
    while (Date.now() - t < cap) {
      await page.waitForTimeout(200);
      if (pending() <= 2) { if (!quiet) quiet = Date.now(); else if (Date.now() - quiet > 800) break; } else quiet = 0;
    }
  }

  await installCriblHostGlobals(page);
  await gotoApm(page, '/?range=-15m');
  const apm = apmFrame(page);
  await dismissHostAnnouncements(page);
  await apm.getByText(/detected issues/i).first().waitFor({ state: 'visible', timeout: 60_000 }).catch(() => {});
  await settle(20_000);

  const overBudget: string[] = [];
  for (const p of pages) {
    await dismissHostAnnouncements(page);
    const jobsBefore = jobPosts;
    await apm.getByText(p.nav, { exact: true }).first().click({ timeout: 30_000 });
    await p.marker(apm).catch(() => {});
    await settle(30_000);
    const jobs = jobPosts - jobsBefore;
    console.log(`${p.nav.padEnd(10)} initialKqlJobs=${jobs} (budget ${p.budget})`);
    if (jobs > p.budget) overBudget.push(`${p.nav}: ${jobs} > ${p.budget}`);
  }
  expect(overBudget, `pages over KQL-job budget: ${overBudget.join(', ')}`).toEqual([]);
});
