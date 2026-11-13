import { defineMachine } from './core.js';
import type { MarketPack } from './market.js';

// ---------- Phone numbers (§3.11) ----------
/** Normalizes local or international input to E.164 for the pack's allowed calling codes; null if not valid. */
export function normalizePhone(input: string, pack: Pick<MarketPack, 'phone'>): string | null {
  const raw = input.replace(/[\s().-]/g, '');
  const { defaultCallingCode, allowedCallingCodes, nationalDigits } = pack.phone;
  let e164: string;
  if (raw.startsWith('+')) e164 = raw;
  else if (raw.startsWith('00')) e164 = `+${raw.slice(2)}`;
  else if (raw.startsWith('0')) e164 = `${defaultCallingCode}${raw.slice(1)}`;
  else e164 = `${defaultCallingCode}${raw}`;
  if (!/^\+\d{8,15}$/.test(e164)) return null;
  const cc = allowedCallingCodes.find((c) => e164.startsWith(c));
  if (!cc) return null;
  const national = e164.slice(cc.length);
  if (national.length < nationalDigits[0] || national.length > nationalDigits[1]) return null;
  return e164;
}

export function maskPhone(e164: string): string {
  return `${e164.slice(0, 4)} ••• ••• ${e164.slice(-3)}`;
}

// ---------- Reputation: measured values only (§3.12) ----------
export interface ThreadStat { startedAt: Date; firstSellerReplyAt: Date | null }

export function replyMetrics(threads: ThreadStat[], now: Date, windowDays: number, replyWindowHours: number, minThreads: number):
  { threads: number; replyRatePct: number | null; medianReplyMinutes: number | null; enoughData: boolean } {
  const since = now.getTime() - windowDays * 86_400_000;
  const inWindow = threads.filter((t) => t.startedAt.getTime() >= since);
  if (inWindow.length < minThreads) return { threads: inWindow.length, replyRatePct: null, medianReplyMinutes: null, enoughData: false };
  const delays = inWindow.filter((t) => t.firstSellerReplyAt).map((t) => (t.firstSellerReplyAt!.getTime() - t.startedAt.getTime()) / 60_000).sort((a, b) => a - b);
  const inTime = delays.filter((m) => m <= replyWindowHours * 60).length;
  const mid = Math.floor(delays.length / 2);
  const median = !delays.length ? null : delays.length % 2 ? delays[mid]! : (delays[mid - 1]! + delays[mid]!) / 2;
  return { threads: inWindow.length, replyRatePct: Math.round((inTime / inWindow.length) * 100), medianReplyMinutes: median == null ? null : Math.round(median), enoughData: true };
}

// ---------- Reviews: interaction gate (§3.12) ----------
export interface InteractionEvidence {
  chatWithBothSides: boolean;
  answeredQuoteRequest: boolean;
  confirmedAfterReveal: boolean;
  lastReviewOfSellerAt: Date | null;
  sameOrganization: boolean;
}

export function reviewEligibility(e: InteractionEvidence, now: Date, cooldownDays: number): { ok: true } | { ok: false; reason: string } {
  if (e.sameOrganization) return { ok: false, reason: 'You cannot review a seller from your own organization.' };
  if (!e.chatWithBothSides && !e.answeredQuoteRequest && !e.confirmedAfterReveal) {
    return { ok: false, reason: 'You can review a seller after you have dealt with them: a chat where you both replied, a quote request they answered, or a confirmed contact.' };
  }
  if (e.lastReviewOfSellerAt && now.getTime() - e.lastReviewOfSellerAt.getTime() < cooldownDays * 86_400_000) {
    return { ok: false, reason: `You can review the same seller once every ${cooldownDays} days.` };
  }
  return { ok: true };
}

// ---------- Quote requests (§3.10) ----------
export type QuoteRequestState = 'sent' | 'viewed' | 'answered' | 'declined' | 'expired' | 'listing_unavailable';
export const quoteRequestMachine = defineMachine<QuoteRequestState, 'view' | 'answer' | 'decline' | 'expire' | 'listing_gone'>('QuoteRequest',
  ['sent', 'viewed', 'answered', 'declined', 'expired', 'listing_unavailable'], [
    { command: 'view', from: ['sent'], to: 'viewed' },
    { command: 'answer', from: ['sent', 'viewed'], to: 'answered' },
    { command: 'decline', from: ['sent', 'viewed'], to: 'declined' },
    { command: 'expire', from: ['sent', 'viewed'], to: 'expired' },
    { command: 'listing_gone', from: ['sent', 'viewed'], to: 'listing_unavailable' },
  ]);

// ---------- Promotions (§3.13) ----------
export type PromotionState = 'pending_payment' | 'paid' | 'active' | 'paused' | 'expired' | 'cancelled' | 'refunded' | 'credited' | 'forfeited';
export type PromotionCommand = 'pay' | 'activate' | 'pause' | 'resume' | 'expire' | 'cancel' | 'refund' | 'credit' | 'forfeit';

