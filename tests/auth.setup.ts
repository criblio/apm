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

  // PRIOR BUG: the workspace SPA bounces through multiple URLs before
  // landing on the Auth0 login form (`/` → `/` → `/login` → ... →
  // login.cribl-staging.cloud/u/login/identifier). Checking
  // `page.url()` right after `domcontentloaded` consistently saw `/`
  // (pre-redirect) and skipped the credential fill. The setup then
  // snapshotted half-set Auth0 transaction cookies (txs cookies still
  // populated with in-flight nonce/code_verifier, `cribl_redirect`
  // literally equal to "undefined") and silently reported success.
  // Specs consumed those cookies, hit Auth0 silent-auth, got
  // `login_required`, and bounced to login. The whole UI test path
  // had been broken for at least a day before anyone noticed.
  //
  // FIX: wait specifically for the Auth0 login-form URL
  // (`login.cribl[-staging].cloud/u/login/identifier`). If it appears,
  // we need to authenticate. If it doesn't appear within the timeout,
  // either we're already logged in (cookies still valid) or the redirect
  // chain stalled — either way, fall through to the post-condition
  // wait below, which will fail loudly if we never reach the workspace.
  const needsLogin = await page
    .waitForURL(/login\.cribl(-staging)?\.cloud\/u\/login/, { timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  const emailField = page.getByLabel(/email address/i);

  if (needsLogin) {
    await emailField.waitFor({ state: 'visible', timeout: 30_000 });
    await emailField.fill(email);
    // Cribl's Auth0 login is a two-step flow: email → "Next" → password →
    // "Continue". Scope the button lookup to the primary submit so we
    // don't collide with the "Continue with <org>" / "Continue with
    // Google" social-login buttons.
    await page.getByRole('button', { name: 'Next', exact: true }).click();

    // After clicking "Next" Auth0 may either show its own password page
    // OR federate to the workspace's IdP (authentik for typhoon.org test
    // accounts). The two flows present different DOM, so race their
    // distinguishing widgets and branch.
    const auth0Password = page.getByLabel(/password/i);
    const authentikEmailOrUsername = page.getByRole('textbox', {
      name: /email or username/i,
    });
    const branch = await Promise.race([
      auth0Password
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => 'auth0' as const),
      authentikEmailOrUsername
        .waitFor({ state: 'visible', timeout: 30_000 })
        .then(() => 'authentik' as const),
    ]);

    if (branch === 'authentik') {
      // Authentik flow: re-enter email/username on its own form, then
      // password on the next page, then optionally consent to the
      // Cribl.Cloud OAuth client (shown on first auth, remembered
      // afterward).
      await authentikEmailOrUsername.fill(email);
      await page.getByRole('button', { name: 'Log in', exact: false }).click();
      const authentikPassword = page.getByRole('textbox', {
        name: /please enter your password|password/i,
      });
      await authentikPassword.waitFor({ state: 'visible', timeout: 30_000 });
      await authentikPassword.fill(password);
      await page.getByRole('button', { name: /continue|log in|sign in/i }).click();

      // OAuth consent screen — "You're about to sign into Cribl.Cloud."
      // Authentik shows this once per (user, client) the first time,
      // and any time the granted scopes change. Race it against the
      // redirect-back-to-workspace so we don't block when it's skipped.
      await Promise.race([
        page
          .getByRole('heading', { name: /redirecting to cribl/i })
          .waitFor({ state: 'visible', timeout: 30_000 })
          .then(async () => {
            await page.getByRole('button', { name: /^continue$/i }).click();
          }),
        page
          .waitForURL(/cribl(-staging)?\.cloud/, { timeout: 30_000 })
          .then(() => undefined),
      ]).catch(() => {
        /* timeout falls through — the post-login waitForURL below
         * fails loudly if we never make it back to the workspace. */
      });
    } else {
      await auth0Password.fill(password);
      await page.getByRole('button', { name: /^(continue|log in|sign in)$/i }).click();
    }
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
