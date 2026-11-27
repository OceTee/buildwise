import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@bw/domain';
import { runCaseTimers } from '../src/modules/cases.js';
import { harness, type Json } from './helpers.js';

/**
 * R3 third slice: a contested discrepancy and a disputed order become cases; staff triage, ask for information,
 * propose, decide; a party appeals once and a different staff member decides it. Both sides review each other once
 * after the order completes. The provider profile shows performance figures (small samples as counts), and the
 * liquidity dashboard reports comparable responses within 72 hours.
 */
let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let mod1: User, mod2: User, ops: User, owner: User, outsider: User, supA: User, supB: User;
let projectId: string, orderId: string, rfqId: string, lineKey: string, deliveryId: string, shortageId: string, caseId: string, safetyCaseId: string, revisionId: string;
let supHandle: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const day = (d: number) => inDays(d).slice(0, 10);
const sys = <T = Json>(q: string, p: unknown[] = []) => h.services.db.tx({ kind: 'system' }, async (sql) => (await sql.query(q, p)).rows as T[]);
const staffCase = (u: User, id = caseId) => h.ok(u.token, 'GET', `/v1/moderation/cases/${id}`);
const command = async (u: User, cmd: string, body: Json = {}, id = caseId) => h.call(u.token, 'POST', `/v1/moderation/cases/${id}/commands/${cmd}`, { expectedVersion: (await staffCase(mod1, id)).version, ...body });
const orderVersion = async () => (await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`)).version;
const delVersion = async () => (await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).deliveries.find((d: Json) => d.id === deliveryId).version;

beforeAll(async () => {
  h = await harness();
  mod1 = await h.signIn('Ada Moderator', { staff: 'moderator' });
  mod2 = await h.signIn('Bayo Moderator', { staff: 'moderator' });
  ops = await h.signIn('Chi Operations', { staff: 'ops_admin' });
  owner = await h.signIn('Ola Owner');
  outsider = await h.signIn('Otto Outsider');
  supA = await h.veteranBusiness(await h.signIn('Ada Supplier'), 'Alpha Cement Depot');
  supB = await h.veteranBusiness(await h.signIn('Ben Supplier'), 'Bravo Building Supplies');
  for (const s of [supA, supB]) await h.ok(mod1.token, 'POST', `/v1/moderation/sellers/${s.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup (test)' });
  await h.liveListing(supA, mod1);
  await h.liveListing(supB, mod1, { price: '9400' });
  supHandle = (await sys<{ handle: string }>(`select handle from organizations where id = $1`, [supA.orgId]))[0]!.handle;

  projectId = (await h.ok(owner.token, 'POST', '/v1/projects', { name: 'Hilltop bungalow', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'construction' })).id;
  const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: 'Slab list' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: 'description,qty,unit,section,specification\nCement 42.5 in 50 kg bags,60,bag,substructure,Grade 42.5' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/share`);
  rfqId = (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Slab cement', categorySlug: 'cement', estimateVersionId: e.versionId, deadline: inDays(5), sourcingMode: 'open' })).id;
  const rv = async () => (await h.ok(owner.token, 'GET', `/v1/rfqs/${rfqId}`)).version;
  await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/commands/publish`, { expectedVersion: await rv() });
  lineKey = (await h.ok(supA.token, 'GET', `/v1/rfqs/${rfqId}`)).lines[0].lineKey;
  const d = await h.ok(supA.token, 'POST', `/v1/rfqs/${rfqId}/quotes`);
  const v = await h.ok(supA.token, 'GET', `/v1/quote-versions/${d.versionId}`);
  await h.ok(supA.token, 'PUT', `/v1/quote-versions/${d.versionId}`, {
    expectedVersion: v.version, validUntil: day(20), deliveryCharge: '15000', deliveryTaxRatePct: 7.5, paymentTerms: 'On delivery',
    lines: [{ rfqLineKey: lineKey, status: 'priced', unit: 'bag', quantity: '60', unitPrice: '9200', taxRatePct: 7.5 }],
  });
  await h.ok(supA.token, 'POST', `/v1/quote-versions/${d.versionId}/submit`, { expectedVersion: (await h.ok(supA.token, 'GET', `/v1/quote-versions/${d.versionId}`)).version });
  await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/commands/close`, { expectedVersion: await rv() });
  orderId = (await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/award`, { quoteVersionId: d.versionId, expectedVersion: await rv() })).orderId;
  await h.ok(supA.token, 'POST', `/v1/orders/${orderId}/commands/confirm`, { expectedVersion: (await h.ok(supA.token, 'GET', `/v1/orders/${orderId}`)).version });

  // One delivery: 60 loaded, 58 counted at the gate, all 58 accepted: the shortage of 2 is raised by the inspection.
  deliveryId = (await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'morning', lines: [{ lineKey, quantity: '60' }] })).id;
  await h.ok(supA.token, 'POST', `/v1/deliveries/${deliveryId}/dispatch`, { expectedVersion: await delVersion(), consignmentRef: 'WB-77', lines: [{ lineKey, quantity: '60' }] });
  await h.ok(supA.token, 'POST', `/v1/deliveries/${deliveryId}/arrive`, { expectedVersion: await delVersion() });
  await h.ok(owner.token, 'POST', `/v1/deliveries/${deliveryId}/receive`, { expectedVersion: await delVersion(), receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), lines: [{ lineKey, quantity: '58' }] });
  await h.ok(owner.token, 'POST', `/v1/deliveries/${deliveryId}/inspect`, { expectedVersion: await delVersion(), lines: [{ lineKey, accepted: '58', rejected: '0' }] });
  shortageId = (await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).deliveries[0].discrepancies[0].id;

  // A project document that passed the upload checks, to attach as evidence.
  const docId = uuidv7(); revisionId = uuidv7();
  await sys(`insert into documents (id, project_id, doc_type, discipline, title, created_by) values ($1, $2, 'other', 'general', 'Gate count sheet', $3)`, [docId, projectId, owner.id]);
  await sys(`insert into document_revisions (id, document_id, project_id, revision_label, storage_key, original_name, state, sha256, uploaded_by) values ($1, $2, $3, 'A', 'test/gate.pdf', 'gate-count.pdf', 'available', $4, $5)`, [revisionId, docId, projectId, 'a'.repeat(64), owner.id]);
  await sys(`update documents set current_revision_id = $2 where id = $1`, [docId, revisionId]);
});
afterAll(async () => { await h?.close(); });

