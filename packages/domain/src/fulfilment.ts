import { defineMachine } from './core';
import { divRound, formatDec, parseDec, SCALE } from './decimal';
import type { OrderCommand, OrderState } from './procurement';

/**
 * Fulfilment, second slice of Release 3 (spec §9.4, §10.4 steps 7–9, §14.1, scenario §22.6). Pure rules: the
 * delivery, discrepancy, return and supplier-invoice state machines, what each order line has been scheduled,
 * received, accepted and returned, the inspection outcome, and the three-way match (supplier invoice ↔ order ↔
 * proof of delivery). Receipt never implies quality acceptance: only an inspection moves quantities to accepted.
 * Values come from `FulfilmentConfig` in the market pack.
 */

// ---------------------------------------------------------------- configuration (market pack, [Proposed])
export interface DeliverySlot { code: string; label: string; start: string; end: string }
export interface FulfilmentConfig {
  /** Delivery windows a client can book (local time). */
  deliverySlots: DeliverySlot[];
  /** How far ahead a delivery can be booked. */
  maxScheduleAheadDays: number;
  /** After this long a received delivery shows as "inspection overdue". Receipt is never taken as acceptance. */
  inspectionWindowHours: number;
  /** Returns can be requested up to this many days after the goods were received. */
  returnWindowDays: number;
  /** A delivery may book or load up to this much more than is outstanding (per cent). */
  overDeliveryTolerancePct: number;
  /** Three-way match tolerances. Anything beyond them is a variance routed to approval (§10.4 step 9). */
  match: { priceTolerancePct: number; quantityTolerancePct: number; totalToleranceMinor: number };
}

export const DEFAULT_FULFILMENT_CONFIG: FulfilmentConfig = {
  deliverySlots: [
    { code: 'morning', label: 'Morning, 8:00 to 12:00', start: '08:00', end: '12:00' },
    { code: 'afternoon', label: 'Afternoon, 12:00 to 16:00', start: '12:00', end: '16:00' },
    { code: 'evening', label: 'Late afternoon, 16:00 to 18:00', start: '16:00', end: '18:00' },
  ],
  maxScheduleAheadDays: 120,
  inspectionWindowHours: 48,
  returnWindowDays: 30,
  overDeliveryTolerancePct: 0,
  match: { priceTolerancePct: 0, quantityTolerancePct: 0, totalToleranceMinor: 100 },
};

// ---------------------------------------------------------------- state machines (§9.4)
export const DELIVERY_STATES = ['scheduled', 'dispatched', 'arrived', 'received', 'inspected_ok', 'discrepancy_raised', 'resolved', 'cancelled'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export type DeliveryCommand = 'reschedule' | 'dispatch' | 'arrive' | 'receive' | 'accept' | 'raise_discrepancy' | 'resolve' | 'cancel';

export const deliveryMachine = defineMachine<DeliveryState, DeliveryCommand>('Delivery', DELIVERY_STATES, [
  { from: ['scheduled'], command: 'reschedule', to: 'scheduled' },
  { from: ['scheduled'], command: 'dispatch', to: 'dispatched' },
  { from: ['dispatched'], command: 'arrive', to: 'arrived' },
  // Proof of delivery records what arrived. It is a receipt, not an acceptance (§22.6).
  { from: ['arrived'], command: 'receive', to: 'received' },
  { from: ['received'], command: 'accept', to: 'inspected_ok' },
  { from: ['received'], command: 'raise_discrepancy', to: 'discrepancy_raised' },
  { from: ['discrepancy_raised'], command: 'resolve', to: 'resolved' },
  { from: ['scheduled', 'dispatched'], command: 'cancel', to: 'cancelled' },
]);
export type FulfilmentActor = 'client' | 'provider' | 'either' | 'system';
export const DELIVERY_ACTOR: Record<DeliveryCommand, FulfilmentActor> = {
  reschedule: 'either', dispatch: 'provider', arrive: 'either', receive: 'client', accept: 'client', raise_discrepancy: 'client', resolve: 'system', cancel: 'either',
};
/** Deliveries whose goods have been received (their proof of delivery is fixed). */
export const RECEIVED_STATES: readonly DeliveryState[] = ['received', 'inspected_ok', 'discrepancy_raised', 'resolved'];
export const INSPECTED_STATES: readonly DeliveryState[] = ['inspected_ok', 'discrepancy_raised', 'resolved'];
const IN_TRANSIT: readonly DeliveryState[] = ['scheduled', 'dispatched', 'arrived'];

export const DISCREPANCY_KINDS = ['shortage', 'damaged', 'wrong_item', 'wrong_spec', 'quality', 'excess'] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];
export const DISCREPANCY_LABEL: Record<DiscrepancyKind, string> = {
  shortage: 'Short delivered', damaged: 'Damaged', wrong_item: 'Wrong item', wrong_spec: 'Wrong specification', quality: 'Quality not acceptable', excess: 'More than ordered',
};
/** Kinds where goods arrived but were rejected at inspection (a shortage never arrived). */
const REJECT_KINDS: readonly DiscrepancyKind[] = ['damaged', 'wrong_item', 'wrong_spec', 'quality', 'excess'];

