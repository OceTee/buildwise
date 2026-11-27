import { defineMachine } from './core';
import { divRound, formatDec, SCALE } from './decimal';
import { calcLine, MATURITY, type LineInput, type Maturity } from './estimates';
import type { ListingType } from './market';
import { comparablePrice, UNITS, type PackSize } from './units';
import { deliveryRecordScore, type PerformanceSummary } from './performance';

/**
 * Structured procurement, first slice of Release 3 (spec §3.17, §9.2–§9.4, §10.4 steps 1–7, §13.1, §13.5, §14.1).
 * Pure rules: RFQ / quote version / invitation / order state machines, RFQ lines from estimates, quote totals,
 * normalised comparison and provider matching. Values come from `ProcurementConfig` in the market pack.
 */

// ---------------------------------------------------------------- configuration (market pack, [Proposed])
export type RfqType = 'material' | 'trade' | 'service' | 'logistics';
export const RFQ_TYPES: readonly RfqType[] = ['material', 'trade', 'service', 'logistics'];
/** Who is asked to quote (§10.4 step 2): every eligible provider, chosen eligible providers, the client's approved (framework) suppliers, or suppliers the client names. */
export type SourcingMode = 'open' | 'invited' | 'framework' | 'nominated';
export const SOURCING_MODES: readonly SourcingMode[] = ['open', 'invited', 'framework', 'nominated'];
export type CheckType = 'identity_contact' | 'business_registration' | 'professional_credential' | 'trade_reference' | 'stock_evidence';

export interface RankingWeights { specFit: number; responseReliability: number; verifiedHistory: number; deliveryRecord: number; distance: number; priceHistory: number }

export interface ProcurementConfig {
  /** Fewer eligible providers than this and the client is offered operations-assisted sourcing (§13.1.6). */
  targetEligibleProviders: number;
  /** Checks a provider must hold, passed and unexpired at the RFQ deadline, by RFQ type (§13.1.1). */
  requiredChecks: Record<RfqType, CheckType[]>;
  /** A provider serves an area it lists in, names as a service area, or lies within this radius of (km). */
  serviceRadiusKm: number;
  /** Soft ranking weights (sum to 1). Fee and commission data are never inputs (§13.5). */
  rankingWeights: RankingWeights;
  /** Distance at which the distance factor reaches zero. */
  distanceZeroKm: number;
  /** Quotes are sealed until the deadline by default for invited RFQs and open for open RFQs (D-14). */
  sealedByDefault: Record<SourcingMode, boolean>;
  minResponseDays: number;
  maxResponseDays: number;
  defaultQuoteValidityDays: number;
  /** Most providers one RFQ may invite. */
  maxInvitations: number;
  /** Block an award when the provider no longer passes the hard eligibility checks (§22 scenario). */
  blockAwardIfIneligible: boolean;
}

export const DEFAULT_PROCUREMENT_CONFIG: ProcurementConfig = {
  targetEligibleProviders: 3,
  requiredChecks: { material: ['business_registration'], logistics: ['business_registration'], trade: [], service: [] },
  serviceRadiusKm: 10,
  rankingWeights: { specFit: 0.3, responseReliability: 0.2, verifiedHistory: 0.15, deliveryRecord: 0.15, distance: 0.12, priceHistory: 0.08 },
  distanceZeroKm: 40,
  sealedByDefault: { open: false, invited: true, framework: true, nominated: true },
  minResponseDays: 1,
  maxResponseDays: 60,
  defaultQuoteValidityDays: 14,
  maxInvitations: 12,
  blockAwardIfIneligible: true,
};

/** The RFQ type a marketplace category feeds (§3.17: product and hire listings become catalog listings for sourcing). */
export function rfqTypeFor(categorySlug: string, listingType: ListingType): RfqType {
  if (categorySlug === 'logistics') return 'logistics';
  if (listingType === 'product') return 'material';
  if (listingType === 'service') return 'trade';
  return 'service';
}

// ---------------------------------------------------------------- state machines (§9.2, §9.3, §9.4)
export const RFQ_STATES = ['draft', 'published', 'closed', 'awarded', 'cancelled', 'no_award'] as const;
export type RfqState = (typeof RFQ_STATES)[number];
export type RfqCommand = 'publish' | 'revise' | 'close' | 'award' | 'cancel' | 'no_award';

export const rfqMachine = defineMachine<RfqState, RfqCommand>('Rfq', RFQ_STATES, [
  { from: ['draft'], command: 'publish', to: 'published' },
  // Changing a published RFQ creates an RfqVersion; the state stays published (§9.2).
  { from: ['published'], command: 'revise', to: 'published' },
  { from: ['published'], command: 'close', to: 'closed' },
  { from: ['closed'], command: 'award', to: 'awarded' },
  { from: ['closed'], command: 'no_award', to: 'no_award' },
  { from: ['draft', 'published', 'closed'], command: 'cancel', to: 'cancelled' },
]);
export const RFQ_ACTOR: Record<RfqCommand, 'client' | 'client_or_system'> = {
  publish: 'client', revise: 'client', close: 'client_or_system', award: 'client', cancel: 'client', no_award: 'client',
};

