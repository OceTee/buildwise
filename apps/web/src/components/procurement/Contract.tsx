'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, errorText, newKey } from '@/lib/client';

/**
 * Milestones, variations and award revisions on an order or contract page, for both sides (R3 last slice, spec §9.5,
 * §9.6). What each side may do comes from the API (`commands`, `canAddMilestones`, `canPropose`). Payments against
 * milestones are recorded in the payments section below; they stay records only.
 */

type C = any;

const MILESTONE_STATE: Record<string, { label: string; cls: string }> = {
  not_started: { label: 'Not started', cls: '' }, ready: { label: 'Ready to start', cls: '' }, in_progress: { label: 'In progress', cls: 'pill-warn' },
  awaiting_client: { label: 'Waiting for sign-off', cls: 'pill-warn' }, complete: { label: 'Complete', cls: 'pill-good' }, blocked: { label: 'Blocked', cls: 'pill-bad' },
  disputed: { label: 'Disputed', cls: 'pill-bad' }, cancelled: { label: 'Cancelled', cls: '' },
};
const VARIATION_STATE: Record<string, { label: string; cls: string }> = {
  proposed: { label: 'Proposed, to be priced', cls: '' }, impact_assessed: { label: 'Priced', cls: 'pill-warn' }, under_review: { label: 'Waiting for decision', cls: 'pill-warn' },
  approved: { label: 'Approved', cls: 'pill-good' }, rejected: { label: 'Rejected', cls: 'pill-bad' }, withdrawn: { label: 'Withdrawn', cls: '' },
  instructed: { label: 'Instructed', cls: 'pill-good' }, executed: { label: 'Carried out', cls: 'pill-good' }, valued: { label: 'Valued', cls: 'pill-good' },
};
const MILESTONE_CMD: Record<string, string> = { ready: 'Mark ready to start', start: 'Start work', claim: 'Ask for sign-off', accept: 'Sign off as complete', reject: 'Send back', block: 'Mark blocked', unblock: 'Unblock', dispute: 'Dispute', resolve: 'Resolve dispute', cancel: 'Cancel milestone' };
const VARIATION_CMD: Record<string, string> = { assess: 'Price it', submit: 'Send for decision', return: 'Send back for a new price', approve: 'Approve variation', reject: 'Reject variation', withdraw: 'Withdraw', instruct: 'Instruct', execute: 'Mark carried out', value: 'Mark valued' };
const NEEDS_REASON = ['reject', 'block', 'dispute', 'cancel', 'resolve'];

const Pill = ({ map, k }: { map: Record<string, { label: string; cls: string }>; k: string }) => <span className={`pill ${map[k]?.cls ?? ''}`}>{map[k]?.label ?? k}</span>;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '');
const days = (n: number) => `${n > 0 ? '+' : ''}${n} day${Math.abs(n) === 1 ? '' : 's'}`;

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

