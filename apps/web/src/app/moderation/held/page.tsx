import type { Metadata } from 'next';
import { ago } from '@/lib/format';
import { api } from '@/lib/server';
import { DecideReview, DecideTransactionReview, ReleaseMessage } from '../ModControls';

export const metadata: Metadata = { title: 'Held content' };

export default async function Held() {
  const [r, tx] = await Promise.all([api<{ messages: any[]; reviews: any[] }>('/v1/moderation/held'), api<{ items: any[]; reasons: { value: string; label: string }[] }>('/v1/moderation/transaction-reviews')]);
  const txItems = tx.status === 200 ? tx.data.items : [];
  return (
    <>
      <h1>Held messages and reviews</h1>
      <section className="stack-sm" aria-labelledby="hm">
        <h2 id="hm">Messages ({r.data.messages.length})</h2>
        {r.data.messages.length === 0 ? <p className="muted">None.</p> : r.data.messages.map((m) => (
          <div key={m.id} className="card stack-sm"><div className="small muted">{m.sender} · {ago(m.at)}</div><p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{m.body}</p><ReleaseMessage id={m.id} /></div>
        ))}
      </section>
      <section className="stack-sm" aria-labelledby="hr">
        <h2 id="hr">Reviews ({r.data.reviews.length})</h2>
        {r.data.reviews.length === 0 ? <p className="muted">None.</p> : r.data.reviews.map((v) => (
          <div key={v.id} className="card stack-sm"><div className="small muted">{v.rating} ★ for {v.seller} · {ago(v.at)}</div><p style={{ margin: 0 }}>{v.body}</p><DecideReview id={v.id} /></div>
        ))}
      </section>
      <section className="stack-sm" aria-labelledby="ht">
        <h2 id="ht">Order reviews ({txItems.length})</h2>
        <p className="small muted" style={{ margin: 0 }}>Held by the content checks or reported. Remove only for a policy reason; a provider asking is not one.</p>
        {txItems.length === 0 ? <p className="muted">None.</p> : txItems.map((v: any) => (
          <div key={v.id} className="card stack-sm">
            <div className="small muted">{v.overall} ★ by the {v.side === 'client' ? 'client' : 'supplier'} ({v.author}) on an order with {v.provider}, {v.area} · {ago(v.at)}{v.holdReasons.length ? ` · held for: ${v.holdReasons.join(', ')}` : ''}{v.openReports ? ` · ${v.openReports} open report(s)` : ''}</div>
            <p style={{ margin: 0 }}>{v.body}</p>
            <DecideTransactionReview id={v.id} reasons={tx.data.reasons} />
          </div>
        ))}
      </section>
    </>
  );
}
