import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BriefForm } from '@/components/projects/BriefForm';
import { loadProjectConfig } from '@/lib/projects';
import { getMarket, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'New project', robots: { index: false } };

export default async function NewProject() {
  if (!(await getMe())) redirect('/sign-in?next=/projects/new');
  const [cfg, market] = await Promise.all([loadProjectConfig(), getMarket()]);
  return (
    <div className="stack" style={{ maxWidth: '48rem' }}>
      <h1>New project</h1>
      <p className="muted">Tell us what you can. Answers you leave blank show up as a checklist on the project page.</p>
      <BriefForm cfg={cfg} regions={market.regions} />
    </div>
  );
}