/**
 * One quote version. Submitted versions are immutable; negotiation or an RFQ change produces a new version, and
 * the one it replaces becomes `revised` (§9.3). `needs_revision` marks a version answering an older RFQ version.
 */
export const QUOTE_STATES = ['draft', 'submitted', 'needs_revision', 'revised', 'withdrawn', 'expired', 'rejected', 'accepted'] as const;
export type QuoteState = (typeof QUOTE_STATES)[number];
export type QuoteCommand = 'submit' | 'request_revision' | 'replace' | 'withdraw' | 'expire' | 'reject' | 'accept';

export const quoteMachine = defineMachine<QuoteState, QuoteCommand>('QuoteVersion', QUOTE_STATES, [
  { from: ['draft'], command: 'submit', to: 'submitted' },
  { from: ['submitted'], command: 'request_revision', to: 'needs_revision' },
  { from: ['submitted', 'needs_revision'], command: 'replace', to: 'revised' },
  { from: ['draft', 'submitted', 'needs_revision'], command: 'withdraw', to: 'withdrawn' },
  { from: ['submitted', 'needs_revision'], command: 'expire', to: 'expired' },
  { from: ['submitted', 'needs_revision'], command: 'reject', to: 'rejected' },
  { from: ['submitted'], command: 'accept', to: 'accepted' },
]);
export const QUOTE_ACTOR: Record<QuoteCommand, 'provider' | 'client' | 'system'> = {
  submit: 'provider', request_revision: 'system', replace: 'system', withdraw: 'provider', expire: 'system', reject: 'client', accept: 'client',
};
/** Versions that still count as the provider's live answer (shown in the comparison). */
export const LIVE_QUOTE_STATES: readonly QuoteState[] = ['submitted', 'needs_revision'];

export const INVITATION_STATES = ['invited', 'viewed', 'quoted', 'declined', 'revoked'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];
export const invitationMachine = defineMachine<InvitationState, 'view' | 'quote' | 'decline' | 'revoke'>('Invitation', INVITATION_STATES, [
  { from: ['invited'], command: 'view', to: 'viewed' },
  { from: ['invited', 'viewed', 'quoted'], command: 'quote', to: 'quoted' },
  { from: ['invited', 'viewed'], command: 'decline', to: 'declined' },
  { from: ['invited', 'viewed', 'quoted', 'declined'], command: 'revoke', to: 'revoked' },
]);

export const ORDER_STATES = ['placed', 'confirmed', 'partially_fulfilled', 'fulfilled', 'closed', 'cancelled', 'disputed'] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export type OrderCommand = 'confirm' | 'fulfil_part' | 'fulfil' | 'close' | 'cancel' | 'dispute' | 'resume';
export const orderMachine = defineMachine<OrderState, OrderCommand>('Order', ORDER_STATES, [
  { from: ['placed'], command: 'confirm', to: 'confirmed' },
  { from: ['confirmed', 'partially_fulfilled'], command: 'fulfil_part', to: 'partially_fulfilled' },
  { from: ['confirmed', 'partially_fulfilled'], command: 'fulfil', to: 'fulfilled' },
  { from: ['fulfilled'], command: 'close', to: 'closed' },
  { from: ['placed', 'confirmed'], command: 'cancel', to: 'cancelled' },
  { from: ['confirmed', 'partially_fulfilled', 'fulfilled'], command: 'dispute', to: 'disputed' },
  // Settling a dispute returns the order to confirmed; fulfilment then catches up from its deliveries (fulfilment.ts).
  { from: ['disputed'], command: 'resume', to: 'confirmed' },
]);
/**
 * Who runs each order command. `fulfil_part` and `fulfil` follow deliveries, inspections and returns (system,
 * `fulfilmentCommand`); the client closes a fulfilled order once nothing is open (`closeBlockers`).
 */
export const ORDER_ACTOR: Record<OrderCommand, 'provider' | 'client' | 'either' | 'system'> = {
  confirm: 'provider', cancel: 'either', dispute: 'either', fulfil_part: 'system', fulfil: 'system', close: 'client', resume: 'client',
};

// ---------------------------------------------------------------- RFQ lines from estimates (§10.4 step 1, §11.1)
export type ScopeSource = 'reviewed_estimate' | 'client_specified' | 'quote_request';
export interface RfqLineProvenance {
  source: ScopeSource;
  maturity: Maturity | null;
  label: string;
  notice: string;
  estimateId: string | null;
  estimateVersionId: string | null;
  estimateVersionNumber: number | null;
  estimateLineId: string | null;
  snapshotHash: string | null;
}
export interface RfqLine {
  lineKey: string;
  position: number;
  section: string;
  description: string;
  specification: string | null;
  unit: string;
  /** Scaled decimal (×10^6). */
  quantity: bigint;
  pack: PackSize | null;
  provenance: RfqLineProvenance;
}

/** Frozen estimate states that may feed an RFQ: a shared client list, an issued or accepted reviewed plan. */
const FEEDING_STATES: Partial<Record<Maturity, string[]>> = { client_specified: ['shared'], reviewed_cost_plan: ['issued', 'accepted'] };

