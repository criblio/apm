import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-29-settings-cleanup',
);

test('Settings page — reorganized layout', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 1400 });
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  await apm
    .getByRole('link', { name: 'Settings', exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await apm.getByRole('link', { name: 'Settings', exact: true }).first().click();

  await apm
    .getByRole('heading', { name: 'Setup status' })
    .waitFor({ timeout: 20_000 });
  await page.waitForTimeout(4_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-settings-top.png'),
    fullPage: true,
  });
});
