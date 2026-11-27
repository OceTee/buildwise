'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, errorText, newKey } from '@/lib/client';

/**
 * R3 slice 3 on an order page, for both sides: supplier cases (a contested discrepancy or a disputed order becomes a
 * case BuildWise staff decide; one appeal) and the two-sided transaction review. What each side may do comes from the
 * API (`canMessage`, `canAppeal`, `canReview`, ...).
 */

type Any = any;

export const CASE_PILL: Record<string, string> = {
  open: 'pill-warn', triaged: 'pill-warn', awaiting_party: 'pill-bad', under_investigation: 'pill-warn', proposed_resolution: 'pill-warn',
  resolved: 'pill-good', appealed: 'pill-warn', under_appeal_review: 'pill-warn', final: 'pill-good',
};
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '');
const H = ({ id, children }: { id: string; children: React.ReactNode }) => <h2 id={id} style={{ fontSize: '1.1rem', margin: 0 }}>{children}</h2>;

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

// ---------------------------------------------------------------- cases
export function CasesPanel({ data, orderId }: { data: Any; orderId: string }) {
  return (
    <section id="cases" className="stack-sm" aria-labelledby="cases-h">
      <H id="cases-h">Cases</H>
      <p className="small muted" style={{ margin: 0 }}>
        A contested discrepancy or a disputed order becomes a case that BuildWise staff review with both sides. Staff do not assess structural safety.
      </p>
      {data.items.length === 0 && <p className="small muted" style={{ margin: 0 }}>No cases on this order.</p>}
      {data.items.map((c: Any) => <CaseCard key={c.id} c={c} />)}
      {data.canRaise && <RaiseCase data={data} orderId={orderId} />}
    </section>
  );
}

export function CaseSummary({ c }: { c: Any }) {
  return (
    <>
      <div className="inline">
        <span className={`pill ${CASE_PILL[c.state] ?? ''}`}>{c.stateLabel}</span>
        <span className={`pill ${c.severity === 'S1' ? 'pill-bad' : ''}`}>{c.severityLabel}</span>
        <span className="small muted">{c.typeLabel} · opened {when(c.openedAt)} by the {c.raisedSide === 'client' ? 'client' : 'supplier'}</span>
      </div>
      {c.safety && c.emergencyMessage && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}><strong>Safety:</strong> {c.emergencyMessage}</p>}
      <p style={{ margin: 0 }}>{c.summary}</p>
      {c.discrepancy && (
        <p className="small" style={{ margin: 0 }}>
          {c.discrepancy.delivery}: {c.discrepancy.kindLabel}, {c.discrepancy.description}, {c.discrepancy.quantity} {c.discrepancy.unit}.
          {c.discrepancy.note ? ` Client: ${c.discrepancy.note}.` : ''}{c.discrepancy.supplierResponse ? ` Supplier: ${c.discrepancy.supplierResponse}.` : ''}
        </p>
      )}
      {!c.firstResponseAt && c.responseDueAt && c.state !== 'final' && (
        <p className="small" style={{ margin: 0 }}>First response from BuildWise due by {when(c.responseDueAt)}{c.responseOverdue ? ' (overdue)' : ''}.</p>
      )}
      {c.proposal && !c.decision && <p className="small notice" style={{ margin: 0 }}><strong>Proposed resolution:</strong> {c.proposal.text}</p>}
      {c.decision && (
        <div className="notice small" style={{ margin: 0 }}>
          <strong>Decision:</strong> {c.decision.label}. {c.decision.note} <span className="muted">({when(c.decision.at)})</span>
          {c.appeal && <div><strong>Appeal by the {c.appeal.side === 'client' ? 'client' : 'supplier'}:</strong> {c.appeal.statement}</div>}
          {c.appeal?.outcome && <div><strong>Appeal decision:</strong> {c.appeal.outcome === 'upheld' ? 'The original decision stands.' : `Overturned. ${c.appeal.newOutcomeLabel}.`} {c.appeal.note}</div>}
          {c.state === 'final' && <div><strong>Outcome that stands:</strong> {c.standingOutcomeLabel}. This decision is final.</div>}
        </div>
      )}
    </>
  );
}

type Run = ReturnType<typeof useRun>;