export function estimateCanFeedRfq(maturity: Maturity, state: string): { ok: true } | { ok: false; reason: string } {
  const m = MATURITY[maturity];
  if (!m?.canFeedRfq) return { ok: false, reason: `${m?.label ?? maturity} estimates can't be used to request quotes. Use a professionally reviewed or client-specified estimate.` };
  if (!FEEDING_STATES[maturity]?.includes(state)) {
    return { ok: false, reason: maturity === 'client_specified' ? 'Share the client-specified estimate first; that freezes its lines.' : 'Only an issued or accepted reviewed estimate can be used.' };
  }
  return { ok: true };
}

export interface EstimateSource {
  estimateId: string; versionId: string; versionNumber: number; maturity: Maturity; state: string; snapshotHash: string | null;
  lines: (LineInput & { key: string; position: number })[];
}

/**
 * RFQ lines copied from a frozen estimate version, each carrying its provenance and the maturity label (§11.1:
 * "Client-specified scope — not platform-reviewed" stays on the RFQ and the comparison). Excluded lines are left out.
 */
export function rfqLinesFromEstimate(src: EstimateSource, pick?: string[]): { ok: true; lines: RfqLine[] } | { ok: false; reason: string } {
  const gate = estimateCanFeedRfq(src.maturity, src.state);
  if (!gate.ok) return gate;
  const m = MATURITY[src.maturity];
  const chosen = src.lines.filter((l) => l.status !== 'excluded' && (!pick || pick.includes(l.id))).sort((a, b) => a.position - b.position);
  if (!chosen.length) return { ok: false, reason: 'Choose at least one estimate line that is not excluded.' };
  return {
    ok: true,
    lines: chosen.map((l, i) => ({
      lineKey: l.key, position: i + 1, section: l.section, description: l.description, specification: l.specification ?? null, unit: l.unit,
      quantity: calcLine(l).net, pack: null,
      provenance: {
        source: src.maturity === 'reviewed_cost_plan' ? 'reviewed_estimate' : 'client_specified', maturity: src.maturity, label: m.label, notice: m.notice,
        estimateId: src.estimateId, estimateVersionId: src.versionId, estimateVersionNumber: src.versionNumber, estimateLineId: l.id, snapshotHash: src.snapshotHash,
      },
    })),
  };
}

/** A website quote request (§3.10) as a one-line client-specified RFQ scope, labelled as such. */
export function rfqLineFromQuoteRequest(q: { id: string; listingTitle: string; quantity: bigint; unit: string; notes: string | null }, lineKey: string): RfqLine {
  return {
    lineKey, position: 1, section: 'other', description: q.listingTitle, specification: q.notes, unit: q.unit, quantity: q.quantity, pack: null,
    provenance: { source: 'quote_request', maturity: 'client_specified', label: 'From a website quote request', notice: MATURITY.client_specified.notice, estimateId: null, estimateVersionId: null, estimateVersionNumber: null, estimateLineId: null, snapshotHash: null },
  };
}

/** The scope label for the whole RFQ: the weakest maturity among its lines wins. */
export function rfqScopeLabel(lines: Pick<RfqLine, 'provenance'>[]): { maturity: Maturity; label: string; notice: string } {
  const anyClient = lines.some((l) => l.provenance.maturity !== 'reviewed_cost_plan');
  const m: Maturity = anyClient ? 'client_specified' : 'reviewed_cost_plan';
  return { maturity: m, label: MATURITY[m].label, notice: MATURITY[m].notice };
}

/** What changed between two RFQ versions, matched by line key (feeds the needs_revision notice). */
export function rfqChanges(prev: RfqLine[], next: RfqLine[]): string[] {
  const out: string[] = [];
  const pm = new Map(prev.map((l) => [l.lineKey, l]));
  const nm = new Map(next.map((l) => [l.lineKey, l]));
  for (const l of next) {
    const p = pm.get(l.lineKey);
    if (!p) { out.push(`Added: ${l.description}`); continue; }
    if (p.quantity !== l.quantity || p.unit !== l.unit) out.push(`${l.description}: ${formatDec(p.quantity, 3)} ${p.unit} → ${formatDec(l.quantity, 3)} ${l.unit}`);
    if ((p.specification ?? '') !== (l.specification ?? '')) out.push(`${l.description}: specification changed`);
    if (p.description !== l.description) out.push(`Renamed: ${p.description} → ${l.description}`);
  }
  for (const p of prev) if (!nm.has(p.lineKey)) out.push(`Removed: ${p.description}`);
  return out;
}

// ---------------------------------------------------------------- quotes (§10.4 step 3)
export type QuoteLineStatus = 'priced' | 'excluded';
export interface QuoteLineInput {
  rfqLineKey: string;
  status: QuoteLineStatus;
  /** What the provider offers: brand, product or equivalent. */
  offered: string | null;
  isSubstitution: boolean;
  substitutionNote: string | null;
  unit: string;
  /** Scaled decimal. */
  quantity: bigint;
  pack: PackSize | null;
  /** Price per `unit`, integer minor units, before tax. */
  unitPriceMinor: bigint;
  taxRatePct: number;
  availability: string | null;
  leadTimeDays: number | null;
}
export interface QuoteTerms {
  currency: string;
  deliveryMinor: bigint;
  deliveryTaxRatePct: number;
  validUntil: string;
  paymentTerms: string | null;
  warranty: string | null;
  leadTimeDays: number | null;
  exclusions: string[];
  notes: string | null;
}
export interface QuoteTotals { linesMinor: bigint; deliveryMinor: bigint; taxMinor: bigint; grossMinor: bigint }

