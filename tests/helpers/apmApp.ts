// APM's bindings for the framework Playwright helpers
// (`@criblio/app-tooling/playwright`, see the framework's docs/testing.md).
//
// The framework owns the mechanics: host globals (CRIBL_BASE_PATH,
// CRIBL_API_URL, a Bearer-injecting fetch wrapper), the cached OAuth token,
// finding the app iframe, dismissing host announcement modals, and running
// KQL from Node. This file only fixes the two things that are APM's: which
// app (CRIBL_APM_APP_PATH, default /app-ui/apm/) and the positional
// `runQuery(kql, earliest, latest, limit)` shape the specs and eval harness
// already use.
//
// Credentials are read when a helper is called, not at import, so
// `playwright test --list` and modules that only need `apmFrame` load
// without a client secret.

import type { FrameLocator, Page } from '@playwright/test';
import {
  appFrame,
  criblCredentialsFromEnv,
  gotoApp,
  installCriblHostGlobals,
  runSearch,
} from '@criblio/app-tooling/playwright';

export { dismissHostAnnouncements } from '@criblio/app-tooling/playwright';

export const APM_APP_PATH = process.env.CRIBL_APM_APP_PATH ?? '/app-ui/apm/';

function appIdFromPath(path: string): string {
  const match = /^\/app-ui\/([^/]+)\/?$/.exec(path);
  if (!match) {
    throw new Error(
      `CRIBL_APM_APP_PATH must look like /app-ui/<app-id>/ (got ${JSON.stringify(path)})`,
    );
  }
  return match[1];
}

/** App id the iframe is matched on — exact, so `apm` never matches `apm-lab`. */
export const APM_APP_ID = appIdFromPath(APM_APP_PATH);

/**
 * Install the host globals and Bearer-injecting fetch wrapper for the APM
 * app. Call once per page, before the first `gotoApm`.
 */
export async function installApmHostGlobals(page: Page): Promise<void> {
  await installCriblHostGlobals(page, { ...criblCredentialsFromEnv(), appPath: APM_APP_PATH });
}

/**
 * Open APM through the workspace shell, wait for its iframe, clear host
 * announcements. The shell ignores deep paths: land here, then click the
 * nav inside `apmFrame(page)`.
 */
export async function gotoApm(page: Page, inAppPath = '/'): Promise<void> {
  await gotoApp(page, APM_APP_ID, { appPath: APM_APP_PATH, path: inAppPath });
}

/** FrameLocator rooted in the APM iframe; every in-app locator goes through it. */
export function apmFrame(page: Page): FrameLocator {
  return appFrame(page, APM_APP_ID);
}

/**
 * Run a KQL query against the default search group and return its rows
 * (150 s job budget — see `runSearch`).
 */
export async function runQuery(
  kql: string,
  earliest = '-1h',
  latest = 'now',
  limit = 200,
): Promise<Record<string, unknown>[]> {
  return runSearch(criblCredentialsFromEnv(), kql, { earliest, latest, limit });
}
