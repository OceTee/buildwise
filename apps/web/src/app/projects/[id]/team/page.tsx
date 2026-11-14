import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { InviteForm, MemberControls, RevokeInvitation } from '@/components/projects/ProjectControls';
import { canDo, loadProject, ROLE_LABELS } from '@/lib/projects';
import { dateText } from '@/lib/format';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Team' };

const ROLE_HELP: Record<string, string> = {
  owner: 'Controls the project, its team and accepts estimates.',
  manager: 'Manages documents, RFIs, estimates and payment records.',
  collaborator: 'Uploads documents, raises RFIs and edits own-quantity estimates.',
  viewer: 'Reads the project.',
  reviewer: 'BuildWise reviewer assigned to an estimate. Sees documents and the estimate only.',
};

export default async function Team({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p || !canDo(p, 'members.read')) notFound();
  const r = await api<{ members: any[]; invitations: any[]; grantable: string[] }>(`/v1/projects/${id}/members`);
  const manage = canDo(p, 'members.manage') && !p.viaStaffSession;
  return (
    <div className="layout-2">
      <section aria-labelledby="team-h" className="stack-sm">
        <h1 id="team-h" style={{ fontSize: '1.3rem' }}>Team</h1>
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <caption className="sr-only">Project members</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Since</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {r.data.members.map((m) => (
                <tr key={m.userId}>
                  <td>{m.name}{m.you && <span className="small muted"> (you)</span>}</td>
                  <td>{ROLE_LABELS[m.role] ?? m.role}</td>
                  <td className="small">{dateText(m.since)}</td>
                  <td>{(manage || m.you) && <MemberControls projectId={id} userId={m.userId} role={m.role} roles={r.data.grantable} self={m.you} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {r.data.invitations.length > 0 && (
          <div className="card stack-sm">
            <h2 style={{ fontSize: '1rem', margin: 0 }}>Waiting to accept</h2>
            {r.data.invitations.map((i) => <div key={i.id} className="inline" style={{ justifyContent: 'space-between' }}><span>{i.phoneMasked} as {i.role} <span className="small muted">until {dateText(i.expiresAt)}</span></span>{manage && <RevokeInvitation projectId={id} inviteId={i.id} />}</div>)}
          </div>
        )}
      </section>
      <aside className="stack">
        {manage && r.data.grantable.length > 0 && <section className="card"><h2 style={{ fontSize: '1rem' }}>Invite someone</h2><InviteForm projectId={id} roles={r.data.grantable} /></section>}
        <section className="card"><h2 style={{ fontSize: '1rem' }}>What each role can do</h2><dl className="facts small">{Object.entries(ROLE_HELP).map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{ROLE_LABELS[k]}</dt><dd>{v}</dd></div>)}</dl></section>
      </aside>
    </div>
  );
}