export const quoteLineAmount = (l: Pick<QuoteLineInput, 'status' | 'quantity' | 'unitPriceMinor'>) => (l.status === 'excluded' ? 0n : divRound(l.quantity * l.unitPriceMinor, SCALE));
const taxOf = (amount: bigint, pct: number) => divRound(amount * BigInt(Math.round(pct * 10_000)), 1_000_000n);

export function quoteTotals(lines: QuoteLineInput[], terms: Pick<QuoteTerms, 'deliveryMinor' | 'deliveryTaxRatePct'>): QuoteTotals {
  let linesMinor = 0n; let tax = 0n;
  for (const l of lines) { const a = quoteLineAmount(l); linesMinor += a; tax += taxOf(a, l.taxRatePct); }
  tax += taxOf(terms.deliveryMinor, terms.deliveryTaxRatePct);
  return { linesMinor, deliveryMinor: terms.deliveryMinor, taxMinor: tax, grossMinor: linesMinor + terms.deliveryMinor + tax };
}

/** Problems that stop a draft quote being submitted. */
export function quoteProblems(rfqLines: Pick<RfqLine, 'lineKey' | 'description'>[], lines: QuoteLineInput[], terms: QuoteTerms, today: string): string[] {
  const p: string[] = [];
  const keys = new Set(rfqLines.map((l) => l.lineKey));
  if (!lines.length) p.push('Price at least one line.');
  for (const l of lines) {
    if (!keys.has(l.rfqLineKey)) p.push('A line does not belong to this request.');
    if (l.status === 'priced' && l.unitPriceMinor <= 0n) p.push(`${rfqLines.find((r) => r.lineKey === l.rfqLineKey)?.description ?? 'A line'}: enter a unit price.`);
    if (l.status === 'priced' && l.quantity <= 0n) p.push(`${rfqLines.find((r) => r.lineKey === l.rfqLineKey)?.description ?? 'A line'}: enter a quantity.`);
    if (!UNITS[l.unit]) p.push(`Unknown unit "${l.unit}".`);
    if (l.isSubstitution && !l.substitutionNote) p.push('Describe each substitution.');
  }
  if (new Set(lines.map((l) => l.rfqLineKey)).size !== lines.length) p.push('Each request line can be priced once.');
  if (!lines.some((l) => l.status === 'priced')) p.push('Price at least one line, or decline the request instead.');
  if (!terms.validUntil || terms.validUntil < today) p.push('Set a validity date that has not passed.');
  return [...new Set(p)];
}

// ---------------------------------------------------------------- comparison (§10.4 step 4)
export type CellFlag = 'missing' | 'excluded' | 'substitution' | 'unit_differs' | 'non_comparable_unit' | 'quantity_differs';
export interface ComparisonQuote {
  quoteId: string; versionId: string; versionNumber: number; providerOrgId: string; providerName: string; state: QuoteState;
  terms: QuoteTerms; lines: QuoteLineInput[];
}
export interface ComparisonCell {
  quoteId: string;
  status: 'priced' | 'excluded' | 'missing';
  /** Exactly what the provider quoted. */
  source: { offered: string | null; unit: string; quantity: string; unitPriceMinor: string; amountMinor: string; taxRatePct: number; availability: string | null; leadTimeDays: number | null; substitutionNote: string | null } | null;
  /** Price per base unit of the request line's dimension; null when not comparable. */
  normalized: { perBaseMinor: number; baseUnit: string } | null;
  comparable: boolean;
  flags: CellFlag[];
  lowest: boolean;
}
export interface ComparisonRow { line: { lineKey: string; description: string; specification: string | null; unit: string; quantity: string; provenance: RfqLineProvenance }; cells: ComparisonCell[] }
export interface ComparisonColumn {
  quoteId: string; versionId: string; versionNumber: number; providerOrgId: string; providerName: string; state: QuoteState;
  totals: { linesMinor: string; deliveryMinor: string; taxMinor: string; grossMinor: string };
  terms: { validUntil: string; paymentTerms: string | null; warranty: string | null; leadTimeDays: number | null; exclusions: string[]; notes: string | null };
  flags: { partial: boolean; missingLines: number; excludedLines: number; substitutions: number; nonComparableLines: number; quantityDiffers: number; needsRevision: boolean; exclusionsStated: boolean };
  /** Prices every line, in a comparable unit, at the requested quantity, with no substitution, against the current RFQ version. */
  likeForLike: boolean;
}
export interface Comparison {
  rows: ComparisonRow[];
  columns: ComparisonColumn[];
  noBids: { providerOrgId: string; providerName: string; reason: string | null }[];
  /** Only when at least two like-for-like quotes exist; never across non-comparable quotes. */
  lowestTotal: { quoteId: string; grossMinor: string } | null;
  lowestTotalNote: string;
  scope: { maturity: Maturity; label: string; notice: string };
}