export const DISCREPANCY_STATES = ['open', 'acknowledged', 'contested', 'resolved'] as const;
export type DiscrepancyState = (typeof DISCREPANCY_STATES)[number];
export type DiscrepancyCommand = 'acknowledge' | 'contest' | 'resolve';
export const discrepancyMachine = defineMachine<DiscrepancyState, DiscrepancyCommand>('Discrepancy', DISCREPANCY_STATES, [
  { from: ['open'], command: 'acknowledge', to: 'acknowledged' },
  { from: ['open', 'acknowledged'], command: 'contest', to: 'contested' },
  { from: ['open', 'acknowledged', 'contested'], command: 'resolve', to: 'resolved' },
]);
export const DISCREPANCY_ACTOR: Record<DiscrepancyCommand, FulfilmentActor> = { acknowledge: 'provider', contest: 'provider', resolve: 'client' };

/**
 * How a discrepancy is settled. `replace`: the supplier sends the quantity again (it stays outstanding).
 * `credit`: it is not resupplied and should not be invoiced (it no longer counts as outstanding).
 * `accept_as_is`: the client keeps rejected goods (they count as accepted) or accepts a shortfall (no longer outstanding).
 */
export const RESOLUTIONS = ['replace', 'credit', 'accept_as_is'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];
export const RESOLUTION_LABEL: Record<Resolution, string> = { replace: 'Supplier replaces it', credit: 'Supplier credits it (not resupplied)', accept_as_is: 'Accept as is' };

export const RETURN_STATES = ['requested', 'approved', 'collected', 'rejected', 'cancelled'] as const;
export type ReturnState = (typeof RETURN_STATES)[number];
export type ReturnCommand = 'approve' | 'reject' | 'collect' | 'cancel';
export const returnMachine = defineMachine<ReturnState, ReturnCommand>('ReturnRequest', RETURN_STATES, [
  { from: ['requested'], command: 'approve', to: 'approved' },
  { from: ['requested'], command: 'reject', to: 'rejected' },
  { from: ['approved'], command: 'collect', to: 'collected' },
  { from: ['requested', 'approved'], command: 'cancel', to: 'cancelled' },
]);
export const RETURN_ACTOR: Record<ReturnCommand, FulfilmentActor> = { approve: 'provider', reject: 'provider', collect: 'either', cancel: 'client' };
const OPEN_RETURNS: readonly ReturnState[] = ['requested', 'approved'];

/** A supplier invoice is matched on submission; a variance waits for an authorised client decision (§10.4 step 9). */
export const INVOICE_STATES = ['submitted', 'matched', 'awaiting_approval', 'approved', 'rejected', 'withdrawn'] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];
export type InvoiceCommand = 'match' | 'flag' | 'approve' | 'reject' | 'withdraw';
export const invoiceMachine = defineMachine<InvoiceState, InvoiceCommand>('SupplierInvoice', INVOICE_STATES, [
  { from: ['submitted', 'awaiting_approval'], command: 'match', to: 'matched' },
  { from: ['submitted', 'matched'], command: 'flag', to: 'awaiting_approval' },
  { from: ['awaiting_approval'], command: 'approve', to: 'approved' },
  { from: ['matched', 'awaiting_approval'], command: 'reject', to: 'rejected' },
  { from: ['submitted', 'matched', 'awaiting_approval'], command: 'withdraw', to: 'withdrawn' },
]);
export const INVOICE_ACTOR: Record<InvoiceCommand, FulfilmentActor> = { match: 'system', flag: 'system', approve: 'client', reject: 'client', withdraw: 'provider' };
/** Invoices that still count towards what has been billed. */
export const BILLED_INVOICE_STATES: readonly InvoiceState[] = ['submitted', 'matched', 'awaiting_approval', 'approved'];
/** Invoices the client can treat as payable (matched, or a variance an authorised person approved). */
export const PAYABLE_INVOICE_STATES: readonly InvoiceState[] = ['matched', 'approved'];

// ---------------------------------------------------------------- order lines (from the awarded QuoteVersion snapshot)
export interface OrderLine {
  lineKey: string;
  description: string;
  unit: string;
  /** Scaled decimal (×10^6). */
  quantity: bigint;
  unitPriceMinor: bigint;
  taxRatePct: number;
  /** Excluded lines are part of the snapshot but are not supplied. */
  priced: boolean;
}

