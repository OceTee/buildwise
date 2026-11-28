import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { staffCan, STAFF_ROLE_LABELS, type StaffRole } from '@bw/domain';
import { ago, dateText } from '@/lib/format';
import { api, getMe } from '@/lib/server';
import { DecideStaffChange, GrantStaffRole, ResetStaffMfa, RevokeStaffRole } from './StaffControls';

export const metadata: Metadata = { title: 'Staff roles' };

interface Person { id: string; name: string; phoneMasked: string | null }
interface Change { id: string; action: 'grant' | 'revoke'; role: StaffRole | null; previousRole: StaffRole | null; reason: string; status: string; via: string; target: Person; requestedBy: Person | null; decidedBy: Person | null; decisionNote: string | null; createdAt: string; decidedAt: string | null; mine: boolean }
interface StaffData {
  roles: { role: StaffRole; label: string; needsSecondApprover: boolean }[];
  staff: (Person & { role: StaffRole; mfaEnrolled: boolean; lastSeenAt: string | null })[];
  pending: Change[]; history: Change[];
}

const label = (r: StaffRole | null) => (r ? STAFF_ROLE_LABELS[r] ?? r : 'none');

/** Operations admins grant and revoke staff roles, with a reason; an ops_admin grant needs a second admin (§7.6). */
export default async function StaffRoles() {
  const me = await getMe();
  if (!me || !staffCan(me.staffRole, 'admin')) notFound();
  const d = (await api<StaffData>('/v1/moderation/staff')).data;
  return (
    <>
      <h1>Staff roles</h1>
      <p className="small muted" style={{ margin: 0 }}>
        Every change needs a reason and is written to the audit log. Granting <strong>Operations admin</strong> waits until a second operations admin approves it.
        Grants and revokes need a code from your authenticator entered in the last few minutes.
      </p>

      <section className="card stack-sm" aria-labelledby="pending-h">
        <h2 id="pending-h" style={{ margin: 0 }}>Waiting for approval</h2>
        {d.pending.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Nothing waiting.</p> : (
          <ul className="plain stack-sm">
            {d.pending.map((c) => (
              <li key={c.id} className="stack-sm" style={{ borderTop: '1px solid var(--border)', paddingTop: '.5rem' }}>
                <div><strong>{label(c.role)}</strong> for {c.target.name} <span className="small muted">({c.target.phoneMasked ?? 'no number'})</span></div>
                <div className="small">Asked by {c.requestedBy?.name ?? 'command line'} {ago(c.createdAt)}: “{c.reason}”</div>
                <DecideStaffChange id={c.id} mine={c.mine} summary={`${label(c.role)} for ${c.target.name}`} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card stack-sm" aria-labelledby="grant-h">
        <h2 id="grant-h" style={{ margin: 0 }}>Grant a role</h2>
        <p className="small muted" style={{ margin: 0 }}>The person must already have a BuildWise account. They set up two-step verification the first time they open the staff tools.</p>
        <GrantStaffRole roles={d.roles} />
      </section>

      <section className="card stack-sm" aria-labelledby="staff-h" style={{ padding: 0 }}>
        <h2 id="staff-h" style={{ margin: 0, padding: '1rem 1rem 0' }}>Staff</h2>
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Current staff</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Two-step</th><th scope="col">Last seen</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {d.staff.map((u) => (
                <tr key={u.id}>
                  <td>{u.name}<div className="small muted">{u.phoneMasked}</div></td>
                  <td>{label(u.role)}</td>
                  <td>{u.mfaEnrolled ? 'Set up' : 'Not yet'}</td>
                  <td className="small">{u.lastSeenAt ? ago(u.lastSeenAt) : '—'}</td>
                  <td>{u.id === me.id ? <span className="small muted">You</span> : (
                    <div className="stack-sm">
                      <RevokeStaffRole userId={u.id} name={u.name} />
                      {u.mfaEnrolled && <ResetStaffMfa userId={u.id} name={u.name} />}
                    </div>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card stack-sm" aria-labelledby="hist-h">
        <h2 id="hist-h" style={{ margin: 0 }}>Recent changes</h2>
        {d.history.length === 0 ? <p className="muted small" style={{ margin: 0 }}>No changes yet.</p> : (
          <ul className="plain stack-sm small">
            {d.history.map((c) => (
              <li key={c.id}>
                <strong>{c.action === 'grant' ? `Grant ${label(c.role)}` : `Revoke ${label(c.previousRole)}`}</strong> · {c.target.name} · {c.status}
                {' '}· {c.via === 'cli' ? 'command line' : c.requestedBy?.name}{c.decidedBy && c.decidedBy.id !== c.requestedBy?.id ? `, approved by ${c.decidedBy.name}` : ''}
                {' '}· {dateText(c.decidedAt ?? c.createdAt)}
                <div className="muted">“{c.reason}”{c.decisionNote ? ` Note: ${c.decisionNote}` : ''}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
