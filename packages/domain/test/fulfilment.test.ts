import { describe, expect, it } from 'vitest';
import {
  can, closeBlockers, DEMO_MARKET, deliveryMachine, discrepancyMachine, dispatchProblems, fulfilmentCommand, fulfilmentProgress, inspectionOutcome,
  invoiceMachine, invoiceProblems, invoiceTotals, matchCommand, ORDER_ACTOR, orderLinesFromTerms, orderMachine, paymentPosition, podProblems, returnMachine,
  returnProblems, scheduleProblems, threeWayMatch,
  type DeliveryLineRecord, type DeliveryRecord, type FulfilmentConfig, type InvoiceInput, type OrderLine, type ReturnRecord,
} from '../src/index';

/** R3 slice 2: delivery, discrepancy, return and invoice machines, fulfilment progress and the three-way match. */

const cfg = DEMO_MARKET.fulfilment;
const D = 1_000_000n;
const q = (n: number) => BigInt(Math.round(n * 1e6));
const CEMENT = 'cement-key';
const REBAR = 'rebar-key';

const terms = {
  lines: [
    { rfqLineKey: CEMENT, description: 'Cement 42.5', status: 'priced', unit: 'bag', quantity: '60', unitPriceMinor: '920000', taxRatePct: 7.5 },
    { rfqLineKey: REBAR, description: 'Y12 bars', status: 'priced', unit: 'tonne', quantity: '2', unitPriceMinor: '115000000', taxRatePct: 7.5 },
    { rfqLineKey: 'sand-key', description: 'Sharp sand', status: 'excluded', unit: 'tonne', quantity: '0', unitPriceMinor: '0', taxRatePct: 0 },
  ],
  terms: { deliveryMinor: '1500000', deliveryTaxRatePct: 7.5 },
};
const lines: OrderLine[] = orderLinesFromTerms(terms);
const order = { lines, deliveryMinor: 1_500_000n, deliveryTaxRatePct: 7.5 };

type LineIn = Partial<DeliveryLineRecord> & { lineKey: string; scheduled: bigint };
const delivery = (id: string, state: DeliveryRecord['state'], l: LineIn[], discrepancies: DeliveryRecord['discrepancies'] = []): DeliveryRecord => ({
  id, state, receivedAt: '2026-11-20T10:00:00Z',
  lines: l.map((x) => ({ dispatched: null, received: null, accepted: null, rejected: null, ...x })), discrepancies,
});

describe('state machines (§9.4)', () => {
  it('runs a delivery from booking to proof of delivery and inspection; receipt is not acceptance', () => {
    let s = deliveryMachine.next('scheduled', 'dispatch');
    s = deliveryMachine.next(s, 'arrive');
    s = deliveryMachine.next(s, 'receive');
    expect(s).toBe('received');
    // From received only an inspection moves on: there is no path to "accepted" without one.
    expect(deliveryMachine.commandsFrom('received').sort()).toEqual(['accept', 'raise_discrepancy']);
    expect(deliveryMachine.next('received', 'raise_discrepancy')).toBe('discrepancy_raised');
    expect(deliveryMachine.next('discrepancy_raised', 'resolve')).toBe('resolved');
    expect(deliveryMachine.can('arrived', 'cancel')).toBe(false);
    expect(deliveryMachine.can('scheduled', 'receive')).toBe(false);
    expect(deliveryMachine.commandsFrom('inspected_ok')).toEqual([]);
  });

  it('settles discrepancies, returns and invoices only along their paths', () => {
    expect(discrepancyMachine.next('open', 'acknowledge')).toBe('acknowledged');
    expect(discrepancyMachine.next('acknowledged', 'contest')).toBe('contested');
    expect(discrepancyMachine.can('resolved', 'contest')).toBe(false);
    expect(returnMachine.next('requested', 'approve')).toBe('approved');
    expect(returnMachine.can('requested', 'collect')).toBe(false);
    expect(returnMachine.next('approved', 'collect')).toBe('collected');
    expect(invoiceMachine.next('submitted', 'flag')).toBe('awaiting_approval');
    expect(invoiceMachine.can('matched', 'approve')).toBe(false);
    expect(invoiceMachine.next('awaiting_approval', 'approve')).toBe('approved');
    expect(invoiceMachine.next('awaiting_approval', 'match')).toBe('matched');
  });

  it('makes fulfilment a system command, closing a client one, and lets a dispute resume', () => {
    expect(ORDER_ACTOR.fulfil).toBe('system');
    expect(ORDER_ACTOR.fulfil_part).toBe('system');
    expect(ORDER_ACTOR.close).toBe('client');
    expect(orderMachine.next('disputed', 'resume')).toBe('confirmed');
    expect(orderMachine.can('partially_fulfilled', 'close')).toBe(false);
    expect(can('manager', 'order.manage')).toBe(true);
    expect(can('manager', 'invoice.approve')).toBe(false);
    expect(can('owner', 'invoice.approve')).toBe(true);
    expect(can('collaborator', 'order.manage')).toBe(false);
  });
});

