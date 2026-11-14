'use client';
import { useState } from 'react';
import { ApiFailure, call, errorText } from '@/lib/client';
import { COMPONENTS, QSOURCE_LABELS, STATUS_LABELS, type Line } from './types';

interface Props {
  line: Line; projectId: string; regionCode: string | null; workSections: { code: string; label: string }[];
  onDone: (message?: string) => void | Promise<void>; onCancel: () => void;
}

interface Measurement { id: string; label: string; value: string; unit: string; page: number; potentiallyAffected: boolean; doc: string; revision: string }
interface CatalogItem { id: string; code: string; name: string; unit: string; rateCategory: string; bestRate: { observationId: string; rate: { display: string }; sourceLabel: string; observedAt: string } | null }

type Draft = Record<string, unknown>;

/** Edits one line with its own optimistic concurrency (spec §11.2); a conflict shows both versions to merge. */
export function LineEditor({ line, projectId, regionCode, workSections, onDone, onCancel }: Props) {
  const [base, setBase] = useState<Line>(line);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState<{ theirs: Line; mine: Draft } | null>(null);
  const [measures, setMeasures] = useState<Measurement[] | null>(null);
  const [picked, setPicked] = useState<string[]>(line.measurementIds);
  const [catalog, setCatalog] = useState<CatalogItem[] | null>(null);

  async function save(changes: Draft, rowVersion: number) {
    setBusy(true); setError('');
    try {
      await call(`/v1/estimate-lines/${line.id}`, { method: 'PATCH', body: { ...changes, rowVersion } });
      await onDone('Line saved.');
    } catch (e) {
      if (e instanceof ApiFailure && e.code === 'LINE_CHANGED' && e.details?.current) setConflict({ theirs: e.details.current as Line, mine: changes });
      else setError(errorText(e));
    } finally { setBusy(false); }
  }

  function collect(form: HTMLFormElement): Draft {
    const f = new FormData(form);
    const s = (k: string) => String(f.get(k) ?? '');
    const d: Draft = {
      section: s('section'), description: s('description'), specification: s('specification') || null, status: s('status'),
      quantitySource: s('quantitySource') || null, wastePct: Number(s('wastePct') || 0), deductions: s('deductions') || '0',
      rates: Object.fromEntries(COMPONENTS.map((c) => [c, s(`rate-${c}`) || null])),
    };
    if (picked.length) d.measurementIds = picked;
    else { d.measurementIds = []; d.gross = s('gross') || '0'; }
    return d;
  }

  async function loadMeasurements() {
    setError('');
    try {
      const docs = await call<{ items: { id: string; title: string; current: { id: string; revision: string; state: string } | null }[] }>(`/v1/projects/${projectId}/documents`);
      const out: Measurement[] = [];
      for (const d of docs.items) {
        if (!d.current || d.current.state !== 'available') continue;
        const t = await call<{ measurements: Omit<Measurement, 'doc' | 'revision'>[] }>(`/v1/revisions/${d.current.id}/takeoff`);
        for (const m of t.measurements) out.push({ ...m, doc: d.title, revision: d.current.revision });
      }
      setMeasures(out);
    } catch (e) { setError(errorText(e)); }
  }

  async function searchCatalog(q: string) {
    setError('');
    try {
      const qs = new URLSearchParams({ unit: base.unit, ...(q ? { q } : {}), ...(regionCode ? { region: regionCode } : {}) });
      setCatalog((await call<{ items: CatalogItem[] }>(`/v1/catalog?${qs}`)).items);
    } catch (e) { setError(errorText(e)); }
  }

  async function applyRate(item: CatalogItem, component: string, reconfirm = false) {
    setBusy(true); setError('');
    try {
      await call(`/v1/estimate-lines/${line.id}/apply-rate`, { body: { catalogItemId: item.id, component, rowVersion: base.rowVersion, ...(reconfirm && base.rateSource ? { observationId: (base.rateSource as { observationId?: string }).observationId, reconfirm: true } : {}) } });
      await onDone(`Rate applied from ${item.name}.`);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  if (conflict) {
    const t = conflict.theirs;
    const fields: [string, string, string][] = [
      ['Description', t.description, String(conflict.mine.description ?? '')],
      ['Quantity', `${t.gross} − ${t.deductions} + ${t.wastePct}%`, conflict.mine.measurementIds && (conflict.mine.measurementIds as string[]).length ? 'from linked measurements' : `${conflict.mine.gross} − ${conflict.mine.deductions} + ${conflict.mine.wastePct}%`],
      ['Status', STATUS_LABELS[t.status], STATUS_LABELS[conflict.mine.status as Line['status']] ?? String(conflict.mine.status)],
      ['Unit rate', t.unitRate, COMPONENTS.map((c) => (conflict.mine.rates as Record<string, string | null>)[c]).filter(Boolean).join(' + ') || '—'],
    ];
    return (
      <div className="stack-sm" role="alert">
        <strong>Someone else saved this line while you were editing.</strong>
        <div className="table-wrap">
          <table className="small">
            <caption className="sr-only">Their version and your version</caption>
            <thead><tr><th scope="col">Field</th><th scope="col">Saved by them</th><th scope="col">Your changes</th></tr></thead>
            <tbody>{fields.map(([k, a, b]) => <tr key={k}><th scope="row">{k}</th><td>{a}</td><td>{b}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="inline">
          <button type="button" className="btn btn-small" onClick={() => onDone('Kept their version.')}>Keep theirs</button>
          <button type="button" className="btn btn-small btn-primary" disabled={busy} onClick={() => { const theirs = conflict.theirs; setConflict(null); setBase(theirs); void save(conflict.mine, theirs.rowVersion); }}>Save mine over theirs</button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack-sm">
      <form className="stack-sm" onSubmit={(e) => { e.preventDefault(); void save(collect(e.currentTarget), base.rowVersion); }}>
        <div className="row">
          <div><label htmlFor={`le-sec-${line.id}`}>Work section</label><select id={`le-sec-${line.id}`} name="section" defaultValue={base.section}>{workSections.map((w) => <option key={w.code} value={w.code}>{w.label}</option>)}</select></div>
          <div style={{ flex: '2 1 260px' }}><label htmlFor={`le-d-${line.id}`}>Description</label><input id={`le-d-${line.id}`} name="description" defaultValue={base.description} required minLength={2} maxLength={300} /></div>
          <div><label htmlFor={`le-sp-${line.id}`}>Specification</label><input id={`le-sp-${line.id}`} name="specification" defaultValue={base.specification ?? ''} maxLength={300} /></div>
        </div>
        <fieldset style={{ margin: 0 }}>
          <legend>Quantity ({base.unit})</legend>
          <div className="row">
            {picked.length === 0
              ? <div><label htmlFor={`le-g-${line.id}`}>Gross</label><input id={`le-g-${line.id}`} name="gross" inputMode="decimal" defaultValue={base.gross} /></div>
              : <div className="small">Gross comes from {picked.length} linked measurement(s).</div>}
            <div><label htmlFor={`le-de-${line.id}`}>Deductions</label><input id={`le-de-${line.id}`} name="deductions" inputMode="decimal" defaultValue={base.deductions} /></div>
            <div><label htmlFor={`le-w-${line.id}`}>Waste (%)</label><input id={`le-w-${line.id}`} name="wastePct" type="number" min={0} max={100} step={0.5} defaultValue={base.wastePct} /></div>
            <div><label htmlFor={`le-qs-${line.id}`}>Quantity source</label><select id={`le-qs-${line.id}`} name="quantitySource" defaultValue={base.quantitySource ?? ''}><option value="">Not set</option>{Object.entries(QSOURCE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
            <div><label htmlFor={`le-st-${line.id}`}>Status</label><select id={`le-st-${line.id}`} name="status" defaultValue={base.status}>{Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></div>
          </div>
        </fieldset>
        <fieldset style={{ margin: 0 }}>
          <legend>Unit rate by component <span className="hint">Manual entries are recorded as a manual estimate</span></legend>
          <div className="row">
            {COMPONENTS.map((c) => <div key={c}><label htmlFor={`le-r-${c}-${line.id}`} style={{ textTransform: 'capitalize' }}>{c}</label><input id={`le-r-${c}-${line.id}`} name={`rate-${c}`} inputMode="decimal" defaultValue={base.rates[c] ?? ''} /></div>)}
          </div>
        </fieldset>
        <div className="inline"><button className="btn btn-small btn-primary" type="submit" disabled={busy}>Save line</button><button type="button" className="btn btn-small" onClick={onCancel}>Cancel</button></div>
      </form>

      <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !measures) void loadMeasurements(); }}>
        <summary>Link drawing measurements</summary>
        {!measures ? <p className="small muted" role="status">Loading measurements…</p> : (
          <fieldset style={{ marginTop: '.5rem' }}>
            <legend>Measurements in {base.unit}</legend>
            {measures.filter((m) => m.unit === base.unit).length === 0 && <p className="small muted" style={{ margin: 0 }}>No measurements in {base.unit} yet. Measure on a drawing in Documents first.</p>}
            {measures.filter((m) => m.unit === base.unit).map((m) => (
              <label key={m.id} className="check small">
                <input type="checkbox" checked={picked.includes(m.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, m.id] : picked.filter((x) => x !== m.id))} />
                {m.label}: {m.value} {m.unit} — {m.doc} rev {m.revision}, page {m.page}{m.potentiallyAffected ? ' (drawing revised; check)' : ''}
              </label>
            ))}
            <p className="small muted" style={{ margin: '.25rem 0 0' }}>Save the line to apply the linked measurements.</p>
          </fieldset>
        )}
      </details>

      <details onToggle={(e) => { if ((e.target as HTMLDetailsElement).open && !catalog) void searchCatalog(''); }}>
        <summary>Price from the rate catalog</summary>
        <form className="inline" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); void searchCatalog(String(new FormData(e.currentTarget).get('q') ?? '')); }}>
          <label htmlFor={`cat-q-${line.id}`} className="sr-only">Search the catalog</label>
          <input id={`cat-q-${line.id}`} name="q" placeholder={`Items priced per ${base.unit}`} style={{ flex: 1, minWidth: '12rem' }} />
          <button className="btn btn-small" type="submit">Search</button>
        </form>
        {!regionCode && <p className="small notice notice-warn">Set the project location to see regional rates.</p>}
        {catalog && (catalog.length === 0 ? <p className="small muted">No catalog items priced per {base.unit}.</p> : (
          <ul className="plain stack-sm" style={{ marginTop: '.5rem' }}>
            {catalog.map((it) => (
              <li key={it.id} className="small">
                <strong>{it.name}</strong> <span className="muted">({it.code})</span>
                <div>{it.bestRate ? <>Best current rate: {it.bestRate.rate.display} — {it.bestRate.sourceLabel}, {new Date(it.bestRate.observedAt).toLocaleDateString('en-GB')}</> : <span className="muted">No current rate in this region</span>}</div>
                {it.bestRate && (
                  <form className="inline" onSubmit={(e) => { e.preventDefault(); void applyRate(it, String(new FormData(e.currentTarget).get('component'))); }}>
                    <label htmlFor={`comp-${line.id}-${it.id}`} className="sr-only">Component</label>
                    <select id={`comp-${line.id}-${it.id}`} name="component" defaultValue="material" style={{ width: 'auto' }}>{COMPONENTS.map((c) => <option key={c} value={c}>{c}</option>)}</select>
                    <button className="btn btn-small" type="submit" disabled={busy}>Use this rate<span className="sr-only"> for {it.name}</span></button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ))}
        {base.rateSource && base.catalogItemId && (
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => applyRate({ id: base.catalogItemId!, name: 'the current source', code: '', unit: base.unit, rateCategory: base.rateCategory, bestRate: null }, ((base.rateSource as { component?: string } | null)?.component ?? COMPONENTS.find((c) => base.rates[c]) ?? 'material'), true)}>
            Reconfirm the current rate is still valid
          </button>
        )}
      </details>
      <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
    </div>
  );
}
