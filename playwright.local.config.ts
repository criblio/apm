import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/local',
  workers: 1,
  reporter: 'list',
  webServer: {
    command: 'npm run preview -- --host 127.0.0.1 --port 4173',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
  },
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:4173',
  },
});
