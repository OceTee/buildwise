import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  BILLED_INVOICE_STATES, canonicalJson, canScheduleDelivery, closeBlockers, DELIVERY_ACTOR, deliveryMachine, DISCREPANCY_ACTOR, DISCREPANCY_KINDS,
  DISCREPANCY_LABEL, discrepancyMachine, dispatchProblems, formatDec, formatMoney, fulfilmentCommand, fulfilmentProgress, INVOICE_ACTOR, invoiceMachine,
  invoiceProblems, inspectionOutcome, matchCommand, orderDeliveryTerms, orderLinesFromTerms, orderMachine, parseDec, parseMajor, paymentPosition, podProblems,
  RECEIPT_NOTICE, RECORD_ONLY_PAYMENT_NOTICE, RESOLUTION_LABEL, RESOLUTIONS, RETURN_ACTOR, returnMachine, returnProblems, scheduleProblems, slotProblems,
  threeWayMatch, unitLabel, uuidv7, VARIANCE_LABEL,
  type DeliveryCommand, type DeliveryRecord, type DiscrepancyKind, type FulfilmentActor, type FulfilmentProgress, type InvoiceInput, type InvoiceState,
  type OrderState, type PriorInvoice, type ReturnCommand, type ReturnRecord, type ThreeWayMatch,
} from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Actor, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, sha256, unprocessable } from '../platform/platform.js';
import { orderSide, orgUsers, type OrderSide } from './parties.js';

/**
 * Fulfilment, R3 second slice (spec §9.4, §10.4 steps 7–9, §14.1, §22.6): deliveries booked into slots, consignments
 * dispatched by the supplier, proof of delivery, inspection and discrepancies, returns, supplier invoices with a
 * three-way match and approval of variances, and record-only payments against the order. Every route goes through
 * `route()` (one transaction, RLS for the signed-in user); the rules live in `@bw/domain` `fulfilment.ts`.
 */

type Row = Record<string, any>;
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const dec = (v: unknown) => parseDec(String(v ?? '0')) ?? 0n;
const decOrNull = (v: unknown) => (v == null ? null : dec(v));
const q3 = (v: bigint | null | undefined) => (v == null ? null : formatDec(v, 3));
const today = () => new Date().toISOString().slice(0, 10);
const qtyField = z.string().trim().regex(/^\d+(\.\d{1,6})?$/, 'Enter a quantity.');
const lineQty = z.object({ lineKey: z.uuid(), quantity: qtyField });
const version = { expectedVersion: z.number().int() };
const ref = (prefix: string, n: number) => `${prefix}-${String(n).padStart(3, '0')}`;

function moneyOf(s: Services) {
  return (minor: bigint | string | number, currency = s.pack.currency) => ({ amountMinor: String(minor), currency, display: formatMoney({ amountMinor: String(minor), currency }, s.pack.locale) });
}

// ---------------------------------------------------------------- loading
export async function loadFulfilment(sql: Sql, o: Row) {
  const terms = json<Row>(o.terms);
  const lines = orderLinesFromTerms(terms);
  const dRows = await many<Row>(sql, `select * from deliveries where order_id = $1 order by number`, [o.id]);
  const dlRows = await many<Row>(sql, `select * from delivery_lines where order_id = $1 order by position`, [o.id]);
  const ddRows = await many<Row>(sql, `select * from delivery_discrepancies where order_id = $1 order by created_at, id`, [o.id]);
  const rRows = await many<Row>(sql, `select * from return_requests where order_id = $1 order by number`, [o.id]);
  const rlRows = await many<Row>(sql, `select * from return_lines where order_id = $1`, [o.id]);
  const iRows = await many<Row>(sql, `select * from supplier_invoices where order_id = $1 order by created_at, id`, [o.id]);
  const ilRows = await many<Row>(sql, `select * from supplier_invoice_lines where order_id = $1 order by position`, [o.id]);
  const deliveries: DeliveryRecord[] = dRows.map((d) => ({
    id: d.id, state: d.state, receivedAt: iso(d.received_at),
    lines: dlRows.filter((l) => l.delivery_id === d.id).map((l) => ({
      lineKey: l.line_key, scheduled: dec(l.scheduled_qty), dispatched: decOrNull(l.dispatched_qty), received: decOrNull(l.received_qty), accepted: decOrNull(l.accepted_qty), rejected: decOrNull(l.rejected_qty),
    })),
    discrepancies: ddRows.filter((x) => x.delivery_id === d.id).map((x) => ({ id: x.id, deliveryId: d.id, lineKey: x.line_key, kind: x.kind, quantity: dec(x.quantity), state: x.state, resolution: x.resolution })),
  }));
  const returns: ReturnRecord[] = rRows.map((r) => ({ id: r.id, state: r.state, discrepancyId: r.discrepancy_id, lines: rlRows.filter((l) => l.return_id === r.id).map((l) => ({ lineKey: l.line_key, quantity: dec(l.quantity) })) }));
  const progress = fulfilmentProgress(lines, deliveries, returns);
  return { terms, lines, deliveryTerms: orderDeliveryTerms(terms), dRows, dlRows, ddRows, rRows, rlRows, iRows, ilRows, deliveries, returns, progress };
}
type Loaded = Awaited<ReturnType<typeof loadFulfilment>>;

function invoiceInput(inv: Row, ilRows: Row[]): InvoiceInput {
  return {
    lines: ilRows.filter((l) => l.invoice_id === inv.id).map((l) => ({ lineKey: l.line_key, description: l.description, unit: l.unit, quantity: dec(l.quantity), unitPriceMinor: BigInt(l.unit_price_minor), taxRatePct: Number(l.tax_rate_pct) })),
    deliveryMinor: BigInt(inv.delivery_minor), deliveryTaxRatePct: Number(inv.delivery_tax_rate_pct), statedTotalMinor: BigInt(inv.stated_total_minor),
  };
}
/** Invoices billed before this one (submission order), which its quantities and delivery charge add to. */
function priorInvoices(f: Loaded, inv: Row | null): PriorInvoice[] {
  const before = f.iRows.filter((x) => BILLED_INVOICE_STATES.includes(x.state) && (!inv || (x.id !== inv.id && (iso(x.created_at)! < iso(inv.created_at)! || (iso(x.created_at) === iso(inv.created_at) && x.id < inv.id)))));
  return before.map((x) => { const i = invoiceInput(x, f.ilRows); return { lines: i.lines.map((l) => ({ lineKey: l.lineKey, quantity: l.quantity })), deliveryMinor: i.deliveryMinor }; });
}

/** The stored form of a match: quantities as decimals, money as minor-unit strings. */
function matchJson(m: ThreeWayMatch) {
  return {
    status: m.status, notes: m.notes, expectedMinor: String(m.expectedMinor), statedTotalMinor: String(m.statedTotalMinor),
    totals: { linesMinor: String(m.totals.linesMinor), deliveryMinor: String(m.totals.deliveryMinor), taxMinor: String(m.totals.taxMinor), grossMinor: String(m.totals.grossMinor) },
    lines: m.lines.map((l) => ({
      lineKey: l.lineKey, description: l.description, unit: l.unit, ordered: q3(l.ordered), received: q3(l.received), accepted: q3(l.accepted), awaitingInspection: q3(l.awaitingInspection),
      previouslyInvoiced: q3(l.previouslyInvoiced), invoiced: q3(l.invoiced), orderUnitPriceMinor: l.orderUnitPriceMinor == null ? null : String(l.orderUnitPriceMinor),
      invoiceUnitPriceMinor: String(l.invoiceUnitPriceMinor), amountMinor: String(l.amountMinor), variances: l.variances,
    })),
    variances: m.variances.map((v) => ({ ...v, impactMinor: String(v.impactMinor), label: VARIANCE_LABEL[v.kind] })),
  };
}

