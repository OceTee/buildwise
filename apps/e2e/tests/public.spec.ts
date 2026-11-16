import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';

const PAGES = ['/', '/market', '/build', '/search?q=cement', '/search?category=cement&sort=price_asc', '/hilltop/cement', '/help', '/help/safety', '/help/selling', '/sign-in'];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    for (const path of PAGES) {
      test(`${path} renders and passes accessibility checks`, async ({ page }) => {
        const res = await page.goto(path);
        expect(res?.status()).toBe(200);
        await expect(page.locator('h1')).toBeVisible();
        await expectAccessible(page, `${scheme} ${path}`);
      });
    }
    test('a listing page and its seller page', async ({ page }) => {
      await page.goto('/hilltop/cement');
      await page.locator('a.lcard-title').first().click();
      await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(1);
      await expect(page.getByRole('link', { name: 'Sign in to contact' })).toBeVisible();
      await expectAccessible(page, `${scheme} listing`);
      await page.getByRole('heading', { level: 2 }).getByRole('link').first().click();
      await expect(page).toHaveURL(/\/seller\//);
      await expectAccessible(page, `${scheme} seller`);
    });
  });
}

test('price sorting groups listings by comparable unit', async ({ page }) => {
  await page.goto('/search?category=cement&sort=price_asc');
  await expect(page.getByRole('heading', { name: 'Compared per kg' })).toBeVisible();
});

test('search engines get a sitemap and robots rules, and unknown pages are 404', async ({ page, request }) => {
  expect((await request.get('/robots.txt')).status()).toBe(200);
  const sm = await request.get('/sitemap.xml');
  expect(await sm.text()).toContain('/listing/');
  expect((await page.goto('/nowhere/cement'))?.status()).toBe(404);
});

test('skip link moves focus to the main content', async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
});
