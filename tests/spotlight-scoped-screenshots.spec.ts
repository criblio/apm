/**
 * Capture screenshots for the scoped-baseline Spotlight redesign.
 * Run while paymentFailure 50% is on so the differential is sharp.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-29-spotlight-scoped',
);

test('payment service detail with scoped Spotlight', async ({ page }) => {
  test.setTimeout(300_000);
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

  // Click the payment service specifically — that's where the
  // injected paymentFailure 50% should produce a clean signal.
  const paymentLink = apm
    .locator('a[href*="/service/payment"]')
    .first();
  await paymentLink.waitFor({ timeout: 30_000 });
  await paymentLink.click();

  await apm
    .getByRole('heading', { name: 'Spotlight' })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(30_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-payment-spotlight-scoped.png'),
    fullPage: true,
  });
});

test('errors page expanded with scoped Spotlight', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1200 });
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  await apm
    .getByRole('link', { name: 'Errors', exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await apm.getByRole('link', { name: 'Errors', exact: true }).first().click();

  await apm.getByRole('heading', { name: 'Errors' }).waitFor({
    timeout: 20_000,
  });
  await page.waitForTimeout(5_000);

  // Expand the first row.
  await apm.locator('tbody tr').first().click();
  await page.waitForTimeout(25_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '01-errors-spotlight-scoped.png'),
    fullPage: true,
  });
});
