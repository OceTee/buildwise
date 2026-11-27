import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { drainBackground } from '../src/modules/documents.js';
import { runProcurementTimers } from '../src/modules/procurement.js';
import { harness, pdf, type Json } from './helpers.js';

/**
 * R3 last slice: sealed tenders (package, shared clarifications, sealing enforced by row-level security, opening at
 * the deadline, evaluation, award as a contract), client supplier lists and conflict checks, sourcing modes,
 * milestones, variations with award revisions, and supplier uploads through the document pipeline.
 */
let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let owner: User, manager: User, moderator: User, ops: User, supA: User, supB: User, supC: User, supD: User;
let projectId: string, versionId: string, tenderId: string, orderId: string, cementKey: string, rebarKey: string;
let bidA: string, bidB: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const day = (d: number) => inDays(d).slice(0, 10);
const sys = (q: string, p: unknown[] = []) => h.services.db.tx({ kind: 'system' }, (sql) => sql.query(q, p));
const view = (u: User, id = tenderId) => h.ok(u.token, 'GET', `/v1/rfqs/${id}`);
const handleOf = async (orgId: string) => (await sys(`select handle from organizations where id = $1`, [orgId])).rows[0]!.handle as string;
/** What a signed-in user can read with row-level security on (the API's own transaction setup), outside any route. */
const asUser = <T>(userId: string, fn: (q: (text: string, p?: unknown[]) => Promise<Json[]>) => Promise<T>) =>
  h.services.db.tx({ kind: 'user', userId }, (sql) => fn(async (text, p = []) => (await sql.query<Json>(text, p)).rows));

const PACKAGE = {
  scope: 'Supply of cement and reinforcement for the ground-floor slab, delivered to site in two drops, with offloading.',
  siteVisitRequired: true, siteVisitNote: 'Call the site manager to arrange a visit before you bid.',
  startDate: day(10), finishDate: day(66), conditions: 'Deliveries between 8am and 4pm only.', retentionPct: 5,
  responseFields: ['programme', 'method', 'inclusions'],
};
const RESPONSE = { startDate: day(10), programmeWeeks: 6, method: 'Two drops by flatbed with a hiab; offload to the covered store.', inclusions: ['Offloading', 'Waybills'], siteVisitConfirmed: true, conflict: { declared: false, details: null } };
const line = (key: string, unit: string, quantity: string, unitPrice: string) => ({ rfqLineKey: key, status: 'priced', unit, quantity, unitPrice, taxRatePct: 7.5 });

async function bid(u: User, id: string, cement: string, extra: Json = {}) {
  const d = await h.ok(u.token, 'POST', `/v1/rfqs/${id}/quotes`);
  const v = await h.ok(u.token, 'GET', `/v1/quote-versions/${d.versionId}`);
  await h.ok(u.token, 'PUT', `/v1/quote-versions/${d.versionId}`, {
    expectedVersion: v.version, lines: [line(cementKey, 'bag', '60', cement), line(rebarKey, 'tonne', '2', '1150000')], validUntil: day(40), deliveryCharge: '15000', deliveryTaxRatePct: 7.5,
    paymentTerms: 'Milestones as tendered', tenderResponse: RESPONSE, ...extra,
  });
  const fresh = await h.ok(u.token, 'GET', `/v1/quote-versions/${d.versionId}`);
  return { versionId: d.versionId as string, quoteId: d.quoteId as string, version: fresh.version as number, problems: fresh.problems as string[] };
}

