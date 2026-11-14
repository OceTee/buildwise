import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { api } from '@/lib/server';
import { DevPay } from './DevPay';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

/**
 * Checkout status. With a real provider the buyer pays on the provider's page and comes back here; the API then
 * confirms the outcome with the provider. With the development provider this page is the checkout itself and
 * completes payment through the same signed webhook path a provider would use.
 */
export default async function Checkout({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  let r = await api<any>(`/v1/checkout/${encodeURIComponent(ref)}`);
  if (r.status !== 200) notFound();
  if (!r.data.devProvider && r.data.status === 'pending_payment') {
    await api(`/v1/checkout/${encodeURIComponent(ref)}/refresh`, { method: 'POST', body: {} });
    r = await api<any>(`/v1/checkout/${encodeURIComponent(ref)}`);
  }
  const c = r.data;
  return (
    <div className="card stack" style={{ maxWidth: '30rem', margin: '0 auto' }}>
      <h1>Checkout</h1>
      {c.devProvider && <p className="notice notice-warn small">Development payment page. No real money moves.</p>}
      <dl className="facts">
        <dt>Item</dt><dd>{c.productName}</dd>
        <dt>Ad</dt><dd>{c.listingTitle}</dd>
        <dt>Total</dt><dd><strong>{c.total.display}</strong></dd>
      </dl>
      {c.status !== 'pending_payment'
        ? <p className="notice" role="status">This checkout is {c.status === 'cancelled' ? 'cancelled' : 'already paid'}. <a href="/account/promotions">See your promotions</a>.</p>
        : c.devProvider ? <DevPay checkoutRef={ref} />
        : <p className="notice" role="status">We have not received confirmation of this payment yet. If you paid, it can take a minute: reload this page. Unpaid checkouts are cancelled after a day.</p>}
    </div>
  );
}
