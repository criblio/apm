import { expect, test } from '@playwright/test';
import { apmFrame, gotoApm, installCriblHostGlobals } from './helpers/apmSession';

test('nightly metrics responses populate APM views', async ({ page }) => {
  await installCriblHostGlobals(page);
  await gotoApm(page, '/');
  const app = apmFrame(page);

  await app.getByText('Services', { exact: true }).first().click();
  await expect(app.getByText(/^Services \([1-9]\d*\)$/)).toBeVisible({ timeout: 20_000 });

  await app.getByText('Metrics', { exact: true }).first().click();
  await expect(app.getByText('http_server_duration_milliseconds', { exact: true }).first())
    .toBeVisible({ timeout: 20_000 });
});
