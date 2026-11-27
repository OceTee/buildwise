import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invoiceTotals, parseDec } from '@bw/domain';
import { harness, type Json } from './helpers.js';

/**
 * R3 second slice: an awarded order is confirmed, booked, dispatched, received with proof of delivery, inspected
 * with discrepancies, partly returned, re-delivered, invoiced (three-way match, variance approval), paid on a
 * record-only basis and closed.
 */
let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let owner: User, manager: User, viewer: User, outsider: User, moderator: User, supA: User, supB: User;
let projectId: string, orderId: string, cementKey: string, rebarKey: string;
let del1: string, del2: string, damagedId: string, shortageId: string, returnId: string, inv1: string, inv2: string;

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const day = (d: number) => inDays(d).slice(0, 10);
const sys = (q: string, p: unknown[] = []) => h.services.db.tx({ kind: 'system' }, (sql) => sql.query(q, p));
const view = (u: User) => h.ok(u.token, 'GET', `/v1/orders/${orderId}/fulfilment`);
const deliveryOf = async (u: User, id: string) => (await view(u)).deliveries.find((d: Json) => d.id === id);
const progressOf = async (key: string) => (await view(owner)).progress.lines.find((l: Json) => l.lineKey === key);
const orderState = async () => (await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`)).state;
const ver = async (u: User, id: string) => (await deliveryOf(u, id)).version;
const total = (lines: { quantity: string; price: string }[], delivery = '15000') => {
  const t = invoiceTotals({
    lines: lines.map((l) => ({ lineKey: null, description: '', unit: '', quantity: parseDec(l.quantity)!, unitPriceMinor: BigInt(l.price) * 100n, taxRatePct: 7.5 })),
    deliveryMinor: BigInt(delivery) * 100n, deliveryTaxRatePct: 7.5,
  });
  const g = t.grossMinor;
  return `${g / 100n}.${String(g % 100n).padStart(2, '0')}`;
};

beforeAll(async () => {
  h = await harness();
  moderator = await h.signIn('Mo Moderator', { staff: 'moderator' });
  owner = await h.signIn('Ola Owner');
  manager = await h.signIn('Mia Manager');
  viewer = await h.signIn('Vic Viewer');
  outsider = await h.signIn('Otto Outsider');
  supA = await h.veteranBusiness(await h.signIn('Ada Supplier'), 'Alpha Cement Depot');
  supB = await h.veteranBusiness(await h.signIn('Ben Supplier'), 'Bravo Building Supplies');
  for (const s of [supA, supB]) await h.ok(moderator.token, 'POST', `/v1/moderation/sellers/${s.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup (test)' });
  await h.liveListing(supA, moderator);
  await h.liveListing(supB, moderator, { price: '9400' });

  projectId = (await h.ok(owner.token, 'POST', '/v1/projects', { name: 'Hilltop bungalow', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'construction' })).id;
  for (const [u, role] of [[manager, 'manager'], [viewer, 'viewer']] as const) {
    await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/invitations`, { phone: u.phone, role });
    const inv = (await h.ok(u.token, 'GET', '/v1/me/project-invitations')).items[0];
    await h.ok(u.token, 'POST', `/v1/project-invitations/${inv.id}/respond`, { accept: true });
  }
  const e = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/estimates`, { maturity: 'client_specified', title: 'Slab list' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/import`, { csv: 'description,qty,unit,section,specification\nCement 42.5 in 50 kg bags,60,bag,substructure,Grade 42.5\nY12 reinforcement bars,2,tonne,frame,' });
  await h.ok(owner.token, 'POST', `/v1/estimate-versions/${e.versionId}/share`);
  const rfqId = (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Slab materials', categorySlug: 'cement', estimateVersionId: e.versionId, deadline: inDays(5), sourcingMode: 'open' })).id;
  const rv = async () => (await h.ok(owner.token, 'GET', `/v1/rfqs/${rfqId}`)).version;
  await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/commands/publish`, { expectedVersion: await rv() });
  const lines = (await h.ok(supA.token, 'GET', `/v1/rfqs/${rfqId}`)).lines;
  [cementKey, rebarKey] = lines.map((l: Json) => l.lineKey);
  const d = await h.ok(supA.token, 'POST', `/v1/rfqs/${rfqId}/quotes`);
  const v = await h.ok(supA.token, 'GET', `/v1/quote-versions/${d.versionId}`);
  await h.ok(supA.token, 'PUT', `/v1/quote-versions/${d.versionId}`, {
    expectedVersion: v.version, validUntil: day(20), deliveryCharge: '15000', deliveryTaxRatePct: 7.5, paymentTerms: 'On delivery',
    lines: [{ rfqLineKey: cementKey, status: 'priced', unit: 'bag', quantity: '60', unitPrice: '9200', taxRatePct: 7.5 }, { rfqLineKey: rebarKey, status: 'priced', unit: 'tonne', quantity: '2', unitPrice: '1150000', taxRatePct: 7.5 }],
  });
  await h.ok(supA.token, 'POST', `/v1/quote-versions/${d.versionId}/submit`, { expectedVersion: (await h.ok(supA.token, 'GET', `/v1/quote-versions/${d.versionId}`)).version });
  await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/commands/close`, { expectedVersion: await rv() });
  orderId = (await h.ok(owner.token, 'POST', `/v1/rfqs/${rfqId}/award`, { quoteVersionId: d.versionId, expectedVersion: await rv() })).orderId;
});
afterAll(async () => { await h?.close(); });

describe('who sees and books deliveries', () => {
  it('waits for the supplier to confirm before anything can be booked', async () => {
    const r = await h.call(owner.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'morning', lines: [{ lineKey: cementKey, quantity: '60' }] });
    expect(r.status).toBe(409);
    expect(r.body.error.message).toMatch(/not confirmed/);
    const o = await h.ok(supA.token, 'GET', `/v1/orders/${orderId}`);
    await h.ok(supA.token, 'POST', `/v1/orders/${orderId}/commands/confirm`, { expectedVersion: o.version });
  });

  it('shows the fulfilment to both parties only, and lets only the client book', async () => {
    expect((await h.call(outsider.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).status).toBe(404);
    expect((await h.call(supB.token, 'GET', `/v1/orders/${orderId}/fulfilment`)).status).toBe(404);
    const pv = await view(supA);
    expect(pv).toMatchObject({ side: 'provider', canSchedule: false, canInvoice: true, paymentNotice: expect.stringMatching(/does not process, hold or protect/) });
    expect((await view(viewer))).toMatchObject({ side: 'client', canManage: false, canSchedule: false });
    expect((await h.call(supA.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'morning', lines: [{ lineKey: cementKey, quantity: '60' }] })).status).toBe(403);
    expect((await h.call(viewer.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'morning', lines: [{ lineKey: cementKey, quantity: '60' }] })).status).toBe(403);
    const over = await h.call(manager.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'morning', lines: [{ lineKey: cementKey, quantity: '61' }] });
    expect(over.status).toBe(422);
    expect(over.body.error.message).toMatch(/only 60 bag left to book/);
    expect((await h.call(manager.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(-1), slot: 'night', lines: [{ lineKey: cementKey, quantity: '1' }] })).status).toBe(422);
    // A booking can be cancelled with a reason; it then counts for nothing.
    const extra = await h.ok(manager.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'evening', lines: [{ lineKey: cementKey, quantity: '10' }] });
    expect((await h.call(supA.token, 'POST', `/v1/deliveries/${extra.id}/cancel`, { expectedVersion: 1 })).status).toBe(400);
    await h.ok(supA.token, 'POST', `/v1/deliveries/${extra.id}/cancel`, { expectedVersion: 1, reason: 'Booked by mistake, one run is enough' });
    const r = await h.ok(manager.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(1), slot: 'morning', instructions: 'Gate 2, offload by the store', lines: [{ lineKey: cementKey, quantity: '60' }, { lineKey: rebarKey, quantity: '2' }] });
    del1 = r.id;
    expect(r.reference).toBe('DEL-002');
    const o = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`);
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/commands/cancel`, { expectedVersion: o.version, reason: 'Changed my mind' })).body.error.code).toBe('HAS_DELIVERIES');
    expect(await progressOf(cementKey)).toMatchObject({ ordered: '60', inTransit: '60', outstanding: '0' });
  });
});

describe('dispatch, arrival and proof of delivery (§9.4, §22.6)', () => {
  it('lets the supplier move and dispatch a consignment, never load more than booked', async () => {
    await h.ok(supA.token, 'POST', `/v1/deliveries/${del1}/reschedule`, { expectedVersion: await ver(supA, del1), date: day(2), slot: 'afternoon', reason: 'Truck in service until Thursday' });
    expect(await deliveryOf(owner, del1)).toMatchObject({ scheduledDate: day(2), slot: { code: 'afternoon' }, rescheduleCount: 1, commands: expect.arrayContaining(['reschedule', 'cancel']) });
    expect((await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/arrive`, { expectedVersion: await ver(owner, del1) })).status).toBe(409);
    expect((await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/dispatch`, { expectedVersion: await ver(owner, del1), consignmentRef: 'X', lines: [{ lineKey: cementKey, quantity: '60' }] })).status).toBe(403);
    const tooMuch = await h.call(supA.token, 'POST', `/v1/deliveries/${del1}/dispatch`, { expectedVersion: await ver(supA, del1), consignmentRef: 'WB-1001', lines: [{ lineKey: cementKey, quantity: '61' }, { lineKey: rebarKey, quantity: '2' }] });
    expect(tooMuch.status).toBe(422);
    await h.ok(supA.token, 'POST', `/v1/deliveries/${del1}/dispatch`, { expectedVersion: await ver(supA, del1), consignmentRef: 'WB-1001', vehicle: 'LSD 123 XY', driverName: 'Musa', lines: [{ lineKey: cementKey, quantity: '60' }, { lineKey: rebarKey, quantity: '2' }] });
    expect(await deliveryOf(owner, del1)).toMatchObject({ state: 'dispatched', consignment: { reference: 'WB-1001', vehicle: 'LSD 123 XY' } });
    expect((await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/receive`, { expectedVersion: await ver(owner, del1), receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), lines: [] })).status).toBe(400);
    expect((await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/receive`, { expectedVersion: await ver(owner, del1), receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), lines: [{ lineKey: cementKey, quantity: '58' }] })).body.error.message).toMatch(/Mark the delivery as arrived/);
    await h.ok(supA.token, 'POST', `/v1/deliveries/${del1}/arrive`, { expectedVersion: await ver(supA, del1) });
  });

  it('records proof of delivery as a receipt: fixed once recorded, never an acceptance', async () => {
    const stale = await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/receive`, { expectedVersion: 1, receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), lines: [{ lineKey: cementKey, quantity: '58' }, { lineKey: rebarKey, quantity: '2' }] });
    expect(stale.body.error.code).toBe('STALE');
    const partial = await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/receive`, { expectedVersion: await ver(owner, del1), receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), lines: [{ lineKey: cementKey, quantity: '58' }] });
    expect(partial.status).toBe(422);
    const r = await h.ok(owner.token, 'POST', `/v1/deliveries/${del1}/receive`, { expectedVersion: await ver(owner, del1), receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), notes: 'Two bags short on the count', lines: [{ lineKey: cementKey, quantity: '58' }, { lineKey: rebarKey, quantity: '2' }] });
    expect(r).toMatchObject({ state: 'received', orderState: 'partially_fulfilled', podHash: expect.stringMatching(/^[0-9a-f]{64}$/), notice: expect.stringMatching(/not that it is acceptable/) });
    expect(await progressOf(cementKey)).toMatchObject({ received: '58', awaitingInspection: '58', accepted: '0', netAccepted: '0' });
    await expect(sys(`update deliveries set received_by_name = 'Someone else' where id = $1`, [del1])).rejects.toThrow(/cannot be changed/);
    await expect(sys(`update delivery_lines set received_qty = 60 where delivery_id = $1`, [del1])).rejects.toThrow(/cannot be changed/);
    expect((await deliveryOf(supA, del1)).pod).toMatchObject({ receivedBy: 'Site foreman', hash: r.podHash });
  });

  it('matches an early invoice against nothing accepted yet: a quantity variance, not a payable invoice', async () => {
    const lines = [{ quantity: '60', price: '9200' }, { quantity: '2', price: '1150000' }];
    const r = await h.ok(supA.token, 'POST', `/v1/orders/${orderId}/invoices`, {
      invoiceNumber: 'INV-1001', issuedOn: day(0), deliveryCharge: '15000', deliveryTaxRatePct: 7.5, statedTotal: total(lines),
      lines: [{ lineKey: cementKey, quantity: '60', unitPrice: '9200', taxRatePct: 7.5 }, { lineKey: rebarKey, quantity: '2', unitPrice: '1150000', taxRatePct: 7.5 }],
    });
    inv1 = r.id;
    expect(r).toMatchObject({ state: 'awaiting_approval', match: { status: 'variance' } });
    expect(r.match.variances.map((v: Json) => v.kind)).toEqual(['quantity', 'quantity']);
    expect((await h.call(supA.token, 'POST', `/v1/orders/${orderId}/invoices`, { invoiceNumber: 'INV-1001', issuedOn: day(0), statedTotal: '1', lines: [{ lineKey: cementKey, quantity: '1', unitPrice: '1' }] })).status).toBe(409);
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/invoices`, { invoiceNumber: 'X', issuedOn: day(0), statedTotal: '1', lines: [{ lineKey: cementKey, quantity: '1', unitPrice: '1' }] })).status).toBe(403);
    const i = (await view(owner)).invoices.find((x: Json) => x.id === inv1);
    expect(i.match.notes.join(' ')).toMatch(/not inspected yet/);
    await expect(sys(`update supplier_invoices set stated_total_minor = 1 where id = $1`, [inv1])).rejects.toThrow(/cannot be changed/);
  });
});

