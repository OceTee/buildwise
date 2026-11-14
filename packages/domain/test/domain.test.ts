import { describe, expect, it } from 'vitest';
import {
  DEMO_MARKET, comparablePrice, distanceKm, groupForPriceSort, hammingHex, isMaterialEdit, listingMachine, listingPath, normalizePhone,
  parseMajor, placeSlots, priceOutlier, promotionMachine, promotionOnListingChange, quoteRequestMachine, remainingAfterPause, replyMetrics,
  reviewEligibility, runChecks, scanText, shortIdFromPath, taxOn, uuidv7, validateAttributes, validatePriceUnit,
} from '../src/index.js';

const cement = DEMO_MARKET.categories.find((c) => c.slug === 'cement')!;

describe('listing lifecycle (§3.8)', () => {
  it('follows the table, including appeal overturn and reopen', () => {
    expect(listingMachine.next('draft', 'submit')).toBe('in_review');
    expect(listingMachine.next('in_review', 'approve')).toBe('live');
    expect(listingMachine.next('live', 'material_edit')).toBe('in_review');
    expect(listingMachine.next('live', 'expire')).toBe('expired');
    expect(listingMachine.next('expired', 'renew')).toBe('in_review');
    expect(listingMachine.next('closed', 'reopen')).toBe('in_review');
    expect(listingMachine.next('blocked', 'overturn')).toBe('in_review');
    expect(() => listingMachine.next('blocked', 'reopen')).toThrow();
    expect(() => listingMachine.next('draft', 'approve')).toThrow();
  });
});

describe('category attributes and units', () => {
  it('requires attributes, validates enums and pack sizes', () => {
    const bad = validateAttributes(cement, { brand: '', grade: '99' });
    expect(bad.ok).toBe(false);
    const ok = validateAttributes(cement, { brand: ' Acme ', grade: '42.5', pack_size: { value: '50', unit: 'kg' }, quantity_available: '300' });
    expect(ok).toEqual({ ok: true, clean: { brand: 'Acme', grade: '42.5', pack_size: { value: 50, unit: 'kg' }, quantity_available: 300 } });
    expect(validatePriceUnit(cement, 'bag')).toBeNull();
    expect(validatePriceUnit(cement, 'trip')).toMatch(/Choose one of/);
  });

  it('normalizes per base unit through pack size and never compares across dimensions', () => {
    const bag50 = comparablePrice(950_000n, 'bag', { value: 50, unit: 'kg' });
    const tonne = comparablePrice(18_000_000n, 'tonne');
    expect(bag50).toMatchObject({ key: 'dim:mass', baseUnit: 'kg', perBaseMinor: 19_000 });
    expect(tonne).toMatchObject({ key: 'dim:mass', perBaseMinor: 18_000 });
    expect(comparablePrice(950_000n, 'bag')).toMatchObject({ key: 'unit:bag', perBaseMinor: null });
    const groups = groupForPriceSort([
      { id: 'a', priceMinor: 950_000n, unit: 'bag', pack: { value: 50, unit: 'kg' } },
      { id: 'b', priceMinor: 500_000n, unit: 'bag', pack: { value: 25, unit: 'kg' } },
      { id: 'c', priceMinor: 18_000_000n, unit: 'tonne' },
      { id: 'd', priceMinor: 100n, unit: 'trip' },
    ], 'asc');
    expect(groups[0]!.items.map((x) => x.id)).toEqual(['c', 'a', 'b']); // 18,000 < 19,000 < 20,000 per kg
    expect(groups[1]!.key).toBe('unit:trip');
  });

  it('parses money safely', () => {
    expect(parseMajor('9,500', 'NGN')).toBe(950_000n);
    expect(parseMajor('9500.5', 'NGN')).toBe(950_050n);
    expect(parseMajor('9500.555', 'NGN')).toBeNull();
    expect(parseMajor('abc', 'NGN')).toBeNull();
    expect(taxOn(250_000, 7.5)).toBe(18_750);
  });
});

