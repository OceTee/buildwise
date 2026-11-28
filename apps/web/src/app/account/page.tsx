import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ago, dateText } from '@/lib/format';
import { api, getMarket, getMe } from '@/lib/server';
import { BusinessDetails, BusinessForm, DeleteAccount, DownloadData, MarkRead, NotificationPrefs, PhoneForm, ProfileForm, ReviewPrompt, SessionRevoke } from './AccountForms';

interface Named { id: string; name: string }
interface Deletion { effects: string[]; retained: string[]; holdDays: number; closesBusinesses: Named[]; leavesBusinesses: Named[]; archivesProjects: Named[]; leavesProjects: Named[] }

export const metadata: Metadata = { title: 'Account', robots: { index: false } };

export default async function Account() {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=/account');
  const [notes, sessions, prompts, market, prefs, deletion] = await Promise.all([
    api<{ unread: number; items: any[] }>('/v1/notifications'), api<{ items: any[] }>('/v1/me/sessions'), api<{ items: any[] }>('/v1/me/review-prompts'), getMarket(),
    api<{ topics: any[]; hasEmail: boolean; hasPhone: boolean }>('/v1/me/notification-preferences'),
    api<Deletion>('/v1/me/deletion'),
  ]);
  const del = deletion.data;
  const names = (xs: Named[]) => xs.map((x) => x.name).join(', ');
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

      {prefs.data?.topics && (
        <section className="card stack-sm" aria-labelledby="np-h">
          <h2 id="np-h" style={{ margin: 0 }}>Email and SMS copies</h2>
          <p className="small muted" style={{ margin: 0 }}>You always see notifications here. Choose what is also sent to you.</p>
          <NotificationPrefs topics={prefs.data.topics} hasEmail={prefs.data.hasEmail} hasPhone={prefs.data.hasPhone} />
        </section>
      )}

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
        <PhoneForm callingCode={market.defaultCallingCode} />
      </section>

      <section className="card stack-sm" aria-labelledby="b-h">
        <h2 id="b-h">Businesses</h2>
        {me.organizations.filter((o) => o.kind === 'business').map((o) => (
          <div key={o.id} className="stack-sm">
            <p style={{ margin: 0 }}><Link href={`/seller/${o.handle}`}>{o.name}</Link> <span className="small muted">({o.role}{o.closed ? ', closed' : ''})</span></p>
            {!o.closed && (o.role === 'owner' || o.role === 'admin') && <BusinessDetails org={o} regions={market.regions} />}
          </div>
        ))}
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

      <section className="card stack-sm" aria-labelledby="x-h">
        <h2 id="x-h">Your data</h2>
        <p className="small" style={{ margin: 0 }}>
          Download a copy of everything BuildWise holds about your account: profile, businesses, listings, chats, quote requests, reviews,
          saved searches, favourites, projects you own and notifications, as one JSON file. Project drawings are downloaded from each project.
        </p>
        <DownloadData />
      </section>

      <section className="card stack-sm" aria-labelledby="d-h">
        <h2 id="d-h">Delete account</h2>
        <p className="small" style={{ margin: 0 }}>Download your data first if you want a copy. Deleting your account:</p>
        <ul className="small" style={{ margin: 0 }}>{del.effects.map((e) => <li key={e}>{e}</li>)}</ul>
        {(del.closesBusinesses.length > 0 || del.leavesBusinesses.length > 0 || del.archivesProjects.length > 0 || del.leavesProjects.length > 0) && (
          <div className="notice notice-warn small stack-sm">
            {del.closesBusinesses.length > 0 && <div>Closes: {names(del.closesBusinesses)} (you are the only owner).</div>}
            {del.leavesBusinesses.length > 0 && <div>You leave: {names(del.leavesBusinesses)}.</div>}
            {del.archivesProjects.length > 0 && <div>Archives: {names(del.archivesProjects)}.</div>}
            {del.leavesProjects.length > 0 && <div>You leave the projects: {names(del.leavesProjects)}.</div>}
          </div>
        )}
        <p className="small" style={{ margin: 0 }}>We keep your details for {del.holdDays} days in case of fraud or a dispute, then erase them. These records are kept because the law or our audit duties require it:</p>
        <ul className="small" style={{ margin: 0 }}>{del.retained.map((e) => <li key={e}>{e}</li>)}</ul>
        <DeleteAccount />
      </section>
    </div>
  );
}
