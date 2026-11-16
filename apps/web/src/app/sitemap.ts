import type { MetadataRoute } from 'next';
import { API_URL, SITE_URL } from '@/lib/env';

export const dynamic = 'force-dynamic';

/** Only live listings, sellers with live listings, and area–category pages with enough inventory (spec §3.6). */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const r = await fetch(`${API_URL}/v1/public/sitemap`, { cache: 'no-store' }).then((x) => x.json()).catch(() => null);
  if (!r) return [{ url: SITE_URL }];
  return [
    { url: SITE_URL, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/build`, changeFrequency: 'weekly', priority: 0.9 },
    { url: `${SITE_URL}/market`, changeFrequency: 'hourly', priority: 0.9 },
    ...r.pairs.map((p: { area: string; category: string }) => ({ url: `${SITE_URL}/${p.area}/${p.category}`, changeFrequency: 'daily' as const, priority: 0.8 })),
    ...r.listings.map((l: { path: string; updatedAt: string }) => ({ url: `${SITE_URL}${l.path}`, lastModified: l.updatedAt, priority: 0.6 })),
    ...r.sellers.map((s: string) => ({ url: `${SITE_URL}${s}`, priority: 0.4 })),
  ];
}
