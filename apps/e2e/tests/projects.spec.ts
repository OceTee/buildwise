import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, PHONES, signIn } from './helpers';

test.describe.configure({ mode: 'serial' });

const QS = '08000000004';
const RUN = Date.now().toString(36);
const WALLS = `External walls ${RUN}`;
let projectUrl = '';
let estimateUrl = '';
let estimateTitle = '';

/** JSON call through the web proxy with the page's session cookie (for setup the canvas UI makes brittle). */
async function api(page: Page, method: string, path: string, data?: unknown) {
  const r = await page.request.fetch(`/api${path}`, { method, data, headers: data ? { 'content-type': 'application/json' } : {} });
  if (!r.ok()) throw new Error(`${method} ${path} -> ${r.status()} ${await r.text()}`);
  return r.json();
}

test('a client sees readiness and an indicative range, and records a measurement on a drawing', async ({ page }) => {
  await signIn(page, PHONES.buyer, '/projects');
  await expectAccessible(page, 'projects');
  await page.getByRole('link', { name: /Demo bungalow/ }).click();
  await expect(page.getByRole('heading', { name: 'Ready for a reviewed estimate' })).toBeVisible();
  await expect(page.getByText(/Indicative only\./)).toBeVisible();
  projectUrl = new URL(page.url()).pathname;
  await expectAccessible(page, 'project overview');

  await page.getByRole('link', { name: 'Documents', exact: true }).click();
  await expectAccessible(page, 'document register');
  await page.getByRole('link', { name: 'Ground floor plan' }).click();
  await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await page.getByLabel('Name', { exact: true }).last().fill(WALLS);
  await page.getByLabel('Value').fill('96');
  await page.getByLabel('Unit').last().selectOption('m2');
  await page.getByLabel('How it was worked out').fill('Perimeter 44 m × 2.7 m less openings, from A-101');
  await page.getByRole('button', { name: 'Save manual measurement' }).click();
  await expect(page.getByRole('cell', { name: WALLS })).toBeVisible();
  await expectAccessible(page, 'drawing viewer');
});

test('the client requests a professionally reviewed estimate', async ({ page }) => {
  await signIn(page, PHONES.buyer, `${projectUrl}/estimates`);
  await expectAccessible(page, 'estimates');
  estimateTitle = `Reviewed estimate ${Date.now().toString(36)}`;
  await page.getByLabel('Name').last().fill(estimateTitle);
  await page.getByRole('button', { name: 'Create and prepare request' }).click();
  await page.waitForURL(/\/estimates\/[0-9a-f-]{36}$/);
  estimateUrl = new URL(page.url()).pathname;
  await expect(page.getByText('Professionally reviewed', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Request professional review' }).click();
  await expect(page.getByText(/Waiting for a reviewer/).first()).toBeVisible();
  await expectAccessible(page, 'estimate worksheet');
});

test('a qualified reviewer measures, prices, checks and issues it', async ({ page }) => {
  await signIn(page, QS, '/moderation/review');
  await expectAccessible(page, 'review queue');
  const estimateId = estimateUrl.split('/').pop()!;
  const est = page.locator('li.card', { hasText: estimateTitle }).filter({ has: page.getByRole('button', { name: 'Assign' }) });
  await est.getByRole('button', { name: 'Assign' }).click();
  await expect(est.getByText(/Assigned/)).toBeVisible();

  // Lines are set up through the API (the takeoff canvas is covered by its own checks); review and issue go through the UI.
  const projectId = projectUrl.split('/').pop()!;
  const docs = await api(page, 'GET', `/v1/projects/${projectId}/documents`);
  const takeoff = await api(page, 'GET', `/v1/revisions/${docs.items[0].current.id}/takeoff`);
  const m = takeoff.measurements.find((x: { label: string }) => x.label === WALLS);
  const est2 = await api(page, 'GET', `/v1/estimates/${estimateId}`);
  const v = est2.current;
  const line = await api(page, 'POST', `/v1/estimate-versions/${v.id}/lines`, { section: 'walls', description: '9 inch blockwork, external walls', unit: 'm2', measurementIds: [m.id], wastePct: 5 });
  const cat = await api(page, 'GET', '/v1/catalog?q=blockwork&region=north');
  await api(page, 'POST', `/v1/estimate-lines/${line.id}/apply-rate`, { catalogItemId: cat.items[0].id, component: 'material', rowVersion: line.rowVersion });
  const fresh = await api(page, 'GET', `/v1/estimate-versions/${v.id}`);
  await api(page, 'PATCH', `/v1/estimate-versions/${v.id}`, { expectedVersion: fresh.version, contingencyPct: 7.5, assumptions: ['Road access for 10 t trucks'], exclusions: ['External works', 'Furniture'] });

  await page.goto(estimateUrl);
  await expectAccessible(page, 'reviewer worksheet');
  // Each QA warning needs a recorded reason before the review can be completed.
  const acks = page.getByRole('button', { name: 'Acknowledge' });
  await expect(page.getByRole('heading', { name: 'Quality checks' })).toBeVisible();
  const total = await acks.count();
  for (let done = 0; done < total; done++) {
    await page.getByLabel(/Reason for accepting/).first().fill('Scope limited to walls at this design stage; client informed.');
    await acks.first().click();
    await expect(page.getByText(/^Acknowledged:/)).toHaveCount(done + 1);
  }
  await page.getByRole('button', { name: 'Complete review' }).click();
  await page.getByRole('button', { name: 'Confirm: Complete review' }).click();
  await expect(page.getByText(/Reviewed, not yet issued/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Issue to client' }).click();
  await page.getByRole('button', { name: 'Confirm: Issue to client' }).click();
  await expect(page.getByText('Issued', { exact: true }).first()).toBeVisible();
});

test('the client accepts the issued estimate and opens the report', async ({ page }) => {
  await signIn(page, PHONES.buyer, estimateUrl);
  await expect(page.getByText(/Dayo \(QS reviewer\)/).first()).toBeVisible();
  await page.getByRole('button', { name: 'Accept as budget baseline' }).click();
  await page.getByRole('button', { name: 'Confirm: Accept as budget baseline' }).click();
  await expect(page.getByText(/Accepted \(budget baseline\)/).first()).toBeVisible();
  await page.getByRole('link', { name: /report/i }).first().click();
  await expect(page.getByText(/Not a guarantee of final cost/)).toBeVisible();
  await expect(page.getByText(/[0-9a-f]{64}/)).toBeVisible();
  await expectAccessible(page, 'estimate report');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectAccessible(page, 'estimate report (dark)');
});

test('record-only payments say so, and team roles are explained', async ({ page }) => {
  await signIn(page, PHONES.buyer, `${projectUrl}/payments`);
  await expect(page.getByText(/did not process or protect/)).toBeVisible();
  await page.getByRole('button', { name: 'Record a payment' }).click();
  await page.getByLabel('Paid to').fill('Hilltop Building Supplies');
  await page.getByLabel('Amount').fill('570000');
  await page.getByLabel('Date paid').fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel('What for').fill('60 bags of cement');
  await page.getByRole('button', { name: 'Save record' }).click();
  await expect(page.getByRole('cell', { name: 'Hilltop Building Supplies' }).first()).toBeVisible();
  await expectAccessible(page, 'payments');
  await page.getByRole('link', { name: 'Team', exact: true }).click();
  await expect(page.getByText('What each role can do')).toBeVisible();
  await expectAccessible(page, 'team');
});
