import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NewRfiForm } from '@/components/projects/ProjectControls';
import { canDo, loadProject } from '@/lib/projects';
import { dateText } from '@/lib/format';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'RFIs' };

export default async function Rfis({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p || !canDo(p, 'rfi.read')) notFound();
  const [r, members] = await Promise.all([api<{ items: any[] }>(`/v1/projects/${id}/rfis`), canDo(p, 'members.read') ? api<{ members: any[] }>(`/v1/projects/${id}/members`) : Promise.resolve({ data: { members: [] } })]);
  return (
    <div className="stack">
      <h1 style={{ fontSize: '1.3rem', margin: 0 }}>Requests for information</h1>
      {canDo(p, 'rfi.create') && !p.viaStaffSession && <NewRfiForm projectId={id} members={members.data.members.map((m: any) => ({ userId: m.userId, name: m.name }))} />}
      {r.data.items.length === 0 ? <p className="muted">No RFIs yet.</p> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <caption className="sr-only">RFIs</caption>
            <thead><tr><th scope="col">No.</th><th scope="col">Subject</th><th scope="col">Status</th><th scope="col">Reference</th><th scope="col">Assigned</th><th scope="col">Due</th></tr></thead>
            <tbody>
              {r.data.items.map((x) => (
                <tr key={x.id}>
                  <td>{x.number}</td>
                  <td><Link href={`/projects/${id}/rfis/${x.id}`}>{x.subject}</Link><div className="small muted">by {x.author}, {dateText(x.createdAt)}</div></td>
                  <td><span className={`pill ${x.status === 'open' ? (x.overdue ? 'pill-bad' : 'pill-warn') : 'pill-good'}`}>{x.status}{x.overdue ? ' · overdue' : ''}</span></td>
                  <td className="small">{x.reference ? `${x.reference.document} rev ${x.reference.revision}${x.reference.page ? `, p${x.reference.page}` : ''}` : x.estimateLineId ? 'Estimate line' : '—'}</td>
                  <td className="small">{x.assignee ?? '—'}</td>
                  <td className="small">{x.dueDate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