function CaseCard({ c }: { c: Any }) {
  // One status for the card: the form that sent it may disappear once the case moves on.
  const a = useRun();
  return (
    <article className="card stack-sm" aria-labelledby={`case-${c.id}`}>
      <h3 id={`case-${c.id}`} style={{ fontSize: '1rem', margin: 0 }}>Case {c.reference}</h3>
      <CaseSummary c={c} />
      {c.awaitingYou && <p className="notice small" style={{ margin: 0 }}><strong>BuildWise is waiting for your reply.</strong> Answer below.</p>}
      <details>
        <summary>Case log ({c.messages.length})</summary>
        <ol className="plain stack-sm" style={{ marginTop: '.5rem' }}>
          {c.messages.map((m: Any) => (
            <li key={m.id} className="small"><strong>{m.role === 'client' ? 'Client' : m.role === 'provider' ? 'Supplier' : m.author}</strong> <span className="muted">{when(m.at)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div></li>
          ))}
        </ol>
      </details>
      {c.evidence.length > 0 && (
        <div className="small"><strong>Evidence:</strong>
          <ul style={{ margin: '.25rem 0 0' }}>{c.evidence.map((e: Any) => <li key={e.id}>{e.documentTitle} (rev {e.revision}, {e.fileName}){e.note ? `: ${e.note}` : ''}</li>)}</ul>
        </div>
      )}
      {c.canMessage && <CaseMessage c={c} a={a} />}
      {c.canAddEvidence && <AddEvidence c={c} a={a} />}
      {c.canAppeal && <Appeal c={c} a={a} />}
      {a.status}
      {c.decision && !c.canAppeal && c.state === 'resolved' && c.appealProblems?.[0] && <p className="small muted" style={{ margin: 0 }}>{c.appealProblems[0]}</p>}
      <p className="small muted" style={{ margin: 0 }}>{c.notice}</p>
    </article>
  );
}

function CaseMessage({ c, a }: { c: Any; a: Run }) {
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const fd = new FormData(form); void a.run(async () => {
      await call(`/v1/cases/${c.id}/messages`, { body: { body: String(fd.get('body')) } }); form.reset(); return 'Message sent to BuildWise.';
    }); }}>
      <label htmlFor={`cm-${c.id}`}>Message to BuildWise about {c.reference} <span className="hint">Both sides and BuildWise staff see it. No phone numbers.</span></label>
      <textarea id={`cm-${c.id}`} name="body" rows={2} required minLength={2} maxLength={4000} />
      <div><button className="btn btn-small" type="submit" disabled={a.busy}>Send message</button></div>
    </form>
  );
}

