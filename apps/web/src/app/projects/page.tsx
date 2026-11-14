import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { InvitationResponse } from '@/components/projects/ProjectControls';
import { ROLE_LABELS } from '@/lib/projects';
import { dateText } from '@/lib/format';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Projects', robots: { index: false } };

export default async function Projects() {
  if (!(await getMe())) redirect('/sign-in?next=/projects');
  const [list, invites] = await Promise.all([api<{ items: any[] }>('/v1/projects'), api<{ items: any[] }>('/v1/me/project-invitations')]);
  return (
    <div className="stack" style={{ maxWidth: '56rem' }}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>Projects</h1>
        <Link className="btn btn-primary" href="/projects/new">New project</Link>
      </div>
      {invites.data.items.length > 0 && (
        <section className="card stack-sm" aria-labelledby="inv-h">
          <h2 id="inv-h">Invitations</h2>
          {invites.data.items.map((i) => <InvitationResponse key={i.id} invitation={i} />)}
        </section>
      )}
      {list.data.items.length === 0 ? (
        <div className="card stack-sm">
          <p style={{ margin: 0 }}><strong>Plan a build with BuildWise.</strong> Describe your project, upload drawings, get an indicative range straight away, or ask a qualified reviewer to measure and price it.</p>
          <div><Link className="btn btn-primary" href="/projects/new">Start a project</Link></div>
        </div>
      ) : (
        <ul className="plain card" style={{ padding: 0 }}>
          {list.data.items.map((p) => (
            <li key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
              <Link href={`/projects/${p.id}`} style={{ display: 'block', padding: '.8rem 1rem', textDecoration: 'none', color: 'var(--text)' }}>
                <div className="inline" style={{ justifyContent: 'space-between' }}><strong>{p.name}</strong><span className="pill">{ROLE_LABELS[p.role] ?? p.role}</span></div>
                <div className="small muted">Updated {dateText(p.updatedAt)}{p.openRfis ? ` · ${p.openRfis} open RFI(s)` : ''}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
