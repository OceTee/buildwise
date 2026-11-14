import { defineMachine } from './core';
import { divRound, formatDec, parseDec, pctOf, SCALE } from './decimal';
import type { ProjectConfig } from './projects';
import { isKnownUnit } from './units';

/** Estimation (spec §9.1, §10.3, §11.1, §11.3, §11.6; MVP §5). */

// ---------------------------------------------------------------- maturity and labels (§11.1)
export const MATURITY = {
  indicative: { label: 'Indicative range', notice: 'Not a bill of quantities or a supplier quote.', canFeedRfq: false },
  client_specified: { label: 'Client-specified scope', notice: 'Client-specified scope — not platform-reviewed.', canFeedRfq: true },
  draft_takeoff: { label: 'Draft takeoff', notice: 'Requires review.', canFeedRfq: false },
  reviewed_cost_plan: { label: 'Professionally reviewed', notice: 'A named, qualified reviewer checked the stated scope and basis.', canFeedRfq: true },
} as const;
export type Maturity = keyof typeof MATURITY;

// ---------------------------------------------------------------- reviewed estimate version lifecycle (§9.1)
export const ESTIMATE_STATES = ['draft', 'submitted', 'under_review', 'information_required', 'changes_requested', 'reviewed', 'issued', 'accepted', 'expired', 'superseded', 'withdrawn'] as const;
export type EstimateState = (typeof ESTIMATE_STATES)[number];
export type EstimateCommand = 'submit' | 'assign' | 'request_information' | 'request_changes' | 'resume' | 'complete_review' | 'issue' | 'accept' | 'expire' | 'supersede' | 'withdraw';

export const estimateMachine = defineMachine<EstimateState, EstimateCommand>('EstimateVersion', ESTIMATE_STATES, [
  { from: ['draft'], command: 'submit', to: 'submitted' },
  { from: ['submitted'], command: 'assign', to: 'under_review' },
  { from: ['under_review'], command: 'request_information', to: 'information_required' },
  { from: ['under_review'], command: 'request_changes', to: 'changes_requested' },
  { from: ['information_required', 'changes_requested'], command: 'resume', to: 'under_review' },
  { from: ['under_review'], command: 'complete_review', to: 'reviewed' },
  { from: ['reviewed'], command: 'issue', to: 'issued' },
  { from: ['issued'], command: 'accept', to: 'accepted' },
  { from: ['issued'], command: 'expire', to: 'expired' },
  { from: ['issued', 'accepted', 'expired'], command: 'supersede', to: 'superseded' },
  { from: ['draft', 'submitted', 'under_review', 'information_required', 'changes_requested', 'reviewed', 'issued'], command: 'withdraw', to: 'withdrawn' },
]);
/** Who may run each command: the client side or the assigned reviewer. */
export const ESTIMATE_ACTOR: Record<EstimateCommand, 'client' | 'reviewer' | 'system'> = {
  submit: 'client', assign: 'system', request_information: 'reviewer', request_changes: 'reviewer', resume: 'reviewer',
  complete_review: 'reviewer', issue: 'reviewer', accept: 'client', expire: 'system', supersede: 'system', withdraw: 'client',
};

// ---------------------------------------------------------------- lines and arithmetic (§8.4, §8.5)
export const RATE_COMPONENTS = ['labour', 'material', 'plant', 'logistics', 'other'] as const;
export type RateComponent = (typeof RATE_COMPONENTS)[number];

export const SOURCE_CLASSES = ['supplier_confirmed_quote', 'recent_marketplace_offer', 'historical_project_actual', 'professional_rate_book', 'published_dataset', 'advertised_listing_price', 'modelled_benchmark', 'manual_estimate'] as const;
export type SourceClass = (typeof SOURCE_CLASSES)[number];
export const SOURCE_LABELS: Record<SourceClass, string> = {
  supplier_confirmed_quote: 'Supplier-confirmed quote', recent_marketplace_offer: 'Recent marketplace offer', historical_project_actual: 'Historical project actual',
  professional_rate_book: 'Professional rate book', published_dataset: 'Published dataset', advertised_listing_price: 'Advertised listing price',
  modelled_benchmark: 'Modelled benchmark', manual_estimate: 'Manual estimate',
};

