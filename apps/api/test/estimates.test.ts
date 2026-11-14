import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, pdf, type Json } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let owner: User, manager: User, reviewer: User, reviewer2: User, ops: User, outsider: User;
let projectId: string, measurementId: string, blockworkId: string, cementId: string;

async function uploadDrawing(user: User, title: string) {
  const data = pdf(1);
  const r = await h.ok(user.token, 'POST', `/v1/projects/${projectId}/documents`, { title, docType: 'drawing', discipline: 'architectural', revisionLabel: 'P1', fileName: `${title}.pdf`, bytes: data.length });
  await h.app.inject({ method: 'PUT', url: r.upload.url, payload: data, headers: { 'content-type': 'application/pdf' } });
  for (let i = 0; i < 100; i++) {
    const d = await h.ok(user.token, 'GET', `/v1/documents/${r.documentId}`);
    if (d.revisions[0].state === 'available') return r.revisionId as string;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('not processed');
}

const cmd = async (u: User, versionId: string, command: string, body: Json = {}) => {
  const v = await h.ok(u.token, 'GET', `/v1/estimate-versions/${versionId}`);
  return h.call(u.token, 'POST', `/v1/estimate-versions/${versionId}/commands/${command}`, { expectedVersion: v.version, ...body });
};

beforeAll(async () => {
  h = await harness();
  owner = await h.signIn('Ola Owner');
  manager = await h.signIn('Mia Manager');
  reviewer = await h.signIn('Rita Reviewer', { staff: 'qs_reviewer' });
  reviewer2 = await h.signIn('Ravi Reviewer', { staff: 'qs_reviewer' });
  ops = await h.signIn('Opal Ops', { staff: 'ops_admin' });
  outsider = await h.signIn('Otto Outsider');
  projectId = (await h.ok(owner.token, 'POST', '/v1/projects', { name: 'Bungalow', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'construction' })).id;
  await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/invitations`, { phone: manager.phone, role: 'manager' });
  const inv = (await h.ok(manager.token, 'GET', '/v1/me/project-invitations')).items[0];
  await h.ok(manager.token, 'POST', `/v1/project-invitations/${inv.id}/respond`, { accept: true });
  const rev = await uploadDrawing(owner, 'Ground floor');
  await h.ok(owner.token, 'POST', `/v1/revisions/${rev}/calibrations`, { page: 1, a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, knownLength: '10', knownUnit: 'm' });
  measurementId = (await h.ok(owner.token, 'POST', `/v1/revisions/${rev}/measurements`, { page: 1, kind: 'area', label: 'External walls', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }, { x: 0, y: 50 }] })).id;
  blockworkId = (await h.ok(ops.token, 'POST', '/v1/admin/catalog-items', { code: 'blockwork-9in', name: '9 inch sandcrete blockwork', section: 'walls', unit: 'm2', rateCategory: 'general' })).id;
  cementId = (await h.ok(ops.token, 'POST', '/v1/admin/catalog-items', { code: 'cement-50kg', name: 'Cement 42.5, 50 kg bag', section: 'substructure', unit: 'bag', rateCategory: 'volatile' })).id;
  const today = new Date().toISOString().slice(0, 10);
  await h.ok(ops.token, 'POST', '/v1/admin/rate-observations', { catalogItemId: blockworkId, regionCode: 'north', sourceClass: 'advertised_listing_price', rate: '9000', observedAt: today, reference: 'Listings, Hilltop' });
  await h.ok(ops.token, 'POST', '/v1/admin/rate-observations', { catalogItemId: blockworkId, regionCode: 'north', sourceClass: 'professional_rate_book', rate: '11000', observedAt: today, reference: 'Rate book Q4' });
  await h.ok(ops.token, 'POST', '/v1/admin/rate-observations', { catalogItemId: cementId, regionCode: 'north', sourceClass: 'supplier_confirmed_quote', rate: '9500', observedAt: '2026-01-05', reference: 'Old quote' });
});
afterAll(async () => { await h?.close(); });

describe('indicative and client-specified estimates', () => {
  it('saves an indicative range as its own labelled estimate', async () => {
    const r = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates/indicative`);
    expect(r.indicative.low.display).toMatch(/₦|NGN/);
    const list = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}/estimates`);
    expect(list.items[0]).toMatchObject({ maturity: 'indicative', label: 'Indicative range', state: 'generated' });
  });

  it('imports a quantity list into a client-specified estimate and freezes it when shared', async () => {
    const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: 'My QS list' });
    const imp = await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: 'description,qty,unit,section\nBlockwork 9in,120,sqm,walls\nRoof sheets,85,m²,roof\nBad row,x,m,walls' });
    expect(imp.imported).toBe(2);
    expect(imp.errors).toHaveLength(1);
    const v = await h.ok(owner.token, 'GET', `/v1/estimate-versions/${e.versionId}`);
    expect(v.notice).toMatch(/not platform-reviewed/);
    expect(v.lines.map((l: Json) => [l.unit, l.originalUnit])).toEqual([['m2', 'sqm'], ['m2', 'm²']]);
    await h.ok(owner.token, 'PATCH', `/v1/estimate-lines/${v.lines[0].id}`, { rowVersion: v.lines[0].rowVersion, rates: { material: '8500', labour: '2500' } });
    expect((await h.call(owner.token, 'PATCH', `/v1/estimate-lines/${v.lines[0].id}`, { rowVersion: v.lines[0].rowVersion, description: 'stale write' })).status).toBe(409);
    await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/share`);
    const shared = await h.ok(owner.token, 'GET', `/v1/estimate-versions/${e.versionId}`);
    expect(shared.state).toBe('shared');
    expect(shared.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    expect(shared.totals.net.amountMinor).toBe(String(120n * 1_100_000n));
    expect((await h.call(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/lines`, { section: 'walls', description: 'more', unit: 'm2', gross: '1' })).status).toBe(409);
  });
});

describe('professionally reviewed estimate', () => {
  let estimateId: string, versionId: string;

  it('is submitted by the client and only staff reviewers see the queue', async () => {
    const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'reviewed_cost_plan', title: 'Reviewed estimate' });
    estimateId = e.estimateId; versionId = e.versionId;
    expect((await h.call(owner.token, 'POST', `/v1/estimate-versions/${versionId}/lines`, { section: 'walls', description: 'Extra wall', unit: 'm2', gross: '1' })).status).toBe(409);
    expect((await cmd(owner, versionId, 'submit')).status).toBe(200);
    expect((await h.call(outsider.token, 'GET', '/v1/review/queue')).status).toBe(403);
    const q = await h.ok(reviewer.token, 'GET', '/v1/review/queue');
    expect(q.waiting.map((w: Json) => w.versionId)).toContain(versionId);
    expect((await h.call(reviewer.token, 'GET', `/v1/projects/${projectId}`)).status).toBe(404);
  });

  it('assignment makes the reviewer a scoped project member', async () => {
    expect((await h.call(ops.token, 'POST', '/v1/review/assignments', { versionId, reviewerUserId: owner.id, kind: 'primary' })).status).toBe(422);
    await h.ok(ops.token, 'POST', '/v1/review/assignments', { versionId, reviewerUserId: reviewer.id, kind: 'primary' });
    const p = await h.ok(reviewer.token, 'GET', `/v1/projects/${projectId}`);
    expect(p.role).toBe('reviewer');
    expect((await h.call(reviewer.token, 'GET', `/v1/projects/${projectId}/payments`)).status).toBe(404);
    expect((await h.ok(reviewer.token, 'GET', `/v1/estimate-versions/${versionId}`)).editable).toBe(true);
  });

  it('the reviewer can ask the client for information through an RFI tied to the estimate', async () => {
    const r = await cmd(reviewer, versionId, 'request_information', { message: 'Please confirm the wall height.' });
    expect(r.status).toBe(200);
    const rfis = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}/rfis`);
    expect(rfis.items[0].subject).toMatch(/Information needed/);
    expect((await cmd(owner, versionId, 'resume')).status).toBe(404);
    expect((await cmd(reviewer, versionId, 'resume')).status).toBe(200);
  });

  it('prices measured lines from the best valid rate source, never a lower class', async () => {
    const line = await h.ok(reviewer.token, 'POST', `/v1/estimate-versions/${versionId}/lines`, { section: 'walls', description: '9 inch blockwork', unit: 'm2', measurementIds: [measurementId], deductions: '0', wastePct: 5 });
    expect(line.gross).toBe('50');
    expect(line.quantitySource).toBe('measurement');
    const priced = await h.ok(reviewer.token, 'POST', `/v1/estimate-lines/${line.id}/apply-rate`, { catalogItemId: blockworkId, component: 'material', rowVersion: line.rowVersion });
    expect(priced.rateSource.sourceClass).toBe('professional_rate_book');
    expect(priced.unitRate).toBe('11000');
    expect(priced.amount.amountMinor).toBe(String(525n * 110_000n)); // 52.5 m2 × ₦11,000
    const rates = await h.ok(reviewer.token, 'GET', `/v1/catalog/${blockworkId}/rates`);
    const listingObs = rates.observations.find((o: Json) => o.sourceClass === 'advertised_listing_price');
    expect((await h.call(reviewer.token, 'POST', `/v1/estimate-lines/${line.id}/apply-rate`, { catalogItemId: blockworkId, component: 'material', rowVersion: priced.rowVersion, observationId: listingObs.id })).status).toBe(422);
  });

  it('blocks issue on QA blockers, stale rates and missing qualification; warnings need reasons', async () => {
    const cement = await h.ok(reviewer.token, 'POST', `/v1/estimate-versions/${versionId}/lines`, { section: 'substructure', description: 'Cement for foundations', unit: 'bag', gross: '60', quantitySource: 'provisional_sum', status: 'provisional' });
    const old = (await h.ok(reviewer.token, 'GET', `/v1/catalog/${cementId}/rates`)).observations[0];
    const stale = await h.ok(reviewer.token, 'POST', `/v1/estimate-lines/${cement.id}/apply-rate`, { catalogItemId: cementId, component: 'material', rowVersion: cement.rowVersion, observationId: old.id });
    let r = await cmd(reviewer, versionId, 'complete_review');
    expect(r.status).toBe(422);
    expect(r.body.error.details.findings.map((f: Json) => f.code)).toContain('rate_stale');
    await h.ok(reviewer.token, 'POST', `/v1/estimate-lines/${cement.id}/apply-rate`, { catalogItemId: cementId, component: 'material', rowVersion: stale.rowVersion, observationId: old.id, reconfirm: true });

    const v = await h.ok(reviewer.token, 'GET', `/v1/estimate-versions/${versionId}`);
    await h.ok(reviewer.token, 'PATCH', `/v1/estimate-versions/${versionId}`, { expectedVersion: v.version, contingencyPct: 7.5, assumptions: ['Road access for 10 t trucks'], exclusions: ['External works', 'Furniture'] });
    r = await cmd(reviewer, versionId, 'complete_review');
    expect(r.body.error.code).toBe('QA_WARNINGS');
    for (const f of r.body.error.details.findings) await h.ok(reviewer.token, 'POST', `/v1/estimate-versions/${versionId}/qa-acknowledgements`, { key: f.key, reason: 'Out of scope for this stage; client confirmed.' });
    r = await cmd(reviewer, versionId, 'complete_review');
    expect(r.status).toBe(403);
    await h.ok(ops.token, 'POST', '/v1/admin/reviewer-qualifications', { userId: reviewer.id, classCode: 'residential_lowrise', credential: 'Registered QS (demo)', validUntil: '2030-12-31' });
    expect((await cmd(reviewer, versionId, 'complete_review')).status).toBe(200);
  });

  it('issues an immutable, hashed version the owner can accept; a manager cannot', async () => {
    expect((await cmd(reviewer, versionId, 'issue')).status).toBe(200);
    const v = await h.ok(owner.token, 'GET', `/v1/estimate-versions/${versionId}`);
    expect(v.state).toBe('issued');
    expect(v.label).toBe('Professionally reviewed');
    expect(v.reviewer.name).toBe('Rita Reviewer');
    expect(v.validUntil).toBeTruthy();
    expect(v.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const report = await h.ok(owner.token, 'GET', `/v1/estimate-versions/${versionId}/report`);
    expect(report.documents[0]).toMatchObject({ title: 'Ground floor', revision: 'P1' });
    expect(report.statement).toMatch(/Not a guarantee/);
    expect((await h.call(reviewer.token, 'POST', `/v1/estimate-versions/${versionId}/lines`, { section: 'walls', description: 'late', unit: 'm2', gross: '1' })).status).toBe(409);
    expect((await cmd(manager, versionId, 'accept')).status).toBe(404);
    expect((await cmd(owner, versionId, 'accept')).status).toBe(200);
    const p = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}`);
    expect(p.currency).toBe('NGN');
  });

  it('a new version copies lines and reports a line-by-line change summary', async () => {
    const nv = await h.ok(owner.token, 'POST', `/v1/estimates/${estimateId}/versions`, { changeReason: 'Client added a store room' });
    const v = await h.ok(owner.token, 'GET', `/v1/estimate-versions/${nv.versionId}`);
    expect(v.number).toBe(2);
    expect(v.lines).toHaveLength(2);
    const d = await h.ok(owner.token, 'GET', `/v1/estimate-versions/${nv.versionId}/delta`);
    expect(d.rows).toHaveLength(0);
    expect(d.changeReason).toBe('Client added a store room');
  });
});

describe('second review and payments', () => {
  it('requires a different second reviewer above the value threshold', async () => {
    const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'reviewed_cost_plan', title: 'Big job' });
    await cmd(owner, e.versionId, 'submit');
    await h.ok(ops.token, 'POST', '/v1/review/assignments', { versionId: e.versionId, reviewerUserId: reviewer.id, kind: 'primary' });
    const l = await h.ok(reviewer.token, 'POST', `/v1/estimate-versions/${e.versionId}/lines`, { section: 'walls', description: 'Blockwork', unit: 'm2', gross: '200000', quantitySource: 'provisional_sum' });
    await h.ok(reviewer.token, 'POST', `/v1/estimate-lines/${l.id}/apply-rate`, { catalogItemId: blockworkId, component: 'material', rowVersion: l.rowVersion });
    const v = await h.ok(reviewer.token, 'GET', `/v1/estimate-versions/${e.versionId}`);
    await h.ok(reviewer.token, 'PATCH', `/v1/estimate-versions/${e.versionId}`, { expectedVersion: v.version, contingencyPct: 10, assumptions: ['a b'], exclusions: ['c d'] });
    // The primary review can be completed; issuing waits for the second review.
    await h.ok(ops.token, 'POST', '/v1/admin/reviewer-qualifications', { userId: reviewer.id, classCode: 'residential_lowrise', credential: 'QS', validUntil: '2030-12-31' }).catch(() => undefined);
    const first = await cmd(reviewer, e.versionId, 'complete_review');
    for (const f of first.body.error?.details?.findings ?? []) await h.ok(reviewer.token, 'POST', `/v1/estimate-versions/${e.versionId}/qa-acknowledgements`, { key: f.key, reason: 'Accepted for this stage of design.' });
    expect((await cmd(reviewer, e.versionId, 'complete_review')).status).toBe(200);
    const q = await h.ok(ops.token, 'GET', '/v1/review/queue');
    expect(q.needSecondReviewer.map((x: Json) => x.versionId)).toContain(e.versionId);
    const r = await cmd(reviewer, e.versionId, 'issue');
    expect(r.body.error.details.findings.map((f: Json) => f.code)).toContain('second_review_required');
    expect((await h.call(ops.token, 'POST', '/v1/review/assignments', { versionId: e.versionId, reviewerUserId: reviewer.id, kind: 'second' })).status).toBe(409);
    await h.ok(ops.token, 'POST', '/v1/review/assignments', { versionId: e.versionId, reviewerUserId: reviewer2.id, kind: 'second' });
    await h.ok(reviewer2.token, 'POST', `/v1/estimate-versions/${e.versionId}/second-review`, { approve: true, note: 'Quantities and rates checked.' });
    const after = await h.ok(reviewer.token, 'GET', `/v1/estimate-versions/${e.versionId}`);
    expect(after.qa.some((f: Json) => f.code === 'second_review_required')).toBe(false);
    expect((await cmd(reviewer, e.versionId, 'issue')).status).toBe(200);
  });

  it('records off-platform payments, acknowledged by someone else, and never claims protection', async () => {
    const r = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/payments`, { payee: 'Hilltop Building Supplies', description: '60 bags of cement', amount: '570000', paidOn: '2026-11-01', method: 'bank_transfer', reference: 'TRX-1' });
    const list = await h.ok(manager.token, 'GET', `/v1/projects/${projectId}/payments`);
    expect(list.notice).toMatch(/did not process or protect/);
    expect(list.total.amountMinor).toBe('57000000');
    expect((await h.call(owner.token, 'POST', `/v1/payment-records/${r.id}/acknowledge`, {})).status).toBe(403);
    await h.ok(manager.token, 'POST', `/v1/payment-records/${r.id}/acknowledge`, {});
    expect((await h.call(reviewer.token, 'GET', `/v1/projects/${projectId}/payments`)).status).toBe(404);
    expect((await h.call(owner.token, 'POST', `/v1/projects/${projectId}/payments`, { payee: 'X Y', description: 'future', amount: '10', paidOn: '2099-01-01', method: 'cash' })).status).toBe(400);
  });
});