describe('fulfilment progress', () => {
  it('reads order lines from the awarded snapshot and leaves excluded lines out of what is owed', () => {
    expect(lines.map((l) => [l.lineKey, l.priced, l.quantity])).toEqual([[CEMENT, true, 60n * D], [REBAR, true, 2n * D], ['sand-key', false, 0n]]);
    const p = fulfilmentProgress(lines, [], []);
    expect(p.lines.find((l) => l.lineKey === CEMENT)!.outstanding).toBe(60n * D);
    expect(p.lines.find((l) => l.lineKey === 'sand-key')!.complete).toBe(true);
    expect(p.complete).toBe(false);
  });

  it('counts received goods as awaiting inspection, not accepted (§22.6)', () => {
    const d = delivery('d1', 'received', [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(60) }]);
    const p = fulfilmentProgress(lines, [d], []);
    const c = p.lines.find((l) => l.lineKey === CEMENT)!;
    expect(c).toMatchObject({ received: q(60), awaitingInspection: q(60), accepted: 0n, netAccepted: 0n, outstanding: 0n, complete: false });
    expect(p.anyReceived).toBe(true);
    expect(fulfilmentCommand('confirmed', p)).toBe('fulfil_part');
    expect(fulfilmentCommand('partially_fulfilled', p)).toBeNull();
  });

  it('follows inspection, discrepancy resolutions and returns to fulfilment', () => {
    const disc = { id: 'x1', deliveryId: 'd1', lineKey: CEMENT, kind: 'damaged' as const, quantity: q(5), state: 'open' as const, resolution: null };
    const d1 = delivery('d1', 'discrepancy_raised', [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(60), accepted: q(55), rejected: q(5) }], [disc]);
    const d2 = delivery('d2', 'inspected_ok', [{ lineKey: REBAR, scheduled: q(2), dispatched: q(2), received: q(2), accepted: q(2), rejected: 0n }]);
    let p = fulfilmentProgress(lines, [d1, d2], []);
    expect(p.lines.find((l) => l.lineKey === CEMENT)).toMatchObject({ accepted: q(55), rejected: q(5), outstanding: q(5) });
    expect(p.openDiscrepancies).toBe(1);
    expect(p.complete).toBe(false);
    // Credited: not resupplied, so the order no longer waits for it.
    const credited = { ...disc, state: 'resolved' as const, resolution: 'credit' as const };
    const d1r = { ...d1, state: 'resolved' as const, discrepancies: [credited] };
    p = fulfilmentProgress(lines, [d1r, d2], []);
    expect(p.lines.find((l) => l.lineKey === CEMENT)).toMatchObject({ waived: q(5), outstanding: 0n, complete: true });
    expect(p.complete).toBe(true);
    expect(fulfilmentCommand('partially_fulfilled', p)).toBe('fulfil');
    // Sending the damaged bags back (linked to the discrepancy) does not change what was kept.
    const ret: ReturnRecord = { id: 'r1', state: 'collected', discrepancyId: 'x1', lines: [{ lineKey: CEMENT, quantity: q(5) }] };
    expect(fulfilmentProgress(lines, [d1r, d2], [ret]).lines.find((l) => l.lineKey === CEMENT)!.netAccepted).toBe(q(55));
    // Kept as is: the rejected bags count as accepted.
    const asIs = { ...d1r, discrepancies: [{ ...credited, resolution: 'accept_as_is' as const }] };
    expect(fulfilmentProgress(lines, [asIs, d2], []).lines.find((l) => l.lineKey === CEMENT)).toMatchObject({ accepted: q(60), rejected: 0n, waived: 0n });
    // Replaced: still outstanding until a new delivery comes.
    const replace = { ...d1r, discrepancies: [{ ...credited, resolution: 'replace' as const }] };
    expect(fulfilmentProgress(lines, [replace, d2], []).lines.find((l) => l.lineKey === CEMENT)!.outstanding).toBe(q(5));
    // A return of kept surplus reduces what was kept and is not owed again.
    const surplus: ReturnRecord = { id: 'r2', state: 'collected', discrepancyId: null, lines: [{ lineKey: REBAR, quantity: q(0.5) }] };
    expect(fulfilmentProgress(lines, [d1r, d2], [surplus]).lines.find((l) => l.lineKey === REBAR)).toMatchObject({ returned: q(0.5), netAccepted: q(1.5), waived: q(0.5), complete: true });
  });

  it('counts a cancelled delivery as nothing and a booked one as in transit', () => {
    const p = fulfilmentProgress(lines, [delivery('d1', 'cancelled', [{ lineKey: CEMENT, scheduled: q(60) }]), delivery('d2', 'scheduled', [{ lineKey: CEMENT, scheduled: q(20) }])], []);
    expect(p.lines.find((l) => l.lineKey === CEMENT)).toMatchObject({ inTransit: q(20), outstanding: q(40) });
    expect(p.openDeliveries).toBe(1);
  });
});

