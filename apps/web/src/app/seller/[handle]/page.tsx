import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ListingCard, type CardListing } from '@/components/ListingCard';
import { dateText } from '@/lib/format';
import { api } from '@/lib/server';

type Props = { params: Promise<{ handle: string }> };
const load = async (handle: string) => { const r = await api<any>(`/v1/public/sellers/${encodeURIComponent(handle)}`); return r.status === 200 ? r.data : null; };
const loadProvider = async (handle: string) => { const r = await api<any>(`/v1/providers/${encodeURIComponent(handle)}`); return r.status === 200 ? r.data : null; };
const CHECK_STATE: Record<string, string> = { passed: 'Passed', failed: 'Failed', expired: 'Expired', revoked: 'Revoked' };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = await load((await params).handle);
  if (!d) return { title: 'Seller not found', robots: { index: false } };
  return { title: d.seller.name, description: `${d.seller.name}: ${d.listings.length} listings on BuildWise${d.serviceAreas.length ? ` in ${d.serviceAreas.join(', ')}` : ''}.`, alternates: { canonical: `/seller/${d.seller.handle}` }, robots: { index: d.listings.length > 0 } };
}

export default async function SellerPage({ params }: Props) {
  const { handle } = await params;
  const [d, provider] = await Promise.all([load(handle), loadProvider(handle)]);
  if (!d) notFound();
  const s = d.seller;
  const checkLabel: Record<string, string> = { business_registration: 'Business registration checked', identity_contact: 'Contact details checked', professional_credential: 'Professional credential checked', trade_reference: 'Trade reference checked', stock_evidence: 'Stock seen' };
  return (
    <div className="stack">
      <section className="card stack-sm">
        <h1 style={{ margin: 0 }}>{s.name}</h1>
        <p className="muted" style={{ margin: 0 }}>{s.kind === 'business' ? 'Business' : 'Individual'} · on BuildWise since {dateText(s.memberSince)}{d.serviceAreas.length ? ` · ${d.serviceAreas.join(', ')}` : ''}</p>
        {s.businessHours && <p style={{ margin: 0 }}>Hours: {s.businessHours}</p>}
        {s.businessAddress && <p style={{ margin: 0 }}>Address: {s.businessAddress}</p>}
        <div className="inline">{s.checks.map((c: any) => <span key={c.type} className="pill pill-good">{checkLabel[c.type] ?? c.type}</span>)}</div>
        <p className="small" style={{ margin: 0 }}>
          {s.reputation.enoughData ? `Replies to ${s.reputation.replyRatePct}% of messages.` : 'Not enough recent chats to show a reply rate.'}
          {s.reputation.reviewCount > 0 ? ` ${s.reputation.averageRating?.toFixed(1)} ★ from ${s.reputation.reviewCount} reviews.` : ' No reviews yet.'}
        </p>
        <p className="small muted" style={{ margin: 0 }}>Checks confirm specific facts on the date shown. They are not a guarantee of quality.</p>
      </section>

      {provider && (provider.categories.length > 0 || provider.verification.length > 0) && (
        <section aria-labelledby="pp-h" className="card stack-sm">
          <h2 id="pp-h" style={{ margin: 0, fontSize: '1.1rem' }}>Provider profile</h2>
          <p className="small" style={{ margin: 0 }}>
            {provider.acceptsRfqs ? 'Accepts requests for quotes' : 'Not taking new requests for quotes right now'}
            {provider.categories.length ? ` for ${provider.categories.map((c: any) => c.name).join(', ')}` : ''}
            {provider.serviceAreas.length ? ` in ${provider.serviceAreas.map((a: any) => a.label).join(', ')}` : ''}.
            {provider.capacityNote ? ` ${provider.capacityNote}` : ''}
          </p>
          {provider.verification.length > 0 && (
            <div className="table-wrap">
              <table className="small">
                <caption className="sr-only">Verification history</caption>
                <thead><tr><th scope="col">Check</th><th scope="col">Result</th><th scope="col">Checked</th><th scope="col">Expires</th></tr></thead>
                <tbody>{provider.verification.map((v: any, i: number) => <tr key={i}><td>{v.label}</td><td>{CHECK_STATE[v.state] ?? v.state}</td><td>{dateText(v.checkedAt)}</td><td>{v.expiresAt ? dateText(v.expiresAt) : '—'}</td></tr>)}</tbody>
              </table>
            </div>
          )}
          <p className="small" style={{ margin: 0 }}>
            {provider.performance.rfqInvitations > 0 ? `Answered ${provider.performance.rfqResponses} of ${provider.performance.rfqInvitations} requests for quotes. ` : ''}
            {provider.performance.orders > 0 ? `${provider.performance.orders} order${provider.performance.orders === 1 ? '' : 's'} through BuildWise. ` : ''}
            {provider.performance.websiteReviews.label}: {provider.performance.websiteReviews.count}.
          </p>
          <p className="small muted" style={{ margin: 0 }}>{provider.verificationStatement}</p>
        </section>
      )}

      <section aria-labelledby="l-h">
        <h2 id="l-h">Listings ({d.listings.length})</h2>
        {d.listings.length ? <div className="grid">{(d.listings as CardListing[]).map((l) => <ListingCard key={l.id} l={l} />)}</div> : <p className="muted">No live listings right now.</p>}
      </section>

      <section aria-labelledby="r-h">
        <h2 id="r-h">Reviews</h2>
        <p className="small muted">Only people who chatted, asked for a quote or contacted this seller can leave a review.</p>
        {d.reviews.length === 0 ? <p className="muted">No reviews yet.</p> : (
          <ul className="plain stack">
            {d.reviews.map((r: any) => (
              <li key={r.id} className="card">
                <div><strong aria-label={`${r.rating} out of 5 stars`}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</strong> <span className="small muted">{r.author} · {dateText(r.createdAt)}</span></div>
                <p style={{ margin: '.25rem 0 0' }}>{r.body}</p>
                {r.reply && <p className="small" style={{ margin: '.5rem 0 0', paddingLeft: '.75rem', borderLeft: '3px solid var(--border)' }}><strong>Seller reply:</strong> {r.reply.body}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
