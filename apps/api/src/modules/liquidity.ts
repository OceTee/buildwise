import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { compareQuotes, findArea, liquidityReport, rfqLiquidity, type LiquidityRfq } from '@bw/domain';
import { iso, many, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { qLines, qvDomain, rfqLines } from './procurement.js';

/**
 * Liquidity dashboard for the Release 3 exit gate (spec §25): the share of published requests for quotes that got at
 * least three comparable responses within 72 hours, by category, area and week. "Comparable" is the comparison page's
 * own like-for-like rule (`compareQuotes`), applied to each provider's latest quote version submitted inside the
 * window, against the RFQ version it answered. Staff only, system context (it spans every project).
 */

type Row = Record<string, any>;

export async function liquidityInputs(sql: Sql, s: Services, since: Date): Promise<LiquidityRfq[]> {
  const cfg = s.pack.liquidity;
  const rfqs = await many<Row>(sql, `select r.id, r.category_slug, r.area_code, r.published_at, c.name as category_name from rfqs r join categories c on c.slug = r.category_slug
      where r.published_at is not null and r.published_at >= $1 order by r.published_at`, [since.toISOString()]);
  const out: LiquidityRfq[] = [];
  for (const r of rfqs) {
    const publishedAt = iso(r.published_at)!;
    const windowEnd = new Date(new Date(publishedAt).getTime() + cfg.windowHours * 3_600_000).toISOString();
    // Each provider's newest version submitted inside the window.
    const versions = await many<Row>(sql, `select distinct on (v.quote_id) v.*, rv.id as rfq_version_id from quote_versions v
        join rfq_versions rv on rv.rfq_id = v.rfq_id and rv.number = v.rfq_version_number
        where v.rfq_id = $1 and v.submitted_at is not null and v.submitted_at <= $2 order by v.quote_id, v.number desc`, [r.id, windowEnd]);
    const lineCache = new Map<string, Awaited<ReturnType<typeof rfqLines>>>();
    const responses: LiquidityRfq['responses'] = [];
    for (const v of versions) {
      if (!lineCache.has(v.rfq_version_id)) lineCache.set(v.rfq_version_id, await rfqLines(sql, v.rfq_version_id));
      const d = qvDomain(v, await qLines(sql, v.id));
      const c = compareQuotes(lineCache.get(v.rfq_version_id)!, [{ quoteId: v.quote_id, versionId: v.id, versionNumber: v.number, providerOrgId: v.provider_org_id, providerName: '', state: 'submitted', terms: d.terms, lines: d.lines }]);
      responses.push({ providerOrgId: v.provider_org_id, submittedAt: iso(v.submitted_at)!, likeForLike: !!c.columns[0]?.likeForLike });
    }
    out.push({ id: r.id, categorySlug: r.category_slug, categoryName: r.category_name, areaCode: r.area_code, areaLabel: findArea(s.pack, r.area_code)?.label ?? r.area_code, publishedAt, responses });
  }
  return out;
}

export function registerLiquidity(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/moderation/liquidity', auth: 'staff', systemContext: true,
    query: z.object({ weeks: z.coerce.number().int().min(1).max(104).optional() }),
    handler: async ({ sql, query }) => {
      const cfg = s.pack.liquidity;
      const weeks = query.weeks ?? cfg.weeks;
      const now = new Date();
      const rfqs = await liquidityInputs(sql, s, new Date(now.getTime() - weeks * 7 * 86_400_000));
      const report = liquidityReport(rfqs, cfg, now);
      return {
        weeks, ...report,
        recent: rfqs.slice(-20).reverse().map((r) => ({ ...rfqLiquidity(r, cfg, now), category: r.categoryName, area: r.areaLabel, publishedAt: r.publishedAt })),
        notice: `Comparable means the quote prices every line in a comparable unit at the requested quantity with no substitution, the same rule as the comparison page. Cells with fewer than ${cfg.minRfqsPerCell} decided requests show counts, not shares.`,
      };
    },
  });
}
