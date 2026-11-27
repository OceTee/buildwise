import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, PHONES, signIn } from './helpers';

/**
 * Release 3, third slice: a contested discrepancy becomes a case that staff triage, propose and decide; the supplier
 * appeals once and a different moderator decides the appeal. After the order completes both sides review each other,
 * and the provider profile shows the delivery record (small samples as counts) and the order review. The order up to
 * the inspection is set up through the API (slices 1 and 2 have their own e2e flows).
 */
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const LINE = 'Cement 42.5 in 50 kg bags';
let projectId = '';
let orderId = '';
let caseRef = '';
let caseHref = '';
let providerHandle = '';

async function api(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(`/api${path}`, { method, data, headers: data ? { 'content-type': 'application/json' } : {} });
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`);
  return r.json();
}
const clientOrder = () => `/projects/${projectId}/orders/${orderId}`;
const providerOrder = () => `/provider/orders/${orderId}`;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const delivery = async (page: Page) => (await api(page, 'GET', `/v1/orders/${orderId}/fulfilment`)).deliveries[0];

test('an order is delivered short and the inspection raises a shortage', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/projects');
  projectId = (await api(page, 'GET', '/v1/projects')).items.find((p: { name: string }) => p.name === 'Demo bungalow').id;
  const e = await api(page, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: `Case list ${RUN}` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: `description,qty,unit,section,specification\n${LINE},40,bag,substructure,Grade 42.5` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/share`, {});
  const rfqId = (await api(page, 'POST', `/v1/projects/${projectId}/rfqs`, { title: `Case cement ${RUN}`, categorySlug: 'cement', estimateVersionId: e.versionId, deadline: inDays(5), sourcingMode: 'open' })).id;
  const rv = async () => (await api(page, 'GET', `/v1/rfqs/${rfqId}`)).version;
  await api(page, 'POST', `/v1/rfqs/${rfqId}/commands/publish`, { expectedVersion: await rv() });

  await signIn(page, PHONES.supplier2, '/provider/rfqs');
  const lineKey = (await api(page, 'GET', `/v1/rfqs/${rfqId}`)).lines[0].lineKey;
  const d = await api(page, 'POST', `/v1/rfqs/${rfqId}/quotes`);
  const draft = await api(page, 'GET', `/v1/quote-versions/${d.versionId}`);
  await api(page, 'PUT', `/v1/quote-versions/${d.versionId}`, {
    expectedVersion: draft.version, validUntil: inDays(20).slice(0, 10), deliveryCharge: '10000', deliveryTaxRatePct: 7.5, paymentTerms: 'Pay on delivery',
    lines: [{ rfqLineKey: lineKey, status: 'priced', unit: 'bag', quantity: '40', unitPrice: '9200', taxRatePct: 7.5 }],
  });
  await api(page, 'POST', `/v1/quote-versions/${d.versionId}/submit`, { expectedVersion: (await api(page, 'GET', `/v1/quote-versions/${d.versionId}`)).version });

  await signIn(page, PHONES.buyer, '/projects');
  await api(page, 'POST', `/v1/rfqs/${rfqId}/commands/close`, { expectedVersion: await rv() });
  orderId = (await api(page, 'POST', `/v1/rfqs/${rfqId}/award`, { quoteVersionId: d.versionId, expectedVersion: await rv() })).orderId;
  providerHandle = (await api(page, 'GET', `/v1/orders/${orderId}`)).provider.handle;

  await signIn(page, PHONES.supplier2, '/provider/rfqs');
  await api(page, 'POST', `/v1/orders/${orderId}/commands/confirm`, { expectedVersion: (await api(page, 'GET', `/v1/orders/${orderId}`)).version });
  await signIn(page, PHONES.buyer, '/projects');
  await api(page, 'POST', `/v1/orders/${orderId}/deliveries`, { date: inDays(1).slice(0, 10), slot: 'morning', lines: [{ lineKey, quantity: '40' }] });
  await signIn(page, PHONES.supplier2, '/provider/rfqs');
  let del = await delivery(page);
  await api(page, 'POST', `/v1/deliveries/${del.id}/dispatch`, { expectedVersion: del.version, consignmentRef: `WB-${RUN}`, lines: [{ lineKey, quantity: '40' }] });
  await api(page, 'POST', `/v1/deliveries/${del.id}/arrive`, { expectedVersion: (await delivery(page)).version });
  await signIn(page, PHONES.buyer, '/projects');
  await api(page, 'POST', `/v1/deliveries/${del.id}/receive`, { expectedVersion: (await delivery(page)).version, receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), lines: [{ lineKey, quantity: '38' }] });
  await api(page, 'POST', `/v1/deliveries/${del.id}/inspect`, { expectedVersion: (await delivery(page)).version, lines: [{ lineKey, accepted: '38', rejected: '0' }] });
  del = await delivery(page);
  expect(del.discrepancies[0]).toMatchObject({ kind: 'shortage', quantity: '2', state: 'open' });
});

