import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { dateText } from '@/lib/format';
import { api } from '@/lib/server';
import { RecordCheck, RestrictionActions, RestrictSeller } from '../../ModControls';

export const metadata: Metadata = { title: 'Seller' };

export default async function SellerAdmin({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const r = await api<any>(`/v1/moderation/sellers/${orgId}`);
  if (r.status !== 200) notFound();
  const { seller, restrictions, listings } = r.data;
  return (
    <>
      <h1>{seller.name} <span className="small muted">({seller.kind})</span></h1>
      <p className="small"><Link href={`/seller/${seller.handle}`}>Public profile</Link> · since {dateText(seller.memberSince)} · {seller.checks.length} passed checks</p>
      <div className="layout-2">
        <div className="stack">
          <section className="card" aria-labelledby="sl">
            <h2 id="sl">Listings</h2>
            <div className="table-wrap"><table><thead><tr><th scope="col">Title</th><th scope="col">Status</th><th scope="col">Risk</th><th scope="col">Updated</th></tr></thead>
              <tbody>{listings.map((l: any) => <tr key={l.id}><td>{l.title}</td><td>{l.status}</td><td>{l.riskScore}</td><td>{dateText(l.updatedAt)}</td></tr>)}</tbody></table></div>
          </section>
          <section className="card stack-sm" aria-labelledby="sr">
            <h2 id="sr">Restrictions</h2>
            {restrictions.length === 0 ? <p className="muted" style={{ margin: 0 }}>None.</p> : restrictions.map((x: any) => (
              <div key={x.id} className="inline" style={{ justifyContent: 'space-between' }}>
                <span><strong>{x.kind.replace(/_/g, ' ')}</strong> · {x.status.replace(/_/g, ' ')} · {x.reason}{x.endsAt ? ` · until ${dateText(x.endsAt)}` : ''}</span>
                {['active', 'pending_second_approval'].includes(x.status) && <RestrictionActions id={x.id} status={x.status} />}
              </div>
            ))}
          </section>
        </div>
        <aside className="stack">
          <section className="card" aria-labelledby="ra"><h2 id="ra">Restrict</h2><RestrictSeller orgId={orgId} /></section>
          <section className="card" aria-labelledby="rc"><h2 id="rc">Record a check</h2><RecordCheck orgId={orgId} /></section>
        </aside>
      </div>
    </>
  );
}
