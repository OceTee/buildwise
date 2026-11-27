'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { call, errorText, newKey } from '@/lib/client';
import { readTenderResponse, TenderResponseFields } from './Tender';

/** Client controls for structured procurement (R3): create and run an RFQ, quote, compare, award and confirm. */

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

const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

// ---------------------------------------------------------------- client: create an RFQ
export interface RfqSources {
  estimates: { versionId: string; title: string; number: number; label: string; lines: number; usable: boolean; reason: string | null }[];
  quoteRequests: { id: string; listingTitle: string; seller: string; quantity: string; unit: string; categorySlug: string }[];
}

const FIELD_LABELS: Record<string, string> = { programme: 'Programme', staffing: 'Staffing', method: 'Method statement', inclusions: 'Inclusions', qualifications: 'Qualifications', defects: 'Warranty and defects terms', exceptions: 'Commercial exceptions' };

export function NewRfqForm({ projectId, sources, categories, modes, tenders, minResponseMinutes = null }: { projectId: string; sources: RfqSources; categories: { slug: string; name: string; parent: string | null }[]; modes: { code: string; label: string }[]; tenders?: any; minResponseMinutes?: number | null }) {
  const a = useRun();
  const [kind, setKind] = useState<'rfq' | 'tender'>('rfq');
  const [visit, setVisit] = useState(false);
  const tender = kind === 'tender';
  const usable = sources.estimates.filter((e) => e.usable);
  const blocked = sources.estimates.filter((e) => !e.usable);
  const leaf = categories.filter((c) => c.parent || !categories.some((x) => x.parent === c.slug));
  const [src, setSrc] = useState(usable[0] ? `est:${usable[0].versionId}` : sources.quoteRequests[0] ? `qr:${sources.quoteRequests[0].id}` : '');
  const qr = src.startsWith('qr:') ? sources.quoteRequests.find((q) => `qr:${q.id}` === src) : null;
  if (!usable.length && !sources.quoteRequests.length) {
    return (
      <div className="notice small">
        <strong>Nothing to request quotes for yet.</strong> Requests for quotes are made from a <em>shared client-specified</em> estimate or an <em>issued professionally reviewed</em> estimate, so suppliers price an exact scope. Indicative ranges and draft takeoffs can't be used.
        {blocked.length > 0 && <ul>{blocked.map((b) => <li key={b.versionId}>{b.title} (v{b.number}): {b.reason}</li>)}</ul>}
      </div>
    );
  }
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
      const source = String(f.get('source'));
      const r = await call<{ id: string }>(`/v1/projects/${projectId}/rfqs`, { idempotencyKey: newKey(), body: {
        title: String(f.get('title')), categorySlug: String(f.get('category')), deadline: new Date(String(f.get('deadline'))).toISOString(), sourcingMode: String(f.get('mode')),
        notes: String(f.get('notes') || '') || undefined, neededBy: String(f.get('neededBy') || '') || undefined,
        ...(source.startsWith('est:') ? { estimateVersionId: source.slice(4) } : { quoteRequestId: source.slice(3) }),
        ...(tender ? { kind: 'tender', package: {
          scope: String(f.get('scope')), siteVisitRequired: visit, siteVisitNote: visit ? String(f.get('visitNote') || '') || null : null,
          startDate: String(f.get('start') || '') || null, finishDate: String(f.get('finish') || '') || null, conditions: String(f.get('conditions') || '') || null,
          retentionPct: Number(f.get('retention') || 0), responseFields: Object.keys(FIELD_LABELS).filter((k) => f.get(`rf-${k}`) === 'on'),
        } } : {}),
      } });
      a.router.push(`/projects/${projectId}/rfqs/${r.id}`);
    }); }}>
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>{tender ? 'New sealed tender' : 'New request for quotes'}</h2>
      {tenders && (
        <div><label htmlFor="rfq-kind">Type</label>
          <select id="rfq-kind" value={kind} onChange={(e) => setKind(e.target.value as 'rfq' | 'tender')}>
            <option value="rfq">Request for quotes (materials and services)</option>
            <option value="tender">Sealed tender for a trade package</option>
          </select>
        </div>
      )}
      <div className="row">
        <div><label htmlFor="rfq-title">Title</label><input id="rfq-title" name="title" required minLength={3} maxLength={160} defaultValue={tender ? 'Blockwork and plastering package' : 'Materials for the slab'} key={kind} /></div>
        <div><label htmlFor="rfq-source">Scope</label>
          <select id="rfq-source" name="source" value={src} onChange={(e) => setSrc(e.target.value)}>
            {usable.map((e) => <option key={e.versionId} value={`est:${e.versionId}`}>{e.title} v{e.number} · {e.label} · {e.lines} lines</option>)}
            {sources.quoteRequests.map((q) => <option key={q.id} value={`qr:${q.id}`}>Quote request: {q.listingTitle} ({q.quantity} {q.unit}, {q.seller})</option>)}
          </select>
        </div>
      </div>
      <div className="row">
        <div><label htmlFor="rfq-cat">Category</label>
          <select id="rfq-cat" name="category" defaultValue={qr?.categorySlug ?? 'cement'} key={qr?.id ?? 'est'}>{leaf.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select>
        </div>
        <div><label htmlFor="rfq-deadline">{tender ? 'Bid deadline' : 'Quote deadline'}</label><input id="rfq-deadline" name="deadline" type="datetime-local" required defaultValue={localInput(new Date(Date.now() + (tender ? 14 : 7) * 86_400_000))} key={kind} /></div>
        <div><label htmlFor="rfq-needed">Needed on site by <span className="hint">Optional</span></label><input id="rfq-needed" name="neededBy" type="date" /></div>
      </div>
      <div><label htmlFor="rfq-mode">{tender ? 'Who can bid' : 'Who can quote'}</label><select id="rfq-mode" name="mode" defaultValue={tender ? 'invited' : 'open'} key={kind}>{modes.filter((m) => !tender || m.code !== 'open').map((m) => <option key={m.code} value={m.code}>{m.label}</option>)}</select></div>
      {tender && tenders && (
        <fieldset className="card-inset stack-sm">
          <legend><strong>The package</strong> <span className="small muted">· bids stay sealed until the deadline, then open together</span></legend>
          <div><label htmlFor="pk-scope">Scope of work</label><textarea id="pk-scope" name="scope" rows={3} required minLength={20} maxLength={8000} placeholder="What the trade contractor does, where, and to what standard." /></div>
          <div className="row">
            <div><label htmlFor="pk-start">Start <span className="hint">Optional</span></label><input id="pk-start" name="start" type="date" /></div>
            <div><label htmlFor="pk-finish">Finish <span className="hint">Optional</span></label><input id="pk-finish" name="finish" type="date" /></div>
            <div><label htmlFor="pk-ret">Retention %</label><input id="pk-ret" name="retention" inputMode="decimal" defaultValue={tenders.defaultRetentionPct} /></div>
          </div>
          <div className="inline"><input type="checkbox" id="pk-visit" checked={visit} onChange={(e) => setVisit(e.target.checked)} style={{ width: 'auto' }} /><label htmlFor="pk-visit" style={{ margin: 0 }}>Bidders must visit the site</label></div>
          {visit && <div><label htmlFor="pk-visit-note">How to arrange the visit</label><input id="pk-visit-note" name="visitNote" required maxLength={1000} /></div>}
          <div><label htmlFor="pk-cond">Conditions <span className="hint">Optional. Working hours, access, insurance.</span></label><textarea id="pk-cond" name="conditions" rows={2} maxLength={5000} /></div>
          <div className="small"><strong>Bids must include</strong> (as well as the priced lines and a conflict-of-interest declaration)
            <div className="inline" style={{ flexWrap: 'wrap', marginTop: '.25rem' }}>{Object.entries(FIELD_LABELS).map(([k, label]) => (
              <span key={k} className="inline"><input type="checkbox" id={`rf-${k}`} name={`rf-${k}`} defaultChecked={tenders.defaultResponseFields.includes(k)} style={{ width: 'auto' }} /><label htmlFor={`rf-${k}`} style={{ margin: 0 }}>{label}</label></span>
            ))}</div>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Bidders get {tenders.minResponseDays} to {tenders.maxResponseDays} days{minResponseMinutes != null ? ` (development: at least ${minResponseMinutes} minute${minResponseMinutes === 1 ? '' : 's'})` : ''}. Questions close {tenders.questionCutoffHours} hours before the deadline. Attach scope documents after creating the draft.</p>
        </fieldset>
      )}
      <div><label htmlFor="rfq-notes">Notes for suppliers <span className="hint">Optional. Site access, delivery times. No phone numbers: suppliers reply here.</span></label><textarea id="rfq-notes" name="notes" maxLength={2000} rows={2} /></div>
      {qr && <p className="small muted" style={{ margin: 0 }}>The seller you asked ({qr.seller}) is invited if they pass the same checks as everyone else.</p>}
      <div><button type="submit" className="btn btn-primary" disabled={a.busy}>{tender ? 'Create draft tender' : 'Create draft request'}</button></div>
      {a.status}
    </form>
  );
}

