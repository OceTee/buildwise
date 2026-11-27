import type { OrderState } from './procurement';

/**
 * Transaction reviews, Release 3 third slice (spec §13.4). Only the two parties to a completed or terminated order can
 * review, once each, within a window from the market pack. Structured dimensions plus text; the reviewed side can
 * reply once, publicly. A side's review stays hidden from the other until both have reviewed or the window closes,
 * so neither answers the other's review. Removal needs a policy reason and is audited; a provider asking is not one.
 * Ratings never stand in for case resolution and never imply structural safety.
 */

export interface ReviewsConfig {
  /** Days after the order completes (or is terminated) during which each side may review. */
  windowDays: number;
  minBodyChars: number;
  maxBodyChars: number;
  maxReplyChars: number;
}
export const DEFAULT_REVIEWS_CONFIG: ReviewsConfig = { windowDays: 30, minBodyChars: 10, maxBodyChars: 2000, maxReplyChars: 1000 };

export type ReviewSide = 'client' | 'provider';

/** The client reviews the supplier on these (§13.4); the supplier reviews the client on its own three. */
export const REVIEW_DIMENSIONS: Record<ReviewSide, readonly { key: string; label: string }[]> = {
  client: [
    { key: 'quality', label: 'Quality of goods or work' },
    { key: 'timeliness', label: 'Timeliness' },
    { key: 'communication', label: 'Communication' },
    { key: 'accuracy', label: 'Accuracy against the quote' },
  ],
  provider: [
    { key: 'communication', label: 'Communication' },
    { key: 'timeliness', label: 'Site access and payment on time' },
    { key: 'accuracy', label: 'Order matched the request' },
  ],
};

export const REVIEW_REMOVAL_REASONS = {
  abuse: 'Abusive, threatening or discriminatory',
  personal_data: 'Contains personal data (phone numbers, addresses, names of private people)',
  not_about_transaction: 'Not about this transaction',
  conflict_of_interest: 'Written by someone with a conflict of interest',
  manipulation: 'Review manipulation (offered reward, coordinated or fake)',
} as const;
export type ReviewRemovalReason = keyof typeof REVIEW_REMOVAL_REASONS;
export const REVIEW_REMOVAL_KEYS = Object.keys(REVIEW_REMOVAL_REASONS) as ReviewRemovalReason[];

export const TRANSACTION_REVIEW_NOTICE = 'From a completed BuildWise order. Ratings describe the transaction, not structural safety, and do not replace a case.';

/** When the order counts as completed or terminated for reviews; null when it is neither yet. */
export function reviewableSince(o: { state: OrderState; confirmedAt: string | null; fulfilledAt: string | null; closedAt: string | null; updatedAt: string }): string | null {
  if (o.state === 'fulfilled' || o.state === 'closed') return o.fulfilledAt ?? o.closedAt ?? o.updatedAt;
  // A terminated order: cancelled after the supplier had confirmed it (a placed order that was never confirmed is not a transaction).
  if (o.state === 'cancelled' && o.confirmedAt) return o.updatedAt;
  return null;
}

export function reviewEligibilityFor(
  o: Parameters<typeof reviewableSince>[0],
  already: boolean,
  now: Date,
  cfg: Pick<ReviewsConfig, 'windowDays'>,
): { ok: true; closesAt: string } | { ok: false; reason: string; closesAt: string | null } {
  const since = reviewableSince(o);
  if (!since) return { ok: false, reason: 'You can review once the order is delivered in full, closed or cancelled after confirmation.', closesAt: null };
  const closesAt = new Date(new Date(since).getTime() + cfg.windowDays * 86_400_000).toISOString();
  if (already) return { ok: false, reason: 'You have already reviewed this order. Each side reviews once.', closesAt };
  if (now.getTime() > new Date(closesAt).getTime()) return { ok: false, reason: `Reviews close ${cfg.windowDays} days after the order completes.`, closesAt };
  return { ok: true, closesAt };
}

/** Ratings must cover exactly the side's dimensions, each a whole number 1–5. */
export function ratingProblems(side: ReviewSide, ratings: Record<string, number>): string[] {
  const dims = REVIEW_DIMENSIONS[side];
  const out: string[] = [];
  for (const d of dims) {
    const v = ratings[d.key];
    if (v == null) out.push(`Rate ${d.label.toLowerCase()}.`);
    else if (!Number.isInteger(v) || v < 1 || v > 5) out.push(`${d.label}: choose 1 to 5.`);
  }
  for (const k of Object.keys(ratings)) if (!dims.some((d) => d.key === k)) out.push(`Unknown rating "${k}".`);
  return out;
}

export const overallRating = (ratings: Record<string, number>) => {
  const v = Object.values(ratings);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0;
};

/** The other side's review shows once both have reviewed or the window has closed. Your own always shows to you. */
export function counterpartVisible(bothSubmitted: boolean, closesAt: string | null, now: Date): boolean {
  return bothSubmitted || (!!closesAt && now.getTime() > new Date(closesAt).getTime());
}

export interface ReviewSummary {
  count: number;
  overall: number | null;
  dimensions: { key: string; label: string; average: number | null }[];
  /** Fewer reviews than the minimum: show the count, not an average. */
  enough: boolean;
}

/** Averages of the client-side dimensions over published reviews of a provider. */
export function reviewSummary(reviews: { ratings: Record<string, number> }[], minSample: number): ReviewSummary {
  const enough = reviews.length >= minSample;
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : null);
  return {
    count: reviews.length, enough,
    overall: enough ? avg(reviews.map((r) => overallRating(r.ratings))) : null,
    dimensions: REVIEW_DIMENSIONS.client.map((d) => ({ key: d.key, label: d.label, average: enough ? avg(reviews.map((r) => r.ratings[d.key]).filter((x): x is number => typeof x === 'number')) : null })),
  };
}