function matchOf(s: Services, o: Row, f: Loaded, inv: Row) {
  return threeWayMatch({ lines: f.lines, ...f.deliveryTerms }, f.progress, invoiceInput(inv, f.ilRows), priorInvoices(f, inv), s.pack.fulfilment);
}

/**
 * After anything that changes what was received, kept or billed: re-run the three-way match on open invoices and
 * move the order to partially fulfilled / fulfilled when its deliveries say so (system commands).
 */
export async function syncOrder(sql: Sql, s: Services, orderId: string): Promise<{ state: OrderState }> {
  const o = (await one<Row>(sql, `select * from orders where id = $1`, [orderId]))!;
  const f = await loadFulfilment(sql, o);
  const clients = [o.awarded_by];
  for (const inv of f.iRows) {
    if (!['submitted', 'matched', 'awaiting_approval'].includes(inv.state)) continue;
    const m = matchOf(s, o, f, inv);
    const stored = matchJson(m);
    const cmd = matchCommand(inv.state, m);
    if (!cmd && canonicalJson(stored) === canonicalJson(json(inv.match))) continue;
    const to = cmd ? invoiceMachine.next(inv.state, cmd) : inv.state;
    await sql.query(`update supplier_invoices set match = $2::jsonb, match_status = $3, matched_at = now(), state = $4, version = version + 1, updated_at = now() where id = $1`, [inv.id, JSON.stringify(stored), m.status, to]);
    inv.state = to;
    if (cmd) {
      await publish(sql, 'SupplierInvoiceMatched', { orderId: o.id, invoiceId: inv.id, status: m.status });
      if (cmd === 'flag') await notify(sql, clients, { kind: 'order', title: 'An invoice needs approval', body: `Invoice ${inv.invoice_number}: ${m.variances[0]?.message ?? 'variance'}`, link: `/projects/${o.project_id}/orders/${o.id}` });
    }
  }
  const cmd = fulfilmentCommand(o.state, f.progress);
  if (!cmd) return { state: o.state };
  const to = orderMachine.next(o.state, cmd);
  await sql.query(`update orders set state = $2, fulfilled_at = case when $3 then now() else fulfilled_at end, version = version + 1, updated_at = now() where id = $1`, [o.id, to, cmd === 'fulfil']);
  await publish(sql, cmd === 'fulfil' ? 'OrderFulfilled' : 'OrderPartiallyFulfilled', { orderId: o.id, orgId: o.provider_org_id });
  await audit(sql, { actorUserId: null, action: `order.${cmd}`, targetType: 'Order', targetId: o.id, metadata: { from: o.state, to } });
  if (cmd === 'fulfil') {
    await notify(sql, clients, { kind: 'order', title: 'Order delivered in full', body: `${ref('PO', o.number)}: everything is received and inspected. Close the order when the invoices are settled.`, link: `/projects/${o.project_id}/orders/${o.id}` });
    await notify(sql, await orgUsers(sql, o.provider_org_id), { kind: 'order', title: 'Order delivered in full', body: `${ref('PO', o.number)} is fully received and inspected by the client.`, link: `/provider/orders/${o.id}` });
  }
  return { state: to };
}

export async function orderCloseCheck(sql: Sql, _s: Services, o: Row) {
  const f = await loadFulfilment(sql, o);
  return closeBlockers(o.state, f.progress, f.iRows.map((i) => ({ state: i.state as InvoiceState })));
}

// ---------------------------------------------------------------- permissions
function allowed(who: FulfilmentActor, side: OrderSide) {
  if (who === 'system') return false;
  if (who === 'provider') return side.side === 'provider';
  if (who === 'client') return side.canManage;
  return side.side === 'provider' || side.canManage;
}

async function deliveryCtx(sql: Sql, user: Actor, id: string) {
  const d = await one<Row>(sql, `select * from deliveries where id = $1`, [id]);
  if (!d) throw notFound('Delivery');
  const side = await orderSide(sql, user, d.order_id).catch(() => { throw notFound('Delivery'); });
  return { d, side, o: side.o };
}

function stale(row: Row, expected: number, what: string) {
  if (row.version !== expected) throw conflict('STALE', `This ${what} changed. Reload and try again.`);
}

const links = (o: Row) => ({ client: `/projects/${o.project_id}/orders/${o.id}`, provider: `/provider/orders/${o.id}` });
async function tellProvider(sql: Sql, o: Row, title: string, body: string) {
  await notify(sql, await orgUsers(sql, o.provider_org_id), { kind: 'order', title, body, link: links(o).provider });
}
async function tellClient(sql: Sql, o: Row, title: string, body: string) {
  const r = await one<Row>(sql, `select created_by from rfqs where id = $1`, [o.rfq_id]);
  await notify(sql, [o.awarded_by, r?.created_by], { kind: 'order', title, body, link: links(o).client });
}

function quantities(lines: { lineKey: string; quantity: string }[]) {
  return lines.map((l) => ({ lineKey: l.lineKey, quantity: parseDec(l.quantity) ?? 0n }));
}
const descriptions = (f: Loaded) => Object.fromEntries(f.lines.map((l) => [l.lineKey, l.description]));