function AddEvidence({ c, a }: { c: Any; a: Run }) {
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/cases/${c.id}/evidence`, { body: { revisionId: String(fd.get('revisionId')), note: String(fd.get('note') || '') || undefined } }); return 'Evidence attached.';
    }); }}>
      <div className="row">
        <div><label htmlFor={`ev-${c.id}`}>Project document to attach</label><select id={`ev-${c.id}`} name="revisionId">{c.evidenceOptions.map((o: Any) => <option key={o.revisionId} value={o.revisionId}>{o.label}</option>)}</select></div>
        <div><label htmlFor={`evn-${c.id}`}>What it shows <span className="hint">Optional</span></label><input id={`evn-${c.id}`} name="note" maxLength={500} /></div>
      </div>
      <div><button className="btn btn-small" type="submit" disabled={a.busy}>Attach evidence</button></div>
    </form>
  );
}

function Appeal({ c, a }: { c: Any; a: Run }) {
  return (
    <details>
      <summary>Appeal this decision</summary>
      <form className="stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
        await call(`/v1/cases/${c.id}/appeal`, { body: { statement: String(fd.get('statement')), expectedVersion: c.version } }); return 'Appeal sent. A different staff member will review it.';
      }); }}>
        <p className="small muted" style={{ margin: 0 }}>You can appeal once{c.appealOpenUntil ? `, until ${when(c.appealOpenUntil)}` : ''}. A staff member who did not make the decision reviews it.</p>
        <label htmlFor={`ap-${c.id}`}>Why the decision should change</label>
        <textarea id={`ap-${c.id}`} name="statement" rows={3} required minLength={10} maxLength={2000} />
        <div><button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Send appeal</button></div>
      </form>
    </details>
  );
}

function RaiseCase({ data, orderId }: { data: Any; orderId: string }) {
  const a = useRun();
  const [type, setType] = useState<string>(data.types[0]?.value ?? 'non_delivery');
  const safety = data.types.find((t: Any) => t.value === type)?.safety;
  return (
    <details className="card">
      <summary>Raise a case with BuildWise</summary>
      <form className="stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
        const r = await call<{ reference: string }>(`/v1/orders/${orderId}/cases`, { idempotencyKey: newKey(), body: { type, summary: String(fd.get('summary')), discrepancyId: String(fd.get('discrepancyId') || '') || undefined } });
        return `Case ${r.reference} opened. BuildWise staff will reply by the time shown.`;
      }); }}>
        <div className="row">
          <div><label htmlFor="rc-type">What happened</label><select id="rc-type" value={type} onChange={(e) => setType(e.target.value)}>{data.types.map((t: Any) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
          {data.openDiscrepancies.length > 0 && (
            <div><label htmlFor="rc-disc">About a discrepancy <span className="hint">Optional</span></label><select id="rc-disc" name="discrepancyId" defaultValue=""><option value="">Not about one discrepancy</option>{data.openDiscrepancies.map((d: Any) => <option key={d.id} value={d.id}>{d.label}</option>)}</select></div>
          )}
        </div>
        {safety && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}><strong>Safety:</strong> {data.emergencyMessage}</p>}
        <label htmlFor="rc-summary">Describe it <span className="hint">What, where and when. No phone numbers.</span></label>
        <textarea id="rc-summary" name="summary" rows={3} required minLength={10} maxLength={2000} />
        <div><button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Raise case</button></div>
        {a.status}
      </form>
    </details>
  );
}

// ---------------------------------------------------------------- reviews
const Stars = ({ n }: { n: number }) => <span aria-label={`${n} out of 5`}>{'★'.repeat(Math.round(n))}{'☆'.repeat(5 - Math.round(n))} {n.toFixed(1)}</span>;

export function ReviewsPanel({ data, orderId }: { data: Any; orderId: string }) {
  const a = useRun();
  return (
    <section id="reviews" className="stack-sm" aria-labelledby="reviews-h">
      <H id="reviews-h">Reviews</H>
      <p className="small muted" style={{ margin: 0 }}>{data.notice}</p>
      {data.mine && <ReviewCard title="Your review" r={data.mine} />}
      {data.theirs && <ReviewCard title={`Review from the ${data.side === 'client' ? 'supplier' : 'client'}`} r={data.theirs} canReply={data.theirs.canReply} maxReply={data.maxReplyChars} a={a} />}
      {data.theirsWaitingText && <p className="small notice" style={{ margin: 0 }}>{data.theirsWaitingText}</p>}
      {data.canReview ? <WriteReview data={data} orderId={orderId} a={a} /> : !data.mine && data.reason && <p className="small muted" style={{ margin: 0 }}>{data.reason}</p>}
      {a.status}
    </section>
  );
}

function ReviewCard({ title, r, canReply, maxReply, a }: { title: string; r: Any; canReply?: boolean; maxReply?: number; a?: Run }) {
  return (
    <article className="card stack-sm" aria-label={title}>
      <div className="inline"><strong>{title}</strong> <Stars n={r.overall} />{r.held && <span className="pill pill-warn">Waiting for a moderator</span>}{r.removed && <span className="pill pill-bad">Removed: {r.removed.reason}</span>}</div>
      <ul className="plain small inline">{r.ratings.map((x: Any) => <li key={x.key}>{x.label}: {x.value}/5</li>)}</ul>
      <p style={{ margin: 0 }}>{r.body}</p>
      {r.reply && <p className="small" style={{ margin: 0, paddingLeft: '.75rem', borderLeft: '3px solid var(--border)' }}><strong>Reply:</strong> {r.reply.body}</p>}
      {canReply && a && <Reply id={r.id} max={maxReply ?? 1000} a={a} />}
    </article>
  );
}

function Reply({ id, max, a }: { id: string; max: number; a: Run }) {
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/transaction-reviews/${id}/reply`, { body: { body: String(fd.get('body')) } }); return 'Reply published.';
    }); }}>
      <label htmlFor={`rp-${id}`}>Your public reply <span className="hint">You can reply once.</span></label>
      <textarea id={`rp-${id}`} name="body" rows={2} required minLength={2} maxLength={max} />
      <div><button className="btn btn-small" type="submit" disabled={a.busy}>Publish reply</button></div>
    </form>
  );
}

function WriteReview({ data, orderId, a }: { data: Any; orderId: string; a: Run }) {
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
      const ratings = Object.fromEntries(data.dimensions.map((d: Any) => [d.key, Number(fd.get(`rate-${d.key}`))]));
      const r = await call<{ message: string }>(`/v1/orders/${orderId}/reviews`, { idempotencyKey: newKey(), body: { ratings, body: String(fd.get('body')) } });
      return r.message;
    }); }}>
      <strong>Review {data.reviewsSubject}</strong>
      <p className="small muted" style={{ margin: 0 }}>Once each, until {when(data.closesAt)}. The other side sees your review after they have written theirs, or when reviews close.</p>
      <div className="row">
        {data.dimensions.map((d: Any) => (
          <div key={d.key}><label htmlFor={`rate-${d.key}`}>{d.label}</label>
            <select id={`rate-${d.key}`} name={`rate-${d.key}`} defaultValue="5">{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n} {n === 5 ? '(excellent)' : n === 1 ? '(poor)' : ''}</option>)}</select></div>
        ))}
      </div>
      <label htmlFor="rv-body">Your review <span className="hint">About this order. No phone numbers or personal details.</span></label>
      <textarea id="rv-body" name="body" rows={3} required minLength={data.minBodyChars} maxLength={data.maxBodyChars} />
      <div><button className="btn btn-primary" type="submit" disabled={a.busy}>Submit review</button></div>
    </form>
  );
}
