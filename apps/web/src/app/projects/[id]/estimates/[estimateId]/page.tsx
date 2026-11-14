import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { Estimate } from '@/components/estimates/types';
import { Worksheet } from '@/components/estimates/Worksheet';
import { loadProject, loadProjectConfig } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Estimate' };

export default async function EstimatePage({ params }: { params: Promise<{ id: string; estimateId: string }> }) {
  const { id, estimateId } = await params;
  const p = await loadProject(id);
  if (!p) notFound();
  const r = await api<Estimate>(`/v1/estimates/${estimateId}`);
  if (r.status !== 200 || r.data.projectId !== id) notFound();
  const cfg = await loadProjectConfig();
  return (
    <Worksheet
      initial={r.data} projectId={id} regionCode={(p.brief.regionCode as string | undefined) ?? null}
      workSections={cfg.workSections} readOnly={p.viaStaffSession}
    />
  );
}