export const promotionMachine = defineMachine<PromotionState, PromotionCommand>('Promotion',
  ['pending_payment', 'paid', 'active', 'paused', 'expired', 'cancelled', 'refunded', 'credited', 'forfeited'], [
    { command: 'pay', from: ['pending_payment'], to: 'paid' },
    { command: 'cancel', from: ['pending_payment'], to: 'cancelled' },
    { command: 'activate', from: ['paid'], to: 'active' },
    { command: 'pause', from: ['active'], to: 'paused' },
    { command: 'resume', from: ['paused'], to: 'active' },
    { command: 'expire', from: ['active'], to: 'expired' },
    { command: 'refund', from: ['paid', 'active', 'paused'], to: 'refunded' },
    { command: 'credit', from: ['active', 'paused', 'paid'], to: 'credited' },
    { command: 'forfeit', from: ['active', 'paused'], to: 'forfeited' },
  ]);

/** Remaining promoted time is tracked in seconds so a pause never consumes paid time (§3.13). */
export function remainingAfterPause(activeSince: Date, remainingSeconds: number, pausedAt: Date): number {
  return Math.max(0, remainingSeconds - Math.floor((pausedAt.getTime() - activeSince.getTime()) / 1000));
}

export function endsAt(activeSince: Date, remainingSeconds: number): Date {
  return new Date(activeSince.getTime() + remainingSeconds * 1000);
}

/** What happens to a running promotion when its listing leaves `live` (§3.13). */
export function promotionOnListingChange(to: string, reason?: string | null): 'pause' | 'credit' | 'forfeit' | 'none' {
  if (to === 'live') return 'none';
  if (to === 'blocked') return reason === 'prohibited_item' || reason === 'scam_signals' ? 'forfeit' : 'credit';
  if (to === 'rejected') return 'credit';
  return 'pause'; // in_review, expired, closed
}

/**
 * Places promoted listings into labelled slots: up to `topPerPage` top slots, then one promoted slot every
 * `everyN` organic results. Promoted items must already be eligible (live, in category and area); rotation is
 * deterministic per `seed` with share proportional to weight. Promoted items never appear unlabelled (§3.7).
 */
export function placeSlots<T extends { id: string }>(
  organic: T[], top: (T & { weight: number })[], promoted: (T & { weight: number })[],
  opts: { topPerPage: number; everyN: number; seed: number },
): { item: T; slot: 'top' | 'promoted' | 'organic' }[] {
  const rotate = <U extends { id: string; weight: number }>(xs: U[]): U[] => {
    const tickets = xs.flatMap((x) => Array.from({ length: Math.max(1, Math.round(x.weight)) }, () => x));
    if (!tickets.length) return [];
    const start = opts.seed % tickets.length;
    const out: U[] = [];
    for (let i = 0; i < tickets.length && out.length < xs.length; i++) {
      const t = tickets[(start + i) % tickets.length]!;
      if (!out.includes(t)) out.push(t);
    }
    return out;
  };
  const used = new Set<string>();
  const result: { item: T; slot: 'top' | 'promoted' | 'organic' }[] = [];
  for (const t of rotate(top).slice(0, opts.topPerPage)) { result.push({ item: t, slot: 'top' }); used.add(t.id); }
  // A promoted listing moves to its labelled slot; it is never shown twice (once organic, once promoted).
  const slots = Math.floor(organic.filter((o) => !used.has(o.id)).length / opts.everyN);
  const promos = rotate(promoted).filter((p) => !used.has(p.id)).slice(0, slots);
  for (const p of promos) used.add(p.id);
  let n = 0;
  for (const o of organic) {
    if (used.has(o.id)) continue;
    result.push({ item: o, slot: 'organic' });
    n += 1;
    if (n % opts.everyN === 0 && promos.length) result.push({ item: promos.shift()!, slot: 'promoted' });
  }
  return result;
}

// ---------- Perceptual hashes (§3.8 reused photos) ----------
/** Hamming distance between two 64-bit difference hashes as 16-char hex strings. */
export function hammingHex(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return d;
}

export const PHASH_MATCH_DISTANCE = 6;

// ---------- Seller restrictions and appeals (§3.9) ----------
export const RESTRICTION_KINDS = ['posting_limit', 'chat_limit', 'listing_suspension', 'account_suspension'] as const;
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

export const REPORT_REASONS = {
  scam: 'Scam or fraud',
  counterfeit: 'Counterfeit or substandard',
  impersonation: 'Impersonating a real business or professional',
  prohibited: 'Prohibited item',
  wrong_info: 'Wrong price, category or details',
  unsafe_work: 'Unsafe work',
  offensive: 'Offensive content',
  other: 'Something else',
} as const;
export type ReportReason = keyof typeof REPORT_REASONS;

/** Impersonation and unsafe-work reports get priority review (§3.9). */
export const PRIORITY_REPORTS: ReportReason[] = ['impersonation', 'unsafe_work', 'scam'];
