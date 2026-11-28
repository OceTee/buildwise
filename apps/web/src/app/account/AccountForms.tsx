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

type PrefTopic = { topic: string; label: string; help: string; email: boolean; sms: boolean };

/** Which notifications are also copied to email or SMS; in-app notifications are always kept. */
export function NotificationPrefs({ topics, hasEmail, hasPhone }: { topics: PrefTopic[]; hasEmail: boolean; hasPhone: boolean }) {
  const a = useAction();
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const body = Object.fromEntries(topics.map((t) => [t.topic, { email: f.get(`${t.topic}-email`) === 'on', sms: f.get(`${t.topic}-sms`) === 'on' }]));
      void a.run(async () => { await call('/v1/me/notification-preferences', { method: 'PUT', body }); return 'Saved.'; });
    }}>
      {topics.map((t) => (
        <fieldset key={t.topic} className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600 }}>{t.label} <span className="small muted" style={{ fontWeight: 400 }}>· {t.help}</span></legend>
          <div className="inline">
            <label className="inline" style={{ gap: '.35rem' }}><input type="checkbox" name={`${t.topic}-email`} defaultChecked={t.email} /> Email</label>
            <label className="inline" style={{ gap: '.35rem' }}><input type="checkbox" name={`${t.topic}-sms`} defaultChecked={t.sms} /> SMS</label>
          </div>
        </fieldset>
      ))}
      {!hasEmail && <p className="small muted" style={{ margin: 0 }}>Add an email address to your profile to get email copies.</p>}
      {!hasPhone && <p className="small muted" style={{ margin: 0 }}>SMS copies need a phone number on your account.</p>}
      <div><button className="btn btn-small" type="submit" disabled={a.busy}>Save notification settings</button></div>
      {a.status}
    </form>
  );
}

/** Correction of the phone number: a code goes to the new number; the old one is told. */
export function PhoneForm({ callingCode }: { callingCode: string }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  const [phone, setPhone] = useState('');
  const [sent, setSent] = useState<{ phoneMasked: string; devCode?: string } | null>(null);
  if (!open) return <div><button type="button" className="btn btn-small" onClick={() => setOpen(true)}>Change phone number</button>{a.status}</div>;
  if (!sent) {
    return (
      <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); void a.run(async () => { setSent(await call('/v1/me/phone/request', { body: { phone } })); }); }}>
        <label htmlFor="np">New mobile number <span className="hint">For example {callingCode} 803 123 4567. We text it a code.</span></label>
        <input id="np" type="tel" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} style={{ maxWidth: '18rem' }} />
        <div className="inline"><button className="btn btn-small btn-primary" type="submit" disabled={a.busy || phone.trim().length < 6}>Send code</button><button type="button" className="btn btn-small" onClick={() => setOpen(false)}>Cancel</button></div>
        {a.status}
      </form>
    );
  }
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      await call('/v1/me/phone/verify', { body: { phone, code: String(f.get('code')) } });
      setOpen(false); setSent(null); setPhone('');
      return 'Phone number changed. We told your old number too.';
    }); }}>
      <p className="small" style={{ margin: 0 }}>We sent a code to {sent.phoneMasked}.</p>
      {sent.devCode && <p className="notice small" style={{ margin: 0 }}>Development mode: the code is <strong>{sent.devCode}</strong>.</p>}
      <label htmlFor="npc">6-digit code</label>
      <input id="npc" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required style={{ maxWidth: '10rem' }} />
      <div className="inline"><button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Change number</button><button type="button" className="btn btn-small" onClick={() => setSent(null)}>Use a different number</button></div>
      {a.status}
    </form>
  );
}

export function BusinessDetails({ org, regions }: { org: { id: string; name: string; businessEmail: string | null; areaCode: string | null; reservedName: boolean }; regions: { code: string; label: string; areas: { code: string; label: string }[] }[] }) {
  const a = useAction();
  const [open, setOpen] = useState(false);
  if (!open) return <div><button type="button" className="btn btn-small" onClick={() => setOpen(true)} aria-label={`Edit details of ${org.name}`}>Edit details</button>{a.status}</div>;
  const p = `bd-${org.id}`;
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      const name = String(f.get('name'));
      await call(`/v1/organizations/${org.id}`, { method: 'PATCH', body: { ...(name !== org.name ? { name } : {}), businessEmail: String(f.get('email')), areaCode: String(f.get('area')) } });
      setOpen(false); return 'Business details saved.';
    }); }}>
      <div className="row">
        <div>
          <label htmlFor={`${p}-n`}>Business name {org.reservedName && <span className="hint">Verified: contact support to change it</span>}</label>
          <input id={`${p}-n`} name="name" defaultValue={org.name} required minLength={2} maxLength={80} readOnly={org.reservedName} />
        </div>
        <div><label htmlFor={`${p}-e`}>Business email</label><input id={`${p}-e`} name="email" type="email" defaultValue={org.businessEmail ?? ''} required /></div>
        <div><label htmlFor={`${p}-a`}>Area</label><select id={`${p}-a`} name="area" defaultValue={org.areaCode ?? undefined} required>{regions.map((r) => <optgroup key={r.code} label={r.label}>{r.areas.map((x) => <option key={x.code} value={x.code}>{x.label}</option>)}</optgroup>)}</select></div>
      </div>
      <div className="inline"><button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Save details</button><button type="button" className="btn btn-small" onClick={() => setOpen(false)}>Cancel</button></div>
      {a.status}
    </form>
  );
}

/** Builds the export on the server and downloads it through a short-lived signed link. */
export function DownloadData() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <div className="stack-sm">
      <div>
        <button type="button" className="btn btn-small" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const r = await call<{ url: string; bytes: number }>('/v1/me/export', { body: {} });
            const link = document.createElement('a');
            link.href = `/api${r.url}`;
            link.download = `buildwise-data-${new Date().toISOString().slice(0, 10)}.json`;
            document.body.appendChild(link); link.click(); link.remove();
            setMsg({ ok: true, text: `Your data is downloading (${Math.max(1, Math.round(r.bytes / 1024))} KB). The link works for a few minutes.` });
          } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
        }}>Download my data</button>
      </div>
      <div role="status" aria-live="polite">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
    </div>
  );
}
