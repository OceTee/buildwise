import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProcurementTimers } from '../src/modules/procurement.js';
import { harness, type Json } from './helpers.js';

/** R3 first slice: RFQs from estimates, matching, sealed and open quotes, comparison, award and a record-only order. */
let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let owner: User, manager: User, outsider: User, moderator: User, supA: User, supB: User, indiv: User;
let projectId: string, versionId: string, draftVersionId: string, listingA: string;
let rfqId: string, cementKey: string, rebarKey: string;
let qvA1: string, qvA2: string, qvB1: string, orderId: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const sys = (q: string, p: unknown[] = []) => h.services.db.tx({ kind: 'system' }, (sql) => sql.query(q, p));
const rfq = (u: User, id = rfqId) => h.ok(u.token, 'GET', `/v1/rfqs/${id}`);
const command = async (u: User, id: string, c: string, body: Json = {}) => h.call(u.token, 'POST', `/v1/rfqs/${id}/commands/${c}`, { expectedVersion: (await rfq(owner, id)).version, ...body });

async function quote(u: User, id: string, lines: Json[], extra: Json = {}) {
  const d = await h.ok(u.token, 'POST', `/v1/rfqs/${id}/quotes`);
  const v = await h.ok(u.token, 'GET', `/v1/quote-versions/${d.versionId}`);
  await h.ok(u.token, 'PUT', `/v1/quote-versions/${d.versionId}`, { expectedVersion: v.version, lines, validUntil: inDays(20).slice(0, 10), deliveryCharge: '15000', deliveryTaxRatePct: 7.5, paymentTerms: '50% on order, 50% on delivery', ...extra });
  const fresh = await h.ok(u.token, 'GET', `/v1/quote-versions/${d.versionId}`);
  return { versionId: d.versionId as string, quoteId: d.quoteId as string, version: fresh.version as number };
}
const line = (key: string, unit: string, quantity: string, unitPrice: string, over: Json = {}) => ({ rfqLineKey: key, status: 'priced', unit, quantity, unitPrice, taxRatePct: 7.5, ...over });

beforeAll(async () => {
  h = await harness();
  moderator = await h.signIn('Mo Moderator', { staff: 'moderator' });
  owner = await h.signIn('Ola Owner');
  manager = await h.signIn('Mia Manager');
  outsider = await h.signIn('Otto Outsider');
  supA = await h.veteranBusiness(await h.signIn('Ada Supplier'), 'Alpha Cement Depot');
  supB = await h.veteranBusiness(await h.signIn('Ben Supplier'), 'Bravo Building Supplies');
  indiv = await h.signIn('Ivy Individual');
  for (const s of [supA, supB]) await h.ok(moderator.token, 'POST', `/v1/moderation/sellers/${s.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup (test)' });
  listingA = (await h.liveListing(supA, moderator)).id;
  await h.liveListing(supB, moderator, { areaCode: 'airport-road', price: '9300' });
  await h.liveListing(indiv, moderator, { orgId: indiv.orgId, price: '9900' });

  projectId = (await h.ok(owner.token, 'POST', '/v1/projects', { name: 'Hilltop bungalow', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'construction' })).id;
  await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/invitations`, { phone: manager.phone, role: 'manager' });
  const inv = (await h.ok(manager.token, 'GET', '/v1/me/project-invitations')).items[0];
  await h.ok(manager.token, 'POST', `/v1/project-invitations/${inv.id}/respond`, { accept: true });
  const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: 'My QS list' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: 'description,qty,unit,section,specification\nCement 42.5 in 50 kg bags,60,bags,substructure,Grade 42.5\nY12 reinforcement bars,2,tonne,frame,' });
  versionId = e.versionId;
  const e2 = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: 'Unshared list' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e2.versionId}/import`, { csv: 'description,qty,unit\nBlocks,100,piece' });
  draftVersionId = e2.versionId;
});
afterAll(async () => { await h?.close(); });

describe('RFQ scope comes only from shared or reviewed estimates (§10.4 step 1)', () => {
  it('refuses a draft client-specified list and labels a shared one', async () => {
    const r = await h.call(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Blocks', categorySlug: 'blocks', estimateVersionId: draftVersionId, deadline: inDays(5) });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/Share/);
    await h.ok(owner.token, 'POST', `/v1/estimate-versions/${versionId}/share`);
    const src = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}/rfq-sources`);
    expect(src.estimates.find((x: Json) => x.versionId === versionId)).toMatchObject({ usable: true, label: 'Client-specified scope' });
    expect(src.estimates.find((x: Json) => x.versionId === draftVersionId).usable).toBe(false);
  });

  it('creates a draft RFQ whose lines keep their provenance', async () => {
    expect((await h.call(manager.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'x', categorySlug: 'cement', estimateVersionId: versionId, deadline: inDays(0.2) })).status).toBe(400);
    const r = await h.ok(manager.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Cement and rebar for the slab', categorySlug: 'cement', estimateVersionId: versionId, deadline: inDays(5), sourcingMode: 'open' });
    rfqId = r.id;
    const v = await rfq(owner);
    expect(v).toMatchObject({ state: 'draft', sealed: false, scope: { label: 'Client-specified scope', notice: expect.stringMatching(/not platform-reviewed/) }, area: { code: 'hilltop' } });
    expect(v.lines.map((l: Json) => [l.unit, l.quantity])).toEqual([['bag', '60'], ['tonne', '2']]);
    expect(v.lines[0].provenance).toMatchObject({ source: 'client_specified', estimateVersionId: versionId, estimateVersionNumber: 1 });
    [cementKey, rebarKey] = v.lines.map((l: Json) => l.lineKey);
    expect((await h.call(outsider.token, 'GET', `/v1/rfqs/${rfqId}`)).status).toBe(404);
    expect((await h.call(supA.token, 'GET', `/v1/rfqs/${rfqId}`)).status).toBe(404);
  });
});

