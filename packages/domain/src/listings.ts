import { defineMachine } from './core.js';
import type { CategoryAttribute, CategoryDef, MarketPack } from './market.js';
import { UNITS, comparablePrice, type PackSize } from './units.js';

/**
 * Listings (spec §3.4, §3.8). A listing is publicly visible only when `live`.
 */
export const LISTING_STATES = ['draft', 'in_review', 'live', 'rejected', 'expired', 'closed', 'blocked'] as const;
export type ListingState = (typeof LISTING_STATES)[number];
export type ListingCommand = 'submit' | 'approve' | 'reject' | 'resubmit' | 'material_edit' | 'flag' | 'expire' | 'renew' | 'close' | 'reopen' | 'block' | 'overturn';

/** `submit`, `resubmit`, `renew`, `reopen` and `material_edit` land in `in_review`; the API may publish straight away when checks pass (§3.8). */
export const listingMachine = defineMachine<ListingState, ListingCommand>('Listing', LISTING_STATES, [
  { command: 'submit', from: ['draft'], to: 'in_review' },
  { command: 'approve', from: ['in_review'], to: 'live' },
  { command: 'reject', from: ['in_review'], to: 'rejected' },
  { command: 'resubmit', from: ['rejected'], to: 'in_review' },
  { command: 'material_edit', from: ['live'], to: 'in_review' },
  { command: 'flag', from: ['live'], to: 'in_review' },
  { command: 'expire', from: ['live'], to: 'expired' },
  { command: 'renew', from: ['expired'], to: 'in_review' },
  { command: 'close', from: ['live', 'expired', 'in_review', 'draft', 'rejected'], to: 'closed' },
  { command: 'reopen', from: ['closed'], to: 'in_review' },
  { command: 'block', from: ['draft', 'in_review', 'live', 'rejected', 'expired', 'closed'], to: 'blocked' },
  { command: 'overturn', from: ['blocked', 'rejected'], to: 'in_review' },
]);

export const LISTING_ACTOR: Record<ListingCommand, 'seller' | 'moderator' | 'system'> = {
  submit: 'seller', resubmit: 'seller', renew: 'seller', close: 'seller', reopen: 'seller', material_edit: 'seller',
  approve: 'moderator', reject: 'moderator', block: 'moderator', overturn: 'moderator', flag: 'system', expire: 'system',
};

export const CLOSE_REASONS = ['sold', 'no_longer_available', 'other'] as const;

// ---------- Moderation reason codes (versioned catalog, §3.9) ----------
export const REASON_CODES = {
  missing_required_photos: 'Add the photos this category needs.',
  missing_required_attributes: 'Fill in the required details for this category.',
  contact_details_in_text: 'Remove phone numbers, emails and links from the title and description. Buyers contact you through chat or "Show phone number".',
  payment_instructions: 'Remove payment instructions. Payments are arranged directly between buyer and seller after inspection.',
  reused_photos: 'Use your own photos of the actual item; these photos already appear in another listing.',
  price_outlier_unverified: 'The price is far from similar listings. Check the price and unit, or add details that explain it.',
  prohibited_item: 'This item cannot be listed on the marketplace.',
  restricted_item: 'This item needs extra review before it can be listed.',
  misleading_claim: 'Remove claims we cannot verify, or mark them as declared by you.',
  wrong_category: 'Choose the category that matches the item.',
  duplicate_listing: 'You already have a listing for this item. Edit or renew that one instead.',
  scam_signals: 'This listing matches patterns we see in scams and has been held.',
  other: 'See the moderator note.',
} as const;
export type ReasonCode = keyof typeof REASON_CODES;

// ---------- Attributes ----------
export type AttributeValues = Record<string, unknown>;

export function validateAttributes(cat: CategoryDef, values: AttributeValues): { ok: true; clean: AttributeValues } | { ok: false; errors: { key: string; message: string }[] } {
  const errors: { key: string; message: string }[] = [];
  const clean: AttributeValues = {};
  for (const a of cat.attributes) {
    const v = values[a.key];
    const empty = v == null || v === '';
    if (empty) {
      if (a.required) errors.push({ key: a.key, message: `${a.label} is required.` });
      continue;
    }
    const err = checkAttr(a, v);
    if (err) errors.push({ key: a.key, message: err });
    else clean[a.key] = normalizeAttr(a, v);
  }
  return errors.length ? { ok: false, errors } : { ok: true, clean };
}

