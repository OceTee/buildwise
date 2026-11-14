import type { Metadata } from 'next';
import { ago } from '@/lib/format';
import { api } from '@/lib/server';
import { DecideReview, ReleaseMessage } from '../ModControls';

export const metadata: Metadata = { title: 'Held content' };

export default async function Held() {
  const r = await api<{ messages: any[]; reviews: any[] }>('/v1/moderation/held');
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
    </>
  );
}
