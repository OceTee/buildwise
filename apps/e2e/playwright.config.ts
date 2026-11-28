import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests against the real web app and API. Locally they reuse servers already started with
 * `pnpm dev` (after `pnpm seed`); in CI they start both, seeding a fresh embedded database first.
 */
const WEB = process.env.E2E_WEB_URL ?? 'http://localhost:3000';
/** The API's health URL (set when reusing an API started on another port). */
const API_HEALTH = process.env.E2E_API_HEALTH_URL ?? 'http://localhost:4000/health';

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
      url: API_HEALTH,
      // Tests never call paid AI: the local assistant and the design engine answer.
      // MIN_RESPONSE_MINUTES (development only) lets the tender test reach a real deadline in minutes.
      env: { OTP_LIMIT_PER_HOUR: '1000', RATE_LIMIT_PER_MINUTE: '100000', BROWSE_PER_MINUTE: '100000', FILES_PER_MINUTE: '100000', HEALTH_PER_MINUTE: '100000', MIN_RESPONSE_MINUTES: '1', BUILDER_AI_PROVIDER: 'none', ARCHITECT_PROVIDER: 'none', RENDER_PROVIDER: 'none', DESIGNER_PROVIDER: 'none', DREAM_PROVIDER: 'none', ASSISTANT_PROVIDER: 'none', CRITIQUE_PROVIDER: 'designer' },
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
