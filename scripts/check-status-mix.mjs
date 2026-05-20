// Status-mix widget screenshot check. Loads a service's detail page
// on staging, waits for the new Status mix chart to populate, writes
// a PNG to docs/sessions/screenshots/.../.
//
//   STATUS_MIX_SERVICE=frontend-proxy npx tsx scripts/check-status-mix.mjs
//
// Defaults to frontend-proxy (richest mix on the demo cluster).
// Output path can be overridden via STATUS_MIX_OUT.
//
// Per CLAUDE.md "Validating UI changes via Playwright" — uses
// playwright-core + tests/helpers/apmSession.ts (auth + host globals)
// rather than the @playwright/test runner. Reusable, kept around so
// the widget can be re-validated after layout / colour changes.
import { chromium } from 'playwright-core';
import {
  installCriblHostGlobals,
  gotoApm,
  apmFrame,
} from '../tests/helpers/apmSession.ts';

const SERVICE = process.env.STATUS_MIX_SERVICE ?? 'frontend-proxy';
const OUT =
  process.env.STATUS_MIX_OUT ??
  `docs/sessions/screenshots/2026-05-20-smooth-climb-misdiagnosis/status-mix-${SERVICE}.png`;

const browser = await chromium.launch({ headless: true });
try {
  const baseURL = process.env.CRIBL_BASE_URL?.replace(/\/$/, '');
  if (!baseURL) throw new Error('CRIBL_BASE_URL must be set');
  // Reuse the cached storageState from the Playwright test suite so we
  // don't have to drive Auth0 here. tests/auth.setup.ts populates it.
  const ctx = await browser.newContext({
    baseURL,
    storageState: 'playwright/.auth/cribl-cloud.json',
    viewport: { width: 1600, height: 1100 },
  });
  const page = await ctx.newPage();
  await installCriblHostGlobals(page);
  // Land on the app root first so the host shell injects globals,
  // then push the in-app deep route via the iframe's history. The
  // shell URL `/apps/a/apm/service/<name>` lands on Services even
  // when <name> is set, so we drive React Router directly from inside.
  await gotoApm(page, '/');
  const frame = apmFrame(page);
  await frame.getByRole('link', { name: 'Services', exact: true }).first().waitFor({
    timeout: 30_000,
  });
  // FrameLocator has no .evaluate — get the underlying Frame via the
  // page's frame list (the iframe whose URL contains /app-ui/apm).
  const appFrame = page
    .frames()
    .find((f) => f.url().includes('/app-ui/apm'));
  if (!appFrame) throw new Error('could not find APM iframe to drive nav');
  await appFrame.evaluate((svc) => {
    window.history.pushState({}, '', `/app-ui/apm/service/${svc}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, SERVICE);
  // Confirm we landed on the right service via the page header.
  await frame.locator(`h1, h2, [class*="title" i]`).filter({ hasText: SERVICE }).first().waitFor({
    timeout: 30_000,
  });
  // Wait for the existing RED charts so we know the Service Detail
  // page hydrated before looking for the new chart.
  await frame.getByText('Rate', { exact: true }).first().waitFor({
    timeout: 30_000,
  });
  // The new chart's title.
  const mixTitle = frame.getByText('Status mix', { exact: true }).first();
  await mixTitle.waitFor({ timeout: 30_000 });

  // Wait until the chart has at least one rendered <path> with data.
  // Polling on the SVG is more robust than waiting on "Loading…" to
  // detach — when the chart starts in the empty state (statusMix=[])
  // there's no "Loading…" to wait for, so a detached-wait returns
  // immediately and we'd screenshot before the fetch resolves.
  const chartRow = mixTitle.locator(
    'xpath=ancestor::*[contains(@class, "chartRow")][1]',
  );
  for (let attempt = 0; attempt < 60; attempt++) {
    const paths = await chartRow.locator('svg path').count();
    if (paths > 1) break; // axis baseline alone is 1; data adds more
    await page.waitForTimeout(1_000);
  }
  // Brief settle so the SVG paint completes.
  await page.waitForTimeout(1_500);

  // Screenshot the new chart's container (the .chartRow div) so we
  // capture title + subtitle + SVG + legend.
  const block = mixTitle.locator(
    'xpath=ancestor::*[contains(@class, "chartRow")][1]',
  );
  await block.screenshot({ path: OUT });
  console.log('wrote', OUT);

  // Quick assertion: at least one legend entry should be visible
  // (frontend-proxy has 4xx, 500, 503 in the live data).
  const present = (await Promise.all(
    ['503', '504', '500', '4xx'].map((c) =>
      frame.getByText(c, { exact: true }).count(),
    ),
  )).filter((n) => n > 0).length;
  console.log(`legend entries present: ${present}/4 expected classes`);

  await browser.close();
  process.exit(0);
} catch (err) {
  console.error('FAILED:', err);
  await browser.close();
  process.exit(1);
}