interface SnapshotLine { rfqLineKey: string; description?: string; status: string; unit: string; quantity: string; unitPriceMinor: string; taxRatePct: number }
export function orderLinesFromTerms(terms: { lines?: SnapshotLine[] }): OrderLine[] {
  return (terms.lines ?? []).map((l) => ({
    lineKey: l.rfqLineKey, description: l.description ?? '', unit: l.unit, quantity: parseDec(l.quantity) ?? 0n,
    unitPriceMinor: BigInt(l.unitPriceMinor ?? '0'), taxRatePct: Number(l.taxRatePct ?? 0), priced: l.status === 'priced',
  }));
}
/** The delivery charge and its tax rate agreed in the awarded quote. */
export function orderDeliveryTerms(terms: { terms?: { deliveryMinor?: string | number; deliveryTaxRatePct?: number } }) {
  return { deliveryMinor: BigInt(terms.terms?.deliveryMinor ?? 0), deliveryTaxRatePct: Number(terms.terms?.deliveryTaxRatePct ?? 0) };
}

// ---------------------------------------------------------------- fulfilment progress
export interface DeliveryLineRecord { lineKey: string; scheduled: bigint; dispatched: bigint | null; received: bigint | null; accepted: bigint | null; rejected: bigint | null }
export interface DiscrepancyRecord { id: string; deliveryId: string; lineKey: string; kind: DiscrepancyKind; quantity: bigint; state: DiscrepancyState; resolution: Resolution | null }
export interface DeliveryRecord { id: string; state: DeliveryState; receivedAt?: string | null; lines: DeliveryLineRecord[]; discrepancies: DiscrepancyRecord[] }
export interface ReturnRecord { id: string; state: ReturnState; discrepancyId: string | null; lines: { lineKey: string; quantity: bigint }[] }

export interface LineProgress {
  lineKey: string; description: string; unit: string; priced: boolean;
  ordered: bigint;
  /** Booked or on the road (scheduled, dispatched, arrived). */
  inTransit: bigint;
  /** On a proof of delivery. */
  received: bigint;
  /** Received but not inspected yet: not accepted. */
  awaitingInspection: bigint;
  accepted: bigint;
  rejected: bigint;
  /** Accepted goods sent back (collected). */
  returned: bigint;
  /** Goods on an open return request. */
  returnPending: bigint;
  /** No longer to be supplied: credited or accepted shortfalls, and returned surplus. */
  waived: bigint;
  /** What the client has, inspected and kept: accepted minus returned. This is the quantity an invoice may bill. */
  netAccepted: bigint;
  /** Still to book: ordered − waived − kept − awaiting inspection − in transit. */
  outstanding: bigint;
  complete: boolean;
}
export interface FulfilmentProgress {
  lines: LineProgress[];
  anyReceived: boolean;
  /** Every supplied line is kept in full (or settled), nothing is in transit or awaiting inspection. */
  complete: boolean;
  openDeliveries: number;
  awaitingInspection: number;
  openDiscrepancies: number;
  openReturns: number;
}

const max0 = (n: bigint) => (n < 0n ? 0n : n);

