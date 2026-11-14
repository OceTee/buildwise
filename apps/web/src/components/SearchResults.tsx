import Link from 'next/link';
import type { Category, Market } from '@/lib/server';
import { ListingCard, type CardListing } from './ListingCard';
import { SaveSearchButton } from './SaveSearchButton';

export interface SearchResponse {
  total: number; page: number; pages: number; sort: string;
  groups: { key: string; label: string | null; items: { slot: 'organic' | 'top' | 'promoted'; listing: CardListing }[] }[];
}
export type SearchParams = Record<string, string | undefined>;

const SORTS = [['relevance', 'Best match'], ['newest', 'Newest'], ['price_asc', 'Lowest price'], ['price_desc', 'Highest price']] as const;

export function toQuery(p: SearchParams, extra: SearchParams = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...p, ...extra })) if (v) q.set(k, v);
  return q.toString();
}

/** Filters (a plain GET form, so it works without JavaScript) and the result grid with labelled paid slots. */
export function SearchResults({ params, result, categories, market, basePath = '/search', fixed = {}, signedIn }: {
  params: SearchParams; result: SearchResponse; categories: Category[]; market: Market; basePath?: string; fixed?: SearchParams; signedIn: boolean;
}) {
  const cat = categories.find((c) => c.slug === (params.category ?? fixed.category));
  const units = cat?.priceUnits ?? [];
  const hasCondition = !!cat?.attributes.some((a: any) => a.key === 'condition');
  const items = result.groups.flatMap((g) => g.items);
  return (
    <div className="layout-filters">
      <aside aria-label="Filters">
        <form action={basePath} className="card">
          {params.q !== undefined && !fixed.q && <input type="hidden" name="q" value={params.q} />}
          {!fixed.category && (
            <div className="field">
              <label htmlFor="f-cat">Category</label>
              <select id="f-cat" name="category" defaultValue={params.category ?? ''}>
                <option value="">All categories</option>
                {categories.map((c) => <option key={c.slug} value={c.slug}>{c.parent ? '— ' : ''}{c.name}</option>)}
              </select>
            </div>
          )}
          {!fixed.area && (
            <div className="field">
              <label htmlFor="f-area">Area</label>
              <select id="f-area" name="area" defaultValue={params.area ?? ''}>
                <option value="">Everywhere</option>
                {market.regions.map((r) => (
                  <optgroup key={r.code} label={r.label}>{r.areas.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}</optgroup>
                ))}
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="f-sort">Sort by</label>
            <select id="f-sort" name="sort" defaultValue={params.sort ?? 'relevance'}>
              {SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <fieldset>
            <legend>Price</legend>
            <div className="row">
              <div><label htmlFor="f-min" className="small">Min</label><input id="f-min" name="min" inputMode="decimal" defaultValue={params.min ?? ''} /></div>
              <div><label htmlFor="f-max" className="small">Max</label><input id="f-max" name="max" inputMode="decimal" defaultValue={params.max ?? ''} /></div>
            </div>
            {units.length > 1 && (
              <div className="field" style={{ marginTop: '.5rem', marginBottom: 0 }}>
                <label htmlFor="f-unit" className="small">Priced per</label>
                <select id="f-unit" name="unit" defaultValue={params.unit ?? ''}>
                  <option value="">Any unit</option>
                  {units.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            )}
          </fieldset>
          {hasCondition && (
            <div className="field">
              <label htmlFor="f-cond">Condition</label>
              <select id="f-cond" name="condition" defaultValue={params.condition ?? ''}>
                <option value="">Any</option><option value="new">New</option><option value="used">Used</option>
              </select>
            </div>
          )}
          <div className="field">
            <label htmlFor="f-seller">Seller</label>
            <select id="f-seller" name="sellerType" defaultValue={params.sellerType ?? ''}>
              <option value="">Anyone</option><option value="business">Businesses</option><option value="personal">Individuals</option>
            </select>
          </div>
          <div className="stack-sm field">
            <label className="check"><input type="checkbox" name="delivery" value="1" defaultChecked={params.delivery === '1'} /> Delivery offered</label>
            <label className="check"><input type="checkbox" name="verified" value="1" defaultChecked={params.verified === '1'} /> Checked businesses only</label>
          </div>
          <button className="btn btn-primary" type="submit" style={{ width: '100%' }}>Apply filters</button>
        </form>
      </aside>

      <section aria-labelledby="results-h">
        <div className="inline" style={{ justifyContent: 'space-between', marginBottom: '.5rem' }}>
          <h2 id="results-h" style={{ margin: 0 }}>{result.total === 1 ? '1 result' : `${result.total} results`}</h2>
          {signedIn && <SaveSearchButton query={{ ...params, ...fixed }} />}
        </div>
        {(result.sort === 'price_asc' || result.sort === 'price_desc') && result.groups.length > 1 && (
          <p className="small muted">Prices in different units are not ranked against each other, so results are grouped by unit.</p>
        )}
        {items.length === 0 ? (
          <div className="notice">
            <p><strong>No listings match.</strong> Try fewer filters, a nearby area, or a different word.</p>
            {signedIn ? <p className="small" style={{ margin: 0 }}>Save this search to hear when something is listed.</p> : <p className="small" style={{ margin: 0 }}><Link href="/sign-in">Sign in</Link> to save this search and get alerts.</p>}
          </div>
        ) : result.groups.map((g) => (
          <div key={g.key}>
            {g.label && <h3 className="group-label">{g.label}</h3>}
            <div className="grid">{g.items.map((it, i) => <ListingCard key={it.listing.id} l={it.listing} slot={it.slot} priority={i < 4} />)}</div>
          </div>
        ))}
        {result.pages > 1 && (
          <nav aria-label="Pages" className="inline" style={{ marginTop: '1.5rem' }}>
            {result.page > 1 && <Link className="btn" href={`${basePath}?${toQuery(params, { page: String(result.page - 1) })}`} rel="prev">Previous</Link>}
            <span className="muted">Page {result.page} of {result.pages}</span>
            {result.page < result.pages && <Link className="btn" href={`${basePath}?${toQuery(params, { page: String(result.page + 1) })}`} rel="next">Next</Link>}
          </nav>
        )}
        {items.some((x) => x.slot !== 'organic') && <p className="small muted" style={{ marginTop: '1rem' }}>“Top ad” and “Promoted” listings are paid placements. They only appear when they match your search and filters.</p>}
      </section>
    </div>
  );
}