// ---------------------------------------------------------------- client: run an RFQ
export function RfqActions({ rfq }: { rfq: any }) {
  const a = useRun();
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const cmd = (c: string, body: Record<string, unknown> = {}) => a.run(async () => {
    const r = await call(`/v1/rfqs/${rfq.id}/commands/${c}`, { idempotencyKey: newKey(), body: { expectedVersion: rfq.version, ...body } });
    if (c === 'publish') return `Published. ${r.invited} ${rfq.kind === 'tender' ? 'bidder' : 'provider'}${r.invited === 1 ? '' : 's'} invited.${r.refused?.length ? ` Not invited: ${r.refused.map((x: any) => `${x.name} (${x.reasons.join(' ')})`).join('; ')}.` : ''}`;
    return undefined;
  });
  const m = rfq.lastMatch;
  const invitedIds = new Set(rfq.invitations.map((i: any) => i.providerOrgId));
  const has = (c: string) => rfq.commands.includes(c);
  return (
    <div className="stack">
      {rfq.canManage && ['draft', 'published'].includes(rfq.state) && (
        <section aria-labelledby="match-h" className="card stack-sm">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 id="match-h" style={{ fontSize: '1.05rem', margin: 0 }}>Eligible suppliers</h2>
            <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/rfqs/${rfq.id}/match`, { method: 'POST' }); })}>{m ? 'Check again' : 'Find eligible suppliers'}</button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Suppliers must list this category, serve {rfq.area.label}, be active and hold the required checks until the deadline. Your blocked and conflict lists, and conflicts of interest with your project team, keep suppliers out; preferred suppliers come first. They are then ranked by the factors shown. Promoted listings are labelled and never change who is eligible or the order.</p>
          {m && (
            <>
              {m.assistedSourcing.offered && (
                <div className="notice notice-warn small stack-sm">
                  <span>{m.assistedSourcing.message}</span>
                  {rfq.assistedSourcing ? <span><strong>Assisted sourcing requested.</strong> Operations will add suppliers that pass the same checks.</span> : (
                    <span><button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => (await call(`/v1/rfqs/${rfq.id}/assisted-sourcing`, { body: {} })).message)}>Ask operations to find more suppliers</button></span>
                  )}
                </div>
              )}
              {m.eligible.length > 0 && (
                <ol className="plain stack-sm">
                  {m.eligible.map((e: any) => (
                    <li key={e.orgId} className="card-inset stack-sm">
                      <div className="inline" style={{ justifyContent: 'space-between' }}>
                        <span className="inline">
                          {rfq.sourcingMode === 'invited' && !invitedIds.has(e.orgId) && (
                            <input type="checkbox" id={`pick-${e.orgId}`} aria-label={`Invite ${e.name}`} checked={picked.includes(e.orgId)} onChange={(ev) => setPicked(ev.target.checked ? [...picked, e.orgId] : picked.filter((x) => x !== e.orgId))} style={{ width: 'auto' }} />
                          )}
                          <strong>{e.rank}. {e.name}</strong>
                          {invitedIds.has(e.orgId) && <span className="pill pill-good">Invited</span>}
                          {e.promoted && <span className="pill pill-promo">Promoted listing</span>}
                          {(e.labels ?? []).map((l: string) => <span key={l} className="pill">{l}</span>)}
                        </span>
                        <span className="small muted">Match score {Math.round(e.score * 100)}</span>
                      </div>
                      <p className="small" style={{ margin: 0 }}>{e.why.join(' · ')}</p>
                      {e.warnings?.length > 0 && <p className="small notice notice-warn" style={{ margin: 0 }}>{e.warnings.join(' ')}</p>}
                      <details className="small"><summary>Why this provider</summary>
                        <div className="table-wrap"><table>
                          <caption className="sr-only">Ranking factors for {e.name}</caption>
                          <thead><tr><th scope="col">Factor</th><th scope="col">Detail</th><th scope="col" className="num">Score</th><th scope="col" className="num">Weight</th></tr></thead>
                          <tbody>{e.factors.map((f: any) => <tr key={f.key}><th scope="row">{f.label}</th><td>{f.detail}</td><td className="num">{Math.round(f.value * 100)}</td><td className="num">{Math.round(f.weight * 100)}%</td></tr>)}</tbody>
                        </table></div>
                      </details>
                    </li>
                  ))}
                </ol>
              )}
              {m.ineligible.length > 0 && (
                <details className="small"><summary>Not eligible ({m.ineligible.length})</summary>
                  <ul>{m.ineligible.map((x: any) => <li key={x.orgId}><strong>{x.name}</strong>: {x.reasons.join(' ')}</li>)}</ul>
                </details>
              )}
              {rfq.sourcingMode === 'invited' && picked.length > 0 && (
                <div><button type="button" className="btn btn-small btn-primary" disabled={a.busy} onClick={() => a.run(async () => { const r = await call(`/v1/rfqs/${rfq.id}/invitations`, { body: { providerOrgIds: picked } }); setPicked([]); return `${r.invited.length} invited.`; })}>Invite selected ({picked.length})</button></div>
              )}
              {rfq.sourcingMode !== 'invited' && rfq.state === 'draft' && <p className="small" style={{ margin: 0 }}>{rfq.sourcingMode === 'open' ? 'Publishing invites every eligible supplier.' : rfq.sourcingMode === 'framework' ? 'Publishing invites every eligible supplier on your approved list.' : 'Publishing invites every eligible supplier you named.'}</p>}
            </>
          )}
        </section>
      )}

      {rfq.canManage && (
        <div className="stack-sm">
          <div className="inline">
            {has('publish') && <button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => cmd('publish')}>{rfq.kind === 'tender' ? 'Publish tender' : 'Publish request'}</button>}
            {has('close') && <button type="button" className="btn" disabled={a.busy} onClick={() => cmd('close')}>Close and compare</button>}
          </div>
          {(has('cancel') || has('no_award')) && (
            <details><summary className="small">Cancel or close without an award</summary>
              <div className="stack-sm" style={{ marginTop: '.5rem' }}>
                <label htmlFor="rfq-reason">Reason (shown to suppliers)</label>
                <input id="rfq-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
                <div className="inline">
                  {has('cancel') && <button type="button" className="btn btn-small btn-danger" disabled={a.busy || reason.trim().length < 3} onClick={() => cmd('cancel', { reason })}>Cancel request</button>}
                  {has('no_award') && <button type="button" className="btn btn-small" disabled={a.busy || reason.trim().length < 3} onClick={() => cmd('no_award', { reason })}>Close without an award</button>}
                </div>
              </div>
            </details>
          )}
          {rfq.state === 'published' && <ReviseForm rfq={rfq} />}
        </div>
      )}
      {a.status}
    </div>
  );
}

function ReviseForm({ rfq }: { rfq: any }) {
  const a = useRun();
  return (
    <details><summary className="small">Change the request (creates version {rfq.versionNumber + 1})</summary>
      <form className="stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => {
        const r = await call(`/v1/rfqs/${rfq.id}/revise`, { body: { expectedVersion: rfq.version, changeReason: String(f.get('reason')), lines: [{ lineKey: String(f.get('line')), quantity: String(f.get('qty')) }] } });
        return `Version ${r.versionNumber} published. ${r.quotesNeedingRevision} quote${r.quotesNeedingRevision === 1 ? '' : 's'} now need revising.`;
      }); }}>
        <p className="small muted" style={{ margin: 0 }}>Suppliers are told what changed, and quotes already in must be revised before they can be awarded.</p>
        <div className="row">
          <div><label htmlFor="rv-line">Line</label><select id="rv-line" name="line">{rfq.lines.map((l: any) => <option key={l.lineKey} value={l.lineKey}>{l.description}</option>)}</select></div>
          <div><label htmlFor="rv-qty">New quantity</label><input id="rv-qty" name="qty" inputMode="decimal" required pattern="\d+(\.\d{1,6})?" /></div>
        </div>
        <div><label htmlFor="rv-reason">Reason for the change</label><input id="rv-reason" name="reason" required minLength={3} maxLength={500} /></div>
        <div><button type="submit" className="btn btn-small" disabled={a.busy}>Publish revision</button></div>
        {a.status}
      </form>
    </details>
  );
}

// ---------------------------------------------------------------- client: award (two-step confirm)
export function AwardButton({ rfqId, projectId, quoteVersionId, providerName, expectedVersion, blockers }: { rfqId: string; projectId: string; quoteVersionId: string; providerName: string; expectedVersion: number; blockers: string[] }) {
  const a = useRun();
  const [confirming, setConfirming] = useState(false);
  if (blockers.length) return <p className="small muted" style={{ margin: 0 }}>{blockers[0]}</p>;
  return (
    <div className="stack-sm">
      {!confirming ? <button type="button" className="btn btn-small btn-primary" onClick={() => setConfirming(true)}>Award to {providerName}</button> : (
        <>
          <p className="small" style={{ margin: 0 }}>This places a binding order on {providerName}&apos;s exact quote. Payment is arranged directly with them.</p>
          <div className="inline">
            <button type="button" className="btn btn-small btn-primary" disabled={a.busy} onClick={() => a.run(async () => {
              const r = await call<{ orderId: string }>(`/v1/rfqs/${rfqId}/award`, { idempotencyKey: newKey(), body: { quoteVersionId, expectedVersion } });
              a.router.push(`/projects/${projectId}/orders/${r.orderId}`);
            })}>Confirm award to {providerName}</button>
            <button type="button" className="btn btn-small" onClick={() => setConfirming(false)}>Back</button>
          </div>
        </>
      )}
      {a.status}
    </div>
  );
}

// ---------------------------------------------------------------- provider: quote, decline, clarify
export function StartQuote({ rfqId, label = 'Start a quote' }: { rfqId: string; label?: string }) {
  const a = useRun();
  return <div className="stack-sm"><div><button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/rfqs/${rfqId}/quotes`, { method: 'POST' }); })}>{label}</button></div>{a.status}</div>;
}