test('the supplier contests the shortage and it becomes a case', async ({ page }) => {
  await signIn(page, PHONES.supplier2, providerOrder());
  await page.getByLabel(/Your answer/).fill('Our loading tally shows 40 bags left the yard');
  await page.getByRole('button', { name: 'Contest' }).click();
  const done = page.getByText(/Contested\. Case CASE-\d+ is open/);
  await expect(done).toBeVisible();
  caseRef = (await done.textContent())!.match(/CASE-\d+/)![0];
  const card = page.getByRole('article', { name: `Case ${caseRef}` });
  await expect(card.getByText('Waiting for triage')).toBeVisible();
  await expect(card.getByText(/Short delivered, Cement 42.5 in 50 kg bags, 2 bag/)).toBeVisible();
  await expect(card.getByText(/First response from BuildWise due by/)).toBeVisible();
  await expectAccessible(page, 'provider order with a case');
});

test('a moderator triages, proposes and decides the case', async ({ page }) => {
  await signIn(page, PHONES.moderator, '/moderation/cases');
  await page.getByRole('link', { name: caseRef }).click();
  await expect(page.getByRole('heading', { name: `Case ${caseRef}` })).toBeVisible();
  caseHref = new URL(page.url()).pathname;
  await page.getByLabel('Severity').selectOption('S3');
  await page.getByRole('button', { name: 'Triage' }).click();
  await expect(page.getByText('Done: the case is now triaged.')).toBeVisible();
  await page.getByLabel(/Proposed resolution/).fill('The signed gate count shows 38. The supplier resupplies or credits the 2 bags.');
  await page.getByRole('button', { name: 'Propose resolution' }).click();
  await expect(page.getByText('Done: the case is now proposed resolution.')).toBeVisible();
  await page.getByLabel('Outcome').selectOption('client_upheld');
  await page.getByLabel(/Decision and reasons/).fill('The gate count was signed by the driver; the shortage stands.');
  await expectAccessible(page, 'staff case page');
  await page.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByText('Done: the case is now resolved.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Case summary' }).getByText(/Decision:.*Upheld in the client's favour/)).toBeVisible();
  await expect(page.getByRole('cell', { name: 'case.decide' })).toBeVisible();
});

