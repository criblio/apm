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

  // NavBar brand + three representative tabs from src/components/NavBar.tsx.
  await expect(apm.getByRole('link', { name: 'Overview', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(apm.getByRole('link', { name: 'Services', exact: true })).toBeVisible();
  await expect(apm.getByRole('link', { name: 'Investigate', exact: true })).toBeVisible();
});
