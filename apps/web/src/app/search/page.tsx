import type { Metadata } from 'next';
import { SearchResults, toQuery, type SearchParams, type SearchResponse } from '@/components/SearchResults';
import { api, getCategories, getMarket, getMe } from '@/lib/server';

const KEYS = ['q', 'category', 'area', 'sort', 'min', 'max', 'unit', 'condition', 'brand', 'delivery', 'sellerType', 'verified', 'page'];

function pick(sp: Record<string, string | string[] | undefined>): SearchParams {
  return Object.fromEntries(KEYS.map((k) => [k, typeof sp[k] === 'string' && sp[k] ? (sp[k] as string).slice(0, 100) : undefined]).filter(([, v]) => v));
}

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const p = pick(await searchParams);
  // Free-text and filtered result pages are not indexed; curated area/category pages are (spec §3.6).
  return { title: p.q ? `“${p.q}”` : 'Search', robots: { index: false, follow: true } };
}

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = pick(await searchParams);
  const [categories, market, me, res] = await Promise.all([getCategories(), getMarket(), getMe(), api<SearchResponse | { error: { message: string } }>(`/v1/search?${toQuery(params)}`)]);
  const cat = categories.find((c) => c.slug === params.category);
  const area = market.regions.flatMap((r) => r.areas).find((a) => a.code === params.area);
  const heading = params.q ? `Results for “${params.q}”` : cat ? cat.name : 'All listings';
  return (
    <>
      <h1>{heading}{area ? ` in ${area.label}` : ''}</h1>
      {res.status !== 200 || !('groups' in res.data)
        ? <div className="notice notice-warn" role="alert">{'error' in res.data ? res.data.error.message : 'Search is unavailable. Try again.'}</div>
        : <SearchResults params={params} result={res.data} categories={categories} market={market} signedIn={!!me} />}
    </>
  );
}
