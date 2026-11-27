import { describe, expect, it } from 'vitest';
import {
  appealProblems, caseClock, caseMachine, caseQueueOrder, caseTypeForDiscrepancy, counterpartVisible, DEFAULT_CASES_CONFIG, DEFAULT_LIQUIDITY_CONFIG,
  DEFAULT_PERFORMANCE_CONFIG, DEFAULT_PROCUREMENT_CONFIG, DEFAULT_REVIEWS_CONFIG, defaultSeverity, deliveryRecordScore, getMarket, isSafetyCase, liquidityReport,
  matchProviders, providerPerformance, ratingProblems, rankingFactors, responseDueAt, reviewEligibilityFor, reviewSummary, rfqLiquidity, staffConflict,
  standingOutcome, weekOf,
  type CaseTimes, type LiquidityRfq, type PerformanceInputs, type ProviderCandidate,
} from '../src/index';

const cfg = DEFAULT_CASES_CONFIG;
const at = (s: string) => new Date(s);

describe('case state machine (§9.10)', () => {
  it('runs open → triaged → awaiting party → investigation → proposal → decision → appeal → final', () => {
    let s = caseMachine.next('open', 'triage');
    s = caseMachine.next(s, 'request_info');
    expect(s).toBe('awaiting_party');
    s = caseMachine.next(s, 'party_reply');
    expect(s).toBe('under_investigation');
    s = caseMachine.next(s, 'propose');
    s = caseMachine.next(s, 'decide');
    expect(s).toBe('resolved');
    s = caseMachine.next(s, 'appeal');
    s = caseMachine.next(s, 'take_appeal');
    expect(s).toBe('under_appeal_review');
    expect(caseMachine.next(s, 'decide_appeal')).toBe('final');
  });

  it('cannot decide without a proposal, appeal twice, or reopen a final case', () => {
    expect(caseMachine.can('triaged', 'decide')).toBe(false);
    expect(caseMachine.can('appealed', 'appeal')).toBe(false);
    expect(caseMachine.can('under_appeal_review', 'appeal')).toBe(false);
    expect(caseMachine.commandsFrom('final')).toEqual([]);
    // An unappealed decision becomes final when the window lapses.
    expect(caseMachine.next('resolved', 'close')).toBe('final');
  });

  it('classifies contested discrepancies and treats unsafe work as a safety case', () => {
    expect(caseTypeForDiscrepancy('shortage')).toBe('non_delivery');
    expect(caseTypeForDiscrepancy('damaged')).toBe('damage');
    expect(caseTypeForDiscrepancy('wrong_spec')).toBe('substandard_product');
    expect(defaultSeverity('unsafe_work')).toBe('S1');
    expect(isSafetyCase('unsafe_work')).toBe(true);
    expect(isSafetyCase('damage', 'S3')).toBe(false);
    expect(isSafetyCase('damage', 'S1')).toBe(true);
    expect(cfg.emergencyMessage).toMatch(/112/);
  });
});

describe('response targets (§13.3)', () => {
  it('runs S1 on the clock, 24/7', () => {
    // Saturday 02:00 local is still one hour.
    expect(responseDueAt(at('2026-11-28T01:00:00Z'), 'S1', cfg).toISOString()).toBe('2026-11-28T02:00:00.000Z');
  });

  it('counts business hours only for S2–S4 (Lagos time, Mon–Fri 08:00–17:00)', () => {
    // Friday 16:00 local: one hour on Friday, three on Monday → Monday 11:00 local (10:00Z).
    expect(responseDueAt(at('2026-11-27T15:00:00Z'), 'S2', cfg).toISOString()).toBe('2026-11-30T10:00:00.000Z');
    // Saturday: a business day from Monday 08:00 → Monday 17:00 local.
    expect(responseDueAt(at('2026-11-28T10:00:00Z'), 'S3', cfg).toISOString()).toBe('2026-11-30T16:00:00.000Z');
    // Before opening on a weekday: starts at 08:00.
    expect(responseDueAt(at('2026-11-30T05:00:00Z'), 'S2', cfg).toISOString()).toBe('2026-11-30T11:00:00.000Z');
    // S4: three business days from Monday 08:00 → Wednesday 17:00 local.
    expect(responseDueAt(at('2026-11-30T07:00:00Z'), 'S4', cfg).toISOString()).toBe('2026-12-02T16:00:00.000Z');
  });

  it('flags overdue responses and orders the queue: safety, overdue, soonest due', () => {
    const base: CaseTimes = { state: 'open', severity: 'S3', openedAt: '2026-11-20T08:00:00Z', responseDueAt: '2026-11-21T08:00:00Z', firstResponseAt: null, decidedAt: null, appealedAt: null };
    const now = at('2026-11-22T00:00:00Z');
    expect(caseClock(base, now, cfg).responseOverdue).toBe(true);
    expect(caseClock({ ...base, firstResponseAt: '2026-11-20T09:00:00Z' }, now, cfg).responseOverdue).toBe(false);
    const q = caseQueueOrder([
      { ...base, id: 'later', responseDueAt: '2026-11-25T08:00:00Z' },
      { ...base, id: 'overdue' },
      { ...base, id: 'safety', severity: 'S1', responseDueAt: '2026-11-23T08:00:00Z' },
      { ...base, id: 'low', severity: 'S4', responseDueAt: '2026-11-21T00:00:00Z' },
    ], now);
    expect(q.map((c) => c.id)).toEqual(['safety', 'overdue', 'later', 'low']);
  });
});

