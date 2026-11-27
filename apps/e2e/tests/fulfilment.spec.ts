import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, PHONES, signIn } from './helpers';

/**
 * Release 3, second slice: an awarded order is confirmed, booked, dispatched, received with proof of delivery,
 * inspected with one discrepancy, partly returned and invoiced; the three-way match passes and the client closes
 * the order. The request for quotes and the quote are set up through the API (slice 1 has its own e2e flow).
 */
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const TITLE = `Fulfilment cement ${RUN}`;
const LINE = 'Cement 42.5 in 50 kg bags';
let projectId = '';
let orderId = '';

async function api(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(`/api${path}`, { method, data, headers: data ? { 'content-type': 'application/json' } : {} });
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`);
  return r.json();
}
const clientOrder = () => `/projects/${projectId}/orders/${orderId}`;
const providerOrder = () => `/provider/orders/${orderId}`;
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

test('an order is awarded and the supplier confirms it', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/projects');
  projectId = (await api(page, 'GET', '/v1/projects')).items.find((p: { name: string }) => p.name === 'Demo bungalow').id;
  const e = await api(page, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: `Fulfilment list ${RUN}` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: `description,qty,unit,section,specification\n${LINE},60,bag,substructure,Grade 42.5` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/share`, {});
  const rfqId = (await api(page, 'POST', `/v1/projects/${projectId}/rfqs`, { title: TITLE, categorySlug: 'cement', estimateVersionId: e.versionId, deadline: inDays(5), sourcingMode: 'open' })).id;
  const rv = async () => (await api(page, 'GET', `/v1/rfqs/${rfqId}`)).version;
  await api(page, 'POST', `/v1/rfqs/${rfqId}/commands/publish`, { expectedVersion: await rv() });

  await signIn(page, PHONES.supplier2, '/provider/rfqs');
  const lineKey = (await api(page, 'GET', `/v1/rfqs/${rfqId}`)).lines[0].lineKey;
  const d = await api(page, 'POST', `/v1/rfqs/${rfqId}/quotes`);
  const draft = await api(page, 'GET', `/v1/quote-versions/${d.versionId}`);
  await api(page, 'PUT', `/v1/quote-versions/${d.versionId}`, {
    expectedVersion: draft.version, validUntil: inDays(20).slice(0, 10), deliveryCharge: '15000', deliveryTaxRatePct: 7.5, paymentTerms: 'Pay on delivery',
    lines: [{ rfqLineKey: lineKey, status: 'priced', unit: 'bag', quantity: '60', unitPrice: '9200', taxRatePct: 7.5, offered: '42.5 grade, 50 kg' }],
  });
  await api(page, 'POST', `/v1/quote-versions/${d.versionId}/submit`, { expectedVersion: (await api(page, 'GET', `/v1/quote-versions/${d.versionId}`)).version });

  await signIn(page, PHONES.buyer, '/projects');
  await api(page, 'POST', `/v1/rfqs/${rfqId}/commands/close`, { expectedVersion: await rv() });
  orderId = (await api(page, 'POST', `/v1/rfqs/${rfqId}/award`, { quoteVersionId: d.versionId, expectedVersion: await rv() })).orderId;

  await signIn(page, PHONES.supplier2, providerOrder());
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText('Confirmed by supplier')).toBeVisible();
  await expect(page.getByText('The client has not booked a delivery yet.')).toBeVisible();
});

test('the client books a delivery slot', async ({ page }) => {
  await signIn(page, PHONES.buyer, clientOrder());
  await expect(page.getByRole('heading', { name: 'Delivery progress' })).toBeVisible();
  await expect(page.getByLabel(/Quantity to deliver/)).toHaveValue('60');
  await page.getByLabel('Delivery slot').selectOption('morning');
  await page.getByLabel(/Site instructions/).fill('Gate 2, offload by the store');
  await expectAccessible(page, 'order with booking form');
  await page.getByRole('button', { name: 'Book delivery' }).click();
  await expect(page.getByText('Delivery DEL-001 booked.')).toBeVisible();
  await expect(page.locator('.pill', { hasText: /^Booked$/ })).toBeVisible();
});

test('the supplier dispatches the consignment and marks it arrived', async ({ page }) => {
  await signIn(page, PHONES.supplier2, providerOrder());
  await page.getByLabel('Waybill or consignment number').fill(`WB-${RUN}`);
  await page.getByLabel(/Vehicle/).fill('LSD 123 XY');
  await expect(page.getByLabel(/Quantity loaded/)).toHaveValue('60');
  await expectAccessible(page, 'provider dispatch');
  await page.getByRole('button', { name: 'Dispatch consignment' }).click();
  await expect(page.getByText('On the way')).toBeVisible();
  await page.getByRole('button', { name: 'Mark arrived' }).click();
  await expect(page.getByText('Arrived on site')).toBeVisible();
});

