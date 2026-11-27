import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ORDER_STATE, Pill, QUOTE_STATE, RFQ_STATE, when } from '@/components/procurement/Display';
import { ProviderToggle } from '@/components/procurement/ProcurementControls';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Requests for quotes', robots: { index: false } };

/** The provider inbox (spec §16: Leads/RFQs · Quotes · Orders). */
export default async function ProviderRfqs() {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=/provider/rfqs');
  const [r, profiles] = await Promise.all([
    api<any>('/v1/provider/rfqs'),
    Promise.all(me.organizations.filter((o) => ['owner', 'admin'].includes(o.role)).map((o) => api<any>(`/v1/providers/${encodeURIComponent(o.handle)}`).then((x) => (x.status === 200 ? x.data : null)))),
  ]);
  const providers = profiles.filter((x) => x && x.categories.length > 0);
  const items: any[] = r.data.items ?? [];
  const orders: any[] = r.data.orders ?? [];
  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Requests for quotes</h1>
      <p className="small muted" style={{ margin: 0 }}>Clients invite you when your listings match the category and area and your checks are valid, or when they name you or approve you as a supplier. Quote exactly what is asked; mark substitutions and exclusions. Tenders are sealed: nobody reads a bid before the deadline.</p>
      {items.length === 0 ? <p className="muted">No requests yet. Keep your listings live and your checks current to be matched.</p> : (
        <ul className="plain stack-sm">
          {items.map((x) => (
            <li key={`${x.id}-${x.provider.orgId}`} className="card stack-sm">
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <Link href={`/provider/rfqs/${x.id}`}><strong>{x.reference}: {x.title}</strong>{x.kind === 'tender' && <span className="sr-only"> (sealed tender)</span>}</Link>
                <span className="inline"><Pill map={RFQ_STATE} k={x.state} />{x.quoteStatus && x.quoteStatus !== 'draft' ? <Pill map={QUOTE_STATE} k={x.quoteStatus} /> : <span className="pill">{x.invitationState === 'declined' ? 'Declined' : 'Not quoted'}</span>}</span>
              </div>
              <div className="small muted">{x.kind === 'tender' ? 'Sealed tender · ' : ''}{x.category.name} · {x.area.label} · respond by {when(x.deadline)} · for {x.provider.name}</div>
            </li>
          ))}
        </ul>
      )}
      {providers.length > 0 && (
        <section aria-labelledby="pp-h" className="stack-sm">
          <h2 id="pp-h">Your provider profiles</h2>
          <p className="small muted" style={{ margin: 0 }}>Built from your storefront: live listings set your categories and service areas, and your verification checks decide which requests you can be matched to.</p>
          <ul className="plain stack-sm">
            {providers.map((p: any) => (
              <li key={p.orgId} className="card inline" style={{ justifyContent: 'space-between' }}>
                <span><Link href={`/seller/${p.handle}`}>{p.name}</Link> <span className="small muted">· {p.categories.map((c: any) => c.name).join(', ')} · {p.acceptsRfqs ? 'accepting requests' : 'paused'}</span></span>
                <ProviderToggle orgId={p.orgId} accepts={p.acceptsRfqs} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {orders.length > 0 && (
        <section aria-labelledby="po-h" className="stack-sm">
          <h2 id="po-h">Orders</h2>
          <ul className="plain stack-sm">{orders.map((o) => <li key={o.id} className="card inline" style={{ justifyContent: 'space-between' }}><Link href={`/provider/orders/${o.id}`}>{o.kind === 'contract' ? 'CT' : 'PO'}-{String(o.number).padStart(3, '0')} · {o.title}</Link><span className="inline"><Pill map={ORDER_STATE} k={o.state} /><strong>{o.total.display}</strong></span></li>)}</ul>
        </section>
      )}
    </div>
  );
}
