// End-to-end smoke test: load the deployed APM pack from the
// `/app-ui/apm/` path and assert the app shell rendered. This is the "is
// the build alive?" check that future specs will extend.
//
// The Cribl App Platform serves the pack's index.html directly at this
// path and, when the outer Cribl Search shell wraps the pack, injects
// `window.CRIBL_BASE_PATH` / `window.CRIBL_API_URL` so React Router
// resolves relative to the pack mount point. Navigating to the URL
// directly from Playwright skips that injection, so we polyfill the
// base path ourselves via `addInitScript` — which is exactly what the
// Cribl shell would have done if we'd click-driven our way in through
// the Apps menu.

import { test, expect } from '@playwright/test';

const APP_PATH = process.env.CRIBL_APM_APP_PATH ?? '/app-ui/apm/';

test('APM app shell renders on Cribl Cloud', async ({ page }) => {
  // Polyfill the host globals the pack's `App.tsx` reads so React Router
  // uses the pack mount point as its basename. Without this the router
  // sees `/app-ui/apm/` as the pathname with a `/` basename, and no
  // route matches.
  await page.addInitScript((basePath) => {
    (window as unknown as { CRIBL_BASE_PATH: string }).CRIBL_BASE_PATH = basePath;
    (window as unknown as { CRIBL_API_URL: string }).CRIBL_API_URL = '/m/default_search';
  }, APP_PATH.replace(/\/$/, ''));

  await page.goto(APP_PATH, { waitUntil: 'domcontentloaded' });

  // NavBar brand + three representative tabs from src/components/NavBar.tsx.
  // `getByRole('link', { exact: true })` is used on `Home` because the
  // brand anchor also contains "Cribl APM Home"-style text in some
  // layouts; the exact match avoids ambiguity.
  await expect(page.getByText('Cribl APM').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'System Architecture' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Investigate' })).toBeVisible();
});
