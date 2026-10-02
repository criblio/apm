// Cribl Cloud UI login → storageState cache. Runs once as the "setup"
// project in playwright.config.ts; specs reuse the saved state. The flow
// (Auth0 two-step, federated IdP branch, the redirect-race guard) is the
// framework's `loginSetup`: if Cribl changes the login UI, fix it there.

import { test as setup } from '@playwright/test';
import { loginSetup } from '@criblio/app-tooling/playwright';

// Redirect chain → Auth0 → workspace hydration; 30 s is too tight.
setup.setTimeout(120_000);

setup('authenticate to Cribl Cloud', async ({ page }) => {
  await loginSetup(page, {
    email: process.env.CRIBL_TEST_EMAIL ?? '',
    password: process.env.CRIBL_TEST_PASSWORD ?? '',
    storageStatePath: 'playwright/.auth/cribl-cloud.json', // AUTH_FILE in playwright.config.ts
  });
});
