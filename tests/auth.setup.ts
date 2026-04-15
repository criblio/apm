// Cribl Cloud UI login → storageState cache.
//
// Runs once at the start of a Playwright session (see playwright.config.ts
// "setup" project) and writes an authenticated browser state to
// playwright/.auth/cribl-cloud.json. Subsequent test projects reuse that
// state so each spec starts already-logged-in.
//
// The Cribl Cloud login is an Auth0 hosted flow. Selectors below target the
// stock Auth0 Universal Login form fields. If Cribl changes the login UI
// this file is the single place to update.

import { test as setup, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const AUTH_FILE = 'playwright/.auth/cribl-cloud.json';

setup('authenticate to Cribl Cloud', async ({ page }) => {
  const email = process.env.CRIBL_TEST_EMAIL;
  const password = process.env.CRIBL_TEST_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'CRIBL_TEST_EMAIL and CRIBL_TEST_PASSWORD must be set (see .env.example).',
    );
  }

  // Navigate to the workspace root. If we're not logged in, Cribl Cloud
  // bounces us through login.cribl[-staging].cloud (Auth0).
  await page.goto('/');

  // Wait for either the login form or the Cribl app shell to appear.
  await page.waitForLoadState('domcontentloaded');

  const onAuth0 = /login\.cribl(-staging)?\.cloud/.test(page.url());
  if (onAuth0) {
    await page.getByLabel(/email/i).fill(email);
    // Auth0 Universal Login can be one-page (email + password together) or
    // two-step (email → continue → password). Handle both.
    const passwordField = page.getByLabel(/password/i);
    if (await passwordField.isVisible().catch(() => false)) {
      await passwordField.fill(password);
    } else {
      await page.getByRole('button', { name: /continue|next/i }).click();
      await passwordField.waitFor({ state: 'visible' });
      await passwordField.fill(password);
    }
    await page.getByRole('button', { name: /continue|log in|sign in/i }).click();
  }

  // Wait for the redirect back to the workspace. Cribl Cloud workspaces
  // live on *.cribl(-staging).cloud — assert we've returned to that origin
  // and are no longer on the Auth0 login host.
  await expect
    .poll(() => page.url(), { timeout: 45_000 })
    .not.toMatch(/login\.cribl(-staging)?\.cloud/);
  await page.waitForLoadState('networkidle');

  mkdirSync(dirname(AUTH_FILE), { recursive: true });
  await page.context().storageState({ path: AUTH_FILE });
});