describe('booking, dispatch, proof of delivery and inspection', () => {
  const p = fulfilmentProgress(lines, [], []);
  it('refuses bookings beyond what is outstanding, off-slot or in the past', () => {
    expect(scheduleProblems(p, { date: '2026-12-01', slot: 'morning', lines: [{ lineKey: CEMENT, quantity: q(60) }] }, '2026-11-26', cfg)).toEqual([]);
    expect(scheduleProblems(p, { date: '2026-12-01', slot: 'morning', lines: [{ lineKey: CEMENT, quantity: q(61) }] }, '2026-11-26', cfg)[0]).toMatch(/only 60 bag left/);
    expect(scheduleProblems(p, { date: '2026-11-25', slot: 'midnight', lines: [{ lineKey: 'sand-key', quantity: q(1) }] }, '2026-11-26', cfg)).toEqual(['Choose a delivery slot.', 'Choose a delivery date from today onwards.', 'A line is not on this order.']);
    const loose: FulfilmentConfig = { ...cfg, overDeliveryTolerancePct: 5 };
    expect(scheduleProblems(p, { date: '2026-12-01', slot: 'morning', lines: [{ lineKey: CEMENT, quantity: q(63) }] }, '2026-11-26', loose)).toEqual([]);
  });

  it('lets a consignment load less than booked, never more', () => {
    const dl = [{ lineKey: CEMENT, scheduled: q(60), dispatched: null, received: null, accepted: null, rejected: null }];
    expect(dispatchProblems(dl, [{ lineKey: CEMENT, quantity: q(58) }], cfg)).toEqual([]);
    expect(dispatchProblems(dl, [{ lineKey: CEMENT, quantity: q(61) }], cfg, { [CEMENT]: 'Cement 42.5' })[0]).toMatch(/Cement 42.5: more than was booked/);
    expect(dispatchProblems(dl, [{ lineKey: CEMENT, quantity: 0n }], cfg)).toContain('Load at least one line, or cancel the delivery.');
  });

  it('needs a receiver, a time not in the future and a quantity for every line', () => {
    const dl = [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: null, accepted: null, rejected: null }];
    const now = new Date('2026-11-26T12:00:00Z');
    expect(podProblems(dl, { receivedBy: 'Musa', receivedAt: '2026-11-26T11:00:00Z', lines: [{ lineKey: CEMENT, quantity: q(58) }] }, now)).toEqual([]);
    expect(podProblems(dl, { receivedBy: 'M', receivedAt: '2026-11-27T11:00:00Z', lines: [] }, now)).toHaveLength(3);
  });

  it('splits what arrived into accepted and rejected and raises a shortage on its own', () => {
    const dl = [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(58), accepted: null, rejected: null }];
    const ok = inspectionOutcome(dl, [{ lineKey: CEMENT, accepted: q(53), rejected: q(5), kind: 'damaged', note: 'Torn bags' }]);
    expect(ok.problems).toEqual([]);
    expect(ok.command).toBe('raise_discrepancy');
    expect(ok.discrepancies.map((x) => [x.kind, x.quantity])).toEqual([['damaged', q(5)], ['shortage', q(2)]]);
    expect(inspectionOutcome(dl, [{ lineKey: CEMENT, accepted: q(50), rejected: q(5), kind: 'damaged' }]).problems[0]).toMatch(/add up to the 58 received/);
    expect(inspectionOutcome(dl, [{ lineKey: CEMENT, accepted: q(53), rejected: q(5) }]).problems[0]).toMatch(/say why/);
    const full = [{ ...dl[0]!, received: q(60) }];
    expect(inspectionOutcome(full, [{ lineKey: CEMENT, accepted: q(60), rejected: 0n }])).toMatchObject({ command: 'accept', discrepancies: [] });
  });

  it('limits returns to rejected goods for a discrepancy, or kept goods not already going back, within the window', () => {
    const disc = { id: 'x1', deliveryId: 'd1', lineKey: CEMENT, kind: 'damaged' as const, quantity: q(5), state: 'resolved' as const, resolution: 'credit' as const };
    const d1 = delivery('d1', 'resolved', [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(60), accepted: q(55), rejected: q(5) }], [disc]);
    const pr = fulfilmentProgress(lines, [d1], []);
    const now = new Date('2026-11-26T12:00:00Z');
    expect(returnProblems(pr, { lines: [{ lineKey: CEMENT, quantity: q(5) }], discrepancy: disc, receivedAt: '2026-11-20T10:00:00Z' }, now, cfg)).toEqual([]);
    expect(returnProblems(pr, { lines: [{ lineKey: CEMENT, quantity: q(6) }], discrepancy: disc, receivedAt: '2026-11-20T10:00:00Z' }, now, cfg)[0]).toMatch(/only 5 bag was rejected/);
    expect(returnProblems(pr, { lines: [{ lineKey: CEMENT, quantity: q(56) }], discrepancy: null, receivedAt: '2026-11-20T10:00:00Z' }, now, cfg)[0]).toMatch(/only 55 bag kept/);
    expect(returnProblems(pr, { lines: [{ lineKey: CEMENT, quantity: q(1) }], discrepancy: null, receivedAt: '2026-09-01T10:00:00Z' }, now, cfg)[0]).toMatch(/30 days/);
    const short = { ...disc, kind: 'shortage' as const };
    expect(returnProblems(pr, { lines: [{ lineKey: CEMENT, quantity: q(1) }], discrepancy: short, receivedAt: null }, now, cfg)).toContain('A shortage has nothing to send back.');
  });
});