// ---------------------------------------------------------------- the fulfilment view
function fulfilmentView(s: Services, side: OrderSide, f: Loaded, payments: Row[]) {
  const o = side.o;
  const money = moneyOf(s);
  const cfg = s.pack.fulfilment;
  const lineOf = (k: string | null) => f.lines.find((l) => l.lineKey === k);
  const slot = (code: string) => cfg.deliverySlots.find((x) => x.code === code) ?? { code, label: code, start: '', end: '' };
  const isProvider = side.side === 'provider';
  const orderOpen = !['cancelled', 'closed'].includes(o.state);
  const deliveryCommands = (state: string) => (orderOpen ? deliveryMachine.commandsFrom(state as never).filter((c) => allowed(DELIVERY_ACTOR[c as DeliveryCommand], side)) : []);
  const progressLines = (p: FulfilmentProgress) => p.lines.map((l) => ({
    lineKey: l.lineKey, description: l.description, unit: l.unit, unitLabel: unitLabel(l.unit), priced: l.priced,
    ordered: q3(l.ordered), inTransit: q3(l.inTransit), received: q3(l.received), awaitingInspection: q3(l.awaitingInspection), accepted: q3(l.accepted), rejected: q3(l.rejected),
    returned: q3(l.returned), returnPending: q3(l.returnPending), waived: q3(l.waived), netAccepted: q3(l.netAccepted), outstanding: q3(l.outstanding), complete: l.complete,
  }));
  const now = Date.now();
  const deliveries = f.dRows.map((d) => {
    const lines = f.dlRows.filter((l) => l.delivery_id === d.id);
    const overdue = d.state === 'received' && d.received_at && now - new Date(String(d.received_at)).getTime() > cfg.inspectionWindowHours * 3_600_000;
    return {
      id: d.id, number: d.number, reference: ref('DEL', d.number), state: d.state, version: d.version,
      scheduledDate: String(iso(d.scheduled_date)).slice(0, 10), slot: slot(d.slot_code), instructions: d.instructions, rescheduleCount: d.reschedule_count,
      consignment: d.dispatched_at ? { reference: d.consignment_ref, vehicle: d.vehicle, driverName: d.driver_name, notes: d.dispatch_notes, dispatchedAt: iso(d.dispatched_at) } : null,
      arrivedAt: iso(d.arrived_at),
      pod: d.received_at ? { receivedBy: d.received_by_name, receivedAt: iso(d.received_at), recordedAt: iso(d.pod_recorded_at), notes: d.pod_notes, proofRevisionId: d.pod_proof_revision_id, hash: d.pod_hash } : null,
      inspection: d.inspected_at ? { at: iso(d.inspected_at), notes: d.inspection_notes } : null,
      inspectionOverdue: !!overdue, cancelReason: d.cancel_reason,
      lines: lines.map((l) => ({
        lineKey: l.line_key, description: l.description, unit: l.unit, unitLabel: unitLabel(l.unit),
        scheduled: q3(dec(l.scheduled_qty)), dispatched: q3(decOrNull(l.dispatched_qty)), received: q3(decOrNull(l.received_qty)), accepted: q3(decOrNull(l.accepted_qty)), rejected: q3(decOrNull(l.rejected_qty)),
      })),
      discrepancies: f.ddRows.filter((x) => x.delivery_id === d.id).map((x) => ({
        id: x.id, lineKey: x.line_key, description: lineOf(x.line_key)?.description ?? '', unitLabel: unitLabel(lineOf(x.line_key)?.unit ?? ''), kind: x.kind, kindLabel: DISCREPANCY_LABEL[x.kind as DiscrepancyKind],
        quantity: q3(dec(x.quantity)), note: x.note, state: x.state, supplierResponse: x.supplier_response, respondedAt: iso(x.responded_at),
        resolution: x.resolution, resolutionLabel: x.resolution ? RESOLUTION_LABEL[x.resolution as keyof typeof RESOLUTION_LABEL] : null, resolutionNote: x.resolution_note, resolvedAt: iso(x.resolved_at),
        commands: orderOpen ? discrepancyMachine.commandsFrom(x.state).filter((c) => allowed(DISCREPANCY_ACTOR[c], side)) : [],
        returnable: x.kind !== 'shortage' && !f.rRows.some((r) => r.discrepancy_id === x.id && !['rejected', 'cancelled'].includes(r.state)),
      })),
      commands: deliveryCommands(d.state),
    };
  });
  const returns = f.rRows.map((r) => ({
    id: r.id, number: r.number, reference: ref('RET', r.number), state: r.state, version: r.version, reason: r.reason, supplierNote: r.supplier_note,
    discrepancyId: r.discrepancy_id, delivery: r.delivery_id ? ref('DEL', f.dRows.find((d) => d.id === r.delivery_id)?.number ?? 0) : null,
    createdAt: iso(r.created_at), decidedAt: iso(r.decided_at), collectedAt: iso(r.collected_at),
    lines: f.rlRows.filter((l) => l.return_id === r.id).map((l) => ({ lineKey: l.line_key, description: l.description, unitLabel: unitLabel(l.unit), quantity: q3(dec(l.quantity)) })),
    commands: orderOpen ? returnMachine.commandsFrom(r.state).filter((c) => allowed(RETURN_ACTOR[c], side)) : [],
  }));
  const invoices = f.iRows.map((i) => {
    const m = json<Row>(i.match);
    return {
      id: i.id, invoiceNumber: i.invoice_number, issuedOn: String(iso(i.issued_on)).slice(0, 10), dueOn: i.due_on ? String(iso(i.due_on)).slice(0, 10) : null, state: i.state, version: i.version,
      notes: i.notes, submittedAt: iso(i.created_at), decisionReason: i.decision_reason, decidedAt: iso(i.decided_at), snapshotHash: i.snapshot_hash,
      total: money(i.stated_total_minor, i.currency),
      match: {
        ...m, matchedAt: iso(i.matched_at),
        expected: money(m.expectedMinor, i.currency), stated: money(m.statedTotalMinor, i.currency), computed: money(m.totals.grossMinor, i.currency),
        lines: m.lines.map((l: Row) => ({ ...l, unitLabel: unitLabel(l.unit), orderUnitPrice: l.orderUnitPriceMinor == null ? null : money(l.orderUnitPriceMinor, i.currency).display, invoiceUnitPrice: money(l.invoiceUnitPriceMinor, i.currency).display, amount: money(l.amountMinor, i.currency).display })),
        variances: m.variances.map((v: Row) => ({ ...v, impact: money(v.impactMinor, i.currency).display })),
      },
      commands: invoiceMachine.commandsFrom(i.state).filter((c) => (c === 'approve' ? side.canApprove : allowed(INVOICE_ACTOR[c], side))),
    };
  });
  const paid = payments.filter((p) => !p.voided_at).reduce((a, p) => a + BigInt(p.amount_minor), 0n);
  const pos = paymentPosition(f.iRows.map((i) => ({ state: i.state, grossMinor: BigInt(i.stated_total_minor) })), paid);
  const close = closeBlockers(o.state, f.progress, f.iRows.map((i) => ({ state: i.state })));
  return {
    orderId: o.id, reference: ref('PO', o.number), state: o.state, version: o.version, side: side.side, currency: o.currency,
    canManage: side.canManage, canApprove: side.canApprove, canSchedule: side.canManage && canScheduleDelivery(o.state),
    canRequestReturn: side.canManage && orderOpen && f.progress.lines.some((l) => l.netAccepted > l.returnPending),
    canInvoice: isProvider && ['confirmed', 'partially_fulfilled', 'fulfilled', 'disputed'].includes(o.state),
    slots: cfg.deliverySlots, receiptNotice: RECEIPT_NOTICE, paymentNotice: RECORD_ONLY_PAYMENT_NOTICE,
    inspectionWindowHours: cfg.inspectionWindowHours, returnWindowDays: cfg.returnWindowDays,
    progress: {
      lines: progressLines(f.progress), complete: f.progress.complete, anyReceived: f.progress.anyReceived,
      openDeliveries: f.progress.openDeliveries, awaitingInspection: f.progress.awaitingInspection, openDiscrepancies: f.progress.openDiscrepancies, openReturns: f.progress.openReturns,
    },
    orderLines: f.lines.filter((l) => l.priced).map((l) => ({ lineKey: l.lineKey, description: l.description, unit: l.unit, unitLabel: unitLabel(l.unit), quantity: q3(l.quantity), unitPriceMinor: String(l.unitPriceMinor), unitPrice: money(l.unitPriceMinor, o.currency).display, taxRatePct: l.taxRatePct })),
    deliveryCharge: { minor: String(f.deliveryTerms.deliveryMinor), display: money(f.deliveryTerms.deliveryMinor, o.currency).display, taxRatePct: f.deliveryTerms.deliveryTaxRatePct },
    deliveries, returns, invoices,
    payments: {
      notice: RECORD_ONLY_PAYMENT_NOTICE, canRecord: side.side === 'client' && side.canManage && orderOpen,
      position: { payable: money(pos.payableMinor, o.currency), pendingApproval: money(pos.pendingApprovalMinor, o.currency), recordedPaid: money(pos.recordedPaidMinor, o.currency), balance: money(pos.balanceMinor, o.currency) },
      items: payments.map((p) => ({
        id: p.id, amount: money(p.amount_minor, p.currency), paidOn: String(iso(p.paid_on)).slice(0, 10), method: p.method, reference: p.reference, invoiceId: p.supplier_invoice_id,
        voided: !!p.voided_at, supplierAcknowledgedAt: iso(p.supplier_acknowledged_at),
        canAcknowledge: isProvider && !p.voided_at && !p.supplier_acknowledged_at,
      })),
    },
    close: { ...close, canClose: side.canManage && orderMachine.can(o.state, 'close') && !close.blockers.length },
  };
}

