/**
 * Capture screenshots for the Errors-page Spotlight integration (PR H).
 *
 * The OTel demo cluster is healthy when flagd is fully off — there may
 * be zero error groups at runtime. The spec still captures the
 * collapsed table state; the expanded-Spotlight shot only fires if
 * at least one row exists.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-28-errors-spotlight',
);

test('capture Errors-page Spotlight screenshots', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  await apm
    .getByRole('link', { name: 'Errors', exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await apm.getByRole('link', { name: 'Errors', exact: true }).first().click();

  // Wait for the page heading.
  await apm.getByRole('heading', { name: 'Errors' }).waitFor({
    timeout: 20_000,
  });
  await page.waitForTimeout(5_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-errors-collapsed.png'),
    fullPage: false,
  });

  // Expand the first row, wait for Spotlight to stream in.
  const firstChevron = apm.locator('tbody tr').first();
  const visible = await firstChevron.isVisible().catch(() => false);
  if (visible) {
    await firstChevron.click();
    await page.waitForTimeout(20_000);
    await page.screenshot({
      path: path.join(SHOT_DIR, '01-errors-spotlight-expanded.png'),
      fullPage: false,
    });
  }
});
