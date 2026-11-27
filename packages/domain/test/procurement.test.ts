import { describe, expect, it } from 'vitest';
import {
  awardBlockers, can, checkValidAt, compareQuotes, DEMO_MARKET, estimateCanFeedRfq, invitationMachine, matchProviders, orderMachine, quoteMachine,
  quoteProblems, quoteTotals, RANKING_INPUTS, rfqChanges, rfqLinesFromEstimate, rfqMachine, rfqScopeLabel, rfqTypeFor,
  type ComparisonQuote, type LineInput, type MatchRequest, type ProviderCandidate, type QuoteLineInput, type QuoteTerms, type RfqLine,
} from '../src/index';

const cfg = DEMO_MARKET.procurement;
const D = 1_000_000n;

const estLine = (id: string, over: Partial<LineInput> = {}): LineInput & { key: string; position: number } => ({
  id, key: `k-${id}`, position: Number(id.replace(/\D/g, '')) || 1, section: 'substructure', description: `Line ${id}`, specification: null, unit: 'bag',
  gross: 60n * D, deductions: 0n, wastePct: 5, rates: { material: 9500n * D }, taxRatePct: 0, status: 'provisional', quantitySource: 'client_entered', measurementIds: [], ...over,
});

describe('RFQ scope from estimates (§10.4 step 1, §11.1)', () => {
  it('accepts only frozen client-specified or reviewed estimates', () => {
    expect(estimateCanFeedRfq('indicative', 'generated').ok).toBe(false);
    expect(estimateCanFeedRfq('draft_takeoff', 'draft').ok).toBe(false);
    expect(estimateCanFeedRfq('client_specified', 'draft')).toMatchObject({ ok: false, reason: expect.stringMatching(/Share/) });
    expect(estimateCanFeedRfq('client_specified', 'shared').ok).toBe(true);
    expect(estimateCanFeedRfq('reviewed_cost_plan', 'under_review').ok).toBe(false);
    expect(estimateCanFeedRfq('reviewed_cost_plan', 'issued').ok).toBe(true);
    expect(estimateCanFeedRfq('reviewed_cost_plan', 'accepted').ok).toBe(true);
  });

  it('copies net quantities with provenance and drops excluded lines', () => {
    const r = rfqLinesFromEstimate({ estimateId: 'e1', versionId: 'v1', versionNumber: 2, maturity: 'client_specified', state: 'shared', snapshotHash: 'h', lines: [estLine('l1'), estLine('l2', { status: 'excluded' })] });
    if (!r.ok) throw new Error(r.reason);
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.quantity).toBe(63n * D); // 60 + 5% waste
    expect(r.lines[0]!.provenance).toMatchObject({ source: 'client_specified', estimateVersionNumber: 2, estimateLineId: 'l1', notice: expect.stringMatching(/not platform-reviewed/) });
    expect(rfqScopeLabel(r.lines).label).toBe('Client-specified scope');
    const reviewed = rfqLinesFromEstimate({ estimateId: 'e', versionId: 'v', versionNumber: 1, maturity: 'reviewed_cost_plan', state: 'issued', snapshotHash: null, lines: [estLine('l1', { status: 'measured' })] });
    expect(reviewed.ok && rfqScopeLabel(reviewed.lines).label).toBe('Professionally reviewed');
    expect(rfqLinesFromEstimate({ estimateId: 'e', versionId: 'v', versionNumber: 1, maturity: 'draft_takeoff', state: 'draft', snapshotHash: null, lines: [estLine('l1')] }).ok).toBe(false);
  });

  it('maps categories to RFQ types', () => {
    expect(rfqTypeFor('cement', 'product')).toBe('material');
    expect(rfqTypeFor('trades', 'service')).toBe('trade');
    expect(rfqTypeFor('logistics', 'service')).toBe('logistics');
    expect(rfqTypeFor('plant-hire', 'hire')).toBe('service');
  });
});