export function DeclineForm({ rfqId }: { rfqId: string }) {
  const a = useRun();
  return (
    <details><summary className="small">Decline to quote</summary>
      <form className="stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void a.run(async () => { await call(`/v1/rfqs/${rfqId}/decline`, { body: { reason: String(f.get('reason')) } }); return 'Declined. The client sees this as a no-bid with your reason.'; }); }}>
        <label htmlFor="dec-reason">Reason</label><input id="dec-reason" name="reason" required minLength={2} maxLength={500} />
        <div><button type="submit" className="btn btn-small" disabled={a.busy}>Decline</button></div>
        {a.status}
      </form>
    </details>
  );
}

export function QuoteForm({ draft, rfqLines, units, pkg = null }: { draft: any; rfqLines: any[]; units: { code: string; label: string }[]; pkg?: any }) {
  const a = useRun();
  const byKey = new Map<string, any>(draft.lines.map((l: any) => [l.rfqLineKey, l]));
  const collect = (form: HTMLFormElement) => {
    const f = new FormData(form);
    return {
      expectedVersion: draft.version,
      lines: rfqLines.map((rl, i) => {
        const sub = f.get(`sub-${i}`) === 'on';
        return {
          rfqLineKey: rl.lineKey, status: String(f.get(`status-${i}`)), unit: String(f.get(`unit-${i}`)), quantity: String(f.get(`qty-${i}`) || '0'), unitPrice: String(f.get(`price-${i}`) || '0'),
          offered: String(f.get(`offered-${i}`) || '') || null, isSubstitution: sub, substitutionNote: sub ? String(f.get(`subnote-${i}`) || '') || null : null,
          availability: String(f.get(`avail-${i}`) || '') || null, taxRatePct: Number(f.get(`tax-${i}`) || 0),
        };
      }),
      deliveryCharge: String(f.get('delivery') || '0'), deliveryTaxRatePct: Number(f.get('deliveryTax') || 0), validUntil: String(f.get('validUntil')),
      paymentTerms: String(f.get('paymentTerms') || '') || null, warranty: String(f.get('warranty') || '') || null, leadTimeDays: f.get('leadTime') ? Number(f.get('leadTime')) : null,
      exclusions: String(f.get('exclusions') || '').split('\n').map((x) => x.trim()).filter(Boolean), notes: String(f.get('notes') || '') || null,
      ...(pkg ? { tenderResponse: readTenderResponse(f) } : {}),
    };
  };
  const save = async (form: HTMLFormElement) => call<{ version: number }>(`/v1/quote-versions/${draft.id}`, { method: 'PUT', body: collect(form) });
  return (
    <form className="card stack" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null; void a.run(async () => {
      const r = await save(form);
      if (submitter?.value !== 'submit') return 'Draft saved. Only you can see it.';
      const s = await call<{ total: { display: string } }>(`/v1/quote-versions/${draft.id}/submit`, { idempotencyKey: newKey(), body: { expectedVersion: r.version } });
      return pkg ? `Bid submitted and sealed: ${s.total.display}. Nobody can read it before the deadline; you can withdraw it or bid again until then.` : `Quote submitted: ${s.total.display}. It can't be edited now; a change means a new version.`;
    }); }}>
      <h2 style={{ fontSize: '1.05rem', margin: 0 }}>Your {pkg ? 'bid' : 'quote'}, version {draft.number} (draft)</h2>
      <p className="small muted" style={{ margin: 0 }}>Price each line in the unit you sell in. Mark a different product as a substitution and say what it is. Exclude anything you can&apos;t supply.</p>
      {rfqLines.map((rl, i) => {
        const l = byKey.get(rl.lineKey) ?? {};
        const name = rl.description;
        return (
          <fieldset key={rl.lineKey} className="card-inset stack-sm">
            <legend><strong>{name}</strong> <span className="small muted">· requested {rl.quantity} {rl.unitLabel}{rl.specification ? ` · ${rl.specification}` : ''}</span></legend>
            <div className="row">
              <div><label htmlFor={`status-${i}`}>Line <span className="sr-only">status for {name}</span></label><select id={`status-${i}`} name={`status-${i}`} defaultValue={l.status ?? 'priced'}><option value="priced">Priced</option><option value="excluded">Excluded (not supplied)</option></select></div>
              <div><label htmlFor={`qty-${i}`}>Quantity <span className="sr-only">for {name}</span></label><input id={`qty-${i}`} name={`qty-${i}`} inputMode="decimal" defaultValue={l.quantity ?? rl.quantity} /></div>
              <div><label htmlFor={`unit-${i}`}>Unit <span className="sr-only">for {name}</span></label><select id={`unit-${i}`} name={`unit-${i}`} defaultValue={l.unit ?? rl.unit}>{units.map((u) => <option key={u.code} value={u.code}>{u.label}</option>)}</select></div>
              <div><label htmlFor={`price-${i}`}>Unit price <span className="sr-only">for {name}</span><span className="hint">Before tax</span></label><input id={`price-${i}`} name={`price-${i}`} inputMode="decimal" defaultValue={l.unitPrice && l.unitPrice !== '0' ? l.unitPrice : ''} /></div>
              <div><label htmlFor={`tax-${i}`}>Tax % <span className="sr-only">for {name}</span></label><input id={`tax-${i}`} name={`tax-${i}`} inputMode="decimal" defaultValue={l.taxRatePct ?? 0} /></div>
            </div>
            <div className="row">
              <div><label htmlFor={`offered-${i}`}>Brand or product <span className="sr-only">for {name}</span><span className="hint">Optional</span></label><input id={`offered-${i}`} name={`offered-${i}`} maxLength={200} defaultValue={l.offered ?? ''} /></div>
              <div><label htmlFor={`avail-${i}`}>Availability <span className="sr-only">for {name}</span><span className="hint">Optional</span></label><input id={`avail-${i}`} name={`avail-${i}`} maxLength={200} defaultValue={l.availability ?? ''} placeholder="In stock" /></div>
            </div>
            <div className="inline"><input type="checkbox" id={`sub-${i}`} name={`sub-${i}`} defaultChecked={!!l.isSubstitution} style={{ width: 'auto' }} /><label htmlFor={`sub-${i}`} style={{ margin: 0 }}>This is a substitution <span className="sr-only">for {name}</span></label></div>
            <div><label htmlFor={`subnote-${i}`}>Substitution details <span className="sr-only">for {name}</span><span className="hint">Required if substituting</span></label><input id={`subnote-${i}`} name={`subnote-${i}`} maxLength={500} defaultValue={l.substitutionNote ?? ''} /></div>
          </fieldset>
        );
      })}
      <div className="row">
        <div><label htmlFor="q-delivery">Delivery charge</label><input id="q-delivery" name="delivery" inputMode="decimal" defaultValue={draft.deliveryCharge} /></div>
        <div><label htmlFor="q-dtax">Tax on delivery %</label><input id="q-dtax" name="deliveryTax" inputMode="decimal" defaultValue={draft.deliveryTaxRatePct} /></div>
        <div><label htmlFor="q-valid">Valid until</label><input id="q-valid" name="validUntil" type="date" required defaultValue={draft.validUntil ?? ''} /></div>
        <div><label htmlFor="q-lead">Lead time (days)</label><input id="q-lead" name="leadTime" inputMode="numeric" defaultValue={draft.leadTimeDays ?? ''} /></div>
      </div>
      <div className="row">
        <div><label htmlFor="q-pay">Payment terms</label><input id="q-pay" name="paymentTerms" maxLength={300} defaultValue={draft.paymentTerms ?? ''} placeholder="e.g. 50% on order, balance on delivery" /></div>
        <div><label htmlFor="q-warranty">Warranty <span className="hint">Optional</span></label><input id="q-warranty" name="warranty" maxLength={300} defaultValue={draft.warranty ?? ''} /></div>
      </div>
      <div><label htmlFor="q-excl">Exclusions <span className="hint">One per line</span></label><textarea id="q-excl" name="exclusions" rows={2} defaultValue={(draft.exclusions ?? []).join('\n')} /></div>
      <div><label htmlFor="q-notes">Notes <span className="hint">Optional. No phone numbers or payment details.</span></label><textarea id="q-notes" name="notes" rows={2} maxLength={2000} defaultValue={draft.notes ?? ''} /></div>
      {pkg && <TenderResponseFields response={draft.tenderResponse} pkg={pkg} />}
      {draft.problems?.length > 0 && <ul className="small notice notice-warn" style={{ margin: 0, paddingLeft: '1.5rem' }}>{draft.problems.map((p: string) => <li key={p}>{p}</li>)}</ul>}
      <div className="inline">
        <button type="submit" className="btn" value="save" disabled={a.busy}>Save draft</button>
        <button type="submit" className="btn btn-primary" value="submit" disabled={a.busy}>{pkg ? 'Submit sealed bid' : 'Submit quote'}</button>
      </div>
      {a.status}
    </form>
  );
}

