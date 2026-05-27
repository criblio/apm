// Full-page screenshot of Service Detail on staging for layout review.
//   STATUS_MIX_SERVICE=frontend-proxy npx tsx scripts/screenshot-svcdetail.mjs
import { chromium } from 'playwright-core';
import {
  installCriblHostGlobals,
  gotoApm,
  apmFrame,
} from '../tests/helpers/apmSession.ts';

const SERVICE = process.env.STATUS_MIX_SERVICE ?? 'frontend-proxy';
const OUT =
  process.env.STATUS_MIX_OUT ??
  `/tmp/svcdetail-${SERVICE}.png`;

const browser = await chromium.launch({ headless: true });
try {
  const baseURL = process.env.CRIBL_BASE_URL?.replace(/\/$/, '');
  if (!baseURL) throw new Error('CRIBL_BASE_URL must be set');
  const ctx = await browser.newContext({
    baseURL,
    storageState: 'playwright/.auth/cribl-cloud.json',
    viewport: { width: 1600, height: 1100 },
  });
  const page = await ctx.newPage();
  await installCriblHostGlobals(page);
  await gotoApm(page, '/');
  await page.waitForTimeout(8_000);
  const appFrame = page.frames().find((f) => f.url().includes('/app-ui/apm'));
  if (!appFrame) {
    console.log('frame URLs at timeout:', page.frames().map(f => f.url()));
    throw new Error('iframe not found');
  }
  await appFrame.evaluate((svc) => {
    window.history.pushState({}, '', `/app-ui/apm/service/${svc}`);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, SERVICE);
  await page.waitForTimeout(3_000);

  const frame = apmFrame(page);
  try {
    await frame.locator('h1, [class*="heroName" i]').first().waitFor({ timeout: 30_000 });
  } catch (err) {
    console.log('h1 not found; frame text snapshot:', (await appFrame.content()).slice(0, 800));
    throw err;
  }
  // Wait for any chart to paint
  await page.waitForTimeout(15_000);

  // Full-page screenshot
  await page.screenshot({ path: OUT, fullPage: true });
  console.log('wrote', OUT);
  await browser.close();
  process.exit(0);
} catch (err) {
  console.error('FAILED:', err);
  await browser.close();
  process.exit(1);
}
