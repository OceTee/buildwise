'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, errorText } from '@/lib/client';

function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); router.refresh(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  const status = <div role="status" aria-live="polite">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>;
  return { busy, run, status };
}

export function DecideListing({ id, version, reasonCodes }: { id: string; version: number; reasonCodes: { code: string; message: string }[] }) {
  const a = useRun();
  const [decision, setDecision] = useState<'approve' | 'reject' | 'block'>('approve');
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/moderation/listings/${id}/decide`, { body: { decision, expectedVersion: version, reasonCode: decision === 'approve' ? undefined : String(f.get('reasonCode')), note: String(f.get('note') || '') || undefined } });
      return decision === 'approve' ? 'Approved.' : decision === 'reject' ? 'Sent back to the seller.' : 'Blocked.';
    }); }}>
      <fieldset style={{ margin: 0 }}>
        <legend className="sr-only">Decision</legend>
        <div className="inline">
          {(['approve', 'reject', 'block'] as const).map((d) => <label key={d} className="check"><input type="radio" name={`d-${id}`} checked={decision === d} onChange={() => setDecision(d)} /> {d === 'approve' ? 'Approve' : d === 'reject' ? 'Needs changes' : 'Block'}</label>)}
        </div>
      </fieldset>
      {decision !== 'approve' && (
        <div className="row">
          <div><label htmlFor={`rc-${id}`}>Reason shown to seller</label><select id={`rc-${id}`} name="reasonCode" required>{reasonCodes.map((r) => <option key={r.code} value={r.code}>{r.message}</option>)}</select></div>
          <div><label htmlFor={`nt-${id}`}>Note to seller <span className="hint">Optional</span></label><input id={`nt-${id}`} name="note" maxLength={1000} /></div>
        </div>
      )}
      <button className={`btn btn-small ${decision === 'approve' ? 'btn-primary' : decision === 'block' ? 'btn-danger' : ''}`} type="submit" disabled={a.busy}>Record decision</button>
      {a.status}
    </form>
  );
}

export function DecideReport({ id, targetType }: { id: string; targetType: string }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const outcome = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? 'dismissed';
      void a.run(async () => { await call(`/v1/moderation/reports/${id}/decide`, { body: { outcome, note: String(f.get('note')), removeReview: targetType === 'review' && outcome === 'actioned' } }); return outcome === 'actioned' ? 'Actioned.' : 'Dismissed.'; });
    }}>
      <label htmlFor={`rn-${id}`}>Decision note</label>
      <input id={`rn-${id}`} name="note" required minLength={3} maxLength={1000} />
      <div className="inline">
        <button className="btn btn-small btn-primary" type="submit" name="outcome" value="actioned" disabled={a.busy}>{targetType === 'review' ? 'Remove review' : 'Mark actioned'}</button>
        <button className="btn btn-small" type="submit" name="outcome" value="dismissed" disabled={a.busy}>Dismiss</button>
      </div>
      {a.status}
    </form>
  );
}

export function DecideAppeal({ id, canDecide }: { id: string; canDecide: boolean }) {
  const a = useRun();
  if (!canDecide) return <p className="small muted" style={{ margin: 0 }}>You made the original decision, so another moderator must decide this appeal.</p>;
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const outcome = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? 'upheld';
      void a.run(async () => { await call(`/v1/moderation/appeals/${id}/decide`, { body: { outcome, note: String(f.get('note')) } }); return outcome === 'overturned' ? 'Overturned: the listing goes back to review.' : 'Original decision upheld.'; });
    }}>
      <label htmlFor={`an-${id}`}>Reason (shown to the seller)</label>
      <textarea id={`an-${id}`} name="note" required minLength={5} maxLength={1000} />
      <div className="inline">
        <button className="btn btn-small btn-primary" type="submit" value="overturned" disabled={a.busy}>Overturn</button>
        <button className="btn btn-small" type="submit" value="upheld" disabled={a.busy}>Uphold</button>
      </div>
      {a.status}
    </form>
  );
}

export function ReleaseMessage({ id }: { id: string }) {
  const a = useRun();
  return (
    <form className="inline" onSubmit={(e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const release = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'release';
      void a.run(async () => { await call(`/v1/moderation/messages/${id}/release`, { body: { release, note: String(f.get('note')) } }); return release ? 'Released.' : 'Kept held.'; });
    }}>
      <label htmlFor={`mn-${id}`} className="sr-only">Note</label>
      <input id={`mn-${id}`} name="note" required minLength={3} placeholder="Note" style={{ maxWidth: '16rem' }} />
      <button className="btn btn-small" type="submit" value="release" disabled={a.busy}>Release</button>
      <button className="btn btn-small" type="submit" value="keep" disabled={a.busy}>Keep held</button>
      {a.status}
    </form>
  );
}

export function DecideReview({ id }: { id: string }) {
  const a = useRun();
  return (
    <form className="inline" onSubmit={(e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const publish = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'publish';
      void a.run(async () => { await call(`/v1/moderation/reviews/${id}/decide`, { body: { publish, note: String(f.get('note')) } }); return publish ? 'Published.' : 'Removed.'; });
    }}>
      <label htmlFor={`vn-${id}`} className="sr-only">Note</label>
      <input id={`vn-${id}`} name="note" required minLength={3} placeholder="Note" style={{ maxWidth: '16rem' }} />
      <button className="btn btn-small" type="submit" value="publish" disabled={a.busy}>Publish</button>
      <button className="btn btn-small" type="submit" value="remove" disabled={a.busy}>Remove</button>
      {a.status}
    </form>
  );
}

export function RestrictSeller({ orgId }: { orgId: string }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      const r = await call('/v1/moderation/restrictions', { body: { orgId, kind: String(f.get('kind')), reason: String(f.get('reason')), days: f.get('days') ? Number(f.get('days')) : null, impersonation: f.get('impersonation') === 'on' } });
      return r.status === 'pending_second_approval' ? 'Recorded. A second moderator must approve it before it takes effect.' : 'Restriction active.';
    }); }}>
      <div className="row">
        <div><label htmlFor="rk">Restriction</label><select id="rk" name="kind"><option value="posting_limit">Posting limit</option><option value="chat_limit">Chat limit</option><option value="listing_suspension">Suspend listings</option><option value="account_suspension">Suspend account</option></select></div>
        <div><label htmlFor="rd">Days <span className="hint">Blank = until lifted</span></label><input id="rd" name="days" inputMode="numeric" pattern="\d*" /></div>
      </div>
      <label htmlFor="rr">Reason (shown to the seller)</label>
      <input id="rr" name="reason" required minLength={5} maxLength={500} />
      <label className="check"><input type="checkbox" name="impersonation" /> Impersonation case (needs a second moderator)</label>
      <button className="btn btn-small btn-danger" type="submit" disabled={a.busy}>Restrict seller</button>
      {a.status}
    </form>
  );
}

export function RestrictionActions({ id, status }: { id: string; status: string }) {
  const a = useRun();
  return (
    <span className="inline">
      {status === 'pending_second_approval' && <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/moderation/restrictions/${id}/approve`, { body: {} }); return 'Approved.'; })}>Approve (second moderator)</button>}
      <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => { const note = prompt('Why lift this restriction?'); if (note) void a.run(async () => { await call(`/v1/moderation/restrictions/${id}/lift`, { body: { note } }); return 'Lifted.'; }); }}>Lift</button>
      {a.status}
    </span>
  );
}

