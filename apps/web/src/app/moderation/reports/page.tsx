import type { Metadata } from 'next';
import Link from 'next/link';
import { ago } from '@/lib/format';
import { api } from '@/lib/server';
import { DecideReport } from '../ModControls';

export const metadata: Metadata = { title: 'Reports' };

export default async function Reports() {
  const r = await api<{ items: any[]; reviewRemovalReasons?: { value: string; label: string }[] }>('/v1/moderation/reports');
  return (
    <>
      <h1>Reports <span className="muted" style={{ fontWeight: 400 }}>({r.data.items.length})</span></h1>
      <p className="small muted">Scam, impersonation and unsafe-work reports are listed first.</p>
      {r.data.items.length === 0 ? <p className="notice">No open reports.</p> : (
        <ul className="plain stack">
          {r.data.items.map((x) => (
            <li key={x.id} className="card stack-sm">
              <div className="inline">{x.priority && <span className="pill pill-bad">Priority</span>}<strong>{x.reasonLabel}</strong><span className="small muted">{x.targetType} · reported by {x.reporter} · {ago(x.createdAt)}</span></div>
              {x.target ? <div>{x.target.path ? <Link href={x.target.path}>{x.target.title}</Link> : x.target.title}{x.target.status ? <span className="small muted"> ({x.target.status})</span> : null}{x.target.sellerOrgId && <> · <Link className="small" href={`/moderation/sellers/${x.target.sellerOrgId}`}>Seller</Link></>}</div> : <div className="muted">Target no longer exists</div>}
              {x.details && <p className="small" style={{ margin: 0 }}>{x.details}</p>}
              <DecideReport id={x.id} targetType={x.targetType} reviewReasons={r.data.reviewRemovalReasons ?? []} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