describe('state machines (§9.2–§9.4)', () => {
  it('runs the RFQ lifecycle and keeps revision inside published', () => {
    expect(rfqMachine.next('draft', 'publish')).toBe('published');
    expect(rfqMachine.next('published', 'revise')).toBe('published');
    expect(rfqMachine.next('published', 'close')).toBe('closed');
    expect(rfqMachine.next('closed', 'award')).toBe('awarded');
    expect(rfqMachine.next('closed', 'no_award')).toBe('no_award');
    expect(rfqMachine.can('published', 'award')).toBe(false);
    expect(rfqMachine.can('awarded', 'cancel')).toBe(false);
    expect(() => rfqMachine.next('draft', 'close')).toThrow(/not allowed/);
  });

  it('never edits a submitted quote version: it is replaced, rejected, accepted or expires', () => {
    expect(quoteMachine.commandsFrom('submitted').sort()).toEqual(['accept', 'expire', 'reject', 'replace', 'request_revision', 'withdraw']);
    expect(quoteMachine.next('submitted', 'request_revision')).toBe('needs_revision');
    expect(quoteMachine.can('needs_revision', 'accept')).toBe(false);
    expect(quoteMachine.next('needs_revision', 'replace')).toBe('revised');
    expect(quoteMachine.commandsFrom('accepted')).toEqual([]);
    expect(invitationMachine.next('viewed', 'decline')).toBe('declined');
    expect(orderMachine.next('placed', 'confirm')).toBe('confirmed');
    expect(orderMachine.can('fulfilled', 'cancel')).toBe(false);
  });

  it('lets only the owner award, and managers prepare RFQs', () => {
    expect(can('owner', 'rfq.award')).toBe(true);
    expect(can('manager', 'rfq.award')).toBe(false);
    expect(can('manager', 'rfq.manage')).toBe(true);
    expect(can('collaborator', 'rfq.manage')).toBe(false);
    expect(can('viewer', 'rfq.read')).toBe(true);
  });
});

const rfqLine = (key: string, unit: string, qty: number, over: Partial<RfqLine> = {}): RfqLine => ({
  lineKey: key, position: 1, section: 'substructure', description: `Item ${key}`, specification: null, unit, quantity: BigInt(qty) * D, pack: null,
  provenance: { source: 'client_specified', maturity: 'client_specified', label: 'Client-specified scope', notice: 'Client-specified scope — not platform-reviewed.', estimateId: null, estimateVersionId: null, estimateVersionNumber: null, estimateLineId: null, snapshotHash: null },
  ...over,
});
const qLine = (key: string, unit: string, qty: number, price: number, over: Partial<QuoteLineInput> = {}): QuoteLineInput => ({
  rfqLineKey: key, status: 'priced', offered: null, isSubstitution: false, substitutionNote: null, unit, quantity: BigInt(qty) * D, pack: null,
  unitPriceMinor: BigInt(price), taxRatePct: 0, availability: null, leadTimeDays: null, ...over,
});
const terms = (over: Partial<QuoteTerms> = {}): QuoteTerms => ({ currency: 'NGN', deliveryMinor: 0n, deliveryTaxRatePct: 0, validUntil: '2026-12-31', paymentTerms: null, warranty: null, leadTimeDays: null, exclusions: [], notes: null, ...over });
const quote = (id: string, lines: QuoteLineInput[], over: Partial<ComparisonQuote> = {}): ComparisonQuote => ({ quoteId: id, versionId: `${id}-v1`, versionNumber: 1, providerOrgId: `org-${id}`, providerName: `Supplier ${id}`, state: 'submitted', terms: terms(), lines, ...over });

