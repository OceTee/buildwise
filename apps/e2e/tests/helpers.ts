import AxeBuilder from '@axe-core/playwright';
import { expect, type Cookie, type Page } from '@playwright/test';

/** Seeded demo accounts (see apps/api/src/seed.ts). Development codes are shown on the sign-in page. */
export const PHONES = { moderator: '08000000001', moderator2: '08000000002', ops: '08000000003', supplier: '08011111111', supplier2: '08077777777', buyer: '08055555555', architect: '08066666666' };

// One sign-in per account per run keeps tests inside the real per-number code limit.
const sessions = new Map<string, Cookie[]>();

export async function signIn(page: Page, phone: string, next = '/') {
  await page.context().clearCookies();
  const cached = sessions.get(phone);
  if (cached) {
    await page.context().addCookies(cached);
    await page.goto(next);
    if (!page.url().includes('/sign-in')) return;
    await page.context().clearCookies();
  }
  await page.goto(`/sign-in?next=${encodeURIComponent(next)}`);
  await page.getByLabel('Mobile number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  const hint = page.getByText(/your code is \d{6}/);
  await expect(hint, 'the sign-in code was not issued (check the API is running with EXPOSE_OTP and the code limit)').toBeVisible();
  const code = (await hint.textContent())!.match(/(\d{6})/)![1]!;
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  // The redirect can race the dev server's first compile of a page; wait on the condition, not one navigation event.
  await expect(page).not.toHaveURL(/\/sign-in/, { timeout: 90_000 });
  await page.waitForLoadState();
  sessions.set(phone, await page.context().cookies());
}

/** WCAG 2.2 AA scan; fails on serious or critical violations. */
export async function expectAccessible(page: Page, label: string) {
  // Next streams metadata after client-side navigation; wait for the real title before scanning.
  await expect(page).toHaveTitle(/BuildWise/);
  // No sideways scrolling: content must fit the viewport (WCAG 1.4.10 reflow).
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `${label}: page is ${overflow}px wider than the viewport`).toBeLessThanOrEqual(1);
  // Scan from the top: a sticky header or tab bar sits over whatever was last scrolled under it, and axe would report
  // those controls as too small (target-size) depending only on where the test last scrolled.
  await page.evaluate(() => window.scrollTo(0, 0));
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(bad.map((v) => `${label}: ${v.id} (${v.impact}) ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}
