// Cribl Cloud UI login → storageState cache.
//
// Runs once at the start of a Playwright session (see playwright.config.ts
// "setup" project) and writes an authenticated browser state to
// playwright/.auth/cribl-cloud.json. Subsequent test projects reuse that
// state so each spec starts already-logged-in.
//
// The Cribl Cloud login is an Auth0 Universal Login hosted flow. The
// workspace's own login page wraps it with a carousel and social-login
// buttons ("Continue with <org>", "Continue with Google", etc.) but the
// primary email/password affordances are still label-based so we target
// those with accessible-name matchers. If Cribl changes the login UI this
// file is the single place to update.

import { test as setup } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const AUTH_FILE = 'playwright/.auth/cribl-cloud.json';

// Setup is slow: redirect chain → Auth0 round trip → workspace shell
// hydration. Default 30s is too tight.
setup.setTimeout(120_000);

setup('authenticate to Cribl Cloud', async ({ page }) => {
  const email = process.env.CRIBL_TEST_EMAIL;
  const password = process.env.CRIBL_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'CRIBL_TEST_EMAIL and CRIBL_TEST_PASSWORD must be set (see .env.example).',
    );
  }

  // Navigate to the workspace root. If we're not logged in, Cribl Cloud
  // bounces us through login.cribl[-staging].cloud (Auth0). Use `commit`
  // so Playwright doesn't wait for the initial page's load event — that
  // event never fires because the redirect chain replaces the document.
  await page.goto('/', { waitUntil: 'commit' });
  await page.waitForLoadState('domcontentloaded');

  if (/login\.cribl(-staging)?\.cloud/.test(page.url())) {
    await page.getByLabel(/email address/i).fill(email);
    // Cribl's Auth0 login is a two-step flow: email → "Next" → password →
    // "Continue". Scope the button lookup to the primary submit so we
    // don't collide with the "Continue with <org>" / "Continue with
    // Google" social-login buttons.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    const passwordField = page.getByLabel(/password/i);
    await passwordField.waitFor({ state: 'visible', timeout: 30_000 });
    await passwordField.fill(password);
    await page.getByRole('button', { name: /^(continue|log in|sign in)$/i }).click();
  }

  // Wait for the final redirect back to the workspace. The Cribl Cloud
  // SPA performs a second /authorize round-trip to pick up a management
  // API token after the first login — give that time to land before we
  // snapshot cookies, otherwise silent auth on the next test run fails.
  await page.waitForURL((url) => !/login\.cribl(-staging)?\.cloud/.test(url.toString()), {
    timeout: 60_000,
  });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => {});

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
