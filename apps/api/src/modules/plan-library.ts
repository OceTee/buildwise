import Exa from 'exa-js';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { BUILDING_TYPES, BUILDING_TYPE_KEYS, FEATURES, isHouse, PRIORITIES, PURPOSES, TASTES } from '@bw/domain';
import { clientOf, type Services } from '../http/route.js';
import { badRequest, tooMany } from '../platform/platform.js';

const input = z.object({
  type: z.enum(BUILDING_TYPE_KEYS),
  taste: z.enum(['simple', 'modern', 'tropical', 'grand']),
  purpose: z.enum(['family', 'tenants', 'both', 'own', 'community', 'exploring']).nullish(),
  bedrooms: z.number().int().min(1).max(12),
  storeys: z.number().int().min(1).max(10),
  priorities: z.array(z.enum(['garden', 'privacy', 'host'])).max(3),
  features: z.array(z.string().max(30)).max(30).default([]),
  study: z.boolean().default(false),
  openKitchen: z.boolean().default(false),
  plot: z.object({ widthM: z.number().min(6).max(200), depthM: z.number().min(6).max(200) }).optional(),
  aiOnly: z.boolean().default(false),
});
type Query = z.infer<typeof input>;
const licensed = /\b(?:single[- ]build licen[cs]e|licen[cs]e to build|construction licen[cs]e|permission to build (?:one|a single))\b/i;
const aiDisclosure = /\b(?:AI[- ]generated (?:house|home|floor|architectural|building) plans?|(?:floor plans?|house plans?|layout|design) (?:was |were )?(?:generated|created|designed) (?:with|by|using) (?:AI|ChatGPT|GPT[- ]?\d|Claude|Gemini))\b/i;

function publicUrl(raw?: string | null) {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !/\.[a-z]{2,}$/i.test(url.hostname) || /\.(?:local|internal|localhost)$/i.test(url.hostname)) return null;
    url.hash = '';
    return url;
  } catch { return null; }
}
const isHost = (host: string, domain: string) => host === domain || host.endsWith('.' + domain);
const floorPlanName = /(?:floor[-_ ]?plan|ground[-_ ]?floor|main[-_ ]?level|(?:[-_](?:plan|floor|fp))\d*\.(?:jpg|jpeg|png|webp))/i;
const branding = /(?:^|[/_-])(?:logo|icon|favicon|og-image|placeholder|banner|sprite|lovable-uploads)(?:[/_.-]|$)/i;

export async function findPublishedPlans(query: Query, key: string, fetchSource: typeof fetch = fetch) {
  const type = query.type === 'duplex' ? 'single-family house' : BUILDING_TYPES[query.type].label;
  const features = Object.entries(FEATURES).filter(([id]) => query.features.includes(id)).map(([, feature]) => feature.label);
  const brief = [TASTES[query.taste].label, type, `${query.storeys}-storey`,
    ...(isHouse(query.type) ? [`${query.bedrooms} bedrooms`] : []),
    ...(query.purpose && query.purpose !== 'exploring' ? [PURPOSES[query.purpose].short] : []),
    ...(query.study ? ['study'] : []), ...(query.openKitchen ? ['open-plan kitchen'] : []), ...features,
    ...(query.plot ? [`plot up to ${query.plot.widthM} by ${query.plot.depthM} metres`] : []),
    ...query.priorities.map((id) => PRIORITIES[id].label)].join(', ');
  const exa = new Exa(key, { timeout: 15_000, fetch: (url, init) => fetchSource(url, { ...init, redirect: 'error' }) });
  const search = (terms: string) => exa.search(
    terms,
    {
      objective: 'Find specific building designs with public previews and identifiable floor plan drawings. Rank close matches and varied layouts from different publishers. Exclude search pages, inspiration-only image galleries, AI generator landing pages, and generic articles. Extract storeys, bedrooms, disclosed build licence terms and explicit AI attribution when present.',
      contents: { highlights: true, extras: { imageLinks: 24 } },
    },
  );
  const result = await search(
    `${brief}. ${query.aiOnly ? 'Published AI-generated architectural floor plans with named model attribution' : 'Published individual designs from specialist architectural plan catalogues and architecture studios with visible floor plan previews'}.`,
  );
  const seen = new Set<string>();
  const cards = (hits: typeof result.results) => hits.flatMap((hit) => {
    const page = publicUrl(hit.url);
    const title = hit.title?.trim().slice(0, 145);
    if (!page || page.pathname === '/' || !title || seen.has(page.href)) return [];
    const highlights = (hit.highlights ?? []).map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    const evidence = [title, ...highlights].join(' ');
    const disclosedAi = aiDisclosure.test(evidence);
    if (query.aiOnly && !disclosedAi) return [];
    const domain = page.hostname.replace(/^www\./, '');
    const extras = (hit as { extras?: { imageLinks?: string[] } }).extras?.imageLinks ?? [];
    const assetUrls = [...new Set([hit.image, ...extras])].flatMap((raw) => {
      const url = publicUrl(raw);
      if (!url || branding.test(url.pathname)) return [];
      const publisherAsset = isHost(url.hostname, domain)
        || (isHost(page.hostname, 'archdaily.com') && isHost(url.hostname, 'adsttc.com'))
        || (isHost(page.hostname, 'houseplans.com') && isHost(url.hostname, 'houseplansservices.com'));
      return publisherAsset ? [url.href] : [];
    });
    const planPreview = assetUrls.find((url) => floorPlanName.test(new URL(url).pathname)) ?? null;
    const exteriorPreview = assetUrls.find((url) => !floorPlanName.test(new URL(url).pathname)) ?? null;
    if (!planPreview && !exteriorPreview) return [];
    seen.add(page.href);
    const catalogue = (isHost(page.hostname, 'architecturaldesigns.com') && /^\/house-plans\/(?!collections\/)[^/]+\/?$/.test(page.pathname))
      || (isHost(page.hostname, 'maramani.com') && page.pathname.startsWith('/products/'))
      || (isHost(page.hostname, 'houseplans.com') && page.pathname.startsWith('/plan/'));
    const requiresLicence = licensed.test(evidence) || catalogue;
    return [{ title, url: page.href, publisher: domain, planPreview, exteriorPreview,
      licence: requiresLicence ? 'required' as const : 'check' as const, disclosedAi,
      excerpt: highlights[0]?.slice(0, 220) ?? null }];
  });
  const plans = cards(result.results);
  if (!query.aiOnly && isHouse(query.type) && plans.filter((plan) => plan.planPreview).length < 3) {
    const more = await search(`${brief}. Individual licensable house designs with illustrated ground floor drawings and plan previews from specialist house plan publishers such as Maramani, Architectural Designs or Houseplans.`).catch(() => null);
    if (more) plans.push(...cards(more.results));
  }
  return plans.sort((a, b) => Number(!!b.planPreview) - Number(!!a.planPreview)).slice(0, 12);
}

export function registerPlanLibrary(app: FastifyInstance, s: Services) {
  app.post('/v1/build/library', async (req, reply) => {
    const client = clientOf(req, s);
    const limited = await s.limiter.hit(`plan-library:${client.ip}`, 15);
    if (limited) throw tooMany('Try searching again shortly.', limited);
    const parsed = input.safeParse(req.body);
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the search choices.');
    reply.header('cache-control', 'private, no-store');
    const key = process.env.EXA_API_KEY?.trim();
    if (!key) return { status: 'not_configured' as const, plans: [] };
    try {
      return { status: 'ready' as const, plans: await findPublishedPlans(parsed.data, key) };
    } catch {
      return { status: 'unavailable' as const, plans: [] };
    }
  });
}