export type QuantitySource = 'measurement' | 'client_entered' | 'imported' | 'provisional_sum';
export type LineStatus = 'measured' | 'provisional' | 'excluded' | 'clarification_required';

export interface LineInput {
  id: string;
  section: string;
  description: string;
  specification?: string | null;
  unit: string;
  /** Scaled decimals (×10^6). */
  gross: bigint; deductions: bigint; wastePct: number;
  /** Unit rate by component, in minor units (may be fractional minor → scaled decimal). */
  rates: Partial<Record<RateComponent, bigint>>;
  taxRatePct: number;
  status: LineStatus;
  quantitySource: QuantitySource | null;
  measurementIds: string[];
  rate?: { sourceClass: SourceClass; reference: string; observedAt: string; validUntil: string | null; reconfirmedAt?: string | null } | null;
}

export interface LineCalc { net: bigint; waste: bigint; unitRate: bigint; amountMinor: bigint; taxMinor: bigint }

export const CALCULATION_VERSION = 'calc-2026.1';

/** Line amount at full precision, rounded once to minor units (§8.4). Excluded lines are zero. */
export function calcLine(l: LineInput): LineCalc {
  const base = l.gross - l.deductions;
  const waste = pctOf(base < 0n ? 0n : base, l.wastePct);
  const net = (base < 0n ? 0n : base) + waste;
  const unitRate = RATE_COMPONENTS.reduce((s, k) => s + (l.rates[k] ?? 0n), 0n); // scaled minor per unit
  if (l.status === 'excluded') return { net, waste, unitRate, amountMinor: 0n, taxMinor: 0n };
  const amountMinor = divRound(net * unitRate, SCALE * SCALE);
  const taxMinor = divRound(amountMinor * BigInt(Math.round(l.taxRatePct * 10_000)), 1_000_000n);
  return { net, waste, unitRate, amountMinor, taxMinor };
}

export interface Totals { netMinor: bigint; contingencyMinor: bigint; taxMinor: bigint; grossMinor: bigint; bySection: Record<string, bigint>; calculationVersion: string }

/** Totals are the sum of rounded lines; contingency is its own component and is never blended into lines. */
export function totals(lines: LineInput[], contingencyPct: number): Totals {
  let net = 0n; let tax = 0n;
  const bySection: Record<string, bigint> = {};
  for (const l of lines) {
    const c = calcLine(l);
    net += c.amountMinor; tax += c.taxMinor;
    bySection[l.section] = (bySection[l.section] ?? 0n) + c.amountMinor;
  }
  const contingency = divRound(net * BigInt(Math.round(contingencyPct * 10_000)), 1_000_000n);
  return { netMinor: net, contingencyMinor: contingency, taxMinor: tax, grossMinor: net + contingency + tax, bySection, calculationVersion: CALCULATION_VERSION };
}

// ---------------------------------------------------------------- rates (§11.3)
export interface RateObservation {
  id: string; catalogItemId: string; regionCode: string; unit: string; sourceClass: SourceClass;
  rateMinor: bigint; observedAt: string; validUntil: string | null; rateCategory: 'volatile' | 'general' | 'labour';
  includesDelivery: boolean; includesTax: boolean; reference: string;
}

export function rateExpiry(o: Pick<RateObservation, 'observedAt' | 'validUntil' | 'rateCategory'>, cfg: Pick<ProjectConfig, 'rateFreshnessDays'>): Date {
  const fresh = new Date(new Date(o.observedAt).getTime() + cfg.rateFreshnessDays[o.rateCategory] * 86_400_000);
  if (!o.validUntil) return fresh;
  const v = new Date(o.validUntil);
  return v < fresh ? v : fresh;
}

/**
 * The best valid rate for an item, region and unit: highest source class first, then the newest. A lower class
 * never outranks a valid higher one; expired observations are only returned as `stale` alternatives.
 */
