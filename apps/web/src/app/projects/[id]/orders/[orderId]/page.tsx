import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { OrderView } from '@/components/procurement/Display';
import { FulfilmentPanel } from '@/components/procurement/Fulfilment';
import { OrderActions } from '@/components/procurement/ProcurementControls';
import { canDo, loadProject } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Order' };

export default async function ClientOrder({ params }: { params: Promise<{ id: string; orderId: string }> }) {
  const { id, orderId } = await params;
  const p = await loadProject(id);
  if (!p || !/^[0-9a-f-]{36}$/.test(orderId)) notFound();
  const r = await api<any>(`/v1/orders/${orderId}`);
  if (r.status !== 200 || r.data.projectId !== id) notFound();
  const o = r.data;
  const f = await api<any>(`/v1/orders/${orderId}/fulfilment`);
  return (
    <div className="stack">
      <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href={`/projects/${id}/rfqs`}>Procurement</Link></li><li aria-current="page">{o.reference}</li></ol></nav>
      <OrderView o={o} rfqHref={`/projects/${id}/rfqs/${o.rfq.id}`} />
      <OrderActions orderId={o.id} version={o.version} commands={o.commands} canClose={f.status === 200 ? f.data.close.canClose : false} />
      {f.status === 200 && <FulfilmentPanel f={f.data} />}
      {canDo(p, 'payments.read') && <p className="small" style={{ margin: 0 }}>Every payment on this project, including ones not linked to an order, is on the <Link href={`/projects/${id}/payments`}>payments page</Link>.</p>}
    </div>
  );
}
