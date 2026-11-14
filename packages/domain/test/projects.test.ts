import { describe, expect, it } from 'vitest';
import {
  calcLine, calibrate, can, canonicalJson, DEMO_MARKET, estimateMachine, formatDec, grantableRoles, indicativeRange, intakeMissing, measure,
  netQuantity, parseDec, parseQuantityCsv, pickRate, readiness, runQa, totals, versionDelta, type LineInput, type RateObservation,
} from '../src/index';

const cfg = DEMO_MARKET.projects;
const now = new Date('2026-11-14T12:00:00Z');

describe('decimals', () => {
  it('parses and formats fixed-point quantities without floating point', () => {
    expect(parseDec('1,250.75')).toBe(1_250_750_000n);
    expect(parseDec('0.1234567')).toBeNull();
    expect(formatDec(parseDec('12.500')!)).toBe('12.5');
    expect(formatDec(parseDec('-3')!)).toBe('-3');
  });
});

describe('project access', () => {
  it('gives each role only its actions', () => {
    expect(can('owner', 'estimate.accept')).toBe(true);
    expect(can('manager', 'estimate.accept')).toBe(false);
    expect(can('viewer', 'documents.upload')).toBe(false);
    expect(can('reviewer', 'payments.read')).toBe(false);
    expect(can('reviewer', 'estimate.review')).toBe(true);
    expect(can(null, 'project.read')).toBe(false);
    expect(grantableRoles('manager')).not.toContain('manager');
  });
});

describe('intake and readiness', () => {
  const brief = { name: 'Family house', buildingUse: 'house', areaCode: 'hilltop', regionCode: 'north', floors: 2, grossFloorAreaM2: '180', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'planning' };
  it('lists missing intake fields', () => {
    expect(intakeMissing({ name: 'x' }).map((m) => m.field)).toContain('buildingUse');
    expect(intakeMissing(brief)).toEqual([]);
  });
  it('needs structural drawings for multi-storey houses and drawings for a reviewed estimate', () => {
    expect(readiness(brief, { drawingCount: 0, disciplines: [] }, cfg).outcome).toBe('needs_professional');
    expect(readiness(brief, { drawingCount: 3, disciplines: ['architectural'] }, cfg).outcome).toBe('needs_professional');
    expect(readiness(brief, { drawingCount: 3, disciplines: ['architectural', 'structural'] }, cfg).outcome).toBe('can_proceed');
    expect(readiness({ ...brief, buildingUse: 'other' }, { drawingCount: 3, disciplines: [] }, cfg).outcome).toBe('cannot_estimate');
  });
  it('gives a coarse indicative range, or says there is not enough local data', () => {
    const r = indicativeRange(brief, DEMO_MARKET, now);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.lowMinor).toBeGreaterThan(0n); expect(r.highMinor).toBeGreaterThan(r.lowMinor); expect(r.lowMinor % 10_000_000n).toBe(0n); }
    const none = indicativeRange({ ...brief, finishBand: 'premium' }, DEMO_MARKET, now);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.reason).toBe('not_enough_local_data');
    const old = indicativeRange(brief, DEMO_MARKET, new Date('2028-01-01'));
    expect(old.ok).toBe(false);
  });
});

describe('takeoff', () => {
  const cal = calibrate({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, knownLength: '5', knownUnit: 'm', check: { a: { x: 0, y: 0 }, b: { x: 0, y: 200 }, knownLength: '10000', knownUnit: 'mm' } }, 2);
  it('calibrates from a known dimension and checks a second one', () => {
    expect(cal.metresPerUnit).toBeCloseTo(0.05);
    expect(() => calibrate({ a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, knownLength: '5', knownUnit: 'm', check: { a: { x: 0, y: 0 }, b: { x: 0, y: 200 }, knownLength: '11', knownUnit: 'm' } }, 2)).toThrow(/disagree/);
  });
  it('measures length, area and volume, and refuses uncalibrated pages', () => {
    const sq = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(formatDec(measure({ kind: 'perimeter', points: sq }, cal).value)).toBe('20');
    expect(formatDec(measure({ kind: 'area', points: sq }, cal).value)).toBe('25');
    expect(formatDec(measure({ kind: 'volume', points: sq, depth: '0.15' }, cal).value)).toBe('3.75');
    expect(measure({ kind: 'count', points: sq }, null).unit).toBe('piece');
    expect(() => measure({ kind: 'area', points: sq }, null)).toThrow(/Calibrate/);
    expect(() => measure({ kind: 'manual', manualValue: '3', manualUnit: 'm' }, null)).toThrow(/how the value/);
  });
  it('keeps gross, deductions and waste separate', () => {
    const r = netQuantity(parseDec('100')!, parseDec('10')!, 5);
    expect(formatDec(r.net)).toBe('94.5');
    expect(formatDec(r.waste)).toBe('4.5');
  });
});

const line = (over: Partial<LineInput> = {}): LineInput => ({
  id: 'l1', section: 'walls', description: '9in blockwork', unit: 'm2', gross: parseDec('120')!, deductions: parseDec('20')!, wastePct: 5,
  rates: { material: parseDec('8500')! * 100n, labour: parseDec('2500')! * 100n }, taxRatePct: 7.5, status: 'measured', quantitySource: 'measurement',
  measurementIds: ['m1'], rate: { sourceClass: 'professional_rate_book', reference: 'Rate book 2026', observedAt: '2026-11-01', validUntil: null }, ...over,
});

