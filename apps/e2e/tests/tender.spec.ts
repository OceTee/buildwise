import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, PHONES, signIn } from './helpers';

/**
 * Release 3, last slice: the client issues a sealed tender for a trade package, two seeded suppliers bid, the bids
 * stay sealed until they are opened together at the deadline, the client evaluates and awards a contract, the
 * supplier's priced variation is approved (a new award revision) and a milestone payment is recorded.
 *
 * The deadline is real: start the API with MIN_RESPONSE_MINUTES=1 (development only) so a tender can close within
 * minutes. Without it the API refuses deadlines under the pack's three days and this file is skipped.
 */
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const TITLE = `Slab works tender ${RUN}`;
const LINE = 'Cement 42.5 in 50 kg bags';
let projectId = '';
let tenderUrl = '';
let deadline = 0;

async function api(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(`/api${path}`, { method, data, headers: data ? { 'content-type': 'application/json' } : {} });
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`);
  return r.json();
}

test('the client issues a sealed tender to two invited bidders', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, PHONES.buyer, '/projects');
  const cfg = await api(page, 'GET', '/v1/procurement-config');
  test.skip(cfg.minResponseMinutes == null, 'Start the API with MIN_RESPONSE_MINUTES=1 to run the tender flow against a real deadline.');
  const projects = await api(page, 'GET', '/v1/projects');
  projectId = projects.items.find((p: { name: string }) => p.name === 'Demo bungalow').id;
  const e = await api(page, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: `Tender BoQ ${RUN}` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: `description,qty,unit,section,specification\n${LINE},60,bag,substructure,Grade 42.5` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/share`, {});

  await page.goto(`/projects/${projectId}/suppliers`);
  await expect(page.getByRole('heading', { name: /Supplier lists for/ })).toBeVisible();
  await expectAccessible(page, 'supplier lists');

  await page.goto(`/projects/${projectId}/rfqs`);
  await page.getByLabel('Type').selectOption('tender');
  await expect(page.getByRole('heading', { name: 'New sealed tender' })).toBeVisible();
  await page.getByLabel('Title', { exact: true }).fill(TITLE);
  const scope = page.getByLabel('Scope', { exact: true });
  await scope.selectOption((await scope.locator('option', { hasText: `Tender BoQ ${RUN}` }).getAttribute('value'))!);
  await page.getByLabel('Category').selectOption('cement');
  // Three minutes is enough for both bids; the deadline is entered in the browser's own time zone.
  const local = await page.evaluate(() => { const d = new Date(Date.now() + 3 * 60_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); });
  deadline = await page.evaluate((v) => new Date(v).getTime(), local);
  await page.getByLabel('Bid deadline').fill(local);
  await page.getByLabel('Who can bid').selectOption('invited');
  await page.getByLabel('Scope of work').fill('Supply and place cement for the ground-floor slab, with offloading to the site store.');
  await expectAccessible(page, 'new tender form');
  await page.getByRole('button', { name: 'Create draft tender' }).click();
  await page.waitForURL(/\/rfqs\/[0-9a-f-]{36}$/);
  tenderUrl = new URL(page.url()).pathname;
  await expect(page.getByRole('heading', { name: 'Trade package' })).toBeVisible();

  await page.getByRole('button', { name: 'Find eligible suppliers' }).click();
  await page.getByLabel('Invite Hilltop Building Supplies').check();
  await page.getByLabel('Invite Old Town Cement Depot').check();
  await page.getByRole('button', { name: 'Invite selected (2)' }).click();
  await expect(page.getByText('2 invited.')).toBeVisible();
  await expectAccessible(page, 'draft tender');
  await page.getByRole('button', { name: 'Publish tender' }).click();
  await expect(page.getByText(/Published\. 2 bidders invited/)).toBeVisible();
});

async function submitBid(page: Page, phone: string, price: string) {
  await signIn(page, phone, '/provider/rfqs');
  await page.getByRole('link', { name: new RegExp(TITLE) }).click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Trade package' })).toBeVisible();
  await page.getByRole('button', { name: 'Start a bid' }).click();
  await page.getByLabel(new RegExp(`Unit price for ${LINE}`)).fill(price);
  await page.getByLabel(/^Start date/).fill(await page.evaluate(() => new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10)));
  await page.getByLabel(/^Programme \(weeks\)/).fill('3');
  await page.getByLabel(/^Method statement/).fill('Deliver in two drops by flatbed, offload to the covered store, waybill with every drop.');
  await page.getByLabel(/^Inclusions/).fill('Offloading\nWaybills');
  await page.getByLabel('Qualifications and references').fill('Eight years supplying slabs in Hilltop; references on request.');
  await page.getByLabel('Warranty and defects terms').fill('Replace any damaged bag within 7 days.');
  await page.getByLabel(/no conflict of interest with the client/).check();
  await expectAccessible(page, 'bid form');
  await page.getByRole('button', { name: 'Submit sealed bid' }).click();
  await expect(page.getByText(/Bid submitted and sealed/)).toBeVisible();
}

test('the first supplier bids', async ({ page }) => { test.skip(!tenderUrl, 'Tender not created.'); await submitBid(page, PHONES.supplier, '9400'); });
test('the second supplier bids', async ({ page }) => { test.skip(!tenderUrl, 'Tender not created.'); await submitBid(page, PHONES.supplier2, '9100'); });