export function pickRate(obs: RateObservation[], q: { catalogItemId: string; regionCode: string; unit: string }, now: Date, cfg: Pick<ProjectConfig, 'rateFreshnessDays'>): { best: RateObservation | null; stale: RateObservation[] } {
  const match = obs.filter((o) => o.catalogItemId === q.catalogItemId && o.regionCode === q.regionCode && o.unit === q.unit);
  const valid = match.filter((o) => rateExpiry(o, cfg) > now);
  const rank = (o: RateObservation) => SOURCE_CLASSES.indexOf(o.sourceClass);
  valid.sort((a, b) => rank(a) - rank(b) || new Date(b.observedAt).getTime() - new Date(a.observedAt).getTime());
  return { best: valid[0] ?? null, stale: match.filter((o) => !valid.includes(o)) };
}

export function rateIsStale(rate: LineInput['rate'], category: 'volatile' | 'general' | 'labour', now: Date, cfg: Pick<ProjectConfig, 'rateFreshnessDays'>): boolean {
  if (!rate) return false;
  const basis = rate.reconfirmedAt ?? rate.observedAt;
  return rateExpiry({ observedAt: basis, validUntil: rate.reconfirmedAt ? null : rate.validUntil, rateCategory: category }, cfg) <= now;
}

// ---------------------------------------------------------------- QA (§11.6)
/** `key` identifies one finding (code plus line or subject) so each warning is acknowledged separately. */
export interface QaFinding { key: string; code: string; severity: 'warning' | 'blocker'; lineId: string | null; message: string }
export interface QaContext {
  lines: (LineInput & { rateCategory: 'volatile' | 'general' | 'labour' })[];
  contingencyPct: number;
  assumptions: string[]; exclusions: string[];
  /** Measurement ids whose document revision has been superseded. */
  supersededMeasurementIds: Set<string>;
  previousGrossMinor: bigint | null; changeReason: string | null;
  requiredSections: string[];
  secondReviewDone: boolean;
  now: Date;
  cfg: Pick<ProjectConfig, 'rateFreshnessDays' | 'review'>;
}