describe('a contested discrepancy becomes a case', () => {
  it('opens a case when the supplier contests, visible to both parties only', async () => {
    const r = await h.ok(supA.token, 'POST', `/v1/discrepancies/${shortageId}/respond`, { action: 'contest', note: 'Driver counted 60 at loading' });
    expect(r).toMatchObject({ state: 'contested', caseReference: expect.stringMatching(/^CASE-\d{3}$/) });
    caseId = r.caseId;
    const list = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/cases`);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      id: caseId, type: 'non_delivery', severity: 'S3', state: 'open', source: 'discrepancy', raisedSide: 'provider', side: 'client',
      discrepancy: { kind: 'shortage', quantity: '2', supplierResponse: 'Driver counted 60 at loading' }, canMessage: true, canAppeal: false, canAddEvidence: true,
    });
    expect(list.items[0].messages[0].body).toMatch(/opened by the supplier/);
    expect((await h.call(outsider.token, 'GET', `/v1/cases/${caseId}`)).status).toBe(404);
    expect((await h.call(supB.token, 'GET', `/v1/cases/${caseId}`)).status).toBe(404);
    expect((await h.call(owner.token, 'GET', '/v1/moderation/cases')).status).toBe(403);
    // The same discrepancy never opens a second case.
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/cases`, { type: 'non_delivery', summary: 'Two bags missing at the gate', discrepancyId: shortageId })).body.error.code).toBe('CASE_EXISTS');
  });

  it('puts the case in the staff queue with a business-hours response target', async () => {
    const q = await h.ok(mod1.token, 'GET', '/v1/moderation/cases');
    const c = q.items.find((x: Json) => x.id === caseId);
    expect(c).toMatchObject({ severity: 'S3', state: 'open', provider: 'Alpha Cement Depot', responseOverdue: false });
    expect(new Date(c.responseDueAt).getTime()).toBeGreaterThan(Date.now());
    const s = await staffCase(mod1);
    expect(s.commands.map((x: Json) => x.command)).toEqual(['triage']);
    expect(s.audit.map((a: Json) => a.action)).toEqual(['case.opened']);
  });

  it('lets the client attach project documents as evidence, and only the client', async () => {
    expect((await h.call(supA.token, 'POST', `/v1/cases/${caseId}/evidence`, { revisionId })).status).toBe(403);
    await h.ok(owner.token, 'POST', `/v1/cases/${caseId}/evidence`, { revisionId, note: 'Gate count signed by the driver' });
    expect((await h.call(owner.token, 'POST', `/v1/cases/${caseId}/evidence`, { revisionId })).status).toBe(409);
    const p = await h.ok(supA.token, 'GET', `/v1/cases/${caseId}`);
    expect(p.evidence).toEqual([expect.objectContaining({ fileName: 'gate-count.pdf', side: 'client', sha256: 'a'.repeat(64) })]);
  });

  it('triages, asks the supplier, and returns to investigation when the supplier replies', async () => {
    expect((await command(mod1, 'decide', { outcome: 'client_upheld', note: 'x' })).status).toBe(409);
    expect((await command(mod1, 'triage', {})).status).toBe(400);
    expect((await command(mod1, 'triage', { severity: 'S2', note: 'Repeated shortages reported in this area' })).status).toBe(200);
    let s = await staffCase(mod1);
    expect(s).toMatchObject({ state: 'triaged', severity: 'S2', people: { triagedBy: 'Ada Moderator' } });
    expect(s.firstResponseAt).toBeTruthy();
    await command(mod1, 'request_info', { side: 'provider', note: 'Send the loading tally for WB-77.' });
    const sup = await h.ok(supA.token, 'GET', `/v1/cases/${caseId}`);
    expect(sup).toMatchObject({ state: 'awaiting_party', awaitingSide: 'provider', awaitingYou: true });
    // A staff-only note never reaches either party (and RLS hides it even from a direct read).
    await h.ok(mod1.token, 'POST', `/v1/moderation/cases/${caseId}/messages`, { body: 'Driver has two prior shortage reports', internal: true });
    expect((await h.ok(supA.token, 'GET', `/v1/cases/${caseId}`)).messages.some((m: Json) => /prior shortage/.test(m.body))).toBe(false);
    expect((await staffCase(mod1)).messages.some((m: Json) => m.internal && /prior shortage/.test(m.body))).toBe(true);
    const r = await h.ok(supA.token, 'POST', `/v1/cases/${caseId}/messages`, { body: 'Tally attached to the waybill shows 60 loaded.' });
    expect(r.state).toBe('under_investigation');
    s = await staffCase(mod1);
    expect(s.messages.map((m: Json) => m.role)).toContain('provider');
  });

  it('proposes and decides, then refuses changes to the recorded decision', async () => {
    expect((await command(mod1, 'propose', {})).status).toBe(400);
    await command(mod1, 'propose', { resolution: 'The gate count is signed; the supplier credits or resupplies the 2 bags.' });
    expect((await h.ok(owner.token, 'GET', `/v1/cases/${caseId}`)).proposal.text).toMatch(/credits or resupplies/);
    expect((await command(mod1, 'decide', { outcome: 'client_upheld' })).status).toBe(400);
    await command(mod1, 'decide', { outcome: 'client_upheld', note: 'The signed gate count outweighs the loading tally.' });
    const c = await h.ok(owner.token, 'GET', `/v1/cases/${caseId}`);
    expect(c).toMatchObject({ state: 'resolved', decision: { outcome: 'client_upheld' }, standingOutcome: 'client_upheld', canAppeal: true, appealOpenUntil: expect.any(String) });
    await expect(sys(`update cases set outcome = 'provider_upheld' where id = $1`, [caseId])).rejects.toThrow(/cannot be changed/);
  });

  it('takes one appeal, decided by a different staff member', async () => {
    const cv = async () => (await h.ok(supA.token, 'GET', `/v1/cases/${caseId}`)).version;
    expect((await h.call(supA.token, 'POST', `/v1/cases/${caseId}/appeal`, { statement: 'short', expectedVersion: await cv() })).status).toBe(400);
    await h.ok(supA.token, 'POST', `/v1/cases/${caseId}/appeal`, { statement: 'Our weighbridge ticket shows the full load left the yard.', expectedVersion: await cv() });
    expect((await h.call(owner.token, 'POST', `/v1/cases/${caseId}/appeal`, { statement: 'We also want to appeal this one.', expectedVersion: await cv() })).body.error.message).toMatch(/once/);
    // The decider is kept off the appeal.
    const mine = await staffCase(mod1);
    expect(mine.commands).toEqual([{ command: 'take_appeal', blockedReason: expect.stringMatching(/different staff member/) }]);
    expect((await command(mod1, 'take_appeal')).status).toBe(403);
    expect((await command(mod2, 'take_appeal')).status).toBe(200);
    expect((await command(ops, 'decide_appeal', { appealOutcome: 'upheld', note: 'x x x' })).status).toBe(403);
    expect((await command(mod2, 'decide_appeal', { appealOutcome: 'overturned', note: 'Both counts are signed.' })).status).toBe(400);
    expect((await command(mod2, 'decide_appeal', { appealOutcome: 'overturned', outcome: 'client_upheld', note: 'Both counts are signed.' })).body.error.code).toBe('SAME_OUTCOME');
    await command(mod2, 'decide_appeal', { appealOutcome: 'overturned', outcome: 'shared', note: 'Both counts are signed; the loss happened in transit. Share the cost.' });
    const c = await h.ok(owner.token, 'GET', `/v1/cases/${caseId}`);
    expect(c).toMatchObject({ state: 'final', decision: { outcome: 'client_upheld' }, appeal: { side: 'provider', outcome: 'overturned', newOutcome: 'shared' }, standingOutcome: 'shared', canMessage: false });
    await expect(sys(`update cases set appeal_reviewer = $2 where id = $1`, [caseId, mod1.id])).rejects.toThrow();
    const s = await staffCase(mod2);
    expect(s.audit.map((a: Json) => a.action)).toEqual(['case.opened', 'case.evidence_added', 'case.triage', 'case.request_info', 'case.note', 'case.message', 'case.propose', 'case.decide', 'case.appealed', 'case.take_appeal', 'case.decide_appeal']);
    // Every step is in the hash chain.
    expect(new Set(s.audit.map((a: Json) => a.hash)).size).toBe(s.audit.length);
    expect(s.commands).toEqual([]);
  });
});

