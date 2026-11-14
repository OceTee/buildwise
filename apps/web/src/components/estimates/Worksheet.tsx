'use client';
import { useCallback, useState } from 'react';
import Link from 'next/link';
import { ApiFailure, call, errorText } from '@/lib/client';
import { dateText } from '@/lib/format';
import { IndicativeCard, MaturityBanner, TotalsTable } from './Display';
import { LineEditor } from './LineEditor';
import { COMMAND_LABELS, QSOURCE_LABELS, STATUS_LABELS, statePill, type Estimate, type Line, type QaFinding, type Version } from './types';

interface Props { initial: Estimate; projectId: string; regionCode: string | null; workSections: { code: string; label: string }[]; readOnly: boolean }

const CONFIRM: Record<string, string> = {
  issue: 'Issue this version to the client? It becomes read-only and its snapshot is fixed.',
  accept: 'Accept this estimate as your budget baseline?',
  withdraw: 'Withdraw this version? The request stops and the version is closed.',
  complete_review: 'Mark the review complete? Checks are run again before it is saved.',
};
const NEEDS_MESSAGE = new Set(['request_information', 'request_changes']);

export function Worksheet({ initial, projectId, regionCode, workSections, readOnly }: Props) {
  const [est, setEst] = useState(initial);
  const [viewing, setViewing] = useState<Version>(initial.current);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; findings?: QaFinding[] } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const v = viewing;
  const isCurrent = v.id === est.current.id;
  const editable = isCurrent && v.editable && !readOnly;
  const sectionLabel = (c: string) => workSections.find((w) => w.code === c)?.label ?? c;

  const refresh = useCallback(async () => {
    const e = await call<Estimate>(`/v1/estimates/${est.id}`);
    setEst(e); setViewing(e.current);
  }, [est.id]);

  async function run(fn: () => Promise<string | void>) {
    setBusy(true); setMsg(null);
    try { const t = await fn(); await refresh(); if (t) setMsg({ ok: true, text: t }); }
    catch (e) { setMsg({ ok: false, text: errorText(e), findings: e instanceof ApiFailure ? e.details?.findings : undefined }); }
    finally { setBusy(false); }
  }

  async function viewVersion(id: string) {
    if (id === est.current.id) { setViewing(est.current); return; }
    try { setViewing(await call<Version>(`/v1/estimate-versions/${id}`)); } catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  }

  const command = (cmd: string, message?: string) => run(async () => {
    await call(`/v1/estimate-versions/${v.id}/commands/${cmd}`, { body: { expectedVersion: v.version, message } });
    setPending(null);
    return `${COMMAND_LABELS[cmd] ?? cmd}: done.`;
  });

  const bySection = new Map<string, Line[]>();
  for (const l of v.lines) bySection.set(l.section, [...(bySection.get(l.section) ?? []), l]);
  const qaFor = (lineId: string) => (v.qa ?? []).filter((f) => f.lineId === lineId);

  return (
    <div className="stack">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ margin: 0 }}>{est.title}</h1>
        {v.maturity !== 'indicative' && <Link className="btn btn-small no-print" href={`/projects/${projectId}/estimates/${est.id}/report/${v.id}`}>Customer report</Link>}
      </div>
      <MaturityBanner v={v} />
      {!isCurrent && <p className="notice small" role="status">You are looking at version {v.number}, which is not the current version. <button type="button" className="linkish" onClick={() => setViewing(est.current)}>Back to the current version</button></p>}

      {v.maturity === 'indicative' && v.indicative && <IndicativeCard i={v.indicative} projectId={projectId} />}

      {v.maturity !== 'indicative' && (
        <div className="layout-2">
          <div className="stack">
            {/* Commands */}
            {isCurrent && !readOnly && (v.commands.length > 0 || v.canShare || est.canNewVersion) && (
              <section className="card stack-sm no-print" aria-labelledby="act-h">
                <h2 id="act-h" style={{ margin: 0, fontSize: '1rem' }}>Actions</h2>
                <div className="inline">
                  {v.commands.map((c) => (
                    <button key={c} type="button" className={`btn btn-small ${c === 'issue' || c === 'accept' || c === 'submit' ? 'btn-primary' : c === 'withdraw' ? 'btn-danger' : ''}`} disabled={busy}
                      onClick={() => { if (NEEDS_MESSAGE.has(c) || CONFIRM[c]) setPending(c); else void command(c); }}>{COMMAND_LABELS[c] ?? c}</button>
                  ))}
                  {v.canShare && <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => { if (confirm('Share this version? It becomes read-only; start a new version to change it.')) void run(async () => { await call(`/v1/estimate-versions/${v.id}/share`, { method: 'POST' }); return 'Shared. This version is now fixed.'; }); }}>Share (fix this version)</button>}
                </div>
                {v.commands.includes('submit') && <p className="small muted" style={{ margin: 0 }}>A reviewer is assigned once you submit. You need at least one drawing in Documents.</p>}
                {pending && (
                  <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); const m = String(new FormData(e.currentTarget).get('m') ?? '').trim(); void command(pending, m || undefined); }}>
                    {NEEDS_MESSAGE.has(pending) ? (
                      <>
                        <label htmlFor="cmd-msg">{pending === 'request_information' ? 'What do you need from the client?' : 'What should change?'} <span className="hint">Sent as an RFI on the project</span></label>
                        <textarea id="cmd-msg" name="m" required minLength={5} maxLength={4000} />
                      </>
                    ) : <p className="small" style={{ margin: 0 }} role="alert">{CONFIRM[pending]}</p>}
                    <div className="inline">
                      <button type="submit" className="btn btn-small btn-primary" disabled={busy}>Confirm: {COMMAND_LABELS[pending]}</button>
                      <button type="button" className="btn btn-small" onClick={() => setPending(null)}>Cancel</button>
                    </div>
                  </form>
                )}
              </section>
            )}
            <div role="status" aria-live="polite">
              {msg && (
                <div className={`notice small ${msg.ok ? 'notice-good' : 'notice-bad'}`}>
                  <p style={{ margin: 0 }}>{msg.text}</p>
                  {msg.findings && <ul style={{ margin: '.4rem 0 0' }}>{msg.findings.map((f, i) => <li key={i}>{f.message}{f.lineId && <> — <a href={`#line-${f.lineId}`}>go to line</a></>}</li>)}</ul>}
                </div>
              )}
            </div>

            {v.yourReviewRole === 'second' && v.state === 'under_review' && !v.secondReviewDone && <SecondReview versionId={v.id} run={run} busy={busy} />}

            {/* Lines */}
            <section aria-labelledby="lines-h" className="stack-sm">
              <h2 id="lines-h" style={{ margin: 0 }}>Lines</h2>
              {v.lines.length === 0 && <p className="muted">No lines yet.{editable ? ' Add a line or import a quantity list below.' : ''}</p>}
              {[...bySection.entries()].map(([section, lines]) => {
                const subtotal = v.totals?.bySection.find((s) => s.code === section)?.amount.display;
                return (
                  <div key={section} className="card" style={{ padding: 0 }}>
                    <div className="table-wrap">
                      <table>
                        <caption style={{ textAlign: 'left', padding: '.6rem .5rem', fontWeight: 700 }}>{sectionLabel(section)}{subtotal ? ` — ${subtotal} (excl. tax)` : ''}</caption>
                        <thead><tr><th scope="col">Item</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Unit rate</th><th scope="col" className="num">Amount</th><th scope="col">Status and sources</th>{editable && <th scope="col"><span className="sr-only">Actions</span></th>}</tr></thead>
                        <tbody>
                          {lines.map((l) => (
                            <LineRow key={l.id} l={l} editable={editable} findings={qaFor(l.id)} onEdit={() => setEditing(editing === l.id ? null : l.id)} editingOpen={editing === l.id}
                              editor={editing === l.id ? <LineEditor line={l} projectId={projectId} regionCode={regionCode} workSections={workSections} onDone={async (t) => { setEditing(null); await refresh(); if (t) setMsg({ ok: true, text: t }); }} onCancel={() => setEditing(null)} /> : null}
                              onDelete={() => { if (confirm(`Delete “${l.description}”?`)) void run(async () => { await call(`/v1/estimate-lines/${l.id}`, { method: 'DELETE' }); return 'Line deleted.'; }); }} />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
              {editable && <AddLine versionId={v.id} maturity={v.maturity} workSections={workSections} run={run} busy={busy} />}
              {editable && <ImportCsv versionId={v.id} workSections={workSections} run={run} busy={busy} />}
            </section>
          </div>

          <aside className="stack">
            {v.totals && (
              <section className="card stack-sm" aria-labelledby="tot-h">
                <h2 id="tot-h" style={{ margin: 0, fontSize: '1rem' }}>Totals</h2>
                <TotalsTable t={v.totals} />
              </section>
            )}
            <BasisPanel v={v} editable={editable} run={run} busy={busy} />
            {v.qa && <QaPanel v={v} canAck={editable && v.yourReviewRole === 'primary'} run={run} busy={busy} />}
            <VersionsPanel est={est} viewing={v} onView={viewVersion} projectId={projectId} run={run} busy={busy} readOnly={readOnly} />
          </aside>
        </div>
      )}
    </div>
  );
}

type Run = (fn: () => Promise<string | void>) => Promise<void>;

function LineRow({ l, editable, findings, onEdit, onDelete, editingOpen, editor }: { l: Line; editable: boolean; findings: QaFinding[]; onEdit: () => void; onDelete: () => void; editingOpen: boolean; editor: React.ReactNode }) {
  const stale = findings.some((f) => f.code === 'rate_stale');
  return (
    <>
      <tr id={`line-${l.id}`}>
        <td>
          <div>{l.description}</div>
          {l.specification && <div className="small muted">{l.specification}</div>}
          {findings.map((f, i) => <div key={i} className="small" style={{ color: f.severity === 'blocker' ? 'var(--bad)' : 'var(--warn)' }}>{f.severity === 'blocker' ? 'Blocking: ' : 'Check: '}{f.message}</div>)}
        </td>
        <td className="num">
          {l.net} {l.unit}
          {(l.deductions !== '0' || l.wastePct > 0) && <div className="small muted">{l.gross} − {l.deductions}{l.wastePct ? ` + ${l.wastePct}% waste` : ''}</div>}
          {l.originalUnit && l.originalUnit !== l.unit && <div className="small muted">imported as “{l.originalUnit}”</div>}
        </td>
        <td className="num">{l.unitRate !== '0' ? l.unitRate : '—'}</td>
        <td className="num">{l.status === 'excluded' ? 'Excluded' : l.amount.display}</td>
        <td className="small">
          <span className={`pill ${l.status === 'measured' ? 'pill-good' : l.status === 'clarification_required' ? 'pill-bad' : ''}`}>{STATUS_LABELS[l.status]}</span>
          <div>{l.quantitySource ? QSOURCE_LABELS[l.quantitySource] : <span style={{ color: 'var(--bad)' }}>No quantity source</span>}{l.measurementIds.length ? ` (${l.measurementIds.length})` : ''}</div>
          {l.rateSource
            ? <div>{l.rateSource.label}, {dateText(l.rateSource.reconfirmedAt ?? l.rateSource.observedAt)}{l.rateSource.reconfirmedAt ? ' (reconfirmed)' : ''}{stale ? <strong style={{ color: 'var(--bad)' }}> — stale</strong> : ''}<div className="muted">{l.rateSource.reference}</div></div>
            : <div className="muted">No rate source</div>}
        </td>
        {editable && (
          <td>
            <div className="inline" style={{ flexWrap: 'nowrap' }}>
              <button type="button" className="btn btn-small" aria-expanded={editingOpen} onClick={onEdit}>{editingOpen ? 'Close' : 'Edit'}<span className="sr-only"> {l.description}</span></button>
              <button type="button" className="btn btn-small btn-danger" onClick={onDelete}>Delete<span className="sr-only"> {l.description}</span></button>
            </div>
          </td>
        )}
      </tr>
      {editingOpen && <tr><td colSpan={editable ? 6 : 5} style={{ background: 'var(--surface-2)' }}>{editor}</td></tr>}
    </>
  );
}

function AddLine({ versionId, maturity, workSections, run, busy }: { versionId: string; maturity: string; workSections: { code: string; label: string }[]; run: Run; busy: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open) return <div><button type="button" className="btn" onClick={() => setOpen(true)}>Add a line</button></div>;
  return (
    <form className="card stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      void run(async () => {
        await call(`/v1/estimate-versions/${versionId}/lines`, { body: {
          section: f.section, description: f.description, specification: f.specification || null, unit: f.unit, gross: f.gross || '0',
          quantitySource: f.quantitySource || undefined, status: f.status || undefined,
          rates: f.rate ? { [f.component || 'material']: f.rate } : undefined,
        } });
        setOpen(false);
        return 'Line added.';
      });
    }}>
      <h3 style={{ margin: 0, fontSize: '1rem' }}>Add a line</h3>
      <div className="row">
        <div><label htmlFor="al-sec">Work section</label><select id="al-sec" name="section">{workSections.map((w) => <option key={w.code} value={w.code}>{w.label}</option>)}</select></div>
        <div style={{ flex: '2 1 260px' }}><label htmlFor="al-desc">Description</label><input id="al-desc" name="description" required minLength={2} maxLength={300} /></div>
      </div>
      <div className="row">
        <div><label htmlFor="al-spec">Specification <span className="hint">Optional</span></label><input id="al-spec" name="specification" maxLength={300} /></div>
        <div><label htmlFor="al-qty">Quantity</label><input id="al-qty" name="gross" inputMode="decimal" pattern="\d+(\.\d{1,6})?" defaultValue="0" /></div>
        <div><label htmlFor="al-unit">Unit</label><select id="al-unit" name="unit">{['m2', 'm', 'm3', 'piece', 'kg', 'tonne', 'bag', 'trip', 'litre', 'day', 'hour', 'job'].map((u) => <option key={u} value={u}>{u}</option>)}</select></div>
      </div>
      <div className="row">
        <div><label htmlFor="al-qs">Quantity source</label>
          <select id="al-qs" name="quantitySource" defaultValue={maturity === 'client_specified' ? 'client_entered' : 'provisional_sum'}>
            <option value="client_entered">Entered by client</option><option value="provisional_sum">Provisional sum</option><option value="measurement">From measurements (link them after adding)</option>
          </select></div>
        <div><label htmlFor="al-st">Status</label><select id="al-st" name="status" defaultValue={maturity === 'client_specified' ? 'provisional' : 'measured'}>{Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
        <div><label htmlFor="al-rate">Rate per unit <span className="hint">Optional; entered manually</span></label><input id="al-rate" name="rate" inputMode="decimal" /></div>
        <div><label htmlFor="al-comp">Rate component</label><select id="al-comp" name="component"><option value="material">Material</option><option value="labour">Labour</option><option value="plant">Plant</option><option value="logistics">Logistics</option><option value="other">Other</option></select></div>
      </div>
      <div className="inline"><button className="btn btn-primary btn-small" type="submit" disabled={busy}>Add line</button><button type="button" className="btn btn-small" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function ImportCsv({ versionId, workSections, run, busy }: { versionId: string; workSections: { code: string; label: string }[]; run: Run; busy: boolean }) {
  const [errors, setErrors] = useState<{ row: number; message: string }[]>([]);
  return (
    <details className="card">
      <summary>Import a quantity list (CSV)</summary>
      <form className="stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => {
        e.preventDefault();
        const fd = new FormData(e.currentTarget);
        const file = fd.get('file') as File | null;
        if (!file || !file.size) return;
        void run(async () => {
          const csv = await file.text();
          const r = await call<{ imported: number; errors: { row: number; message: string }[] }>(`/v1/estimate-versions/${versionId}/import`, { body: { csv, defaultSection: String(fd.get('section')) } });
          setErrors(r.errors);
          return `Imported ${r.imported} line(s)${r.errors.length ? `; ${r.errors.length} row(s) skipped` : ''}.`;
        });
      }}>
        <p className="small" style={{ margin: 0 }}>The first row must name the columns: <strong>description</strong>, <strong>quantity</strong> (or qty) and <strong>unit</strong>; optional <strong>section</strong>, <strong>specification</strong> and <strong>notes</strong>. Units such as sqm, nr and bags are recognised; the original unit is kept.</p>
        <div className="row">
          <div><label htmlFor="imp-file">CSV file</label><input id="imp-file" name="file" type="file" accept=".csv,text/csv" required /></div>
          <div><label htmlFor="imp-sec">Section for rows without one</label><select id="imp-sec" name="section" defaultValue="other">{workSections.map((w) => <option key={w.code} value={w.code}>{w.label}</option>)}</select></div>
        </div>
        <button className="btn btn-small" type="submit" disabled={busy}>Import</button>
        {errors.length > 0 && <ul className="small" style={{ margin: 0 }}>{errors.map((x) => <li key={x.row}>Row {x.row}: {x.message}</li>)}</ul>}
      </form>
    </details>
  );
}

