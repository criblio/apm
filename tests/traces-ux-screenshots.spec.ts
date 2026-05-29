/**
 * Screenshot capture for PR G's Traces UX-guidance changes:
 * rich empty state, example-filter chips, panel captions, and
 * Spotlight-as-default-tab behavior.
 *
 * Shots go to docs/sessions/screenshots/2026-05-28-traces-ux/.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-28-traces-ux',
);

test('capture traces-ux-guidance screenshots', async ({ page }) => {
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

  // 00 — empty state with explanatory copy + example chips
  await page.waitForTimeout(3_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-empty-state-explained.png'),
    fullPage: false,
  });

  // 01 — click an example chip to seed a filter, watch Spotlight
  // populate (it's now the default tab)
  await apm.getByRole('button', { name: 'HTTP 5xx errors' }).click();
  await page.waitForTimeout(20_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '01-spotlight-default-with-sample.png'),
    fullPage: false,
  });

  // 02 — switch to Facets to show the new caption
  await apm.getByRole('tab', { name: 'Facets' }).click();
  await page.waitForTimeout(8_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '02-facets-with-caption.png'),
    fullPage: false,
  });
});