describe('quotes and totals', () => {
  it('adds lines, delivery and tax in minor units', () => {
    const t = quoteTotals([qLine('a', 'bag', 60, 950_000, { taxRatePct: 7.5 }), qLine('b', 'm2', 10, 100_000, { status: 'excluded' })], { deliveryMinor: 1_500_000n, deliveryTaxRatePct: 7.5 });
    expect(t.linesMinor).toBe(57_000_000n);
    expect(t.taxMinor).toBe(4_275_000n + 112_500n);
    expect(t.grossMinor).toBe(57_000_000n + 1_500_000n + 4_387_500n);
  });

  it('lists what stops a draft being submitted', () => {
    const lines = [rfqLine('a', 'bag', 60)];
    expect(quoteProblems(lines, [qLine('a', 'bag', 60, 0)], terms(), '2026-11-25')).toContain('Item a: enter a unit price.');
    expect(quoteProblems(lines, [qLine('a', 'bag', 60, 100, { isSubstitution: true })], terms(), '2026-11-25')).toContain('Describe each substitution.');
    expect(quoteProblems(lines, [qLine('a', 'bag', 60, 100)], terms({ validUntil: '2026-01-01' }), '2026-11-25')).toContain('Set a validity date that has not passed.');
    expect(quoteProblems(lines, [qLine('a', 'bag', 60, 100)], terms(), '2026-11-25')).toEqual([]);
  });
});

describe('normalised comparison (§10.4 step 4)', () => {
  const lines = [rfqLine('cement', 'bag', 60), rfqLine('rebar', 'tonne', 2)];

  it('normalises comparable units, keeps source values and shows a lowest total only like for like', () => {
    const c = compareQuotes(lines, [
      quote('A', [qLine('cement', 'bag', 60, 950_000), qLine('rebar', 'tonne', 2, 115_000_000)]),
      quote('B', [qLine('cement', 'bag', 60, 920_000), qLine('rebar', 'kg', 2000, 112_000)]),
    ]);
    const rebar = c.rows[1]!.cells;
    expect(rebar[1]!.source).toMatchObject({ unit: 'kg', quantity: '2000', unitPriceMinor: '112000' });
    expect(rebar[1]!.flags).toEqual(['unit_differs']);
    expect(rebar[0]!.normalized).toEqual({ perBaseMinor: 115_000, baseUnit: 'kg' });
    expect(rebar[1]!.lowest).toBe(true);
    expect(c.columns.every((x) => x.likeForLike)).toBe(true);
    expect(c.lowestTotal?.quoteId).toBe('B');
  });

  it('flags partial bids, exclusions, substitutions, non-comparable units and no-bids, and then shows no lowest total', () => {
    const c = compareQuotes(lines, [
      quote('A', [qLine('cement', 'bag', 60, 950_000)]),
      quote('B', [qLine('cement', 'tonne', 3, 18_000_000), qLine('rebar', 'tonne', 2, 110_000_000, { isSubstitution: true, substitutionNote: 'Y10 instead of Y12' })]),
      quote('C', [qLine('cement', 'bag', 60, 900_000), qLine('rebar', 'tonne', 2, 0, { status: 'excluded' })]),
    ], [{ providerOrgId: 'org-D', providerName: 'Supplier D', reason: 'Out of stock' }]);
    const [a, b, cc] = c.columns;
    expect(a!.flags).toMatchObject({ partial: true, missingLines: 1 });
    expect(b!.flags).toMatchObject({ substitutions: 1, nonComparableLines: 1, partial: false });
    expect(cc!.flags).toMatchObject({ partial: true, excludedLines: 1 });
    expect(c.rows[0]!.cells[1]!.flags).toContain('non_comparable_unit'); // tonne vs bag without a pack size
    expect(c.rows[0]!.cells[1]!.comparable).toBe(false);
    expect(c.rows[1]!.cells[1]!.lowest).toBe(false); // a substitution is never "lowest"
    expect(c.lowestTotal).toBeNull();
    expect(c.lowestTotalNote).toMatch(/No lowest total/);
    expect(c.noBids).toHaveLength(1);
    expect(c.rows[0]!.cells.filter((x) => x.lowest).map((x) => x.quoteId)).toEqual(['C']);
  });

  it('compares bags through declared pack sizes and flags a different quantity', () => {
    const c = compareQuotes([rfqLine('cement', 'bag', 60, { pack: { value: 50, unit: 'kg' } })], [
      quote('A', [qLine('cement', 'bag', 120, 480_000, { pack: { value: 25, unit: 'kg' } })]),
      quote('B', [qLine('cement', 'bag', 50, 950_000, { pack: { value: 50, unit: 'kg' } })]),
    ]);
    expect(c.rows[0]!.cells[0]!.flags).toEqual([]);
    expect(c.rows[0]!.cells[0]!.normalized?.baseUnit).toBe('kg');
    expect(c.rows[0]!.cells[1]!.flags).toEqual(['quantity_differs']);
    expect(c.lowestTotal).toBeNull();
  });

  it('treats a quote against an older RFQ version as not like for like', () => {
    const c = compareQuotes([rfqLine('cement', 'bag', 60)], [quote('A', [qLine('cement', 'bag', 60, 1)], { state: 'needs_revision' }), quote('B', [qLine('cement', 'bag', 60, 2)])]);
    expect(c.columns[0]!.likeForLike).toBe(false);
    expect(c.lowestTotal).toBeNull();
  });

  it('describes RFQ changes', () => {
    expect(rfqChanges([rfqLine('a', 'bag', 60)], [rfqLine('a', 'bag', 80), rfqLine('b', 'm2', 5)])).toEqual(['Item a: 60 bag → 80 bag', 'Added: Item b']);
  });
});

