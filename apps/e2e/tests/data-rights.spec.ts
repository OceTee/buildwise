import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { expectAccessible, PHONES, signIn } from './helpers';

/**
 * Public beta, data rights and staff access (spec §7.6, §19.1, §20): a person downloads their data from the account
 * page, and an operations admin (after the two-step check) grants and revokes a staff role with a reason.
 */
test('a signed-in person downloads their data from the account page', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/account');
  await expect(page.getByRole('heading', { name: 'Your data' })).toBeVisible();
  await expect(page.getByText('The audit log (7 years, append-only).')).toBeVisible();
  await expectAccessible(page, 'account with data rights');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download my data' }).click()]);
  expect(download.suggestedFilename()).toMatch(/^buildwise-data-\d{4}-\d{2}-\d{2}\.json$/);
  const archive = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(archive.format).toBe('buildwise-export/v1');
  expect(archive.profile.phone).toMatch(/5555555$/);
  // Nothing from the seeded staff or sellers' own accounts.
  expect(JSON.stringify(archive)).not.toContain('8000000001');
  await expect(page.getByText(/Your data is downloading/)).toBeVisible();
});

test('an operations admin grants and revokes a staff role, after the two-step check', async ({ browser, page }) => {
  // The person to grant needs an account: sign up a fresh number in a separate browser context.
  const phone = `0809${String(Date.now()).slice(-7)}`;
  const name = `Beta Moderator ${phone.slice(-4)}`;
  const other = await browser.newContext();
  const p2 = await other.newPage();
  await p2.goto('/sign-in?next=/account');
  await p2.getByLabel('Mobile number').fill(phone);
  await p2.getByRole('button', { name: 'Send code' }).click();
  const code = (await p2.getByText(/your code is \d{6}/).textContent())!.match(/(\d{6})/)![1]!;
  await p2.getByLabel('6-digit code').fill(code);
  await p2.getByRole('button', { name: 'Continue' }).click();
  await p2.getByLabel(/Your name/).fill(name);
  await p2.getByRole('button', { name: 'Create account' }).click();
  await expect(p2).toHaveURL(/\/account/, { timeout: 60_000 });
  await other.close();

  await signIn(page, PHONES.ops, '/moderation/staff');
  await expect(page.getByRole('heading', { name: 'Staff roles' })).toBeVisible();
  await expectAccessible(page, 'staff roles');
  await page.getByLabel('Their mobile number').fill(phone);
  await page.getByLabel('Role', { exact: true }).selectOption('moderator');
  await page.getByLabel(/^Reason/).fill('Joining the beta moderation team');
  await page.getByRole('button', { name: 'Grant role' }).click();
  await expect(page.getByText('Role granted.')).toBeVisible();
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toContainText('Moderator');
  await expect(row).toContainText('Not yet');

  await row.getByRole('button', { name: `Revoke role: ${name}` }).click();
  const why = `Testing the revoke path ${phone.slice(-4)}`;
  await row.getByLabel('Reason', { exact: true }).fill(why);
  await row.getByRole('button', { name: 'Revoke role' }).click();
  await expect(page.getByRole('row', { name: new RegExp(name) })).toHaveCount(0);
  await expect(page.getByText(`“${why}”`)).toBeVisible();
});

test('the two-step page is accessible', async ({ page }) => {
  await signIn(page, PHONES.moderator, '/moderation');
  await page.goto('/account/two-step?next=/moderation');
  await expect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
  await expectAccessible(page, 'two-step');
});