export function runQa(c: QaContext): QaFinding[] {
  const f: QaFinding[] = [];
  const add = (code: string, severity: 'warning' | 'blocker', lineId: string | null, message: string, subject?: string) => f.push({ key: `${code}:${lineId ?? subject ?? '-'}`, code, severity, lineId, message });
  const priced = c.lines.filter((l) => l.status !== 'excluded');
  if (!c.lines.length) add('no_lines', 'blocker', null, 'The estimate has no lines.');
  const seen = new Map<string, string>();
  for (const l of c.lines) {
    if (!isKnownUnit(l.unit)) add('unit_invalid', 'blocker', l.id, `Unknown unit "${l.unit}".`);
    if (l.status !== 'excluded' && !l.quantitySource) add('quantity_source_missing', 'blocker', l.id, 'This line has no quantity source.');
    if (l.quantitySource === 'measurement' && !l.measurementIds.length) add('measurement_missing', 'blocker', l.id, 'This line says it is measured but has no measurements.');
    if (l.measurementIds.some((m) => c.supersededMeasurementIds.has(m))) add('superseded_revision', 'blocker', l.id, 'A measurement is on a drawing revision that has been superseded. Re-measure or confirm it on the new revision.');
    if (l.status !== 'excluded' && l.status !== 'clarification_required' && !l.rate) add('rate_source_missing', 'blocker', l.id, 'This line has no rate source.');
    if (l.rate && rateIsStale(l.rate, l.rateCategory, c.now, c.cfg)) add('rate_stale', 'blocker', l.id, 'The rate is past its freshness window. Reconfirm it or use a current rate.');
    if (l.status === 'clarification_required') add('clarification_open', 'blocker', l.id, 'A line still needs clarification. Resolve it, mark it provisional or exclude it.');
    if (l.gross < l.deductions) add('negative_quantity', 'blocker', l.id, 'Deductions are larger than the gross quantity.');
    const key = `${l.section}|${l.description.trim().toLowerCase()}|${l.unit}|${l.specification ?? ''}`;
    if (seen.has(key)) add('duplicate_line', 'warning', l.id, 'This looks like a duplicate of another line.');
    else seen.set(key, l.id);
    if (l.status !== 'excluded' && calcLine(l).unitRate === 0n && l.rate) add('zero_rate', 'warning', l.id, 'The rate is zero.');
  }
  for (const s of c.requiredSections) if (!c.lines.some((l) => l.section === s)) add('section_missing', 'warning', null, `No lines in the "${s}" work section. Add them, or record it as an exclusion.`, s);
  if (c.contingencyPct < c.cfg.review.minContingencyPct) add('contingency_low', 'warning', null, `Contingency is below ${c.cfg.review.minContingencyPct}%.`);
  if (!c.exclusions.length) add('exclusions_missing', 'warning', null, 'No exclusions are recorded.');
  if (!c.assumptions.length) add('assumptions_missing', 'warning', null, 'No assumptions are recorded (for example site access, logistics, taxes).');
  const t = totals(priced, c.contingencyPct);
  if (c.previousGrossMinor && c.previousGrossMinor > 0n && !c.changeReason) {
    const delta = Number((t.grossMinor - c.previousGrossMinor) * 10_000n / c.previousGrossMinor) / 100;
    if (Math.abs(delta) > c.cfg.review.largeDeltaPct) add('large_delta', 'warning', null, `The total changed by ${delta.toFixed(1)}% from the previous version. Record the reason.`);
  }
  if (t.grossMinor > BigInt(c.cfg.review.secondReviewAboveMinor) && !c.secondReviewDone) add('second_review_required', 'blocker', null, 'This estimate is above the value that needs a second reviewer.');
  return f;
}

// ---------------------------------------------------------------- version delta (§10.3 step 7)
export interface DeltaRow { key: string; description: string; change: 'added' | 'removed' | 'changed'; before: { qty: string; rate: string; amountMinor: string } | null; after: { qty: string; rate: string; amountMinor: string } | null; reasons: string[] }

/** Line-by-line change summary between two versions, matched by a stable line key carried across versions. */
export function versionDelta(prev: (LineInput & { key: string })[], next: (LineInput & { key: string })[]): { rows: DeltaRow[]; beforeMinor: bigint; afterMinor: bigint } {
  const view = (l: LineInput) => { const c = calcLine(l); return { qty: formatDec(c.net, 3), rate: formatDec(c.unitRate, 2), amountMinor: String(c.amountMinor) }; };
  const pm = new Map(prev.map((l) => [l.key, l]));
  const nm = new Map(next.map((l) => [l.key, l]));
  const rows: DeltaRow[] = [];
  for (const l of next) {
    const p = pm.get(l.key);
    if (!p) { rows.push({ key: l.key, description: l.description, change: 'added', before: null, after: view(l), reasons: [] }); continue; }
    const a = view(p); const b = view(l);
    const reasons: string[] = [];
    if (a.qty !== b.qty) reasons.push('quantity');
    if (a.rate !== b.rate) reasons.push('rate');
    if (p.status !== l.status) reasons.push(`status: ${p.status} → ${l.status}`);
    if ((p.specification ?? '') !== (l.specification ?? '')) reasons.push('specification');
    if (p.unit !== l.unit) reasons.push('unit');
    if (reasons.length) rows.push({ key: l.key, description: l.description, change: 'changed', before: a, after: b, reasons });
  }
  for (const p of prev) if (!nm.has(p.key)) rows.push({ key: p.key, description: p.description, change: 'removed', before: view(p), after: null, reasons: [] });
  const sum = (ls: LineInput[]) => ls.reduce((s, l) => s + calcLine(l).amountMinor, 0n);
  return { rows, beforeMinor: sum(prev), afterMinor: sum(next) };
}

