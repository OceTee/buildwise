import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Gallery } from '@/components/Gallery';
import { ListingActions } from '@/components/ListingActions';
import { ListingCard, type CardListing } from '@/components/ListingCard';
import { SITE_URL } from '@/lib/env';
import { dateText, perBaseText, priceText } from '@/lib/format';
import { api, getMarket, getMe } from '@/lib/server';

type Props = { params: Promise<{ slug: string }> };

async function load(slug: string) {
  const short = slug.match(/([0-9a-f]{12})$/)?.[1];
  if (!short) return null;
  const r = await api<any>(`/v1/public/listings/${short}`);
  return r.status === 200 ? r.data : null;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const l = await load((await params).slug);
  if (!l) return { title: 'Listing not found', robots: { index: false } };
  if (!l.available) return { title: `${l.title} (no longer available)`, robots: { index: false, follow: true } };
  const desc = `${priceText(l)}${l.area ? ` in ${l.area.label}` : ''}. ${String(l.description).slice(0, 140)}`;
  return {
    title: l.title, description: desc, alternates: { canonical: l.path },
    openGraph: { title: l.title, description: desc, images: l.photos?.[0] ? [{ url: l.photos[0].urls.full, width: l.photos[0].width, height: l.photos[0].height }] : [] },
  };
}

