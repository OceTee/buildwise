'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, errorText, newKey } from '@/lib/client';

/** Adding and removing entries on the client's supplier lists (spec §13.1.5). */

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
  return { busy, run, status };
}

export function AddSupplierEntry({ projectId, kinds, categories }: { projectId: string; kinds: { code: string; label: string }[]; categories: { slug: string; name: string }[] }) {
  const a = useRun();
  const [kind, setKind] = useState('preferred');
  const needsReason = kind === 'blocked' || kind === 'conflict';
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void a.run(async () => {
      const cat = String(f.get('category') || '');
      await call(`/v1/projects/${projectId}/supplier-lists`, { idempotencyKey: newKey(), body: {
        handle: String(f.get('handle')).trim(), kind, categorySlugs: cat ? [cat] : [], validUntil: String(f.get('until') || '') || undefined, reason: String(f.get('reason') || '') || undefined,
      } });
      form.reset();
      return 'Added. It applies to your next match.';
    }); }}>
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Add a supplier to a list</h2>
      <div className="row">
        <div><label htmlFor="sl-handle">Supplier handle <span className="hint">The end of their profile address, /seller/handle</span></label><input id="sl-handle" name="handle" required minLength={2} maxLength={80} /></div>
        <div><label htmlFor="sl-kind">List</label><select id="sl-kind" value={kind} onChange={(e) => setKind(e.target.value)}>{kinds.map((k) => <option key={k.code} value={k.code}>{k.label}</option>)}</select></div>
      </div>
      <div className="row">
        {(kind === 'approved' || kind === 'preferred') && <div><label htmlFor="sl-cat">Category <span className="hint">Optional; all if blank</span></label><select id="sl-cat" name="category" defaultValue=""><option value="">All categories</option>{categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select></div>}
        <div><label htmlFor="sl-until">Until <span className="hint">{kind === 'approved' ? 'Optional; 12 months if blank' : 'Optional'}</span></label><input id="sl-until" name="until" type="date" /></div>
      </div>
      <div><label htmlFor="sl-reason">Reason {needsReason ? '(required, recorded)' : <span className="hint">Optional</span>}</label><input id="sl-reason" name="reason" required={needsReason} minLength={needsReason ? 5 : undefined} maxLength={500} /></div>
      <div><button type="submit" className="btn btn-small btn-primary" disabled={a.busy}>Add to list</button></div>
      {a.status}
    </form>
  );
}

export function RemoveSupplierEntry({ projectId, entryId, name }: { projectId: string; entryId: string; name: string }) {
  const a = useRun();
  const [reason, setReason] = useState('');
  return (
    <details><summary className="small">Remove <span className="sr-only">{name}</span></summary>
      <div className="stack-sm" style={{ marginTop: '.25rem' }}>
        <label htmlFor={`rm-${entryId}`} className="small">Reason</label>
        <input id={`rm-${entryId}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        <button type="button" className="btn btn-small" disabled={a.busy || reason.trim().length < 3} onClick={() => a.run(async () => { await call(`/v1/supplier-lists/${entryId}/remove`, { body: { projectId, reason } }); return 'Removed.'; })}>Remove entry</button>
      </div>
      {a.status}
    </details>
  );
}
