import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, PHONES, sameOrigin, signIn } from './helpers';

/**
 * Release 3, first slice: a client publishes a request for quotes from a shared client-specified estimate, two
 * seeded suppliers quote, the client compares and awards, and the supplier confirms the record-only order.
 */
test.describe.configure({ mode: 'serial' });

const RUN = Date.now().toString(36);
const TITLE = `Slab cement ${RUN}`;
const LINE = 'Cement 42.5 in 50 kg bags';
let projectId = '';
let rfqUrl = '';

async function api(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(`/api${path}`, { method, data, headers: { ...sameOrigin(page), ...(data ? { 'content-type': 'application/json' } : {}) } });
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`);
  return r.json();
}

test('the client creates and publishes a request for quotes to eligible suppliers', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/projects');
  const projects = await api(page, 'GET', '/v1/projects');
  projectId = projects.items.find((p: { name: string }) => p.name === 'Demo bungalow').id;
  // The scope is a shared client-specified list (set up through the API; its editor has its own checks).
  const e = await api(page, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: `Slab list ${RUN}` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: `description,qty,unit,section,specification\n${LINE},60,bag,substructure,Grade 42.5` });
  await api(page, 'POST', `/v1/estimate-versions/${e.versionId}/share`, {});

  await page.goto(`/projects/${projectId}/rfqs`);
  await expect(page.getByRole('heading', { name: 'Procurement', level: 1 })).toBeVisible();
  await expectAccessible(page, 'procurement');
  await page.getByLabel('Title', { exact: true }).fill(TITLE);
  const scope = page.getByLabel('Scope');
  await scope.selectOption((await scope.locator('option', { hasText: `Slab list ${RUN}` }).getAttribute('value'))!);
  await page.getByLabel('Category').selectOption('cement');
  await page.getByLabel('Who can quote').selectOption('open');
  await page.getByRole('button', { name: 'Create draft request' }).click();
  await page.waitForURL(/\/rfqs\/[0-9a-f-]{36}$/);
  rfqUrl = new URL(page.url()).pathname;
  await expect(page.getByText('Client-specified scope.')).toBeVisible();

  await page.getByRole('button', { name: 'Find eligible suppliers' }).click();
  await expect(page.getByText(/Hilltop Building Supplies/).first()).toBeVisible();
  await expect(page.getByText(/Old Town Cement Depot/).first()).toBeVisible();
  // Fewer than three eligible suppliers: assisted sourcing is offered instead of a dead end.
  await expect(page.getByRole('button', { name: 'Ask operations to find more suppliers' })).toBeVisible();
  await expect(page.getByText('Not eligible', { exact: false }).first()).toBeVisible();
  await expectAccessible(page, 'rfq draft with matches');
  await page.getByRole('button', { name: 'Publish request' }).click();
  await expect(page.getByText(/Published\. 2 providers invited/)).toBeVisible();
  await expect(page.getByText('Open for quotes').first()).toBeVisible();
});

async function submitQuote(page: Page, phone: string, price: string) {
  await signIn(page, phone, '/provider/rfqs');
  await expectAccessible(page, 'provider inbox');
  await page.getByRole('link', { name: new RegExp(TITLE) }).click();
  await expect(page.getByRole('heading', { name: TITLE })).toBeVisible();
  await page.getByRole('button', { name: 'Start a quote' }).click();
  await page.getByLabel(new RegExp(`Unit price for ${LINE}`)).fill(price);
  await page.getByLabel(new RegExp(`Brand or product for ${LINE}`)).fill('42.5 grade, 50 kg');
  await page.getByLabel('Delivery charge').fill('15000');
  await page.getByLabel('Payment terms').fill('Pay on delivery');
  await expectAccessible(page, 'quote form');
  await page.getByRole('button', { name: 'Submit quote' }).click();
  await expect(page.getByText(/Quote version \d+ submitted/)).toBeVisible();
}

test('the first supplier quotes', async ({ page }) => { await submitQuote(page, PHONES.supplier, '9500'); });
test('the second supplier quotes', async ({ page }) => { await submitQuote(page, PHONES.supplier2, '9200'); });

test('the client closes, compares like for like and awards a record-only order', async ({ page }) => {
  await signIn(page, PHONES.buyer, rfqUrl);
  await expect(page.getByText(/2 quotes received/)).toBeVisible();
  await page.getByRole('button', { name: 'Close and compare' }).click();
  await expect(page.getByText('Closed, comparing').first()).toBeVisible();
  await page.getByRole('link', { name: 'Compare quotes' }).click();
  await expect(page.getByText(/Lowest total: Old Town Cement Depot/)).toBeVisible();
  await expect(page.getByText('Like for like').first()).toBeVisible();
  await expectAccessible(page, 'quote comparison');
  await page.getByRole('button', { name: 'Award to Old Town Cement Depot' }).click();
  await page.getByRole('button', { name: 'Confirm award to Old Town Cement Depot' }).click();
  await page.waitForURL(/\/orders\/[0-9a-f-]{36}$/);
  await expect(page.getByText('Record only.')).toBeVisible();
  await expect(page.getByText(/does not process, hold or protect/)).toBeVisible();
  await expect(page.getByText('Placed, awaiting supplier')).toBeVisible();
  await expect(page.getByRole('cell', { name: /Cement 42.5 in 50 kg bags/ })).toBeVisible();
  await expectAccessible(page, 'order');
});

test('the awarded supplier confirms the order; the other sees they were not selected', async ({ page }) => {
  await signIn(page, PHONES.supplier2, '/provider/rfqs');
  await page.getByRole('link', { name: new RegExp(`PO-\\d+ · ${TITLE}`) }).click();
  await page.getByRole('button', { name: 'Confirm order' }).click();
  await expect(page.getByText('Confirmed by supplier')).toBeVisible();
  await expectAccessible(page, 'provider order');
  await signIn(page, PHONES.supplier, '/provider/rfqs');
  await expect(page.locator('li.card', { hasText: TITLE }).getByText('Not selected')).toBeVisible();
});
