// Baseline UI timing capture — Phase 1 of the search-perf-plan.
// Measures wall-clock time from goto-call to a known "content
// visible" marker on each page. Captures partial data even when
// markers don't appear within the timeout — that's its own
// signal.
//
// Numbers go to /tmp/apm-baseline-ui.json. Run via:
//   npx playwright test tests/baseline-ui-timing.spec.ts
//
// NOT part of the regression suite — delete or skip once the
// perf-plan phases have shipped and the baseline is stale.

import { test } from '@playwright/test';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import type { FrameLocator, Page } from '@playwright/test';
import { apmFrame, gotoApm } from './helpers/apmSession';

const OUT = '/tmp/apm-baseline-ui.json';
const MARKER_TIMEOUT_MS = 180_000;

interface PageMeasurement {
  page: string;
  navMs: number;
  firstContentMs: number | null;
  markerFound: boolean;
  marker: string;
  recordedAt: string;
}

function record(measurement: PageMeasurement) {
  let existing: PageMeasurement[] = [];
  if (existsSync(OUT)) {
    try {
      existing = JSON.parse(readFileSync(OUT, 'utf8'));
    } catch {
      // First run — output file doesn't exist yet, start fresh.
    }
  }
  existing.push(measurement);
  writeFileSync(OUT, JSON.stringify(existing, null, 2));
}

async function waitForFirstMarker(
  promises: Array<Promise<unknown>>,
  timeoutMs: number,
): Promise<boolean> {
  return Promise.race([
    Promise.race(promises).then(() => true),
    new Promise<boolean>((resolve) =>
      setTimeout(() => resolve(false), timeoutMs),
    ),
  ]);
}

async function measure(
  page: Page,
  pageName: string,
  marker: string,
  nav: (page: Page, apm: FrameLocator) => Promise<void>,
  markerWaits: (apm: FrameLocator) => Array<Promise<unknown>>,
): Promise<void> {
  const apm = apmFrame(page);
  const t0 = Date.now();
  await nav(page, apm);
  const navMs = Date.now() - t0;

  const found = await waitForFirstMarker(markerWaits(apm), MARKER_TIMEOUT_MS);
  const elapsed = Date.now() - t0;
  record({
    page: pageName,
    navMs,
    firstContentMs: found ? elapsed : null,
    markerFound: found,
    marker,
    recordedAt: new Date().toISOString(),
  });
}

test.beforeAll(() => {
  writeFileSync(OUT, JSON.stringify([], null, 2));
});

test.describe('UI baseline timings', () => {
  // Playwright requires the first argument of beforeEach to use an
  // object-destructure pattern (it's the fixtures arg, even when
  // unused). The no-empty-pattern lint rule is wrong for this case.
  test.beforeEach(
    // eslint-disable-next-line no-empty-pattern
    ({}, testInfo) => {
      // Allow each test to run up to MARKER_TIMEOUT_MS + setup time.
      testInfo.setTimeout(MARKER_TIMEOUT_MS + 60_000);
    },
  );

  test('Home / Overview', async ({ page }) => {
    await measure(
      page,
      'home',
      'Detected Issues OR Overview heading',
      async (p) => {
        await gotoApm(p, '/?range=-15m');
      },
      (apm) => [
        apm.getByText(/detected issues/i).first().waitFor({ state: 'visible' }),
        apm
          .getByRole('heading', { name: /overview/i })
          .first()
          .waitFor({ state: 'visible' }),
      ],
    );
  });

  test('Services list', async ({ page }) => {
    await measure(
      page,
      'services',
      'Services (N) header',
      async (p, apm) => {
        await gotoApm(p, '/');
        await apm.getByRole('link', { name: 'Services', exact: true }).click();
      },
      (apm) => [
        apm
          .getByText(/^Services \(\d+\)/)
          .first()
          .waitFor({ state: 'visible' }),
      ],
    );
  });

  test('Service Detail / frontend', async ({ page }) => {
    await measure(
      page,
      'serviceDetail-frontend',
      'Top operations heading',
      async (p, apm) => {
        await gotoApm(p, '/');
        await apm.getByRole('link', { name: 'Services', exact: true }).click();
        await apm
          .getByText(/^Services \(\d+\)/)
          .first()
          .waitFor({ state: 'visible', timeout: MARKER_TIMEOUT_MS })
          .catch(() => {});
        await apm
          .locator('table tbody a:has-text("frontend")')
          .first()
          .click()
          .catch(() => {});
      },
      (apm) => [
        apm.getByText(/^Top operations/).first().waitFor({ state: 'visible' }),
      ],
    );
  });

  test('Errors page', async ({ page }) => {
    await measure(
      page,
      'errors',
      'errors table row OR empty state',
      async (p, apm) => {
        await gotoApm(p, '/');
        await apm.getByRole('link', { name: 'Errors', exact: true }).click();
      },
      (apm) => [
        apm.locator('table tbody tr').first().waitFor({ state: 'visible' }),
        apm.getByText(/no errors/i).first().waitFor({ state: 'visible' }),
      ],
    );
  });

  test('System Architecture', async ({ page }) => {
    await measure(
      page,
      'systemArch',
      'first svg visible',
      async (p, apm) => {
        await gotoApm(p, '/');
        await apm.getByRole('link', { name: /service map/i }).click();
      },
      (apm) => [apm.locator('svg').first().waitFor({ state: 'visible' })],
    );
  });
});
