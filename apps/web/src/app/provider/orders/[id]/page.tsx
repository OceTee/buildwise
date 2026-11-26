import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { OrderView } from '@/components/procurement/Display';
import { FulfilmentPanel } from '@/components/procurement/Fulfilment';
import { OrderActions } from '@/components/procurement/ProcurementControls';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Order', robots: { index: false } };

export default async function ProviderOrder({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getMe())) redirect(`/sign-in?next=/provider/orders/${id}`);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await api<any>(`/v1/orders/${id}`);
  if (r.status !== 200 || r.data.side !== 'provider') notFound();
  const o = r.data;
  const f = await api<any>(`/v1/orders/${id}/fulfilment`);
  return (
    <div className="stack">
      <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href="/provider/rfqs">Requests for quotes</Link></li><li aria-current="page">{o.reference}</li></ol></nav>
      <OrderView o={o} rfqHref={`/provider/rfqs/${o.rfq.id}`} />
      <OrderActions orderId={o.id} version={o.version} commands={o.commands} />
      {f.status === 200 && <FulfilmentPanel f={f.data} />}
    </div>
  );
}
