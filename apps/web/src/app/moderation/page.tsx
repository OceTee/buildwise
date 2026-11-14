import type { Metadata } from 'next';
import Link from 'next/link';
import { ago, money } from '@/lib/format';
import { api } from '@/lib/server';
import { DecideListing } from './ModControls';

export const metadata: Metadata = { title: 'Review queue' };

export default async function Queue() {
  const r = await api<{ items: any[]; reasonCodes: { code: string; message: string }[] }>('/v1/moderation/queue');
  return (
    <>
      <h1>Review queue <span className="muted" style={{ fontWeight: 400 }}>({r.data.items.length})</span></h1>
      <p className="small muted">Highest risk first, then oldest. Each decision is recorded with its reason; a sample is re-checked.</p>
      {r.data.items.length === 0 ? <p className="notice">Nothing waiting for review.</p> : (
        <ul className="plain stack">
          {r.data.items.map((l) => (
            <li key={l.id} className="card stack-sm">
              <div className="inline" style={{ justifyContent: 'space-between' }}>
                <h2 style={{ margin: 0, fontSize: '1.1rem' }}>{l.title}</h2>
                <span className={`pill ${l.riskScore >= 50 ? 'pill-bad' : l.riskScore >= 20 ? 'pill-warn' : ''}`}>Risk {l.riskScore}</span>
              </div>
              <div className="small muted">
                {l.categorySlug} · {l.price ? `${money(l.price)} / ${l.unit}` : 'Quote on request'} · waiting {ago(l.waitingSince)} · version {l.version}
              </div>
              <div className="small">
                Seller: <Link href={`/moderation/sellers/${l.seller.orgId}`}>{l.seller.name}</Link> ({l.seller.kind}) · {l.seller.liveListings} live · {l.seller.priorRejections} recent rejections{l.openReports ? ` · ${l.openReports} open reports` : ''}
              </div>
              {l.signals.length > 0 && <ul className="small" style={{ margin: 0 }}>{l.signals.map((s: any, i: number) => <li key={i}><strong>{s.code.replace(/_/g, ' ')}</strong>: {s.detail} <span className="muted">(+{s.weight})</span></li>)}</ul>}
              {l.matchingListings.length > 0 && <div className="small notice notice-warn">Photos match: {l.matchingListings.map((m: any) => <span key={m.id}><Link href={m.path}>{m.title}</Link> by {m.seller}; </span>)}</div>}
              <div className="inline">{l.photos.map((p: any) => <a key={p.id} href={p.urls.full} target="_blank" rel="noreferrer"><img src={p.urls.thumb} alt={p.alt ?? 'Listing photo'} width={120} height={90} style={{ borderRadius: 6, objectFit: 'cover' }} /></a>)}</div>
              {l.description && <details><summary className="small">Description</summary><p className="small" style={{ whiteSpace: 'pre-wrap' }}>{l.description}</p></details>}
              <details><summary className="small">Attributes</summary><pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(l.attributes, null, 2)}</pre></details>
              <DecideListing id={l.id} version={l.version} reasonCodes={r.data.reasonCodes} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
