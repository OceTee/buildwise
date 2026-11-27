import { EMPTY_PERFORMANCE, overallRating, providerPerformance, reviewSummary, type PerformanceInputs, type ProviderPerformance, type ReviewSummary } from '@bw/domain';
import { many, type Sql } from '../db/database.js';
import type { Services } from '../http/route.js';

/**
 * Provider reputation from completed transactions (R3 slice 3): delivery and quote performance through the narrow
 * `provider_performance_inputs` function (dates, states and counts only), and published transaction reviews written
 * by clients. Used by the provider profile and by RFQ matching.
 */

type Row = Record<string, any>;
const arr = <T>(v: unknown): T[] => ((typeof v === 'string' ? JSON.parse(v) : v) ?? []) as T[];
const isoOf = (v: unknown) => (v == null ? null : new Date(String(v)).toISOString());

export async function performanceFor(sql: Sql, s: Services, orgIds: string[]): Promise<Map<string, ProviderPerformance>> {
  const out = new Map<string, ProviderPerformance>();
  if (!orgIds.length) return out;
  const rows = await many<Row>(sql, `select * from provider_performance_inputs($1::uuid[], $2)`, [orgIds, s.pack.performance.windowDays]);
  for (const r of rows) {
    const inputs: PerformanceInputs = {
      deliveries: arr<Row>(r.deliveries).map((d) => ({ scheduledDate: String(d.scheduledDate).slice(0, 10), state: d.state, arrivedAt: isoOf(d.arrivedAt), inspected: !!d.inspected, discrepancies: Number(d.discrepancies ?? 0) })),
      invoices: arr<Row>(r.invoices).map((i) => ({ state: i.state, matchStatus: i.matchStatus })),
      invitations: arr<Row>(r.invitations).map((i) => ({ invitedAt: isoOf(i.invitedAt)!, respondedAt: isoOf(i.respondedAt), state: i.state })),
      quotes: arr<Row>(r.quotes).map((q) => ({ state: q.state, withdrawn: !!q.withdrawn, validUntil: q.validUntil ? String(q.validUntil).slice(0, 10) : null, rfqDeadline: isoOf(q.rfqDeadline)! })),
    };
    out.set(r.org_id, providerPerformance(inputs, s.pack.performance));
  }
  return out;
}

export interface TransactionReviewStats { summary: ReviewSummary; average: number | null; count: number }

/** Published reviews by clients of each provider (the provider's reviews of clients are not part of its reputation). */
export async function transactionReviewStats(sql: Sql, s: Services, orgIds: string[]): Promise<Map<string, TransactionReviewStats>> {
  const out = new Map<string, TransactionReviewStats>();
  if (!orgIds.length) return out;
  const rows = await many<Row>(sql, `select provider_org_id, ratings from transaction_reviews where provider_org_id = any($1::uuid[]) and author_side = 'client' and status = 'published'`, [orgIds]);
  for (const id of orgIds) {
    const mine = rows.filter((r) => r.provider_org_id === id).map((r) => ({ ratings: typeof r.ratings === 'string' ? JSON.parse(r.ratings) : r.ratings }));
    const summary = reviewSummary(mine, s.pack.performance.minSample);
    const all = mine.map((r) => overallRating(r.ratings));
    out.set(id, { summary, count: mine.length, average: all.length ? Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10 : null });
  }
  return out;
}

export const summaryOf = (p: ProviderPerformance | undefined) => p?.summary ?? EMPTY_PERFORMANCE;