function sameKey(a: { unit: string; pack: PackSize | null }, b: { unit: string; pack: PackSize | null }) {
  const ka = comparablePrice(1n, a.unit, a.pack); const kb = comparablePrice(1n, b.unit, b.pack);
  return ka.key === kb.key ? ka : null;
}
/** Quantity in base units when measurable, else the raw scaled quantity for exact-unit comparison. */
function baseQty(q: bigint, unit: string, pack: PackSize | null): number {
  const u = UNITS[unit];
  if (u?.toBase && u.dimension !== 'time') return (Number(q) / 1e6) * u.toBase;
  if (pack && UNITS[pack.unit]?.toBase) return (Number(q) / 1e6) * pack.value * UNITS[pack.unit]!.toBase!;
  return Number(q) / 1e6;
}

export function compareQuotes(rfqLines: RfqLine[], quotes: ComparisonQuote[], noBids: Comparison['noBids'] = []): Comparison {
  const columns: ComparisonColumn[] = quotes.map((q) => {
    const t = quoteTotals(q.lines, q.terms);
    return {
      quoteId: q.quoteId, versionId: q.versionId, versionNumber: q.versionNumber, providerOrgId: q.providerOrgId, providerName: q.providerName, state: q.state,
      totals: { linesMinor: String(t.linesMinor), deliveryMinor: String(t.deliveryMinor), taxMinor: String(t.taxMinor), grossMinor: String(t.grossMinor) },
      terms: { validUntil: q.terms.validUntil, paymentTerms: q.terms.paymentTerms, warranty: q.terms.warranty, leadTimeDays: q.terms.leadTimeDays, exclusions: q.terms.exclusions, notes: q.terms.notes },
      flags: { partial: false, missingLines: 0, excludedLines: 0, substitutions: 0, nonComparableLines: 0, quantityDiffers: 0, needsRevision: q.state === 'needs_revision', exclusionsStated: q.terms.exclusions.length > 0 },
      likeForLike: false,
    };
  });
  const rows: ComparisonRow[] = rfqLines.map((rl) => {
    const cells: ComparisonCell[] = quotes.map((q, qi) => {
      const col = columns[qi]!;
      const l = q.lines.find((x) => x.rfqLineKey === rl.lineKey);
      if (!l) { col.flags.missingLines++; return { quoteId: q.quoteId, status: 'missing', source: null, normalized: null, comparable: false, flags: ['missing'], lowest: false }; }
      const source = { offered: l.offered, unit: l.unit, quantity: formatDec(l.quantity, 3), unitPriceMinor: String(l.unitPriceMinor), amountMinor: String(quoteLineAmount(l)), taxRatePct: l.taxRatePct, availability: l.availability, leadTimeDays: l.leadTimeDays, substitutionNote: l.substitutionNote };
      if (l.status === 'excluded') { col.flags.excludedLines++; return { quoteId: q.quoteId, status: 'excluded', source, normalized: null, comparable: false, flags: ['excluded'], lowest: false }; }
      const flags: CellFlag[] = [];
      if (l.isSubstitution) { flags.push('substitution'); col.flags.substitutions++; }
      const key = sameKey(rl, l);
      let normalized: ComparisonCell['normalized'] = null;
      if (!key) { flags.push('non_comparable_unit'); col.flags.nonComparableLines++; }
      else {
        if (l.unit !== rl.unit) flags.push('unit_differs');
        const c = comparablePrice(l.unitPriceMinor, l.unit, l.pack);
        normalized = { perBaseMinor: c.perBaseMinor ?? Number(l.unitPriceMinor), baseUnit: c.baseUnit };
        if (Math.abs(baseQty(l.quantity, l.unit, l.pack) - baseQty(rl.quantity, rl.unit, rl.pack)) > 1e-6) { flags.push('quantity_differs'); col.flags.quantityDiffers++; }
      }
      return { quoteId: q.quoteId, status: 'priced', source, normalized, comparable: !!key, flags, lowest: false };
    });
    // Lowest per line only among comparable, non-substituted cells, and only when there is something to compare.
    const pool = cells.filter((c) => c.comparable && !c.flags.includes('substitution'));
    if (pool.length >= 2) {
      const min = Math.min(...pool.map((c) => c.normalized!.perBaseMinor));
      for (const c of pool) c.lowest = c.normalized!.perBaseMinor === min;
    }
    return { line: { lineKey: rl.lineKey, description: rl.description, specification: rl.specification, unit: rl.unit, quantity: formatDec(rl.quantity, 3), provenance: rl.provenance }, cells };
  });
  for (const c of columns) {
    c.flags.partial = c.flags.missingLines + c.flags.excludedLines > 0;
    c.likeForLike = !c.flags.partial && c.flags.substitutions === 0 && c.flags.nonComparableLines === 0 && c.flags.quantityDiffers === 0 && !c.flags.needsRevision;
  }
  const lf = columns.filter((c) => c.likeForLike);
  let lowestTotal: Comparison['lowestTotal'] = null;
  let lowestTotalNote: string;
  if (lf.length >= 2) {
    const best = lf.reduce((a, b) => (BigInt(b.totals.grossMinor) < BigInt(a.totals.grossMinor) ? b : a));
    lowestTotal = { quoteId: best.quoteId, grossMinor: best.totals.grossMinor };
    lowestTotalNote = lf.length === columns.length ? 'Lowest total among quotes that price the same scope.' : `Lowest total among the ${lf.length} like-for-like quotes; the others are not compared on total.`;
  } else {
    lowestTotalNote = columns.length < 2 ? 'Only one quote so far.' : 'No lowest total is shown: the quotes do not price the same scope in comparable units.';
  }
  return { rows, columns, noBids, lowestTotal, lowestTotalNote, scope: rfqScopeLabel(rfqLines) };
}

