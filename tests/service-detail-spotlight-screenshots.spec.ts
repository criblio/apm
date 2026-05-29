/**
 * Capture screenshots for the Service Detail Spotlight integration (PR I).
 *
 * Lands the service-level Spotlight section between the health charts
 * and the Operations table. Per-operation Spotlight expands inline
 * when the row's chevron is clicked.
 */
import { test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apmFrame, gotoApm } from './helpers/apmSession';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SHOT_DIR = path.resolve(
  __dirname,
  '../docs/sessions/screenshots/2026-05-28-service-spotlight',
);

test('capture Service-Detail Spotlight screenshots', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1400 });
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  // Navigate to Services list, click into the first service.
  await apm
    .getByRole('link', { name: 'Services', exact: true })
    .first()
    .waitFor({ timeout: 30_000 });
  await apm
    .getByRole('link', { name: 'Services', exact: true })
    .first()
    .click();

  // Wait for the services table to populate, then click any service
  // link. Whichever service is at the top in the demo cluster will
  // do — we just need a populated Service Detail page.
  const anyServiceLink = apm.locator('a[href*="/service/"]').first();
  await anyServiceLink.waitFor({ timeout: 30_000 });
  await anyServiceLink.click();

  // Wait for the page to mount.
  await apm.getByRole('heading', { name: 'Spotlight' }).waitFor({
    timeout: 30_000,
  });

  // Give the service-level Spotlight a chance to stream in.
  await page.waitForTimeout(25_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '00-service-spotlight.png'),
    fullPage: true,
  });

  // Find the Operations table heading first, then expand its first
  // row. There are multiple <tbody> elements on the page (service
  // metric cards, ops table, instances) — narrow to the one inside
  // the Operations section.
  const opsTable = apm
    .locator('section')
    .filter({ has: apm.getByRole('heading', { name: 'Operations' }) })
    .locator('table tbody tr')
    .first();
  await opsTable.waitFor({ timeout: 30_000 });
  await opsTable.locator('td').first().click();
  await page.waitForTimeout(25_000);
  await page.screenshot({
    path: path.join(SHOT_DIR, '01-operation-spotlight-expanded.png'),
    fullPage: true,
  });
});
