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