// ---------------------------------------------------------------- provider matching (§13.1, §13.5)
export interface CheckRecord { type: CheckType; state: 'passed' | 'failed' | 'expired' | 'revoked'; checkedAt: string; expiresAt: string | null }
export interface ProviderCandidate {
  orgId: string;
  name: string;
  handle: string;
  /** False when the provider paused RFQs, an owner account is not active, or a suspension is in force. */
  active: boolean;
  inactiveReason?: string | null;
  /** Live listings in the RFQ's category, with where they are and where they serve. */
  listings: { areaCode: string; serviceAreas: string[]; distanceKm: number | null; perBaseMinor: number | null; matchesSpec: boolean }[];
  checks: CheckRecord[];
  /** Platform history; null fields mean "not enough data". */
  stats: {
    invitations: number; responses: number; awards: number; replyRatePct: number | null; reviewAverage: number | null; reviewCount: number;
    /** Delivery and quote record from completed orders (R3 slice 3); rates are null where the sample is small. */
    performance?: PerformanceSummary | null;
    /** Published transaction reviews (client of the provider): overall average when there are enough of them. */
    transactionReviewAverage?: number | null; transactionReviewCount?: number;
  };
  /** The median per-base-unit price across all live listings in the category and area (price history context). */
  marketMedianPerBase: number | null;
  /** Labelled only. Never read by eligibility or ranking (§13.1.4). */
  promoted?: boolean;
}

/**
 * The only fields ranking reads. Fee, commission and promotion data are not among them (§13.5); a test checks
 * that adding them changes nothing.
 */
export const RANKING_INPUTS = ['listings', 'checks', 'stats', 'marketMedianPerBase'] as const;

export interface MatchFactor { key: keyof RankingWeights; label: string; value: number; weight: number; contribution: number; detail: string }
export interface ProviderMatch {
  orgId: string; name: string; handle: string;
  eligible: true;
  score: number; rank: number;
  factors: MatchFactor[];
  why: string[];
  promoted: boolean;
  /** The client's own lists: "Preferred supplier", "Approved supplier", "Named by you". */
  labels: string[];
  /** Shown to the client, never a reason to exclude (e.g. a nominated supplier without a listing in the category). */
  warnings: string[];
  preferred: boolean;
  checksAtDeadline: { type: CheckType; validUntil: string | null }[];
}
export interface ProviderExclusion { orgId: string; name: string; handle: string; eligible: false; reasons: string[] }
export interface MatchResult {
  rankingVersion: string;
  sourcingMode: SourcingMode;
  eligible: ProviderMatch[];
  ineligible: ProviderExclusion[];
  weights: RankingWeights;
  /** §13.1.6: fewer eligible providers than the target. */
  assistedSourcing: { offered: boolean; eligibleCount: number; target: number; message: string | null };
}
export interface MatchRequest { categorySlug: string; categoryName: string; areaCode: string; areaLabel: string; rfqType: RfqType; deadline: string }

export const RANKING_VERSION = 'match-2026.2';

const CHECK_LABELS: Record<CheckType, string> = {
  identity_contact: 'Identity and contact', business_registration: 'Business registration', professional_credential: 'Professional credential',
  trade_reference: 'Trade capability and references', stock_evidence: 'Product and stock evidence',
};
export const checkLabel = (t: CheckType) => CHECK_LABELS[t] ?? t;

/** The newest passed check of a type that is still valid at `at`. */
export function checkValidAt(checks: CheckRecord[], type: CheckType, at: Date): CheckRecord | null {
  const ok = checks.filter((c) => c.type === type && c.state === 'passed' && new Date(c.checkedAt) <= at && (!c.expiresAt || new Date(c.expiresAt) >= at));
  // A later failed or revoked check of the same type overrides an earlier pass.
  const latest = checks.filter((c) => c.type === type).sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0];
  if (latest && latest.state !== 'passed') return null;
  return ok.sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] ?? null;
}

/** Category and area coverage (§13.1.1): a live listing in the category that serves the area. */
export function coverageReasons(c: Pick<ProviderCandidate, 'listings'>, req: MatchRequest, cfg: ProcurementConfig): string[] {
  if (!c.listings.length) return [`No live listing in ${req.categoryName}.`];
  if (!c.listings.some((l) => l.areaCode === req.areaCode || l.serviceAreas.includes(req.areaCode) || (l.distanceKm != null && l.distanceKm <= cfg.serviceRadiusKm))) return [`Does not serve ${req.areaLabel}.`];
  return [];
}

/** The required checks (pack values plus any the request adds) a provider lacks at the deadline. */
export function checkReasons(c: Pick<ProviderCandidate, 'checks'>, req: MatchRequest, cfg: ProcurementConfig, extraChecks: CheckType[] = []): string[] {
  const reasons: string[] = [];
  const at = new Date(req.deadline);
  for (const t of [...new Set([...cfg.requiredChecks[req.rfqType], ...extraChecks])]) {
    if (checkValidAt(c.checks, t, at)) continue;
    const now = checkValidAt(c.checks, t, new Date(Math.min(Date.now(), at.getTime())));
    reasons.push(now ? `${checkLabel(t)} check expires before the deadline.` : `${checkLabel(t)} check not passed.`);
  }
  return reasons;
}