describe('a disputed order becomes a case; safety cases skip triage', () => {
  it('opens an S1 safety case from a dispute, pages the safety owner and shows the emergency message', async () => {
    const r = await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/commands/dispute`, { expectedVersion: await orderVersion(), reason: 'Bags labelled 42.5 crumble; slab poured with them is cracking', caseType: 'unsafe_work' });
    expect(r).toMatchObject({ state: 'disputed', caseReference: expect.stringMatching(/^CASE-/), emergencyMessage: expect.stringMatching(/call 112/) });
    safetyCaseId = r.caseId;
    const c = await h.ok(supA.token, 'GET', `/v1/cases/${safetyCaseId}`);
    expect(c).toMatchObject({ severity: 'S1', state: 'triaged', safety: true, source: 'order', emergencyMessage: expect.stringMatching(/BuildWise cannot assess structural safety/) });
    expect(new Date(c.responseDueAt).getTime() - new Date(c.openedAt).getTime()).toBe(60 * 60_000);
    const paged = await sys(`select title from notifications where user_id = $1 and kind = 'case'`, [ops.id]);
    expect(paged.map((n) => n.title).join(' ')).toMatch(/Safety case CASE-\d+: respond within the hour/);
    const q = await h.ok(mod1.token, 'GET', '/v1/moderation/cases');
    expect(q.items[0].id).toBe(safetyCaseId);
    // While it is open, a second dispute case for the order is not created.
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/cases`, { type: 'non_delivery', summary: 'Another issue with this order' })).body.error.code).toBe('CASE_EXISTS');
  });

  it('reminds staff once when the response target passes, and finalises unappealed decisions', async () => {
    await sys(`update cases set response_due_at = now() - interval '1 minute' where id = $1`, [safetyCaseId]);
    const first = await h.services.db.tx({ kind: 'system' }, (sql) => runCaseTimers(sql, h.services));
    expect(first.staffReminders).toBe(1);
    expect((await h.services.db.tx({ kind: 'system' }, (sql) => runCaseTimers(sql, h.services))).staffReminders).toBe(0);
    await command(mod1, 'propose', { resolution: 'Stop using the batch; building control to inspect the slab.' }, safetyCaseId);
    await command(mod1, 'decide', { outcome: 'referred', note: 'Referred to building control; the supplier withdraws the batch.' }, safetyCaseId);
    const short = { ...h.services, pack: { ...h.services.pack, cases: { ...h.services.pack.cases, appealWindowDays: 0 } } };
    const r = await h.services.db.tx({ kind: 'system' }, (sql) => runCaseTimers(sql, short));
    expect(r.finalized).toBe(1);
    expect((await h.ok(owner.token, 'GET', `/v1/cases/${safetyCaseId}`)).state).toBe('final');
    await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/commands/resume`, { expectedVersion: await orderVersion(), reason: 'Case decided' });
  });
});

describe('two-sided transaction reviews', () => {
  it('opens reviews only once the order is complete', async () => {
    const before = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/reviews`);
    expect(before).toMatchObject({ canReview: false, reason: expect.stringMatching(/delivered in full/) });
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/reviews`, { ratings: { quality: 4, timeliness: 4, communication: 4, accuracy: 4 }, body: 'Good supplier overall.' })).status).toBe(409);
    // Settle the shortage: the order is then delivered in full.
    await h.ok(owner.token, 'POST', `/v1/discrepancies/${shortageId}/resolve`, { resolution: 'credit', note: 'Shared cost per case decision' });
    expect((await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`)).state).toBe('fulfilled');
  });

  it('keeps each side’s review hidden from the other until both have reviewed', async () => {
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/reviews`, { ratings: { quality: 4, timeliness: 9, communication: 4, accuracy: 4 }, body: 'Good supplier overall.' })).status).toBe(422);
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/reviews`, { ratings: { quality: 4 }, body: 'Good supplier overall.' })).body.error.code).toBe('RATINGS_INVALID');
    const c = await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/reviews`, { ratings: { quality: 4, timeliness: 5, communication: 4, accuracy: 3 }, body: 'Fast delivery, two bags short but sorted out through the case.' });
    expect(c.status).toBe('published');
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/reviews`, { ratings: { quality: 4, timeliness: 5, communication: 4, accuracy: 3 }, body: 'Second review attempt.' })).status).toBe(409);
    const sup = await h.ok(supA.token, 'GET', `/v1/orders/${orderId}/reviews`);
    expect(sup).toMatchObject({ side: 'provider', canReview: true, theirs: null, theirsWaiting: true, dimensions: [{ key: 'communication' }, { key: 'timeliness' }, { key: 'accuracy' }] });
    // The supplier's review mentions a phone number: held for a moderator (same content checks as listings).
    const p = await h.ok(supA.token, 'POST', `/v1/orders/${orderId}/reviews`, { ratings: { communication: 5, timeliness: 4, accuracy: 5 }, body: 'Clear order, easy site access. Call our site lead on 0803 123 4567 next time.' });
    expect(p).toMatchObject({ status: 'pending', message: expect.stringMatching(/moderator checks it/) });
    const own = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/reviews`);
    expect(own.theirs).toBeNull();
    const supNow = await h.ok(supA.token, 'GET', `/v1/orders/${orderId}/reviews`);
    expect(supNow).toMatchObject({ canReview: false, mine: { status: 'pending', held: true }, theirs: { overall: 4, canReply: true } });
  });

  it('lets a moderator publish a held review, and the reviewed side reply once', async () => {
    const held = await h.ok(mod1.token, 'GET', '/v1/moderation/transaction-reviews');
    const item = held.items.find((x: Json) => x.side === 'provider');
    expect(item.holdReasons).toContain('phone number');
    await h.ok(mod1.token, 'POST', `/v1/moderation/transaction-reviews/${item.id}/decide`, { publish: true, note: 'Site lead number is a business line' });
    const own = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/reviews`);
    expect(own.theirs).toMatchObject({ side: 'provider', overall: 4.7, canReply: true });
    const sup = await h.ok(supA.token, 'GET', `/v1/orders/${orderId}/reviews`);
    await h.ok(supA.token, 'POST', `/v1/transaction-reviews/${sup.theirs.id}/reply`, { body: 'Thank you. The credit note is on its way.' });
    expect((await h.call(supA.token, 'POST', `/v1/transaction-reviews/${sup.theirs.id}/reply`, { body: 'Again' })).status).toBe(409);
    expect((await h.call(owner.token, 'POST', `/v1/transaction-reviews/${sup.theirs.id}/reply`, { body: 'Replying to my own' })).status).toBe(403);
  });

  it('removes a reported review only for a stated policy reason, and audits it', async () => {
    const sup = await h.ok(supA.token, 'GET', `/v1/orders/${orderId}/reviews`);
    const target = sup.theirs.id;
    await h.ok(supA.token, 'POST', '/v1/reports', { targetType: 'transaction_review', targetId: target, reason: 'other', details: 'Please remove, it hurts our rating' });
    const reports = await h.ok(mod1.token, 'GET', '/v1/moderation/reports');
    const rep = reports.items.find((x: Json) => x.targetId === target);
    expect(rep.target.title).toMatch(/Fast delivery/);
    expect(reports.reviewRemovalReasons.map((r: Json) => r.value)).toContain('personal_data');
    expect((await h.call(mod1.token, 'POST', `/v1/moderation/reports/${rep.id}/decide`, { outcome: 'actioned', note: 'Provider asked', removeReview: true })).body.error.code).toBe('REASON_REQUIRED');
    // A provider asking is not a reason: dismissed, and the review stays.
    await h.ok(mod1.token, 'POST', `/v1/moderation/reports/${rep.id}/decide`, { outcome: 'dismissed', note: 'No policy breach; reviews are not removed on request' });
    expect((await h.ok(owner.token, 'GET', `/v1/orders/${orderId}/reviews`)).mine.status).toBe('published');
    await expect(sys(`update transaction_reviews set body = 'edited' where id = $1`, [target])).rejects.toThrow(/cannot be edited/);
  });
});