beforeAll(async () => {
  h = await harness();
  moderator = await h.signIn('Mo Moderator', { staff: 'moderator' });
  ops = await h.signIn('Opal Ops', { staff: 'ops_admin' });
  owner = await h.signIn('Ola Owner');
  manager = await h.signIn('Mia Manager');
  supA = await h.veteranBusiness(await h.signIn('Ada Supplier'), 'Alpha Cement Depot');
  supB = await h.veteranBusiness(await h.signIn('Ben Supplier'), 'Bravo Building Supplies');
  supC = await h.veteranBusiness(await h.signIn('Cy Supplier'), 'Charlie Cement');
  supD = await h.veteranBusiness(await h.signIn('Di Supplier'), 'Delta Depot');
  for (const s of [supA, supB, supC, supD]) {
    await h.ok(moderator.token, 'POST', `/v1/moderation/sellers/${s.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup (test)' });
    await h.liveListing(s, moderator);
  }
  projectId = (await h.ok(owner.token, 'POST', '/v1/projects', { name: 'Hilltop slab', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'construction' })).id;
  await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/invitations`, { phone: manager.phone, role: 'manager' });
  const inv = (await h.ok(manager.token, 'GET', '/v1/me/project-invitations')).items[0];
  await h.ok(manager.token, 'POST', `/v1/project-invitations/${inv.id}/respond`, { accept: true });
  // The manager is also a member of Delta Depot: a conflict of interest beyond "your own organization".
  await sys(`insert into org_members (org_id, user_id, role) values ($1, $2, 'member')`, [supD.orgId, manager.id]);
  const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: 'Slab BoQ' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: 'description,qty,unit,section,specification\nCement 42.5 in 50 kg bags,60,bags,substructure,Grade 42.5\nY12 reinforcement bars,2,tonne,frame,' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/share`);
  versionId = e.versionId;
});
afterAll(async () => { await drainBackground(); await h?.close(); });

describe('a tender package (§10.5 step 1)', () => {
  it('needs a package, goes to invited bidders only, and keeps the package editable only in draft', async () => {
    const base = { title: 'Slab materials tender', categorySlug: 'cement', estimateVersionId: versionId, deadline: inDays(5), kind: 'tender' };
    expect((await h.call(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { ...base, sourcingMode: 'invited' })).status).toBe(400);
    expect((await h.call(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { ...base, sourcingMode: 'open', package: PACKAGE })).status).toBe(400);
    expect((await h.call(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { ...base, deadline: inDays(1.5), sourcingMode: 'invited', package: PACKAGE })).status).toBe(400);
    const bad = await h.call(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { ...base, sourcingMode: 'invited', package: { ...PACKAGE, scope: 'Cement', retentionPct: 40 } });
    expect(bad.status).toBe(422);
    tenderId = (await h.ok(manager.token, 'POST', `/v1/projects/${projectId}/rfqs`, { ...base, sourcingMode: 'invited', package: PACKAGE })).id;
    const v = await view(owner);
    expect(v).toMatchObject({ kind: 'tender', reference: 'TND-001', sealed: true, rfqType: 'trade', tender: { package: { retentionPct: 5, siteVisitRequired: true } } });
    [cementKey, rebarKey] = v.lines.map((l: Json) => l.lineKey);
    expect(v.commands).not.toContain('close');
    const upd = await h.ok(owner.token, 'PUT', `/v1/rfqs/${tenderId}/package`, { ...PACKAGE, conditions: 'Deliveries 8am–4pm; no Sunday work.', expectedVersion: v.version });
    expect(upd.package.conditions).toMatch(/Sunday/);
    expect((await h.call(supA.token, 'GET', `/v1/rfqs/${tenderId}`)).status).toBe(404);
  });
});

describe('client supplier lists and conflicts of interest (§13.1.5)', () => {
  it('keeps traceable lists: blocks and conflicts need a reason, contradictions are refused', async () => {
    const add = (u: User, body: Json) => h.call(u.token, 'POST', `/v1/projects/${projectId}/supplier-lists`, body);
    expect((await add(owner, { handle: await handleOf(supC.orgId), kind: 'blocked' })).status).toBe(422);
    expect((await add(owner, { handle: await handleOf(supC.orgId), kind: 'blocked', reason: 'Short-delivered twice last year' })).status).toBe(201);
    expect((await add(manager, { handle: await handleOf(supB.orgId), kind: 'preferred' })).status).toBe(201);
    expect((await add(owner, { handle: await handleOf(supC.orgId), kind: 'approved' })).status).toBe(409);
    expect((await add(owner, { handle: 'no-such-supplier', kind: 'preferred' })).status).toBe(400);
    const lists = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}/supplier-lists`);
    expect(lists.items.map((i: Json) => [i.provider.name, i.kind])).toEqual(expect.arrayContaining([['Charlie Cement', 'blocked'], ['Bravo Building Supplies', 'preferred']]));
    await expect(sys(`update supplier_lists set reason = 'edited' where provider_org_id = $1`, [supC.orgId])).rejects.toThrow(/cannot be changed/);
  });

  it('applies the lists and the conflict checks when matching, preferred suppliers first', async () => {
    const m = await h.ok(owner.token, 'POST', `/v1/rfqs/${tenderId}/match`);
    expect(m.sourcingMode).toBe('invited');
    expect(m.eligible.map((e: Json) => e.name)).toEqual(['Bravo Building Supplies', 'Alpha Cement Depot']);
    expect(m.eligible[0].labels).toContain('Preferred supplier');
    const why = Object.fromEntries(m.ineligible.map((x: Json) => [x.name, x.reasons.join(' ')]));
    expect(why['Charlie Cement']).toMatch(/blocked list: Short-delivered/);
    expect(why['Delta Depot']).toMatch(/Mia Manager is on your project team/);
    const r = await h.ok(owner.token, 'POST', `/v1/rfqs/${tenderId}/invitations`, { providerOrgIds: [supA.orgId, supB.orgId, supC.orgId, supD.orgId] });
    expect(r.invited.sort()).toEqual([supA.orgId, supB.orgId].sort());
    expect(r.refused.map((x: Json) => x.orgId).sort()).toEqual([supC.orgId, supD.orgId].sort());
  });

  it('the approved-supplier mode invites only approved suppliers; the named mode only those named', async () => {
    const mk = async (mode: string) => (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: `Cement ${mode}`, categorySlug: 'cement', estimateVersionId: versionId, deadline: inDays(5), sourcingMode: mode })).id as string;
    const fw = await mk('framework');
    expect((await h.ok(owner.token, 'POST', `/v1/rfqs/${fw}/match`)).eligible).toEqual([]);
    await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/supplier-lists`, { handle: await handleOf(supA.orgId), kind: 'approved', categorySlugs: ['cement'] });
    const m = await h.ok(owner.token, 'POST', `/v1/rfqs/${fw}/match`);
    expect(m.eligible.map((e: Json) => e.name)).toEqual(['Alpha Cement Depot']);
    expect(m.ineligible.find((x: Json) => x.name === 'Bravo Building Supplies').reasons[0]).toMatch(/Not on your approved supplier list/);
    const pub = await h.ok(owner.token, 'POST', `/v1/rfqs/${fw}/commands/publish`, { expectedVersion: (await view(owner, fw)).version });
    expect(pub.invited).toBe(1);

    const nm = await mk('nominated');
    expect((await h.call(owner.token, 'POST', `/v1/rfqs/${tenderId}/nominations`, { handles: [await handleOf(supB.orgId)] })).status).toBe(409);
    await h.ok(owner.token, 'POST', `/v1/rfqs/${nm}/nominations`, { handles: [await handleOf(supB.orgId), await handleOf(supC.orgId)] });
    const n = await h.ok(owner.token, 'POST', `/v1/rfqs/${nm}/match`);
    expect(n.eligible.map((e: Json) => e.name)).toEqual(['Bravo Building Supplies']);
    expect(n.eligible[0].labels).toEqual(expect.arrayContaining(['Named by you', 'Preferred supplier']));
    expect(n.ineligible.find((x: Json) => x.name === 'Alpha Cement Depot').reasons[0]).toMatch(/Not one of the suppliers you named/);
    expect(n.ineligible.find((x: Json) => x.name === 'Charlie Cement').reasons.join(' ')).toMatch(/blocked/);
    for (const id of [fw, nm]) await h.ok(owner.token, 'POST', `/v1/rfqs/${id}/commands/cancel`, { expectedVersion: (await view(owner, id)).version, reason: 'Test request only' });
  });
});

describe('publication and clarifications shared with every bidder (§10.5 step 5)', () => {
  it('publishes to the invited bidders, who see the package', async () => {
    const r = await h.ok(owner.token, 'POST', `/v1/rfqs/${tenderId}/commands/publish`, { expectedVersion: (await view(owner)).version });
    expect(r.invited).toBe(2);
    const p = await view(supA);
    expect(p).toMatchObject({ side: 'provider', kind: 'tender', projectId: null, tender: { package: { scope: expect.stringMatching(/ground-floor slab/) }, canAsk: true } });
    expect((await h.call(owner.token, 'PUT', `/v1/rfqs/${tenderId}/package`, { ...PACKAGE, expectedVersion: (await view(owner)).version })).status).toBe(409);
  });

  it('a question is private until answered; the answer goes to every bidder without saying who asked', async () => {
    const q = await h.ok(supA.token, 'POST', `/v1/rfqs/${tenderId}/clarifications`, { question: 'Is offloading by hand acceptable?' });
    expect((await view(supB)).tender.clarifications).toEqual([]);
    const forB = await asUser(supB.id, (rows) => rows(`select * from tender_clarifications where rfq_id = $1`, [tenderId]));
    expect(forB).toEqual([]);
    expect((await h.call(supA.token, 'POST', `/v1/tender-clarifications/${q.id}/answer`, { answer: 'Answering my own question' })).status).toBe(404);
    await h.ok(owner.token, 'POST', `/v1/tender-clarifications/${q.id}/answer`, { answer: 'Yes, with two people; a hiab is preferred.' });
    const b = (await view(supB)).tender.clarifications;
    expect(b).toEqual([expect.objectContaining({ question: 'Is offloading by hand acceptable?', answer: expect.stringMatching(/hiab/), mine: false, askedByOrgId: null })]);
    expect((await view(supA)).tender.clarifications[0].mine).toBe(true);
    // Who asked never reaches other bidders, not even through the database.
    expect(await asUser(supB.id, (rows) => rows(`select * from tender_clarification_askers where rfq_id = $1`, [tenderId]))).toEqual([]);
    expect((await view(owner)).tender.clarifications[0].askedBy).toBe('Alpha Cement Depot');
    const notice = await h.ok(owner.token, 'POST', `/v1/rfqs/${tenderId}/clarifications`, { question: 'Addendum 1: delivery address', answer: 'Use the north gate.' });
    expect(notice.warning).toBeNull();
    expect((await view(supB)).tender.clarifications).toHaveLength(2);
  });
});

describe('sealed bids (§10.5, §19.2)', () => {
  it('a bid needs the tender response; a bidder can withdraw and bid again before the deadline', async () => {
    const empty = await bid(supA, tenderId, '9500', { tenderResponse: {} });
    expect(empty.problems.join(' ')).toMatch(/programme/);
    const r = await h.call(supA.token, 'POST', `/v1/quote-versions/${empty.versionId}/submit`, { expectedVersion: empty.version });
    expect(r.status).toBe(422);
    const a = await bid(supA, tenderId, '9500');
    expect(a.problems).toEqual([]);
    await h.ok(supA.token, 'POST', `/v1/quote-versions/${a.versionId}/submit`, { expectedVersion: a.version });
    bidA = a.versionId;
    const b1 = await bid(supB, tenderId, '9400');
    await h.ok(supB.token, 'POST', `/v1/quote-versions/${b1.versionId}/submit`, { expectedVersion: b1.version });
    await h.ok(supB.token, 'POST', `/v1/quote-versions/${b1.versionId}/withdraw`, { reason: 'Price error' });
    const b2 = await bid(supB, tenderId, '9200');
    await h.ok(supB.token, 'POST', `/v1/quote-versions/${b2.versionId}/submit`, { expectedVersion: b2.version });
    bidB = b2.versionId;
  });

  it('stays unreadable before the deadline to members and to staff with an access session', async () => {
    const v = await view(owner);
    expect(v.quotes).toMatchObject({ count: 2, pricesOpen: false });
    const c = await h.ok(owner.token, 'GET', `/v1/rfqs/${tenderId}/comparison`);
    expect(c).toMatchObject({ sealed: true, kind: 'tender', count: 2 });
    expect(JSON.stringify(c)).not.toMatch(/9200|9500|totals/);
    expect((await h.call(owner.token, 'GET', `/v1/quote-versions/${bidB}`)).status).toBe(404);
    expect(await asUser(owner.id, (rows) => rows(`select id from quote_versions where rfq_id = $1`, [tenderId]))).toEqual([]);
    expect(await asUser(owner.id, (rows) => rows(`select id from quote_lines where quote_id in (select id from quotes where rfq_id = $1)`, [tenderId]))).toEqual([]);
    // Staff in the app_user role with a reason-coded access session see the project, never the sealed bids.
    await h.ok(ops.token, 'POST', '/v1/staff/access-sessions', { projectId, reasonCode: 'support_request', ticket: 'SUP-2001' });
    expect((await h.ok(ops.token, 'GET', `/v1/rfqs/${tenderId}/comparison`)).sealed).toBe(true);
    expect(await asUser(ops.id, (rows) => rows(`select id, totals, tender_response from quote_versions where rfq_id = $1`, [tenderId]))).toEqual([]);
    expect((await asUser(ops.id, (rows) => rows(`select count(*)::int as n from quotes where rfq_id = $1`, [tenderId])))[0]!.n).toBe(2);
    // The bidder still reads its own bid.
    expect((await h.ok(supB.token, 'GET', `/v1/quote-versions/${bidB}`)).totals.gross.amountMinor).toBeTruthy();
  });

  it('cannot be opened or closed early, by the API or the database', async () => {
    expect((await h.call(owner.token, 'POST', `/v1/rfqs/${tenderId}/open`, { expectedVersion: (await view(owner)).version })).status).toBe(409);
    expect((await h.call(owner.token, 'POST', `/v1/rfqs/${tenderId}/commands/close`, { expectedVersion: (await view(owner)).version })).status).toBe(409);
    await expect(sys(`update rfqs set opened_at = now() where id = $1`, [tenderId])).rejects.toThrow(/sealed until the deadline/);
    await expect(sys(`update rfqs set state = 'closed' where id = $1`, [tenderId])).rejects.toThrow(/bid opening/);
    await expect(sys(`insert into tender_openings (id, rfq_id, project_id, record, record_hash) values (gen_random_uuid(), $1, $2, '{}', 'x')`, [tenderId, projectId])).rejects.toThrow(/sealed until the deadline/);
  });

  it('opens all bids together at the deadline with a hashed register; late bids and withdrawals are refused', async () => {
    // The deadline passes (just after the last bid arrived).
    await sys(`update rfqs set deadline = now() - interval '20 milliseconds' where id = $1`, [tenderId]);
    expect((await h.call(supA.token, 'POST', `/v1/quote-versions/${bidA}/withdraw`, { reason: 'Too late' })).status).toBe(409);
    expect((await h.call(supA.token, 'POST', `/v1/rfqs/${tenderId}/quotes`)).status).toBe(409);
    // Still sealed after the deadline until the opening is recorded.
    expect((await h.ok(owner.token, 'GET', `/v1/rfqs/${tenderId}/comparison`)).sealed).toBe(true);
    const o = await h.ok(owner.token, 'POST', `/v1/rfqs/${tenderId}/open`, { expectedVersion: (await view(owner)).version });
    expect(o.opening.bids.map((b: Json) => b.providerName)).toEqual(['Alpha Cement Depot', 'Bravo Building Supplies']);
    expect(o.opening.bids[1].quoteVersionId).toBe(bidB);
    expect(o.recordHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await h.call(owner.token, 'POST', `/v1/rfqs/${tenderId}/open`, { expectedVersion: (await view(owner)).version })).status).toBe(409);
    await expect(sys(`update rfqs set opened_at = now() where id = $1`, [tenderId])).rejects.toThrow(/already opened/);
    const audit = (await sys(`select metadata from audit_events where action = 'tender.opened' and target_id = $1`, [tenderId])).rows;
    expect(audit).toHaveLength(1);
    const v = await view(owner);
    expect(v).toMatchObject({ state: 'closed', quotes: { pricesOpen: true }, tender: { opening: { recordHash: o.recordHash } } });
    expect((await view(supB)).tender.openedAt).toBeTruthy();
  });

  it('the worker opens a due tender by itself', async () => {
    const id = (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Second tender', categorySlug: 'cement', estimateVersionId: versionId, deadline: inDays(5), sourcingMode: 'invited', kind: 'tender', package: PACKAGE })).id;
    await h.ok(owner.token, 'POST', `/v1/rfqs/${id}/invitations`, { providerOrgIds: [supA.orgId] });
    await h.ok(owner.token, 'POST', `/v1/rfqs/${id}/commands/publish`, { expectedVersion: (await view(owner, id)).version });
    await sys(`update rfqs set deadline = now() - interval '1 minute' where id = $1`, [id]);
    const t = await h.services.db.tx({ kind: 'system' }, (sql) => runProcurementTimers(sql, h.services));
    expect(t.opened).toBe(1);
    const v = await view(owner, id);
    expect(v).toMatchObject({ state: 'closed', tender: { opening: { record: { competition: 'none', openedBy: 'system' } } } });
  });
});

describe('evaluation and award (§10.5 steps 4, 6)', () => {
  it('compares normalised prices beside the responses; evaluators declare interests before scoring', async () => {
    const c = await h.ok(owner.token, 'GET', `/v1/rfqs/${tenderId}/comparison`);
    expect(c.sealed).toBe(false);
    expect(c.lowestTotal.quoteId).toBe(c.columns.find((x: Json) => x.providerName === 'Bravo Building Supplies').quoteId);
    expect(c.tender.responses.find((r: Json) => r.providerName === 'Alpha Cement Depot').response).toMatchObject({ programmeWeeks: 6, inclusions: ['Offloading', 'Waybills'] });
    const qa = c.columns.find((x: Json) => x.providerName === 'Alpha Cement Depot').quoteId;
    const qb = c.columns.find((x: Json) => x.providerName === 'Bravo Building Supplies').quoteId;
    const scores = (s: number) => c.tender.evaluation.criteria.map((k: Json) => ({ criterion: k.key, score: s }));
    expect((await h.call(owner.token, 'PUT', `/v1/rfqs/${tenderId}/scores`, { quoteId: qa, scores: scores(4) })).status).toBe(409);
    await h.ok(manager.token, 'POST', `/v1/rfqs/${tenderId}/declaration`, { conflict: true, details: 'Member of Delta Depot, which was not invited' });
    expect((await h.call(manager.token, 'PUT', `/v1/rfqs/${tenderId}/scores`, { quoteId: qa, scores: scores(5) })).status).toBe(403);
    await h.ok(owner.token, 'POST', `/v1/rfqs/${tenderId}/declaration`, { conflict: false });
    expect((await h.call(owner.token, 'PUT', `/v1/rfqs/${tenderId}/scores`, { quoteId: qa, scores: scores(9) })).status).toBe(400);
    await h.ok(owner.token, 'PUT', `/v1/rfqs/${tenderId}/scores`, { quoteId: qa, scores: scores(5) });
    await h.ok(owner.token, 'PUT', `/v1/rfqs/${tenderId}/scores`, { quoteId: qb, scores: scores(4) });
    const e = (await h.ok(owner.token, 'GET', `/v1/rfqs/${tenderId}/comparison`)).tender;
    expect(e.evaluation).toMatchObject({ evaluators: 1, excluded: 1 });
    expect(e.evaluation.bids.every((b: Json) => b.total != null && b.rank != null)).toBe(true);
    expect(e.declarations.map((d: Json) => d.conflict)).toEqual([true, false]);
  });

  it('awards a contract that keeps the retention, with revision 1 as the award', async () => {
    const r = await h.ok(owner.token, 'POST', `/v1/rfqs/${tenderId}/award`, { quoteVersionId: bidB, expectedVersion: (await view(owner)).version, reason: 'Best value on price and quality' });
    orderId = r.orderId;
    const o = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`);
    expect(o).toMatchObject({ kind: 'contract', reference: expect.stringMatching(/^CT-/), retentionPct: 5, revisionNumber: 1 });
    expect(o.contractValue.amountMinor).toBe(o.total.amountMinor);
    await expect(sys(`update tender_scores set score = 1 where rfq_id = $1`, [tenderId])).rejects.toThrow(/fixed once the tender is decided/);
    await h.ok(supB.token, 'POST', `/v1/orders/${orderId}/commands/confirm`, { expectedVersion: o.version });
  });
});

