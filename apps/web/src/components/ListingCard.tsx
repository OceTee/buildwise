import Link from 'next/link';
import { BadgeCheck, ImageOff, MapPin, Truck } from 'lucide-react';
import { ago, perBaseText, priceText } from '@/lib/format';

export interface CardListing {
  id: string; path: string; title: string; price: { amountMinor: string; currency: string } | null; unit: string; unitLabel?: string;
  negotiable?: boolean; quoteOnRequest?: boolean; perBaseUnit?: { amountMinor: string; currency: string; unit: string } | null;
  area: { label: string; region: string } | null; deliveryOffered?: boolean; photo: { urls: { card: string; thumb: string }; alt: string | null } | null;
  sellerName?: string | null; sellerKind?: string | null; publishedAt: string | null; verified?: boolean;
}

export function ListingCard({ l, slot, priority = false }: { l: CardListing; slot?: 'organic' | 'top' | 'promoted'; priority?: boolean }) {
  const per = perBaseText(l);
  return (
    <article className="lcard">
      <div className="lcard-media">
        {l.photo
          ? <img className="lcard-photo" src={l.photo.urls.card} alt={l.photo.alt ?? ''} loading={priority ? 'eager' : 'lazy'} width={640} height={480} />
          : <div className="lcard-placeholder" aria-hidden="true"><ImageOff size={22} /></div>}
        {slot && slot !== 'organic' && <span className="pill pill-promo lcard-promo">{slot === 'top' ? 'Top ad' : 'Promoted'}</span>}
      </div>
      <div className="lcard-body">
        <div className="lcard-price">{priceText(l)}</div>
        {per && <div className="small muted">{per}</div>}
        <h3 style={{ fontSize: '1rem', margin: 0 }}><Link className="lcard-title" href={l.path}>{l.title}</Link></h3>
        <div className="lcard-meta">
          {l.area && <><MapPin size={13} aria-hidden="true" />{l.area.label}, {l.area.region}</>}{l.publishedAt ? ` · ${ago(l.publishedAt)}` : ''}
        </div>
        <div className="inline" style={{ gap: '.3rem', marginTop: 'auto', paddingTop: '.3rem' }}>
          {l.verified && <span className="pill pill-good"><BadgeCheck size={12} aria-hidden="true" />Checked business</span>}
          {l.deliveryOffered && <span className="pill"><Truck size={12} aria-hidden="true" />Delivery</span>}
          {l.negotiable && <span className="pill">Negotiable</span>}
        </div>
      </div>
    </article>
  );
}