function checkAttr(a: CategoryAttribute, v: unknown): string | null {
  switch (a.type) {
    case 'text': return typeof v === 'string' && v.trim().length <= (a.max ?? 200) ? null : `${a.label} is too long.`;
    case 'enum': return a.options?.some((o) => o.value === v) ? null : `Choose a valid ${a.label.toLowerCase()}.`;
    case 'boolean': return typeof v === 'boolean' ? null : `${a.label} must be yes or no.`;
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) && n >= 0 && n <= (a.max ?? 1e9) ? null : `${a.label} must be a number${a.max ? ` up to ${a.max}` : ''}.`;
    }
    case 'pack_size': {
      const p = v as PackSize;
      return p && typeof p === 'object' && Number(p.value) > 0 && (a.packUnits ?? []).includes(p.unit) ? null : `${a.label} needs a positive amount in ${(a.packUnits ?? []).join('/')}.`;
    }
  }
}

function normalizeAttr(a: CategoryAttribute, v: unknown): unknown {
  if (a.type === 'text') return (v as string).trim();
  if (a.type === 'number') return Number(v);
  if (a.type === 'pack_size') return { value: Number((v as PackSize).value), unit: (v as PackSize).unit };
  return v;
}

export function packSizeOf(cat: CategoryDef, attrs: AttributeValues): PackSize | null {
  const key = cat.attributes.find((a) => a.type === 'pack_size')?.key;
  const v = key ? (attrs[key] as PackSize | undefined) : undefined;
  return v && v.value > 0 ? v : null;
}

// ---------- Material vs minor edits (§3.8) ----------
export interface ListingSnapshot {
  title: string; description: string; categorySlug: string; priceMinor: bigint | null; unit: string; photoHashes: string[];
}

export function isMaterialEdit(before: ListingSnapshot, after: ListingSnapshot, priceChangePct: number): { material: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (before.categorySlug !== after.categorySlug) reasons.push('category');
  if (before.title.trim() !== after.title.trim()) reasons.push('title');
  if (before.unit !== after.unit) reasons.push('unit');
  if ([...before.photoHashes].sort().join() !== [...after.photoHashes].sort().join()) reasons.push('photos');
  if ((before.priceMinor == null) !== (after.priceMinor == null)) reasons.push('price');
  else if (before.priceMinor != null && after.priceMinor != null && before.priceMinor > 0n) {
    const change = Math.abs(Number(after.priceMinor - before.priceMinor)) / Number(before.priceMinor) * 100;
    if (change > priceChangePct) reasons.push('price');
  }
  return { material: reasons.length > 0, reasons };
}

// ---------- Automated checks (§3.8) ----------
const PHONE_RE = /(?:\+?\d[\s().-]*){8,}/;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|ng|net|org|io|co|me|shop|store|link|ly)\b/i;
const PAYMENT_RE = /\b(?:account\s*(?:no|number)|acct\b|bank\s*transfer|pay\s*(?:to|into)|transfer\s*to|opay|palmpay|moniepoint|paystack\.com|flutterwave|bitcoin|usdt|crypto\s*wallet)\b/i;

export interface TextFinding { code: ReasonCode; detail: string }

/** Contact details, links, payment instructions and scam phrases in free text (titles, descriptions, chat). */
export function scanText(text: string, pack: Pick<MarketPack, 'scamPhrases' | 'prohibitedTerms' | 'restrictedTerms'>): TextFinding[] {
  const out: TextFinding[] = [];
  const lower = text.toLowerCase();
  // Digits that are prices, sizes or quantities are fine; only phone-like runs count.
  const phone = PHONE_RE.exec(text.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g, ' '));
  if (phone && phone[0].replace(/\D/g, '').length >= 9) out.push({ code: 'contact_details_in_text', detail: 'phone number' });
  if (EMAIL_RE.test(text)) out.push({ code: 'contact_details_in_text', detail: 'email address' });
  if (LINK_RE.test(text)) out.push({ code: 'contact_details_in_text', detail: 'link' });
  if (PAYMENT_RE.test(text)) out.push({ code: 'payment_instructions', detail: 'payment instruction' });
  for (const p of pack.scamPhrases) if (lower.includes(p)) out.push({ code: 'scam_signals', detail: p });
  for (const p of pack.prohibitedTerms) if (lower.includes(p)) out.push({ code: 'prohibited_item', detail: p });
  for (const p of pack.restrictedTerms) if (lower.includes(p)) out.push({ code: 'restricted_item', detail: p });
  return out;
}

