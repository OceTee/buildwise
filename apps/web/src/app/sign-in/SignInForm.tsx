'use client';
import { useRef, useState } from 'react';
import { call, errorText } from '@/lib/client';

type Step = 'phone' | 'code' | 'name';

export function SignInForm({ next, callingCode }: { next: string; callingCode: string }) {
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [masked, setMasked] = useState('');
  const [devCode, setDevCode] = useState<string | null>(null);
  const [existing, setExisting] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [hint, setHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);

  const go = (s: Step) => { setStep(s); setError(''); setTimeout(() => heading.current?.focus(), 0); };

  async function requestCode(e?: React.FormEvent) {
    e?.preventDefault(); setBusy(true); setError('');
    try {
      const r = await call<{ phoneMasked: string; devCode?: string }>('/v1/auth/otp/request', { body: { phone } });
      setMasked(r.phoneMasked); setDevCode(r.devCode ?? null); go('code');
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  }

  async function verify(body: Record<string, unknown>) {
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) { setError(data?.error?.message ?? 'That did not work. Try again.'); return; }
      if (data.needsName) { setExisting(!!data.existingAccount); setHint(data.accountHint ?? ''); go('name'); return; }
      window.location.href = next;
    } catch { setError('Check your connection and try again.'); } finally { setBusy(false); }
  }

  return (
    <div className="card stack">
      {step === 'phone' && (
        <form onSubmit={requestCode} className="stack-sm" noValidate>
          <h2 ref={heading} tabIndex={-1}>Your mobile number</h2>
          <label htmlFor="phone">Mobile number <span className="hint">For example {callingCode} 803 123 4567, or 0803 123 4567</span></label>
          <input id="phone" name="phone" type="tel" autoComplete="tel" inputMode="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} aria-invalid={!!error} aria-describedby={error ? 'err' : undefined} />
          <button className="btn btn-primary" type="submit" disabled={busy || phone.trim().length < 6}>Send code</button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={(e) => { e.preventDefault(); void verify({ phone, code }); }} className="stack-sm">
          <h2 ref={heading} tabIndex={-1}>Enter the code</h2>
          <p className="small" style={{ margin: 0 }}>We sent a code to {masked}. It expires in a few minutes.</p>
          {devCode && <p className="notice small" style={{ margin: 0 }}>Development mode: your code is <strong>{devCode}</strong>.</p>}
          <label htmlFor="code">6-digit code</label>
          <input id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} aria-invalid={!!error} aria-describedby={error ? 'err' : undefined} />
          <button className="btn btn-primary" type="submit" disabled={busy || code.length !== 6}>Continue</button>
          <div className="inline small">
            <button type="button" className="linkish" onClick={() => requestCode()} disabled={busy}>Send a new code</button>
            <button type="button" className="linkish" onClick={() => go('phone')}>Use a different number</button>
          </div>
        </form>
      )}

      {step === 'name' && (
        <form onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void verify({ phone, code, displayName: String(f.get('displayName')), freshAccount: fresh }); }} className="stack-sm">
          <h2 ref={heading} tabIndex={-1}>{existing && !fresh ? 'Confirm your account' : 'Create your account'}</h2>
          {existing && (
            <fieldset>
              <legend>This number has an account{hint ? ` (name starts ${hint})` : ''} that has not been used for a long time</legend>
              <label className="check"><input type="radio" name="who" checked={!fresh} onChange={() => setFresh(false)} /> It's mine: sign me in</label>
              <label className="check"><input type="radio" name="who" checked={fresh} onChange={() => setFresh(true)} /> It's not mine: I recently got this number</label>
              {fresh && <p className="small muted" style={{ margin: '.5rem 0 0' }}>We'll start a new account for you. The previous owner's chats, listings and details stay private and are not moved to you.</p>}
            </fieldset>
          )}
          {(!existing || fresh) && (
            <>
              <label htmlFor="displayName">Your name <span className="hint">Shown to people you chat with</span></label>
              <input id="displayName" name="displayName" autoComplete="name" required minLength={2} maxLength={60} />
            </>
          )}
          {existing && !fresh
            ? <button className="btn btn-primary" type="button" disabled={busy} onClick={() => verify({ phone, code, confirmExisting: true })}>Sign in</button>
            : <button className="btn btn-primary" type="submit" disabled={busy}>Create account</button>}
        </form>
      )}

      <div role="alert" id="err">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
    </div>
  );
}