describe('edits and automated checks', () => {
  const base = { title: 'Cement 42.5', description: 'Fresh stock', categorySlug: 'cement', priceMinor: 950_000n, unit: 'bag', photoHashes: ['a', 'b'] };
  it('classifies material edits', () => {
    expect(isMaterialEdit(base, { ...base, description: 'Fresh stock, delivered' }, 20).material).toBe(false);
    expect(isMaterialEdit(base, { ...base, priceMinor: 1_000_000n }, 20).material).toBe(false);
    expect(isMaterialEdit(base, { ...base, priceMinor: 1_500_000n }, 20).reasons).toEqual(['price']);
    expect(isMaterialEdit(base, { ...base, photoHashes: ['a', 'c'] }, 20).reasons).toEqual(['photos']);
  });

  it('finds contact details, payment instructions and scam phrases, not prices or sizes', () => {
    const codes = (s: string) => scanText(s, DEMO_MARKET).map((f) => f.code);
    expect(codes('Dangote cement 50kg, 9,500 per bag, 1,200 bags available')).toEqual([]);
    expect(codes('Call 0803 123 4567 now')).toContain('contact_details_in_text');
    expect(codes('email me at seller@example.com')).toContain('contact_details_in_text');
    expect(codes('see www.example.com')).toContain('contact_details_in_text');
    expect(codes('Pay to account number 0123456789')).toContain('payment_instructions');
    expect(codes('Pay deposit to my account before delivery.')).toContain('payment_instructions');
    expect(codes('Send it with Opay please')).toContain('payment_instructions');
    expect(codes('Deposit slip not needed, depositors welcome')).not.toContain('payment_instructions');
    expect(codes('pay a deposit to reserve your order')).toContain('scam_signals');
    expect(codes('Plots for sale with C of O')).toContain('prohibited_item');
  });

  it('skips the outlier check until enough observations exist (cold start)', () => {
    const price = { priceMinor: 100_000n, unit: 'bag', pack: { value: 50, unit: 'kg' } };
    expect(priceOutlier(price, [19_000, 18_000], 20, 3)).toEqual({ checked: false, outlier: false });
    const obs = Array.from({ length: 25 }, (_, i) => 18_000 + i * 50);
    expect(priceOutlier(price, obs, 20, 3)).toMatchObject({ checked: true, outlier: true });
  });

  it('scores risk; blocks contact details; auto-publishes only clean submissions from established sellers', () => {
    const account = { ageDays: 60, priorRejections: 0, openReports: 0, restricted: false, established: true };
    const good = { category: cement, title: 'Cement', description: '', attributes: { brand: 'Acme', grade: '42.5' }, photoCount: 1, textFindings: [], reusedPhotoMatches: 0, outlier: { checked: true, outlier: false }, account };
    expect(runChecks(good)).toMatchObject({ pass: true, autoPublish: true });
    expect(runChecks({ ...good, account: { ...account, established: false } }).autoPublish).toBe(false);
    const contact = runChecks({ ...good, textFindings: [{ code: 'contact_details_in_text', detail: 'phone number' }] });
    expect(contact.pass).toBe(false);
    expect(contact.blocking).toContain('contact_details_in_text');
    const reused = runChecks({ ...good, reusedPhotoMatches: 2 });
    expect(reused).toMatchObject({ pass: true, autoPublish: false });
    expect(reused.riskScore).toBeGreaterThanOrEqual(50);
    expect(runChecks({ ...good, photoCount: 0 }).blocking).toContain('missing_required_photos');
  });
});

