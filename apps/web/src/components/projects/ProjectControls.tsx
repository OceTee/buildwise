'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiFailure, call, errorText, newKey, uploadFile } from '@/lib/client';
import { stateLabel } from '@/lib/documents';

function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const t = await fn(); if (t) setMsg({ ok: true, text: t }); router.refresh(); return true; }
    catch (e) { setMsg({ ok: false, text: errorText(e) }); return false; } finally { setBusy(false); }
  };
  const status = <div role="status" aria-live="polite">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>;
  return { busy, run, status, router };
}

// ---------------------------------------------------------------- invitations and team
export function InvitationResponse({ invitation }: { invitation: { id: string; projectName: string; role: string; invitedBy: string } }) {
  const a = useRun();
  return (
    <div className="inline" style={{ justifyContent: 'space-between' }}>
      <span><strong>{invitation.projectName}</strong> <span className="small muted">as {invitation.role}, from {invitation.invitedBy}</span></span>
      <span className="inline">
        <button type="button" className="btn btn-small btn-primary" disabled={a.busy} onClick={() => a.run(async () => { const r = await call(`/v1/project-invitations/${invitation.id}/respond`, { body: { accept: true } }); a.router.push(`/projects/${r.projectId}`); })}>Accept</button>
        <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/project-invitations/${invitation.id}/respond`, { body: { accept: false } }); return 'Declined.'; })}>Decline</button>
      </span>
      {a.status}
    </div>
  );
}

export function InviteForm({ projectId, roles }: { projectId: string; roles: string[] }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget; void a.run(async () => { await call(`/v1/projects/${projectId}/invitations`, { body: { phone: String(f.get('phone')), role: String(f.get('role')) } }); form.reset(); return 'Invitation sent by SMS. They accept it after signing in with that number.'; }); }}>
      <div className="row">
        <div><label htmlFor="inv-phone">Mobile number</label><input id="inv-phone" name="phone" type="tel" autoComplete="off" required /></div>
        <div><label htmlFor="inv-role">Role</label><select id="inv-role" name="role">{roles.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
      </div>
      <button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Send invitation</button>
      {a.status}
    </form>
  );
}

export function MemberControls({ projectId, userId, role, roles, self }: { projectId: string; userId: string; role: string; roles: string[]; self: boolean }) {
  const a = useRun();
  const editable = roles.includes(role);
  return (
    <span className="inline">
      {editable && !self && (
        <>
          <label htmlFor={`role-${userId}`} className="sr-only">Role</label>
          <select id={`role-${userId}`} defaultValue={role} style={{ width: 'auto' }} onChange={(e) => { void a.run(async () => { await call(`/v1/projects/${projectId}/members/${userId}`, { method: 'PATCH', body: { role: e.target.value } }); return 'Role changed.'; }); }}>
            {roles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => { if (confirm('Remove this person from the project?')) void a.run(async () => { await call(`/v1/projects/${projectId}/members/${userId}`, { method: 'DELETE' }); }); }}>Remove</button>
        </>
      )}
      {self && role !== 'owner' && <button type="button" className="btn btn-small" onClick={() => { if (confirm('Leave this project?')) void a.run(async () => { await call(`/v1/projects/${projectId}/members/${userId}`, { method: 'DELETE' }); a.router.push('/projects'); }); }}>Leave project</button>}
      {a.status}
    </span>
  );
}

export function RevokeInvitation({ projectId, inviteId }: { projectId: string; inviteId: string }) {
  const a = useRun();
  return <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/projects/${projectId}/invitations/${inviteId}`, { method: 'DELETE' }); })}>Cancel invitation</button>;
}

// ---------------------------------------------------------------- documents

