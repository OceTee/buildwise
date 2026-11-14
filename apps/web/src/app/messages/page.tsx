import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ago } from '@/lib/format';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Messages', robots: { index: false } };

export default async function Messages() {
  if (!(await getMe())) redirect('/sign-in?next=/messages');
  const r = await api<{ unread: number; items: any[] }>('/v1/threads');
  const items = r.data.items ?? [];
  return (
    <div className="stack" style={{ maxWidth: '50rem' }}>
      <h1>Messages</h1>
      {items.length === 0 ? <p className="muted">No conversations yet. When you contact a seller, or a buyer contacts you, it shows here.</p> : (
        <ul className="plain card" style={{ padding: 0 }}>
          {items.map((t) => (
            <li key={t.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <Link href={`/messages/${t.id}`} style={{ display: 'block', padding: '.8rem 1rem', textDecoration: 'none', color: 'var(--text)' }}>
                <div className="inline" style={{ justifyContent: 'space-between' }}>
                  <strong>{t.counterpart}{t.unread > 0 && <span className="count" aria-label={`${t.unread} unread`}>{t.unread}</span>}</strong>
                  <span className="small muted">{ago(t.lastMessageAt)}</span>
                </div>
                <div className="small muted">{t.role === 'seller' ? 'Buyer asking about' : 'About'} {t.listingTitle}{!t.listingAvailable && ' (no longer available)'}</div>
                <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.lastMessage}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
