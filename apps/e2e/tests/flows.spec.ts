import { expect, test } from '@playwright/test';
import { expectAccessible, PHONES, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

test('a buyer contacts a seller by chat and sees the phone number', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/hilltop/cement');
  await page.locator('a.lcard-title').first().click();
  await page.getByRole('button', { name: 'Show phone number' }).click();
  await expect(page.getByRole('link', { name: /^\+\d+/ })).toBeVisible();
  await page.getByRole('button', { name: 'Chat with seller' }).click();
  const text = `Can you deliver on Friday? ${Date.now()}`;
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForURL(/\/messages\//);
  await expect(page.getByRole('log')).toContainText(text);
  await expectAccessible(page, 'thread');
});

test('a seller posts an ad, a moderator approves it and it goes live', async ({ page }) => {
  const title = `Floor tiling crew ${Date.now().toString(36)}`;
  await signIn(page, PHONES.supplier, '/post');
  await expectAccessible(page, 'post form');
  await page.getByLabel('Category').selectOption('trades');
  await page.getByLabel(/^Title/).fill(title);
  await page.getByLabel(/^Description/).fill('Experienced team with our own cutters. Floors, walls and stairs.');
  await page.getByLabel('Trade').selectOption('tiler');
  await page.getByLabel('Years of experience').fill('8');
  await page.getByLabel('Price', { exact: true }).fill('3500');
  await page.getByLabel('Per', { exact: true }).selectOption('m2');
  await page.getByLabel('Where you are based').selectOption('hilltop');
  await page.getByRole('button', { name: 'Post ad' }).click();
  await expect(page.getByText(/with our reviewers|is live/)).toBeVisible();

  await page.goto('/my-ads');
  await expectAccessible(page, 'my ads');

  await signIn(page, PHONES.moderator, '/moderation');
  const item = page.locator('li.card', { hasText: title });
  await expect(item).toBeVisible();
  await expectAccessible(page, 'moderation queue');
  await item.getByRole('button', { name: 'Record decision' }).click();
  await expect(item.getByText('Approved.')).toBeVisible();

  await page.goto(`/search?q=${encodeURIComponent(title)}`);
  await expect(page.getByRole('link', { name: title })).toBeVisible();
});

test('a seller promotes a live ad through checkout and gets an invoice', async ({ page }) => {
  await signIn(page, PHONES.supplier, '/my-ads');
  await page.getByRole('link', { name: 'Promote' }).first().click();
  await expectAccessible(page, 'promote');
  await page.getByRole('button', { name: /Continue to payment/ }).click();
  await page.waitForURL(/\/checkout\//);
  await page.getByRole('button', { name: 'Pay (simulated)' }).click();
  await page.waitForURL(/\/account\/promotions/);
  const invoice = page.getByRole('link', { name: /^INV-\d{4}-\d{6}$/ }).first();
  await expect(invoice).toBeVisible();
  await invoice.click();
  await page.waitForURL(/\/account\/invoices\//, { timeout: 45_000 }); // first dev-server compile can be slow
  await expect(page.getByRole('heading', { name: /^Invoice INV-/ })).toBeVisible();
  await expectAccessible(page, 'invoice');
});

test('account page lists devices and signing out ends the session', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/account');
  await expect(page.getByText('This device', { exact: true })).toBeVisible();
  await expectAccessible(page, 'account');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await page.waitForURL('/');
  await page.goto('/account');
  await expect(page).toHaveURL(/\/sign-in/);
});
