/**
 * Screenshot capture for the PR body — not a smoke test. Lives in a
 * separate spec so the smoke spec stays fast and free of timing-
 * dependent waits.
 *
 * The captured shots go to docs/sessions/screenshots/2026-05-28-faceted-nav/.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-28-faceted-nav',
);

test('capture faceted-nav UI screenshots', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 900 });
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  await apm
    .getByRole('link', { name: 'Traces', exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await apm.getByRole('link', { name: 'Traces', exact: true }).first().click();
  await apm.getByRole('button', { name: 'Find Traces' }).waitFor({
    timeout: 20_000,
  });

  // 00 — initial empty state: facets rail shows the "pick a service
  // or add a filter" hint.
  await page.waitForTimeout(3_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-search-initial.png'),
    fullPage: false,
  });

  // Add a typed filter to give the facet panel a real predicate to
  // run against — sidesteps the services-dropdown timing dependency
  // and exercises the FilterBuilder → facet pipeline.
  await apm.getByRole('button', { name: '+ Add filter' }).click();
  await apm.getByLabel('filter attribute').last().fill('http.response.status_code');
  await apm.getByLabel('filter value').last().fill('200');
  // Wait for the facet rail to populate.
  await page.waitForTimeout(20_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '01-search-with-facets.png'),
    fullPage: false,
  });

  // Switch to Spotlight — same predicate becomes the SELECTION,
  // baseline is the rest of the window.
  await apm.getByRole('tab', { name: 'Spotlight' }).click();
  await page.waitForTimeout(20_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '02-spotlight-with-selection.png'),
    fullPage: false,
  });

  // FilterBuilder closeup — adjust selection to error spans for a
  // sharper Spotlight signal.
  await apm.getByRole('tab', { name: 'Facets' }).click();
  await page.waitForTimeout(2_000);
  await apm.getByLabel('filter value').last().fill('500');
  await page.waitForTimeout(20_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '03-filter-builder-row.png'),
    fullPage: false,
  });

  await apm.getByRole('tab', { name: 'Spotlight' }).click();
  await page.waitForTimeout(20_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '04-spotlight-errors-selection.png'),
    fullPage: false,
  });
});
