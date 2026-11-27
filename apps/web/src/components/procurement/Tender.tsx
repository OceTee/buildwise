'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatMoney } from '@bw/domain';
import { call, errorText, newKey } from '@/lib/client';

/**
 * Sealed tenders for trade packages (R3 last slice, spec §10.5): the package, shared clarifications, the bid opening
 * at the deadline and its register, named suppliers, and the evaluation on the comparison page. Bid prices are never
 * sent to the browser before the opening exists; these controls only show what the API returns.
 */

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '');

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

// ---------------------------------------------------------------- package
export function TenderPackage({ rfqId, pkg }: { rfqId: string; pkg: any }) {
  const a = useRun();
  if (!pkg) return null;
  const open = (revisionId: string) => a.run(async () => { const r = await call<{ url: string }>(`/v1/rfqs/${rfqId}/documents/${revisionId}/link`, { body: {} }); window.location.href = `/api${r.url}`; });
  return (
    <section aria-labelledby="pkg-h" className="card stack-sm">
      <h2 id="pkg-h" style={{ fontSize: '1.05rem', margin: 0 }}>Trade package</h2>
      <p className="small" style={{ margin: 0, whiteSpace: 'pre-line' }}>{pkg.scope}</p>
      <dl className="facts small">
        {(pkg.startDate || pkg.finishDate) && (<><dt>Programme</dt><dd>{pkg.startDate ?? '—'} to {pkg.finishDate ?? '—'}</dd></>)}
        <dt>Site visit</dt><dd>{pkg.siteVisitRequired ? `Required before bidding. ${pkg.siteVisitNote ?? ''}` : 'Not required'}</dd>
        {pkg.conditions && (<><dt>Conditions</dt><dd>{pkg.conditions}</dd></>)}
        <dt>Retention</dt><dd>{pkg.retentionPct}% of each milestone, released at the end of the defects period</dd>
        {pkg.requiredChecks.length > 0 && (<><dt>Checks bidders need</dt><dd>{pkg.requiredChecks.join(', ').replace(/_/g, ' ')}</dd></>)}
        <dt>Bids must include</dt><dd>Priced bill of quantities, {pkg.responseFieldLabels.map((f: any) => f.label.toLowerCase()).join(', ')}, and a conflict-of-interest declaration</dd>
      </dl>
      {pkg.documents.length > 0 && (
        <div className="small"><strong>Scope documents</strong>
          <ul style={{ margin: '.25rem 0 0' }}>{pkg.documents.map((d: any) => (
            <li key={d.revisionId}>{d.title}, revision {d.revision} <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => open(d.revisionId)}>Download <span className="sr-only">{d.title}</span></button></li>
          ))}</ul>
        </div>
      )}
      {a.status}
    </section>
  );
}

// ---------------------------------------------------------------- clarifications shared with every bidder
export function TenderClarifications({ rfq }: { rfq: any }) {
  const t = rfq.tender;
  const a = useRun();
  const client = rfq.side === 'client';
  return (
    <section aria-labelledby="tc-h" className="stack-sm">
      <h2 id="tc-h" style={{ fontSize: '1.05rem', margin: 0 }}>Clarifications</h2>
      <p className="small muted" style={{ margin: 0 }}>{client ? 'Every answer goes to all bidders. Bidders never see who asked.' : `Every answer goes to all bidders, without saying who asked. Questions close ${t.questionCutoffHours} hours before the deadline.`}</p>
      {t.clarifications.length === 0 && <p className="small muted" style={{ margin: 0 }}>No clarifications yet.</p>}
      <ul className="plain stack-sm">
        {t.clarifications.map((c: any) => <ClarificationItem key={c.id} c={c} canAnswer={client && t.canAnswer} />)}
      </ul>
      {!client && t.canAsk && (
        <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void a.run(async () => { await call(`/v1/rfqs/${rfq.id}/clarifications`, { idempotencyKey: newKey(), body: { question: String(f.get('q')) } }); form.reset(); return 'Question sent. The answer will go to every bidder.'; }); }}>
          <label htmlFor="tq">Ask a question about the package</label>
          <textarea id="tq" name="q" rows={2} required minLength={5} maxLength={2000} />
          <div><button type="submit" className="btn btn-small" disabled={a.busy}>Send question</button></div>
        </form>
      )}
      {!client && !t.canAsk && t.questionBlocker && <p className="small muted" style={{ margin: 0 }}>{t.questionBlocker}</p>}
      {client && t.canAnswer && (
        <details><summary className="small">Publish a clarification to every bidder</summary>
          <form className="stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void a.run(async () => {
            const r = await call(`/v1/rfqs/${rfq.id}/clarifications`, { idempotencyKey: newKey(), body: { question: String(f.get('subject')), answer: String(f.get('text')) } });
            form.reset();
            return r.warning ?? 'Published to every bidder.';
          }); }}>
            <label htmlFor="tn-subject">Subject</label><input id="tn-subject" name="subject" required minLength={5} maxLength={200} placeholder="e.g. Addendum 1: site access" />
            <label htmlFor="tn-text">Clarification</label><textarea id="tn-text" name="text" rows={2} required minLength={2} maxLength={4000} />
            <div><button type="submit" className="btn btn-small" disabled={a.busy}>Publish</button></div>
          </form>
        </details>
      )}
      {a.status}
    </section>
  );
}

