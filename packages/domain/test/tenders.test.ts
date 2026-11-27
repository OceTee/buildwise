import { describe, expect, it } from 'vitest';
import {
  approvalBlockers, contractCloseBlockers, contractFulfilmentCommand, criteriaWeightsValid, DEMO_MARKET, EMPTY_TENDER_RESPONSE, entriesInForce, evaluateBids,
  lateAnswerWarning, listEntryProblems, matchProviders, milestoneMachine, milestonePayable, MILESTONE_ACTOR, nextRevision, openingBlocker, openingRecord,
  packageProblems, pricesSealed, questionBlocker, relatedGroups, responseProblems, retentionOf, milestoneScheduleProblems, scheduleSummary, scoreProblems, sourcingScreen,
  variationLinesTotal, variationMachine, VARIATION_ACTOR, variationProblems, visibleClarifications, withdrawalBlocker,
  type MatchRequest, type ProviderCandidate, type SealState, type SourcingPolicy, type SupplierListEntry, type TenderPackage,
} from '../src/index';

const T = DEMO_MARKET.tenders;
const C = DEMO_MARKET.contracts;
const S = DEMO_MARKET.sourcing;

const pkg = (over: Partial<TenderPackage> = {}): TenderPackage => ({
  scope: 'Plumbing first and second fix for a four-bedroom bungalow, including the septic connection.', siteVisitRequired: true, siteVisitNote: 'Call the site manager.',
  startDate: '2027-01-10', finishDate: '2027-03-07', conditions: null, requiredChecks: ['trade_reference'], retentionPct: 5, responseFields: ['programme', 'method', 'inclusions', 'qualifications', 'defects'], documents: [], ...over,
});

describe('tender package and response (§10.5 steps 1, 3)', () => {
  it('checks the package', () => {
    expect(packageProblems(pkg(), T, '2026-11-27')).toEqual([]);
    const p = packageProblems(pkg({ scope: 'Pipes', finishDate: '2027-01-01', retentionPct: 25, siteVisitNote: null, responseFields: [] }), T, '2026-11-27');
    expect(p).toEqual(expect.arrayContaining([expect.stringMatching(/scope/), expect.stringMatching(/finish date/), expect.stringMatching(/Retention/), expect.stringMatching(/site visit/), expect.stringMatching(/at least one/)]));
    expect(criteriaWeightsValid(T)).toBe(true);
  });

  it('asks for every requested part of the response and the bidder’s conflict declaration', () => {
    const missing = responseProblems(pkg(), EMPTY_TENDER_RESPONSE);
    expect(missing).toEqual(expect.arrayContaining([expect.stringMatching(/programme/), expect.stringMatching(/method/), expect.stringMatching(/includes/), expect.stringMatching(/qualifications/), expect.stringMatching(/defects/), expect.stringMatching(/visited the site/), expect.stringMatching(/conflict/)]));
    const full = { ...EMPTY_TENDER_RESPONSE, startDate: '2027-01-10', programmeWeeks: 8, method: 'Survey, first fix, pressure test, second fix, commission.', inclusions: ['Fittings'], qualifications: 'Ten years of domestic plumbing, references attached.', defectsTerms: '12 months', siteVisitConfirmed: true, conflict: { declared: false, details: null } };
    expect(responseProblems(pkg(), full)).toEqual([]);
    expect(responseProblems(pkg(), { ...full, conflict: { declared: true, details: null } })).toEqual([expect.stringMatching(/Describe the conflict/)]);
  });
});