describe('inspection, discrepancies and returns', () => {
  it('accepts, rejects with a reason and raises the shortage on its own', async () => {
    const bad = await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/inspect`, { expectedVersion: await ver(owner, del1), lines: [{ lineKey: cementKey, accepted: '53', rejected: '4', kind: 'damaged' }, { lineKey: rebarKey, accepted: '2' }] });
    expect(bad.body.error.message).toMatch(/add up to the 58 received/);
    const r = await h.ok(manager.token, 'POST', `/v1/deliveries/${del1}/inspect`, { expectedVersion: await ver(owner, del1), notes: 'Bags checked one by one', lines: [{ lineKey: cementKey, accepted: '53', rejected: '5', kind: 'damaged', note: 'Torn bags, set hard' }, { lineKey: rebarKey, accepted: '2', rejected: '0' }] });
    expect(r).toMatchObject({ state: 'discrepancy_raised', discrepancies: 2, orderState: 'partially_fulfilled' });
    const d = await deliveryOf(supA, del1);
    expect(d.discrepancies.map((x: Json) => [x.kind, x.quantity, x.state])).toEqual([['damaged', '5', 'open'], ['shortage', '2', 'open']]);
    [damagedId, shortageId] = d.discrepancies.map((x: Json) => x.id);
    expect(d.discrepancies[0].commands).toEqual(['acknowledge', 'contest']);
    expect(await progressOf(cementKey)).toMatchObject({ accepted: '53', rejected: '5', netAccepted: '53', outstanding: '7' });
    // The receipt stays exactly as recorded after the dispute is raised (§22.6).
    expect(d.pod.receivedBy).toBe('Site foreman');
    expect((await h.call(owner.token, 'POST', `/v1/deliveries/${del1}/inspect`, { expectedVersion: d.version, lines: [] })).status).toBe(400);
  });

  it('lets the supplier answer and the client resolve, and resolves the delivery when all are settled', async () => {
    expect((await h.call(owner.token, 'POST', `/v1/discrepancies/${damagedId}/respond`, { action: 'acknowledge', note: 'Fine by us' })).status).toBe(403);
    await h.ok(supA.token, 'POST', `/v1/discrepancies/${damagedId}/respond`, { action: 'acknowledge', note: 'Sorry, wet store. We will credit them.' });
    await h.ok(supA.token, 'POST', `/v1/discrepancies/${shortageId}/respond`, { action: 'contest', note: 'Driver counted 60 at loading' });
    expect((await h.call(supA.token, 'POST', `/v1/discrepancies/${damagedId}/resolve`, { resolution: 'credit' })).status).toBe(403);
    const a = await h.ok(owner.token, 'POST', `/v1/discrepancies/${damagedId}/resolve`, { resolution: 'credit', note: 'Credit the five bags' });
    expect(a.deliveryState).toBe('discrepancy_raised');
    const b = await h.ok(owner.token, 'POST', `/v1/discrepancies/${shortageId}/resolve`, { resolution: 'replace', note: 'Bring two more with the next run' });
    expect(b.deliveryState).toBe('resolved');
    expect(await progressOf(cementKey)).toMatchObject({ waived: '5', netAccepted: '53', outstanding: '2' });
  });

  it('returns part of a delivery: the damaged bags, approved and collected by the supplier', async () => {
    const tooMany = await h.call(owner.token, 'POST', `/v1/orders/${orderId}/returns`, { reason: 'Damaged bags', discrepancyId: damagedId, lines: [{ lineKey: cementKey, quantity: '6' }] });
    expect(tooMany.body.error.message).toMatch(/only 5 bag was rejected/);
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/returns`, { reason: 'Nothing to return', discrepancyId: shortageId, lines: [{ lineKey: cementKey, quantity: '1' }] })).body.error.message).toMatch(/shortage/);
    const r = await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/returns`, { reason: 'Damaged bags going back', discrepancyId: damagedId, lines: [{ lineKey: cementKey, quantity: '5' }] });
    returnId = r.id;
    expect(r.reference).toBe('RET-001');
    expect((await h.call(owner.token, 'POST', `/v1/orders/${orderId}/returns`, { reason: 'Again', discrepancyId: damagedId, lines: [{ lineKey: cementKey, quantity: '5' }] })).status).toBe(409);
    const rv = async () => (await view(supA)).returns.find((x: Json) => x.id === returnId).version;
    expect((await h.call(owner.token, 'POST', `/v1/returns/${returnId}/approve`, { expectedVersion: await rv() })).status).toBe(403);
    expect((await h.call(supA.token, 'POST', `/v1/returns/${returnId}/collect`, { expectedVersion: await rv() })).status).toBe(409);
    await h.ok(supA.token, 'POST', `/v1/returns/${returnId}/approve`, { expectedVersion: await rv(), note: 'We will collect on Friday' });
    const c = await h.ok(supA.token, 'POST', `/v1/returns/${returnId}/collect`, { expectedVersion: await rv() });
    expect(c.state).toBe('collected');
    // Rejected goods going back do not change what was kept.
    expect(await progressOf(cementKey)).toMatchObject({ netAccepted: '53', returnPending: '0', outstanding: '2' });
  });
});

describe('replacement delivery and fulfilment', () => {
  it('delivers the replacement and marks the order fulfilled from inspection, not from receipt', async () => {
    const r = await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/deliveries`, { date: day(3), slot: 'morning', lines: [{ lineKey: cementKey, quantity: '2' }] });
    del2 = r.id;
    await h.ok(supA.token, 'POST', `/v1/deliveries/${del2}/dispatch`, { expectedVersion: await ver(supA, del2), consignmentRef: 'WB-1002', lines: [{ lineKey: cementKey, quantity: '2' }] });
    await h.ok(owner.token, 'POST', `/v1/deliveries/${del2}/arrive`, { expectedVersion: await ver(owner, del2) });
    const rec = await h.ok(owner.token, 'POST', `/v1/deliveries/${del2}/receive`, { expectedVersion: await ver(owner, del2), receivedBy: 'Site foreman', receivedAt: new Date().toISOString(), lines: [{ lineKey: cementKey, quantity: '2' }] });
    expect(rec.orderState).toBe('partially_fulfilled');
    const ins = await h.ok(owner.token, 'POST', `/v1/deliveries/${del2}/inspect`, { expectedVersion: await ver(owner, del2), lines: [{ lineKey: cementKey, accepted: '2', rejected: '0' }] });
    expect(ins).toMatchObject({ state: 'inspected_ok', discrepancies: 0, orderState: 'fulfilled' });
    expect((await view(owner)).progress.complete).toBe(true);
  });
});

