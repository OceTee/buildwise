import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real web app and API. Locally they reuse servers already started with
 * `pnpm dev` (after `pnpm seed`); in CI they start both, seeding a fresh embedded database first.
 */
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: { baseURL: WEB, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /public\.spec\.ts/ },
  ],
  webServer: [
    {
      command: 'pnpm --filter @bw/api seed && pnpm --filter @bw/api start',
      url: 'http://localhost:4000/health',
      env: { OTP_LIMIT_PER_HOUR: '1000', RATE_LIMIT_PER_MINUTE: '100000' },
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      cwd: '../..',
    },
    {
      command: 'pnpm --filter @bw/web dev',
      url: `${WEB}/robots.txt`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      cwd: '../..',
    },
  ],
});