describe('sealing, withdrawal and opening (§19.2, D-14)', () => {
  const now = Date.parse('2026-12-01T12:00:00Z');
  const tender = (over: Partial<SealState> = {}): SealState => ({ kind: 'tender', sealed: true, state: 'published', deadline: '2026-12-01T17:00:00Z', openedAt: null, ...over });

  it('keeps tender bids sealed until the opening record, even after the deadline', () => {
    expect(pricesSealed(tender(), now)).toBe(true);
    expect(pricesSealed(tender({ deadline: '2026-12-01T10:00:00Z' }), now)).toBe(true);
    expect(pricesSealed(tender({ deadline: '2026-12-01T10:00:00Z', state: 'closed', openedAt: '2026-12-01T11:00:00Z' }), now)).toBe(false);
    // A sealed RFQ opens at its deadline; an open RFQ was never sealed.
    expect(pricesSealed({ ...tender(), kind: 'rfq' }, now)).toBe(true);
    expect(pricesSealed({ ...tender({ deadline: '2026-12-01T10:00:00Z' }), kind: 'rfq' }, now)).toBe(false);
    expect(pricesSealed({ ...tender(), kind: 'rfq', sealed: false }, now)).toBe(false);
  });

  it('lets bidders withdraw only before the deadline, and opens only at or after it', () => {
    expect(withdrawalBlocker(tender(), now)).toBeNull();
    expect(withdrawalBlocker(tender({ deadline: '2026-12-01T11:00:00Z' }), now)).toMatch(/before the deadline/);
    expect(openingBlocker(tender(), now)).toMatch(/sealed until the deadline/);
    expect(openingBlocker(tender({ deadline: '2026-12-01T11:00:00Z' }), now)).toBeNull();
    expect(openingBlocker(tender({ deadline: '2026-12-01T11:00:00Z', openedAt: '2026-12-01T11:30:00Z' }), now)).toMatch(/already opened/);
    expect(openingBlocker({ ...tender(), kind: 'rfq' }, now)).toMatch(/Only tenders/);
  });

  it('writes an opening register of live bids in submission order, naming withdrawals and silence', () => {
    const base = { quoteId: 'q', versionNumber: 1, snapshotHash: 'h', grossMinor: '100' };
    const r = openingRecord({
      rfqId: 'r', reference: 'TND-001', deadline: '2026-12-01T17:00:00.000Z', openedAt: '2026-12-01T17:05:00.000Z', openedBy: 'system',
      bids: [
        { ...base, versionId: 'v2', providerOrgId: 'b', providerName: 'Bravo', state: 'submitted', submittedAt: '2026-12-01T09:00:00.000Z' },
        { ...base, versionId: 'v1', providerOrgId: 'a', providerName: 'Alpha', state: 'submitted', submittedAt: '2026-11-30T09:00:00.000Z' },
        { ...base, versionId: 'v3', providerOrgId: 'c', providerName: 'Charlie', state: 'withdrawn', submittedAt: '2026-11-30T10:00:00.000Z' },
        { ...base, versionId: null, providerOrgId: 'd', providerName: 'Delta', state: 'none', submittedAt: null },
        { ...base, versionId: null, providerOrgId: 'e', providerName: 'Echo', state: 'declined', submittedAt: null },
      ],
    }, T);
    expect(r.bids.map((b) => b.providerName)).toEqual(['Alpha', 'Bravo']);
    expect(r.withdrawn.map((x) => x.providerName)).toEqual(['Charlie']);
    expect(r.noResponse.map((x) => x.providerName)).toEqual(['Delta']);
    expect(r.declined.map((x) => x.providerName)).toEqual(['Echo']);
    expect(r).toMatchObject({ competition: 'competitive', note: '2 bids opened together at the deadline.' });
    expect(openingRecord({ rfqId: 'r', reference: 'x', deadline: 'z', openedAt: 'z', openedBy: 'u', bids: [] }, T).competition).toBe('none');
  });
});