describe('appeals: once, in time, decided by someone else', () => {
  const decided: CaseTimes & { appealedBy: string | null } = { state: 'resolved', severity: 'S3', openedAt: '2026-11-01T08:00:00Z', responseDueAt: null, firstResponseAt: null, decidedAt: '2026-11-10T08:00:00Z', appealedAt: null, appealedBy: null };
  it('lets a party appeal within the window, once', () => {
    expect(appealProblems(decided, true, at('2026-11-20T00:00:00Z'), cfg)).toEqual([]);
    expect(appealProblems(decided, false, at('2026-11-20T00:00:00Z'), cfg)[0]).toMatch(/Only the client or the supplier/);
    expect(appealProblems(decided, true, at('2026-11-25T00:00:00Z'), cfg)[0]).toMatch(/within 14 days/);
    expect(appealProblems({ ...decided, state: 'appealed', appealedAt: '2026-11-11T00:00:00Z', appealedBy: 'u' }, true, at('2026-11-12T00:00:00Z'), cfg)[0]).toMatch(/once/);
    expect(appealProblems({ ...decided, state: 'under_investigation', decidedAt: null }, true, at('2026-11-12T00:00:00Z'), cfg)[0]).toMatch(/no decision/);
  });

  it('keeps the decider off the appeal', () => {
    expect(staffConflict('take_appeal', 'ada', { decidedBy: 'ada', appealReviewer: null })).toMatch(/different staff member/);
    expect(staffConflict('decide_appeal', 'ada', { decidedBy: 'ada', appealReviewer: 'ada' })).toMatch(/different staff member/);
    expect(staffConflict('take_appeal', 'bayo', { decidedBy: 'ada', appealReviewer: null })).toBeNull();
    expect(staffConflict('decide_appeal', 'chi', { decidedBy: 'ada', appealReviewer: 'bayo' })).toMatch(/Another staff member/);
    expect(staffConflict('decide', 'ada', { decidedBy: null, appealReviewer: null })).toBeNull();
  });

  it('reports the outcome that stands', () => {
    expect(standingOutcome({ outcome: 'provider_upheld', appealOutcome: 'overturned', appealNewOutcome: 'client_upheld' })).toBe('client_upheld');
    expect(standingOutcome({ outcome: 'provider_upheld', appealOutcome: 'upheld', appealNewOutcome: null })).toBe('provider_upheld');
  });
});