// ---------------------------------------------------------------- quantity list import (§12.1)
const UNIT_ALIASES: Record<string, string> = {
  'm²': 'm2', sqm: 'm2', 'sq m': 'm2', 'sq.m': 'm2', m2: 'm2', 'm³': 'm3', cum: 'm3', 'cu m': 'm3', m3: 'm3',
  lm: 'm', 'lin m': 'm', metre: 'm', metres: 'm', meter: 'm', meters: 'm', m: 'm',
  nr: 'piece', no: 'piece', 'no.': 'piece', pcs: 'piece', pc: 'piece', each: 'piece', ea: 'piece', piece: 'piece', pieces: 'piece',
  kg: 'kg', t: 'tonne', ton: 'tonne', tons: 'tonne', tonne: 'tonne', tonnes: 'tonne', bag: 'bag', bags: 'bag', trip: 'trip', trips: 'trip',
  l: 'litre', litre: 'litre', litres: 'litre', item: 'job', sum: 'job', ls: 'job', 'l.s.': 'job', job: 'job', day: 'day', days: 'day', hr: 'hour', hour: 'hour', hours: 'hour',
};
export const normalizeUnit = (u: string) => { const k = u.trim().toLowerCase(); const v = UNIT_ALIASES[k] ?? k; return isKnownUnit(v) ? v : null; };

function splitCsvLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export interface ImportedRow { row: number; section: string; description: string; specification: string | null; quantity: bigint; unit: string; originalUnit: string; notes: string | null }

/**
 * Parses a quantity list (CSV with a header row). Recognised headers: description, quantity/qty, unit,
 * section, specification/spec, notes. The original unit is kept beside the normalized one (§8.5).
 */
export function parseQuantityCsv(text: string, defaultSection: string, maxRows = 2000): { rows: ImportedRow[]; errors: { row: number; message: string }[] } {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const errors: { row: number; message: string }[] = [];
  if (!lines.length) return { rows: [], errors: [{ row: 0, message: 'The file is empty.' }] };
  const header = splitCsvLine(lines[0]!).map((h) => h.toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const ci = { d: col('description', 'item', 'item description'), q: col('quantity', 'qty'), u: col('unit', 'units', 'uom'), s: col('section', 'work section', 'trade'), sp: col('specification', 'spec'), n: col('notes', 'note', 'remarks') };
  if (ci.d < 0 || ci.q < 0 || ci.u < 0) return { rows: [], errors: [{ row: 1, message: 'The first row must name the columns, including description, quantity and unit.' }] };
  const rows: ImportedRow[] = [];
  for (let i = 1; i < lines.length && rows.length < maxRows; i++) {
    const c = splitCsvLine(lines[i]!);
    const description = c[ci.d] ?? '';
    const qty = parseDec(c[ci.q] ?? '');
    const unitRaw = c[ci.u] ?? '';
    const unit = normalizeUnit(unitRaw);
    if (!description) { errors.push({ row: i + 1, message: 'Description is empty.' }); continue; }
    if (qty == null || qty < 0n) { errors.push({ row: i + 1, message: `Quantity "${c[ci.q] ?? ''}" is not a number.` }); continue; }
    if (!unit) { errors.push({ row: i + 1, message: `Unit "${unitRaw}" is not recognised.` }); continue; }
    rows.push({ row: i + 1, section: (ci.s >= 0 && c[ci.s]) || defaultSection, description: description.slice(0, 300), specification: ci.sp >= 0 ? c[ci.sp] || null : null, quantity: qty, unit, originalUnit: unitRaw, notes: ci.n >= 0 ? c[ci.n] || null : null });
  }
  if (lines.length - 1 > maxRows) errors.push({ row: maxRows + 2, message: `Only the first ${maxRows} rows were imported.` });
  return { rows, errors };
}

// ---------------------------------------------------------------- snapshots (§8.6)
/** Canonical JSON (sorted keys, bigint as string) so a snapshot hash is stable. */
export function canonicalJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object') return `{${Object.keys(v as object).sort().filter((k) => (v as Record<string, unknown>)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

