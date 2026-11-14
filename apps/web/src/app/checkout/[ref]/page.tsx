import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { api } from '@/lib/server';
import { DevPay } from './DevPay';

export const metadata: Metadata = { title: 'Checkout', robots: { index: false } };

/**
 * Hosted checkout. In production the API's checkout URL points at the payment provider; this page is the
 * development stand-in, which completes payment through the same signed webhook the provider would send.
 */
export default async function Checkout({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;
  const r = await api<any>(`/v1/checkout/${encodeURIComponent(ref)}`);
  if (r.status !== 200) notFound();
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
        : c.devProvider ? <DevPay checkoutRef={ref} /> : <p>Payment is handled by our payment provider.</p>}
    </div>
  );
}