describe('estimate arithmetic', () => {
  it('rounds each line once and sums rounded lines', () => {
    const c = calcLine(line());
    expect(formatDec(c.net)).toBe('105');
    expect(c.amountMinor).toBe(105n * 1_100_000n); // 105 m2 × ₦11,000
    expect(c.taxMinor).toBe(8_662_500n);
    const t = totals([line(), line({ id: 'l2', status: 'excluded' })], 10);
    expect(t.netMinor).toBe(115_500_000n);
    expect(t.contingencyMinor).toBe(11_550_000n);
  });
  it('follows the review lifecycle', () => {
    expect(estimateMachine.next('draft', 'submit')).toBe('submitted');
    expect(estimateMachine.can('draft', 'issue')).toBe(false);
    expect(estimateMachine.next('under_review', 'request_information')).toBe('information_required');
    expect(estimateMachine.next('reviewed', 'issue')).toBe('issued');
    expect(estimateMachine.can('accepted', 'withdraw')).toBe(false);
  });
});

describe('rates', () => {
  const obs = (o: Partial<RateObservation>): RateObservation => ({ id: 'r', catalogItemId: 'cement', regionCode: 'north', unit: 'bag', sourceClass: 'advertised_listing_price', rateMinor: 950_000n, observedAt: '2026-11-10', validUntil: null, rateCategory: 'volatile', includesDelivery: false, includesTax: true, reference: 'x', ...o });
  it('prefers a valid higher source class and never uses an expired one', () => {
    const r = pickRate([
      obs({ id: 'a', sourceClass: 'advertised_listing_price', observedAt: '2026-11-13' }),
      obs({ id: 'b', sourceClass: 'supplier_confirmed_quote', observedAt: '2026-11-05' }),
      obs({ id: 'c', sourceClass: 'supplier_confirmed_quote', observedAt: '2026-10-01' }),
    ], { catalogItemId: 'cement', regionCode: 'north', unit: 'bag' }, now, cfg);
    expect(r.best?.id).toBe('b');
    expect(r.stale.map((x) => x.id)).toEqual(['c']);
  });
});

describe('estimate QA', () => {
  const base = { contingencyPct: 10, assumptions: ['Site access by road'], exclusions: ['Furniture'], supersededMeasurementIds: new Set<string>(), previousGrossMinor: null, changeReason: null, requiredSections: ['walls'], secondReviewDone: false, now, cfg };
  it('passes a complete estimate', () => {
    expect(runQa({ ...base, lines: [{ ...line(), rateCategory: 'general' }] }).filter((f) => f.severity === 'blocker')).toEqual([]);
  });
  it('blocks missing sources, stale rates and superseded measurements', () => {
    const f = runQa({ ...base, supersededMeasurementIds: new Set(['m1']), lines: [
      { ...line({ id: 'a', rate: null }), rateCategory: 'general' },
      { ...line({ id: 'b', description: 'cement', rate: { sourceClass: 'manual_estimate', reference: 'x', observedAt: '2026-10-01', validUntil: null } }), rateCategory: 'volatile' },
    ] });
    const codes = f.filter((x) => x.severity === 'blocker').map((x) => x.code);
    expect(codes).toEqual(expect.arrayContaining(['rate_source_missing', 'rate_stale', 'superseded_revision']));
  });
  it('requires a second reviewer above the value threshold and warns on large deltas', () => {
    const big = line({ gross: parseDec('2000000')!, deductions: 0n });
    const f = runQa({ ...base, previousGrossMinor: 1_000n, lines: [{ ...big, rateCategory: 'general' }] });
    expect(f.map((x) => x.code)).toEqual(expect.arrayContaining(['second_review_required', 'large_delta']));
  });
});

describe('versions and import', () => {
  it('summarises line changes between versions', () => {
    const a = [{ ...line(), key: 'k1' }, { ...line({ id: 'x', description: 'Roof' }), key: 'k2' }];
    const b = [{ ...line({ gross: parseDec('130')! }), key: 'k1' }, { ...line({ id: 'y', description: 'Doors' }), key: 'k3' }];
    const d = versionDelta(a, b);
    expect(d.rows.map((r) => r.change).sort()).toEqual(['added', 'changed', 'removed']);
    expect(d.rows.find((r) => r.change === 'changed')!.reasons).toContain('quantity');
  });
  it('imports a quantity list, mapping unit aliases and reporting bad rows', () => {
    const r = parseQuantityCsv('Description,Qty,Unit,Section\n"Blockwork, 9in",120.5,sqm,walls\nCement,40,bags,\nSand,abc,trip,\nPaint,3,gallon,', 'other');
    expect(r.rows.map((x) => [x.description, x.unit, x.section])).toEqual([['Blockwork, 9in', 'm2', 'walls'], ['Cement', 'bag', 'other']]);
    expect(r.errors.map((e) => e.row)).toEqual([4, 5]);
  });
  it('canonical JSON is key-order independent', () => {
    expect(canonicalJson({ b: 1, a: [2n, { d: null, c: 'x' }] })).toBe(canonicalJson({ a: [2n, { c: 'x', d: null }], b: 1 }));
  });
});