describe('three-way match: supplier invoice ↔ order ↔ proof of delivery (§10.4 step 9)', () => {
  const disc = { id: 'x1', deliveryId: 'd1', lineKey: CEMENT, kind: 'damaged' as const, quantity: q(5), state: 'resolved' as const, resolution: 'credit' as const };
  const d1 = delivery('d1', 'resolved', [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(60), accepted: q(55), rejected: q(5) }], [disc]);
  const p = fulfilmentProgress(lines, [d1], []);
  const invoice = (over: Partial<InvoiceInput> = {}, cement = { quantity: q(55), unitPriceMinor: 920_000n }): InvoiceInput => {
    const base: InvoiceInput = { lines: [{ lineKey: CEMENT, description: 'Cement 42.5', unit: 'bag', quantity: cement.quantity, unitPriceMinor: cement.unitPriceMinor, taxRatePct: 7.5 }], deliveryMinor: 1_500_000n, deliveryTaxRatePct: 7.5, statedTotalMinor: 0n, ...over };
    return { ...base, statedTotalMinor: over.statedTotalMinor ?? invoiceTotals(base).grossMinor };
  };

  it('matches an invoice for what was received, inspected and kept at the order price', () => {
    const inv = invoice();
    expect(invoiceTotals(inv).grossMinor).toBe(55n * 920_000n + 1_500_000n + (55n * 920_000n * 75n) / 1000n + 112_500n);
    const m = threeWayMatch(order, p, inv, [], cfg);
    expect(m).toMatchObject({ status: 'matched', variances: [] });
    expect(m.lines[0]).toMatchObject({ ordered: q(60), received: q(60), accepted: q(55), invoiced: q(55) });
    expect(m.expectedMinor).toBe(invoiceTotals(inv).grossMinor);
    expect(matchCommand('submitted', m)).toBe('match');
  });

  it('routes quantity, price, tax, delivery, unknown-line and total variances to approval', () => {
    const over = threeWayMatch(order, p, invoice({}, { quantity: q(60), unitPriceMinor: 920_000n }), [], cfg);
    expect(over.status).toBe('variance');
    expect(over.variances[0]).toMatchObject({ kind: 'quantity', impactMinor: 5n * 920_000n });
    expect(over.variances[0]!.message).toMatch(/billed 60 bag in total; 55 bag received, inspected and kept/);
    expect(matchCommand('submitted', over)).toBe('flag');
    const price = threeWayMatch(order, p, invoice({}, { quantity: q(55), unitPriceMinor: 950_000n }), [], cfg);
    expect(price.variances.map((v) => [v.kind, v.impactMinor])).toEqual([['price', 55n * 30_000n]]);
    const loose = threeWayMatch(order, p, invoice({}, { quantity: q(55), unitPriceMinor: 924_000n }), [], { ...cfg, match: { ...cfg.match, priceTolerancePct: 0.5 } });
    expect(loose.status).toBe('matched');
    const extra = invoice({ deliveryMinor: 2_000_000n });
    extra.lines.push({ lineKey: null, description: 'Offloading', unit: 'item', quantity: q(1), unitPriceMinor: 500_000n, taxRatePct: 0 });
    extra.lines[0] = { ...extra.lines[0]!, taxRatePct: 10 };
    extra.statedTotalMinor = 1n;
    const m = threeWayMatch(order, p, extra, [], cfg);
    expect(m.variances.map((v) => v.kind).sort()).toEqual(['delivery', 'not_on_order', 'tax', 'total']);
  });

  it('adds each invoice to the ones before it, so billing in parts never bills twice', () => {
    const first = threeWayMatch(order, p, invoice({}, { quantity: q(30), unitPriceMinor: 920_000n }), [], cfg);
    expect(first.status).toBe('matched');
    const prior = [{ lines: [{ lineKey: CEMENT, quantity: q(30) }], deliveryMinor: 1_500_000n }];
    expect(threeWayMatch(order, p, invoice({ deliveryMinor: 0n }, { quantity: q(25), unitPriceMinor: 920_000n }), prior, cfg).status).toBe('matched');
    const twice = threeWayMatch(order, p, invoice({}, { quantity: q(30), unitPriceMinor: 920_000n }), prior, cfg);
    expect(twice.variances.map((v) => v.kind).sort()).toEqual(['delivery', 'quantity']);
  });

  it('does not bill goods awaiting inspection and says so', () => {
    const waiting = fulfilmentProgress(lines, [delivery('d1', 'received', [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(60) }])], []);
    const m = threeWayMatch(order, waiting, invoice(), [], cfg);
    expect(m.variances[0]!.kind).toBe('quantity');
    expect(m.notes[0]).toMatch(/not inspected yet/);
  });

  it('validates the invoice itself', () => {
    expect(invoiceProblems({ ...invoice(), number: '', issuedOn: '2026-12-31' }, '2026-11-26')).toEqual(['Enter the invoice number.', 'The invoice date cannot be in the future.']);
  });
});