export function NewDocumentForm({ projectId, docTypes, disciplines, maxBytes, maxPages, canRestrict }: { projectId: string; docTypes: { code: string; label: string }[]; disciplines: { code: string; label: string }[]; maxBytes: number; maxPages: number; canRestrict: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [state, setState] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  if (!open) return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Upload a document</button>;
  const mb = Math.round(maxBytes / 1024 / 1024);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setMsg(null); setErrors({});
    if (!file) { setErrors({ file: 'Choose a file.' }); return; }
    if (file.size > maxBytes) { setErrors({ file: `This file is ${Math.round(file.size / 1024 / 1024)} MB; the limit is ${mb} MB.` }); return; }
    try {
      setState('Creating the document…');
      const r = await call<{ documentId: string; revisionId: string; upload: { method: 'PUT'; url: string } }>(`/v1/projects/${projectId}/documents`, {
        idempotencyKey: newKey(),
        body: { title: String(f.get('title')), number: String(f.get('number') || '') || undefined, docType: String(f.get('docType')), discipline: String(f.get('discipline')), revisionLabel: String(f.get('revisionLabel')), issuedDate: String(f.get('issuedDate') || '') || undefined, fileName: file.name, bytes: file.size, restricted: f.get('restricted') === 'on' },
      });
      setState('Uploading…'); setPct(0);
      const up = await uploadFile(r.upload, file, setPct);
      setState('Uploaded. Checking and reading the file…');
      for (let i = 0; i < 120; i++) {
        const d = await call(`/v1/documents/${r.documentId}`);
        const rev = d.revisions.find((x: any) => x.id === r.revisionId);
        setState(stateLabel(rev.state));
        if (rev.state === 'available') { setMsg({ ok: true, text: `Ready${rev.pages ? `: ${rev.pages} page(s)` : ''}.${up.duplicateOf ? ` Note: this file is identical to ${up.duplicateOf}.` : ''}` }); break; }
        if (rev.state === 'rejected' || rev.state === 'failed') { setMsg({ ok: false, text: rev.stateDetail ?? 'The file could not be processed.' }); break; }
        await new Promise((res) => setTimeout(res, 1500));
      }
      setPct(null); setFile(null); (e.target as HTMLFormElement).reset?.();
      router.refresh();
    } catch (x) {
      setPct(null); setState(null);
      if (x instanceof ApiFailure && x.code === 'DOCUMENT_EXISTS') setMsg({ ok: false, text: `${x.message}` });
      else if (x instanceof ApiFailure && x.fieldErrors.length) setErrors(Object.fromEntries(x.fieldErrors.map((fe) => [fe.path, fe.message])));
      else setMsg({ ok: false, text: errorText(x) });
    }
  }

  return (
    <form className="card stack-sm" onSubmit={submit}>
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Upload a document</h2>
      <p className="small muted" style={{ margin: 0 }}>PDF drawings and specifications (up to {maxPages} pages), photos, CSV or XLSX quantity lists, DOCX, and DWG/DXF/IFC files (download only). Up to {mb} MB. Password-protected PDFs can't be read.</p>
      <div className="row">
        <div><label htmlFor="d-title">Title</label><input id="d-title" name="title" required minLength={2} maxLength={200} /></div>
        <div><label htmlFor="d-number">Drawing or document number <span className="hint">Optional, e.g. A-101</span></label><input id="d-number" name="number" maxLength={40} /></div>
      </div>
      <div className="row">
        <div><label htmlFor="d-type">Type</label><select id="d-type" name="docType">{docTypes.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select></div>
        <div><label htmlFor="d-disc">Discipline</label><select id="d-disc" name="discipline">{disciplines.map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}</select></div>
        <div><label htmlFor="d-rev">Revision</label><input id="d-rev" name="revisionLabel" required maxLength={20} defaultValue="P1" /></div>
        <div><label htmlFor="d-date">Issue date <span className="hint">Optional</span></label><input id="d-date" name="issuedDate" type="date" /></div>
      </div>
      <div className="field">
        <label htmlFor="d-file">File</label>
        <input id="d-file" type="file" required onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-invalid={!!errors.file || undefined} aria-describedby={errors.file ? 'd-file-err' : undefined} />
        {errors.file && <div id="d-file-err" className="field-error">{errors.file}</div>}
      </div>
      {canRestrict && <label className="check"><input type="checkbox" name="restricted" /> Restrict to owners and managers (for example title documents)</label>}
      {pct != null && <div className="progress" role="progressbar" aria-label="Upload progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>}
      <div role="status" aria-live="polite" className="small">{state}</div>
      <div className="inline"><button className="btn btn-primary" type="submit" disabled={!!state && !msg}>Upload</button><button type="button" className="btn" onClick={() => setOpen(false)}>Close</button></div>
      <div role="alert">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
    </form>
  );
}

// ---------------------------------------------------------------- RFIs
export function NewRfiForm({ projectId, members }: { projectId: string; members: { userId: string; name: string }[] }) {
  const a = useRun();
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Raise an RFI</button>;
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      const r = await call(`/v1/projects/${projectId}/rfis`, { body: { subject: String(f.get('subject')), question: String(f.get('question')), assigneeUserId: String(f.get('assignee') || '') || undefined, dueDate: String(f.get('due') || '') || undefined } });
      a.router.push(`/projects/${projectId}/rfis/${r.id}`);
    }); }}>
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Raise a request for information</h2>
      <label htmlFor="rfi-subject">Subject</label><input id="rfi-subject" name="subject" required minLength={3} maxLength={200} />
      <label htmlFor="rfi-q">Question</label><textarea id="rfi-q" name="question" required minLength={5} maxLength={4000} />
      <div className="row">
        <div><label htmlFor="rfi-a">Assign to <span className="hint">Optional</span></label><select id="rfi-a" name="assignee"><option value="">Project owners and managers</option>{members.map((m) => <option key={m.userId} value={m.userId}>{m.name}</option>)}</select></div>
        <div><label htmlFor="rfi-due">Answer needed by <span className="hint">Optional</span></label><input id="rfi-due" name="due" type="date" /></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>To ask about a specific drawing, raise the RFI from that drawing so it links to the page.</p>
      <div className="inline"><button className="btn btn-primary" type="submit" disabled={a.busy}>Raise RFI</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
      {a.status}
    </form>
  );
}