export default async function ListingPage({ params }: Props) {
  const { slug } = await params;
  const l = await load(slug);
  if (!l) notFound();
  const [me, market] = await Promise.all([getMe(), getMarket()]);

  if (!l.available) {
    return (
      <div className="stack">
        <h1>{l.title}</h1>
        <div className="notice notice-warn">This listing is no longer available. Here are similar listings nearby.</div>
        <div className="grid">{(l.similar as CardListing[]).map((x) => <ListingCard key={x.id} l={x} />)}</div>
      </div>
    );
  }

  const isOwner = !!me?.organizations.some((o) => o.id === l.seller.id);
  const per = perBaseText(l);
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': l.listingType === 'product' ? 'Product' : 'Service',
    name: l.title, description: l.description, url: `${SITE_URL}${l.path}`,
    image: (l.photos as any[]).map((p) => `${SITE_URL}${p.urls.full}`),
    ...(l.listingType === 'product' ? { category: l.category.name } : { serviceType: l.category.name, areaServed: [l.area?.label, ...l.serviceAreas].filter(Boolean) }),
    ...(l.price && !l.quoteOnRequest ? { offers: { '@type': 'Offer', price: (Number(l.price.amountMinor) / 100).toFixed(2), priceCurrency: l.price.currency, availability: 'https://schema.org/InStock', seller: { '@type': 'Organization', name: l.seller.name } } } : {}),
  };
  const checks: Record<string, string> = { business_registration: 'Business registration checked', identity_contact: 'Contact details checked', professional_credential: 'Professional credential checked', trade_reference: 'Trade reference checked', stock_evidence: 'Stock seen' };

  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c') }} />
      <nav aria-label="Breadcrumb" className="breadcrumbs">
        <ol>
          <li><Link href="/">Home</Link></li>
          {l.area && <li><Link href={`/${l.area.code}/${l.category.slug}`}>{l.category.name} in {l.area.label}</Link></li>}
          <li aria-current="page">{l.title}</li>
        </ol>
      </nav>
      <div className="layout-2">
        <div className="stack">
          <Gallery photos={l.photos} title={l.title} />
          <section className="card stack-sm" aria-labelledby="t">
            <h1 id="t" style={{ marginBottom: 0 }}>{l.title}</h1>
            <div className="price-big">{priceText(l)}</div>
            {per && <div className="muted">{per} · compare across pack sizes</div>}
            <div className="inline small">
              {l.negotiable && <span className="pill">Negotiable</span>}
              {l.deliveryOffered && <span className="pill">Delivery offered</span>}
              <span className="muted">Price confirmed {dateText(l.priceConfirmedAt)}</span>
            </div>
            <p className="muted small" style={{ margin: 0 }}>{l.area ? `${l.area.label}, ${l.area.region}` : ''}{l.serviceAreas.length ? ` · Also serves ${l.serviceAreas.join(', ')}` : ''}</p>
            {l.category.slug === 'house-plans' && l.hasDesignFile && (
              <div className="stack-sm">
                <Link href={`/build?plan=${encodeURIComponent(l.id)}`} className="btn btn-primary" aria-describedby="try-plan-hint">Try this design on my plot</Link>
                <p id="try-plan-hint" className="small muted" style={{ margin: 0 }}>Opens this architect&rsquo;s design in 3D on your own plot, with the building rules checked, before you buy.</p>
              </div>
            )}
          </section>
          <section className="card" aria-labelledby="details-h">
            <h2 id="details-h">Details</h2>
            <dl className="facts">
              <dt>Category</dt><dd>{l.category.name}</dd>
              {(l.attributes as { key: string; label: string; value: string; declared: boolean }[]).map((a) => (
                <div key={a.key} style={{ display: 'contents' }}><dt>{a.label.replace(/ \(declared\)/i, '')}</dt><dd>{a.value}{a.declared && <span className="small muted"> (declared by seller, not checked)</span>}</dd></div>
              ))}
            </dl>
            {l.description && <><h3 style={{ marginTop: '1rem' }}>Description</h3><p style={{ whiteSpace: 'pre-wrap' }}>{l.description}</p></>}
          </section>
        </div>

        <aside className="stack" aria-label="Seller and contact">
          <section className="card stack-sm" aria-labelledby="seller-h">
            <h2 id="seller-h"><Link href={`/seller/${l.seller.handle}`}>{l.seller.name}</Link></h2>
            <div className="small muted">{l.seller.kind === 'business' ? 'Business' : 'Individual'} · on BuildWise since {dateText(l.seller.memberSince)}</div>
            {l.seller.checks.length > 0 && <ul className="plain stack-sm">{l.seller.checks.map((c: any) => <li key={c.type}><span className="pill pill-good">{checks[c.type] ?? c.type}</span></li>)}</ul>}
            <p className="small" style={{ margin: 0 }}>
              {l.seller.reputation.enoughData
                ? <>Replies to {l.seller.reputation.replyRatePct}% of messages{l.seller.reputation.medianReplyMinutes != null ? `, usually within ${l.seller.reputation.medianReplyMinutes < 60 ? `${l.seller.reputation.medianReplyMinutes} min` : `${Math.round(l.seller.reputation.medianReplyMinutes / 60)} h`}` : ''}.</>
                : <span className="muted">Not enough recent chats to show a reply rate.</span>}
              {l.seller.reputation.reviewCount > 0 && <> · {l.seller.reputation.averageRating?.toFixed(1)} ★ from {l.seller.reputation.reviewCount} reviews</>}
            </p>
          </section>
          <ListingActions
            listingId={l.id} sellerOrgId={l.seller.id} signedIn={!!me} isOwner={isOwner} chatOnly={l.seller.chatOnly}
            favourite={l.favourite} units={[l.unit]} unitLabel={l.unitLabel} areas={market.regions.flatMap((r) => r.areas)} listingType={l.listingType}
            path={l.path}
          />
          <section className="card" aria-labelledby="safety-h">
            <h2 id="safety-h" style={{ fontSize: '1rem' }}>Stay safe</h2>
            <ul className="small" style={{ paddingLeft: '1.1rem', margin: 0 }}>{(l.safetyTips as string[]).map((t) => <li key={t}>{t}</li>)}</ul>
            <p className="small" style={{ marginTop: '.5rem', marginBottom: 0 }}><Link href="/help/safety">More safety advice</Link></p>
          </section>
        </aside>
      </div>

      {l.similar.length > 0 && (
        <section aria-labelledby="sim-h" style={{ marginTop: '2rem' }}>
          <h2 id="sim-h">Similar listings</h2>
          <div className="grid">{(l.similar as CardListing[]).filter((x) => x.id !== l.id).slice(0, 6).map((x) => <ListingCard key={x.id} l={x} />)}</div>
        </section>
      )}
    </>
  );
}
