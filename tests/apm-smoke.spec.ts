// End-to-end smoke test: load the deployed APM pack inside Cribl Cloud and
// assert the app shell rendered. This is the "is the build alive?" check
// that future specs will extend.
//
// The APM app is mounted inside Cribl Search via the Cribl App Platform
// under a path controlled by the host. Set CRIBL_APM_APP_PATH in .env to
// override it; the default matches the Cribl Cloud convention of
// /app-ui/<pack-name>.

import { test, expect } from '@playwright/test';

const APP_PATH = process.env.CRIBL_APM_APP_PATH ?? '/app-ui/apm/';

test('APM app shell renders on Cribl Cloud', async ({ page }) => {
  await page.goto(APP_PATH);

  // The app can render directly or inside an iframe depending on how the
  // Cribl host wraps pack UIs. Try the page first, fall back to the first
  // frame whose URL matches the pack path.
  let root = page.locator('body');
  if (!(await root.getByText('Cribl APM').first().isVisible().catch(() => false))) {
    const frame = page.frames().find((f) => /apm/.test(f.url()));
    if (frame) root = frame.locator('body');
  }

  // Brand + a handful of nav tabs from src/components/NavBar.tsx
  await expect(root.getByText('Cribl APM').first()).toBeVisible({ timeout: 30_000 });
  await expect(root.getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  await expect(root.getByRole('link', { name: 'System Architecture' })).toBeVisible();
  await expect(root.getByRole('link', { name: 'Investigate' })).toBeVisible();
});
