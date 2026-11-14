'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { call, errorText, uploadFile } from '@/lib/client';
import { TakeoffViewer } from './TakeoffViewer';

export interface Revision {
  id: string; revision: string; issuedDate: string | null; status: { code: string; setBy: string | null; basis: string | null } | null;
  fileName: string; type: string | null; typeLabel: string | null; preview: 'pdf' | 'image' | 'none'; bytes: number | null; pages: number | null;
  pageSizes: { w: number; h: number }[] | null; sha256: string | null; state: string; stateDetail: string | null; superseded: boolean;
  supersedesRevisionId: string | null; uploadedBy: string | null; createdAt: string; availableAt: string | null;
}
export interface DocumentDetail {
  id: string; projectId: string; title: string; number: string | null; type: string; discipline: string; restricted: boolean; currentRevisionId: string | null;
  revisions: Revision[]; affectedMeasurements: number; can: { upload: boolean; setStatus: boolean; measure: boolean };
}
interface Config { maxUploadBytes: number; maxPdfPages: number; documentStatuses: { code: string; label: string }[]; disciplines: { code: string; label: string }[] }

const PENDING = ['awaiting_upload', 'quarantined', 'scanning', 'processing'];
const STATE_LABEL: Record<string, string> = {
  awaiting_upload: 'Waiting for upload', quarantined: 'Uploaded, waiting for checks', scanning: 'Checking for malware', processing: 'Reading the file',
  available: 'Available', failed: 'Processing failed', rejected: 'Rejected',
};
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.csv,.xlsx,.docx,.dwg,.dxf,.ifc,application/pdf,image/jpeg,image/png,image/webp,text/csv';
const size = (b: number | null) => (b == null ? '—' : b > 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const date = (s: string | null) => (s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

export function DocumentWorkspace({ projectId, initial, config, canConfirm, canRaiseRfi, initialRevisionId, initialPage }: {
  projectId: string; initial: DocumentDetail; config: Config; canConfirm: boolean; canRaiseRfi: boolean; initialRevisionId?: string; initialPage?: number;
}) {
  const [doc, setDoc] = useState(initial);
  const firstViewable = initial.revisions.find((r) => r.id === initialRevisionId) ?? initial.revisions.find((r) => r.id === initial.currentRevisionId) ?? initial.revisions[0];
  const [selectedId, setSelectedId] = useState(firstViewable?.id ?? null);
  const selected = doc.revisions.find((r) => r.id === selectedId) ?? null;
  const current = doc.revisions.find((r) => r.id === doc.currentRevisionId) ?? null;
  const [page, setPage] = useState(initialPage ?? 1);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try { const d = await call<DocumentDetail>(`/v1/documents/${doc.id}`); setDoc(d); return d; } catch { return null; }
  }, [doc.id]);

  // Keep polling while any revision is still being processed.
  useEffect(() => {
    if (!doc.revisions.some((r) => PENDING.includes(r.state) && r.state !== 'awaiting_upload')) return;
    const t = setTimeout(() => { void refresh(); }, 1500);
    return () => clearTimeout(t);
  }, [doc, refresh]);

  async function download(r: Revision) {
    try { const l = await call<{ url: string }>(`/v1/revisions/${r.id}/file-link`, { body: { disposition: 'attachment' } }); window.location.href = `/api${l.url}`; }
    catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  }

  return (
    <div className="stack">
      {doc.affectedMeasurements > 0 && (
        <div className="notice notice-warn" role="status">
          <strong>⚠ {doc.affectedMeasurements} measurement(s) may be affected by a newer revision.</strong> They were taken on a superseded revision. Re-measure them on the current revision, or have a reviewer confirm them.
        </div>
      )}

      {selected && selected.superseded && current && (
        <div className="notice notice-warn" role="status">
          You are viewing revision {selected.revision}, which has been superseded by revision {current.revision}. It is read-only.{' '}
          <button type="button" className="linkish" onClick={() => { setSelectedId(current.id); setPage(1); }}>View the current revision</button>
        </div>
      )}

      {selected ? (
        selected.state === 'available' ? (
          <TakeoffViewer
            key={selected.id}
            projectId={projectId}
            revision={selected}
            page={page}
            onPage={setPage}
            disciplines={config.disciplines}
            canMeasure={doc.can.measure && !selected.superseded}
            canConfirm={canConfirm}
            canRaiseRfi={canRaiseRfi}
            onDownload={() => download(selected)}
          />
        ) : (
          <RevisionState r={selected} onRetry={async () => { try { await call(`/v1/revisions/${selected.id}/retry`, { body: {} }); setMsg({ ok: true, text: 'Processing restarted.' }); void refresh(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } }} canRetry={doc.can.upload} />
        )
      ) : <p className="notice">This document has no revisions yet.</p>}

      <div className="layout-2">
        <section className="card stack-sm" aria-labelledby="hist-h">
          <h2 id="hist-h">Revision history</h2>
          <div className="table-wrap">
            <table>
              <caption className="sr-only">Revisions, newest first</caption>
              <thead><tr><th scope="col">Revision</th><th scope="col">Status label</th><th scope="col">Date</th><th scope="col">File</th><th scope="col">State</th><th scope="col">Uploaded by</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {doc.revisions.map((r) => (
                  <tr key={r.id} aria-current={r.id === selectedId ? 'true' : undefined}>
                    <th scope="row">
                      {r.revision}
                      {r.id === doc.currentRevisionId && <> <span className="pill pill-good">Current</span></>}
                      {r.superseded && <> <span className="pill">Superseded</span></>}
                    </th>
                    <td className="small">
                      {r.status ? <><strong>{config.documentStatuses.find((x) => x.code === r.status!.code)?.label ?? r.status.code}</strong><div className="muted">Set by {r.status.setBy ?? 'unknown'}: {r.status.basis}</div></> : <span className="muted">Not set</span>}
                    </td>
                    <td className="small">{r.issuedDate ? date(r.issuedDate) : date(r.createdAt)}</td>
                    <td className="small">{r.fileName}<div className="muted">{r.typeLabel ?? '—'} · {size(r.bytes)}{r.pages ? ` · ${r.pages} page${r.pages === 1 ? '' : 's'}` : ''}</div></td>
                    <td className="small">{STATE_LABEL[r.state] ?? r.state}{r.stateDetail && (r.state === 'rejected' || r.state === 'failed') && <div className="muted">{r.stateDetail}</div>}</td>
                    <td className="small">{r.uploadedBy ?? '—'}</td>
                    <td>
                      <div className="inline">
                        {r.state === 'available' && r.id !== selectedId && <button type="button" className="btn btn-small" onClick={() => { setSelectedId(r.id); setPage(1); }} aria-label={`View revision ${r.revision}`}>View</button>}
                        {r.id === selectedId && <span className="small muted">Viewing</span>}
                        {r.state === 'available' && <button type="button" className="btn btn-small" onClick={() => download(r)} aria-label={`Download revision ${r.revision}`}>Download</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div role="status" aria-live="polite">{msg && <p className={`notice small ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
        </section>

        <aside className="stack">
          {doc.can.setStatus && current && current.state === 'available' && <StatusForm revision={current} statuses={config.documentStatuses} onDone={refresh} />}
          {doc.can.upload && <NewRevisionForm doc={doc} current={current} config={config} onUploaded={async (revId) => { const d = await refresh(); if (d) setSelectedId(revId); }} />}
        </aside>
      </div>
    </div>
  );
}

function RevisionState({ r, onRetry, canRetry }: { r: Revision; onRetry: () => void; canRetry: boolean }) {
  const steps = ['quarantined', 'scanning', 'processing', 'available'];
  const at = steps.indexOf(r.state);
  return (
    <section className="card stack-sm" aria-labelledby="state-h">
      <h2 id="state-h">Revision {r.revision}: {STATE_LABEL[r.state] ?? r.state}</h2>
      {PENDING.includes(r.state) && (
        <ol className="small" style={{ margin: 0, paddingLeft: '1.2rem' }}>
          {['Uploaded', 'Checked for malware', 'File read and indexed', 'Ready to view'].map((label, i) => (
            <li key={label}>{label}: {r.state === 'awaiting_upload' ? 'waiting' : i < at ? 'done' : i === at ? 'in progress' : 'waiting'}</li>
          ))}
        </ol>
      )}
      {r.state === 'awaiting_upload' && <p className="small" style={{ margin: 0 }}>The file has not arrived. Upload it again from the form below.</p>}
      {(r.state === 'rejected' || r.state === 'failed') && (
        <div className={`notice ${r.state === 'rejected' ? 'notice-bad' : 'notice-warn'}`} role="alert">
          {r.stateDetail ?? 'This file could not be processed.'}
          {r.state === 'failed' && <> Your original file is kept.</>}
        </div>
      )}
      {r.state === 'failed' && canRetry && <div><button type="button" className="btn btn-small" onClick={onRetry}>Retry processing</button></div>}
      {r.state === 'rejected' && <p className="small muted" style={{ margin: 0 }}>Fix the file and upload it as a new revision, or ask support for a manual route.</p>}
    </section>
  );
}

function StatusForm({ revision, statuses, onDone }: { revision: Revision; statuses: { code: string; label: string }[]; onDone: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section className="card" aria-labelledby="status-h">
      <h2 id="status-h" style={{ fontSize: '1rem' }}>Status of revision {revision.revision}</h2>
      <p className="small muted">The label is shown with your name and the basis you give. It is your statement, not a platform approval.</p>
      <form className="stack-sm" onSubmit={async (e) => {
        e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setMsg(null);
        try { await call(`/v1/revisions/${revision.id}/status`, { body: { status: String(f.get('status')), basis: String(f.get('basis')) } }); setMsg({ ok: true, text: 'Status saved.' }); await onDone(); }
        catch (x) { setMsg({ ok: false, text: errorText(x) }); } finally { setBusy(false); }
      }}>
        <label htmlFor="st-status">Status</label>
        <select id="st-status" name="status" defaultValue={revision.status?.code ?? statuses[0]?.code}>{statuses.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select>
        <label htmlFor="st-basis">Basis <span className="hint">For example: “Issued by the architect on 10 Nov”</span></label>
        <textarea id="st-basis" name="basis" required minLength={3} maxLength={500} style={{ minHeight: '4rem' }} />
        <button className="btn btn-small" type="submit" disabled={busy}>Save status</button>
        <div role="status" aria-live="polite">{msg && <p className={`notice small ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
      </form>
    </section>
  );
}

function NewRevisionForm({ doc, current, config, onUploaded }: { doc: DocumentDetail; current: Revision | null; config: Config; onUploaded: (revisionId: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const maxMb = Math.round(config.maxUploadBytes / 1024 / 1024);
  const tooBig = !!file && file.size > config.maxUploadBytes;
  if (!current) return null;
  return (
    <section className="card" aria-labelledby="newrev-h">
      <h2 id="newrev-h" style={{ fontSize: '1rem' }}>Upload a new revision</h2>
      <p className="small muted">PDF, JPEG, PNG, WebP, CSV, XLSX, DOCX, DWG, DXF or IFC, up to {maxMb} MB (PDFs up to {config.maxPdfPages} pages). CAD, BIM and office files can be downloaded but not previewed.</p>
      <form ref={formRef} className="stack-sm" onSubmit={async (e) => {
        e.preventDefault();
        if (!file || tooBig) return;
        const f = new FormData(e.currentTarget); setBusy(true); setMsg(null); setProgress(0);
        try {
          const r = await call<{ revisionId: string; upload: { method: 'PUT'; url: string } }>(`/v1/documents/${doc.id}/revisions`, {
            body: { revisionLabel: String(f.get('label')), issuedDate: String(f.get('issued') || '') || undefined, fileName: file.name, bytes: file.size, supersedesRevisionId: current.id },
          });
          const up = await uploadFile(r.upload, file, setProgress);
          setMsg({ ok: true, text: up.duplicateOf ? `Uploaded. Note: this file is identical to ${up.duplicateOf}.` : 'Uploaded. We are checking and reading the file now.' });
          formRef.current?.reset(); setFile(null);
          await onUploaded(r.revisionId);
        } catch (x) { setMsg({ ok: false, text: errorText(x) }); } finally { setBusy(false); setProgress(null); }
      }}>
        <label htmlFor="nr-file">File</label>
        <input id="nr-file" type="file" accept={ACCEPT} required onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-invalid={tooBig || undefined} aria-describedby={tooBig ? 'nr-file-err' : undefined} />
        {tooBig && <div id="nr-file-err" className="field-error">This file is {size(file!.size)}; the limit is {maxMb} MB.</div>}
        <div className="row">
          <div><label htmlFor="nr-label">Revision label</label><input id="nr-label" name="label" required maxLength={20} placeholder="e.g. P2 or C1" /></div>
          <div><label htmlFor="nr-issued">Issue date <span className="hint">Optional</span></label><input id="nr-issued" name="issued" type="date" /></div>
        </div>
        <label className="check"><input type="checkbox" name="confirm" required /> This file replaces revision {current.revision} ({current.fileName}). Measurements on {current.revision} will be flagged for checking.</label>
        {progress != null && <div><div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Upload progress"><span style={{ width: `${progress}%` }} /></div><div className="small muted">{progress}% uploaded</div></div>}
        <button className="btn btn-primary btn-small" type="submit" disabled={busy || !file || tooBig}>Upload revision</button>
        <div role="status" aria-live="polite">{msg && <p className={`notice small ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
      </form>
      <p className="small muted" style={{ marginBottom: 0 }}>A new upload never silently replaces a drawing; earlier revisions stay in the history. <Link href={`/projects/${doc.projectId}/documents`}>Add a different document instead</Link></p>
    </section>
  );
}