export function ContractPanel({ c }: { c: C }) {
  const s = c.summary;
  return (
    <div className="stack">
      <section className="stack-sm" aria-labelledby="ms-h">
        <h2 id="ms-h" style={{ fontSize: '1.1rem', margin: 0 }}>{c.kind === 'contract' ? 'Contract milestones' : 'Payment milestones'}</h2>
        <dl className="facts small">
          <dt>Contract value</dt><dd>{c.contractValue.display}{c.revisions.length > 1 ? ` (awarded at ${c.originalValue.display}, revision ${c.revisions.length})` : ''}</dd>
          <dt>Scheduled in milestones</dt><dd>{s.scheduledMinor.display}{s.unscheduledMinor.amountMinor !== '0' ? ` · ${s.unscheduledMinor.display} not yet scheduled` : ''}</dd>
          <dt>Signed off</dt><dd>{s.complete} of {s.total} · {s.completeMinor.display}</dd>
          {c.retentionPct > 0 && (<><dt>Retention</dt><dd>{c.retentionPct}% held on each signed-off milestone · {s.retentionHeldMinor.display} held</dd></>)}
          <dt>Recorded as paid</dt><dd>{s.paidMinor.display} · {s.payableMinor.display} left to pay on signed-off milestones</dd>
        </dl>
        {c.scheduleProblems.length > 0 && <p className="notice notice-warn small" style={{ margin: 0 }}>{c.scheduleProblems.join(' ')}</p>}
        {c.milestones.length === 0 && <p className="small muted" style={{ margin: 0 }}>{c.side === 'client' ? 'No milestones yet. Split the contract value into payment milestones.' : 'The client has not set milestones yet.'}</p>}
        {c.milestones.map((m: any) => <Milestone key={m.id} m={m} />)}
        {c.canAddMilestones && <AddMilestones c={c} />}
      </section>
      <section className="stack-sm" aria-labelledby="var-h">
        <h2 id="var-h" style={{ fontSize: '1.1rem', margin: 0 }}>Variations</h2>
        <p className="small muted" style={{ margin: 0 }}>A variation changes the scope, cost or time of the award. The supplier prices it, the project owner decides, and an approved variation creates a new revision of the award.</p>
        {c.variations.length === 0 && <p className="small muted" style={{ margin: 0 }}>No variations.</p>}
        {c.variations.map((v: any) => <Variation key={v.id} v={v} />)}
        {c.canPropose && <ProposeVariation c={c} />}
      </section>
      <section className="stack-sm" aria-labelledby="rev-h">
        <h2 id="rev-h" style={{ fontSize: '1.1rem', margin: 0 }}>Award revisions</h2>
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <caption className="sr-only">Revisions of the award</caption>
            <thead><tr><th scope="col">Revision</th><th scope="col">Reason</th><th scope="col" className="num">Value</th><th scope="col" className="num">Time</th><th scope="col">Completion</th><th scope="col">Recorded</th></tr></thead>
            <tbody>{c.revisions.map((r: any) => (
              <tr key={r.number}><td>{r.number}</td><td>{r.reason}</td><td className="num">{r.value.display}</td><td className="num">{days(r.timeDays)}</td><td className="small">{r.completionDate ?? '—'}</td><td className="small">{when(r.at)}<div className="muted"><code style={{ wordBreak: 'break-all' }}>{r.hash.slice(0, 16)}</code></div></td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Milestone({ m }: { m: any }) {
  const a = useRun();
  const [reason, setReason] = useState('');
  const go = (cmd: string) => a.run(async () => {
    await call(`/v1/milestones/${m.id}/commands/${cmd}`, { idempotencyKey: newKey(), body: { expectedVersion: m.version, ...(cmd === 'claim' ? { evidenceNote: reason } : reason ? { reason } : {}) } });
    setReason('');
    return cmd === 'accept' ? 'Signed off. You can now record a payment against it.' : cmd === 'claim' ? 'Sent to the client for sign-off.' : undefined;
  });
  const needsText = m.commands.some((c: string) => NEEDS_REASON.includes(c) || c === 'claim');
  return (
    <article className="card stack-sm" aria-labelledby={`m-${m.id}`}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h3 id={`m-${m.id}`} style={{ fontSize: '1rem', margin: 0 }}>{m.position}. {m.title}: {m.amount.display}</h3>
        <Pill map={MILESTONE_STATE} k={m.state} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>{m.dueDate ? `Due ${m.dueDate}` : 'No due date'}{m.state === 'complete' ? ` · retention ${m.retention.display} · paid ${m.paid.display} · ${m.payable.display} left to pay` : ''}</p>
      {m.description && <p className="small" style={{ margin: 0 }}>{m.description}</p>}
      {m.evidenceNote && <p className="small" style={{ margin: 0 }}><strong>Work done:</strong> {m.evidenceNote}</p>}
      {m.commands.length > 0 && (
        <div className="stack-sm">
          {needsText && (<><label htmlFor={`mr-${m.id}`}>{m.commands.includes('claim') ? 'What was done (shown to the client)' : 'Reason (needed to send back, block, dispute or cancel)'}</label>
            <input id={`mr-${m.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} /></>)}
          <div className="inline">
            {m.commands.map((cmd: string) => (
              <button key={cmd} type="button" className={`btn btn-small ${['accept', 'start', 'claim'].includes(cmd) ? 'btn-primary' : cmd === 'cancel' ? 'btn-danger' : ''}`}
                disabled={a.busy || ((NEEDS_REASON.includes(cmd) || cmd === 'claim') && reason.trim().length < 3)} onClick={() => go(cmd)}>{MILESTONE_CMD[cmd] ?? cmd} <span className="sr-only">for {m.title}</span></button>
            ))}
          </div>
        </div>
      )}
      {m.history.length > 1 && (
        <details className="small"><summary>History</summary>
          <ol>{m.history.map((h: any, i: number) => <li key={i}>{when(h.at)}: {h.by} ({h.side}) {h.command.replace(/_/g, ' ')}{h.reason ? `: ${h.reason}` : ''}</li>)}</ol>
        </details>
      )}
      {a.status}
    </article>
  );
}

function AddMilestones({ c }: { c: C }) {
  const a = useRun();
  return (
    <details><summary className="small">Add a milestone</summary>
      <form className="card-inset stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void a.run(async () => {
        await call(`/v1/orders/${c.orderId}/milestones`, { idempotencyKey: newKey(), body: { milestones: [{ title: String(f.get('title')), amount: String(f.get('amount')), dueDate: String(f.get('due') || '') || undefined, description: String(f.get('description') || '') || undefined }] } });
        form.reset();
        return 'Milestone added. The supplier has been told.';
      }); }}>
        <p className="small muted" style={{ margin: 0 }}>{c.summary.unscheduledMinor.display} of the contract value is not yet in a milestone.</p>
        <div className="row">
          <div><label htmlFor="ms-title">Milestone</label><input id="ms-title" name="title" required minLength={3} maxLength={160} placeholder="e.g. First fix complete" /></div>
          <div><label htmlFor="ms-amount">Amount</label><input id="ms-amount" name="amount" required inputMode="decimal" /></div>
          <div><label htmlFor="ms-due">Due <span className="hint">Optional</span></label><input id="ms-due" name="due" type="date" /></div>
        </div>
        <div><label htmlFor="ms-desc">What has to be done <span className="hint">Optional</span></label><input id="ms-desc" name="description" maxLength={1000} /></div>
        <div><button type="submit" className="btn btn-small" disabled={a.busy}>Add milestone</button></div>
        {a.status}
      </form>
    </details>
  );
}

function Variation({ v }: { v: any }) {
  const a = useRun();
  const [note, setNote] = useState('');
  const [cost, setCost] = useState('');
  const [time, setTime] = useState('');
  const go = (cmd: string) => a.run(async () => {
    await call(`/v1/variations/${v.id}/commands/${cmd}`, { idempotencyKey: newKey(), body: { expectedVersion: v.version, ...(note ? { note } : {}), ...(cmd === 'assess' ? { costImpact: cost, timeImpactDays: Number(time || 0) } : {}) } });
    setNote('');
    return cmd === 'approve' ? 'Approved. A new revision of the award was recorded.' : undefined;
  });
  return (
    <article className="card stack-sm" aria-labelledby={`v-${v.id}`}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h3 id={`v-${v.id}`} style={{ fontSize: '1rem', margin: 0 }}>{v.reference}: {v.title}</h3>
        <Pill map={VARIATION_STATE} k={v.state} />
      </div>
      <p className="small" style={{ margin: 0 }}>{v.description}</p>
      <dl className="facts small">
        <dt>Why</dt><dd>{v.reason}</dd>
        <dt>Proposed by</dt><dd>{v.proposedBy} ({v.proposedSide === 'client' ? 'client' : 'supplier'})</dd>
        <dt>Cost impact</dt><dd>{v.cost ? v.cost.display : 'Not priced yet'}</dd>
        <dt>Time impact</dt><dd>{v.timeImpactDays == null ? 'Not given yet' : days(v.timeImpactDays)}</dd>
        {v.decisionNote && (<><dt>Decision</dt><dd>{v.decisionNote}</dd></>)}
      </dl>
      {v.lines.length > 0 && <ul className="small" style={{ margin: 0 }}>{v.lines.map((l: any, i: number) => <li key={i}>{l.description}: {l.quantity} {l.unit} at {l.rate.display}</li>)}</ul>}
      {v.commands.length > 0 && (
        <div className="stack-sm">
          {v.commands.includes('assess') && (
            <div className="row">
              <div><label htmlFor={`vc-${v.id}`}>Cost impact <span className="hint">Negative for an omission</span></label><input id={`vc-${v.id}`} value={cost} onChange={(e) => setCost(e.target.value)} inputMode="decimal" /></div>
              <div><label htmlFor={`vt-${v.id}`}>Time impact (days)</label><input id={`vt-${v.id}`} value={time} onChange={(e) => setTime(e.target.value)} inputMode="numeric" /></div>
            </div>
          )}
          <label htmlFor={`vn-${v.id}`}>Note <span className="hint">Needed to send back or reject</span></label>
          <input id={`vn-${v.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
          <div className="inline">
            {v.commands.map((cmd: string) => (
              <button key={cmd} type="button" className={`btn btn-small ${cmd === 'approve' || cmd === 'submit' ? 'btn-primary' : cmd === 'reject' || cmd === 'withdraw' ? 'btn-danger' : ''}`}
                disabled={a.busy || (['return', 'reject'].includes(cmd) && note.trim().length < 3) || (cmd === 'assess' && !cost)} onClick={() => go(cmd)}>{VARIATION_CMD[cmd] ?? cmd} <span className="sr-only">{v.reference}</span></button>
            ))}
          </div>
        </div>
      )}
      <details className="small"><summary>Revision history ({v.history.length})</summary>
        <ol>{v.history.map((h: any, i: number) => <li key={i}>{when(h.at)}: {h.by} ({h.side === 'client' ? 'client' : 'supplier'}) {h.command}{h.cost ? `, ${h.cost.display}` : ''}{h.timeImpactDays != null ? `, ${days(h.timeImpactDays)}` : ''}{h.note ? `: ${h.note}` : ''}</li>)}</ol>
      </details>
      {a.status}
    </article>
  );
}

function ProposeVariation({ c }: { c: C }) {
  const a = useRun();
  const provider = c.side === 'provider';
  return (
    <details><summary className="small">Propose a variation</summary>
      <form className="card-inset stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void a.run(async () => {
        const r = await call(`/v1/orders/${c.orderId}/variations`, { idempotencyKey: newKey(), body: {
          title: String(f.get('title')), description: String(f.get('description')), reason: String(f.get('reason')),
          costImpact: String(f.get('cost') || '') || undefined, timeImpactDays: f.get('time') ? Number(f.get('time')) : undefined, submit: provider,
        } });
        form.reset();
        return r.state === 'under_review' ? 'Sent to the client for a decision.' : 'Proposed. The supplier prices it before you decide.';
      }); }}>
        <p className="small muted" style={{ margin: 0 }}>{provider ? 'Price the change. It goes to the project owner for a decision.' : 'Describe the change. The supplier prices it, then you approve or reject it.'}</p>
        <div><label htmlFor="vp-title">Variation</label><input id="vp-title" name="title" required minLength={3} maxLength={160} /></div>
        <div><label htmlFor="vp-desc">Change in scope</label><textarea id="vp-desc" name="description" required minLength={10} maxLength={4000} rows={2} /></div>
        <div><label htmlFor="vp-reason">Why it is needed</label><input id="vp-reason" name="reason" required minLength={5} maxLength={1000} /></div>
        <div className="row">
          <div><label htmlFor="vp-cost">Cost impact {provider ? '' : <span className="hint">Optional, your estimate</span>}</label><input id="vp-cost" name="cost" inputMode="decimal" required={provider} placeholder="e.g. 90000 or -20000" /></div>
          <div><label htmlFor="vp-time">Time impact (days)</label><input id="vp-time" name="time" inputMode="numeric" required={provider} defaultValue={provider ? '0' : ''} /></div>
        </div>
        <div><button type="submit" className="btn btn-small btn-primary" disabled={a.busy}>{provider ? 'Send variation for decision' : 'Propose variation'}</button></div>
        {a.status}
      </form>
    </details>
  );
}
