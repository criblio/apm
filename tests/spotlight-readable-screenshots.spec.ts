/**
 * Capture screenshots for the readable Spotlight redesign — each
 * card now leads with a TL;DR sentence + inline per-value rows
 * (counts, percentages, Search button) instead of hiding the
 * substance behind a click.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-29-spotlight-readable',
);

test('payment service detail — readable Spotlight', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1400 });
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

  const paymentLink = apm.locator('a[href*="/service/payment"]').first();
  await paymentLink.waitFor({ timeout: 30_000 });
  await paymentLink.click();

  await apm
    .getByRole('heading', { name: 'Spotlight' })
    .waitFor({ timeout: 30_000 });
  await page.waitForTimeout(60_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-payment-readable.png'),
    fullPage: true,
  });
});