describe('transaction reviews (§13.4)', () => {
  const order = { state: 'fulfilled' as const, confirmedAt: '2026-11-01T00:00:00Z', fulfilledAt: '2026-11-10T00:00:00Z', closedAt: null, updatedAt: '2026-11-10T00:00:00Z' };
  it('opens after completion or termination, once, within the window', () => {
    expect(reviewEligibilityFor({ ...order, state: 'confirmed', fulfilledAt: null }, false, at('2026-11-11T00:00:00Z'), DEFAULT_REVIEWS_CONFIG).ok).toBe(false);
    expect(reviewEligibilityFor(order, false, at('2026-11-11T00:00:00Z'), DEFAULT_REVIEWS_CONFIG)).toEqual({ ok: true, closesAt: '2026-12-10T00:00:00.000Z' });
    expect(reviewEligibilityFor(order, true, at('2026-11-11T00:00:00Z'), DEFAULT_REVIEWS_CONFIG)).toMatchObject({ ok: false, reason: expect.stringMatching(/once/) });
    expect(reviewEligibilityFor(order, false, at('2026-12-11T00:00:00Z'), DEFAULT_REVIEWS_CONFIG)).toMatchObject({ ok: false, reason: expect.stringMatching(/close 30 days/) });
    // Terminated: cancelled after confirmation counts; cancelled before it does not.
    expect(reviewEligibilityFor({ ...order, state: 'cancelled', fulfilledAt: null }, false, at('2026-11-11T00:00:00Z'), DEFAULT_REVIEWS_CONFIG).ok).toBe(true);
    expect(reviewEligibilityFor({ ...order, state: 'cancelled', confirmedAt: null, fulfilledAt: null }, false, at('2026-11-11T00:00:00Z'), DEFAULT_REVIEWS_CONFIG).ok).toBe(false);
  });

  it('checks each side has its own dimensions, 1 to 5', () => {
    expect(ratingProblems('client', { quality: 5, timeliness: 4, communication: 4, accuracy: 5 })).toEqual([]);
    expect(ratingProblems('client', { quality: 5, timeliness: 4, communication: 4 })[0]).toMatch(/accuracy/);
    expect(ratingProblems('provider', { communication: 6, timeliness: 4, accuracy: 4 })[0]).toMatch(/1 to 5/);
    expect(ratingProblems('provider', { communication: 4, timeliness: 4, accuracy: 4, quality: 3 })[0]).toMatch(/Unknown/);
  });

  it('hides the other side until both reviewed or the window closed, and shows small samples as counts', () => {
    expect(counterpartVisible(false, '2026-12-10T00:00:00Z', at('2026-11-20T00:00:00Z'))).toBe(false);
    expect(counterpartVisible(true, '2026-12-10T00:00:00Z', at('2026-11-20T00:00:00Z'))).toBe(true);
    expect(counterpartVisible(false, '2026-12-10T00:00:00Z', at('2026-12-11T00:00:00Z'))).toBe(true);
    const r = { ratings: { quality: 4, timeliness: 5, communication: 3, accuracy: 4 } };
    expect(reviewSummary([r, r], 5)).toMatchObject({ count: 2, enough: false, overall: null });
    expect(reviewSummary([r, r, r, r, r], 5)).toMatchObject({ count: 5, enough: true, overall: 4 });
  });
});