export function RfiReply({ rfiId, open }: { rfiId: string; open: boolean }) {
  const a = useRun();
  if (!open) return null;
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const form = e.currentTarget; const close = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'close';
      void a.run(async () => { await call(`/v1/rfis/${rfiId}/entries`, { body: { kind: String(f.get('kind')), body: String(f.get('body')), close } }); form.reset(); return close ? 'Closed.' : 'Added.'; }); }}>
      <fieldset style={{ margin: 0 }}>
        <legend>Add to this RFI</legend>
        <div className="inline">
          {[['response', 'Response'], ['decision', 'Design decision'], ['question', 'Follow-up question'], ['note', 'Note']].map(([v, l]) => <label key={v} className="check"><input type="radio" name="kind" value={v} defaultChecked={v === 'response'} /> {l}</label>)}
        </div>
      </fieldset>
      <label htmlFor="rfi-body">Text <span className="hint">Entries cannot be edited later</span></label>
      <textarea id="rfi-body" name="body" required minLength={2} maxLength={4000} />
      <div className="inline"><button className="btn btn-primary btn-small" type="submit" value="add" disabled={a.busy}>Add</button><button className="btn btn-small" type="submit" value="close" disabled={a.busy}>Add and close RFI</button></div>
      {a.status}
    </form>
  );
}

// ---------------------------------------------------------------- payments (record-only)
export function PaymentForm({ projectId }: { projectId: string }) {
  const a = useRun();
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>Record a payment</button>;
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/projects/${projectId}/payments`, { idempotencyKey: newKey(), body: { payee: String(f.get('payee')), description: String(f.get('description')), amount: String(f.get('amount')), paidOn: String(f.get('paidOn')), method: String(f.get('method')), reference: String(f.get('reference') || '') || undefined } });
      setOpen(false); return 'Recorded.';
    }); }}>
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Record a payment you made</h2>
      <p className="small muted" style={{ margin: 0 }}>This is a record only. BuildWise does not send, hold or protect the money.</p>
      <div className="row">
        <div><label htmlFor="pay-payee">Paid to</label><input id="pay-payee" name="payee" required minLength={2} maxLength={160} /></div>
        <div><label htmlFor="pay-amount">Amount</label><input id="pay-amount" name="amount" inputMode="decimal" required /></div>
        <div><label htmlFor="pay-date">Date paid</label><input id="pay-date" name="paidOn" type="date" required max={new Date().toISOString().slice(0, 10)} /></div>
      </div>
      <div className="row">
        <div><label htmlFor="pay-desc">What for</label><input id="pay-desc" name="description" required minLength={2} maxLength={300} /></div>
        <div><label htmlFor="pay-method">Method</label><select id="pay-method" name="method">{[['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['mobile_money', 'Mobile money'], ['cheque', 'Cheque'], ['other', 'Other']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label htmlFor="pay-ref">Reference <span className="hint">Optional</span></label><input id="pay-ref" name="reference" maxLength={120} /></div>
      </div>
      <div className="inline"><button className="btn btn-primary" type="submit" disabled={a.busy}>Save record</button><button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button></div>
      {a.status}
    </form>
  );
}

export function PaymentActions({ id, canAcknowledge }: { id: string; canAcknowledge: boolean }) {
  const a = useRun();
  return (
    <span className="inline">
      {canAcknowledge && <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/payment-records/${id}/acknowledge`, { body: {} }); })}>Acknowledge</button>}
      <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => { const reason = prompt('Why is this record wrong?'); if (reason) void a.run(async () => { await call(`/v1/payment-records/${id}/void`, { body: { reason } }); }); }}>Void</button>
      {a.status}
    </span>
  );
}

export function StaffAccessForm() {
  const a = useRun();
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      const id = String(f.get('projectId')).trim();
      const r = await call('/v1/staff/access-sessions', { body: { projectId: id, reasonCode: String(f.get('reason')), ticket: String(f.get('ticket')) } });
      a.router.push(`/projects/${id}`); return `Access granted for ${r.expiresInHours} hours.`;
    }); }}>
      <label htmlFor="sa-project">Project ID</label><input id="sa-project" name="projectId" required pattern="[0-9a-f-]{36}" />
      <div className="row">
        <div><label htmlFor="sa-reason">Reason</label><select id="sa-reason" name="reason">{[['support_request', 'Support request'], ['verification', 'Verification'], ['case_investigation', 'Case investigation'], ['review_assignment', 'Review assignment'], ['security', 'Security']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></div>
        <div><label htmlFor="sa-ticket">Ticket or case reference</label><input id="sa-ticket" name="ticket" required minLength={3} maxLength={80} /></div>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Access is read-only, ends automatically, is audited, and the project owner is notified.</p>
      <button className="btn btn-primary" type="submit" disabled={a.busy}>Open project</button>
      {a.status}
    </form>
  );
}