describe('matching (§13.1)', () => {
  it('filters on category, area and checks at the deadline, explains the ranking and offers assisted sourcing', async () => {
    const m = await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/match`);
    expect(m.eligible.map((e: Json) => e.name).sort()).toEqual(['Alpha Cement Depot', 'Bravo Building Supplies']);
    expect(m.ineligible.find((x: Json) => x.orgId === indiv.orgId).reasons.join(' ')).toMatch(/Business registration check not passed/);
    expect(m.eligible[0].factors).toHaveLength(5);
    expect(m.eligible[0].why.length).toBeGreaterThan(0);
    expect(m.assistedSourcing).toMatchObject({ offered: true, eligibleCount: 2, target: 3 });
    const runs = await sys(`select result from rfq_match_runs where rfq_id = $1`, [rfqId]);
    expect(runs.rows.length).toBeGreaterThan(0);
    const a = await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/assisted-sourcing`, { note: 'Please find a third cement supplier' });
    expect(a.requested).toBe(true);
    const ops = await h.signIn('Opal Ops', { staff: 'ops_admin' });
    expect((await h.ok(ops.token, 'GET', '/v1/admin/assisted-sourcing')).items.map((x: Json) => x.id)).toContain(rfqId);
  });

  it('drops a provider whose check lapses before the deadline and one that pauses requests', async () => {
    const lapse = await h.veteranBusiness(await h.signIn('Lou Lapsing'), 'Lapsing Cement Co');
    await h.ok(moderator.token, 'POST', `/v1/moderation/sellers/${lapse.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry', expiresAt: inDays(2).slice(0, 10) });
    await h.liveListing(lapse, moderator);
    const m = await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/match`);
    expect(m.ineligible.find((x: Json) => x.orgId === lapse.orgId).reasons.join(' ')).toMatch(/expires before the deadline/);
    await h.ok(lapse.token, 'PUT', '/v1/provider/profile', { orgId: lapse.orgId, acceptsRfqs: false });
    const m2 = await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/match`);
    expect(m2.ineligible.find((x: Json) => x.orgId === lapse.orgId).reasons.join(' ')).toMatch(/Not accepting/);
    expect((await h.call(supA.token, 'PUT', '/v1/provider/profile', { orgId: lapse.orgId, acceptsRfqs: true })).status).toBe(403);
  });

  it('shows a provider profile derived from the storefront with its verification history', async () => {
    const handle = (await sys(`select handle from organizations where id = $1`, [supA.orgId])).rows[0]!.handle;
    const p = await h.ok(null, 'GET', `/v1/providers/${handle}`);
    expect(p).toMatchObject({ name: 'Alpha Cement Depot', acceptsRfqs: true, categories: [{ slug: 'cement' }], serviceAreas: [{ code: 'hilltop' }], verificationStatement: expect.stringMatching(/not a guarantee/) });
    expect(p.verification[0]).toMatchObject({ type: 'business_registration', state: 'passed' });
    expect(p.performance.websiteReviews.label).toMatch(/Website reviews/);
  });
});

describe('publish, quote, compare, revise, award (§9.2, §9.3, §10.4)', () => {
  it('publishes to every eligible provider in open mode', async () => {
    const r = await command(manager, rfqId, 'publish');
    expect(r.status).toBe(200);
    expect(r.body.invited).toBe(2);
    const v = await rfq(supA);
    expect(v).toMatchObject({ side: 'provider', invitation: { state: 'viewed' }, canQuote: true, provider: { name: 'Alpha Cement Depot' } });
    expect(v.projectId).toBeNull(); // providers see the delivery area, not the project
    expect(v).not.toHaveProperty('invitations');
    expect((await h.ok(supA.token, 'GET', '/v1/provider/rfqs')).items.map((x: Json) => x.id)).toContain(rfqId);
    expect((await h.call(indiv.token, 'GET', `/v1/rfqs/${rfqId}`)).status).toBe(404);
  });

  it('keeps drafts private and makes a submitted version immutable', async () => {
    const a = await quote(supA, rfqId, [line(cementKey, 'bag', '60', '9500', { offered: 'Dangote 42.5R' }), line(rebarKey, 'tonne', '2', '1150000')]);
    qvA1 = a.versionId;
    expect((await h.call(owner.token, 'GET', `/v1/quote-versions/${qvA1}`)).status).toBe(404); // client never sees a draft
    const sub = await h.ok(supA.token, 'POST', `/v1/quote-versions/${qvA1}/submit`, { expectedVersion: a.version });
    expect(sub.snapshotHash).toMatch(/^[0-9a-f]{64}$/);
    const v = await h.ok(supA.token, 'GET', `/v1/quote-versions/${qvA1}`);
    expect(v.state).toBe('submitted');
    expect((await h.call(supA.token, 'PUT', `/v1/quote-versions/${qvA1}`, { expectedVersion: v.version, lines: [line(cementKey, 'bag', '60', '1')], validUntil: inDays(20).slice(0, 10) })).status).toBe(409);
    await expect(sys(`update quote_versions set delivery_minor = 1 where id = $1`, [qvA1])).rejects.toThrow(/cannot be changed/);
    await expect(sys(`update quote_lines set unit_price_minor = 1 where quote_version_id = $1`, [qvA1])).rejects.toThrow(/cannot be changed/);
  });

  it('compares like for like with normalised units and keeps each provider blind to the other', async () => {
    const b = await quote(supB, rfqId, [line(cementKey, 'bag', '60', '9300'), line(rebarKey, 'kg', '2000', '1120')]);
    qvB1 = b.versionId;
    await h.ok(supB.token, 'POST', `/v1/quote-versions/${qvB1}/submit`, { expectedVersion: b.version });
    expect((await h.call(supA.token, 'GET', `/v1/quote-versions/${qvB1}`)).status).toBe(404);
    const c = await h.ok(owner.token, 'GET', `/v1/rfqs/${rfqId}/comparison`);
    expect(c.sealed).toBe(false);
    expect(c.scope.label).toBe('Client-specified scope');
    const rebar = c.rows.find((r: Json) => r.line.lineKey === rebarKey);
    const bCell = rebar.cells.find((x: Json) => x.quoteId === b.quoteId);
    expect(bCell).toMatchObject({ comparable: true, flags: ['unit_differs'], source: { unit: 'kg', quantity: '2000', unitPriceMinor: '112000' } });
    expect(c.columns.every((x: Json) => x.likeForLike)).toBe(true);
    expect(c.lowestTotal.quoteId).toBe(b.quoteId);
  });

  it('turns a change into a new RFQ version, marks quotes for revision and hides the lowest total', async () => {
    const before = await rfq(owner);
    const r = await h.ok(manager.token, 'POST', `/v1/rfqs/${rfqId}/revise`, { expectedVersion: before.version, changeReason: 'Slab thickened', lines: [{ lineKey: cementKey, quantity: '80' }] });
    expect(r).toMatchObject({ versionNumber: 2, quotesNeedingRevision: 2, changes: ['Cement 42.5 in 50 kg bags: 60 bag → 80 bag'] });
    expect((await h.ok(supA.token, 'GET', `/v1/quote-versions/${qvA1}`)).state).toBe('needs_revision');
    const c = await h.ok(owner.token, 'GET', `/v1/rfqs/${rfqId}/comparison`);
    expect(c.columns.every((x: Json) => x.flags.needsRevision)).toBe(true);
    expect(c.lowestTotal).toBeNull();
    // Supplier A re-quotes: a new version, prefilled from the old one, never an edit of it.
    const a2 = await h.ok(supA.token, 'POST', `/v1/rfqs/${rfqId}/quotes`);
    qvA2 = a2.versionId;
    const draft = await h.ok(supA.token, 'GET', `/v1/quote-versions/${qvA2}`);
    expect(draft).toMatchObject({ number: 2, state: 'draft', rfqVersionNumber: 2 });
    expect(draft.lines.find((l: Json) => l.rfqLineKey === cementKey)).toMatchObject({ quantity: '80', unitPrice: '9500', offered: 'Dangote 42.5R' });
    await h.ok(supA.token, 'POST', `/v1/quote-versions/${qvA2}/submit`, { expectedVersion: draft.version });
    expect((await h.ok(supA.token, 'GET', `/v1/quote-versions/${qvA1}`)).state).toBe('revised');
    const q = await h.ok(owner.token, 'POST', `/v1/quotes/${a2.quoteId}/clarifications`, { body: 'Can you deliver on Saturday?' });
    expect(q.id).toBeTruthy();
    expect((await h.ok(supA.token, 'GET', `/v1/quotes/${a2.quoteId}/clarifications`)).items[0]).toMatchObject({ side: 'client', body: 'Can you deliver on Saturday?' });
  });

  it('lets only the owner award a current, valid quote, and stores its exact terms on a record-only order', async () => {
    expect((await command(manager, rfqId, 'close')).status).toBe(200);
    const v = await rfq(owner);
    expect((await h.call(manager.token, 'POST', `/v1/rfqs/${rfqId}/award`, { quoteVersionId: qvA2, expectedVersion: v.version })).status).toBe(404);
    const blocked = await h.call(owner.token, 'POST', `/v1/rfqs/${rfqId}/award`, { quoteVersionId: qvB1, expectedVersion: v.version });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.message).toMatch(/earlier version/);
    const award = await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/award`, { quoteVersionId: qvA2, expectedVersion: v.version, reason: 'Only current quote' });
    orderId = award.orderId;
    expect(award.paymentNotice).toMatch(/does not process, hold or protect/);
    const o = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`);
    const qv = (await sys(`select snapshot_hash, totals from quote_versions where id = $1`, [qvA2])).rows[0]!;
    expect(o).toMatchObject({ state: 'placed', paymentMode: 'record_only', termsHash: qv.snapshot_hash, quoteVersionId: qvA2, reference: 'PO-001' });
    expect(o.total.amountMinor).toBe(JSON.parse(JSON.stringify(qv.totals)).grossMinor ?? (qv.totals as Json).grossMinor);
    expect(o.terms.lines.find((l: Json) => l.rfqLineKey === cementKey)).toMatchObject({ quantity: '80', unitPriceMinor: '950000' });
    expect(o.commands).toEqual(['cancel']);
    expect((await rfq(owner)).state).toBe('awarded');
    expect((await sys(`select status from quotes where id = (select quote_id from quote_versions where id = $1)`, [qvB1])).rows[0]!.status).toBe('rejected');
    const po = await h.ok(supA.token, 'GET', `/v1/orders/${orderId}`);
    expect(po.commands).toEqual(['confirm', 'cancel']);
    expect(po.projectId).toBeNull();
    expect((await h.call(supB.token, 'GET', `/v1/orders/${orderId}`)).status).toBe(404);
    await h.ok(supA.token, 'POST', `/v1/orders/${orderId}/commands/confirm`, { expectedVersion: po.version });
    expect((await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`)).state).toBe('confirmed');
    expect((await h.ok(owner.token, 'GET', `/v1/projects/${projectId}/rfqs`)).orders[0]).toMatchObject({ reference: 'PO-001', state: 'confirmed' });
  });
});

