import Exa from 'exa-js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BUILDING_TYPES, isBuildingType } from '@bw/domain';
import { clientOf, type Services } from '../http/route.js';
import { badRequest, tooMany } from '../platform/platform.js';

export const planningLocation = z.object({ city: z.string().trim().max(60).default(''), state: z.string().trim().max(60).default(''), country: z.string().trim().max(60).default('') });
export const planningScope = (location?: z.infer<typeof planningLocation>) => location?.country && (location.city || location.state) ? 'local' as const : 'global' as const;
type Focus = { type?: string; taste?: string | null };

const webSearchResponse = z.object({
  results: z.array(z.object({
    title: z.string().nullish(),
    url: z.string(),
    highlights: z.array(z.string()).nullish(),
  })),
});

export async function discoverPlanningSources(location: z.infer<typeof planningLocation> | undefined, token: string, fetchSource: typeof fetch = fetch, focus?: Focus) {
  const place = planningScope(location) === 'local' && location ? [location.city, location.state, location.country].filter(Boolean).join(', ') : '';
  const type = focus?.type === 'duplex' ? 'two-storey single-family house'
    : isBuildingType(focus?.type) ? BUILDING_TYPES[focus.type].label : 'building';
  const taste = ['simple', 'modern', 'tropical', 'grand'].find((key) => key === focus?.taste);
  const exa = new Exa(token, {
    timeout: 12_000,
    fetch: (input, init) => fetchSource(input, { ...init, redirect: 'error' }),
  });
  const result = await exa.search(
    place ? `Prefer a specific primary or official answer page. Current planning, zoning, building code and permit documents for ${place}.`
      : `International contemporary ${taste ? taste + ' ' : ''}${type} architectural case studies with floor plans, distinct footprints, arrival sequences and well-used outdoor space.`,
    {
      contents: { highlights: true },
      objective: place
        ? 'Find the authority and applicable rules for evaluating a building concept. Rank current legislation and planning-authority documents first. Exclude general commentary and pull passages identifying the jurisdiction, applicable edition, zoning and permit requirements.'
        : 'Find transferable planning ideas from completed projects across several countries. Prefer architects’ project pages and case studies with published drawings. Extract the layout, site relationship and circulation decisions. Exclude generic image galleries.',
    },
  );
  const data = webSearchResponse.parse(result);
  const links = new Map<string, { title: string; url: string; host: string; excerpt: string | null }>();
  for (const result of data.results) {
    let link: URL;
    try { link = new URL(result.url); } catch { continue; }
    if (link.protocol !== 'https:' || link.username || link.password) continue;
    link.hash = '';
    const excerpt = result.highlights?.find((value) => value.trim())?.replace(/\s+/g, ' ').trim().slice(0, 400) ?? null;
    if (!links.has(link.href) || (!links.get(link.href)?.excerpt && excerpt)) {
      links.set(link.href, { title: result.title?.trim().slice(0, 180) || link.hostname, url: link.href, host: link.hostname, excerpt });
    }
  }
  return [...links.values()].slice(0, 8);
}

export async function reviewPlanningSources(location?: z.infer<typeof planningLocation>, focus?: Focus) {
  const status = { geometry: 'unverified' as const, scope: planningScope(location) };
  const token = process.env.EXA_API_KEY?.trim();
  if (!token) return { ...status, sourceStatus: 'not_configured' as const };
  try {
    return { ...status, sourceStatus: 'discovered' as const, candidates: await discoverPlanningSources(location, token, fetch, focus) };
  } catch {
    return { ...status, sourceStatus: 'unavailable' as const };
  }
}

export function registerBuildSources(app: FastifyInstance, s: Services) {
  app.get('/v1/build/sources', async (req, reply) => {
    const client = clientOf(req, s);
    const wait = await s.limiter.hit(`build-sources:${client.ip}`, 20);
    if (wait) throw tooMany('Try checking the sources again shortly.', wait);
    const parsed = planningLocation.extend({ type: z.string().max(30).optional(), taste: z.string().max(12).optional() }).safeParse(req.query ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the project location.');

    reply.header('cache-control', 'private, no-store');
    return reviewPlanningSources(parsed.data, parsed.data);
  });
}