describe('provider performance', () => {
  const d = (scheduledDate: string, arrivedAt: string | null, discrepancies = 0, inspected = true) => ({ scheduledDate, state: inspected ? (discrepancies ? 'discrepancy_raised' : 'inspected_ok') : 'arrived', arrivedAt, inspected, discrepancies });
  const inputs = (n: number): PerformanceInputs => ({
    deliveries: Array.from({ length: n }, (_, i) => d('2026-11-10', i === 0 ? '2026-11-11T09:00:00Z' : '2026-11-10T09:00:00Z', i === 1 ? 1 : 0)),
    invoices: Array.from({ length: n }, (_, i) => ({ state: i === 0 ? 'awaiting_approval' : 'matched', matchStatus: i === 0 ? 'variance' as const : 'matched' as const })),
    invitations: Array.from({ length: n }, (_, i) => ({ invitedAt: '2026-11-01T08:00:00Z', respondedAt: `2026-11-0${1 + i}T20:00:00Z`, state: 'quoted' })),
    quotes: Array.from({ length: n }, (_, i) => ({ state: i === 0 ? 'withdrawn' : 'submitted', withdrawn: i === 0, validUntil: '2026-12-01', rfqDeadline: '2026-11-20T12:00:00Z' })),
  });

  it('computes each figure from slice 1 and 2 records', () => {
    const p = providerPerformance(inputs(5), DEFAULT_PERFORMANCE_CONFIG);
    const m = Object.fromEntries(p.metrics.map((x) => [x.key, x]));
    expect(m.onTimeDelivery).toMatchObject({ sample: 5, count: 4, value: 0.8, enough: true });
    expect(m.onTimeDelivery!.display).toBe('80% (4 of 5 deliveries on the booked day)');
    expect(m.discrepancyRate).toMatchObject({ count: 1, value: 0.2, higherIsBetter: false });
    expect(m.invoiceMatch).toMatchObject({ count: 4, value: 0.8 });
    expect(m.quoteReliability).toMatchObject({ count: 4, value: 0.8 });
    // Response hours: 12, 36, 60, 84, 108 → median 60 h; 2 within 48 h.
    expect(m.quoteResponseTime).toMatchObject({ value: 60, count: 2, enough: true });
    expect(p.summary).toMatchObject({ onTimeRate: 0.8, discrepancyRate: 0.2, invoiceMatchRate: 0.8, quoteReliability: 0.8, deliveries: 5 });
  });

  it('uses local time for the booked day', () => {
    // 23:30Z on the 10th is 00:30 on the 11th in Lagos: late.
    const p = providerPerformance({ deliveries: [d('2026-11-10', '2026-11-10T23:30:00Z')], invoices: [], invitations: [], quotes: [] }, { ...DEFAULT_PERFORMANCE_CONFIG, minSample: 1 });
    expect(p.metrics[0]!.count).toBe(0);
  });

  it('shows small samples as counts, not scores, and keeps them out of ranking', () => {
    const p = providerPerformance(inputs(2), DEFAULT_PERFORMANCE_CONFIG);
    expect(p.metrics.every((x) => x.value === null && !x.enough)).toBe(true);
    expect(p.metrics[0]!.display).toBe('1 of 2 deliveries on the booked day: too few to score');
    expect(providerPerformance({ deliveries: [], invoices: [], invitations: [], quotes: [] }, DEFAULT_PERFORMANCE_CONFIG).metrics[0]!.display).toBe('No records yet');
    expect(deliveryRecordScore(p.summary)).toEqual({ value: 0.5, detail: '2 deliveries so far: too few to score (neutral)' });
    expect(deliveryRecordScore(providerPerformance(inputs(5), DEFAULT_PERFORMANCE_CONFIG).summary).value).toBeCloseTo((0.8 + 0.8 + 0.8) / 3, 3);
  });

  it('feeds the delivery record and quote reliability into RFQ ranking', () => {
    const req = { categorySlug: 'cement', categoryName: 'Cement', areaCode: 'hilltop', areaLabel: 'Hilltop', rfqType: 'material' as const, deadline: '2026-12-20T12:00:00Z' };
    const cand = (orgId: string, perf: PerformanceInputs | null): ProviderCandidate => ({
      orgId, name: orgId, handle: orgId, active: true,
      listings: [{ areaCode: 'hilltop', serviceAreas: [], distanceKm: 0, perBaseMinor: null, matchesSpec: true }],
      checks: [{ type: 'business_registration', state: 'passed', checkedAt: '2026-01-01T00:00:00Z', expiresAt: null }],
      stats: { invitations: 5, responses: 5, awards: 1, replyRatePct: null, reviewAverage: null, reviewCount: 0, performance: perf ? providerPerformance(perf, DEFAULT_PERFORMANCE_CONFIG).summary : null },
      marketMedianPerBase: null,
    });
    const good = inputs(5);
    good.deliveries = good.deliveries.map((x) => ({ ...x, arrivedAt: '2026-11-09T09:00:00Z', discrepancies: 0 }));
    const bad = inputs(5);
    bad.deliveries = bad.deliveries.map((x) => ({ ...x, arrivedAt: '2026-11-15T09:00:00Z', discrepancies: 1 }));
    const r = matchProviders([cand('late', bad), cand('new', null), cand('punctual', good)], req, DEFAULT_PROCUREMENT_CONFIG);
    expect(r.rankingVersion).toBe('match-2026.2');
    expect(r.eligible.map((e) => e.orgId)).toEqual(['punctual', 'new', 'late']);
    const factor = (id: string) => r.eligible.find((e) => e.orgId === id)!.factors.find((f) => f.key === 'deliveryRecord')!;
    expect(factor('new')).toMatchObject({ value: 0.5, detail: 'No completed deliveries yet (neutral score)' });
    expect(factor('punctual').detail).toMatch(/100% on time/);
    const rel = rankingFactors(cand('late', bad), req, DEFAULT_PROCUREMENT_CONFIG).find((f) => f.key === 'responseReliability')!;
    expect(rel.detail).toMatch(/kept 80% of quotes/);
    expect(rel.value).toBeCloseTo(0.6 * 1 + 0.4 * 0.8, 3);
    expect(Object.values(DEFAULT_PROCUREMENT_CONFIG.rankingWeights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  });
});

describe('liquidity (R3 exit gate)', () => {
  const pub = '2026-11-02T09:00:00Z';
  const rfq = (id: string, responses: [string, number, boolean][], over: Partial<LiquidityRfq> = {}): LiquidityRfq => {
    const publishedAt = over.publishedAt ?? pub;
    return {
      id, categorySlug: 'cement', categoryName: 'Cement', areaCode: 'hilltop', areaLabel: 'Hilltop', ...over, publishedAt,
      responses: responses.map(([p, h, l]) => ({ providerOrgId: p, submittedAt: new Date(new Date(publishedAt).getTime() + h * 3_600_000).toISOString(), likeForLike: l })),
    };
  };
  const now = at('2026-11-20T00:00:00Z');

  it('counts distinct providers with a like-for-like response inside 72 hours', () => {
    expect(rfqLiquidity(rfq('a', [['p1', 5, true], ['p2', 30, true], ['p3', 71, true]]), DEFAULT_LIQUIDITY_CONFIG, now)).toMatchObject({ comparable: 3, met: true, hoursToTarget: 71 });
    // A late response, a non-comparable one and a second version from the same provider do not count.
    expect(rfqLiquidity(rfq('b', [['p1', 5, true], ['p1', 6, true], ['p2', 10, false], ['p3', 80, true]]), DEFAULT_LIQUIDITY_CONFIG, now)).toMatchObject({ comparable: 1, responses: 2, met: false });
    // Still inside the window and short of the target: pending.
    expect(rfqLiquidity(rfq('c', [['p1', 5, true]]), DEFAULT_LIQUIDITY_CONFIG, at('2026-11-03T00:00:00Z')).met).toBeNull();
  });

  it('reports the share by category, area and week, with small cells as counts', () => {
    const met = (id: string, over: Partial<LiquidityRfq> = {}) => rfq(id, [['p1', 1, true], ['p2', 2, true], ['p3', 3, true]], over);
    const rfqs = [met('1'), met('2'), met('3'), met('4'), rfq('5', [['p1', 1, true]]), met('6', { categorySlug: 'rebar', categoryName: 'Rebar', areaCode: 'harbour', areaLabel: 'Harbour', publishedAt: '2026-11-10T09:00:00Z' })];
    const r = liquidityReport(rfqs, DEFAULT_LIQUIDITY_CONFIG, now);
    expect(r.overall).toMatchObject({ decided: 6, met: 5, sharePct: 83.3, meetsTarget: true });
    expect(r.gate).toMatchObject({ met: true, text: expect.stringMatching(/83.3% of requests got 3 or more comparable responses within 72 hours \(target 80%\)/) });
    expect(r.byCategory[0]).toMatchObject({ key: 'cement', decided: 5, met: 4, sharePct: 80 });
    expect(r.byCategory[1]).toMatchObject({ key: 'rebar', decided: 1, sharePct: null, enough: false });
    expect(r.byArea.map((c) => c.key)).toEqual(['hilltop', 'harbour']);
    expect(r.byWeek.map((c) => c.key)).toEqual(['2026-11-02', '2026-11-09']);
    expect(weekOf('2026-11-08T23:00:00Z')).toBe('2026-11-02');
    const few = liquidityReport([met('1')], DEFAULT_LIQUIDITY_CONFIG, now);
    expect(few.gate.met).toBe(false);
    expect(few.gate.text).toMatch(/Not enough decided requests/);
  });
});

describe('market pack', () => {
  it('carries the slice 3 values', () => {
    const p = getMarket('demo-2026.1');
    expect(p.cases.responseTargets.S1).toEqual({ minutes: 60, businessHours: false });
    expect(p.reviews.windowDays).toBeGreaterThan(0);
    expect(p.performance.minSample).toBeGreaterThan(1);
    expect(p.liquidity).toMatchObject({ minComparableResponses: 3, windowHours: 72, targetPct: 80 });
  });
});
