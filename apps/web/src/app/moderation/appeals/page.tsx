import type { Metadata } from 'next';
import { ago } from '@/lib/format';
import { api } from '@/lib/server';
import { DecideAppeal } from '../ModControls';

export const metadata: Metadata = { title: 'Appeals' };

export default async function Appeals() {
  const r = await api<{ items: any[] }>('/v1/moderation/appeals');
  return (
    <>
      <h1>Appeals <span className="muted" style={{ fontWeight: 400 }}>({r.data.items.length})</span></h1>
      {r.data.items.length === 0 ? <p className="notice">No open appeals.</p> : (
        <ul className="plain stack">
          {r.data.items.map((x) => (
            <li key={x.id} className="card stack-sm">
              <div><strong>{x.seller}</strong> <span className="small muted">· {x.targetType === 'restriction' ? 'restriction' : 'listing decision'} · {ago(x.createdAt)}</span></div>
              {x.original && (x.targetType === 'moderation_decision'
                ? <div className="small">Original: <strong>{x.original.decision}</strong> of “{x.original.title}” for {x.original.reason_code?.replace(/_/g, ' ')}{x.original.note ? ` (${x.original.note})` : ''}</div>
                : <div className="small">Original: {x.original.kind?.replace(/_/g, ' ')}: {x.original.reason}</div>)}
              <blockquote style={{ margin: 0, paddingLeft: '.75rem', borderLeft: '3px solid var(--border)' }}>{x.statement}</blockquote>
              <DecideAppeal id={x.id} canDecide={x.canDecide} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
