import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { api, getMe } from '@/lib/server';
import { MyAdRow, RestrictionNotice } from './MyAdRow';

export const metadata: Metadata = { title: 'My ads', robots: { index: false } };

export default async function MyAds() {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=/my-ads');
  const orgs = me.organizations.filter((o) => ['owner', 'admin', 'member'].includes(o.role));
  const [lists, restrictions] = await Promise.all([
    Promise.all(orgs.map((o) => api<{ items: any[] }>(`/v1/my/listings?orgId=${o.id}`).then((r) => ({ org: o, items: r.data.items ?? [] })))),
    api<{ items: any[] }>('/v1/my/restrictions'),
  ]);
  return (
    <div className="stack">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>My ads</h1>
        <div className="inline"><Link className="btn" href="/account/promotions">Promotions and invoices</Link><Link className="btn btn-primary" href="/post">Post an ad</Link></div>
      </div>
      {restrictions.data.items.map((r) => <RestrictionNotice key={r.id} r={r} />)}
      {lists.map(({ org, items }) => (
        <section key={org.id} aria-labelledby={`org-${org.id}`}>
          {lists.length > 1 && <h2 id={`org-${org.id}`}>{org.name}{org.kind === 'personal' ? ' (personal)' : ''}</h2>}
          {items.length === 0 ? <p className="muted" id={lists.length > 1 ? undefined : `org-${org.id}`}>No ads yet.</p> : (
            <ul className="plain stack">{items.map((l) => <li key={l.id}><MyAdRow l={l} /></li>)}</ul>
          )}
        </section>
      ))}
    </div>
  );
}
