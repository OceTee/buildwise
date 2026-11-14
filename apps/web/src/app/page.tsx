import Link from 'next/link';
import { ListingCard } from '@/components/ListingCard';
import type { SearchResponse } from '@/components/SearchResults';
import { api, getCategories, getMarket } from '@/lib/server';

export default async function Home() {
  const [categories, market, latest] = await Promise.all([getCategories(), getMarket(), api<SearchResponse>('/v1/search?sort=newest')]);
  const top = categories.filter((c) => !c.parent);
  const items = latest.data.groups.flatMap((g) => g.items).slice(0, 8);
  return (
    <div className="stack" style={{ ['--gap' as string]: '2rem' }}>
      <section aria-labelledby="hero-h" className="card" style={{ padding: '1.5rem' }}>
        <h1 id="hero-h">Building materials, tools, plant and trades near you</h1>
        <p className="muted">Compare prices per bag, tonne or trip, chat with sellers, and ask for quotes. Free to browse and free to post.</p>
        <form action="/search" className="row" role="search" aria-label="Search listings">
          <div style={{ flex: '3 1 260px' }}>
            <label htmlFor="home-q" className="sr-only">What do you need?</label>
            <input id="home-q" name="q" type="search" placeholder="What do you need?" />
          </div>
          <div>
            <label htmlFor="home-area" className="sr-only">Area</label>
            <select id="home-area" name="area" defaultValue="">
              <option value="">Everywhere</option>
              {market.regions.map((r) => <optgroup key={r.code} label={r.label}>{r.areas.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}</optgroup>)}
            </select>
          </div>
          <button className="btn btn-primary" type="submit" style={{ flex: '0 0 auto' }}>Search</button>
        </form>
      </section>

      <section aria-labelledby="cat-h">
        <h2 id="cat-h">Browse by category</h2>
        <ul className="tiles plain">
          {top.map((c) => (
            <li key={c.slug}>
              <Link className="tile" href={`/search?category=${c.slug}`}>
                <strong>{c.name}</strong>
                <span className="small muted" style={{ display: 'block' }}>{c.liveCount === 1 ? '1 listing' : `${c.liveCount} listings`}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="latest-h">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <h2 id="latest-h" style={{ margin: 0 }}>Just listed</h2>
          <Link href="/search?sort=newest">See all</Link>
        </div>
        {items.length ? <div className="grid" style={{ marginTop: '.75rem' }}>{items.map((x, i) => <ListingCard key={x.listing.id} l={x.listing} priority={i < 4} />)}</div>
          : <p className="muted">Nothing listed yet. <Link href="/post">Be the first.</Link></p>}
      </section>

      <section aria-labelledby="areas-h">
        <h2 id="areas-h">Browse by area</h2>
        <div className="row">
          {market.regions.map((r) => (
            <div key={r.code} className="card">
              <h3>{r.label}</h3>
              <ul className="plain stack-sm">
                {r.areas.map((a) => <li key={a.code}><Link href={`/search?area=${a.code}`}>{a.label}</Link></li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
