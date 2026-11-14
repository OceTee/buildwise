import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { DocumentWorkspace, type DocumentDetail } from '@/components/takeoff/DocumentWorkspace';
import { loadProject, loadProjectConfig } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Document', robots: { index: false } };

export default async function DocumentPage({ params, searchParams }: { params: Promise<{ id: string; docId: string }>; searchParams: Promise<{ rev?: string; page?: string }> }) {
  const { id, docId } = await params;
  const sp = await searchParams;
  const p = await loadProject(id);
  if (!p) notFound();
  const [r, cfg] = await Promise.all([api<DocumentDetail>(`/v1/documents/${docId}`), loadProjectConfig()]);
  if (r.status !== 200 || r.data.projectId !== id) notFound();
  const d = r.data;
  return (
    <div className="stack">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{d.number ? `${d.number} · ` : ''}{d.title}</h1>
        <Link className="btn btn-small" href={`/projects/${id}/documents`}>All documents</Link>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        {cfg.documentTypes.find((t) => t.code === d.type)?.label ?? d.type} · {cfg.disciplines.find((t) => t.code === d.discipline)?.label ?? d.discipline}
        {d.restricted ? ' · Restricted to owners and managers' : ''}
      </p>
      <DocumentWorkspace
        projectId={id}
        initial={d}
        config={{ maxUploadBytes: cfg.maxUploadBytes, maxPdfPages: cfg.maxPdfPages, documentStatuses: cfg.documentStatuses, disciplines: cfg.disciplines }}
        canConfirm={p.allowed.includes('estimate.review') && !p.viaStaffSession}
        canRaiseRfi={p.allowed.includes('rfi.create') && !p.viaStaffSession}
        initialRevisionId={sp.rev}
        initialPage={sp.page ? Number(sp.page) : undefined}
      />
    </div>
  );
}