export function WithdrawQuote({ versionId, label = 'quote' }: { versionId: string; label?: string }) {
  const a = useRun();
  const [reason, setReason] = useState('');
  return (
    <details><summary className="small">Withdraw this {label}</summary>
      <div className="inline" style={{ marginTop: '.5rem' }}>
        <label htmlFor="wd-reason" className="sr-only">Reason for withdrawing</label>
        <input id="wd-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" style={{ width: 'auto' }} />
        <button type="button" className="btn btn-small btn-danger" disabled={a.busy || reason.trim().length < 2} onClick={() => a.run(async () => { await call(`/v1/quote-versions/${versionId}/withdraw`, { body: { reason } }); return 'Withdrawn.'; })}>Withdraw</button>
      </div>
      {a.status}
    </details>
  );
}

export function ClarificationForm({ quoteId, label }: { quoteId: string; label: string }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const f = new FormData(form); void a.run(async () => { await call(`/v1/quotes/${quoteId}/clarifications`, { body: { body: String(f.get('body')) } }); form.reset(); return 'Sent.'; }); }}>
      <label htmlFor={`clar-${quoteId}`}>{label}</label>
      <textarea id={`clar-${quoteId}`} name="body" rows={2} required minLength={2} maxLength={2000} />
      <p className="small muted" style={{ margin: 0 }}>Clarifications stay with the quote. A change to price or scope needs a new quote version.</p>
      <div><button type="submit" className="btn btn-small" disabled={a.busy}>Send</button></div>
      {a.status}
    </form>
  );
}