describe('provider performance and liquidity', () => {
  it('shows the delivery and quote record on the public provider profile, small samples as counts', async () => {
    const p = await h.ok(null, 'GET', `/v1/providers/${supHandle}`);
    const m = Object.fromEntries(p.performance.metrics.map((x: Json) => [x.key, x]));
    expect(m.onTimeDelivery).toMatchObject({ sample: 1, enough: false, value: null, display: '1 of 1 delivery on the booked day: too few to score' });
    expect(m.discrepancyRate).toMatchObject({ sample: 1, display: '1 of 1 inspected delivery: too few to score' });
    expect(m.quoteResponseTime).toMatchObject({ sample: 1, enough: false });
    expect(m.invoiceMatch.display).toBe('No records yet');
    expect(p.transactionReviews).toMatchObject({ count: 1, enough: false, overall: null, label: 'Reviews from completed BuildWise orders' });
    expect(p.transactionReviews.items[0]).toMatchObject({ overall: 4, area: 'Hilltop', reply: { body: expect.stringMatching(/credit note/) } });
    // A signed-in stranger sees the same published review (RLS allows published rows only).
    expect((await h.ok(outsider.token, 'GET', `/v1/providers/${supHandle}`)).transactionReviews.items).toHaveLength(1);
  });

  it('feeds the record into RFQ matching as a neutral factor until there are enough deliveries', async () => {
    const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: 'Blockwork' });
    await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: 'description,qty,unit,section,specification\nCement 42.5 in 50 kg bags,20,bag,superstructure,' });
    await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/share`);
    const r = (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Blockwork cement', categorySlug: 'cement', estimateVersionId: e.versionId, deadline: inDays(5), sourcingMode: 'open' })).id;
    const m = await h.ok(owner.token, 'POST', `/v1/rfqs/${r}/match`);
    const a = m.eligible.find((x: Json) => x.orgId === supA.orgId);
    expect(m.rankingVersion).toBe('match-2026.2');
    expect(a.factors.find((f: Json) => f.key === 'deliveryRecord')).toMatchObject({ value: 0.5, detail: '1 delivery so far: too few to score (neutral)' });
  });

  it('reports comparable responses within 72 hours for staff', async () => {
    expect((await h.call(owner.token, 'GET', '/v1/moderation/liquidity')).status).toBe(403);
    const l = await h.ok(mod1.token, 'GET', '/v1/moderation/liquidity');
    expect(l.config).toMatchObject({ minComparableResponses: 3, windowHours: 72, targetPct: 80 });
    const first = l.recent.find((x: Json) => x.id === rfqId);
    expect(first).toMatchObject({ comparable: 1, responses: 1, met: null, category: 'Cement', area: 'Hilltop' });
    expect(l.overall).toMatchObject({ decided: 0, sharePct: null });
    expect(l.gate).toMatchObject({ met: false, text: expect.stringMatching(/Not enough decided requests/) });
    expect(l.byCategory[0]).toMatchObject({ key: 'cement' });
    // Seen as published four days ago, the window has passed and the response came after it: missed.
    await sys(`update rfqs set published_at = now() - interval '4 days' where id = $1`, [rfqId]);
    const later = await h.ok(mod1.token, 'GET', '/v1/moderation/liquidity');
    expect(later.recent.find((x: Json) => x.id === rfqId)).toMatchObject({ comparable: 0, responses: 0, met: false });
    expect(later.overall).toMatchObject({ decided: 1, met: 0 });
  });
});
