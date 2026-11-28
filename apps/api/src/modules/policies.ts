import type { FastifyInstance } from 'fastify';
import { RETAINED_AFTER_DELETION } from '@bw/domain';
import { route, type Services } from '../http/route.js';

/**
 * `GET /v1/policies`: the market pack's public rules for the legal and help pages (posting rules, prohibited and
 * restricted items, retention). Every value comes from the pack, so a new market publishes its own text.
 */
export function registerPolicies(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/policies', auth: 'public',
    handler: async () => {
      const p = s.pack;
      return {
        market: { id: p.id, name: p.name, illustrative: p.illustrative, currency: p.currency, locale: p.locale },
        tax: p.tax,
        itemRules: p.itemRules,
        prohibitedTerms: p.prohibitedTerms,
        restrictedTerms: p.restrictedTerms,
        scamPhrases: p.scamPhrases,
        retention: p.retention,
        privacy: {
          exportPerDay: p.privacy.export.perDay, exportLinkMinutes: p.privacy.export.linkMinutes,
          deletedAccountDays: p.privacy.retention.deletedAccountDays, retainedAfterDeletion: RETAINED_AFTER_DELETION,
        },
        safetyTips: p.safetyTips,
        limits: { listingsPerNewAccountPerDay: p.limits.listingsPerNewAccountPerDay, chatsPerNewAccountPerDay: p.limits.chatsPerNewAccountPerDay, revealsPerUserPerDay: p.limits.revealsPerUserPerDay },
        moderation: { reportThreshold: p.moderation.reportThreshold, establishedSellerMinLiveDays: p.moderation.establishedSellerMinLiveDays, materialPriceChangePct: p.moderation.materialPriceChangePct },
        policy: { goneAfterDays: p.policy.goneAfterDays, quoteRequestExpiryDays: p.policy.quoteRequestExpiryDays, reviewCooldownDays: p.policy.reviewCooldownDays, priceFreshDays: p.policy.priceFreshDays },
        categories: p.categories.map((c) => ({
          slug: c.slug, name: c.name, parent: c.parent ?? null, minPhotos: c.minPhotos, listingPeriodDays: c.listingPeriodDays,
          freeAllowance: c.freeAllowance, alwaysReviewed: !c.autoPublish, priceUnits: c.priceUnits,
        })),
      };
    },
  });
}
