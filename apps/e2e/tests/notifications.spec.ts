import { expect, test } from '@playwright/test';
import { expectAccessible, PHONES, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

/**
 * People hear about things on time (spec §16): the seller's notification is written with the message itself, so it
 * is there at once, without any scheduled worker run.
 */
test('a seller sees a buyer’s new chat message straight away and reading the thread clears it', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/seller/hilltop-building-supplies');
  await page.locator('a.lcard-title').first().click();
  await page.getByRole('button', { name: 'Chat with seller' }).click();
  const text = `Is this in stock this week? ${Date.now()}`;
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.waitForURL(/\/messages\//);
  const threadPath = new URL(page.url()).pathname;

  await signIn(page, PHONES.supplier, '/account');
  await expect(page.getByRole('link', { name: /unread notifications/ })).toBeVisible();
  const note = page.getByRole('link', { name: /new messages? from/i }).and(page.locator(`a[href="${threadPath}"]`));
  await expect(note).toHaveCount(1);
  await expect(page.getByRole('heading', { name: 'Email and SMS copies' })).toBeVisible();
  await expectAccessible(page, 'account notifications');

  await note.click();
  await page.waitForURL(threadPath);
  await expect(page.getByRole('log')).toContainText(text);

  await page.goto('/account');
  // Read now: the thread's notification is no longer shown as unread (bold).
  await expect(page.locator(`li:has(> a[href="${threadPath}"])`).first()).toHaveCSS('font-weight', '400');
});

test('notification copies can be switched per topic', async ({ page }) => {
  await signIn(page, PHONES.supplier, '/account');
  const sms = page.getByRole('group', { name: /Chat messages/ }).getByLabel('SMS');
  await expect(sms).not.toBeChecked();
  await sms.check();
  await page.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('group', { name: /Chat messages/ }).getByLabel('SMS')).toBeChecked();
  await page.getByRole('group', { name: /Chat messages/ }).getByLabel('SMS').uncheck();
  await page.getByRole('button', { name: 'Save notification settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
});
