/**
 * Capture screenshots for the Spotlight small-multiples redesign.
 * Driven by the paymentFailure scenario that's currently on in the
 * demo cluster, so the Spotlight signal should be strong.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-29-spotlight-mini',
);

test('Traces page Spotlight small-multiples + tab order', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
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

  // Seed via the HTTP 5xx sample chip so Spotlight has a real selection.
  await apm.getByRole('button', { name: 'HTTP 5xx errors' }).click();
  // Streaming with concurrency 4 + 22 attrs ≈ 25-35s.
  await page.waitForTimeout(35_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-spotlight-small-multiples.png'),
    fullPage: false,
  });

  // Click the first attribute header to expand the detail rows.
  const firstCellHeader = apm
    .locator('[aria-label="Spotlight panel"] button[aria-expanded]')
    .first();
  await firstCellHeader.click();
  await page.waitForTimeout(800);
  await page.screenshot({
    path: path.join(SHOT_DIR, '01-spotlight-expanded.png'),
    fullPage: false,
  });
});

test('Service Detail Spotlight redesign', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  await apm
    .getByRole('link', { name: 'Services', exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await apm
    .getByRole('link', { name: 'Services', exact: true })
    .first()
    .click();

  const anyServiceLink = apm.locator('a[href*="/service/"]').first();
  await anyServiceLink.waitFor({ timeout: 30_000 });
  await anyServiceLink.click();

  await apm
    .getByRole('heading', { name: 'Spotlight' })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(25_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '02-service-detail-spotlight.png'),
    fullPage: true,
  });
});