test('the client records proof of delivery, then inspects with one discrepancy', async ({ page }) => {
  await signIn(page, PHONES.buyer, clientOrder());
  await expect(page.getByText(/Recording a delivery confirms what arrived, not that it is acceptable/).first()).toBeVisible();
  await page.getByLabel('Received by').fill('Site foreman');
  await page.getByRole('button', { name: 'Record proof of delivery' }).click();
  await expect(page.getByText('Received, not inspected')).toBeVisible();
  await expect(page.getByText('Partly delivered')).toBeVisible();
  await expect(page.getByText(/Received by Site foreman/)).toBeVisible();

  await page.getByLabel(/Accepted quantity/).fill('55');
  await page.getByLabel(/Rejected quantity/).fill('5');
  await page.getByLabel(/Why rejected/).selectOption('damaged');
  await page.getByLabel(/What was wrong/).fill('Torn bags, set hard');
  await expectAccessible(page, 'inspection form');
  await page.getByRole('button', { name: 'Record inspection' }).click();
  await expect(page.getByText('Discrepancy raised', { exact: true })).toBeVisible();
  await expect(page.getByText(/Damaged.*Cement 42.5 in 50 kg bags, 5 bag/)).toBeVisible();
});

test('the client resolves the discrepancy with a credit and returns the damaged bags', async ({ page }) => {
  await signIn(page, PHONES.buyer, clientOrder());
  await page.getByLabel(/^Resolution/).selectOption('credit');
  await page.getByRole('button', { name: 'Resolve discrepancy' }).click();
  await expect(page.getByText('Discrepancies resolved')).toBeVisible();
  await expect(page.getByText('Delivered', { exact: true })).toBeVisible(); // 55 kept + 5 credited
  await page.getByText('Return these goods to the supplier').click();
  await expect(page.getByLabel(/Rejected quantity to return/)).toHaveValue('5');
  await page.getByRole('button', { name: 'Request return' }).click();
  await expect(page.getByText(/Return RET-001 requested/)).toBeVisible();
  await expect(page.getByText('Requested', { exact: true })).toBeVisible();
});

test('the supplier approves and collects the return, then invoices what was kept', async ({ page }) => {
  await signIn(page, PHONES.supplier2, providerOrder());
  await page.getByRole('button', { name: 'Approve return' }).click();
  await expect(page.getByText('Approved, awaiting collection')).toBeVisible();
  await page.getByRole('button', { name: 'Mark collected' }).click();
  await expect(page.getByText('Collected', { exact: true })).toBeVisible();

  await page.getByLabel('Invoice number').fill(`INV-${RUN}`);
  await expect(page.getByLabel(/Quantity billed/)).toHaveValue('55');
  await expect(page.getByLabel(/^Unit price/)).toHaveValue('9200');
  await expectAccessible(page, 'invoice form');
  await page.getByRole('button', { name: 'Send invoice' }).click();
  await expect(page.getByText(/Invoice sent\. It matches the order and what the client received/)).toBeVisible();
  await expect(page.getByText('Matched', { exact: true })).toBeVisible();
});

test('the client sees the three-way match, records a payment and closes the order', async ({ page }) => {
  await signIn(page, PHONES.buyer, clientOrder());
  const inv = page.getByRole('article', { name: new RegExp(`Invoice INV-${RUN}`) });
  await expect(inv.getByText('Matched', { exact: true })).toBeVisible();
  await expect(inv.getByRole('cell', { name: 'Matches' })).toBeVisible();
  await expect(page.getByText(/does not process, hold or protect/).first()).toBeVisible();
  await page.getByText('Record a payment you made to the supplier').click();
  await page.getByLabel('Amount paid').fill('100000');
  const forInvoice = page.getByLabel(/For invoice/);
  await forInvoice.selectOption((await forInvoice.locator('option', { hasText: `INV-${RUN}` }).getAttribute('value'))!);
  await page.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('Not confirmed by supplier')).toBeVisible();
  await expectAccessible(page, 'order with invoice and payment');
  await page.getByRole('button', { name: 'Close order' }).click();
  await expect(page.getByText('Closed', { exact: true }).first()).toBeVisible();
});