export function fulfilmentProgress(lines: OrderLine[], deliveries: DeliveryRecord[], returns: ReturnRecord[]): FulfilmentProgress {
  const by = new Map<string, LineProgress>();
  for (const l of lines) {
    by.set(l.lineKey, {
      lineKey: l.lineKey, description: l.description, unit: l.unit, priced: l.priced, ordered: l.priced ? l.quantity : 0n,
      inTransit: 0n, received: 0n, awaitingInspection: 0n, accepted: 0n, rejected: 0n, returned: 0n, returnPending: 0n, waived: 0n, netAccepted: 0n, outstanding: 0n, complete: false,
    });
  }
  const discrepancies = deliveries.flatMap((d) => d.discrepancies);
  for (const d of deliveries) {
    for (const dl of d.lines) {
      const p = by.get(dl.lineKey);
      if (!p) continue;
      if (IN_TRANSIT.includes(d.state)) p.inTransit += d.state === 'scheduled' ? dl.scheduled : dl.dispatched ?? dl.scheduled;
      else if (d.state === 'received') { p.received += dl.received ?? 0n; p.awaitingInspection += dl.received ?? 0n; }
      else if (INSPECTED_STATES.includes(d.state)) { p.received += dl.received ?? 0n; p.accepted += dl.accepted ?? 0n; p.rejected += dl.rejected ?? 0n; }
    }
  }
  for (const x of discrepancies) {
    const p = by.get(x.lineKey);
    if (!p || x.state !== 'resolved') continue;
    if (x.resolution === 'accept_as_is' && REJECT_KINDS.includes(x.kind)) { p.accepted += x.quantity; p.rejected = max0(p.rejected - x.quantity); }
    else if (x.resolution === 'credit' || (x.resolution === 'accept_as_is' && x.kind === 'shortage')) { if (x.kind !== 'excess') p.waived += x.quantity; }
  }
  for (const r of returns) {
    // A return of goods rejected at inspection (linked to a discrepancy) does not change what was kept.
    for (const rl of r.lines) {
      const p = by.get(rl.lineKey);
      if (!p) continue;
      if (OPEN_RETURNS.includes(r.state)) p.returnPending += rl.quantity;
      else if (r.state === 'collected' && !r.discrepancyId) { p.returned += rl.quantity; p.waived += rl.quantity; }
    }
  }
  for (const p of by.values()) {
    p.netAccepted = max0(p.accepted - p.returned);
    const required = max0(p.ordered - p.waived);
    p.outstanding = max0(required - p.netAccepted - p.awaitingInspection - p.inTransit);
    p.complete = !p.priced || (p.netAccepted >= required && p.awaitingInspection === 0n && p.inTransit === 0n);
  }
  const out = [...by.values()];
  return {
    lines: out,
    anyReceived: deliveries.some((d) => RECEIVED_STATES.includes(d.state)),
    complete: out.some((l) => l.priced) && out.every((l) => l.complete),
    openDeliveries: deliveries.filter((d) => IN_TRANSIT.includes(d.state)).length,
    awaitingInspection: deliveries.filter((d) => d.state === 'received').length,
    openDiscrepancies: discrepancies.filter((x) => x.state !== 'resolved').length,
    openReturns: returns.filter((r) => OPEN_RETURNS.includes(r.state)).length,
  };
}

/** The order command fulfilment calls for now, if any (system-driven `fulfil_part` / `fulfil`). */
export function fulfilmentCommand(state: OrderState, p: FulfilmentProgress): Extract<OrderCommand, 'fulfil' | 'fulfil_part'> | null {
  if (state !== 'confirmed' && state !== 'partially_fulfilled') return null;
  if (p.complete) return 'fulfil';
  if (p.anyReceived && state === 'confirmed') return 'fulfil_part';
  return null;
}

/** Orders that can take new deliveries. */
export const canScheduleDelivery = (state: OrderState) => state === 'confirmed' || state === 'partially_fulfilled';

const withTolerance = (q: bigint, pct: number) => q + divRound(q * BigInt(Math.round(pct * 1000)), 100_000n);
const qty = (q: bigint, unit: string) => `${formatDec(q, 3)} ${unit}`;

export interface QuantityInput { lineKey: string; quantity: bigint }

