import { expect, test } from '@playwright/test';
import { PHONES, expectAccessible, signIn } from './helpers';

test.describe.configure({ timeout: 180_000 });

test('the welcome screen asks what to build and offers the marketplace to shoppers', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: /What would you like to build today/ })).toBeVisible();
  await expectAccessible(page, 'welcome');
  await page.getByRole('link', { name: /Just shopping/ }).click();
  await expect(page).toHaveURL(/\/market$/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Everything your build needs');
});

test('from an idea to a 3D design, a bill of materials and where to buy it', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Describe what you want to build').fill('A 3 bedroom bungalow on a 50 by 100 ft plot');
  await page.keyboard.press('Enter');

  // The assistant read the plot and the brief, so the builder opens on "Your home" with the plot in 3D.
  await expect(page.getByRole('heading', { level: 1, name: 'Tell us about your home' })).toBeVisible({ timeout: 90_000 });
  await expect(page.getByRole('img', { name: /3D model of a 15.24 m by 30.48 m plot/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('15.24 × 30.48 m', { exact: false })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Bedrooms' }).locator('output')).toHaveText('3');
  await expectAccessible(page, 'build: your home');

  // Changing the brief updates the design live.
  await page.getByRole('button', { name: 'More bedrooms' }).click();
  await expect(page.getByRole('group', { name: 'Bedrooms' }).locator('output')).toHaveText('4');
  await page.getByRole('button', { name: /^See \d design/ }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Choose a design' })).toBeVisible();
  await expect(page.getByText(/Architect.s checklist/)).toBeVisible();
  await expect(page.locator('.check-row.fail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ground floor plan' }).click();
  await expect(page.locator('.scene-room').first()).toBeAttached();
  await expectAccessible(page, 'build: designs');

  await page.getByRole('button', { name: 'List the materials' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Everything you need to build it' })).toBeVisible();
  const cement = page.getByRole('row', { name: /Cement \(50 kg bags\)/ });
  await expect(cement).toContainText(/\d+ bag/);
  await expect(page.getByRole('row', { name: /Sandcrete blocks, 9 inch/ })).toContainText(/piece/);
  await expectAccessible(page, 'build: materials');

  await page.getByRole('button', { name: 'Find where to buy' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Where to buy/ })).toBeVisible();
  // The seeded marketplace sells cement, so at least that line is priced from a live listing.
  await expect(page.getByText(/for the [1-9]\d* of \d+ items with a matching price/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.offer').first()).toBeVisible();
  await expectAccessible(page, 'build: where to buy');
});

test('entering the land size by hand draws the plot to scale', async ({ page }) => {
  await page.goto('/build');
  await page.evaluate(() => localStorage.removeItem('bw-build-v1'));
  await page.reload();
  await page.getByRole('button', { name: 'Land' }).click().catch(() => undefined);
  await page.getByText('Metres', { exact: true }).click();
  await page.getByLabel('Width (frontage), m').fill('20');
  await page.getByLabel('Depth, m').fill('40');
  await expect(page.getByRole('img', { name: /3D model of a 20 m by 40 m plot/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('status').filter({ hasText: '800 m²' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /Do you already have an architectural plan/ })).toBeVisible();
});

test('the assistant answers building questions and declines anything else', async ({ page }) => {
  await page.goto('/build');
  await page.evaluate(() => localStorage.removeItem('bw-build-v1'));
  await page.reload();
  const box = page.getByLabel('Message the BuildWise assistant');
  await box.fill('How many blocks can one bag of cement make?');
  await box.press('Enter');
  await expect(page.locator('.bubble.assistant').last()).toContainText('moulds', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Helpful', exact: true }).last().click();
  await expect(page.getByRole('button', { name: 'Helpful', exact: true }).last()).toHaveAttribute('aria-pressed', 'true');
  await box.fill('tell me a joke');
  await box.press('Enter');
  await expect(page.locator('.bubble.assistant').last()).toContainText('only help with building');
});

test('staff can see what the assistant is learning', async ({ page }) => {
  await signIn(page, PHONES.ops, '/moderation/assistant');
  await expect(page.getByRole('heading', { level: 1, name: 'BuildWise assistant' })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Held-out test accuracy')).toBeVisible();
  await expectAccessible(page, 'staff: assistant');
});
