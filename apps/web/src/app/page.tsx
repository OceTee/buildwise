import Link from 'next/link';
import { ArrowRight, ArrowUpRight, Boxes, DraftingCompass, HardHat, MapPin, Mountain, Package, Search, Sparkles, Tractor, Truck, Wrench, Zap, type LucideIcon } from 'lucide-react';
import { ListingCard } from '@/components/ListingCard';
import type { SearchResponse } from '@/components/SearchResults';
import { api, getCategories, getMarket } from '@/lib/server';

const CATEGORY_ICON: Record<string, LucideIcon> = {
  'building-materials': Package, 'tools-equipment': Wrench, 'plant-hire': Tractor, trades: HardHat, professionals: DraftingCompass, logistics: Truck,
};
const SUGGESTIONS: { label: string; href: string; icon: LucideIcon }[] = [
  { label: 'Cement', href: '/search?category=cement&sort=price_asc', icon: Package },
  { label: 'Blocks', href: '/search?category=blocks', icon: Boxes },
  { label: 'Sand and granite', href: '/search?category=sand-granite', icon: Mountain },
  { label: 'Masons', href: '/search?q=mason', icon: HardHat },
  { label: 'Tipper trucks', href: '/search?category=logistics', icon: Truck },
  { label: 'Electricians', href: '/search?q=electrician', icon: Zap },
];

export default async function Home() {
  const [categories, market, latest] = await Promise.all([getCategories(), getMarket(), api<SearchResponse>('/v1/search?sort=newest')]);
  const top = categories.filter((c) => !c.parent);
  const items = (latest.data?.groups ?? []).flatMap((g) => g.items).slice(0, 8);
  const live = top.reduce((n, c) => n + c.liveCount, 0);
  const areas = market.regions.reduce((n, r) => n + r.areas.length, 0);
  return (
    <>
      <section className="hero" aria-labelledby="hero-h">
        <Link href="/projects" className="announce glass rise"><span className="tag">New</span> Professionally reviewed estimates for your build <ArrowRight size={14} aria-hidden="true" /></Link>
        <h1 id="hero-h" className="rise rise-2">Everything your build needs, <span className="accent">near you</span></h1>
        <p className="lede rise rise-3">Materials, tools, plant hire and trusted trades. Compare prices per bag, tonne or trip, then chat or call the seller directly.</p>
        <form action="/search" className="prompt glass rise rise-4" role="search" aria-label="Search listings">
          <div className="prompt-row">
            <label htmlFor="home-q" className="sr-only">What do you need?</label>
            <input id="home-q" name="q" type="search" placeholder="What do you need? Try “42.5 cement” or “tiler”" autoComplete="off" />
            <label htmlFor="home-area" className="sr-only">Area</label>
            <select id="home-area" name="area" defaultValue="">
              <option value="">Everywhere</option>
              {market.regions.map((r) => <optgroup key={r.code} label={r.label}>{r.areas.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}</optgroup>)}
            </select>
            <button className="btn btn-primary" type="submit" aria-label="Search"><Search size={20} aria-hidden="true" /></button>
          </div>
        </form>
        <nav className="chips rise rise-4" aria-label="Popular searches">
          {SUGGESTIONS.map(({ label, href, icon: Icon }) => <Link key={label} className="chip" href={href}><Icon size={15} aria-hidden="true" />{label}</Link>)}
        </nav>
        <div className="stats rise rise-4">
          <div><strong>{live}</strong><span>live listings</span></div>
          <div><strong>{top.length}</strong><span>categories</span></div>
          <div><strong>{areas}</strong><span>areas</span></div>
        </div>
      </section>

      <section className="section reveal" aria-labelledby="cat-h">
        <div className="section-head">
          <div><h2 id="cat-h">Browse by category</h2><p>From a single bag of cement to a crane for the day.</p></div>
          <Link href="/search">All listings <ArrowUpRight size={16} aria-hidden="true" /></Link>
        </div>
        <ul className="tiles plain">
          {top.map((c) => {
            const Icon = CATEGORY_ICON[c.slug] ?? Package;
            return (
              <li key={c.slug}>
                <Link className="tile" href={`/search?category=${c.slug}`}>
                  <span className="tile-icon" aria-hidden="true"><Icon size={18} /></span>
                  <strong>{c.name}</strong>
                  <span className="small muted">{c.liveCount === 1 ? '1 listing' : `${c.liveCount} listings`}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="section reveal" aria-labelledby="latest-h">
        <div className="section-head">
          <div><h2 id="latest-h">Just listed</h2><p>The newest listings, checked before they went live.</p></div>
          <Link href="/search?sort=newest">See all <ArrowUpRight size={16} aria-hidden="true" /></Link>
        </div>
        {items.length ? (
          <ol className="ranked plain">
            {items.map((x, i) => (
              <li key={x.listing.id}><span className="rank-num" aria-hidden="true" data-rank={String(i + 1).padStart(2, '0')} /><ListingCard l={x.listing} priority={i < 4} /></li>
            ))}
          </ol>
        ) : <p className="muted">Nothing listed yet. <Link href="/post">Be the first.</Link></p>}
      </section>

      <section className="section cta-grid" aria-label="Get started">
        <div className="cta cta-accent reveal">
          <span className="eyebrow" style={{ color: 'inherit' }}><Sparkles size={14} aria-hidden="true" /> For sellers</span>
          <h2>Sell materials? <em>List free</em> today.</h2>
          <p>Post cement, blocks, tools or your trade in two minutes. Every ad is checked, so buyers trust what they see.</p>
          <div className="inline"><Link className="btn btn-lg" href="/post">Post an ad <ArrowRight size={18} aria-hidden="true" /></Link></div>
        </div>
        <div className="cta reveal">
          <span className="eyebrow"><DraftingCompass size={14} aria-hidden="true" /> For your build</span>
          <h2>Know the cost <em>before</em> you build.</h2>
          <p>Upload your drawings and get an estimate measured and priced by a qualified reviewer, or start with an instant indicative range.</p>
          <div className="inline"><Link className="btn btn-primary btn-lg" href="/projects/new">Start a project <ArrowRight size={18} aria-hidden="true" /></Link><Link className="btn btn-outline btn-lg" href="/help">How it works</Link></div>
        </div>
      </section>

      <section className="section reveal" aria-labelledby="areas-h">
        <div className="section-head"><div><h2 id="areas-h">Browse by area</h2><p>Sellers and trades who serve your area.</p></div></div>
        <div className="row">
          {market.regions.map((r) => (
            <div key={r.code} className="card">
              <h3 className="inline"><MapPin size={16} aria-hidden="true" style={{ color: 'var(--accent)' }} />{r.label}</h3>
              <div className="chips" style={{ justifyContent: 'flex-start', marginTop: '.6rem' }}>
                {r.areas.map((a) => <Link key={a.code} className="chip" href={`/search?area=${a.code}`}>{a.label}</Link>)}
              </div>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
