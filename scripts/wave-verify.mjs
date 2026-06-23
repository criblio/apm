#!/usr/bin/env node
/**
 * One-off Playwright driver to verify the Capra reskin against
 * staging post-deploy. Walks Home → Alerts → Investigate → Service
 * Detail and captures screenshots into
 * docs/sessions/screenshots/2026-06-23-capra-v0.11.0-verify/.
 *
 * Run: node scripts/wave-verify.mjs
 *
 * Per CLAUDE.md, this script lives in scripts/ uncommitted unless
 * it becomes reusable.
 */
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { installCriblHostGlobals, gotoApm } from '../tests/helpers/apmSession.ts';

// Inline dotenv loader so we don't take a dep on the package.
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const OUT = 'docs/sessions/screenshots/2026-06-23-capra-v0.11.0-verify';

async function shoot(page, slug, opts = {}) {
  const fp = `${OUT}/${slug}.png`;
  await page.screenshot({ path: fp, fullPage: opts.full ?? false });
  console.log('  →', fp);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    storageState: 'playwright/.auth/cribl-cloud.json',
    viewport: { width: 1440, height: 900 },
    baseURL: process.env.CRIBL_BASE_URL,
  });
  ctx.setDefaultTimeout(60000);
  ctx.setDefaultNavigationTimeout(60000);
  const page = await ctx.newPage();
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('  [console.error]', msg.text());
  });

  await installCriblHostGlobals(page);

  // Page navigation inside the iframe — direct gotoApm to deep links
  // doesn't work; have to click the sidebar nav. Start on Home; the
  // first gotoApm boots the shell.
  async function clickNav(label) {
    const frame = page.frameLocator('iframe[src*="/app-ui/apm"]').first();
    await frame.getByRole('link', { name: label, exact: true }).click();
    await page.waitForTimeout(1500);
  }

  // Wait for skeleton placeholders to disappear (each page has
  // .skeleton / .skeletonBar children when loading). Bounded.
  async function waitData(maxMs = 45000) {
    const frame = page.frameLocator('iframe[src*="/app-ui/apm"]').first();
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const skel = await frame.locator('[class*="skeleton"]').count();
      if (skel === 0) return;
      await page.waitForTimeout(1000);
    }
  }

  console.log('▶ Home');
  await gotoApm(page, '/');
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 });
  // The Cribl shell sometimes reloads once on first paint ("Service
  // worker failed to take control of page"). Give it a settle window
  // before looking for content inside the iframe.
  await page.waitForTimeout(8000);
  // Wait until we can actually see the APM page title rendered.
  await page
    .frameLocator('iframe[src*="/app-ui/apm"]').first()
    .getByRole('heading', { name: 'Overview' })
    .waitFor({ timeout: 30000 });
  await waitData();
  await shoot(page, 'home-top');
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  await shoot(page, 'home-bottom');
  await shoot(page, 'home-full', { full: true });

  console.log('▶ Alerts');
  await clickNav('Alerts');
  await waitData();
  await shoot(page, 'alerts-top');
  await shoot(page, 'alerts-full', { full: true });

  console.log('▶ Services catalog');
  await clickNav('Services');
  await waitData();
  await shoot(page, 'services');

  console.log('▶ Errors');
  await clickNav('Errors');
  await waitData();
  await shoot(page, 'errors');

  console.log('▶ Investigate');
  await clickNav('Investigate');
  await page.waitForTimeout(2000);
  await shoot(page, 'investigate-empty');

  console.log('▶ Settings');
  await page.frameLocator('iframe[src*="/app-ui/apm"]').first().getByRole('link', { name: 'Settings' }).click();
  await page.waitForTimeout(2500);
  await waitData();
  await shoot(page, 'settings-top');
  await shoot(page, 'settings-full', { full: true });

  await browser.close();
  console.log('✓ Done');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});