test('the supplier appeals once', async ({ page }) => {
  await signIn(page, PHONES.supplier2, providerOrder());
  const card = page.getByRole('article', { name: `Case ${caseRef}` });
  await expect(card.getByText(/Decision:.*Upheld in the client's favour/).first()).toBeVisible();
  await card.getByText('Appeal this decision').click();
  await card.getByLabel('Why the decision should change').fill('Our weighbridge ticket shows the full 40 bags were loaded.');
  await card.getByRole('button', { name: 'Send appeal' }).click();
  await expect(page.getByText('Appeal sent. A different staff member will review it.')).toBeVisible();
  await expect(card.getByText('Appealed', { exact: true })).toBeVisible();
  await expect(card.getByText('Appeal this decision')).toHaveCount(0);
});

test('the deciding moderator cannot review the appeal; a second moderator decides it', async ({ page }) => {
  await signIn(page, PHONES.moderator, caseHref);
  await expect(page.getByText('You decided this case, so a different staff member must review the appeal.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take the appeal' })).toHaveCount(0);

  await signIn(page, PHONES.moderator2, caseHref);
  await page.getByRole('button', { name: 'Take the appeal' }).click();
  await expect(page.getByText('Done: the case is now under appeal review.')).toBeVisible();
  await page.getByLabel('Overturn it').check();
  await page.getByLabel('New outcome').selectOption('shared');
  await page.getByLabel(/Appeal decision and reasons/).fill('Both counts are signed, so the loss happened in transit. Share the cost.');
  await page.getByRole('button', { name: 'Decide appeal' }).click();
  await expect(page.getByText('Done: the case is now final.')).toBeVisible();

  await signIn(page, PHONES.buyer, clientOrder());
  const card = page.getByRole('article', { name: `Case ${caseRef}` });
  await expect(card.getByText(/Outcome that stands: Shared responsibility\. This decision is final\./)).toBeVisible();
  await expectAccessible(page, 'client order with a final case');
});

test('the order completes and both sides review each other once', async ({ page }) => {
  await signIn(page, PHONES.buyer, clientOrder());
  await page.getByLabel(/^Resolution/).selectOption('credit');
  await page.getByRole('button', { name: 'Resolve discrepancy' }).click();
  await expect(page.getByText('Delivered', { exact: true })).toBeVisible();
  const reviews = page.locator('#reviews');
  await reviews.getByLabel('Accuracy against the quote').selectOption('3');
  await reviews.getByLabel('Your review').fill(`Quick delivery and clear paperwork. Two bags short, settled through the case (run ${RUN}).`);
  await expectAccessible(page, 'review form');
  await reviews.getByRole('button', { name: 'Submit review' }).click();
  await expect(page.getByText('Thanks. Your review is saved.')).toBeVisible();
  await expect(reviews.getByRole('article', { name: 'Your review' })).toBeVisible();

  await signIn(page, PHONES.supplier2, providerOrder());
  const sup = page.locator('#reviews');
  await expect(sup.getByText(/The client has reviewed you\. You see it once you have reviewed too/)).toBeVisible();
  await sup.getByLabel('Your review').fill('Easy site access, quick to inspect and fair in the case.');
  await sup.getByRole('button', { name: 'Submit review' }).click();
  const fromClient = sup.getByRole('article', { name: 'Review from the client' });
  await expect(fromClient.getByText(/Two bags short, settled through the case/)).toBeVisible();
  await fromClient.getByLabel('Your public reply').fill('Thank you. The credit note for the two bags is on its way.');
  await fromClient.getByRole('button', { name: 'Publish reply' }).click();
  await expect(fromClient.getByText(/Reply:.*credit note/)).toBeVisible();
  await expect(sup.getByRole('button', { name: 'Submit review' })).toHaveCount(0);

  await signIn(page, PHONES.buyer, clientOrder());
  await expect(page.locator('#reviews').getByRole('article', { name: 'Review from the supplier' }).getByText(/fair in the case/)).toBeVisible();
});

test('the provider profile shows the delivery record and the order review', async ({ page }) => {
  await page.context().clearCookies();
  await page.goto(`/seller/${providerHandle}`);
  const record = page.getByRole('table', { name: /Delivery and quote record/ });
  // A fresh database has too few deliveries for a score; a reused one may have enough. Both read as a count of deliveries.
  await expect(record.getByRole('row', { name: /On-time delivery/ })).toContainText(/\d+ of \d+ deliver(y|ies) on the booked day(: too few to score|\))/);
  await expect(record.getByRole('row', { name: /Deliveries with a discrepancy/ })).toContainText(/inspected deliver(y|ies)/);
  await expect(page.getByText(/With fewer than 5 records a measure is shown as a count, not a score/)).toBeVisible();
  const reviews = page.getByRole('region', { name: 'Reviews from completed BuildWise orders' });
  const mine = reviews.getByRole('listitem').filter({ hasText: `(run ${RUN})` });
  await expect(mine.getByText(/Two bags short, settled through the case/)).toBeVisible();
  await expect(mine.getByText(/Supplier reply:.*credit note/)).toBeVisible();
  await expect(reviews.getByText(/too few for an average|out of 5 from \d+ orders/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Website reviews' })).toBeVisible();
  await expectAccessible(page, 'provider profile with performance');
});

test('staff see the liquidity dashboard for the exit gate', async ({ page }) => {
  await signIn(page, PHONES.ops, '/moderation/liquidity');
  await expect(page.getByRole('heading', { name: 'Liquidity' })).toBeVisible();
  await expect(page.getByText(/Release 3 exit gate:/)).toBeVisible();
  await expect(page.getByRole('table', { name: 'By category' }).getByRole('row', { name: /Cement/ })).toBeVisible();
  await expectAccessible(page, 'liquidity dashboard');
});