describe('clarifications shared with every bidder (§10.5 step 5)', () => {
  const list = [
    { id: '1', askedByOrgId: 'a', question: 'Is the septic tank in scope?', answer: 'Yes', answeredAt: '2026-11-28', createdAt: '2026-11-27' },
    { id: '2', askedByOrgId: 'b', question: 'Can we visit on Sunday?', answer: null, answeredAt: null, createdAt: '2026-11-27' },
    { id: '3', askedByOrgId: null, question: 'Addendum 1', answer: 'Use PPR pipes', answeredAt: '2026-11-28', createdAt: '2026-11-28' },
  ];
  it('shows answered questions to every bidder without who asked, and unanswered ones only to the asker', () => {
    const forB = visibleClarifications(list, { side: 'provider', orgId: 'b' });
    expect(forB.map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(forB.every((c) => c.askedByOrgId === null)).toBe(true);
    expect(forB.find((c) => c.id === '2')!.mine).toBe(true);
    expect(visibleClarifications(list, { side: 'provider', orgId: 'c' }).map((c) => c.id)).toEqual(['1', '3']);
    expect(visibleClarifications(list, { side: 'client' }).map((c) => c.askedByOrgId)).toEqual(['a', 'b', null]);
  });
  it('closes questions before the deadline and warns about late answers', () => {
    const now = Date.parse('2026-12-01T00:00:00Z');
    expect(questionBlocker('2026-12-05T00:00:00Z', T, now)).toBeNull();
    expect(questionBlocker('2026-12-02T00:00:00Z', T, now)).toMatch(/48 hours/);
    expect(lateAnswerWarning('2026-12-02T12:00:00Z', T, now)).toMatch(/extending/);
    expect(lateAnswerWarning('2026-12-10T00:00:00Z', T, now)).toBeNull();
  });
});

describe('evaluation (§10.5 step 4)', () => {
  const col = (id: string, gross: string, likeForLike = true) => ({ quoteId: id, providerName: id.toUpperCase(), likeForLike, totals: { linesMinor: gross, deliveryMinor: '0', taxMinor: '0', grossMinor: gross } });
  const all = (evaluator: string, quote: string, s: number) => T.criteria.map((c) => ({ evaluatorId: evaluator, quoteId: quote, criterion: c.key, score: s }));

  it('scores price only among like-for-like bids and ignores evaluators with a declared conflict', () => {
    const r = evaluateBids([col('a', '1000000'), col('b', '800000'), col('c', '500000', false)],
      [...all('e1', 'a', 5), ...all('e1', 'b', 3), ...all('e1', 'c', 5), ...all('e2', 'a', 0), ...all('e2', 'b', 0)],
      [{ evaluatorId: 'e1', conflict: false }, { evaluatorId: 'e2', conflict: true }], T);
    const by = Object.fromEntries(r.bids.map((b) => [b.quoteId, b]));
    expect(by.b!.priceScore).toBe(1);
    expect(by.a!.priceScore).toBe(0.8);
    expect(by.c!.priceScore).toBeNull();
    expect(by.c!.total).toBeNull();
    expect(by.c!.notes[0]).toMatch(/not scored on price/);
    // a: 0.6 * 0.8 + 0.4 * 1 = 0.88; b: 0.6 * 1 + 0.4 * 0.6 = 0.84 (e2's zeros do not count).
    expect(by.a!.total).toBe(0.88);
    expect(by.b!.total).toBe(0.84);
    expect([by.a!.rank, by.b!.rank]).toEqual([1, 2]);
    expect(r).toMatchObject({ evaluators: 1, excluded: 1 });
  });
  it('needs declarations before any score counts, and bounded scores', () => {
    expect(evaluateBids([col('a', '1')], all('e1', 'a', 4), [], T).note).toMatch(/declared/);
    expect(scoreProblems([{ criterion: 'method', score: 7 }, { criterion: 'nope', score: 1 }], T)).toHaveLength(2);
  });
});

describe('client lists and sourcing modes (§13.1.5, §10.4 step 2)', () => {
  const req: MatchRequest = { categorySlug: 'plumbing', categoryName: 'Plumbing', areaCode: 'hilltop', areaLabel: 'Hilltop', rfqType: 'trade', deadline: '2026-12-10T17:00:00Z' };
  const cand = (id: string, over: Partial<ProviderCandidate> = {}): ProviderCandidate => ({
    orgId: id, name: id.toUpperCase(), handle: id, active: true, listings: [{ areaCode: 'hilltop', serviceAreas: [], distanceKm: 0, perBaseMinor: null, matchesSpec: true }],
    checks: [], stats: { invitations: 0, responses: 0, awards: 0, replyRatePct: null, reviewAverage: null, reviewCount: 0 }, marketMedianPerBase: null, ...over,
  });
  const entry = (providerOrgId: string, kind: SupplierListEntry['kind'], over: Partial<SupplierListEntry> = {}): SupplierListEntry => ({ id: `${providerOrgId}-${kind}`, providerOrgId, kind, categorySlugs: [], validFrom: null, validUntil: null, reason: 'Noted', ...over });
  const policy = (over: Partial<SourcingPolicy> = {}): SourcingPolicy => ({ mode: 'open', categorySlug: 'plumbing', deadline: req.deadline, lists: [], nominated: [], conflicts: {}, ...over });
  const run = (cands: ProviderCandidate[], p: SourcingPolicy) => matchProviders(cands, req, DEMO_MARKET.procurement, { screen: sourcingScreen(p, S), sourcingMode: p.mode });

  it('keeps blocked and conflicted suppliers out and lists preferred ones first', () => {
    const r = run([cand('a'), cand('b'), cand('c'), cand('d'), cand('e')], policy({
      lists: [entry('a', 'blocked', { reason: 'Walked off site' }), entry('b', 'conflict', { reason: 'Owned by my brother' }), entry('e', 'preferred')],
      conflicts: { c: { sharedMembers: ['Mia Manager'], reviewedSourceEstimate: false, relatedTo: [] }, d: { sharedMembers: [], reviewedSourceEstimate: true, relatedTo: [] } },
    }));
    expect(r.eligible.map((e) => e.orgId)).toEqual(['e']);
    expect(r.eligible[0]!.labels).toContain('Preferred supplier');
    const why = Object.fromEntries(r.ineligible.map((x) => [x.orgId, x.reasons.join(' ')]));
    expect(why.a).toMatch(/blocked list: Walked off site/);
    expect(why.b).toMatch(/Declared conflict of interest: Owned by my brother/);
    expect(why.c).toMatch(/Mia Manager is on your project team/);
    expect(why.d).toMatch(/reviewed the estimate/);
  });

  it('warns about related bidders without excluding them', () => {
    const r = run([cand('a'), cand('b')], policy({ conflicts: { a: { sharedMembers: [], reviewedSourceEstimate: false, relatedTo: ['B'] }, b: { sharedMembers: [], reviewedSourceEstimate: false, relatedTo: ['A'] } } }));
    expect(r.eligible).toHaveLength(2);
    expect(r.eligible[0]!.warnings[0]).toMatch(/may not be independent/);
    expect([...relatedGroups([{ orgId: 'a', userId: 'u' }, { orgId: 'b', userId: 'u' }, { orgId: 'c', userId: 'v' }]).entries()]).toEqual([['a', ['b']], ['b', ['a']]]);
  });

  it('approved-supplier mode invites only approvals in force for the category at the deadline', () => {
    const r = run([cand('a'), cand('b'), cand('c'), cand('d')], policy({
      mode: 'framework',
      lists: [entry('a', 'approved', { categorySlugs: ['plumbing'] }), entry('b', 'approved', { categorySlugs: ['roofing'] }), entry('c', 'approved', { validUntil: '2026-12-05' })],
    }));
    expect(r.eligible.map((e) => e.orgId)).toEqual(['a']);
    expect(r.eligible[0]!.labels[0]).toMatch(/Approved supplier/);
    const why = Object.fromEntries(r.ineligible.map((x) => [x.orgId, x.reasons.join(' ')]));
    expect(why.b).toMatch(/Not on your approved supplier list/);
    expect(why.c).toMatch(/ends before the deadline/);
    expect(why.d).toMatch(/Not on your approved/);
  });

  it('nominated mode waives category coverage but never the required checks or the client’s blocks', () => {
    const cfg = { ...DEMO_MARKET.procurement, requiredChecks: { ...DEMO_MARKET.procurement.requiredChecks, trade: ['business_registration' as const] } };
    const ok = { type: 'business_registration' as const, state: 'passed' as const, checkedAt: '2026-01-01T00:00:00Z', expiresAt: null };
    const p = policy({ mode: 'nominated', nominated: ['a', 'b', 'c'], lists: [entry('c', 'blocked')] });
    const r = matchProviders([cand('a', { listings: [], checks: [ok] }), cand('b', { listings: [] }), cand('c', { checks: [ok] }), cand('d', { checks: [ok] })], req, cfg, { screen: sourcingScreen(p, S), sourcingMode: 'nominated' });
    expect(r.eligible.map((e) => e.orgId)).toEqual(['a']);
    expect(r.eligible[0]!.labels).toContain('Named by you');
    expect(r.eligible[0]!.warnings.join(' ')).toMatch(/No live listing in Plumbing/);
    const why = Object.fromEntries(r.ineligible.map((x) => [x.orgId, x.reasons.join(' ')]));
    expect(why.b).toMatch(/check not passed/);
    expect(why.c).toMatch(/blocked/);
    expect(why.d).toMatch(/Not one of the suppliers you named/);
  });

  it('validates list entries and their dates', () => {
    expect(listEntryProblems({ kind: 'blocked', reason: null, validFrom: null, validUntil: null, categorySlugs: [] }, '2026-11-27')[0]).toMatch(/why/);
    expect(listEntryProblems({ kind: 'approved', reason: null, validFrom: null, validUntil: '2026-01-01', categorySlugs: ['cement'] }, '2026-11-27')[0]).toMatch(/passed/);
    expect(listEntryProblems({ kind: 'conflict', reason: 'Family firm', validFrom: null, validUntil: null, categorySlugs: ['cement'] }, '2026-11-27')[0]).toMatch(/every category/);
    expect(entriesInForce([entry('a', 'approved', { validFrom: '2026-12-01' })], 'a', 'x', '2026-11-30T00:00:00Z')).toEqual([]);
  });
});

describe('milestones (§9.5)', () => {
  it('runs the milestone lifecycle with the client signing off', () => {
    let s = milestoneMachine.next('not_started', 'start');
    s = milestoneMachine.next(s, 'claim');
    expect(s).toBe('awaiting_client');
    expect(milestoneMachine.next(s, 'reject')).toBe('in_progress');
    expect(milestoneMachine.next(s, 'accept')).toBe('complete');
    expect(milestoneMachine.can('complete', 'cancel')).toBe(false);
    expect(milestoneMachine.next('in_progress', 'dispute')).toBe('disputed');
    expect([MILESTONE_ACTOR.claim, MILESTONE_ACTOR.accept, MILESTONE_ACTOR.dispute]).toEqual(['provider', 'client', 'either']);
  });

  it('keeps the schedule within the contract value and pays complete milestones less retention', () => {
    const ms = [
      { id: '1', title: 'Mobilise', amountMinor: 400_000_00n, dueDate: null, state: 'complete' as const, paidMinor: 100_000_00n },
      { id: '2', title: 'First fix', amountMinor: 600_000_00n, dueDate: null, state: 'in_progress' as const, paidMinor: 0n },
    ];
    expect(milestoneScheduleProblems(ms, 1_000_000_00n, C)).toEqual([]);
    expect(milestoneScheduleProblems(ms, 900_000_00n, C)[0]).toMatch(/more than the contract value/);
    expect(retentionOf(400_000_00n, 5)).toBe(20_000_00n);
    expect(milestonePayable(ms[0]!, 5)).toBe(280_000_00n);
    expect(milestonePayable(ms[1]!, 5)).toBe(0n);
    expect(scheduleSummary(ms, 1_200_000_00n, 5)).toMatchObject({ unscheduledMinor: String(200_000_00n), retentionHeldMinor: String(20_000_00n), payableMinor: String(280_000_00n), complete: 1, total: 2 });
  });

  it('fulfils a contract through its milestones', () => {
    const done = { amountMinor: 500n, state: 'complete' as const };
    const open = { amountMinor: 500n, state: 'in_progress' as const };
    expect(contractFulfilmentCommand('confirmed', [open], 1000n)).toBeNull();
    expect(contractFulfilmentCommand('confirmed', [done, open], 1000n)).toBe('fulfil_part');
    expect(contractFulfilmentCommand('partially_fulfilled', [done, done], 1000n)).toBe('fulfil');
    expect(contractFulfilmentCommand('partially_fulfilled', [done], 1000n)).toBeNull();
    expect(contractCloseBlockers('fulfilled', [done], 1)[0]).toMatch(/variations/);
  });
});

describe('variations (§9.6)', () => {
  it('runs proposal → price → review → decision, with negotiation rounds', () => {
    let s = variationMachine.next('proposed', 'assess');
    s = variationMachine.next(s, 'submit');
    expect(s).toBe('under_review');
    expect(variationMachine.next(s, 'return')).toBe('proposed');
    expect(variationMachine.next(s, 'approve')).toBe('approved');
    expect(variationMachine.can('approved', 'withdraw')).toBe(false);
    expect(variationMachine.next(variationMachine.next(variationMachine.next('approved', 'instruct'), 'execute'), 'value')).toBe('valued');
    expect([VARIATION_ACTOR.assess, VARIATION_ACTOR.approve, VARIATION_ACTOR.withdraw]).toEqual(['provider', 'client', 'proposer']);
  });

  it('prices from lines, including omissions, and checks the input', () => {
    const lines = [{ description: 'Extra WC', quantity: '1', unit: 'item', rateMinor: 150_000_00n }, { description: 'Omit bidet', quantity: '-1', unit: 'item', rateMinor: 40_000_00n }];
    expect(variationLinesTotal(lines)).toBe(110_000_00n);
    const v = { title: 'Extra WC', description: 'Add a WC to the guest suite.', reason: 'Client request', costImpactMinor: 110_000_00n, timeImpactDays: 3, lines };
    expect(variationProblems(v, true, C)).toEqual([]);
    expect(variationProblems({ ...v, costImpactMinor: 1n }, true, C)[0]).toMatch(/equal the total/);
    expect(variationProblems({ ...v, costImpactMinor: null, lines: [] }, true, C)[0]).toMatch(/cost impact/);
  });

  it('creates the next award revision and refuses approvals that make no sense', () => {
    const r1 = { number: 1, valueMinor: 1_000_000n, timeDays: 0, completionDate: '2027-03-07', variationId: null, reason: 'Award' };
    expect(nextRevision(r1, { id: 'v', title: 'Extra WC', costImpactMinor: 110_000n, timeImpactDays: 3 })).toMatchObject({ number: 2, valueMinor: 1_110_000n, timeDays: 3, completionDate: '2027-03-10', variationId: 'v' });
    expect(approvalBlockers('confirmed', r1, 1_000_000n, { costImpactMinor: -950_000n, timeImpactDays: 0 }, C)[0]).toMatch(/below 10%/);
    expect(approvalBlockers('placed', r1, 1_000_000n, { costImpactMinor: 1n, timeImpactDays: 0 }, C)[0]).toMatch(/not confirmed/);
    expect(approvalBlockers('confirmed', r1, 1_000_000n, { costImpactMinor: null, timeImpactDays: 0 }, C)[0]).toMatch(/not priced/);
  });
});