/** Hard eligibility (§13.1.1). Returns the reasons a provider is out; empty means eligible. */
export function eligibilityReasons(c: ProviderCandidate, req: MatchRequest, cfg: ProcurementConfig, extraChecks: CheckType[] = []): string[] {
  return [...(c.active ? [] : [c.inactiveReason ?? 'Not accepting requests at the moment.']), ...coverageReasons(c, req, cfg), ...checkReasons(c, req, cfg, extraChecks)];
}

const clamp = (n: number) => Math.max(0, Math.min(1, n));
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Soft ranking factors, each 0–1, with the detail a client sees under "why this provider" (§13.1.2–3). */
export function rankingFactors(c: Pick<ProviderCandidate, (typeof RANKING_INPUTS)[number]>, req: MatchRequest, cfg: ProcurementConfig): MatchFactor[] {
  const w = cfg.rankingWeights;
  const serving = c.listings.filter((l) => l.areaCode === req.areaCode || l.serviceAreas.includes(req.areaCode) || (l.distanceKm != null && l.distanceKm <= cfg.serviceRadiusKm));
  const pool = serving.length ? serving : c.listings;
  const spec = pool.some((l) => l.matchesSpec) ? 1 : 0.5;
  const listed = pool.length > 0;
  const { invitations, responses, replyRatePct, awards, reviewAverage, reviewCount, performance, transactionReviewAverage, transactionReviewCount = 0 } = c.stats;
  // Response reliability: RFQ responses when there is history, else chat reply rate, else a neutral prior. Once there
  // are enough submitted quotes, how many were kept to the deadline counts too.
  const answered = invitations >= 3 ? responses / invitations : replyRatePct != null ? replyRatePct / 100 : 0.5;
  const kept = performance?.quoteReliability ?? null;
  const reliability = kept != null ? 0.6 * answered + 0.4 * kept : answered;
  const reliabilityDetail = [invitations >= 3 ? `Answered ${responses} of ${invitations} requests` : replyRatePct != null ? `Replies to ${replyRatePct}% of enquiries` : 'New to requests for quotes (neutral score)',
    kept != null ? `kept ${Math.round(kept * 100)}% of quotes to the deadline` : null].filter(Boolean).join(', ');
  const passed = c.checks.filter((x) => x.state === 'passed').length;
  // Transaction reviews take precedence over website reviews (§13.4) once there are enough of them.
  const txReviews = transactionReviewAverage != null && transactionReviewCount >= 3;
  const rated = txReviews ? transactionReviewAverage! : reviewCount >= 3 && reviewAverage != null ? reviewAverage : null;
  const history = clamp(0.15 * Math.min(passed, 3) + 0.1 * Math.min(awards, 3) + (rated != null ? 0.25 * (rated / 5) : 0));
  const historyDetail = [passed ? `${passed} passed check${passed === 1 ? '' : 's'}` : 'No passed checks', awards ? `${awards} award${awards === 1 ? '' : 's'}` : null,
    rated != null ? `rated ${rated.toFixed(1)} from ${txReviews ? `${transactionReviewCount} order reviews` : `${reviewCount} website reviews`}` : null].filter(Boolean).join(', ');
  const record = deliveryRecordScore(performance);
  const local = pool.some((l) => l.areaCode === req.areaCode);
  const km = listed ? Math.min(...pool.map((l) => (l.areaCode === req.areaCode ? 0 : l.distanceKm ?? cfg.distanceZeroKm))) : cfg.distanceZeroKm;
  const distance = local ? 1 : clamp(1 - km / cfg.distanceZeroKm);
  const distanceDetail = !listed ? 'No listing to measure distance from' : local ? `Based in ${req.areaLabel}` : pool.some((l) => l.serviceAreas.includes(req.areaCode)) ? `Serves ${req.areaLabel} (about ${Math.round(km)} km away)` : `About ${Math.round(km)} km away`;
  const prices = pool.map((l) => l.perBaseMinor).filter((x): x is number => x != null);
  let price = 0.5; let priceDetail = 'No comparable advertised price';
  if (prices.length && c.marketMedianPerBase) {
    const ratio = Math.min(...prices) / c.marketMedianPerBase;
    price = clamp(1 - (ratio - 0.8) / 0.4);
    priceDetail = ratio <= 0.98 ? `Advertised prices below the local median` : ratio >= 1.02 ? 'Advertised prices above the local median' : 'Advertised prices near the local median';
  }
  const f = (key: keyof RankingWeights, label: string, value: number, detail: string): MatchFactor => ({ key, label, value: round3(value), weight: w[key], contribution: round3(value * w[key]), detail });
  return [
    f('specFit', 'Specification fit', listed ? spec : 0.5, !listed ? `No live listing in ${req.categoryName} (named by the client)` : spec === 1 ? `Lists ${req.categoryName}` : `Lists ${req.categoryName}, specification to confirm`),
    f('responseReliability', 'Response reliability', clamp(reliability), reliabilityDetail),
    f('verifiedHistory', 'Verified history', history, historyDetail),
    f('deliveryRecord', 'Delivery record', record.value, record.detail),
    f('distance', 'Distance and logistics', distance, distanceDetail),
    f('priceHistory', 'Price history', price, priceDetail),
  ];
}