function ClarificationItem({ c, canAnswer }: { c: any; canAnswer: boolean }) {
  const a = useRun();
  const [answer, setAnswer] = useState('');
  return (
    <li className="card-inset small stack-sm">
      <span><strong>{c.fromClient ? 'Notice from the client' : 'Question'}</strong>{c.askedBy ? ` from ${c.askedBy}` : c.mine ? ' (yours)' : ''} · {when(c.createdAt)}</span>
      <p style={{ margin: 0 }}>{c.question}</p>
      {c.answer ? <p style={{ margin: 0 }}><strong>{c.fromClient ? '' : 'Answer: '}</strong>{c.answer} <span className="muted">· {when(c.answeredAt)}</span></p> : <p className="muted" style={{ margin: 0 }}>Not answered yet.</p>}
      {!c.answer && canAnswer && (
        <div className="stack-sm">
          <label htmlFor={`ta-${c.id}`}>Answer for every bidder</label>
          <textarea id={`ta-${c.id}`} rows={2} value={answer} onChange={(e) => setAnswer(e.target.value)} maxLength={4000} />
          <div><button type="button" className="btn btn-small" disabled={a.busy || answer.trim().length < 2} onClick={() => a.run(async () => { const r = await call(`/v1/tender-clarifications/${c.id}/answer`, { body: { answer } }); return r.warning ?? 'Answer published to every bidder.'; })}>Publish answer</button></div>
        </div>
      )}
      {a.status}
    </li>
  );
}

// ---------------------------------------------------------------- opening at the deadline
export function OpenBids({ rfq }: { rfq: any }) {
  const a = useRun();
  const t = rfq.tender;
  if (t.opening) return null;
  return (
    <section aria-labelledby="ob-h" className="card stack-sm">
      <h2 id="ob-h" style={{ fontSize: '1.05rem', margin: 0 }}>Bid opening</h2>
      <p className="small" style={{ margin: 0 }}>Bids stay sealed until {when(rfq.deadline)}. Then they are opened together, once, and an opening record lists every bid with the fingerprint of what was submitted. If nobody opens them, BuildWise does at the deadline.</p>
      {t.canOpen ? <div><button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => a.run(async () => { const r = await call(`/v1/rfqs/${rfq.id}/open`, { idempotencyKey: newKey(), body: { expectedVersion: rfq.version } }); return r.opening.note; })}>Open the bids</button></div>
        : <p className="small muted" style={{ margin: 0 }}>{t.openingBlocker}</p>}
      {a.status}
    </section>
  );
}

