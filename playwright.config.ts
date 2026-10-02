import { defineConfig, devices } from '@playwright/test';
import { loadTestEnv } from '@criblio/app-tooling/playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// .env next to this file; values already in the environment (CI secrets) win.
loadTestEnv(resolve(__dirname, '.env'));

export const AUTH_FILE = 'playwright/.auth/cribl-cloud.json';

const baseURL = (process.env.CRIBL_BASE_URL ?? '').replace(/\/$/, '');
if (!baseURL) {
  throw new Error(
    'CRIBL_BASE_URL is not set. Add it to .env (see .env.example) before running playwright.',
  );
}

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts$/,
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: AUTH_FILE,
      },
    },
  ],
});