/** Price far outside observed listings for the same category, comparable unit and region; cold start skips (§3.8). */
export function priceOutlier(
  price: { priceMinor: bigint; unit: string; pack: PackSize | null },
  observedPerBaseMinor: number[],
  minObservations: number, factor: number,
): { checked: boolean; outlier: boolean; median?: number } {
  const c = comparablePrice(price.priceMinor, price.unit, price.pack);
  const value = c.perBaseMinor ?? Number(price.priceMinor);
  if (observedPerBaseMinor.length < minObservations) return { checked: false, outlier: false };
  const s = [...observedPerBaseMinor].sort((a, b) => a - b);
  const median = s[Math.floor(s.length / 2)]!;
  return { checked: true, outlier: value > median * factor || value < median / factor, median };
}

export interface CheckInput {
  category: CategoryDef;
  title: string;
  description: string;
  attributes: AttributeValues;
  photoCount: number;
  textFindings: TextFinding[];
  reusedPhotoMatches: number;
  outlier: { checked: boolean; outlier: boolean };
  account: { ageDays: number; priorRejections: number; openReports: number; restricted: boolean; established: boolean };
}

export interface CheckResult {
  pass: boolean;
  autoPublish: boolean;
  riskScore: number;
  signals: { code: ReasonCode | 'new_account' | 'prior_rejections' | 'open_reports' | 'outlier_unchecked'; detail: string; weight: number }[];
  blocking: ReasonCode[];
}

/** Combines the checks into a risk score that orders the queue; blocking failures stop submission outright. */
export function runChecks(i: CheckInput): CheckResult {
  const signals: CheckResult['signals'] = [];
  const blocking: ReasonCode[] = [];
  if (i.photoCount < i.category.minPhotos) blocking.push('missing_required_photos');
  const attrs = validateAttributes(i.category, i.attributes);
  if (!attrs.ok) blocking.push('missing_required_attributes');
  for (const f of i.textFindings) {
    const weight = f.code === 'prohibited_item' ? 100 : f.code === 'scam_signals' ? 60 : f.code === 'payment_instructions' ? 50 : f.code === 'restricted_item' ? 40 : 30;
    signals.push({ code: f.code, detail: f.detail, weight });
    if (f.code === 'contact_details_in_text' || f.code === 'payment_instructions') blocking.push(f.code);
  }
  if (i.reusedPhotoMatches > 0) signals.push({ code: 'reused_photos', detail: `${i.reusedPhotoMatches} photo(s) match another seller's listing`, weight: 50 });
  if (i.outlier.outlier) signals.push({ code: 'price_outlier_unverified', detail: 'price far from similar listings', weight: 40 });
  if (!i.outlier.checked) signals.push({ code: 'outlier_unchecked', detail: 'not enough price data yet', weight: 5 });
  if (i.account.ageDays < 7) signals.push({ code: 'new_account', detail: `account is ${i.account.ageDays} day(s) old`, weight: 20 });
  if (i.account.priorRejections > 0) signals.push({ code: 'prior_rejections', detail: `${i.account.priorRejections} prior rejection(s)`, weight: 10 * Math.min(i.account.priorRejections, 5) });
  if (i.account.openReports > 0) signals.push({ code: 'open_reports', detail: `${i.account.openReports} open report(s)`, weight: 15 * Math.min(i.account.openReports, 4) });
  const riskScore = Math.min(100, signals.reduce((s, x) => s + x.weight, 0));
  const pass = blocking.length === 0;
  // Auto-publish only when nothing at all was flagged, the category allows it and the seller is established (§3.8).
  const flagged = signals.some((s) => s.code !== 'outlier_unchecked');
  const autoPublish = pass && !flagged && i.category.autoPublish && i.account.established && !i.account.restricted;
  return { pass, autoPublish, riskScore, signals, blocking: [...new Set(blocking)] };
}

/** Price unit must be one the category allows, and known to the unit catalog. */
export function validatePriceUnit(cat: CategoryDef, unit: string): string | null {
  if (!UNITS[unit]) return `Unknown unit “${unit}”.`;
  if (!cat.priceUnits.includes(unit)) return `Choose one of: ${cat.priceUnits.join(', ')}.`;
  return null;
}
