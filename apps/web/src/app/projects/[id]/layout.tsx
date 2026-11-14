import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ProjectTabs } from '@/components/ProjectTabs';
import { loadProject, ROLE_LABELS } from '@/lib/projects';
import { getMe } from '@/lib/server';

export const metadata = { robots: { index: false } };

export default async function ProjectLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getMe())) redirect(`/sign-in?next=/projects/${id}`);
  const p = await loadProject(id);
  if (!p) notFound();
  const tabs = [
    { href: `/projects/${id}`, label: 'Overview', show: true },
    { href: `/projects/${id}/documents`, label: 'Documents', show: p.allowed.includes('documents.read') },
    { href: `/projects/${id}/rfis`, label: `RFIs${p.counts.open_rfis ? ` (${p.counts.open_rfis})` : ''}`, show: p.allowed.includes('rfi.read') },
    { href: `/projects/${id}/estimates`, label: 'Estimates', show: p.allowed.includes('estimate.read') },
    { href: `/projects/${id}/payments`, label: 'Payments', show: p.allowed.includes('payments.read') },
    { href: `/projects/${id}/team`, label: 'Team', show: p.allowed.includes('members.read') },
  ].filter((t) => t.show);
  return (
    <div className="stack">
      <div>
        <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href="/projects">Projects</Link></li><li aria-current="page">{p.name}</li></ol></nav>
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <div className="inline"><span className="h1-like" style={{ fontSize: '1.4rem', fontWeight: 800 }}>{p.name}</span><span className="pill">{ROLE_LABELS[p.role] ?? p.role}</span>{p.viaStaffSession && <span className="pill pill-warn">Staff access (read-only, audited)</span>}</div>
          {p.area && <span className="small muted">{p.area.label}, {p.area.region}</span>}
        </div>
      </div>
      <ProjectTabs tabs={tabs.map(({ href, label }) => ({ href, label }))} />
      <div>{children}</div>
    </div>
  );
}