describe('provider matching (§13.1, §13.5)', () => {
  const req: MatchRequest = { categorySlug: 'cement', categoryName: 'Cement', areaCode: 'hilltop', areaLabel: 'Hilltop', rfqType: 'material', deadline: '2026-12-10T17:00:00Z' };
  const passed = (type: 'business_registration' | 'stock_evidence', expiresAt: string | null = null) => ({ type, state: 'passed' as const, checkedAt: '2026-01-01T00:00:00Z', expiresAt });
  const cand = (id: string, over: Partial<ProviderCandidate> = {}): ProviderCandidate => ({
    orgId: id, name: `Supplier ${id}`, handle: id, active: true,
    listings: [{ areaCode: 'hilltop', serviceAreas: [], distanceKm: 0, perBaseMinor: 190, matchesSpec: true }],
    checks: [passed('business_registration')],
    stats: { invitations: 0, responses: 0, awards: 0, replyRatePct: null, reviewAverage: null, reviewCount: 0 },
    marketMedianPerBase: 190, ...over,
  });

  it('applies hard filters with reasons, including checks that lapse before the deadline', () => {
    const r = matchProviders([
      cand('ok'),
      cand('far', { listings: [{ areaCode: 'harbour', serviceAreas: [], distanceKm: 21, perBaseMinor: 180, matchesSpec: true }] }),
      cand('lapsing', { checks: [passed('business_registration', '2026-12-01')] }),
      cand('unchecked', { checks: [] }),
      cand('paused', { active: false, inactiveReason: 'Not accepting requests for quotes.' }),
      cand('none', { listings: [] }),
      cand('revoked', { checks: [passed('business_registration'), { type: 'business_registration', state: 'revoked', checkedAt: '2026-06-01T00:00:00Z', expiresAt: null }] }),
    ], req, cfg);
    expect(r.eligible.map((e) => e.orgId)).toEqual(['ok']);
    const why = Object.fromEntries(r.ineligible.map((x) => [x.orgId, x.reasons.join(' ')]));
    expect(why.far).toMatch(/Does not serve Hilltop/);
    expect(why.lapsing).toMatch(/expires before the deadline/);
    expect(why.unchecked).toMatch(/Business registration check not passed/);
    expect(why.paused).toMatch(/Not accepting/);
    expect(why.none).toMatch(/No live listing in Cement/);
    expect(why.revoked).toMatch(/not passed/);
    expect(r.assistedSourcing).toMatchObject({ offered: true, eligibleCount: 1, target: 3 });
  });

  it('serves an area named in service areas or within the radius', () => {
    const r = matchProviders([
      cand('named', { listings: [{ areaCode: 'harbour', serviceAreas: ['hilltop'], distanceKm: 21, perBaseMinor: null, matchesSpec: true }] }),
      cand('near', { listings: [{ areaCode: 'airport-road', serviceAreas: [], distanceKm: 4, perBaseMinor: null, matchesSpec: true }] }),
    ], req, cfg);
    expect(r.eligible).toHaveLength(2);
  });

  it('stores factors and weights that add up to the score, and explains the match', () => {
    const r = matchProviders([cand('a', { stats: { invitations: 4, responses: 4, awards: 1, replyRatePct: 90, reviewAverage: 4.5, reviewCount: 6 } }), cand('b')], req, cfg);
    const top = r.eligible[0]!;
    expect(top.orgId).toBe('a');
    expect(top.factors.map((f) => f.key)).toEqual(['specFit', 'responseReliability', 'verifiedHistory', 'deliveryRecord', 'distance', 'priceHistory']);
    expect(top.score).toBeCloseTo(top.factors.reduce((s, f) => s + f.value * f.weight, 0), 2);
    expect(top.why.join(' ')).toMatch(/Answered 4 of 4 requests/);
    expect(r.weights).toEqual(cfg.rankingWeights);
    expect(Object.values(cfg.rankingWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });

  it('keeps paid placement and fee data out of eligibility and ranking', () => {
    const base = [cand('a'), cand('b', { stats: { invitations: 5, responses: 5, awards: 2, replyRatePct: 95, reviewAverage: 4.8, reviewCount: 10 } }), cand('c', { checks: [] })];
    const plain = matchProviders(base, req, cfg);
    const withMoney = matchProviders(base.map((c) => ({ ...c, promoted: true, commissionRatePct: 15, leadFeeMinor: 500_000, subscriptionTier: 'gold' }) as ProviderCandidate), req, cfg);
    expect(withMoney.eligible.map((e) => [e.orgId, e.score, e.rank])).toEqual(plain.eligible.map((e) => [e.orgId, e.score, e.rank]));
    expect(withMoney.ineligible.map((e) => e.orgId)).toEqual(['c']); // promotion never gets past a required check
    expect(withMoney.eligible.every((e) => e.promoted)).toBe(true); // shown as a label only
    expect(RANKING_INPUTS.some((k) => /fee|commission|promot|paid|subscription/i.test(k))).toBe(false);
  });

  it('reads a check as valid at a moment only between its pass and expiry', () => {
    const checks = [passed('business_registration', '2026-12-31')];
    expect(checkValidAt(checks, 'business_registration', new Date('2026-12-30'))).not.toBeNull();
    expect(checkValidAt(checks, 'business_registration', new Date('2027-01-02'))).toBeNull();
  });
});

describe('award blockers (§10.4 step 6, §22)', () => {
  it('needs a closed RFQ, a current submitted version and an unexpired quote', () => {
    const rfq = { state: 'closed' as const, currentVersionNumber: 2 };
    expect(awardBlockers({ state: 'submitted', validUntil: '2026-12-31', rfqVersionNumber: 2 }, rfq, '2026-11-25')).toEqual([]);
    expect(awardBlockers({ state: 'submitted', validUntil: '2026-12-31', rfqVersionNumber: 1 }, rfq, '2026-11-25')[0]).toMatch(/earlier version/);
    expect(awardBlockers({ state: 'submitted', validUntil: '2026-11-01', rfqVersionNumber: 2 }, rfq, '2026-11-25')[0]).toMatch(/expired/);
    expect(awardBlockers({ state: 'submitted', validUntil: '2026-12-31', rfqVersionNumber: 2 }, { ...rfq, state: 'published' }, '2026-11-25')[0]).toMatch(/Close/);
  });
});