function BasisPanel({ v, editable, run, busy }: { v: Version; editable: boolean; run: Run; busy: boolean }) {
  const [edit, setEdit] = useState(false);
  return (
    <section className="card stack-sm" aria-labelledby="basis-h">
      <div className="inline" style={{ justifyContent: 'space-between' }}><h2 id="basis-h" style={{ margin: 0, fontSize: '1rem' }}>Basis</h2>{editable && !edit && <button type="button" className="btn btn-small" onClick={() => setEdit(true)}>Edit</button>}</div>
      {!edit ? (
        <>
          <div className="small"><strong>Contingency:</strong> {v.contingencyPct}%</div>
          <div className="small"><strong>Assumptions</strong>{v.assumptions.length ? <ul style={{ margin: 0 }}>{v.assumptions.map((a) => <li key={a}>{a}</li>)}</ul> : <span className="muted"> none recorded</span>}</div>
          <div className="small"><strong>Exclusions</strong>{v.exclusions.length ? <ul style={{ margin: 0 }}>{v.exclusions.map((a) => <li key={a}>{a}</li>)}</ul> : <span className="muted"> none recorded</span>}</div>
          {v.changeReason && <div className="small"><strong>Reason for this version:</strong> {v.changeReason}</div>}
        </>
      ) : (
        <form className="stack-sm" onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const lines = (k: string) => String(f.get(k) ?? '').split('\n').map((x) => x.trim()).filter((x) => x.length >= 2);
          void run(async () => {
            await call(`/v1/estimate-versions/${v.id}`, { method: 'PATCH', body: { expectedVersion: v.version, contingencyPct: Number(f.get('cont')), assumptions: lines('ass'), exclusions: lines('exc') } });
            setEdit(false);
            return 'Basis saved.';
          });
        }}>
          <label htmlFor="b-cont">Contingency (%)</label><input id="b-cont" name="cont" type="number" min={0} max={50} step={0.5} defaultValue={v.contingencyPct} />
          <label htmlFor="b-ass">Assumptions <span className="hint">One per line</span></label><textarea id="b-ass" name="ass" defaultValue={v.assumptions.join('\n')} />
          <label htmlFor="b-exc">Exclusions <span className="hint">One per line</span></label><textarea id="b-exc" name="exc" defaultValue={v.exclusions.join('\n')} />
          <div className="inline"><button className="btn btn-small btn-primary" type="submit" disabled={busy}>Save</button><button className="btn btn-small" type="button" onClick={() => setEdit(false)}>Cancel</button></div>
        </form>
      )}
    </section>
  );
}