// ---------------------------------------------------------------- routes
export function registerFulfilment(app: FastifyInstance, s: Services) {
  const cfg = s.pack.fulfilment;

  route(app, s, {
    method: 'GET', url: '/v1/orders/:id/fulfilment', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const side = await orderSide(sql, user, params.id);
      const f = await loadFulfilment(sql, side.o);
      const payments = await many<Row>(sql, `select * from payment_records where order_id = $1 order by paid_on desc, created_at desc`, [side.o.id]);
      return fulfilmentView(s, side, f, payments);
    },
  });

  // ---------------------------------------------------------------- deliveries: book, reschedule, cancel
  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/deliveries', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ date: z.iso.date(), slot: z.string().max(40), instructions: z.string().trim().max(1000).optional(), lines: z.array(lineQty).min(1).max(200) }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (!side.canManage) throw side.side === 'provider' ? forbidden('The client books deliveries.') : forbidden();
      const o = side.o;
      if (!canScheduleDelivery(o.state)) throw conflict('ORDER_NOT_ACTIVE', o.state === 'placed' ? 'The supplier has not confirmed this order yet.' : `A ${o.state.replace(/_/g, ' ')} order can't take new deliveries.`);
      const f = await loadFulfilment(sql, o);
      const lines = quantities(body.lines).filter((l) => l.quantity > 0n);
      const problems = scheduleProblems(f.progress, { date: body.date, slot: body.slot, lines }, today(), cfg);
      if (problems.length) throw unprocessable('DELIVERY_INVALID', problems[0]!, { problems });
      const id = uuidv7();
      const n = (await one<{ n: number }>(sql, `select coalesce(max(number), 0)::int + 1 as n from deliveries where order_id = $1`, [o.id]))!.n;
      await sql.query(`insert into deliveries (id, order_id, project_id, provider_org_id, number, scheduled_date, slot_code, instructions, scheduled_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, o.id, o.project_id, o.provider_org_id, n, body.date, body.slot, body.instructions ?? null, user.id]);
      let pos = 0;
      for (const l of lines) {
        const ol = f.lines.find((x) => x.lineKey === l.lineKey)!;
        await sql.query(`insert into delivery_lines (id, delivery_id, order_id, project_id, provider_org_id, line_key, position, description, unit, scheduled_qty) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [uuidv7(), id, o.id, o.project_id, o.provider_org_id, l.lineKey, ++pos, ol.description, ol.unit, formatDec(l.quantity)]);
      }
      const slot = cfg.deliverySlots.find((x) => x.code === body.slot)!;
      await tellProvider(sql, o, 'Delivery booked', `${ref('PO', o.number)} ${ref('DEL', n)}: ${body.date}, ${slot.label}.`);
      await publish(sql, 'DeliveryScheduled', { orderId: o.id, deliveryId: id, date: body.date, slot: body.slot });
      await audit(sql, { actorUserId: user.id, action: 'delivery.scheduled', targetType: 'Delivery', targetId: id, metadata: { orderId: o.id, date: body.date, slot: body.slot } });
      return { id, number: n, reference: ref('DEL', n) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/deliveries/:id/reschedule', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ ...version, date: z.iso.date(), slot: z.string().max(40), reason: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const { d, side, o } = await deliveryCtx(sql, user, params.id);
      if (!allowed(DELIVERY_ACTOR.reschedule, side)) throw forbidden();
      stale(d, body.expectedVersion, 'delivery');
      if (!deliveryMachine.can(d.state, 'reschedule')) throw conflict('INVALID_TRANSITION', 'Only a delivery that has not left can be rescheduled.');
      const problems = slotProblems(body.date, body.slot, today(), cfg);
      if (problems.length) throw unprocessable('DELIVERY_INVALID', problems[0]!, { problems });
      await sql.query(`update deliveries set scheduled_date = $2, slot_code = $3, reschedule_count = reschedule_count + 1, version = version + 1, updated_at = now() where id = $1`, [d.id, body.date, body.slot]);
      const text = `${ref('DEL', d.number)} moved to ${body.date}, ${cfg.deliverySlots.find((x) => x.code === body.slot)!.label}: ${body.reason}`;
      if (side.side === 'provider') await tellClient(sql, o, 'The supplier moved a delivery', text); else await tellProvider(sql, o, 'The client moved a delivery', text);
      await publish(sql, 'DeliveryRescheduled', { orderId: o.id, deliveryId: d.id, date: body.date, slot: body.slot, by: side.side });
      await audit(sql, { actorUserId: user.id, action: 'delivery.rescheduled', targetType: 'Delivery', targetId: d.id, reason: body.reason });
      return { state: d.state };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/deliveries/:id/cancel', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ ...version, reason: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const { d, side, o } = await deliveryCtx(sql, user, params.id);
      if (!allowed(DELIVERY_ACTOR.cancel, side)) throw forbidden();
      stale(d, body.expectedVersion, 'delivery');
      if (!deliveryMachine.can(d.state, 'cancel')) throw conflict('INVALID_TRANSITION', 'A delivery that has arrived cannot be cancelled. Record what arrived (0 if it was refused).');
      await sql.query(`update deliveries set state = 'cancelled', cancelled_at = now(), cancel_reason = $2, version = version + 1, updated_at = now() where id = $1`, [d.id, body.reason]);
      const text = `${ref('DEL', d.number)}: ${body.reason}`;
      if (side.side === 'provider') await tellClient(sql, o, 'The supplier cancelled a delivery', text); else await tellProvider(sql, o, 'The client cancelled a delivery', text);
      await publish(sql, 'DeliveryCancelled', { orderId: o.id, deliveryId: d.id, by: side.side });
      await audit(sql, { actorUserId: user.id, action: 'delivery.cancelled', targetType: 'Delivery', targetId: d.id, reason: body.reason });
      return { state: 'cancelled' };
    },
  });

  // ---------------------------------------------------------------- dispatch (consignment) and arrival
  route(app, s, {
    method: 'POST', url: '/v1/deliveries/:id/dispatch', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({
      ...version, consignmentRef: z.string().trim().min(1).max(80), vehicle: z.string().trim().max(80).optional(), driverName: z.string().trim().max(80).optional(),
      notes: z.string().trim().max(1000).optional(), lines: z.array(lineQty).min(1).max(200),
    }),
    handler: async ({ sql, params, body, user }) => {
      const { d, side, o } = await deliveryCtx(sql, user, params.id);
      if (!allowed(DELIVERY_ACTOR.dispatch, side)) throw forbidden('The supplier dispatches deliveries.');
      stale(d, body.expectedVersion, 'delivery');
      if (!deliveryMachine.can(d.state, 'dispatch')) throw conflict('INVALID_TRANSITION', 'This delivery has already left.');
      if (!['confirmed', 'partially_fulfilled', 'disputed'].includes(o.state)) throw conflict('ORDER_NOT_ACTIVE', 'This order is not active.');
      const f = await loadFulfilment(sql, o);
      const dl = f.deliveries.find((x) => x.id === d.id)!;
      const loaded = quantities(body.lines);
      const problems = dispatchProblems(dl.lines, loaded, cfg, descriptions(f));
      if (problems.length) throw unprocessable('DISPATCH_INVALID', problems[0]!, { problems });
      for (const l of dl.lines) {
        const q = loaded.find((x) => x.lineKey === l.lineKey)?.quantity ?? 0n;
        await sql.query(`update delivery_lines set dispatched_qty = $3 where delivery_id = $1 and line_key = $2`, [d.id, l.lineKey, formatDec(q)]);
      }
      await sql.query(`update deliveries set state = $2, consignment_ref = $3, vehicle = $4, driver_name = $5, dispatch_notes = $6, dispatched_at = now(), dispatched_by = $7, version = version + 1, updated_at = now() where id = $1`,
        [d.id, deliveryMachine.next(d.state, 'dispatch'), body.consignmentRef, body.vehicle ?? null, body.driverName ?? null, body.notes ?? null, user.id]);
      await tellClient(sql, o, 'Delivery on the way', `${ref('DEL', d.number)} left with consignment ${body.consignmentRef}. Record what arrives, then inspect it.`);
      await publish(sql, 'DeliveryDispatched', { orderId: o.id, deliveryId: d.id, consignmentRef: body.consignmentRef });
      await audit(sql, { actorUserId: user.id, action: 'delivery.dispatched', targetType: 'Delivery', targetId: d.id, metadata: { consignmentRef: body.consignmentRef } });
      return { state: 'dispatched' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/deliveries/:id/arrive', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object(version),
    handler: async ({ sql, params, body, user }) => {
      const { d, side, o } = await deliveryCtx(sql, user, params.id);
      if (!allowed(DELIVERY_ACTOR.arrive, side)) throw forbidden();
      stale(d, body.expectedVersion, 'delivery');
      if (!deliveryMachine.can(d.state, 'arrive')) throw conflict('INVALID_TRANSITION', d.state === 'scheduled' ? 'The supplier has not dispatched this delivery yet.' : 'This delivery has already arrived.');
      await sql.query(`update deliveries set state = 'arrived', arrived_at = now(), arrived_by = $2, version = version + 1, updated_at = now() where id = $1`, [d.id, user.id]);
      if (side.side === 'provider') await tellClient(sql, o, 'Delivery has arrived', `${ref('DEL', d.number)} is on site. Record what came off the vehicle.`);
      await publish(sql, 'DeliveryArrived', { orderId: o.id, deliveryId: d.id, by: side.side });
      return { state: 'arrived' };
    },
  });

  // ---------------------------------------------------------------- proof of delivery: a receipt, not an acceptance (§22.6)
  route(app, s, {
    method: 'POST', url: '/v1/deliveries/:id/receive', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({
      ...version, receivedBy: z.string().trim().min(2).max(120), receivedAt: z.iso.datetime({ offset: true }), notes: z.string().trim().max(1000).optional(),
      proofRevisionId: z.uuid().optional(), lines: z.array(lineQty).min(1).max(200),
    }),
    handler: async ({ sql, params, body, user }) => {
      const { d, side, o } = await deliveryCtx(sql, user, params.id);
      if (!allowed(DELIVERY_ACTOR.receive, side)) throw forbidden('The client records proof of delivery.');
      stale(d, body.expectedVersion, 'delivery');
      if (!deliveryMachine.can(d.state, 'receive')) throw conflict('INVALID_TRANSITION', d.state === 'dispatched' ? 'Mark the delivery as arrived first.' : 'Proof of delivery is already recorded.');
      if (body.proofRevisionId && !(await one(sql, `select 1 from document_revisions where id = $1 and project_id = $2`, [body.proofRevisionId, o.project_id]))) throw badRequest('INVALID_REFERENCE', 'That proof is not in this project.');
      const f = await loadFulfilment(sql, o);
      const dl = f.deliveries.find((x) => x.id === d.id)!;
      const pod = { receivedBy: body.receivedBy, receivedAt: body.receivedAt, lines: quantities(body.lines) };
      const problems = podProblems(dl.lines, pod, new Date());
      if (problems.length) throw unprocessable('POD_INVALID', problems[0]!, { problems });
      for (const l of pod.lines) await sql.query(`update delivery_lines set received_qty = $3 where delivery_id = $1 and line_key = $2`, [d.id, l.lineKey, formatDec(l.quantity)]);
      const receivedAt = new Date(body.receivedAt).toISOString();
      const hash = sha256(canonicalJson({ kind: 'ProofOfDelivery', deliveryId: d.id, orderId: o.id, receivedBy: body.receivedBy, receivedAt, notes: body.notes ?? null, proofRevisionId: body.proofRevisionId ?? null, lines: pod.lines.map((l) => ({ lineKey: l.lineKey, quantity: formatDec(l.quantity) })) }));
      await sql.query(`update deliveries set state = $2, received_by_name = $3, received_at = $4, pod_recorded_by = $5, pod_recorded_at = now(), pod_notes = $6, pod_proof_revision_id = $7, pod_hash = $8, version = version + 1, updated_at = now() where id = $1`,
        [d.id, deliveryMachine.next(d.state, 'receive'), body.receivedBy, receivedAt, user.id, body.notes ?? null, body.proofRevisionId ?? null, hash]);
      await tellProvider(sql, o, 'Delivery received (not yet inspected)', `${ref('PO', o.number)} ${ref('DEL', d.number)} was received by ${body.receivedBy}. The client will inspect it.`);
      await publish(sql, 'DeliveryReceived', { orderId: o.id, deliveryId: d.id, podHash: hash });
      await audit(sql, { actorUserId: user.id, action: 'delivery.received', targetType: 'Delivery', targetId: d.id, metadata: { podHash: hash } });
      const after = await syncOrder(sql, s, o.id);
      return { state: 'received', podHash: hash, orderState: after.state, notice: RECEIPT_NOTICE };
    },
  });

  // ---------------------------------------------------------------- inspection and discrepancies
  route(app, s, {
    method: 'POST', url: '/v1/deliveries/:id/inspect', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({
      ...version, notes: z.string().trim().max(1000).optional(),
      lines: z.array(z.object({ lineKey: z.uuid(), accepted: qtyField, rejected: qtyField.default('0'), kind: z.enum(DISCREPANCY_KINDS).nullable().optional(), note: z.string().trim().max(500).nullable().optional() })).min(1).max(200),
    }),
    handler: async ({ sql, params, body, user }) => {
      const { d, side, o } = await deliveryCtx(sql, user, params.id);
      if (!allowed(DELIVERY_ACTOR.accept, side)) throw forbidden('The client inspects deliveries.');
      stale(d, body.expectedVersion, 'delivery');
      if (d.state !== 'received') throw conflict('INVALID_TRANSITION', d.inspected_at ? 'This delivery is already inspected.' : 'Record proof of delivery before inspecting.');
      const f = await loadFulfilment(sql, o);
      const dl = f.deliveries.find((x) => x.id === d.id)!;
      const out = inspectionOutcome(dl.lines, body.lines.map((l) => ({ lineKey: l.lineKey, accepted: parseDec(l.accepted) ?? 0n, rejected: parseDec(l.rejected) ?? 0n, kind: l.kind ?? null, note: l.note ?? null })), descriptions(f));
      if (out.problems.length) throw unprocessable('INSPECTION_INVALID', out.problems[0]!, { problems: out.problems });
      for (const l of out.lines) await sql.query(`update delivery_lines set accepted_qty = $3, rejected_qty = $4 where delivery_id = $1 and line_key = $2`, [d.id, l.lineKey, formatDec(l.accepted), formatDec(l.rejected)]);
      for (const x of out.discrepancies) {
        await sql.query(`insert into delivery_discrepancies (id, delivery_id, order_id, project_id, provider_org_id, line_key, kind, quantity, note, raised_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [uuidv7(), d.id, o.id, o.project_id, o.provider_org_id, x.lineKey, x.kind, formatDec(x.quantity), x.note, user.id]);
      }
      await sql.query(`update deliveries set state = $2, inspected_at = now(), inspected_by = $3, inspection_notes = $4, version = version + 1, updated_at = now() where id = $1`,
        [d.id, deliveryMachine.next(d.state, out.command), user.id, body.notes ?? null]);
      await publish(sql, 'InspectionRecorded', { orderId: o.id, deliveryId: d.id, outcome: out.command });
      if (out.discrepancies.length) {
        await publish(sql, 'DiscrepancyRaised', { orderId: o.id, deliveryId: d.id, count: out.discrepancies.length });
        const names = descriptions(f);
        await tellProvider(sql, o, 'Discrepancy raised on a delivery', `${ref('PO', o.number)} ${ref('DEL', d.number)}: ${out.discrepancies.map((x) => `${names[x.lineKey]} ${formatDec(x.quantity, 3)} ${DISCREPANCY_LABEL[x.kind].toLowerCase()}`).join('; ')}. Acknowledge or contest it.`);
      } else await tellProvider(sql, o, 'Delivery inspected and accepted', `${ref('PO', o.number)} ${ref('DEL', d.number)} passed inspection.`);
      await audit(sql, { actorUserId: user.id, action: 'delivery.inspected', targetType: 'Delivery', targetId: d.id, metadata: { outcome: out.command, discrepancies: out.discrepancies.length } });
      const after = await syncOrder(sql, s, o.id);
      return { state: deliveryMachine.next(d.state, out.command), discrepancies: out.discrepancies.length, orderState: after.state };
    },
  });

  async function discrepancyCtx(sql: Sql, user: Actor, id: string) {
    const x = await one<Row>(sql, `select * from delivery_discrepancies where id = $1`, [id]);
    if (!x) throw notFound('Discrepancy');
    const ctx = await deliveryCtx(sql, user, x.delivery_id).catch(() => { throw notFound('Discrepancy'); });
    return { x, ...ctx };
  }

  route(app, s, {
    method: 'POST', url: '/v1/discrepancies/:id/respond', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ action: z.enum(['acknowledge', 'contest']), note: z.string().trim().min(3).max(1000) }),
    handler: async ({ sql, params, body, user }) => {
      const { x, side, o, d } = await discrepancyCtx(sql, user, params.id);
      if (!allowed(DISCREPANCY_ACTOR[body.action], side)) throw forbidden('The supplier answers discrepancies.');
      if (!discrepancyMachine.can(x.state, body.action)) throw conflict('INVALID_TRANSITION', x.state === 'resolved' ? 'This discrepancy is resolved.' : 'You have already answered this discrepancy.');
      await sql.query(`update delivery_discrepancies set state = $2, supplier_response = $3, responded_by = $4, responded_at = now(), version = version + 1 where id = $1`, [x.id, discrepancyMachine.next(x.state, body.action), body.note, user.id]);
      await tellClient(sql, o, body.action === 'acknowledge' ? 'The supplier acknowledged a discrepancy' : 'The supplier contests a discrepancy', `${ref('DEL', d.number)}: ${body.note}`);
      await publish(sql, 'DiscrepancyAnswered', { orderId: o.id, discrepancyId: x.id, action: body.action });
      await audit(sql, { actorUserId: user.id, action: `discrepancy.${body.action}`, targetType: 'Discrepancy', targetId: x.id, reason: body.note });
      return { state: discrepancyMachine.next(x.state, body.action) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/discrepancies/:id/resolve', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ resolution: z.enum(RESOLUTIONS), note: z.string().trim().max(1000).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const { x, side, o, d } = await discrepancyCtx(sql, user, params.id);
      if (!allowed(DISCREPANCY_ACTOR.resolve, side)) throw forbidden('The client resolves discrepancies.');
      if (!discrepancyMachine.can(x.state, 'resolve')) throw conflict('INVALID_TRANSITION', 'This discrepancy is already resolved.');
      if (x.kind === 'excess' && body.resolution === 'credit') throw unprocessable('RESOLUTION_INVALID', 'Extra goods are returned or kept, not credited.');
      await sql.query(`update delivery_discrepancies set state = 'resolved', resolution = $2, resolution_note = $3, resolved_by = $4, resolved_at = now(), version = version + 1 where id = $1`, [x.id, body.resolution, body.note ?? null, user.id]);
      const open = await one(sql, `select 1 from delivery_discrepancies where delivery_id = $1 and state <> 'resolved'`, [d.id]);
      if (!open && deliveryMachine.can(d.state, 'resolve')) await sql.query(`update deliveries set state = 'resolved', resolved_at = now(), version = version + 1, updated_at = now() where id = $1`, [d.id]);
      await tellProvider(sql, o, 'Discrepancy resolved', `${ref('DEL', d.number)}: ${RESOLUTION_LABEL[body.resolution]}${body.note ? ` (${body.note})` : ''}.`);
      await publish(sql, 'DiscrepancyResolved', { orderId: o.id, discrepancyId: x.id, resolution: body.resolution });
      await audit(sql, { actorUserId: user.id, action: 'discrepancy.resolved', targetType: 'Discrepancy', targetId: x.id, metadata: { resolution: body.resolution } });
      const after = await syncOrder(sql, s, o.id);
      return { state: 'resolved', deliveryState: open ? d.state : 'resolved', orderState: after.state };
    },
  });

  // ---------------------------------------------------------------- returns
  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/returns', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ reason: z.string().trim().min(3).max(1000), discrepancyId: z.uuid().optional(), lines: z.array(lineQty).min(1).max(200) }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (!side.canManage) throw forbidden('The client requests returns.');
      const o = side.o;
      if (['cancelled', 'closed', 'placed'].includes(o.state)) throw conflict('ORDER_NOT_ACTIVE', 'This order cannot take returns.');
      const f = await loadFulfilment(sql, o);
      const disc = body.discrepancyId ? f.deliveries.flatMap((d) => d.discrepancies).find((x) => x.id === body.discrepancyId) ?? null : null;
      if (body.discrepancyId && !disc) throw notFound('Discrepancy');
      if (disc && f.rRows.some((r) => r.discrepancy_id === disc.id && !['rejected', 'cancelled'].includes(r.state))) throw conflict('DUPLICATE_RETURN', 'A return is already open for this discrepancy.');
      const lines = quantities(body.lines).filter((l) => l.quantity > 0n);
      const received = disc ? f.dRows.find((d) => d.id === disc.deliveryId)?.received_at : f.dRows.filter((d) => d.received_at).map((d) => d.received_at).sort().pop();
      const problems = returnProblems(f.progress, { lines, discrepancy: disc, receivedAt: received ? iso(received)! : null }, new Date(), cfg);
      if (problems.length) throw unprocessable('RETURN_INVALID', problems[0]!, { problems });
      const id = uuidv7();
      const n = (await one<{ n: number }>(sql, `select coalesce(max(number), 0)::int + 1 as n from return_requests where order_id = $1`, [o.id]))!.n;
      await sql.query(`insert into return_requests (id, order_id, project_id, provider_org_id, number, delivery_id, discrepancy_id, reason, requested_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, o.id, o.project_id, o.provider_org_id, n, disc?.deliveryId ?? null, disc?.id ?? null, body.reason, user.id]);
      for (const l of lines) {
        const ol = f.lines.find((x) => x.lineKey === l.lineKey)!;
        await sql.query(`insert into return_lines (id, return_id, order_id, project_id, provider_org_id, line_key, description, unit, quantity) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [uuidv7(), id, o.id, o.project_id, o.provider_org_id, l.lineKey, ol.description, ol.unit, formatDec(l.quantity)]);
      }
      await tellProvider(sql, o, 'Return requested', `${ref('PO', o.number)} ${ref('RET', n)}: ${body.reason}. Approve or reject it.`);
      await publish(sql, 'ReturnRequested', { orderId: o.id, returnId: id, discrepancyId: disc?.id ?? null });
      await audit(sql, { actorUserId: user.id, action: 'return.requested', targetType: 'ReturnRequest', targetId: id, reason: body.reason });
      return { id, number: n, reference: ref('RET', n) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/returns/:id/:action', auth: 'user', params: z.object({ id: z.uuid(), action: z.enum(['approve', 'reject', 'collect', 'cancel']) }), successStatus: 200,
    body: z.object({ ...version, note: z.string().trim().min(3).max(1000).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Row>(sql, `select * from return_requests where id = $1`, [params.id]);
      if (!r) throw notFound('Return');
      const side = await orderSide(sql, user, r.order_id).catch(() => { throw notFound('Return'); });
      const o = side.o;
      const cmd = params.action as ReturnCommand;
      if (!allowed(RETURN_ACTOR[cmd], side)) throw forbidden();
      stale(r, body.expectedVersion, 'return');
      const done: Record<ReturnCommand, string> = { approve: 'approved', reject: 'rejected', collect: 'collected', cancel: 'cancelled' };
      if (!returnMachine.can(r.state, cmd)) throw conflict('INVALID_TRANSITION', `A ${r.state} return can't be ${done[cmd]}.`);
      if ((cmd === 'reject' || cmd === 'cancel') && !body.note) throw badRequest('VALIDATION_FAILED', 'Give a reason.', [{ path: 'note', message: 'Required.' }]);
      const to = returnMachine.next(r.state, cmd);
      await sql.query(`update return_requests set state = $2, supplier_note = case when $3 then coalesce($4, supplier_note) else supplier_note end,
          decided_by = case when $5 then $6::uuid else decided_by end, decided_at = case when $5 then now() else decided_at end,
          collected_by = case when $7 then $6::uuid else collected_by end, collected_at = case when $7 then now() else collected_at end, version = version + 1, updated_at = now() where id = $1`,
        [r.id, to, side.side === 'provider', body.note ?? null, cmd === 'approve' || cmd === 'reject', user.id, cmd === 'collect']);
      const text = `${ref('PO', o.number)} ${ref('RET', r.number)}${body.note ? `: ${body.note}` : ''}`;
      if (side.side === 'provider') await tellClient(sql, o, cmd === 'approve' ? 'Return approved' : cmd === 'reject' ? 'Return rejected' : 'Return collected', text);
      else await tellProvider(sql, o, cmd === 'cancel' ? 'Return cancelled' : 'Return collected', text);
      await publish(sql, cmd === 'collect' ? 'ReturnCollected' : 'ReturnDecided', { orderId: o.id, returnId: r.id, state: to });
      await audit(sql, { actorUserId: user.id, action: `return.${cmd}`, targetType: 'ReturnRequest', targetId: r.id, reason: body.note ?? null });
      const after = await syncOrder(sql, s, o.id);
      return { state: to, orderState: after.state };
    },
  });

  // ---------------------------------------------------------------- supplier invoices and the three-way match
  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/invoices', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({
      invoiceNumber: z.string().trim().min(1).max(60), issuedOn: z.iso.date(), dueOn: z.iso.date().optional(), notes: z.string().trim().max(1000).optional(),
      deliveryCharge: z.string().max(24).default('0'), deliveryTaxRatePct: z.number().min(0).max(50).default(0), statedTotal: z.string().max(24),
      lines: z.array(z.object({
        lineKey: z.uuid().nullable(), description: z.string().trim().max(300).optional(), unit: z.string().max(20).optional(),
        quantity: qtyField, unitPrice: z.string().max(24), taxRatePct: z.number().min(0).max(50).default(0),
      })).min(1).max(200),
    }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (side.side !== 'provider') throw forbidden('Only the supplier sends invoices for this order.');
      const o = side.o;
      if (!['confirmed', 'partially_fulfilled', 'fulfilled', 'disputed'].includes(o.state)) throw conflict('ORDER_NOT_ACTIVE', o.state === 'placed' ? 'Confirm the order first.' : 'This order no longer takes invoices.');
      if (await one(sql, `select 1 from supplier_invoices where order_id = $1 and invoice_number = $2`, [o.id, body.invoiceNumber])) throw conflict('DUPLICATE_INVOICE', 'An invoice with this number was already sent for this order.');
      const f = await loadFulfilment(sql, o);
      const money = (v: string, path: string) => {
        const m = parseMajor(v || '0', o.currency);
        if (m == null) throw badRequest('VALIDATION_FAILED', 'Enter an amount like 9500 or 9500.50.', [{ path, message: 'Invalid amount.' }]);
        return m;
      };
      const input: InvoiceInput = {
        lines: body.lines.map((l, i) => {
          const ol = l.lineKey ? f.lines.find((x) => x.lineKey === l.lineKey) : undefined;
          return { lineKey: ol ? ol.lineKey : null, description: l.description || ol?.description || 'Other charge', unit: l.unit || ol?.unit || 'item', quantity: parseDec(l.quantity) ?? 0n, unitPriceMinor: money(l.unitPrice, `lines.${i}.unitPrice`), taxRatePct: l.taxRatePct };
        }),
        deliveryMinor: money(body.deliveryCharge, 'deliveryCharge'), deliveryTaxRatePct: body.deliveryTaxRatePct, statedTotalMinor: money(body.statedTotal, 'statedTotal'),
      };
      const problems = invoiceProblems({ ...input, number: body.invoiceNumber, issuedOn: body.issuedOn }, today());
      if (problems.length) throw unprocessable('INVOICE_INVALID', problems[0]!, { problems });
      const m = threeWayMatch({ lines: f.lines, ...f.deliveryTerms }, f.progress, input, priorInvoices(f, null), cfg);
      const id = uuidv7();
      const totals = { linesMinor: String(m.totals.linesMinor), deliveryMinor: String(m.totals.deliveryMinor), taxMinor: String(m.totals.taxMinor), grossMinor: String(m.totals.grossMinor) };
      const hash = sha256(canonicalJson({
        kind: 'SupplierInvoice', orderId: o.id, number: body.invoiceNumber, issuedOn: body.issuedOn, dueOn: body.dueOn ?? null, currency: o.currency, statedTotalMinor: String(input.statedTotalMinor),
        deliveryMinor: String(input.deliveryMinor), deliveryTaxRatePct: input.deliveryTaxRatePct, lines: input.lines.map((l) => ({ ...l, quantity: formatDec(l.quantity), unitPriceMinor: String(l.unitPriceMinor) })),
      }));
      const state = invoiceMachine.next('submitted', matchCommand('submitted', m)!);
      await sql.query(`insert into supplier_invoices (id, order_id, project_id, provider_org_id, invoice_number, issued_on, due_on, currency, delivery_minor, delivery_tax_rate_pct, stated_total_minor, totals, match, match_status, state, notes, snapshot_hash, submitted_by)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17, $18)`,
      [id, o.id, o.project_id, o.provider_org_id, body.invoiceNumber, body.issuedOn, body.dueOn ?? null, o.currency, String(input.deliveryMinor), input.deliveryTaxRatePct, String(input.statedTotalMinor), JSON.stringify(totals), JSON.stringify(matchJson(m)), m.status, state, body.notes ?? null, hash, user.id]);
      let pos = 0;
      for (const l of input.lines) {
        await sql.query(`insert into supplier_invoice_lines (id, invoice_id, order_id, project_id, provider_org_id, line_key, position, description, unit, quantity, unit_price_minor, tax_rate_pct) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [uuidv7(), id, o.id, o.project_id, o.provider_org_id, l.lineKey, ++pos, l.description, l.unit, formatDec(l.quantity), String(l.unitPriceMinor), l.taxRatePct]);
      }
      await tellClient(sql, o, m.status === 'matched' ? 'Invoice received and matched' : 'Invoice received: variance needs approval',
        `${ref('PO', o.number)} invoice ${body.invoiceNumber}: ${m.status === 'matched' ? 'it matches the order and what was received.' : m.variances.map((v) => v.message).join(' ')}`);
      await publish(sql, 'SupplierInvoiceSubmitted', { orderId: o.id, invoiceId: id, status: m.status });
      await audit(sql, { actorUserId: user.id, action: 'invoice.submitted', targetType: 'SupplierInvoice', targetId: id, metadata: { snapshotHash: hash, match: m.status, variances: m.variances.map((v) => v.kind) } });
      return { id, state, match: { status: m.status, variances: m.variances.map((v) => ({ kind: v.kind, message: v.message })) } };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/invoices/:id/:action', auth: 'user', params: z.object({ id: z.uuid(), action: z.enum(['approve', 'reject', 'withdraw']) }), successStatus: 200,
    body: z.object({ ...version, reason: z.string().trim().min(3).max(1000) }),
    handler: async ({ sql, params, body, user }) => {
      const inv = await one<Row>(sql, `select * from supplier_invoices where id = $1`, [params.id]);
      if (!inv) throw notFound('Invoice');
      const side = await orderSide(sql, user, inv.order_id).catch(() => { throw notFound('Invoice'); });
      const o = side.o;
      const cmd = params.action;
      // Approving a variance is an authorised client decision (owner, §10.4 step 9); a manager can reject.
      if (cmd === 'approve' ? !side.canApprove : !allowed(INVOICE_ACTOR[cmd], side)) throw cmd === 'approve' && side.side === 'client' ? forbidden('Only the project owner can approve an invoice variance.') : forbidden();
      stale(inv, body.expectedVersion, 'invoice');
      if (!invoiceMachine.can(inv.state, cmd)) throw conflict('INVALID_TRANSITION', cmd === 'approve' ? 'Only an invoice with a variance needs approval.' : `A ${inv.state.replace(/_/g, ' ')} invoice can't be ${cmd === 'reject' ? 'rejected' : 'withdrawn'}.`);
      const to = invoiceMachine.next(inv.state, cmd);
      await sql.query(`update supplier_invoices set state = $2, decided_by = $3, decided_at = now(), decision_reason = $4, version = version + 1, updated_at = now() where id = $1`, [inv.id, to, user.id, body.reason]);
      const text = `${ref('PO', o.number)} invoice ${inv.invoice_number}: ${body.reason}`;
      if (side.side === 'provider') await tellClient(sql, o, 'The supplier withdrew an invoice', text);
      else await tellProvider(sql, o, cmd === 'approve' ? 'Invoice variance approved' : 'Invoice rejected', text);
      await publish(sql, cmd === 'withdraw' ? 'SupplierInvoiceWithdrawn' : 'SupplierInvoiceDecided', { orderId: o.id, invoiceId: inv.id, state: to });
      await audit(sql, { actorUserId: user.id, action: `invoice.${cmd}`, targetType: 'SupplierInvoice', targetId: inv.id, reason: body.reason, metadata: { variances: json<Row>(inv.match).variances?.map((v: Row) => v.kind) ?? [] } });
      // Later invoices bill on top of this one; re-match them.
      await syncOrder(sql, s, o.id);
      return { state: to };
    },
  });

  // ---------------------------------------------------------------- record-only payments against the order (§14.1)
  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/payments', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({
      amount: z.string().max(24), paidOn: z.iso.date(), method: z.enum(['bank_transfer', 'cash', 'card', 'mobile_money', 'cheque', 'other']),
      reference: z.string().trim().max(120).optional(), invoiceId: z.uuid().optional(), proofRevisionId: z.uuid().optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (side.side !== 'client' || !side.canManage) throw forbidden();
      const o = side.o;
      const minor = parseMajor(body.amount, o.currency);
      if (minor == null || minor <= 0n) throw badRequest('VALIDATION_FAILED', 'Enter the amount paid.', [{ path: 'amount', message: 'Enter the amount paid.' }]);
      if (body.paidOn > today()) throw badRequest('VALIDATION_FAILED', 'The payment date cannot be in the future.', [{ path: 'paidOn', message: 'The payment date cannot be in the future.' }]);
      const inv = body.invoiceId ? await one<Row>(sql, `select * from supplier_invoices where id = $1 and order_id = $2`, [body.invoiceId, o.id]) : null;
      if (body.invoiceId && !inv) throw badRequest('INVALID_REFERENCE', 'That invoice is not on this order.');
      if (body.proofRevisionId && !(await one(sql, `select 1 from document_revisions where id = $1 and project_id = $2`, [body.proofRevisionId, o.project_id]))) throw badRequest('INVALID_REFERENCE', 'That proof is not in this project.');
      const org = await one<Row>(sql, `select name from organizations where id = $1`, [o.provider_org_id]);
      const id = uuidv7();
      await sql.query(`insert into payment_records (id, project_id, payee, description, amount_minor, currency, paid_on, method, reference, proof_revision_id, recorded_by, order_id, supplier_invoice_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, o.project_id, org?.name ?? 'Supplier', `${ref('PO', o.number)}${inv ? `, invoice ${inv.invoice_number}` : ''}`, String(minor), o.currency, body.paidOn, body.method, body.reference ?? null, body.proofRevisionId ?? null, user.id, o.id, inv?.id ?? null]);
      await tellProvider(sql, o, 'The client recorded a payment', `${ref('PO', o.number)}: ${formatMoney({ amountMinor: String(minor), currency: o.currency }, s.pack.locale)} on ${body.paidOn}. Confirm when you have received it.`);
      await publish(sql, 'PaymentRecorded', { projectId: o.project_id, orderId: o.id, paymentRecordId: id });
      await audit(sql, { actorUserId: user.id, action: 'payment.recorded', targetType: 'PaymentRecord', targetId: id, metadata: { orderId: o.id, invoiceId: inv?.id ?? null } });
      return { id, notice: RECORD_ONLY_PAYMENT_NOTICE };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/payment-records/:id/supplier-acknowledge', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    handler: async ({ sql, params, user }) => {
      const p = await one<Row>(sql, `select * from payment_records where id = $1 and order_id is not null`, [params.id]);
      if (!p) throw notFound('Payment record');
      const side = await orderSide(sql, user, p.order_id).catch(() => { throw notFound('Payment record'); });
      if (side.side !== 'provider') throw forbidden('The supplier confirms receipt of a payment.');
      const ok = (await one<{ ok: boolean }>(sql, `select order_payment_acknowledge($1) as ok`, [p.id]))!.ok;
      if (!ok) throw conflict('ALREADY_ACKNOWLEDGED', 'This payment is already confirmed or was voided.');
      await tellClient(sql, side.o, 'The supplier confirmed a payment', `${ref('PO', side.o.number)}: payment of ${formatMoney({ amountMinor: String(p.amount_minor), currency: p.currency }, s.pack.locale)} received.`);
      await publish(sql, 'PaymentAcknowledged', { orderId: side.o.id, paymentRecordId: p.id });
      await audit(sql, { actorUserId: user.id, action: 'payment.supplier_acknowledged', targetType: 'PaymentRecord', targetId: p.id });
      return { acknowledged: true };
    },
  });
}