export function OpeningRegister({ opening, currency }: { opening: any; currency: string }) {
  if (!opening) return null;
  const r = opening.record;
  return (
    <section aria-labelledby="or-h" className="card stack-sm">
      <h2 id="or-h" style={{ fontSize: '1.05rem', margin: 0 }}>Opening record</h2>
      <p className="small" style={{ margin: 0 }}>{r.note} Opened {when(opening.openedAt)} by {r.openedBy === 'system' ? 'BuildWise at the deadline' : 'the client'}; deadline {when(r.deadline)}.</p>
      {r.bids.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Bids opened</caption>
            <thead><tr><th scope="col">Bidder</th><th scope="col">Submitted</th><th scope="col" className="num">Total</th><th scope="col">Fingerprint</th></tr></thead>
            <tbody>{r.bids.map((b: any) => (
              <tr key={b.quoteVersionId}><th scope="row" style={{ fontWeight: 'normal' }}>{b.providerName} <span className="small muted">v{b.versionNumber}</span></th><td className="small">{when(b.submittedAt)}</td><td className="num">{formatMoney({ amountMinor: b.grossMinor, currency }, 'en-NG')}</td><td className="small"><code style={{ wordBreak: 'break-all' }}>{b.snapshotHash.slice(0, 16)}</code></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {(r.withdrawn.length > 0 || r.declined.length > 0 || r.noResponse.length > 0) && (
        <p className="small muted" style={{ margin: 0 }}>
          {r.withdrawn.length > 0 && `Withdrawn: ${r.withdrawn.map((x: any) => x.providerName).join(', ')}. `}
          {r.declined.length > 0 && `Declined: ${r.declined.map((x: any) => x.providerName).join(', ')}. `}
          {r.noResponse.length > 0 && `No bid: ${r.noResponse.map((x: any) => x.providerName).join(', ')}.`}
        </p>
      )}
      <p className="small muted" style={{ margin: 0 }}>Record fingerprint (SHA-256): <code style={{ wordBreak: 'break-all' }}>{opening.recordHash}</code></p>
    </section>
  );
}

// ---------------------------------------------------------------- suppliers the client names
export function Nominations({ rfq }: { rfq: any }) {
  const a = useRun();
  const [handles, setHandles] = useState('');
  const named: any[] = rfq.sourcing?.nominated ?? [];
  return (
    <section aria-labelledby="nom-h" className="card stack-sm">
      <h2 id="nom-h" style={{ fontSize: '1.05rem', margin: 0 }}>Suppliers you name</h2>
      <p className="small muted" style={{ margin: 0 }}>Name suppliers by the handle at the end of their profile address (/seller/<em>handle</em>). They still need the required checks and must not be on your blocked or conflict lists.</p>
      {named.length > 0 ? <ul className="small" style={{ margin: 0 }}>{named.map((n) => <li key={n.orgId}>{n.name} <span className="muted">@{n.handle}</span></li>)}</ul> : <p className="small muted" style={{ margin: 0 }}>Nobody named yet.</p>}
      <div className="inline">
        <label htmlFor="nom-handles" className="sr-only">Supplier handles, separated by commas</label>
        <input id="nom-handles" value={handles} onChange={(e) => setHandles(e.target.value)} placeholder="handle-one, handle-two" style={{ width: 'auto', flex: 1 }} />
        <button type="button" className="btn btn-small" disabled={a.busy || !handles.trim()} onClick={() => a.run(async () => {
          const r = await call(`/v1/rfqs/${rfq.id}/nominations`, { body: { handles: handles.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean) } });
          setHandles('');
          return `${r.nominated} supplier${r.nominated === 1 ? '' : 's'} named.${r.invited?.length ? ` ${r.invited.length} invited.` : ''}${r.refused?.length ? ` Not eligible: ${r.refused.map((x: any) => `${x.name} (${x.reasons.join(' ')})`).join('; ')}` : ''}`;
        })}>Name suppliers</button>
      </div>
      {a.status}
    </section>
  );
}

// ---------------------------------------------------------------- evaluation (comparison page)
export function TenderEvaluation({ rfqId, t, columns }: { rfqId: string; t: any; columns: any[] }) {
  const a = useRun();
  const [conflict, setConflict] = useState<'no' | 'yes'>('no');
  const [details, setDetails] = useState('');
  const ev = t.evaluation;
  const canScore = t.canEvaluate && t.myDeclaration && !t.myDeclaration.conflict;
  return (
    <section aria-labelledby="ev-h" className="stack-sm">
      <h2 id="ev-h" style={{ fontSize: '1.05rem', margin: 0 }}>Bid responses and evaluation</h2>
      <p className="small muted" style={{ margin: 0 }}>Price counts {Math.round(ev.priceWeight * 100)}% (only among bids that price the same scope), {ev.criteria.map((c: any) => `${c.label.toLowerCase()} ${Math.round(c.weight * 100)}%`).join(', ')}. Scores run 0 to {ev.scoreScale}. {ev.note}</p>
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table>
          <caption className="sr-only">Bid responses and scores</caption>
          <thead><tr><th scope="col">Bidder</th><th scope="col">Programme</th><th scope="col">Method and inclusions</th><th scope="col">Notes</th><th scope="col" className="num">Price score</th><th scope="col" className="num">Total</th></tr></thead>
          <tbody>{t.responses.map((r: any) => {
            const b = ev.bids.find((x: any) => x.quoteId === r.quoteId);
            const x = r.response ?? {};
            return (
              <tr key={r.quoteId}>
                <th scope="row" style={{ fontWeight: 'normal' }}>{r.providerName}{b?.rank ? <div><span className="pill pill-good">Rank {b.rank}</span></div> : null}</th>
                <td className="small">{x.startDate ? `From ${x.startDate}` : '—'}{x.programmeWeeks ? `, ${x.programmeWeeks} weeks` : ''}{x.staffing ? <div>{x.staffing}</div> : null}</td>
                <td className="small">{x.method ?? '—'}{x.inclusions?.length ? <div><strong>Includes:</strong> {x.inclusions.join('; ')}</div> : null}{x.defectsTerms ? <div><strong>Defects:</strong> {x.defectsTerms}</div> : null}{x.exceptions?.length ? <div><strong>Exceptions:</strong> {x.exceptions.join('; ')}</div> : null}</td>
                <td className="small">{[...r.notes, ...(b?.notes ?? [])].join(' ') || '—'}{x.conflict?.declared && <div className="notice notice-warn">Conflict declared: {x.conflict.details}</div>}</td>
                <td className="num">{b?.priceScore != null ? Math.round(b.priceScore * 100) : '—'}</td>
                <td className="num">{b?.total != null ? Math.round(b.total * 100) : '—'}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {t.declarations.length > 0 && <p className="small" style={{ margin: 0 }}><strong>Evaluators&apos; declarations:</strong> {t.declarations.map((d: any) => `${d.name}: ${d.conflict ? `conflict declared (${d.details}), not scoring` : 'no conflict'}`).join('; ')}</p>}
      {t.canEvaluate && !t.myDeclaration && (
        <fieldset className="card-inset stack-sm">
          <legend><strong>Declare your interests before you score</strong></legend>
          <div className="inline">
            <input type="radio" id="dec-no" name="dec" checked={conflict === 'no'} onChange={() => setConflict('no')} style={{ width: 'auto' }} /><label htmlFor="dec-no" style={{ margin: 0 }}>I have no conflict of interest with any bidder</label>
          </div>
          <div className="inline">
            <input type="radio" id="dec-yes" name="dec" checked={conflict === 'yes'} onChange={() => setConflict('yes')} style={{ width: 'auto' }} /><label htmlFor="dec-yes" style={{ margin: 0 }}>I have a conflict of interest</label>
          </div>
          {conflict === 'yes' && (<><label htmlFor="dec-details">Describe it (recorded; you will not score)</label><input id="dec-details" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} /></>)}
          <div><button type="button" className="btn btn-small" disabled={a.busy || (conflict === 'yes' && details.trim().length < 5)} onClick={() => a.run(async () => { await call(`/v1/rfqs/${rfqId}/declaration`, { body: { conflict: conflict === 'yes', details: conflict === 'yes' ? details : undefined } }); return 'Declaration recorded.'; })}>Record declaration</button></div>
        </fieldset>
      )}
      {canScore && columns.map((col) => <ScoreForm key={col.quoteId} rfqId={rfqId} col={col} criteria={ev.criteria} scale={ev.scoreScale} mine={t.myScores.filter((s: any) => s.quoteId === col.quoteId)} />)}
      {a.status}
    </section>
  );
}

function ScoreForm({ rfqId, col, criteria, scale, mine }: { rfqId: string; col: any; criteria: any[]; scale: number; mine: any[] }) {
  const a = useRun();
  return (
    <form className="card-inset stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/rfqs/${rfqId}/scores`, { method: 'PUT', body: { quoteId: col.quoteId, scores: criteria.map((c) => ({ criterion: c.key, score: Number(f.get(c.key)) })) } });
      return `Scores saved for ${col.providerName}.`;
    }); }}>
      <strong className="small">Your scores for {col.providerName}</strong>
      <div className="row">
        {criteria.map((c) => (
          <div key={c.key}><label htmlFor={`sc-${col.quoteId}-${c.key}`}>{c.label} <span className="sr-only">for {col.providerName}</span></label>
            <select id={`sc-${col.quoteId}-${c.key}`} name={c.key} defaultValue={String(mine.find((m) => m.criterion === c.key)?.score ?? Math.ceil(scale / 2))}>
              {Array.from({ length: scale + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
            </select>
          </div>
        ))}
      </div>
      <div><button type="submit" className="btn btn-small" disabled={a.busy}>Save scores <span className="sr-only">for {col.providerName}</span></button></div>
      {a.status}
    </form>
  );
}

// ---------------------------------------------------------------- bid response fields inside the quote form
export function TenderResponseFields({ response, pkg }: { response: any; pkg: any }) {
  const r = response ?? {};
  const need = new Set<string>(pkg?.responseFields ?? []);
  const [declared, setDeclared] = useState<'no' | 'yes' | ''>(r.conflict ? (r.conflict.declared ? 'yes' : 'no') : '');
  return (
    <fieldset className="card-inset stack-sm">
      <legend><strong>Your tender response</strong> <span className="small muted">· fixed with the bid when you submit</span></legend>
      <div className="row">
        <div><label htmlFor="tr-start">Start date {!need.has('programme') && <span className="hint">Optional</span>}</label><input id="tr-start" name="tr-start" type="date" defaultValue={r.startDate ?? pkg?.startDate ?? ''} /></div>
        <div><label htmlFor="tr-weeks">Programme (weeks) {!need.has('programme') && <span className="hint">Optional</span>}</label><input id="tr-weeks" name="tr-weeks" inputMode="numeric" defaultValue={r.programmeWeeks ?? ''} /></div>
      </div>
      <div><label htmlFor="tr-method">Method statement {!need.has('method') && <span className="hint">Optional</span>}</label><textarea id="tr-method" name="tr-method" rows={3} maxLength={5000} defaultValue={r.method ?? ''} /></div>
      {need.has('staffing') && <div><label htmlFor="tr-staff">Staffing</label><textarea id="tr-staff" name="tr-staff" rows={2} maxLength={2000} defaultValue={r.staffing ?? ''} /></div>}
      <div><label htmlFor="tr-incl">Inclusions <span className="hint">One per line</span></label><textarea id="tr-incl" name="tr-incl" rows={2} defaultValue={(r.inclusions ?? []).join('\n')} /></div>
      {need.has('qualifications') && <div><label htmlFor="tr-qual">Qualifications and references</label><textarea id="tr-qual" name="tr-qual" rows={2} maxLength={3000} defaultValue={r.qualifications ?? ''} /></div>}
      {need.has('defects') && <div><label htmlFor="tr-def">Warranty and defects terms</label><input id="tr-def" name="tr-def" maxLength={1000} defaultValue={r.defectsTerms ?? ''} /></div>}
      <div><label htmlFor="tr-exc">Commercial exceptions <span className="hint">One per line. Optional</span></label><textarea id="tr-exc" name="tr-exc" rows={2} defaultValue={(r.exceptions ?? []).join('\n')} /></div>
      {pkg?.siteVisitRequired && <div className="inline"><input type="checkbox" id="tr-visit" name="tr-visit" defaultChecked={!!r.siteVisitConfirmed} style={{ width: 'auto' }} /><label htmlFor="tr-visit" style={{ margin: 0 }}>I visited the site</label></div>}
      <div role="radiogroup" aria-labelledby="tr-coi-l" className="stack-sm">
        <span id="tr-coi-l" className="small"><strong>Conflict of interest</strong> (required)</span>
        <div className="inline"><input type="radio" id="tr-coi-no" name="tr-coi" value="no" checked={declared === 'no'} onChange={() => setDeclared('no')} style={{ width: 'auto' }} /><label htmlFor="tr-coi-no" style={{ margin: 0 }}>We have no conflict of interest with the client or this project</label></div>
        <div className="inline"><input type="radio" id="tr-coi-yes" name="tr-coi" value="yes" checked={declared === 'yes'} onChange={() => setDeclared('yes')} style={{ width: 'auto' }} /><label htmlFor="tr-coi-yes" style={{ margin: 0 }}>We have a conflict of interest to declare</label></div>
        {declared === 'yes' && <div><label htmlFor="tr-coi-d">Describe it</label><input id="tr-coi-d" name="tr-coi-d" maxLength={1000} defaultValue={r.conflict?.details ?? ''} /></div>}
      </div>
    </fieldset>
  );
}

const lines = (v: FormDataEntryValue | null) => String(v ?? '').split('\n').map((x) => x.trim()).filter(Boolean);
/** Reads the tender response fields from the quote form. */
export function readTenderResponse(f: FormData) {
  const coi = f.get('tr-coi');
  return {
    startDate: String(f.get('tr-start') || '') || null, programmeWeeks: f.get('tr-weeks') ? Number(f.get('tr-weeks')) : null,
    method: String(f.get('tr-method') || '') || null, staffing: f.has('tr-staff') ? String(f.get('tr-staff') || '') || null : null,
    inclusions: lines(f.get('tr-incl')), qualifications: f.has('tr-qual') ? String(f.get('tr-qual') || '') || null : null,
    defectsTerms: f.has('tr-def') ? String(f.get('tr-def') || '') || null : null, exceptions: lines(f.get('tr-exc')),
    siteVisitConfirmed: f.get('tr-visit') === 'on', conflict: coi ? { declared: coi === 'yes', details: coi === 'yes' ? String(f.get('tr-coi-d') || '') || null : null } : null,
  };
}