describe('milestones and record-only payments (§9.5, §14.1)', () => {
  let m1: string, m2: string;
  const ms = (u: User) => h.ok(u.token, 'GET', `/v1/orders/${orderId}/contract`);
  const cmd = async (u: User, id: string, c: string, body: Json = {}) => {
    const m = (await ms(owner)).milestones.find((x: Json) => x.id === id);
    return h.call(u.token, 'POST', `/v1/milestones/${id}/commands/${c}`, { expectedVersion: m.version, ...body });
  };

  it('the client sets milestones within the contract value', async () => {
    const value = BigInt((await ms(owner)).contractValue.amountMinor) / 100n;
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/milestones`, { milestones: [{ title: 'Everything', amount: String(value + 1n) }] })).status).toBe(422);
    expect((await h.call(supB.token, 'POST', `/v1/orders/${orderId}/milestones`, { milestones: [{ title: 'Mine', amount: '1' }] })).status).toBe(403);
    const half = value / 2n;
    const r = await h.ok(manager.token, 'POST', `/v1/orders/${orderId}/milestones`, { milestones: [{ title: 'First drop delivered', amount: String(half), dueDate: day(14) }, { title: 'Second drop delivered', amount: String(value - half) }] });
    [m1, m2] = r.ids;
    const c = await ms(supB);
    expect(c.milestones.map((m: Json) => m.state)).toEqual(['not_started', 'not_started']);
    expect(c.summary.unscheduledMinor.amountMinor).toBe('0');
  });

  it('runs a milestone to sign-off; the contract follows its milestones', async () => {
    expect((await cmd(owner, m1, 'start')).status).toBe(403);
    expect((await cmd(supB, m1, 'start')).status).toBe(200);
    expect((await cmd(supB, m1, 'claim')).status).toBe(400);
    expect((await cmd(supB, m1, 'claim', { evidenceNote: 'First drop offloaded, waybill WB-1' })).status).toBe(200);
    expect((await cmd(owner, m1, 'reject')).status).toBe(400);
    const a = await cmd(owner, m1, 'accept');
    expect(a.body).toMatchObject({ state: 'complete', orderState: 'partially_fulfilled' });
    await expect(sys(`update order_milestones set amount_minor = 1 where id = $1`, [m1])).rejects.toThrow(/fixed/);
    const m = (await ms(owner)).milestones.find((x: Json) => x.id === m1);
    expect(m.history.map((e: Json) => e.command)).toEqual(['create', 'start', 'claim', 'accept']);
  });

  it('records a payment only against a completed milestone, within what is left after retention', async () => {
    const m = (await ms(owner)).milestones.find((x: Json) => x.id === m1);
    const payable = BigInt(m.payable.amountMinor);
    expect(BigInt(m.retention.amountMinor)).toBe(BigInt(m.amount.amountMinor) * 5n / 100n);
    const pay = (milestoneId: string, minor: bigint) => h.call(owner.token, 'POST', `/v1/orders/${orderId}/payments`, { amount: `${minor / 100n}.${String(minor % 100n).padStart(2, '0')}`, paidOn: day(0), method: 'bank_transfer', reference: 'TRF-1', milestoneId });
    expect((await pay(m2, 100n)).status).toBe(409);
    expect((await pay(m1, payable + 100n)).status).toBe(422);
    const r = await pay(m1, payable);
    expect(r.status).toBe(201);
    expect(r.body.notice).toMatch(/does not process, hold or protect/);
    const after = (await ms(owner)).milestones.find((x: Json) => x.id === m1);
    expect(after.payable.amountMinor).toBe('0');
    expect((await h.ok(supB.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).payments.items[0].milestoneId).toBe(m1);
  });
});

describe('variations and award revisions (§9.6)', () => {
  const vars = async () => (await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/contract`)).variations;
  const vcmd = async (u: User, id: string, c: string, body: Json = {}) => {
    const v = (await vars()).find((x: Json) => x.id === id);
    return h.call(u.token, 'POST', `/v1/variations/${id}/commands/${c}`, { expectedVersion: v.version, ...body });
  };
  let v1: string;

  it('the provider proposes a priced variation; the owner sends it back, it is re-priced and approved, writing revision 2', async () => {
    const before = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/contract`);
    const p = await h.ok(supB.token, 'POST', `/v1/orders/${orderId}/variations`, {
      title: 'Extra cement for the ramp', description: 'Ten more bags for the garage ramp added by the client.', reason: 'Scope added on site',
      lines: [{ description: 'Cement 42.5', quantity: '10', unit: 'bag', rate: '9200' }], timeImpactDays: 2, submit: true,
    });
    v1 = p.id;
    expect(p.state).toBe('under_review');
    expect((await vcmd(manager, v1, 'approve')).status).toBe(403);
    expect((await vcmd(owner, v1, 'return')).status).toBe(400);
    expect((await vcmd(owner, v1, 'return', { note: 'Use the tendered rate of 9000' })).status).toBe(200);
    expect((await vcmd(owner, v1, 'assess', { costImpact: '90000', timeImpactDays: 2 })).status).toBe(403);
    expect((await vcmd(supB, v1, 'assess', { lines: [{ description: 'Cement 42.5', quantity: '10', unit: 'bag', rate: '9000' }], timeImpactDays: 2 })).status).toBe(200);
    expect((await vcmd(supB, v1, 'submit')).status).toBe(200);
    await expect(sys(`update variations set cost_impact_minor = 1 where id = $1`, [v1])).rejects.toThrow(/price is fixed/);
    const a = await vcmd(owner, v1, 'approve', { note: 'Approved at the tendered rate' });
    expect(a.status).toBe(200);
    const after = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/contract`);
    expect(BigInt(after.contractValue.amountMinor) - BigInt(before.contractValue.amountMinor)).toBe(90_000_00n);
    expect(after.revisions.map((r: Json) => [r.number, r.timeDays])).toEqual([[1, 0], [2, 2]]);
    const v = after.variations.find((x: Json) => x.id === v1);
    expect(v.history.map((e: Json) => e.command)).toEqual(['propose', 'assess', 'submit', 'return', 'assess', 'submit', 'approve']);
    expect((await h.ok(supB.token, 'GET', `/v1/orders/${orderId}`)).revisionNumber).toBe(2);
    // Revisions are append-only for every signed-in user.
    await expect(asUser(owner.id, (rows) => rows(`update award_revisions set value_minor = 1 where order_id = $1`, [orderId]))).rejects.toThrow(/permission denied/);
  });

  it('a client’s proposal waits for the provider’s price, so the client never approves its own price', async () => {
    const p = await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/variations`, { title: 'Omit offloading', description: 'Our labourers will offload the second drop.', reason: 'Saving', costImpact: '-20000', timeImpactDays: 0, submit: true });
    expect(p.state).toBe('proposed');
    expect((await vcmd(owner, p.id, 'submit')).status).toBe(409);
    expect((await vcmd(owner, p.id, 'withdraw')).status).toBe(200);
  });
});

describe('supplier uploads through the document pipeline', () => {
  async function upload(u: User, body: Json, bytes: Buffer) {
    const r = await h.ok(u.token, 'POST', `/v1/orders/${orderId}/files`, { ...body, bytes: bytes.length });
    const put = await h.app.inject({ method: 'PUT', url: r.upload.url, payload: bytes, headers: { 'content-type': 'application/octet-stream' } });
    expect(put.statusCode).toBe(200);
    await h.ok(u.token, 'POST', r.upload.complete);
    await drainBackground();
    return r.fileId as string;
  }

  it('takes a proof-of-delivery photo on a dispatched delivery and an invoice PDF, and checks what they really are', async () => {
    const terms = (await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).orderLines;
    const lk = terms[0].lineKey;
    const delId = (await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'morning', lines: [{ lineKey: lk, quantity: '10' }] })).id;
    const photo = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 90, b: 60 } } }).jpeg().toBuffer();
    expect((await h.call(supB.token, 'POST', `/v1/orders/${orderId}/files`, { purpose: 'pod_photo', deliveryId: delId, fileName: 'pod.jpg', bytes: photo.length })).status).toBe(409);
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/files`, { purpose: 'pod_photo', deliveryId: delId, fileName: 'pod.jpg', bytes: photo.length })).status).toBe(403);
    const ver = (await h.ok(supB.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).deliveries.find((d: Json) => d.id === delId).version;
    await h.ok(supB.token, 'POST', `/v1/deliveries/${delId}/dispatch`, { expectedVersion: ver, consignmentRef: 'WB-9', lines: [{ lineKey: lk, quantity: '10' }] });
    const podId = await upload(supB, { purpose: 'pod_photo', deliveryId: delId, fileName: 'pod.jpg' }, photo);
    const inv = await h.ok(supB.token, 'POST', `/v1/orders/${orderId}/invoices`, { invoiceNumber: 'INV-T1', issuedOn: day(0), statedTotal: '96750', lines: [{ lineKey: lk, quantity: '10', unitPrice: '9000', taxRatePct: 7.5 }] });
    const fakeId = await upload(supB, { purpose: 'invoice_pdf', invoiceId: inv.id, fileName: 'invoice.pdf' }, photo);
    const files = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/fulfilment`);
    const pod = files.files.items.find((f: Json) => f.id === podId);
    expect(pod).toMatchObject({ state: 'available', type: 'image/jpeg', available: true, purpose: 'pod_photo' });
    expect(files.files.items.find((f: Json) => f.id === fakeId)).toMatchObject({ state: 'rejected', available: false, stateDetail: expect.stringMatching(/not a PDF/) });
    const realId = await upload(supB, { purpose: 'invoice_pdf', invoiceId: inv.id, fileName: 'invoice.pdf' }, pdf(1));
    expect((await h.ok(supB.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).files.items.find((f: Json) => f.id === realId)).toMatchObject({ state: 'available', type: 'application/pdf' });
    expect((await h.call(supB.token, 'POST', `/v1/orders/${orderId}/files`, { purpose: 'invoice_pdf', invoiceId: inv.id, fileName: 'again.pdf', bytes: 10 })).status).toBe(409);
    const link = await h.ok(owner.token, 'POST', `/v1/order-files/${podId}/link`);
    const file = await h.app.inject({ method: 'GET', url: link.url });
    expect(file.headers['content-type']).toBe('image/jpeg');
    // The supplier reads its own upload but nothing else in the project.
    const docs = await asUser(supB.id, (rows) => rows(`select doc_type from documents where project_id = $1`, [projectId]));
    expect(docs.map((d) => d.doc_type).sort()).toEqual(['delivery_proof', 'supplier_invoice', 'supplier_invoice']);
    expect((await h.call(supB.token, 'GET', `/v1/projects/${projectId}/documents`)).status).toBe(404);
    // Outsiders cannot attach files to someone else's order through the database function either.
    const ok = await asUser(supA.id, (rows) => rows(`select supplier_file_create(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), $1, 'pod_photo', $2, null, 'x.jpg', 1, 'x') as ok`, [orderId, delId]));
    expect(ok[0]!.ok).toBe(false);
  });
});
