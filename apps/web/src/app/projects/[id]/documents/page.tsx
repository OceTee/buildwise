import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { NewDocumentForm } from '@/components/projects/ProjectControls';
import { stateLabel } from '@/lib/documents';
import { loadProject, loadProjectConfig } from '@/lib/projects';
import { dateText } from '@/lib/format';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Documents' };

/** The drawing and document register, grouped by discipline (§10.2). */
export default async function Documents({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p) notFound();
  const [r, cfg] = await Promise.all([api<{ items: any[]; canUpload: boolean }>(`/v1/projects/${id}/documents`), loadProjectConfig()]);
  if (r.status !== 200) notFound();
  const disc = (c: string) => cfg.disciplines.find((d) => d.code === c)?.label ?? c;
  const type = (c: string) => cfg.documentTypes.find((d) => d.code === c)?.label ?? c;
  const status = (c: string | null) => (c ? cfg.documentStatuses.find((d) => d.code === c)?.label ?? c : null);
  const groups = [...new Set(r.data.items.map((d) => d.discipline))];
  return (
    <div className="stack">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '1.3rem', margin: 0 }}>Documents</h1>
      </div>
      {r.data.canUpload && <NewDocumentForm projectId={id} docTypes={cfg.documentTypes} disciplines={cfg.disciplines} maxBytes={cfg.maxUploadBytes} maxPages={cfg.maxPdfPages} canRestrict={['owner', 'manager'].includes(p.role)} />}
      {r.data.items.length === 0 ? <p className="muted">No documents yet. Upload drawings to get a reviewed estimate.</p> : groups.map((g) => (
        <section key={g} aria-labelledby={`g-${g}`} className="stack-sm">
          <h2 id={`g-${g}`} style={{ fontSize: '1.05rem' }}>{disc(g)}</h2>
          <div className="table-wrap card" style={{ padding: 0 }}>
            <table>
              <caption className="sr-only">{disc(g)} documents</caption>
              <thead><tr><th scope="col">Number</th><th scope="col">Title</th><th scope="col">Type</th><th scope="col">Revision</th><th scope="col">Status label</th><th scope="col">File</th></tr></thead>
              <tbody>
                {r.data.items.filter((d) => d.discipline === g).map((d) => (
                  <tr key={d.id}>
                    <td>{d.number ?? '—'}</td>
                    <td><Link href={`/projects/${id}/documents/${d.id}`}>{d.title}</Link>{d.restricted && <span className="pill pill-warn" style={{ marginLeft: '.4rem' }}>Restricted</span>}</td>
                    <td className="small">{type(d.type)}</td>
                    <td>{d.current?.revision ?? '—'}{d.revisionCount > 1 && <span className="small muted"> ({d.revisionCount})</span>}</td>
                    <td className="small">{status(d.current?.status) ?? <span className="muted">Not set</span>}</td>
                    <td className="small">
                      {d.current ? <span className={`pill ${d.current.state === 'available' ? 'pill-good' : ['rejected', 'failed'].includes(d.current.state) ? 'pill-bad' : 'pill-warn'}`}>{stateLabel(d.current.state)}</span> : '—'}
                      {d.current?.pages ? <span className="muted"> · {d.current.pages} p</span> : null}
                      {d.current?.at && <div className="muted">{dateText(d.current.at)}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}