function QaPanel({ v, canAck, run, busy }: { v: Version; canAck: boolean; run: Run; busy: boolean }) {
  const qa = v.qa ?? [];
  const blockers = qa.filter((f) => f.severity === 'blocker');
  const warnings = qa.filter((f) => f.severity === 'warning');
  return (
    <section className="card stack-sm" aria-labelledby="qa-h">
      <h2 id="qa-h" style={{ margin: 0, fontSize: '1rem' }}>Quality checks</h2>
      {qa.length === 0 && <p className="small notice notice-good" style={{ margin: 0 }}>No findings.</p>}
      {blockers.length > 0 && (
        <div className="stack-sm"><strong className="small">Blocking ({blockers.length}) — must be fixed before issue</strong>
          <ul className="small" style={{ margin: 0, paddingLeft: '1.1rem' }}>{blockers.map((f, i) => <li key={i}>{f.message}{f.lineId && <> <a href={`#line-${f.lineId}`}>Go to line</a></>}</li>)}</ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="stack-sm"><strong className="small">Warnings ({warnings.length}) — acknowledge each with a reason</strong>
          <ul className="plain stack-sm small">
            {warnings.map((f, i) => (
              <li key={i}>
                <div>{f.message}{f.lineId && <> <a href={`#line-${f.lineId}`}>Go to line</a></>}</div>
                {f.acknowledged ? <div className="muted">Acknowledged: {f.acknowledged.reason}</div> : canAck && (
                  <form className="inline" onSubmit={(e) => { e.preventDefault(); const reason = String(new FormData(e.currentTarget).get('r') ?? ''); void run(async () => { await call(`/v1/estimate-versions/${v.id}/qa-acknowledgements`, { body: { key: f.key, reason } }); return 'Warning acknowledged.'; }); }}>
                    <label htmlFor={`ack-${i}`} className="sr-only">Reason for accepting: {f.message}</label>
                    <input id={`ack-${i}`} name="r" required minLength={5} maxLength={500} placeholder="Reason" style={{ flex: 1, minWidth: '10rem' }} />
                    <button className="btn btn-small" type="submit" disabled={busy}>Acknowledge</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function SecondReview({ versionId, run, busy }: { versionId: string; run: Run; busy: boolean }) {
  return (
    <form className="card stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const approve = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'approve';
      void run(async () => { await call(`/v1/estimate-versions/${versionId}/second-review`, { body: { approve, note: String(f.get('note')) } }); return approve ? 'Second review approved.' : 'Second review recorded as not approved.'; });
    }}>
      <h2 style={{ margin: 0, fontSize: '1rem' }}>Your second review</h2>
      <label htmlFor="sr-note">Note</label>
      <textarea id="sr-note" name="note" required minLength={5} maxLength={2000} />
      <div className="inline"><button className="btn btn-small btn-primary" type="submit" value="approve" disabled={busy}>Approve</button><button className="btn btn-small" type="submit" value="reject" disabled={busy}>Not approved</button></div>
    </form>
  );
}

interface Delta { against: { id: string; number: number } | null; before: { display: string } | null; after: { display: string } | null; change?: { display: string }; changeReason: string | null; rows: { key: string; description: string; change: string; before: { qty: string; rate: string; amount: { display: string } } | null; after: { qty: string; rate: string; amount: { display: string } } | null; reasons: string[] }[] }

function VersionsPanel({ est, viewing, onView, projectId, run, busy, readOnly }: { est: Estimate; viewing: Version; onView: (id: string) => void; projectId: string; run: Run; busy: boolean; readOnly: boolean }) {
  const [delta, setDelta] = useState<Delta | null>(null);
  const [err, setErr] = useState('');
  const prev = est.versions.find((x) => x.number === viewing.number - 1);
  return (
    <section className="card stack-sm" aria-labelledby="ver-h">
      <h2 id="ver-h" style={{ margin: 0, fontSize: '1rem' }}>Versions</h2>
      <ul className="plain stack-sm small">
        {est.versions.map((x) => {
          const s = statePill(x.state);
          return (
            <li key={x.id} className="inline" style={{ justifyContent: 'space-between' }}>
              <button type="button" className="linkish" aria-current={x.id === viewing.id ? 'true' : undefined} onClick={() => { setDelta(null); onView(x.id); }}>Version {x.number}{x.id === est.current.id ? ' (current)' : ''}</button>
              <span><span className={`pill ${s.cls}`}>{s.label}</span>{x.gross ? ` ${x.gross.display}` : ''}</span>
            </li>
          );
        })}
      </ul>
      {prev && <button type="button" className="btn btn-small" onClick={async () => { setErr(''); try { setDelta(await call<Delta>(`/v1/estimate-versions/${viewing.id}/delta`)); } catch (e) { setErr(errorText(e)); } }}>Compare with version {prev.number}</button>}
      {err && <p role="alert" className="small">{err}</p>}
      {delta && delta.against && (
        <div className="stack-sm">
          <p className="small" style={{ margin: 0 }}>Version {delta.against.number}: {delta.before?.display} → {delta.after?.display}{delta.change ? ` (${delta.change.display})` : ''}, excluding tax and contingency.{delta.changeReason ? ` Reason: ${delta.changeReason}` : ''}</p>
          {delta.rows.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No line changes.</p> : (
            <div className="table-wrap">
              <table className="small">
                <caption className="sr-only">Changes from version {delta.against.number}</caption>
                <thead><tr><th scope="col">Line</th><th scope="col">Change</th><th scope="col" className="num">Before</th><th scope="col" className="num">After</th></tr></thead>
                <tbody>{delta.rows.map((r) => (
                  <tr key={r.key}><td>{r.description}</td><td>{r.change}{r.reasons.length ? `: ${r.reasons.join(', ')}` : ''}</td><td className="num">{r.before ? `${r.before.qty} × ${r.before.rate} = ${r.before.amount.display}` : '—'}</td><td className="num">{r.after ? `${r.after.qty} × ${r.after.rate} = ${r.after.amount.display}` : '—'}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {est.canNewVersion && !readOnly && viewing.id === est.current.id && (
        <form className="stack-sm" onSubmit={(e) => {
          e.preventDefault();
          const reason = String(new FormData(e.currentTarget).get('reason') ?? '');
          void run(async () => { await call(`/v1/estimates/${est.id}/versions`, { body: { changeReason: reason } }); return 'New draft version started.'; });
        }}>
          <label htmlFor="nv-reason">Start a new version <span className="hint">Say what changed (scope, design or rates)</span></label>
          <textarea id="nv-reason" name="reason" required minLength={3} maxLength={500} style={{ minHeight: '3rem' }} />
          <button className="btn btn-small" type="submit" disabled={busy}>Start new version</button>
        </form>
      )}
      <Link className="small" href={`/projects/${projectId}/estimates`}>All estimates</Link>
    </section>
  );
}