describe('trust and commercial rules', () => {
  it('normalizes phone numbers to the pack calling codes', () => {
    expect(normalizePhone('0803 123 4567', DEMO_MARKET)).toBe('+2348031234567');
    expect(normalizePhone('+234 803 123 4567', DEMO_MARKET)).toBe('+2348031234567');
    expect(normalizePhone('+44 7700 900123', DEMO_MARKET)).toBeNull();
    expect(normalizePhone('12345', DEMO_MARKET)).toBeNull();
  });

  it('measures reply rate and median reply time with a minimum sample', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const t = (hoursAgo: number, replyAfterMin: number | null) => ({ startedAt: new Date(now.getTime() - hoursAgo * 3_600_000), firstSellerReplyAt: replyAfterMin == null ? null : new Date(now.getTime() - hoursAgo * 3_600_000 + replyAfterMin * 60_000) });
    expect(replyMetrics([t(5, 10)], now, 90, 24, 5).enoughData).toBe(false);
    const m = replyMetrics([t(5, 10), t(6, 30), t(7, 2000), t(8, null), t(9, 20)], now, 90, 24, 5);
    expect(m).toMatchObject({ threads: 5, replyRatePct: 60, medianReplyMinutes: 25, enoughData: true }); // replies 10, 20, 30, 2000 → median 25
  });

  it('gates reviews on a recorded interaction and a cooldown', () => {
    const now = new Date('2026-11-13');
    const none = { chatWithBothSides: false, answeredQuoteRequest: false, confirmedAfterReveal: false, lastReviewOfSellerAt: null, sameOrganization: false };
    expect(reviewEligibility(none, now, 90).ok).toBe(false);
    expect(reviewEligibility({ ...none, answeredQuoteRequest: true }, now, 90).ok).toBe(true);
    expect(reviewEligibility({ ...none, chatWithBothSides: true, lastReviewOfSellerAt: new Date('2026-10-01') }, now, 90).ok).toBe(false);
  });

  it('handles quote requests and promotions; pauses never consume paid time', () => {
    expect(quoteRequestMachine.next('viewed', 'answer')).toBe('answered');
    expect(() => quoteRequestMachine.next('answered', 'decline')).toThrow();
    expect(promotionMachine.next('pending_payment', 'pay')).toBe('paid');
    expect(promotionMachine.next('active', 'pause')).toBe('paused');
    expect(promotionMachine.next('paused', 'resume')).toBe('active');
    expect(remainingAfterPause(new Date('2026-11-01T00:00:00Z'), 7 * 86400, new Date('2026-11-03T00:00:00Z'))).toBe(5 * 86400);
    expect(promotionOnListingChange('in_review')).toBe('pause');
    expect(promotionOnListingChange('blocked', 'prohibited_item')).toBe('forfeit');
    expect(promotionOnListingChange('blocked', 'wrong_category')).toBe('credit');
  });

  it('places promoted listings only in labelled slots and never duplicates them', () => {
    const organic = Array.from({ length: 25 }, (_, i) => ({ id: `o${i}` }));
    const top = [{ id: 't1', weight: 1 }, { id: 't2', weight: 1 }, { id: 't3', weight: 1 }, { id: 't4', weight: 1 }];
    const promoted = [{ id: 'p1', weight: 2 }, { id: 'o3', weight: 1 }];
    const out = placeSlots(organic, top, promoted, { topPerPage: 3, everyN: 10, seed: 7 });
    expect(out.filter((x) => x.slot === 'top')).toHaveLength(3);
    expect(out.slice(0, 3).every((x) => x.slot === 'top')).toBe(true);
    const ids = out.map((x) => x.item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(out.filter((x) => x.slot === 'promoted')).toHaveLength(2);
  });

  it('ids, paths, hashes and distance', () => {
    const id = uuidv7();
    expect(shortIdFromPath(listingPath('Dangote Cement 42.5R — 50kg!', id).replace('/listing/', ''))).toBe(id.replace(/-/g, '').slice(-12));
    expect(hammingHex('ffffffffffffffff', 'fffffffffffffff0')).toBe(4);
    expect(distanceKm({ lat: 6.62, lng: 3.35 }, { lat: 6.44, lng: 3.40 })).toBeGreaterThan(15);
  });
});