// ---------------------------------------------------------------- orders
export function OrderActions({ orderId, version, commands, canClose = true }: { orderId: string; version: number; commands: string[]; canClose?: boolean }) {
  const a = useRun();
  const [reason, setReason] = useState('');
  if (!commands.length) return null;
  const go = (c: string) => a.run(async () => { await call(`/v1/orders/${orderId}/commands/${c}`, { idempotencyKey: newKey(), body: { expectedVersion: version, ...(c === 'confirm' || c === 'close' ? {} : { reason }) } }); });
  return (
    <div className="stack-sm">
      {commands.includes('confirm') && <div><button type="button" className="btn btn-primary" disabled={a.busy} onClick={() => go('confirm')}>Confirm order</button></div>}
      {commands.includes('close') && <div><button type="button" className="btn btn-primary" disabled={a.busy || !canClose} onClick={() => go('close')}>Close order</button></div>}
      {commands.includes('resume') && (
        <div className="stack-sm">
          <label htmlFor="ord-resume">How the dispute was settled</label><input id="ord-resume" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          <div><button type="button" className="btn btn-small" disabled={a.busy || reason.trim().length < 3} onClick={() => go('resume')}>Resume order</button></div>
        </div>
      )}
      {(commands.includes('cancel') || commands.includes('dispute')) && (
        <details><summary className="small">Cancel or dispute</summary>
          <div className="stack-sm" style={{ marginTop: '.5rem' }}>
            <label htmlFor="ord-reason">Reason</label><input id="ord-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            <div className="inline">
              {commands.includes('cancel') && <button type="button" className="btn btn-small btn-danger" disabled={a.busy || reason.trim().length < 3} onClick={() => go('cancel')}>Cancel order</button>}
              {commands.includes('dispute') && <button type="button" className="btn btn-small" disabled={a.busy || reason.trim().length < 3} onClick={() => go('dispute')}>Raise a dispute</button>}
            </div>
          </div>
        </details>
      )}
      {a.status}
    </div>
  );
}

export function ProviderToggle({ orgId, accepts }: { orgId: string; accepts: boolean }) {
  const a = useRun();
  return (
    <div className="inline">
      <button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call('/v1/provider/profile', { method: 'PUT', body: { orgId, acceptsRfqs: !accepts } }); return accepts ? 'Paused: you will not be matched to new requests.' : 'You can be matched to requests again.'; })}>
        {accepts ? 'Pause new requests' : 'Accept requests again'}
      </button>
      {a.status}
    </div>
  );
}
