'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { call, errorText, newKey } from '@/lib/client';
import { money } from '@/lib/format';

const FLAG_TEXT: Record<string, string> = {
  link: 'This message contains a link. Only open links you trust.',
  payment_instructions: 'This message asks for payment. Never pay before you have seen the goods.',
  off_platform: 'This message asks to move to another app. Keep the conversation here so you are protected.',
  contact_details_in_text: 'This message contains contact details. Be careful who you share yours with.',
  scam_signals: 'This message looks like a common scam. Do not send money or codes.',
};

export function Thread({ initial, reviewEligible }: { initial: any; reviewEligible: boolean }) {
  const [t, setT] = useState(initial);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewDone, setReviewDone] = useState('');
  const list = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => { try { setT(await call(`/v1/threads/${t.id}`)); } catch { /* keep current view */ } }, [t.id]);
  useEffect(() => { const i = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 10_000); return () => clearInterval(i); }, [refresh]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight }); }, [t.messages.length]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); await refresh(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  return (
    <div className="layout-2">
      <section aria-labelledby="th-h" className="card stack">
        <div className="inline">
          {t.listing.photo && <img src={t.listing.photo} alt="" width={64} height={48} style={{ borderRadius: 6, objectFit: 'cover' }} />}
          <div>
            <h1 id="th-h" style={{ fontSize: '1.2rem', margin: 0 }}>{t.counterpart}</h1>
            <div className="small">{t.listing.available ? <Link href={t.listing.path}>{t.listing.title}</Link> : <>{t.listing.title} <span className="muted">(no longer available)</span></>}</div>
          </div>
        </div>

        <div ref={list} className="chat" role="log" aria-label="Messages" aria-live="polite" tabIndex={0}>
          {t.messages.map((m: any) => (
            <div key={m.id} className={`msg ${m.mine ? 'msg-mine' : ''}`}>
              <div className="msg-meta">{m.author} · {new Date(m.at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}</div>
              <div>{m.body}</div>
              {m.held && <div className="small" style={{ color: 'var(--warn)' }}>Held for review: only you can see this until a moderator checks it.</div>}
              {!m.mine && (m.safetyFlags as string[]).map((f) => FLAG_TEXT[f] ? <div key={f} className="small" style={{ color: 'var(--warn)', marginTop: '.25rem' }}>⚠ {FLAG_TEXT[f]}</div> : null)}
            </div>
          ))}
        </div>

        {t.blocked.byThem ? <p className="notice small">You can't reply in this conversation.</p> : t.blocked.byMe ? <p className="notice small">You blocked this conversation.</p> : (
          <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; void run(async () => { await call(`/v1/threads/${t.id}/messages`, { body: { body: text }, idempotencyKey: newKey() }); setText(''); }); }}>
            <label htmlFor="reply" className="sr-only">Your message</label>
            <textarea id="reply" value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Write a message" style={{ minHeight: '4rem' }} />
            <div className="inline" style={{ justifyContent: 'space-between' }}>
              <button className="btn btn-primary" type="submit" disabled={busy || !text.trim()}>Send</button>
              <button type="button" className="linkish small" onClick={() => { if (confirm('Block this conversation? You will not get more messages from them here.')) void run(() => call(`/v1/threads/${t.id}/block`, { body: { blocked: true } })); }}>Block</button>
            </div>
          </form>
        )}
        <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
      </section>

      <aside className="stack">
        {t.quoteRequests.map((q: any) => (
          <section key={q.id} className="card stack-sm" aria-label="Quote request">
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Quote request</h2>
            <dl className="facts small">
              <dt>Quantity</dt><dd>{q.quantity} {q.unitLabel}</dd>
              <dt>Deliver to</dt><dd>{q.deliveryArea}</dd>
              {q.neededBy && <><dt>Needed by</dt><dd>{q.neededBy}</dd></>}
              <dt>Status</dt><dd>{q.status.replace(/_/g, ' ')}</dd>
              {q.answer?.price && <><dt>Quoted</dt><dd>{money(q.answer.price)}</dd></>}
            </dl>
            {q.notes && <p className="small" style={{ margin: 0 }}>{q.notes}</p>}
            {q.canAnswer && (
              <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(() => call(`/v1/quote-requests/${q.id}/answer`, { body: { price: String(f.get('price')), note: String(f.get('note') || '') || undefined } })); }}>
                <label htmlFor={`qp-${q.id}`}>Your total price</label>
                <input id={`qp-${q.id}`} name="price" inputMode="decimal" required />
                <label htmlFor={`qn-${q.id}`}>Note <span className="hint">Optional: delivery, timing</span></label>
                <input id={`qn-${q.id}`} name="note" maxLength={1000} />
                <div className="inline">
                  <button className="btn btn-small btn-primary" type="submit" disabled={busy}>Send quote</button>
                  <button className="btn btn-small" type="button" disabled={busy} onClick={() => run(() => call(`/v1/quote-requests/${q.id}/decline`, { body: {} }))}>Can't quote</button>
                </div>
              </form>
            )}
          </section>
        ))}

        {t.role === 'buyer' && reviewEligible && !reviewDone && (
          <section className="card stack-sm" aria-label="Review">
            {!reviewOpen ? <button type="button" className="btn" onClick={() => setReviewOpen(true)}>Review this seller</button> : (
              <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(async () => {
                const r = await call(`/v1/sellers/${t.listing.sellerOrgId}/reviews`, { body: { rating: Number(f.get('rating')), body: String(f.get('body')) } });
                setReviewDone(r.status === 'pending' ? 'Thanks. Your review will appear after a quick check.' : 'Thanks. Your review is published.');
              }); }}>
                <fieldset style={{ margin: 0 }}>
                  <legend>Rating</legend>
                  <div className="inline">{[5, 4, 3, 2, 1].map((n) => <label key={n} className="check"><input type="radio" name="rating" value={n} required /> {n} ★</label>)}</div>
                </fieldset>
                <label htmlFor="rv">What was your experience?</label>
                <textarea id="rv" name="body" required minLength={10} maxLength={2000} />
                <button className="btn btn-small btn-primary" type="submit" disabled={busy}>Publish review</button>
              </form>
            )}
          </section>
        )}
        {reviewDone && <p className="notice notice-good small" role="status">{reviewDone}</p>}

        <section className="card" aria-label="Safety">
          <h2 style={{ fontSize: '1rem' }}>Stay safe</h2>
          <ul className="small" style={{ paddingLeft: '1.1rem', margin: 0 }}>{t.safetyTips.map((s: string) => <li key={s}>{s}</li>)}</ul>
        </section>
      </aside>
    </div>
  );
}