/**
 * What the client's own rules say about one candidate (§13.1.5, sourcing modes §10.4 step 2): extra hard reasons
 * (blocked, conflict of interest, not an approved supplier), whether category and area coverage is waived (a
 * supplier the client named), and labels and warnings shown beside the match. Built by `sourcingScreen`.
 */
export interface CandidateScreen { reasons: string[]; waiveCoverage: boolean; labels: string[]; warnings: string[]; preferred: boolean }
export type Screen = (c: ProviderCandidate) => CandidateScreen;

/**
 * Eligibility first, then explainable ranking. Paid placement is carried through as a label only and can never
 * get a provider past a hard filter or move it in the order. A client's preferred suppliers lead the eligible list
 * (a stated preference, §13.1.2) without changing their scores.
 */
export function matchProviders(candidates: ProviderCandidate[], req: MatchRequest, cfg: ProcurementConfig, opts: { screen?: Screen; extraChecks?: CheckType[]; sourcingMode?: SourcingMode } = {}): MatchResult {
  const eligible: Omit<ProviderMatch, 'rank'>[] = [];
  const ineligible: ProviderExclusion[] = [];
  const at = new Date(req.deadline);
  const extra = opts.extraChecks ?? [];
  for (const c of candidates) {
    const sc = opts.screen?.(c) ?? { reasons: [], waiveCoverage: false, labels: [], warnings: [], preferred: false };
    const coverage = coverageReasons(c, req, cfg);
    const reasons = [...sc.reasons, ...(c.active ? [] : [c.inactiveReason ?? 'Not accepting requests at the moment.']), ...(sc.waiveCoverage ? [] : coverage), ...checkReasons(c, req, cfg, extra)];
    if (reasons.length) { ineligible.push({ orgId: c.orgId, name: c.name, handle: c.handle, eligible: false, reasons: [...new Set(reasons)] }); continue; }
    const inputs = { listings: c.listings, checks: c.checks, stats: c.stats, marketMedianPerBase: c.marketMedianPerBase };
    const factors = rankingFactors(inputs, req, cfg);
    const score = round3(factors.reduce((s, x) => s + x.contribution, 0));
    const why = [...factors].sort((a, b) => b.contribution - a.contribution).slice(0, 3).map((x) => x.detail);
    eligible.push({
      orgId: c.orgId, name: c.name, handle: c.handle, eligible: true, score, factors, why, promoted: !!c.promoted,
      labels: sc.labels, warnings: sc.waiveCoverage ? [...sc.warnings, ...coverage] : sc.warnings, preferred: sc.preferred,
      checksAtDeadline: [...new Set([...cfg.requiredChecks[req.rfqType], ...extra])].map((t) => ({ type: t, validUntil: checkValidAt(c.checks, t, at)?.expiresAt ?? null })),
    });
  }
  eligible.sort((a, b) => Number(b.preferred) - Number(a.preferred) || b.score - a.score || a.name.localeCompare(b.name) || a.orgId.localeCompare(b.orgId));
  const offered = eligible.length < cfg.targetEligibleProviders;
  return {
    rankingVersion: RANKING_VERSION,
    sourcingMode: opts.sourcingMode ?? 'open',
    eligible: eligible.map((e, i) => ({ ...e, rank: i + 1 })),
    ineligible: ineligible.sort((a, b) => a.name.localeCompare(b.name)),
    weights: cfg.rankingWeights,
    assistedSourcing: {
      offered, eligibleCount: eligible.length, target: cfg.targetEligibleProviders,
      message: offered ? `Only ${eligible.length} eligible provider${eligible.length === 1 ? '' : 's'} for ${req.categoryName} in ${req.areaLabel}. Our operations team can look for more suppliers for you.` : null,
    },
  };
}

// ---------------------------------------------------------------- orders and payments (§10.4 steps 6–7, §14.1)
export const RECORD_ONLY_PAYMENT_NOTICE = 'Payment is arranged directly with the supplier. BuildWise records payments you make but does not process, hold or protect them.';
export const VERIFICATION_STATEMENT = 'Verification is not a guarantee of workmanship, safety or solvency.';

/** Whether a quote version can be awarded now (§22: an expired quote blocks award until reconfirmed or re-quoted). */
export function awardBlockers(v: { state: QuoteState; validUntil: string; rfqVersionNumber: number }, rfq: { state: RfqState; currentVersionNumber: number }, today: string): string[] {
  const out: string[] = [];
  if (rfq.state !== 'closed') out.push('Close the request before awarding.');
  if (v.state === 'needs_revision' || v.rfqVersionNumber !== rfq.currentVersionNumber) out.push('This quote answers an earlier version of the request. Ask the supplier to re-quote.');
  else if (v.state !== 'submitted') out.push('Only a submitted quote can be awarded.');
  if (v.validUntil < today) out.push('This quote has expired. Ask the supplier to reconfirm or re-quote.');
  return out;
}
