'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ApiFailure, call, errorText } from '@/lib/client';

const CATEGORIES = [
  { value: 'bug', label: 'Something is not working' },
  { value: 'idea', label: 'An idea or suggestion' },
  { value: 'other', label: 'Something else' },
] as const;

/** Public-beta feedback: a category, what happened, the page it was about, and an optional reply address with consent. */
export function FeedbackForm({ signedIn, from }: { signedIn: boolean; from: string | null }) {
  const [category, setCategory] = useState<(typeof CATEGORIES)[number]['value']>('bug');
  const [contactOk, setContactOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [sent, setSent] = useState<{ contactRemoved: boolean } | null>(null);

  if (sent) {
    return (
      <div className="notice notice-good stack-sm" role="status">
        <p style={{ margin: 0 }}><strong>Thank you. We have your feedback.</strong></p>
        {sent.contactRemoved && <p className="small" style={{ margin: 0 }}>We removed a phone number or email address from your message to keep it private.</p>}
        <p className="small" style={{ margin: 0 }}>{from ? <Link href={from}>Back to where you were</Link> : <Link href="/">Back to BuildWise</Link>}</p>
      </div>
    );
  }

  return (
    <form className="stack" noValidate onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const message = String(f.get('message') ?? '').trim();
      const contact = String(f.get('contact') ?? '').trim();
      const local: Record<string, string> = {};
      if (message.length < 10) local.message = 'Tell us a little more (at least 10 characters).';
      if (contact && !contactOk) local.contactOk = 'Tick "you may contact me" if you want a reply at this address.';
      setErrors(local); setProblem(null);
      if (Object.keys(local).length) return;
      setBusy(true);
      void call<{ contactRemoved: boolean }>('/v1/feedback', { body: { category, message, pageUrl: from ?? undefined, contactOk, contact: contact || undefined } })
        .then((r) => setSent({ contactRemoved: r.contactRemoved }))
        .catch((err) => {
          if (err instanceof ApiFailure && err.fieldErrors.length) setErrors(Object.fromEntries(err.fieldErrors.map((x) => [x.path, x.message])));
          else setProblem(errorText(err));
        })
        .finally(() => setBusy(false));
    }}>
      <fieldset style={{ margin: 0 }}>
        <legend>What is it about?</legend>
        <div className="stack-sm">
          {CATEGORIES.map((c) => (
            <label key={c.value} className="check"><input type="radio" name="category" value={c.value} checked={category === c.value} onChange={() => setCategory(c.value)} /> {c.label}</label>
          ))}
        </div>
      </fieldset>
      <div>
        <label htmlFor="fb-message">{category === 'bug' ? 'What were you doing, and what went wrong?' : 'Tell us more'}</label>
        <textarea id="fb-message" name="message" rows={6} maxLength={2000} required aria-invalid={!!errors.message} aria-describedby={`fb-message-hint${errors.message ? ' fb-message-err' : ''}`} />
        <span id="fb-message-hint" className="hint">Please do not include passwords, sign-in codes or other people's details.</span>
        {errors.message && <p id="fb-message-err" className="field-error">{errors.message}</p>}
      </div>
      {from && <p className="small muted" style={{ margin: 0 }}>We will note that this is about the page <code>{from.split('?')[0]}</code>.</p>}
      <div className="stack-sm">
        <label className="check"><input type="checkbox" name="contactOk" checked={contactOk} onChange={(e) => setContactOk(e.target.checked)} aria-invalid={!!errors.contactOk} aria-describedby={errors.contactOk ? 'fb-ok-err' : undefined} /> You may contact me about this feedback</label>
        {errors.contactOk && <p id="fb-ok-err" className="field-error">{errors.contactOk}</p>}
        {contactOk && signedIn && <p className="small muted" style={{ margin: 0 }}>We will reply to the mobile number on your account, unless you give another contact below.</p>}
      </div>
      {(contactOk || !signedIn) && (
        <div>
          <label htmlFor="fb-contact">Email or phone for a reply <span className="hint">Optional. Used only to answer this feedback.</span></label>
          <input id="fb-contact" name="contact" maxLength={120} autoComplete="email" aria-invalid={!!errors.contact} aria-describedby={errors.contact ? 'fb-contact-err' : undefined} />
          {errors.contact && <p id="fb-contact-err" className="field-error">{errors.contact}</p>}
        </div>
      )}
      <div role="alert">{problem && <p className="notice notice-bad small" style={{ margin: 0 }}>{problem}</p>}</div>
      <div><button className="btn btn-primary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Send feedback'}</button></div>
      <p className="small muted" style={{ margin: 0 }}>How we handle feedback: <Link href="/privacy">privacy notice</Link>.</p>
    </form>
  );
}
