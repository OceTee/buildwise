'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Flag, Heart, MessageCircle, Phone, ReceiptText } from 'lucide-react';
import { REPORT_REASONS } from '@bw/domain';
import { call, errorText, newKey } from '@/lib/client';

interface Props {
  listingId: string; sellerOrgId: string; signedIn: boolean; isOwner: boolean; chatOnly: boolean; favourite: boolean;
  units: string[]; unitLabel: string; areas: { code: string; label: string }[]; listingType: string; path: string;
}

/** Contact options on a listing: chat, phone reveal, quote request, save and report (spec §3.10). */
export function ListingActions(p: Props) {
  const router = useRouter();
  const [panel, setPanel] = useState<'none' | 'chat' | 'quote' | 'report'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState<{ phone: string; safetyTips: string[] } | null>(null);
  const [fav, setFav] = useState(p.favourite);
  const [done, setDone] = useState('');

  if (p.isOwner) {
    return (
      <section className="card stack-sm" aria-label="Your listing">
        <p style={{ margin: 0 }}>This is your listing.</p>
        <div className="inline"><Link className="btn" href="/my-ads">Manage in My ads</Link></div>
      </section>
    );
  }
  if (!p.signedIn) {
    return (
      <section className="card stack-sm" aria-label="Contact the seller">
        <p style={{ margin: 0 }}>Sign in with your phone number to chat, see the seller's number or ask for a quote.</p>
        <Link className="btn btn-primary" href={`/sign-in?next=${encodeURIComponent(p.path)}`}>Sign in to contact</Link>
      </section>
    );
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  const form = (e: React.FormEvent<HTMLFormElement>) => { e.preventDefault(); return Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>; };

  return (
    <section className="card stack-sm actions" aria-label="Contact the seller">
      <button type="button" className="btn btn-primary btn-lg" onClick={() => setPanel(panel === 'chat' ? 'none' : 'chat')} aria-expanded={panel === 'chat'}><MessageCircle size={18} aria-hidden="true" />Chat with seller</button>
      {panel === 'chat' && (
        <form onSubmit={(e) => { const f = form(e); void run(async () => { const r = await call(`/v1/listings/${p.listingId}/threads`, { body: { body: f.body }, idempotencyKey: newKey() }); router.push(`/messages/${r.threadId}`); }); }} className="stack-sm">
          <label htmlFor="chat-body">Message</label>
          <textarea id="chat-body" name="body" required maxLength={2000} defaultValue="Hello, is this still available?" />
          <button className="btn" type="submit" disabled={busy}>Send message</button>
        </form>
      )}

      {!p.chatOnly && (phone ? (
        <div className="notice" role="status">
          <div className="price-big" style={{ fontSize: '1.3rem' }}><a href={`tel:${phone.phone}`}>{phone.phone}</a></div>
          <p className="small" style={{ margin: 0 }}>Never pay a deposit before you have seen the goods.</p>
        </div>
      ) : (
        <button type="button" className="btn" disabled={busy} onClick={() => run(async () => setPhone(await call(`/v1/listings/${p.listingId}/reveal`, { method: 'POST' })))}><Phone size={17} aria-hidden="true" />Show phone number</button>
      ))}
      {p.chatOnly && <p className="small muted" style={{ margin: 0 }}>This seller prefers chat; their number is not shown.</p>}

      {p.listingType !== 'professional' && (
        <button type="button" className="btn" onClick={() => setPanel(panel === 'quote' ? 'none' : 'quote')} aria-expanded={panel === 'quote'}><ReceiptText size={17} aria-hidden="true" />Request a quote</button>
      )}
      {panel === 'quote' && (
        <form className="stack-sm" onSubmit={(e) => { const f = form(e); void run(async () => {
          const r = await call(`/v1/listings/${p.listingId}/quote-requests`, { body: { quantity: f.quantity, unit: f.unit, deliveryArea: f.deliveryArea, neededBy: f.neededBy || undefined, notes: f.notes || undefined }, idempotencyKey: newKey() });
          router.push(`/messages/${r.threadId}`);
        }); }}>
          <div className="row">
            <div><label htmlFor="q-qty">Quantity</label><input id="q-qty" name="quantity" inputMode="decimal" required pattern="\d+(\.\d+)?" /></div>
            <div><label htmlFor="q-unit">Unit</label><select id="q-unit" name="unit">{p.units.map((u) => <option key={u} value={u}>{p.unitLabel}</option>)}</select></div>
          </div>
          <div><label htmlFor="q-area">Deliver to</label><select id="q-area" name="deliveryArea" required>{p.areas.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}</select></div>
          <div><label htmlFor="q-by">Needed by <span className="hint">Optional</span></label><input id="q-by" name="neededBy" type="date" /></div>
          <div><label htmlFor="q-notes">Notes <span className="hint">Optional</span></label><textarea id="q-notes" name="notes" maxLength={1000} /></div>
          <button className="btn" type="submit" disabled={busy}>Send quote request</button>
        </form>
      )}

      <div className="inline">
        <button type="button" className="btn btn-small" aria-pressed={fav} disabled={busy} onClick={() => run(async () => { await call(`/v1/favourites/${p.listingId}`, { method: 'PUT', body: { saved: !fav } }); setFav(!fav); })}>
          <Heart size={15} aria-hidden="true" fill={fav ? 'currentColor' : 'none'} />{fav ? 'Saved' : 'Save'}
        </button>
        <button type="button" className="linkish small" onClick={() => setPanel(panel === 'report' ? 'none' : 'report')} aria-expanded={panel === 'report'}><Flag size={13} aria-hidden="true" /> Report this listing</button>
      </div>
      {panel === 'report' && (
        <form className="stack-sm" onSubmit={(e) => { const f = form(e); void run(async () => { await call('/v1/reports', { body: { targetType: 'listing', targetId: p.listingId, reason: f.reason, details: f.details || undefined } }); setDone('Thanks. A moderator will review this listing.'); setPanel('none'); }); }}>
          <label htmlFor="r-reason">What is wrong?</label>
          <select id="r-reason" name="reason" required>{Object.entries(REPORT_REASONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <label htmlFor="r-details">Details <span className="hint">Optional</span></label>
          <textarea id="r-details" name="details" maxLength={2000} />
          <button className="btn btn-danger" type="submit" disabled={busy}>Send report</button>
        </form>
      )}
      <div role="status" aria-live="polite">{done && <p className="notice notice-good small" style={{ margin: 0 }}>{done}</p>}</div>
      <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
    </section>
  );
}
