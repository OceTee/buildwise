'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, errorText } from '@/lib/client';

function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const t = await fn(); if (t) setMsg({ ok: true, text: t }); router.refresh(); }
    catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  const status = <div role="status" aria-live="polite">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>;
  return { busy, run, status };
}

export function ProfileForm({ displayName, email }: { displayName: string; email: string | null }) {
  const a = useAction();
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => { await call('/v1/me', { method: 'PATCH', body: { displayName: String(f.get('displayName')), email: String(f.get('email') || '') || null } }); return 'Saved.'; }); }}>
      <div className="row">
        <div><label htmlFor="dn">Name</label><input id="dn" name="displayName" defaultValue={displayName} required minLength={2} maxLength={60} autoComplete="name" /></div>
        <div><label htmlFor="em">Email <span className="hint">Optional, for notifications</span></label><input id="em" name="email" type="email" defaultValue={email ?? ''} autoComplete="email" /></div>
      </div>
      <button className="btn btn-small" type="submit" disabled={a.busy}>Save profile</button>
      {a.status}
    </form>
  );
}

export function BusinessForm({ regions }: { regions: { code: string; label: string; areas: { code: string; label: string }[] }[] }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  if (!open) return <div><button type="button" className="btn btn-small" onClick={() => setOpen(true)}>Add a business</button>{a.status}</div>;
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => { await call('/v1/businesses', { body: { name: String(f.get('name')), email: String(f.get('email')), areaCode: String(f.get('area')) } }); setOpen(false); return 'Business created. You can now post ads as this business.'; }); }}>
      <div className="row">
        <div><label htmlFor="bn">Business name</label><input id="bn" name="name" required minLength={2} maxLength={80} /></div>
        <div><label htmlFor="be">Business email</label><input id="be" name="email" type="email" required /></div>
        <div><label htmlFor="ba">Area</label><select id="ba" name="area" required>{regions.map((r) => <optgroup key={r.code} label={r.label}>{r.areas.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}</optgroup>)}</select></div>
      </div>
      <div className="inline"><button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Create business</button><button type="button" className="btn btn-small" onClick={() => setOpen(false)}>Cancel</button></div>
      {a.status}
    </form>
  );
}

export function SessionRevoke({ id, everywhere, label }: { id?: string; everywhere?: boolean; label?: string }) {
  const a = useAction();
  return (
    <span>
      <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => {
        await call('/v1/me/sessions/revoke', { body: everywhere ? { everywhere: true } : { sessionId: id } });
        if (everywhere) window.location.href = '/sign-in';
      })} aria-label={everywhere ? undefined : `Sign out ${label ?? 'that device'}`}>{everywhere ? 'Sign out everywhere' : 'Sign out'}</button>
      {a.status}
    </span>
  );
}

export function MarkRead() {
  const a = useAction();
  return <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call('/v1/notifications/read', { body: {} }); })}>Mark all read</button>;
}

export function ReviewPrompt({ p }: { p: { revealId: string; sellerOrgId: string; sellerName: string; listingTitle: string } }) {
  const a = useAction();
  const [step, setStep] = useState<'ask' | 'review' | 'done'>('ask');
  return (
    <div className="stack-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: '.5rem' }}>
      <div><strong>{p.sellerName}</strong> <span className="small muted">about {p.listingTitle}</span></div>
      {step === 'ask' && (
        <div className="inline">
          <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/reveals/${p.revealId}/confirm`, { body: { dealt: true } }); setStep('review'); })}>Yes, review them</button>
          <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/reveals/${p.revealId}/confirm`, { body: { dealt: false } }); setStep('done'); })}>No</button>
        </div>
      )}
      {step === 'review' && (
        <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
          const r = await call(`/v1/sellers/${p.sellerOrgId}/reviews`, { body: { rating: Number(f.get('rating')), body: String(f.get('body')) } });
          setStep('done'); return r.status === 'pending' ? 'Thanks. Your review will appear after a quick check.' : 'Thanks. Your review is published.';
        }); }}>
          <fieldset style={{ margin: 0 }}><legend>Rating</legend><div className="inline">{[5, 4, 3, 2, 1].map((n) => <label key={n} className="check"><input type="radio" name="rating" value={n} required /> {n} ★</label>)}</div></fieldset>
          <label htmlFor={`rv-${p.revealId}`}>Your review</label>
          <textarea id={`rv-${p.revealId}`} name="body" required minLength={10} maxLength={2000} />
          <button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Publish review</button>
        </form>
      )}
      {a.status}
    </div>
  );
}

export function DeleteAccount() {
  const [confirmText, setConfirm] = useState('');
  const [error, setError] = useState('');
  return (
    <form className="stack-sm" onSubmit={async (e) => {
      e.preventDefault();
      try { await call('/v1/me', { method: 'DELETE', body: { confirm: 'DELETE' } }); await fetch('/api/session', { method: 'DELETE' }); window.location.href = '/'; }
      catch (x) { setError(errorText(x)); }
    }}>
      <label htmlFor="del">Type DELETE to confirm</label>
      <input id="del" value={confirmText} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" style={{ maxWidth: '14rem' }} />
      <button className="btn btn-danger btn-small" type="submit" disabled={confirmText !== 'DELETE'}>Delete my account</button>
      {error && <p role="alert" className="small notice notice-bad" style={{ margin: 0 }}>{error}</p>}
    </form>
  );
}
