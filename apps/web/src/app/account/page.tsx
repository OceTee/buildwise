import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ago, dateText } from '@/lib/format';
import { api, getMarket, getMe } from '@/lib/server';
import { BusinessForm, DeleteAccount, MarkRead, ProfileForm, ReviewPrompt, SessionRevoke } from './AccountForms';

export const metadata: Metadata = { title: 'Account', robots: { index: false } };

export default async function Account() {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=/account');
  const [notes, sessions, prompts, market] = await Promise.all([
    api<{ unread: number; items: any[] }>('/v1/notifications'), api<{ items: any[] }>('/v1/me/sessions'), api<{ items: any[] }>('/v1/me/review-prompts'), getMarket(),
  ]);
  return (
    <div className="stack" style={{ maxWidth: '50rem' }}>
      <h1>Account</h1>

      <section className="card stack-sm" aria-labelledby="n-h">
        <div className="inline" style={{ justifyContent: 'space-between' }}><h2 id="n-h" style={{ margin: 0 }}>Notifications</h2>{notes.data.unread > 0 && <MarkRead />}</div>
        {notes.data.items.length === 0 ? <p className="muted" style={{ margin: 0 }}>Nothing yet.</p> : (
          <ul className="plain stack-sm">
            {notes.data.items.slice(0, 20).map((n) => (
              <li key={n.id} style={{ fontWeight: n.read ? 400 : 600 }}>
                {n.link ? <Link href={n.link}>{n.title}</Link> : n.title} <span className="small muted">· {ago(n.createdAt)}</span>
                <div className="small" style={{ fontWeight: 400 }}>{n.body}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {prompts.data.items.length > 0 && (
        <section className="card stack-sm" aria-labelledby="rp-h">
          <h2 id="rp-h">Did you deal with these sellers?</h2>
          {prompts.data.items.map((p) => <ReviewPrompt key={p.revealId} p={p} />)}
        </section>
      )}

      <section className="card stack-sm" aria-labelledby="p-h">
        <h2 id="p-h">Profile</h2>
        <p className="small muted" style={{ margin: 0 }}>Signed in with {me.phoneMasked}</p>
        <ProfileForm displayName={me.displayName} email={me.email} />
      </section>

      <section className="card stack-sm" aria-labelledby="b-h">
        <h2 id="b-h">Businesses</h2>
        {me.organizations.filter((o) => o.kind === 'business').map((o) => <p key={o.id} style={{ margin: 0 }}><Link href={`/seller/${o.handle}`}>{o.name}</Link> <span className="small muted">({o.role})</span></p>)}
        <BusinessForm regions={market.regions} />
        <div><Link className="btn btn-small" href="/account/promotions">Promotions, credits and invoices</Link></div>
      </section>

      <section className="card stack-sm" aria-labelledby="s-h">
        <h2 id="s-h">Signed-in devices</h2>
        <ul className="plain stack-sm">
          {sessions.data.items.map((s) => (
            <li key={s.id} className="inline" style={{ justifyContent: 'space-between' }}>
              <span>{s.deviceLabel ?? 'Browser'}{s.current && <span className="pill" style={{ marginLeft: '.4rem' }}>This device</span>}<span className="small muted"> · signed in {dateText(s.createdAt)}</span></span>
              {!s.current && <SessionRevoke id={s.id} label={`${s.deviceLabel ?? 'browser'} signed in ${dateText(s.createdAt)}`} />}
            </li>
          ))}
        </ul>
        <SessionRevoke everywhere />
      </section>

      <section className="card stack-sm" aria-labelledby="d-h">
        <h2 id="d-h">Delete account</h2>
        <p className="small" style={{ margin: 0 }}>Your listings close and your profile is removed. People you chatted with keep the conversation, shown from “Deleted user”.</p>
        <DeleteAccount />
      </section>
    </div>
  );
}
