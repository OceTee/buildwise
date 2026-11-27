import type { Metadata } from 'next';
import Link from 'next/link';
import { Fragment } from 'react';
import { notFound } from 'next/navigation';
import { AddSupplierEntry, RemoveSupplierEntry } from '@/components/procurement/SupplierLists';
import { canDo, loadProject } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Supplier lists' };

/** The client's preferred, blocked, approved (framework) and conflict-of-interest lists (spec §13.1.5). */
export default async function SupplierLists({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p || !canDo(p, 'rfq.read')) notFound();
  const [r, cfg] = await Promise.all([api<any>(`/v1/projects/${id}/supplier-lists`), api<any>('/v1/procurement-config')]);
  if (r.status !== 200) notFound();
  const d = r.data;
  const cats: { slug: string; name: string }[] = cfg.status === 200 ? cfg.data.categories : [];
  return (
    <div className="stack">
      <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href={`/projects/${id}/rfqs`}>Procurement</Link></li><li aria-current="page">Supplier lists</li></ol></nav>
      <h1 style={{ fontSize: '1.3rem', margin: 0 }}>Supplier lists for {d.owner.name}</h1>
      <p className="small notice" style={{ margin: 0 }}>These lists apply to every request for quotes and tender on {d.owner.name}&apos;s projects. They never get a supplier past the required checks. Entries are never edited: remove one with a reason and add a new one, so every sourcing decision stays traceable.</p>
      <dl className="facts small">{d.kinds.map((k: any) => <Fragment key={k.code}><dt>{k.label}</dt><dd>{k.help}</dd></Fragment>)}</dl>
      {d.items.length === 0 ? <p className="muted">No suppliers on your lists yet.</p> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <caption className="sr-only">Suppliers on your lists</caption>
            <thead><tr><th scope="col">Supplier</th><th scope="col">List</th><th scope="col">Categories</th><th scope="col">Valid</th><th scope="col">Reason</th><th scope="col">Added</th>{d.canManage && <th scope="col"><span className="sr-only">Remove</span></th>}</tr></thead>
            <tbody>{d.items.map((i: any) => (
              <tr key={i.id}>
                <td><Link href={`/seller/${i.provider.handle}`}>{i.provider.name}</Link></td>
                <td><span className={`pill ${i.kind === 'blocked' || i.kind === 'conflict' ? 'pill-bad' : 'pill-good'}`}>{i.kindLabel}</span></td>
                <td className="small">{i.categorySlugs.length ? i.categorySlugs.map((c: string) => cats.find((x) => x.slug === c)?.name ?? c).join(', ') : 'All'}</td>
                <td className="small">{i.validFrom || i.validUntil ? `${i.validFrom ?? 'now'} to ${i.validUntil ?? 'open'}` : 'Open'}</td>
                <td className="small">{i.reason ?? '—'}</td>
                <td className="small">{i.addedBy}</td>
                {d.canManage && <td><RemoveSupplierEntry projectId={id} entryId={i.id} name={i.provider.name} /></td>}
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {d.canManage && <AddSupplierEntry projectId={id} kinds={d.kinds} categories={cats} />}
    </div>
  );
}
