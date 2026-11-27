import type { Metadata } from 'next';
import Link from 'next/link';
import { CASE_PILL } from '@/components/procurement/Trust';
import { ago } from '@/lib/format';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Cases' };

const VIEWS = [['open', 'Open'], ['appeals', 'Appeals'], ['closed', 'Decided and final']] as const;

/** Supplier cases (R3 slice 3): safety first, then overdue responses, then the soonest due. */
export default async function Cases({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const view = (await searchParams).view ?? 'open';
  const r = await api<any>(`/v1/moderation/cases?view=${VIEWS.some(([v]) => v === view) ? view : 'open'}`);
  const items: any[] = r.data.items ?? [];
  return (
    <>
      <h1>Cases <span className="muted" style={{ fontWeight: 400 }}>({items.length})</span></h1>
      <nav aria-label="Case views" className="inline">
        {VIEWS.map(([v, label]) => <Link key={v} className={`btn btn-small ${v === r.data.view ? 'btn-primary' : ''}`} aria-current={v === r.data.view ? 'page' : undefined} href={`/moderation/cases?view=${v}`}>{label}</Link>)}
      </nav>
      <p className="small muted">Safety (S1) cases skip triage and page the on-call safety owner. Targets: S1 1 hour (24/7), S2 4 business hours, S3 1 business day, S4 3 business days.</p>
      {items.length === 0 ? <p className="notice">No cases here.</p> : (
        <ul className="plain stack">
          {items.map((c) => (
            <li key={c.id} className="card stack-sm">
              <div className="inline">
                <Link href={`/moderation/cases/${c.id}`}><strong>{c.reference}</strong></Link>
                <span className={`pill ${c.severity === 'S1' ? 'pill-bad' : ''}`}>{c.severityLabel}</span>
                <span className={`pill ${CASE_PILL[c.state] ?? ''}`}>{c.stateLabel}</span>
                {c.responseOverdue && <span className="pill pill-bad">Response overdue</span>}
                <span className="small muted">{c.typeLabel} · {c.order.reference} · {c.provider} · {c.project} · opened {ago(c.openedAt)}</span>
              </div>
              <p className="small" style={{ margin: 0 }}>{c.summary}</p>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
