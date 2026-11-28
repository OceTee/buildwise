import { expect, test } from '@playwright/test';
import { PHONES, expectAccessible, signIn } from './helpers';

/** Public-beta readiness: policy pages from the footer, the beta banner, and feedback from the form to the staff list. */
const POLICIES = [
  { link: 'Terms of use', path: '/terms', h1: 'Terms of use' },
  { link: 'Privacy notice', path: '/privacy', h1: 'Privacy notice' },
  { link: 'Cookies', path: '/cookies', h1: 'Cookies' },
  { link: 'Posting rules', path: '/help/posting-rules', h1: 'Posting rules' },
  { link: 'Prohibited items', path: '/help/prohibited-items', h1: 'Prohibited and restricted items' },
];

test('the footer links to every policy page, the contact page and the feedback form', async ({ page }) => {
  for (const p of [...POLICIES, { link: 'Contact and support', path: '/contact', h1: 'Contact and support' }, { link: 'Send feedback', path: '/feedback', h1: 'Send feedback' }]) {
    await page.goto('/');
    await page.locator('footer').getByRole('link', { name: p.link, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${p.path.replace(/\//g, '\\/')}$`));
    await expect(page.getByRole('heading', { level: 1, name: p.h1 })).toBeVisible();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });
    for (const p of [...POLICIES, { path: '/contact', h1: 'Contact and support' }, { path: '/feedback', h1: 'Send feedback' }]) {
      test(`${p.path} loads and passes accessibility checks`, async ({ page }) => {
        const res = await page.goto(p.path);
        expect(res?.status()).toBe(200);
        await expect(page.getByRole('heading', { level: 1, name: p.h1 })).toBeVisible();
        if (p.path !== '/feedback') await expect(page.getByRole('note').filter({ hasText: 'Draft for the public beta, pending legal review.' })).toBeVisible();
        await expectAccessible(page, `${scheme} ${p.path}`);
      });
    }
  });
}

test('the prohibited items page is built from the market pack', async ({ page }) => {
  await page.goto('/help/prohibited-items');
  await expect(page.getByRole('heading', { level: 3, name: 'Land, plots and property' })).toBeVisible();
  await expect(page.getByText(/certificate of occupancy/)).toBeVisible();
  await page.goto('/help/posting-rules');
  await expect(page.getByRole('rowheader', { name: 'Cement', exact: true })).toBeVisible();
});

test('the beta banner says figures are illustrative, closes for the session, but stays on checkout pages', async ({ page }) => {
  await page.goto('/terms');
  const banner = page.getByRole('region', { name: 'Public beta' });
  await expect(banner).toContainText('illustrative');
  await banner.getByRole('button', { name: /Close the beta notice/ }).click();
  await expect(banner).toBeHidden();
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { level: 1, name: 'Privacy notice' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Public beta' })).toBeHidden();
  await page.goto('/checkout/not-a-real-reference');
  const kept = page.getByRole('region', { name: 'Public beta' });
  await expect(kept).toBeVisible();
  await expect(kept.getByRole('button')).toHaveCount(0);
});

test('feedback sent from the banner reaches the staff list, where it is triaged', async ({ page }) => {
  // Letters only: a long run of digits would itself be removed as a phone number.
  const tag = Date.now().toString(36).replace(/\d/g, (d) => 'abcdefghij'[Number(d)]!);
  const note = `The drawings page cut off my plan on a phone ${tag}`;
  await page.goto('/help/posting-rules');
  await page.getByRole('region', { name: 'Public beta' }).getByRole('link', { name: 'Send feedback' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Send feedback' })).toBeVisible();
  await expect(page.locator('code', { hasText: '/help/posting-rules' })).toBeVisible();
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.getByText('Tell us a little more')).toBeVisible();
  await page.getByLabel('Something is not working').check();
  await page.getByLabel('What were you doing, and what went wrong?').fill(`${note}. Call me on 0803 123 4567.`);
  await page.getByLabel('You may contact me about this feedback').check();
  await page.getByLabel(/Email or phone for a reply/).fill('reporter@example.test');
  await page.getByRole('button', { name: 'Send feedback' }).click();
  await expect(page.getByText('Thank you. We have your feedback.')).toBeVisible();
  await expect(page.getByText(/We removed a phone number or email address/)).toBeVisible();

  await signIn(page, PHONES.moderator, '/moderation/feedback');
  await page.goto('/moderation/feedback');
  const card = page.locator('li.card', { hasText: note });
  await expect(card).toContainText('[number]');
  await expect(card).toContainText('reporter@example.test');
  await expect(card).toContainText('/help/posting-rules');
  await expectAccessible(page, 'staff feedback list');
  await card.getByLabel(/Staff note/).fill('Reproduced on a small screen.');
  await card.getByRole('button', { name: 'Mark triaged' }).click();
  // Triaged feedback leaves the open list.
  await expect(page.locator('li.card', { hasText: note })).toHaveCount(0);
  await page.goto('/moderation/feedback?status=triaged');
  await expect(page.locator('li.card', { hasText: note })).toContainText('Reproduced on a small screen.');
});
