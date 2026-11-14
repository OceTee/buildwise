import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BriefForm } from '@/components/projects/BriefForm';
import { canDo, loadProject, loadProjectConfig } from '@/lib/projects';
import { getMarket } from '@/lib/server';

export const metadata: Metadata = { title: 'Project details' };

export default async function EditBrief({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p || !canDo(p, 'project.edit')) notFound();
  const [cfg, market] = await Promise.all([loadProjectConfig(), getMarket()]);
  return (
    <div style={{ maxWidth: '48rem' }} className="stack">
      <h1>Project details</h1>
      <BriefForm cfg={cfg} regions={market.regions} projectId={id} version={p.version} initial={{ ...p.brief, name: p.name }} />
    </div>
  );
}
