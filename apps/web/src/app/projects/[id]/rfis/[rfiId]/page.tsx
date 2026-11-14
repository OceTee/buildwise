import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { RfiReply } from '@/components/projects/ProjectControls';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'RFI' };

const KIND: Record<string, string> = { question: 'Question', response: 'Response', decision: 'Design decision', note: 'Note' };

export default async function Rfi({ params }: { params: Promise<{ id: string; rfiId: string }> }) {
  const { id, rfiId } = await params;
  const r = await api<any>(`/v1/rfis/${rfiId}`);
  if (r.status !== 200) notFound();
  const x = r.data;
  return (
    <div className="stack" style={{ maxWidth: '48rem' }}>
      <div>
        <h1 style={{ fontSize: '1.3rem', margin: 0 }}>RFI {x.number}: {x.subject}</h1>
        <div className="inline small" style={{ marginTop: '.4rem' }}>
          <span className={`pill ${x.status === 'open' ? 'pill-warn' : 'pill-good'}`}>{x.status}</span>
          {x.assignee && <span>Assigned to {x.assignee}</span>}
          {x.dueDate && <span className={x.overdue ? '' : 'muted'}>{x.overdue ? 'Overdue: ' : 'Due '}{x.dueDate}</span>}
          {x.reference && x.documentId && <Link href={`/projects/${id}/documents/${x.documentId}`}>{x.reference.document} rev {x.reference.revision}{x.reference.page ? `, page ${x.reference.page}` : ''}</Link>}
        </div>
      </div>
      <ol className="plain stack" aria-label="History">
        {x.entries.map((e: any) => (
          <li key={e.id} className="card">
            <div className="small muted">{KIND[e.kind] ?? e.kind} · {e.author} · {new Date(e.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</div>
            <p style={{ margin: '.25rem 0 0', whiteSpace: 'pre-wrap' }}>{e.body}</p>
          </li>
        ))}
      </ol>
      <RfiReply rfiId={rfiId} open={x.canRespond && x.status !== 'closed'} />
      {x.status === 'closed' && <p className="notice small">This RFI is closed. Its history is kept as a record.</p>}
    </div>
  );
}
