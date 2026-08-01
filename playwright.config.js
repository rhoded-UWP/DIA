import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? 'line' : [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    // Downloads are the product here, so they have to be accepted rather than blocked.
    acceptDownloads: true,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    // The same server used in development, so the tests run against the real CSP
    // rather than a permissive test harness.
    command: 'node tools/serve.js',
    port: PORT,
    env: { PORT: String(PORT) },
    reuseExistingServer: false,
    stdout: 'ignore',
  },
});