describe('invited, sealed RFQs and quote-request seeds (§19.2, §3.17)', () => {
  let sealedId: string; let qvSealed: string;

  it('hides prices until the deadline and refuses to close early', async () => {
    sealedId = (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Sealed cement', categorySlug: 'cement', estimateVersionId: versionId, deadline: inDays(4), sourcingMode: 'invited' })).id;
    expect((await rfq(owner, sealedId)).sealed).toBe(true);
    const inv = await h.ok(owner.token, 'POST', `/v1/rfqs/${sealedId}/invitations`, { providerOrgIds: [supA.orgId, indiv.orgId] });
    expect(inv.invited).toEqual([supA.orgId]);
    expect(inv.refused[0].reasons.join(' ')).toMatch(/Business registration/);
    expect((await command(owner, sealedId, 'publish')).body.invited).toBe(1);
    const lines = (await rfq(supA, sealedId)).lines;
    const a = await quote(supA, sealedId, lines.map((l: Json) => line(l.lineKey, l.unit, l.quantity, '9000')));
    qvSealed = a.versionId;
    await h.ok(supA.token, 'POST', `/v1/quote-versions/${qvSealed}/submit`, { expectedVersion: a.version });
    const c = await h.ok(owner.token, 'GET', `/v1/rfqs/${sealedId}/comparison`);
    expect(c).toMatchObject({ sealed: true, count: 1 });
    expect(c).not.toHaveProperty('columns');
    expect((await h.call(owner.token, 'GET', `/v1/quote-versions/${qvSealed}`)).status).toBe(404); // RLS hides sealed prices
    expect((await command(owner, sealedId, 'close')).body.error.code).toBe('SEALED_UNTIL_DEADLINE');
  });

  it('closes at the deadline (worker) and then shows the prices', async () => {
    await sys(`update rfqs set deadline = now() - interval '1 minute' where id = $1`, [sealedId]);
    const late = await h.call(supA.token, 'POST', `/v1/rfqs/${sealedId}/quotes`);
    expect(late.status).toBe(409);
    const t = await h.services.db.tx({ kind: 'system' }, (sql) => runProcurementTimers(sql));
    expect(t.closed).toBeGreaterThanOrEqual(1);
    expect((await rfq(owner, sealedId)).state).toBe('closed');
    const c = await h.ok(owner.token, 'GET', `/v1/rfqs/${sealedId}/comparison`);
    expect(c.sealed).toBe(false);
    expect(c.columns).toHaveLength(1);
    expect(c.lowestTotalNote).toMatch(/Only one quote/);
    expect((await command(owner, sealedId, 'no_award', { reason: 'Budget moved to next phase' })).body.state).toBe('no_award');
    expect((await h.ok(supA.token, 'GET', `/v1/quote-versions/${qvSealed}`)).state).toBe('rejected');
  });

  it('turns a website quote request into an RFQ that invites that seller', async () => {
    const qr = await h.ok(owner.token, 'POST', `/v1/listings/${listingA}/quote-requests`, { quantity: '40', unit: 'bag', deliveryArea: 'hilltop', notes: 'Grade 42.5 only' });
    const src = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}/rfq-sources`);
    expect(src.quoteRequests.map((x: Json) => x.id)).toContain(qr.id);
    const id = (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'From my enquiry', categorySlug: 'cement', quoteRequestId: qr.id, deadline: inDays(3), sourcingMode: 'invited' })).id;
    const v = await rfq(owner, id);
    expect(v.lines[0]).toMatchObject({ quantity: '40', unit: 'bag', provenance: { source: 'quote_request', label: 'From a website quote request' } });
    expect((await command(owner, id, 'publish')).body.invited).toBe(1);
    expect((await rfq(owner, id)).invitations[0]).toMatchObject({ providerOrgId: supA.orgId, source: 'quote_request' });
    const d = await h.ok(supA.token, 'POST', `/v1/rfqs/${id}/decline`, { reason: 'Out of stock until next month' });
    expect(d.state).toBe('declined');
    await sys(`update rfqs set deadline = now() - interval '1 minute' where id = $1`, [id]);
    await h.services.db.tx({ kind: 'system' }, (sql) => runProcurementTimers(sql));
    const c = await h.ok(owner.token, 'GET', `/v1/rfqs/${id}/comparison`);
    expect(c.noBids[0]).toMatchObject({ providerName: 'Alpha Cement Depot', reason: 'Out of stock until next month' });
  });
});