describe('three-way match and variance approval (§10.4 step 9)', () => {
  it('re-matches the early invoice against what was kept; the supplier withdraws it', async () => {
    const i = (await view(owner)).invoices.find((x: Json) => x.id === inv1);
    expect(i.state).toBe('awaiting_approval');
    expect(i.match.variances.map((v: Json) => v.kind)).toEqual(['quantity']);
    expect(i.match.lines[0]).toMatchObject({ received: '60', accepted: '55', invoiced: '60' });
    expect(i.commands).toEqual(['approve', 'reject']);
    expect((await view(manager)).invoices.find((x: Json) => x.id === inv1).commands).toEqual(['reject']);
    await h.ok(supA.token, 'POST', `/v1/invoices/${inv1}/withdraw`, { expectedVersion: i.version, reason: 'Re-issuing for the quantity kept' });
  });

  it('routes a price variance to the owner and closes only when nothing is open', async () => {
    const lines = [{ quantity: '55', price: '9200' }, { quantity: '2', price: '1160000' }];
    const r = await h.ok(supA.token, 'POST', `/v1/orders/${orderId}/invoices`, {
      invoiceNumber: 'INV-1002', issuedOn: day(0), deliveryCharge: '15000', deliveryTaxRatePct: 7.5, statedTotal: total(lines),
      lines: [{ lineKey: cementKey, quantity: '55', unitPrice: '9200', taxRatePct: 7.5 }, { lineKey: rebarKey, quantity: '2', unitPrice: '1160000', taxRatePct: 7.5 }],
    });
    inv2 = r.id;
    expect(r).toMatchObject({ state: 'awaiting_approval', match: { status: 'variance', variances: [{ kind: 'price' }] } });
    const o = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`);
    expect(o.commands).toContain('close');
    const blocked = await h.call(manager.token, 'POST', `/v1/orders/${orderId}/commands/close`, { expectedVersion: o.version });
    expect(blocked.body.error.code).toBe('CLOSE_BLOCKED');
    expect(blocked.body.error.message).toMatch(/variance waiting for approval/);
    const iv = (await view(owner)).invoices.find((x: Json) => x.id === inv2).version;
    expect((await h.call(manager.token, 'POST', `/v1/invoices/${inv2}/approve`, { expectedVersion: iv, reason: 'Steel price moved' })).status).toBe(403);
    expect((await h.ok(owner.token, 'POST', `/v1/invoices/${inv2}/approve`, { expectedVersion: iv, reason: 'Steel price rose; agreed by phone' })).state).toBe('approved');
    const audit = await sys(`select reason from audit_events where action = 'invoice.approve' and target_id = $1`, [inv2]);
    expect(audit.rows[0]).toMatchObject({ reason: 'Steel price rose; agreed by phone' });
  });

  it('records payments against the order (record only), which the supplier confirms', async () => {
    const r = await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/payments`, { amount: '100000', paidOn: day(0), method: 'bank_transfer', reference: 'TRF-889', invoiceId: inv2 });
    expect(r.notice).toMatch(/does not process, hold or protect/);
    expect((await h.call(supA.token, 'POST', `/v1/orders/${orderId}/payments`, { amount: '1', paidOn: day(0), method: 'cash' })).status).toBe(403);
    const pv = await view(supA);
    expect(pv.payments.items[0]).toMatchObject({ amount: { amountMinor: '10000000' }, canAcknowledge: true });
    expect(pv.payments.position.recordedPaid.amountMinor).toBe('10000000');
    await h.ok(supA.token, 'POST', `/v1/payment-records/${r.id}/supplier-acknowledge`);
    expect((await h.call(supA.token, 'POST', `/v1/payment-records/${r.id}/supplier-acknowledge`)).status).toBe(409);
    expect((await h.call(supB.token, 'POST', `/v1/payment-records/${r.id}/supplier-acknowledge`)).status).toBe(404);
    expect((await view(owner)).payments.items[0].supplierAcknowledgedAt).toBeTruthy();
    expect((await h.ok(owner.token, 'GET', `/v1/projects/${projectId}/payments`)).items.map((x: Json) => x.id)).toContain(r.id);
  });

  it('resumes a disputed order back to fulfilled and then closes it', async () => {
    let o = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`);
    await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/commands/dispute`, { expectedVersion: o.version, reason: 'Checking the steel price change' });
    o = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`);
    expect(o.commands).toEqual(['resume']);
    const resumed = await h.ok(owner.token, 'POST', `/v1/orders/${orderId}/commands/resume`, { expectedVersion: o.version, reason: 'Agreed with the supplier' });
    expect(resumed.state).toBe('fulfilled');
    const v = await view(owner);
    expect(v.close).toMatchObject({ blockers: [], warnings: [], canClose: true });
    o = await h.ok(owner.token, 'GET', `/v1/orders/${orderId}`);
    await h.ok(manager.token, 'POST', `/v1/orders/${orderId}/commands/close`, { expectedVersion: o.version });
    expect(await orderState()).toBe('closed');
    const after = await view(owner);
    expect(after.deliveries.every((d: Json) => d.commands.length === 0)).toBe(true);
    expect(after.payments.canRecord).toBe(false);
  });
});
