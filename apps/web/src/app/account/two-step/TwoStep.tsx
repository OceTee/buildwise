'use client';
import { useState } from 'react';
import { call, errorText } from '@/lib/client';

interface Props { enrolled: boolean; verified: boolean; required: boolean; lockedUntil: string | null; recoveryCodesLeft: number; devCode: string | null; next: string; sessionHours: number }

export function TwoStep(p: Props) {
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; devCode?: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const devCode = setup?.devCode ?? p.devCode;

  async function start() {
    setBusy(true); setError('');
    try { setSetup(await call('/v1/staff/mfa/enrol', { body: {} })); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  async function verify(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setBusy(true); setError('');
    const f = new FormData(e.currentTarget);
    const value = String(f.get('code') ?? '').trim();
    try {
      const r = await call<{ verified: boolean; recoveryCodes?: string[] }>('/v1/staff/mfa/verify', { body: useRecovery ? { recoveryCode: value } : { code: value.replace(/\D/g, '') } });
      if (r.recoveryCodes) setCodes(r.recoveryCodes);
      else { setDone(true); window.location.href = p.next; }
    } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
  }

  if (codes) {
    return (
      <section className="card stack-sm" aria-labelledby="rc-h">
        <h2 id="rc-h" style={{ margin: 0 }}>Save your recovery codes</h2>
        <p className="small" style={{ margin: 0 }}>Each code works once if you lose your phone. Keep them somewhere safe, such as a password manager. They are not shown again.</p>
        <ul className="plain mono" aria-label="Recovery codes" style={{ columns: 2 }}>{codes.map((c) => <li key={c}>{c}</li>)}</ul>
        <div><button type="button" className="btn btn-primary" onClick={() => { window.location.href = p.next; }}>I have saved these codes</button></div>
      </section>
    );
  }

  const needsSetup = !p.enrolled;
  const codeForm = (
    <form className="stack-sm" onSubmit={verify}>
      {devCode && !useRecovery && <p className="notice small" style={{ margin: 0 }}>Development mode: your authenticator code is <strong>{devCode}</strong>.</p>}
      <label htmlFor="mfa-code">{useRecovery ? 'Recovery code' : 'Code from your authenticator app'}</label>
      {useRecovery
        ? <input id="mfa-code" name="code" autoComplete="off" required minLength={8} maxLength={20} style={{ maxWidth: '14rem' }} />
        : <input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required style={{ maxWidth: '10rem' }} />}
      <div className="inline">
        <button className="btn btn-primary" type="submit" disabled={busy || done}>{needsSetup ? 'Turn on two-step verification' : 'Verify'}</button>
        {p.enrolled && <button type="button" className="linkish small" onClick={() => { setUseRecovery(!useRecovery); setError(''); }}>{useRecovery ? 'Use a code from the app' : 'Use a recovery code'}</button>}
      </div>
    </form>
  );

  return (
    <div className="stack">
      {p.lockedUntil && <p className="notice notice-warn small" style={{ margin: 0 }}>Too many wrong codes. Try again after {new Date(p.lockedUntil).toLocaleTimeString()}.</p>}
      {!p.required && <p className="notice small" style={{ margin: 0 }}>Two-step verification is switched off in this development environment. You can still set it up to try it.</p>}

      {needsSetup && !setup && (
        <section className="card stack-sm" aria-labelledby="su-h">
          <h2 id="su-h" style={{ margin: 0 }}>Set up your authenticator</h2>
          <p className="small" style={{ margin: 0 }}>You only do this once. After that, BuildWise asks for a code when you open the staff tools on a new device or after {p.sessionHours} hours.</p>
          <div><button type="button" className="btn btn-primary" onClick={start} disabled={busy}>Set up two-step verification</button></div>
        </section>
      )}

      {needsSetup && setup && (
        <section className="card stack-sm" aria-labelledby="add-h">
          <h2 id="add-h" style={{ margin: 0 }}>Add BuildWise to your app</h2>
          <ol className="small stack-sm" style={{ margin: 0 }}>
            <li>In your authenticator app, add an account and choose to enter a setup key.</li>
            <li>Enter this key (time-based): <strong className="mono" style={{ wordBreak: 'break-all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</strong></li>
            <li>Or, on the phone that has the app, <a href={setup.otpauthUrl}>open this setup link</a>.</li>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          {codeForm}
        </section>
      )}

      {p.enrolled && (
        <section className="card stack-sm" aria-labelledby="v-h">
          <h2 id="v-h" style={{ margin: 0 }}>{p.verified ? 'Confirm it is you' : 'Enter your code'}</h2>
          <p className="small" style={{ margin: 0 }}>
            {p.verified ? 'This device is verified. Granting or revoking staff roles needs a code entered in the last few minutes.' : 'Open your authenticator app and enter the current BuildWise code.'}
            {' '}{p.recoveryCodesLeft} recovery code{p.recoveryCodesLeft === 1 ? '' : 's'} left.
          </p>
          {codeForm}
          {p.verified && <p className="small" style={{ margin: 0 }}><a href={p.next}>Continue without a new code</a></p>}
        </section>
      )}

      <div role="alert" aria-live="assertive">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
    </div>
  );
}