/** Problems with a booking: lines on the order, quantities within what is outstanding, a slot and a date in range. */
export function slotProblems(date: string, slot: string, today: string, cfg: FulfilmentConfig): string[] {
  const out: string[] = [];
  if (!cfg.deliverySlots.some((s) => s.code === slot)) out.push('Choose a delivery slot.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today) out.push('Choose a delivery date from today onwards.');
  else if (new Date(date).getTime() - new Date(today).getTime() > cfg.maxScheduleAheadDays * 86_400_000) out.push(`Book no more than ${cfg.maxScheduleAheadDays} days ahead.`);
  return out;
}

export function scheduleProblems(p: FulfilmentProgress, input: { date: string; slot: string; lines: QuantityInput[] }, today: string, cfg: FulfilmentConfig): string[] {
  const out: string[] = slotProblems(input.date, input.slot, today, cfg);
  const lines = input.lines.filter((l) => l.quantity > 0n);
  if (!lines.length) out.push('Book at least one line.');
  if (new Set(input.lines.map((l) => l.lineKey)).size !== input.lines.length) out.push('Each order line can appear once.');
  for (const l of lines) {
    const lp = p.lines.find((x) => x.lineKey === l.lineKey);
    if (!lp || !lp.priced) { out.push('A line is not on this order.'); continue; }
    if (l.quantity > withTolerance(lp.outstanding, cfg.overDeliveryTolerancePct)) out.push(`${lp.description}: only ${qty(lp.outstanding, lp.unit)} left to book.`);
  }
  return [...new Set(out)];
}

/** What the supplier loaded (the consignment). It may be less than booked; more than booked needs a new booking. */
export function dispatchProblems(lines: DeliveryLineRecord[], loaded: QuantityInput[], cfg: FulfilmentConfig, descriptions: Record<string, string> = {}): string[] {
  const out: string[] = [];
  for (const l of loaded) {
    const dl = lines.find((x) => x.lineKey === l.lineKey);
    if (!dl) { out.push('A line is not on this delivery.'); continue; }
    if (l.quantity < 0n) out.push('Quantities cannot be negative.');
    if (l.quantity > withTolerance(dl.scheduled, cfg.overDeliveryTolerancePct)) out.push(`${descriptions[l.lineKey] ?? 'A line'}: more than was booked. Book another delivery for the rest.`);
  }
  if (!loaded.some((l) => l.quantity > 0n)) out.push('Load at least one line, or cancel the delivery.');
  return [...new Set(out)];
}

export interface PodInput { receivedBy: string; receivedAt: string; lines: QuantityInput[] }
/** Proof of delivery: who received it, when, and how much of each line came off the vehicle. */
export function podProblems(lines: DeliveryLineRecord[], pod: PodInput, now: Date): string[] {
  const out: string[] = [];
  if (pod.receivedBy.trim().length < 2) out.push('Enter the name of the person who received the goods.');
  const at = new Date(pod.receivedAt);
  if (Number.isNaN(at.getTime())) out.push('Enter when the goods were received.');
  else if (at.getTime() > now.getTime() + 5 * 60_000) out.push('The receipt time cannot be in the future.');
  if (pod.lines.length !== lines.length || !lines.every((l) => pod.lines.some((x) => x.lineKey === l.lineKey))) out.push('Record a received quantity for every line on the delivery (0 if none arrived).');
  if (pod.lines.some((l) => l.quantity < 0n)) out.push('Quantities cannot be negative.');
  return [...new Set(out)];
}

export interface InspectionLineInput { lineKey: string; accepted: bigint; rejected: bigint; kind?: DiscrepancyKind | null; note?: string | null }
export interface InspectionOutcome {
  problems: string[];
  command: 'accept' | 'raise_discrepancy';
  lines: { lineKey: string; accepted: bigint; rejected: bigint }[];
  discrepancies: { lineKey: string; kind: DiscrepancyKind; quantity: bigint; note: string | null }[];
}

/**
 * Inspection splits each received quantity into accepted and rejected (with a reason). A line that arrived short
 * of what was loaded raises a shortage on its own. No discrepancies → `accept` (inspected OK).
 */
export function inspectionOutcome(lines: DeliveryLineRecord[], input: InspectionLineInput[], descriptions: Record<string, string> = {}): InspectionOutcome {
  const problems: string[] = [];
  const outLines: InspectionOutcome['lines'] = [];
  const discrepancies: InspectionOutcome['discrepancies'] = [];
  for (const dl of lines) {
    const name = descriptions[dl.lineKey] ?? 'A line';
    const received = dl.received ?? 0n;
    const i = input.find((x) => x.lineKey === dl.lineKey) ?? { lineKey: dl.lineKey, accepted: received, rejected: 0n };
    if (i.accepted < 0n || i.rejected < 0n) problems.push(`${name}: quantities cannot be negative.`);
    if (i.accepted + i.rejected !== received) problems.push(`${name}: accepted and rejected must add up to the ${formatDec(received, 3)} received.`);
    if (i.rejected > 0n) {
      if (!i.kind || i.kind === 'shortage') problems.push(`${name}: say why the rejected quantity was rejected.`);
      else discrepancies.push({ lineKey: dl.lineKey, kind: i.kind, quantity: i.rejected, note: i.note?.trim() || null });
    }
    const loaded = dl.dispatched ?? dl.scheduled;
    if (received < loaded) discrepancies.push({ lineKey: dl.lineKey, kind: 'shortage', quantity: loaded - received, note: `Loaded ${formatDec(loaded, 3)}, received ${formatDec(received, 3)}.` });
    outLines.push({ lineKey: dl.lineKey, accepted: i.accepted, rejected: i.rejected });
  }
  if (input.some((i) => !lines.some((l) => l.lineKey === i.lineKey))) problems.push('A line is not on this delivery.');
  return { problems: [...new Set(problems)], command: discrepancies.length ? 'raise_discrepancy' : 'accept', lines: outLines, discrepancies };
}

/** Return limits: rejected goods up to the discrepancy's quantity, kept goods up to what is kept and not already on a return. */
export function returnProblems(p: FulfilmentProgress, input: { lines: QuantityInput[]; discrepancy: DiscrepancyRecord | null; receivedAt: string | null }, now: Date, cfg: FulfilmentConfig): string[] {
  const out: string[] = [];
  const lines = input.lines.filter((l) => l.quantity > 0n);
  if (!lines.length) out.push('Return at least one line.');
  if (input.receivedAt && now.getTime() - new Date(input.receivedAt).getTime() > cfg.returnWindowDays * 86_400_000) out.push(`Returns can be requested up to ${cfg.returnWindowDays} days after receipt.`);
  for (const l of lines) {
    const lp = p.lines.find((x) => x.lineKey === l.lineKey);
    if (!lp) { out.push('A line is not on this order.'); continue; }
    if (input.discrepancy) {
      if (input.discrepancy.lineKey !== l.lineKey) out.push('A return for a discrepancy can only include that line.');
      else if (!REJECT_KINDS.includes(input.discrepancy.kind)) out.push('A shortage has nothing to send back.');
      else if (l.quantity > input.discrepancy.quantity) out.push(`${lp.description}: only ${qty(input.discrepancy.quantity, lp.unit)} was rejected.`);
    } else {
      const free = max0(lp.netAccepted - lp.returnPending);
      if (l.quantity > free) out.push(`${lp.description}: only ${qty(free, lp.unit)} kept and not already being returned.`);
    }
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- three-way match (§10.4 step 9)
export interface InvoiceLineInput {
  /** The order line billed; null for a charge that is not on the order. */
  lineKey: string | null;
  description: string;
  unit: string;
  /** Scaled decimal. */
  quantity: bigint;
  unitPriceMinor: bigint;
  taxRatePct: number;
}
export interface InvoiceInput { lines: InvoiceLineInput[]; deliveryMinor: bigint; deliveryTaxRatePct: number; statedTotalMinor: bigint }
export interface InvoiceTotals { linesMinor: bigint; deliveryMinor: bigint; taxMinor: bigint; grossMinor: bigint }

const taxOf = (amount: bigint, pct: number) => divRound(amount * BigInt(Math.round(pct * 10_000)), 1_000_000n);
const lineAmount = (q: bigint, price: bigint) => divRound(q * price, SCALE);

export function invoiceTotals(inv: Pick<InvoiceInput, 'lines' | 'deliveryMinor' | 'deliveryTaxRatePct'>): InvoiceTotals {
  let linesMinor = 0n; let tax = 0n;
  for (const l of inv.lines) { const a = lineAmount(l.quantity, l.unitPriceMinor); linesMinor += a; tax += taxOf(a, l.taxRatePct); }
  tax += taxOf(inv.deliveryMinor, inv.deliveryTaxRatePct);
  return { linesMinor, deliveryMinor: inv.deliveryMinor, taxMinor: tax, grossMinor: linesMinor + inv.deliveryMinor + tax };
}

export type VarianceKind = 'price' | 'quantity' | 'unit' | 'tax' | 'not_on_order' | 'delivery' | 'total';
export const VARIANCE_LABEL: Record<VarianceKind, string> = {
  price: 'Price differs from the order', quantity: 'Billed more than received and accepted', unit: 'Unit differs from the order', tax: 'Tax rate differs from the order',
  not_on_order: 'Not on the order', delivery: 'Delivery charge above the order', total: 'Stated total does not add up',
};
export interface Variance { kind: VarianceKind; lineKey: string | null; description: string; expected: string; invoiced: string; impactMinor: bigint; message: string }
export interface MatchLine {
  lineKey: string | null; description: string; unit: string;
  ordered: bigint;
  /** On proofs of delivery. */
  received: bigint;
  /** Inspected, accepted and kept: the most that may be billed in total. */
  accepted: bigint;
  awaitingInspection: bigint;
  previouslyInvoiced: bigint;
  invoiced: bigint;
  orderUnitPriceMinor: bigint | null;
  invoiceUnitPriceMinor: bigint;
  amountMinor: bigint;
  variances: VarianceKind[];
}
export interface ThreeWayMatch {
  status: 'matched' | 'variance';
  lines: MatchLine[];
  variances: Variance[];
  totals: InvoiceTotals;
  statedTotalMinor: bigint;
  /** What the billed quantities cost at the order's prices and tax rates, plus the delivery billed (capped at the order's). */
  expectedMinor: bigint;
  notes: string[];
}

export interface PriorInvoice { lines: { lineKey: string | null; quantity: bigint }[]; deliveryMinor: bigint }

/**
 * Supplier invoice ↔ order ↔ proof of delivery. Quantities are checked cumulatively against what was received,
 * inspected and kept (net of returns); prices, units and tax against the awarded terms; the delivery charge against
 * the order's; the supplier's stated total against the lines. Anything outside tolerance is a variance that needs an
 * authorised client approval. Billing less than received is fine (a part invoice).
 */
export function threeWayMatch(
  order: { lines: OrderLine[]; deliveryMinor: bigint; deliveryTaxRatePct: number },
  progress: FulfilmentProgress,
  invoice: InvoiceInput,
  prior: PriorInvoice[],
  cfg: FulfilmentConfig,
): ThreeWayMatch {
  const tol = cfg.match;
  const variances: Variance[] = [];
  const notes: string[] = [];
  const lines: MatchLine[] = [];
  let expected = 0n;
  const previously = (key: string) => prior.reduce((s, p) => s + p.lines.filter((l) => l.lineKey === key).reduce((a, l) => a + l.quantity, 0n), 0n);
  const seen = new Map<string, bigint>();
  for (const il of invoice.lines) {
    const ol = il.lineKey ? order.lines.find((x) => x.lineKey === il.lineKey && x.priced) : undefined;
    const amount = lineAmount(il.quantity, il.unitPriceMinor);
    if (!ol) {
      variances.push({ kind: 'not_on_order', lineKey: il.lineKey, description: il.description, expected: '—', invoiced: qty(il.quantity, il.unit), impactMinor: amount + taxOf(amount, il.taxRatePct), message: `${il.description}: not on the order.` });
      lines.push({ lineKey: il.lineKey, description: il.description, unit: il.unit, ordered: 0n, received: 0n, accepted: 0n, awaitingInspection: 0n, previouslyInvoiced: 0n, invoiced: il.quantity, orderUnitPriceMinor: null, invoiceUnitPriceMinor: il.unitPriceMinor, amountMinor: amount, variances: ['not_on_order'] });
      continue;
    }
    const lp = progress.lines.find((x) => x.lineKey === ol.lineKey)!;
    const kinds: VarianceKind[] = [];
    const before = previously(ol.lineKey) + (seen.get(ol.lineKey) ?? 0n);
    seen.set(ol.lineKey, (seen.get(ol.lineKey) ?? 0n) + il.quantity);
    if (il.unit !== ol.unit) {
      kinds.push('unit');
      variances.push({ kind: 'unit', lineKey: ol.lineKey, description: ol.description, expected: ol.unit, invoiced: il.unit, impactMinor: 0n, message: `${ol.description}: billed per ${il.unit}, ordered per ${ol.unit}.` });
    } else {
      const allowed = withTolerance(lp.netAccepted, tol.quantityTolerancePct);
      if (before + il.quantity > allowed) {
        const over = before + il.quantity - lp.netAccepted;
        kinds.push('quantity');
        variances.push({
          kind: 'quantity', lineKey: ol.lineKey, description: ol.description, expected: qty(max0(lp.netAccepted - before), ol.unit), invoiced: qty(il.quantity, il.unit),
          impactMinor: lineAmount(over < il.quantity ? over : il.quantity, il.unitPriceMinor),
          message: `${ol.description}: billed ${qty(before + il.quantity, ol.unit)} in total; ${qty(lp.netAccepted, ol.unit)} received, inspected and kept.`,
        });
      }
      const priceAllowed = withTolerance(ol.unitPriceMinor, tol.priceTolerancePct);
      if (il.unitPriceMinor > priceAllowed || il.unitPriceMinor < ol.unitPriceMinor - (priceAllowed - ol.unitPriceMinor)) {
        kinds.push('price');
        variances.push({
          kind: 'price', lineKey: ol.lineKey, description: ol.description, expected: String(ol.unitPriceMinor), invoiced: String(il.unitPriceMinor),
          impactMinor: lineAmount(il.quantity, il.unitPriceMinor - ol.unitPriceMinor), message: `${ol.description}: unit price differs from the awarded quote.`,
        });
      }
    }
    if (Math.abs(il.taxRatePct - ol.taxRatePct) > 1e-9) {
      kinds.push('tax');
      variances.push({ kind: 'tax', lineKey: ol.lineKey, description: ol.description, expected: `${ol.taxRatePct}%`, invoiced: `${il.taxRatePct}%`, impactMinor: taxOf(amount, il.taxRatePct) - taxOf(amount, ol.taxRatePct), message: `${ol.description}: tax rate ${il.taxRatePct}% on the invoice, ${ol.taxRatePct}% on the order.` });
    }
    const atOrder = lineAmount(il.quantity, ol.unitPriceMinor);
    expected += atOrder + taxOf(atOrder, ol.taxRatePct);
    if (lp.awaitingInspection > 0n) notes.push(`${ol.description}: ${qty(lp.awaitingInspection, ol.unit)} received but not inspected yet, so not billable yet.`);
    lines.push({
      lineKey: ol.lineKey, description: ol.description, unit: ol.unit, ordered: ol.quantity, received: lp.received, accepted: lp.netAccepted, awaitingInspection: lp.awaitingInspection,
      previouslyInvoiced: before, invoiced: il.quantity, orderUnitPriceMinor: ol.unitPriceMinor, invoiceUnitPriceMinor: il.unitPriceMinor, amountMinor: amount, variances: kinds,
    });
  }
  const deliveryBefore = prior.reduce((s, p) => s + p.deliveryMinor, 0n);
  const deliveryAllowed = max0(order.deliveryMinor - deliveryBefore);
  if (invoice.deliveryMinor > deliveryAllowed) {
    variances.push({ kind: 'delivery', lineKey: null, description: 'Delivery', expected: String(deliveryAllowed), invoiced: String(invoice.deliveryMinor), impactMinor: invoice.deliveryMinor - deliveryAllowed, message: 'The delivery charge is more than the order allows.' });
  }
  const billedDelivery = invoice.deliveryMinor < deliveryAllowed ? invoice.deliveryMinor : deliveryAllowed;
  expected += billedDelivery + taxOf(billedDelivery, order.deliveryTaxRatePct);
  const totals = invoiceTotals(invoice);
  const diff = invoice.statedTotalMinor - totals.grossMinor;
  if ((diff < 0n ? -diff : diff) > BigInt(tol.totalToleranceMinor)) {
    variances.push({ kind: 'total', lineKey: null, description: 'Invoice total', expected: String(totals.grossMinor), invoiced: String(invoice.statedTotalMinor), impactMinor: diff, message: 'The total on the invoice does not equal its lines, delivery and tax.' });
  }
  return { status: variances.length ? 'variance' : 'matched', lines, variances, totals, statedTotalMinor: invoice.statedTotalMinor, expectedMinor: expected, notes: [...new Set(notes)] };
}

/** The invoice command a (re)match calls for, if any. */
export function matchCommand(state: InvoiceState, m: Pick<ThreeWayMatch, 'status'>): Extract<InvoiceCommand, 'match' | 'flag'> | null {
  if (m.status === 'matched' && invoiceMachine.can(state, 'match')) return 'match';
  if (m.status === 'variance' && invoiceMachine.can(state, 'flag')) return 'flag';
  return null;
}

export function invoiceProblems(inv: InvoiceInput & { number: string; issuedOn: string }, today: string): string[] {
  const out: string[] = [];
  if (inv.number.trim().length < 1) out.push('Enter the invoice number.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inv.issuedOn) || inv.issuedOn > today) out.push('The invoice date cannot be in the future.');
  if (!inv.lines.length) out.push('Bill at least one line.');
  for (const l of inv.lines) {
    if (l.quantity <= 0n) out.push(`${l.description || 'A line'}: enter a quantity.`);
    if (l.unitPriceMinor < 0n) out.push(`${l.description || 'A line'}: the unit price cannot be negative.`);
  }
  if (inv.statedTotalMinor <= 0n) out.push('Enter the invoice total.');
  return [...new Set(out)];
}

// ---------------------------------------------------------------- record-only payment and closing (§14.1)
export function paymentPosition(invoices: { state: InvoiceState; grossMinor: bigint }[], paidMinor: bigint) {
  const payable = invoices.filter((i) => PAYABLE_INVOICE_STATES.includes(i.state)).reduce((s, i) => s + i.grossMinor, 0n);
  const pending = invoices.filter((i) => i.state === 'awaiting_approval' || i.state === 'submitted').reduce((s, i) => s + i.grossMinor, 0n);
  return { payableMinor: payable, pendingApprovalMinor: pending, recordedPaidMinor: paidMinor, balanceMinor: payable - paidMinor };
}

/** What stops the client closing a fulfilled order, and what they should know before they do. */
export function closeBlockers(state: OrderState, p: FulfilmentProgress, invoices: { state: InvoiceState }[]): { blockers: string[]; warnings: string[] } {
  const blockers: string[] = [];
  const warnings: string[] = [];
  if (state !== 'fulfilled') blockers.push(state === 'disputed' ? 'Resume the order before closing it.' : 'Close the order once everything is delivered, inspected and settled.');
  if (p.openDeliveries) blockers.push(`${p.openDeliveries} deliver${p.openDeliveries === 1 ? 'y is' : 'ies are'} still booked or on the way.`);
  if (p.awaitingInspection) blockers.push(`${p.awaitingInspection} deliver${p.awaitingInspection === 1 ? 'y is' : 'ies are'} received but not inspected.`);
  if (p.openDiscrepancies) blockers.push(`${p.openDiscrepancies} discrepanc${p.openDiscrepancies === 1 ? 'y is' : 'ies are'} not resolved.`);
  if (p.openReturns) blockers.push(`${p.openReturns} return${p.openReturns === 1 ? ' is' : 's are'} still open.`);
  const waiting = invoices.filter((i) => i.state === 'awaiting_approval' || i.state === 'submitted').length;
  if (waiting) blockers.push(`${waiting} invoice${waiting === 1 ? ' has' : 's have'} a variance waiting for approval.`);
  if (!invoices.some((i) => PAYABLE_INVOICE_STATES.includes(i.state))) warnings.push('The supplier has not sent a matched invoice yet.');
  return { blockers, warnings };
}

/** Plain statement shown wherever a delivery is received. */
export const RECEIPT_NOTICE = 'Recording a delivery confirms what arrived, not that it is acceptable. Inspect the goods to accept them or raise a discrepancy.';
