/**
 * Just the payment service detail shot, with extra wait time so the
 * ~30-attribute scoped Spotlight has time to fully stream.
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

test('payment service detail — extended Spotlight wait', async ({ page }) => {
  test.setTimeout(360_000);
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

  const paymentLink = apm
    .locator('a[href*="/service/payment"]')
    .first();
  await paymentLink.waitFor({ timeout: 30_000 });
  await paymentLink.click();

  await apm
    .getByRole('heading', { name: 'Spotlight' })
    .waitFor({ timeout: 30_000 });
  // 8 attrs / concurrency 4 = 2 batches; plus the page's other queries.
  await page.waitForTimeout(60_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '02-payment-spotlight-loaded.png'),
    fullPage: true,
  });
});
