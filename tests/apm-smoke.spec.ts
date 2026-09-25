// End-to-end smoke test: load the deployed APM pack and assert the
// app shell rendered. This is the "is the build alive?" check that
// future specs will extend.
//
// The Cribl Cloud workspace shell wraps the pack inside an iframe at
// `/app-ui/apm/`. `gotoApm` waits for the iframe to attach; `apmFrame`
// returns a FrameLocator scoped to the iframe so locators reach the
// app's nav and content. Main-page locators only see the workspace
// shell chrome and won't find anything the APM app renders.

import { test, expect } from '@playwright/test';
import { apmFrame, gotoApm } from './helpers/apmSession';

test('APM app shell renders on Cribl Cloud', async ({ page }) => {
  await gotoApm(page, '/');
  const apm = apmFrame(page);

  // Capra VerticalNavigation items are button-driven (not raw anchors) so
  // role-based link selectors would miss a correctly rendered shell.
  await expect(apm.getByText('Overview', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(apm.getByText('Services', { exact: true }).first()).toBeVisible();
  await expect(apm.getByText('Investigate', { exact: true }).first()).toBeVisible();
});

test('APM settings exposes GoatTown connected-app setup', async ({ page }) => {
  await gotoApm(page, '/configuration');
  const apm = apmFrame(page);

  await expect(apm.getByRole('heading', { name: 'Server-side investigations' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(apm.getByLabel('GoatTown connected-app token')).toBeVisible();
  await expect(apm.getByRole('button', { name: 'Test connection' })).toBeVisible();
  await expect(apm.getByText('goattownEmbedToken', { exact: true })).toBeVisible();

  await apm.getByLabel('GoatTown connected-app token').fill('gt_i1_legacy-installation-token');
  // One button, two labels: "Save token" before a token is stored and
  // "Replace token" once one is. The shared validation workspace is normally
  // already connected, so matching only the first label passed against a
  // fresh tenant and failed in CI every time.
  await apm.getByRole('button', { name: /(save|replace) token/i }).click();
  await expect(apm.getByText(/connected-app token in the form gt_a1_/i)).toBeVisible();
});