export function RecordCheck({ orgId }: { orgId: string }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/moderation/sellers/${orgId}/checks`, { body: { checkType: String(f.get('type')), state: String(f.get('state')), source: String(f.get('source')), expiresAt: String(f.get('expires') || '') || undefined, reserveName: f.get('reserve') === 'on' } });
      return 'Check recorded.';
    }); }}>
      <div className="row">
        <div><label htmlFor="ct">Check</label><select id="ct" name="type"><option value="business_registration">Business registration</option><option value="identity_contact">Contact details</option><option value="professional_credential">Professional credential</option><option value="trade_reference">Trade reference</option><option value="stock_evidence">Stock seen</option></select></div>
        <div><label htmlFor="cs">Result</label><select id="cs" name="state"><option value="passed">Passed</option><option value="failed">Failed</option><option value="revoked">Revoked</option></select></div>
        <div><label htmlFor="ce">Expires <span className="hint">Optional</span></label><input id="ce" name="expires" type="date" /></div>
      </div>
      <label htmlFor="csrc">Source of evidence</label>
      <input id="csrc" name="source" required minLength={3} maxLength={200} placeholder="e.g. registry lookup, reference call" />
      <label className="check"><input type="checkbox" name="reserve" /> Reserve this business name against look-alikes</label>
      <button className="btn btn-small" type="submit" disabled={a.busy}>Record check</button>
      {a.status}
    </form>
  );
}

export function CategoryVersion({ slug, definition }: { slug: string; definition: unknown }) {
  const a = useRun();
  const [text, setText] = useState(JSON.stringify(definition, null, 2));
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const note = String(new FormData(e.currentTarget).get('note')); void a.run(async () => {
      let def: unknown; try { def = JSON.parse(text); } catch { throw new Error('Definition is not valid JSON.'); }
      const r = await call(`/v1/admin/categories/${slug}/versions`, { body: { definition: def, note } });
      return `Published version ${r.version}. Existing listings keep their version until edited.`;
    }); }}>
      <label htmlFor={`def-${slug}`}>Definition (JSON)</label>
      <textarea id={`def-${slug}`} value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: '16rem', fontFamily: 'ui-monospace, monospace', fontSize: '.85rem' }} spellCheck={false} />
      <label htmlFor={`cn-${slug}`}>Change note</label>
      <input id={`cn-${slug}`} name="note" required minLength={3} maxLength={500} />
      <button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Publish new version</button>
      {a.status}
    </form>
  );
}