test('the bids stay sealed until the deadline, then open together with an opening record', async ({ page }) => {
  test.skip(!tenderUrl, 'Tender not created.');
  test.setTimeout(420_000);
  await signIn(page, PHONES.buyer, tenderUrl);
  if (Date.now() < deadline - 15_000) {
    await expect(page.getByText(/Bids are sealed until they are opened together/)).toBeVisible();
    await expect(page.getByText(/2 bids received/)).toBeVisible();
    await page.getByRole('link', { name: 'Bid status' }).click();
    await expect(page.getByText(/you see how many arrived, not their prices/)).toBeVisible();
    await expect(page.getByText('9,100')).toHaveCount(0);
    await page.goto(tenderUrl);
  }
  // Wait for the deadline; the client opens the bids (or BuildWise's worker already has).
  await page.waitForTimeout(Math.max(0, deadline - Date.now() + 2_000));
  await expect(async () => {
    await page.reload();
    const open = page.getByRole('button', { name: 'Open the bids' });
    if (await open.isVisible()) await open.click();
    await expect(page.getByRole('heading', { name: 'Opening record' })).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000, intervals: [3_000, 5_000, 10_000] });
  const register = page.locator('section', { has: page.getByRole('heading', { name: 'Opening record' }) });
  await expect(register.getByText('Hilltop Building Supplies')).toBeVisible();
  await expect(register.getByText('Old Town Cement Depot')).toBeVisible();
  await expect(register.getByText(/2 bids opened together at the deadline/)).toBeVisible();
  await expectAccessible(page, 'opened tender');
});

test('the client declares interests, scores, and awards a contract', async ({ page }) => {
  test.skip(!tenderUrl, 'Tender not created.');
  await signIn(page, PHONES.buyer, `${tenderUrl}/compare`);
  await expect(page.getByRole('heading', { name: /Compare bids/ })).toBeVisible();
  await expect(page.getByText(/Lowest total: Old Town Cement Depot/)).toBeVisible();
  await page.getByLabel('I have no conflict of interest with any bidder').check();
  await page.getByRole('button', { name: 'Record declaration' }).click();
  await expect(page.getByRole('button', { name: 'Save scores for Old Town Cement Depot' })).toBeVisible();
  await page.getByRole('button', { name: 'Save scores for Old Town Cement Depot' }).click();
  await expect(page.getByText('Scores saved for Old Town Cement Depot.')).toBeVisible();
  await expectAccessible(page, 'bid evaluation');
  await page.getByRole('button', { name: 'Award to Old Town Cement Depot' }).click();
  await page.getByRole('button', { name: 'Confirm award to Old Town Cement Depot' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: /^Contract CT-\d+/ })).toBeVisible();
  await expect(page.getByText(/5% held on each signed-off milestone/)).toBeVisible();
  await page.getByText('Add a milestone').click();
  await page.getByLabel('Milestone', { exact: true }).fill('First drop delivered');
  await page.getByLabel('Amount', { exact: true }).fill('200000');
  await page.getByRole('button', { name: 'Add milestone' }).click();
  await expect(page.getByRole('heading', { name: /1\. First drop delivered/ })).toBeVisible();
  await expectAccessible(page, 'contract');
});

test('the supplier confirms, proposes a priced variation and claims the milestone', async ({ page }) => {
  test.skip(!tenderUrl, 'Tender not created.');
  await signIn(page, PHONES.supplier2, '/provider/rfqs');
  await page.getByRole('link', { name: new RegExp(`CT-\\d+ · ${TITLE}`) }).click();
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText('Confirmed by supplier')).toBeVisible();
  await page.getByText('Propose a variation').click();
  await page.getByLabel('Variation', { exact: true }).fill('Ten more bags for the ramp');
  await page.getByLabel('Change in scope').fill('Ten extra bags of cement for the garage ramp added on site.');
  await page.getByLabel('Why it is needed').fill('Ramp added by the client');
  await page.getByLabel(/^Cost impact/).fill('91000');
  await page.getByLabel('Time impact (days)').fill('1');
  await page.getByRole('button', { name: 'Send variation for decision' }).click();
  await expect(page.getByText('Sent to the client for a decision.')).toBeVisible();
  await page.getByRole('button', { name: 'Start work for First drop delivered' }).click();
  await expect(page.getByLabel('What was done (shown to the client)')).toBeVisible();
  await page.getByLabel('What was done (shown to the client)').fill('First drop of 30 bags offloaded, waybill WB-31');
  await page.getByRole('button', { name: 'Ask for sign-off for First drop delivered' }).click();
  await expect(page.getByText('Sent to the client for sign-off.')).toBeVisible();
  await expectAccessible(page, 'provider contract');
});

test('the client approves the variation, signs off the milestone and records a payment against it', async ({ page }) => {
  test.skip(!tenderUrl, 'Tender not created.');
  await signIn(page, PHONES.buyer, '/projects');
  const list = await api(page, 'GET', `/v1/projects/${projectId}/rfqs`);
  const order = list.orders.find((o: { reference: string; provider: string }) => o.reference.startsWith('CT-') && o.provider === 'Old Town Cement Depot');
  await page.goto(`/projects/${projectId}/orders/${order.id}`);
  await page.getByRole('button', { name: /Approve variation/ }).click();
  await expect(page.getByText('Approved. A new revision of the award was recorded.')).toBeVisible();
  const revisions = page.getByRole('table', { name: 'Revisions of the award' });
  await expect(revisions.getByRole('cell', { name: 'Variation approved: Ten more bags for the ramp' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign off as complete for First drop delivered' }).click();
  await expect(page.getByText('Signed off. You can now record a payment against it.')).toBeVisible();
  await page.getByText('Record a payment you made to the supplier').click();
  await page.getByLabel('Amount paid').fill('190000');
  await page.getByLabel(/^For milestone/).selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Payment recorded. The supplier can confirm they received it.')).toBeVisible();
  await expect(page.getByText(/for milestone First drop delivered/)).toBeVisible();
  await expect(page.getByText(/does not process, hold or protect/).first()).toBeVisible();
  await expectAccessible(page, 'contract after payment');
});
