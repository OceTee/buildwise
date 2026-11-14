import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SearchResults, toQuery, type SearchParams, type SearchResponse } from '@/components/SearchResults';
import { api, getCategories, getMarket, getMe } from '@/lib/server';

type Props = { params: Promise<{ area: string; category: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

async function resolve(p: Props['params']) {
  const { area, category } = await p;
  const [market, categories] = await Promise.all([getMarket(), getCategories()]);
  const a = market.regions.flatMap((r) => r.areas.map((x) => ({ ...x, region: r.label }))).find((x) => x.code === area);
  const c = categories.find((x) => x.slug === category);
  return a && c ? { a, c, market, categories } : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const r = await resolve(params);
  if (!r) return {};
  const res = await api<SearchResponse>(`/v1/search?category=${r.c.slug}&area=${r.a.code}`);
  return {
    title: `${r.c.name} in ${r.a.label}`,
    description: `${res.data.total} ${r.c.name.toLowerCase()} listings in ${r.a.label}, ${r.a.region}. Compare prices and contact sellers directly.`,
    alternates: { canonical: `/${r.a.code}/${r.c.slug}` },
    // Pages without inventory stay out of the index (spec §3.6 thin pages).
    robots: { index: res.data.total > 0, follow: true },
  };
}

/** Curated, indexable landing page for one area and category. */
export default async function AreaCategory({ params, searchParams }: Props) {
  const r = await resolve(params);
  if (!r) notFound();
  const sp = await searchParams;
  const extra: SearchParams = Object.fromEntries(['sort', 'min', 'max', 'unit', 'condition', 'delivery', 'sellerType', 'verified', 'page'].map((k) => [k, typeof sp[k] === 'string' ? (sp[k] as string) : undefined]));
  const fixed = { area: r.a.code, category: r.c.slug };
  const [me, res] = await Promise.all([getMe(), api<SearchResponse>(`/v1/search?${toQuery(extra, fixed)}`)]);
  const parent = r.categories.find((c) => c.slug === r.c.parent);
  return (
    <>
      <nav aria-label="Breadcrumb" className="breadcrumbs">
        <ol>
          <li><Link href="/">Home</Link></li>
          {parent && <li><Link href={`/${r.a.code}/${parent.slug}`}>{parent.name}</Link></li>}
          <li aria-current="page">{r.c.name} in {r.a.label}</li>
        </ol>
      </nav>
      <h1>{r.c.name} in {r.a.label}</h1>
      {r.c.seoText && <p className="muted">{r.c.seoText}</p>}
      <SearchResults params={{ ...extra }} fixed={fixed} result={res.data} categories={r.categories} market={r.market} basePath={`/${r.a.code}/${r.c.slug}`} signedIn={!!me} />
    </>
  );
}
