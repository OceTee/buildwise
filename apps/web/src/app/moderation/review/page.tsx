import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AssignReviewer } from '@/components/estimates/StaffControls';
import { STATE_LABELS } from '@/components/estimates/types';
import { ago } from '@/lib/format';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Estimate reviews' };

interface Queue {
  needSecondReviewer: { versionId: string; estimateId: string; title: string; number: number; state: string; projectId: string; projectName: string; primaryReviewer: string | null; updatedAt: string }[];
  waiting: { versionId: string; estimateId: string; title: string; number: number; projectId: string; projectName: string; buildingUse: string | null; areaCode: string | null; documents: number; waitingSince: string }[];
  mine: { versionId: string; estimateId: string; title: string; number: number; state: string; projectId: string; projectName: string; kind: 'primary' | 'second'; updatedAt: string }[];
  qualifications: { classCode: string; credential: string; validUntil: string | null }[];
}

export default async function ReviewQueue() {
  const me = await getMe();
  if (!me || !['qs_reviewer', 'ops_admin'].includes(me.staffRole ?? '')) notFound();
  const [q, reviewers] = await Promise.all([api<Queue>('/v1/review/queue'), api<{ items: { id: string; name: string; activeAssignments: number }[] }>('/v1/review/reviewers')]);
  if (q.status !== 200) notFound();
  const mine = q.data.mine;
  const staff = reviewers.data.items ?? [];
  return (
    <>
      <h1>Estimate reviews</h1>
      {me.staffRole === 'qs_reviewer' && (
        <p className="small muted">
          Your qualifications: {q.data.qualifications.length ? q.data.qualifications.map((x) => `${x.classCode.replace(/_/g, ' ')} (${x.credential}${x.validUntil ? `, to ${x.validUntil}` : ''})`).join('; ') : 'none recorded. You cannot complete or issue a review until an operations admin records one.'}
        </p>
      )}

      <section aria-labelledby="mine-h" className="stack-sm">
        <h2 id="mine-h">Assigned to you ({mine.length})</h2>
        {mine.length === 0 ? <p className="muted">Nothing assigned to you.</p> : (
          <ul className="plain stack-sm">
            {mine.map((m) => (
              <li key={`${m.versionId}-${m.kind}`} className="card inline" style={{ justifyContent: 'space-between' }}>
                <div>
                  {m.estimateId ? <Link href={`/projects/${m.projectId}/estimates/${m.estimateId}`}>{m.title}, version {m.number}</Link> : <span>{m.title}, version {m.number}</span>}
                  <div className="small muted">{m.projectName} · {m.kind === 'primary' ? 'Primary review' : 'Second review'} · updated {ago(m.updatedAt)}</div>
                </div>
                <span className="pill">{STATE_LABELS[m.state] ?? m.state}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="wait-h" className="stack-sm">
        <h2 id="wait-h">Waiting for a reviewer ({q.data.waiting.length})</h2>
        <p className="small muted">Oldest first. Reviewers see a project only after assignment; the assignment adds them as a reviewer on that project.</p>
        {q.data.waiting.length === 0 ? <p className="notice">No estimates are waiting.</p> : (
          <ul className="plain stack">
            {q.data.waiting.map((w) => (
              <li key={w.versionId} className="card stack-sm">
                <div><strong>{w.title}</strong>, version {w.number} <span className="small muted">· {w.projectName} · {w.buildingUse ?? 'use not set'} · {w.areaCode ?? 'area not set'} · {w.documents} document(s) · waiting {ago(w.waitingSince)}</span></div>
                <AssignReviewer versionId={w.versionId} kind="primary" reviewers={staff} selfId={me.staffRole === 'qs_reviewer' ? me.id : null} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sec-h" className="stack-sm">
        <h2 id="sec-h">Needs a second reviewer ({q.data.needSecondReviewer.length})</h2>
        <p className="small muted">Estimates above the value threshold cannot be issued until a different reviewer checks them.</p>
        {q.data.needSecondReviewer.length === 0 ? <p className="muted">None.</p> : (
          <ul className="plain stack">
            {q.data.needSecondReviewer.map((w) => (
              <li key={w.versionId} className="card stack-sm">
                <div><strong>{w.title}</strong>, version {w.number} <span className="small muted">· {w.projectName} · {STATE_LABELS[w.state] ?? w.state} · primary reviewer {w.primaryReviewer ?? 'unassigned'}</span></div>
                <AssignReviewer versionId={w.versionId} kind="second" reviewers={staff.filter((r) => r.name !== w.primaryReviewer)} selfId={null} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
