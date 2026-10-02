import { test, expect } from '@playwright/test';

test('a secondary query failure is explicit and does not take down Overview', async ({ page }) => {
  let injectedFailures = 0;
  await page.addInitScript(() => {
    window.CRIBL_BASE_PATH = '/';
    window.CRIBL_API_URL = 'http://127.0.0.1:4173/api/v1';
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    if (request.method() === 'POST' && body.includes('criblapm_alert')) {
      injectedFailures += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: 'injected alert-history failure' }),
      });
      return;
    }
    if (request.url().includes('/search/jobs') && request.method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ id: 'mock-job', status: 'completed' }] }),
      });
      return;
    }
    if (request.url().includes('/results')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ isFinished: true, totalEventCount: 0 })}\n`,
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await expect(page.getByText(/Some data is unavailable/)).toBeVisible();
  await expect(page.getByText(/not evidence of health/)).toBeVisible();
  await expect(page.getByText(/temporarily unavailable/i)).toHaveCount(0);
  expect(injectedFailures).toBeGreaterThan(0);
});

/**
 * Alerts polls the primary read every 30s, silently. Through
 * `usePageLoad({ silentFailures: 'keep' })` a poll can neither raise the
 * error banner nor clear it; only mount, Refresh or a deps change can.
 */
test.describe('Alerts 30s silent poll', () => {
  async function mockAlertsApi(page: import('@playwright/test').Page, failPrimary: () => boolean) {
    const primary = { calls: 0 };
    await page.addInitScript(() => {
      window.CRIBL_BASE_PATH = '/';
      window.CRIBL_API_URL = 'http://127.0.0.1:4173/api/v1';
    });
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const body = request.postData() ?? '';
      if (request.method() === 'POST' && body.includes('criblapm__home_alerts')) {
        primary.calls += 1;
        if (failPrimary()) {
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ status: 'error', message: 'injected active-alerts failure' }),
          });
          return;
        }
      }
      if (request.url().includes('/search/jobs') && request.method() === 'POST') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [{ id: 'mock-job', status: 'completed' }] }),
        });
        return;
      }
      if (request.url().includes('/results')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/x-ndjson',
          body: `${JSON.stringify({ isFinished: true, totalEventCount: 0 })}\n`,
        });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    return primary;
  }

  test('a failing poll does not raise the banner; Refresh does', async ({ page }) => {
    let failing = false;
    await page.clock.install();
    const primary = await mockAlertsApi(page, () => failing);
    await page.goto('/alerts');
    await expect(page.getByRole('heading', { name: 'Alerts' })).toBeVisible();
    await expect.poll(() => primary.calls).toBe(1);

    failing = true;
    await page.clock.fastForward(30_000);
    await expect.poll(() => primary.calls).toBe(2);
    await page.clock.fastForward(1_000);
    await expect(page.getByText('Search job creation failed')).toHaveCount(0);

    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => primary.calls).toBe(3);
    await expect(page.getByText('Search job creation failed').first()).toBeVisible();
  });

  test('a succeeding poll does not clear the banner; Refresh does', async ({ page }) => {
    let failing = true;
    await page.clock.install();
    const primary = await mockAlertsApi(page, () => failing);
    await page.goto('/alerts');
    const banner = page.getByText('Search job creation failed').first();
    await expect(banner).toBeVisible();

    failing = false;
    await page.clock.fastForward(30_000);
    await expect.poll(() => primary.calls).toBe(2);
    await page.clock.fastForward(1_000);
    await expect(banner).toBeVisible();

    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect.poll(() => primary.calls).toBe(3);
    await expect(page.getByText('Search job creation failed')).toHaveCount(0);
  });
});

/**
 * Service Detail's alert-history effect reports its failure outside the
 * page load (`report`). A settling page load — including one started by a
 * range change, which that effect does not re-run for — must not wipe it.
 */
test('a sibling panel failure on Service Detail survives the page load and a range change', async ({ page }) => {
  let alertHistoryCalls = 0;
  await page.addInitScript(() => {
    window.CRIBL_BASE_PATH = '/';
    window.CRIBL_API_URL = 'http://127.0.0.1:4173/api/v1';
  });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const body = request.postData() ?? '';
    if (request.method() === 'POST' && body.includes('criblapm_alert') && body.includes('frontend')) {
      alertHistoryCalls += 1;
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: 'injected alert-history failure' }),
      });
      return;
    }
    if (request.url().includes('/search/query')) {
      // Metrics reads: one sample, so Service Detail finds the service.
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: [
          { isFinished: true, totalEventCount: 1, job: { id: 'mq-mock', status: 'completed' } },
          { _kind: 'sample', svc: 'frontend', outcome: 'ok', _time: Math.floor(Date.now() / 1000), _value: 10 },
        ].map((line) => JSON.stringify(line)).join('\n') + '\n',
      });
      return;
    }
    if (request.url().includes('/search/jobs') && request.method() === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ items: [{ id: 'mock-job', status: 'completed' }] }),
      });
      return;
    }
    if (request.url().includes('/results')) {
      await route.fulfill({
        status: 200,
        contentType: 'application/x-ndjson',
        body: `${JSON.stringify({ isFinished: true, totalEventCount: 0 })}\n`,
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // The preview serves relative asset paths, so a deep URL cannot be
  // loaded directly: start at / and route client-side.
  await page.goto('/');
  await page.evaluate(() => {
    window.history.pushState({}, '', '/service/frontend');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: 'frontend' })).toBeVisible();
  await expect.poll(() => alertHistoryCalls).toBeGreaterThan(0);
  const failed = page.getByText('Alert history:', { exact: true });
  await expect(failed).toBeVisible();

  await page.getByRole('button', { name: /Last 1 hour/ }).click();
  await page.getByRole('menuitem', { name: 'Last 15 minutes' }).click();
  await expect(page).toHaveURL(/range=-15m/);
  // Let the range change's page load settle, then the sibling failure must remain.
  await page.waitForTimeout(1_000);
  await expect(failed).toBeVisible();
  expect(alertHistoryCalls).toBe(1); // the alert effect does not re-run on range
});
