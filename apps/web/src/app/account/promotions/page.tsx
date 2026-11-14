import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { dateText } from '@/lib/format';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Promotions and invoices', robots: { index: false } };

const STATUS: Record<string, string> = {
  pending_payment: 'Awaiting payment', paid: 'Paid, starts when the ad is live', active: 'Running', paused: 'Paused while the ad is not live',
  expired: 'Finished', cancelled: 'Cancelled', refunded: 'Refunded', credited: 'Converted to credit', forfeited: 'Forfeited',
};

export default async function Promotions() {
  if (!(await getMe())) redirect('/sign-in?next=/account/promotions');
  const r = await api<{ items: any[]; credits: any[] }>('/v1/my/promotions');
  return (
    <div className="stack" style={{ maxWidth: '56rem' }}>
      <h1>Promotions and invoices</h1>
      {r.data.credits.length > 0 && (
        <div className="notice notice-good">You have {r.data.credits.length} promotion credit(s) ({r.data.credits.map((c) => `${c.days} days`).join(', ')}). Use one from <Link href="/my-ads">My ads</Link> → Promote.</div>
      )}
      {r.data.items.length === 0 ? <p className="muted">No promotions yet. Promote a live ad from <Link href="/my-ads">My ads</Link>.</p> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <caption className="sr-only">Your promotions</caption>
            <thead><tr><th scope="col">Ad</th><th scope="col">Promotion</th><th scope="col">Status</th><th scope="col">Total</th><th scope="col">Invoice</th></tr></thead>
            <tbody>
              {r.data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.listingPath ? <Link href={p.listingPath}>{p.listingTitle}</Link> : p.listingTitle}</td>
                  <td>{p.productName}</td>
                  <td>{STATUS[p.status] ?? p.status}{p.status === 'active' && p.endsAt ? <div className="small muted">until {dateText(p.endsAt)}</div> : null}{p.checkoutRef && <div><Link className="small" href={`/checkout/${p.checkoutRef}`}>Pay now</Link></div>}</td>
                  <td>{p.gross.display}</td>
                  <td>{p.invoiceNumber ? <Link href={`/account/invoices/${p.invoiceNumber}`}>{p.invoiceNumber}</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
