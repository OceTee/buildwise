import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ORDER_STATE, Pill, RFQ_STATE, when } from '@/components/procurement/Display';
import { NewRfqForm, type RfqSources } from '@/components/procurement/ProcurementControls';
import { canDo, loadProject } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Procurement' };

/** Requests for quotes and orders for one project (R3, spec §10.4). */
export default async function Rfqs({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p || !canDo(p, 'rfq.read')) notFound();
  const manage = canDo(p, 'rfq.manage') && !p.viaStaffSession;
  const [list, sources, cfg] = await Promise.all([
    api<any>(`/v1/projects/${id}/rfqs`),
    manage ? api<RfqSources>(`/v1/projects/${id}/rfq-sources`) : Promise.resolve(null),
    manage ? api<any>('/v1/procurement-config') : Promise.resolve(null),
  ]);
  const items: any[] = list.data.items ?? [];
  const orders: any[] = list.data.orders ?? [];
  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Procurement</h1>
      <p className="notice small" style={{ margin: 0 }}>
        Ask eligible suppliers to price an exact scope, compare their quotes like for like and award one. Orders are records: payment is arranged directly with the supplier, and BuildWise does not process, hold or protect it.
      </p>
      <section aria-labelledby="rfq-h" className="stack-sm">
        <h2 id="rfq-h">Requests for quotes</h2>
        {items.length === 0 ? <p className="muted">No requests yet.</p> : (
          <div className="table-wrap card" style={{ padding: 0 }}>
            <table>
              <caption className="sr-only">Requests for quotes</caption>
              <thead><tr><th scope="col">Request</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col">Deadline</th><th scope="col" className="num">Quotes</th></tr></thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id}>
                    <td><Link href={`/projects/${id}/rfqs/${r.id}`}>{r.reference}: {r.title}</Link><div className="small muted">{r.scope.label}</div></td>
                    <td>{r.category.name}</td>
                    <td><Pill map={RFQ_STATE} k={r.state} /></td>
                    <td className="small">{when(r.deadline)}</td>
                    <td className="num">{r.quoted} of {r.invited}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {orders.length > 0 && (
        <section aria-labelledby="ord-h" className="stack-sm">
          <h2 id="ord-h">Orders</h2>
          <ul className="plain stack-sm">
            {orders.map((o) => <li key={o.id} className="card inline" style={{ justifyContent: 'space-between' }}><Link href={`/projects/${id}/orders/${o.id}`}>{o.reference} · {o.provider}</Link><span className="inline"><Pill map={ORDER_STATE} k={o.state} /><strong>{o.total.display}</strong></span></li>)}
          </ul>
        </section>
      )}
      {manage && sources && cfg && <NewRfqForm projectId={id} sources={sources.data} categories={cfg.data.categories} modes={cfg.data.sourcingModes} />}
    </div>
  );
}
