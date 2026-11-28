import type { Metadata } from 'next';
import Link from 'next/link';
import { ago } from '@/lib/format';
import { api } from '@/lib/server';
import { FeedbackCommands } from '../ModControls';

export const metadata: Metadata = { title: 'Feedback' };

const STATUSES = [{ value: 'open', label: 'Open' }, { value: 'triaged', label: 'Triaged' }, { value: 'closed', label: 'Closed' }] as const;
const FLAG_LABELS: Record<string, string> = { contact_removed: 'Contact details removed', link: 'Contains a link', payment_instructions: 'Payment instructions', scam_signals: 'Scam phrases' };

export default async function FeedbackList({ searchParams }: { searchParams: Promise<{ status?: string; category?: string }> }) {
  const sp = await searchParams;
  const status = STATUSES.some((x) => x.value === sp.status) ? sp.status! : 'open';
  const qs = new URLSearchParams({ status, ...(sp.category ? { category: sp.category } : {}) });
  const r = await api<{ items: any[]; counts: Record<string, number>; categories: { value: string; label: string }[] }>(`/v1/moderation/feedback?${qs}`);
  const { items, counts, categories } = r.data;
  return (
    <>
      <h1>Feedback <span className="muted" style={{ fontWeight: 400 }}>({items.length})</span></h1>
      <p className="small muted">Feedback and bug reports from the public beta form. Phone numbers and emails in messages are removed when they are sent; a reply contact shows only when the sender agreed to be contacted. Status changes are in the audit log.</p>
      <nav aria-label="Feedback status" className="inline">
        {STATUSES.map((st) => (
          <Link key={st.value} className={`btn btn-small ${st.value === status ? 'btn-primary' : ''}`} aria-current={st.value === status ? 'page' : undefined} href={`/moderation/feedback?status=${st.value}${sp.category ? `&category=${sp.category}` : ''}`}>{st.label} ({counts[st.value] ?? 0})</Link>
        ))}
      </nav>
      <nav aria-label="Feedback category" className="inline small">
        <Link href={`/moderation/feedback?status=${status}`} aria-current={!sp.category ? 'page' : undefined}>All kinds</Link>
        {categories.map((c) => <Link key={c.value} href={`/moderation/feedback?status=${status}&category=${c.value}`} aria-current={sp.category === c.value ? 'page' : undefined}>{c.label}</Link>)}
      </nav>
      {items.length === 0 ? <p className="notice">Nothing here.</p> : (
        <ul className="plain stack">
          {items.map((x) => (
            <li key={x.id} className="card stack-sm">
              <div className="inline">
                <span className={`pill ${x.category === 'bug' ? 'pill-bad' : ''}`}>{x.categoryLabel}</span>
                <span className="small muted">{x.signedIn ? `from ${x.sender ?? 'a deleted user'}` : 'signed out'} · {ago(x.createdAt)}{x.pagePath && <> · page <code>{x.pagePath}</code></>}</span>
                {x.flags.map((f: string) => <span key={f} className="pill pill-warn">{FLAG_LABELS[f] ?? f}</span>)}
              </div>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{x.message}</p>
              {x.contactOk ? <p className="small" style={{ margin: 0 }}>May be contacted{x.contact ? <>: <span className="mono">{x.contact}</span></> : ' (no contact given)'}</p> : <p className="small muted" style={{ margin: 0 }}>Did not ask for a reply.</p>}
              {x.staffNote && <p className="small" style={{ margin: 0 }}><strong>Staff note:</strong> {x.staffNote}{x.updatedBy && <span className="muted"> ({x.updatedBy}, {ago(x.updatedAt)})</span>}</p>}
              <FeedbackCommands id={x.id} commands={x.commands} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
