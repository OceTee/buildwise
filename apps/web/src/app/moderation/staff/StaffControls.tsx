'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiFailure, call, errorText } from '@/lib/client';

/** Runs a staff change; a stale second factor links to the two-step page to confirm with a fresh code. */
function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; stepUp?: boolean } | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); router.refresh(); }
    catch (e) { setMsg({ ok: false, text: errorText(e), stepUp: e instanceof ApiFailure && e.code === 'STEP_UP_REQUIRED' }); }
    finally { setBusy(false); }
  };
  const status = (
    <div role="status" aria-live="polite">
      {msg && (
        <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>
          {msg.text}{msg.stepUp && <> <a href="/account/two-step?next=/moderation/staff">Enter a code</a></>}
        </p>
      )}
    </div>
  );
  return { busy, run, status };
}

export function GrantStaffRole({ roles }: { roles: { role: string; label: string; needsSecondApprover: boolean }[] }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const f = new FormData(form);
      void a.run(async () => {
        const r = await call<{ status: string }>('/v1/moderation/staff/grants', { body: { phone: String(f.get('phone')), role: String(f.get('role')), reason: String(f.get('reason')) } });
        form.reset();
        return r.status === 'pending' ? 'Asked. A second operations admin must approve it.' : 'Role granted.';
      });
    }}>
      <div className="row">
        <div><label htmlFor="sg-phone">Their mobile number</label><input id="sg-phone" name="phone" type="tel" inputMode="tel" autoComplete="off" required minLength={6} maxLength={24} /></div>
        <div><label htmlFor="sg-role">Role</label><select id="sg-role" name="role" required>{roles.map((r) => <option key={r.role} value={r.role}>{r.label}{r.needsSecondApprover ? ' (needs a second approver)' : ''}</option>)}</select></div>
      </div>
      <label htmlFor="sg-reason">Reason <span className="hint">Kept in the audit log</span></label>
      <input id="sg-reason" name="reason" required minLength={5} maxLength={500} />
      <div><button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Grant role</button></div>
      {a.status}
    </form>
  );
}

export function DecideStaffChange({ id, mine, summary }: { id: string; mine: boolean; summary: string }) {
  const a = useRun();
  return (
    <div className="stack-sm">
      <div className="inline">
        {!mine && <button type="button" className="btn btn-small btn-primary" disabled={a.busy} aria-label={`Approve ${summary}`}
          onClick={() => a.run(async () => { await call(`/v1/moderation/staff/changes/${id}/approve`, { body: {} }); return 'Approved and applied.'; })}>Approve</button>}
        <button type="button" className="btn btn-small" disabled={a.busy} aria-label={`${mine ? 'Cancel' : 'Reject'} ${summary}`}
          onClick={() => a.run(async () => { await call(`/v1/moderation/staff/changes/${id}/reject`, { body: {} }); return mine ? 'Cancelled.' : 'Rejected.'; })}>{mine ? 'Cancel request' : 'Reject'}</button>
      </div>
      {mine && <p className="small muted" style={{ margin: 0 }}>You asked for this, so another operations admin must approve it.</p>}
      {a.status}
    </div>
  );
}

function ReasonAction({ label, done, path, name, danger }: { label: string; done: string; path: string; name: string; danger?: boolean }) {
  const a = useRun();
  const [open, setOpen] = useState(false);
  const id = `${path.replace(/\W/g, '-')}`;
  if (!open) return <div><button type="button" className={`btn btn-small ${danger ? 'btn-danger' : ''}`} onClick={() => setOpen(true)} aria-label={`${label}: ${name}`}>{label}</button>{a.status}</div>;
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => { await call(path, { body: { reason: String(f.get('reason')) } }); setOpen(false); return done; }); }}>
      <label htmlFor={id}>Reason</label>
      <input id={id} name="reason" required minLength={5} maxLength={500} />
      <div className="inline">
        <button className={`btn btn-small ${danger ? 'btn-danger' : 'btn-primary'}`} type="submit" disabled={a.busy}>{label}</button>
        <button type="button" className="btn btn-small" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {a.status}
    </form>
  );
}

export const RevokeStaffRole = ({ userId, name }: { userId: string; name: string }) =>
  <ReasonAction label="Revoke role" done="Role revoked." path={`/v1/moderation/staff/${userId}/revoke`} name={name} danger />;

export const ResetStaffMfa = ({ userId, name }: { userId: string; name: string }) =>
  <ReasonAction label="Reset two-step" done="Two-step verification reset. They set it up again at their next staff sign-in." path={`/v1/moderation/staff/${userId}/mfa-reset`} name={name} />;
