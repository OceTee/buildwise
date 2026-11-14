'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { call, errorText } from '@/lib/client';
import { dateText, priceText } from '@/lib/format';

const STATUS: Record<string, { label: string; cls: string; help: string }> = {
  draft: { label: 'Draft', cls: '', help: 'Not submitted yet.' },
  in_review: { label: 'In review', cls: 'pill-warn', help: 'A reviewer is checking this ad.' },
  live: { label: 'Live', cls: 'pill-good', help: 'Visible to buyers.' },
  rejected: { label: 'Needs changes', cls: 'pill-bad', help: 'Fix the issue below and resubmit.' },
  expired: { label: 'Expired', cls: '', help: 'Renew to show it again.' },
  closed: { label: 'Closed', cls: '', help: 'Hidden from buyers.' },
  blocked: { label: 'Removed', cls: 'pill-bad', help: 'Removed by moderation.' },
};

export function MyAdRow({ l }: { l: any }) {
  const router = useRouter();
  const [panel, setPanel] = useState<'' | 'renew' | 'close' | 'appeal'>('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const st = STATUS[l.status] ?? { label: l.status, cls: '', help: '' };

  async function act(fn: () => Promise<string>) {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); setPanel(''); router.refresh(); }
    catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  }
  const cmd = (c: string, extra: object = {}) => act(async () => {
    const r = await call(`/v1/listings/${l.id}/${c}`, { body: { expectedVersion: l.version, ...extra } });
    return r.listing?.status === 'live' ? 'Your ad is live.' : r.listing?.status === 'in_review' ? 'Sent for review.' : 'Done.';
  });

  return (
    <article className="card" aria-labelledby={`t-${l.id}`}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: '0 0 120px' }}>
          {l.photos?.[0] ? <img src={l.photos[0].urls.thumb} alt="" width={120} height={90} style={{ borderRadius: 6, objectFit: 'cover', width: 120, height: 90 }} /> : <div style={{ width: 120, height: 90, borderRadius: 6, background: 'var(--surface-2)' }} />}
        </div>
        <div style={{ flex: '1 1 300px' }} className="stack-sm">
          <div className="inline"><span className={`pill ${st.cls}`}>{st.label}</span><span className="small muted">{st.help}</span></div>
          <h3 id={`t-${l.id}`} style={{ margin: 0 }}>{l.status === 'live' ? <Link href={l.path}>{l.title}</Link> : l.title}</h3>
          <div>{priceText(l)}</div>
          <div className="small muted">
            {l.status === 'live' && l.expiresAt && <>Expires {dateText(l.expiresAt)} · </>}
            {l.views} views · {l.contacts} contacts · updated {dateText(l.updatedAt)}
          </div>
          {l.rejection && (
            <div className="notice notice-warn small">
              <strong>{l.rejection.message}</strong>{l.rejection.note ? <> {l.rejection.note}</> : null}
              {l.appeal?.status && <div>Appeal: {l.appeal.status === 'open' ? 'waiting for a different reviewer' : l.appeal.status}{l.appeal.outcomeNote ? `: ${l.appeal.outcomeNote}` : ''}</div>}
            </div>
          )}
          <div className="inline">
            {l.status !== 'blocked' && <Link className="btn btn-small" href={`/my-ads/${l.id}/edit`}>Edit</Link>}
            {l.allowedCommands.includes('submit') && <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => cmd('submit')}>Submit</button>}
            {l.allowedCommands.includes('resubmit') && <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => cmd('resubmit')}>Resubmit</button>}
            {l.allowedCommands.includes('renew') && <button type="button" className="btn btn-small" aria-expanded={panel === 'renew'} onClick={() => setPanel(panel === 'renew' ? '' : 'renew')}>Renew</button>}
            {l.allowedCommands.includes('reopen') && <button type="button" className="btn btn-small" disabled={busy} onClick={() => cmd('reopen')}>Reopen</button>}
            {(l.status === 'live' || l.status === 'in_review') && <Link className="btn btn-small" href={`/promote/${l.id}`}>Promote</Link>}
            {l.allowedCommands.includes('close') && <button type="button" className="btn btn-small" aria-expanded={panel === 'close'} onClick={() => setPanel(panel === 'close' ? '' : 'close')}>Close</button>}
            {l.appeal?.canAppeal && <button type="button" className="btn btn-small" aria-expanded={panel === 'appeal'} onClick={() => setPanel(panel === 'appeal' ? '' : 'appeal')}>Appeal</button>}
          </div>

          {panel === 'renew' && (
            <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); void cmd('renew', { confirmPrice: true }); }}>
              <label className="check"><input type="checkbox" required /> The price ({priceText(l)}) and availability are still correct</label>
              <div className="inline"><button className="btn btn-small btn-primary" type="submit" disabled={busy}>Renew</button><Link className="small" href={`/my-ads/${l.id}/edit`}>Change the price first</Link></div>
            </form>
          )}
          {panel === 'close' && (
            <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const reason = String(new FormData(e.currentTarget).get('reason')); void act(async () => { await call(`/v1/listings/${l.id}/close`, { body: { reason } }); return 'Closed.'; }); }}>
              <fieldset style={{ margin: 0 }}>
                <legend>Why are you closing it?</legend>
                <label className="check"><input type="radio" name="reason" value="sold" defaultChecked /> Sold or hired out</label>
                <label className="check"><input type="radio" name="reason" value="no_longer_available" /> No longer available</label>
                <label className="check"><input type="radio" name="reason" value="other" /> Other reason</label>
              </fieldset>
              <button className="btn btn-small" type="submit" disabled={busy}>Close ad</button>
            </form>
          )}
          {panel === 'appeal' && (
            <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const statement = String(new FormData(e.currentTarget).get('statement')); void act(async () => { await call('/v1/appeals', { body: { targetType: 'moderation_decision', targetId: l.appeal.decisionId, statement } }); return 'Appeal sent. A different reviewer will decide.'; }); }}>
              <label htmlFor={`ap-${l.id}`}>Why should we look again? <span className="hint">You can appeal each decision once.</span></label>
              <textarea id={`ap-${l.id}`} name="statement" required minLength={10} maxLength={2000} />
              <button className="btn btn-small" type="submit" disabled={busy}>Send appeal</button>
            </form>
          )}
          <div role="status" aria-live="polite">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
        </div>
      </div>
    </article>
  );
}

export function RestrictionNotice({ r }: { r: { id: string; kind: string; reason: string; endsAt: string | null; appealStatus: string | null } }) {
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="notice notice-bad stack-sm" role="region" aria-label="Account restriction">
      <strong>Your account has a restriction: {r.kind.replace(/_/g, ' ')}.</strong>
      <div>{r.reason}{r.endsAt ? ` Until ${dateText(r.endsAt)}.` : ''}</div>
      {r.appealStatus ? <div className="small">Appeal: {r.appealStatus}</div> : sent ? <div className="small">Appeal sent.</div> : (
        <form className="stack-sm" onSubmit={async (e) => { e.preventDefault(); try { await call('/v1/appeals', { body: { targetType: 'restriction', targetId: r.id, statement: String(new FormData(e.currentTarget).get('statement')) } }); setSent(true); } catch (x) { setError(errorText(x)); } }}>
          <label htmlFor={`rs-${r.id}`}>Appeal this restriction</label>
          <textarea id={`rs-${r.id}`} name="statement" required minLength={10} maxLength={2000} />
          <button className="btn btn-small" type="submit">Send appeal</button>
          {error && <p role="alert" className="small">{error}</p>}
        </form>
      )}
    </div>
  );
}
