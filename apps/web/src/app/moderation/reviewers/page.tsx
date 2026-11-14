import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { RecordQualification } from '@/components/estimates/StaffControls';
import { loadProjectConfig } from '@/lib/projects';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Reviewers' };

export default async function Reviewers() {
  const me = await getMe();
  if (me?.staffRole !== 'ops_admin') notFound();
  const r = await api<{ items: { id: string; name: string; activeAssignments: number }[] }>('/v1/review/reviewers');
  const items = r.data.items ?? [];
  const cfg = await loadProjectConfig();
  return (
    <>
      <h1>Reviewers</h1>
      <p className="small muted">A reviewer can complete and issue estimates only for project classes where they hold a current, recorded qualification.</p>
      {items.length === 0 ? <p className="notice">No staff accounts have the reviewer role.</p> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <caption className="sr-only">Staff reviewers</caption>
            <thead><tr><th scope="col">Reviewer</th><th scope="col" className="num">Active assignments</th></tr></thead>
            <tbody>{items.map((x) => <tr key={x.id}><td>{x.name}</td><td className="num">{x.activeAssignments}</td></tr>)}</tbody>
          </table>
        </div>
      )}
      <section className="card stack-sm" aria-labelledby="q-h">
        <h2 id="q-h" style={{ margin: 0 }}>Record a qualification</h2>
        <RecordQualification reviewers={items} classes={cfg.classes ?? []} />
      </section>
    </>
  );
}