describe('record-only payment and closing', () => {
  it('reports what is payable, waiting and recorded as paid, without implying protection', () => {
    expect(paymentPosition([{ state: 'matched', grossMinor: 100n }, { state: 'awaiting_approval', grossMinor: 40n }, { state: 'rejected', grossMinor: 999n }], 60n))
      .toEqual({ payableMinor: 100n, pendingApprovalMinor: 40n, recordedPaidMinor: 60n, balanceMinor: 40n });
  });

  it('blocks closing while anything is open and warns when nothing has been invoiced', () => {
    const p = fulfilmentProgress(lines, [delivery('d1', 'received', [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(60) }])], []);
    const c = closeBlockers('partially_fulfilled', p, [{ state: 'awaiting_approval' }]);
    expect(c.blockers.length).toBe(3);
    const done = fulfilmentProgress(lines, [delivery('d1', 'inspected_ok', [{ lineKey: CEMENT, scheduled: q(60), dispatched: q(60), received: q(60), accepted: q(60), rejected: 0n }, { lineKey: REBAR, scheduled: q(2), dispatched: q(2), received: q(2), accepted: q(2), rejected: 0n }])], []);
    expect(closeBlockers('fulfilled', done, [])).toEqual({ blockers: [], warnings: ['The supplier has not sent a matched invoice yet.'] });
    expect(closeBlockers('fulfilled', done, [{ state: 'matched' }])).toEqual({ blockers: [], warnings: [] });
  });
});
