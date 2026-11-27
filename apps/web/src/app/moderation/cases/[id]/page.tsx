import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CaseSummary } from '@/components/procurement/Trust';
import { api } from '@/lib/server';
import { CaseCommands, StaffCaseMessage } from '../../ModControls';

export const metadata: Metadata = { title: 'Case' };

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '');

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await api<any>(`/v1/moderation/cases/${id}`);
  if (r.status !== 200) notFound();
  const c = r.data;
  return (
    <div className="stack">
      <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href="/moderation/cases">Cases</Link></li><li aria-current="page">{c.reference}</li></ol></nav>
      <h1 style={{ margin: 0 }}>Case {c.reference}</h1>
      <section className="card stack-sm" aria-label="Case summary">
        <CaseSummary c={c} />
        <p className="small muted" style={{ margin: 0 }}>
          {c.order.reference} ({c.order.state.replace(/_/g, ' ')}) · {c.rfqTitle} · supplier <Link href={`/seller/${c.provider.handle}`}>{c.provider.name}</Link> · project {c.project}.
          Raised by {c.people.raisedBy}{c.people.triagedBy ? `; triaged by ${c.people.triagedBy}` : ''}{c.people.decidedBy ? `; decided by ${c.people.decidedBy}` : ''}{c.people.appealReviewer ? `; appeal reviewed by ${c.people.appealReviewer}` : ''}.
        </p>
      </section>

      <section className="stack-sm" aria-labelledby="act-h">
        <h2 id="act-h" style={{ fontSize: '1.1rem', margin: 0 }}>Actions</h2>
        <CaseCommands c={c} />
      </section>

      <section className="stack-sm" aria-labelledby="log-h">
        <h2 id="log-h" style={{ fontSize: '1.1rem', margin: 0 }}>Communication log</h2>
        <ol className="plain stack-sm">
          {c.messages.map((m: any) => (
            <li key={m.id} className="card small" style={m.internal ? { borderStyle: 'dashed' } : undefined}>
              <strong>{m.role === 'client' ? `Client (${m.author})` : m.role === 'provider' ? `Supplier (${m.author})` : m.role === 'staff' ? `Staff (${m.staffName})` : 'BuildWise'}</strong>
              {m.internal && <> <span className="pill">Staff only</span></>} <span className="muted">{when(m.at)}</span>
              <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
            </li>
          ))}
        </ol>
        {c.state !== 'final' && <StaffCaseMessage id={c.id} />}
      </section>

      <section className="stack-sm" aria-labelledby="ev-h">
        <h2 id="ev-h" style={{ fontSize: '1.1rem', margin: 0 }}>Evidence</h2>
        {c.evidence.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None attached.</p> : (
          <ul className="small">{c.evidence.map((e: any) => <li key={e.id}>{e.documentTitle}, rev {e.revision} ({e.fileName}), from the {e.side}{e.note ? `: ${e.note}` : ''}. <span className="muted">SHA-256 {e.sha256?.slice(0, 12)}…</span></li>)}</ul>
        )}
        <p className="small muted" style={{ margin: 0 }}>Evidence files are project documents. Open them with a reason-coded <Link href="/moderation/project-access">project access session</Link>.</p>
      </section>

      <section className="stack-sm" aria-labelledby="au-h">
        <h2 id="au-h" style={{ fontSize: '1.1rem', margin: 0 }}>Audit trail</h2>
        <div className="table-wrap">
          <table className="small">
            <caption className="sr-only">Hash-chained audit events for this case</caption>
            <thead><tr><th scope="col">#</th><th scope="col">Action</th><th scope="col">By</th><th scope="col">When</th><th scope="col">Hash</th></tr></thead>
            <tbody>{c.audit.map((a: any) => <tr key={a.seq}><td>{a.seq}</td><td>{a.action}</td><td>{a.actor ?? 'System'}</td><td>{when(a.at)}</td><td><code>{a.hash.slice(0, 10)}</code></td></tr>)}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
