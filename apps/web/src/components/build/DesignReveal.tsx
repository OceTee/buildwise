'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Check, CircleAlert, Download, FileText, Layers, Loader2, PencilRuler, RefreshCw, TriangleAlert } from 'lucide-react';
import { BUILDING_TYPES, conceptFor, type Design, type DesignConcept, type ProjectPlans } from '@bw/domain';
import { money } from '@/lib/format';
import { fmtCompact } from './planning-ui';
import { RenderButton } from './RenderButton';
import type { View } from './Scene';

// ---------------------------------------------------------------- generating

export interface GenTask { label: string; state: 'waiting' | 'working' | 'done' | 'skipped'; detail?: string }

/** The work BuildWise does for the person, shown as it happens. */
export function GeneratingPanel({ tasks, onSkip }: { tasks: GenTask[]; onSkip?: () => void }) {
  const done = tasks.filter((t) => t.state === 'done' || t.state === 'skipped').length;
  return (
    <section className="gen-panel card" aria-labelledby="gen-h">
      <p className="kicker">Designing</p>
      <h1 id="gen-h" tabIndex={-1}>Designing your building</h1>
      <div className="gen-bar" role="progressbar" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={done} aria-label="Progress"><span style={{ width: `${(done / tasks.length) * 100}%` }} /></div>
      <ol className="plain gen-list" aria-live="polite">
        {tasks.map((t) => (
          <li key={t.label} className={`gen-task ${t.state}`}>
            <span className="gen-icon" aria-hidden="true">{t.state === 'done' ? <Check size={16} /> : t.state === 'working' ? <Loader2 size={16} className="spin" /> : t.state === 'skipped' ? '–' : '·'}</span>
            <span><span className="sr-only">{t.state === 'done' ? 'Done: ' : t.state === 'working' ? 'Working on: ' : ''}</span>{t.label}{t.detail && <span className="small muted"> · {t.detail}</span>}</span>
          </li>
        ))}
      </ol>
      {onSkip && <button type="button" className="btn btn-small btn-ghost" onClick={onSkip}>Don&rsquo;t wait: show BuildWise&rsquo;s quick design now</button>}
    </section>
  );
}

// ---------------------------------------------------------------- the hero: concept and numbers

const STOREY_LABEL = (s: number) => (s === 0 ? 'Ground floor' : `${s === 1 ? 'First' : s === 2 ? 'Second' : s === 3 ? 'Third' : `Floor ${s}`}${s <= 3 ? ' floor' : ''}`);

export function ConceptCard({ design, location, plans, currency, aiPending, capture, renderConnected, onChange, onAdjust }: {
  design: Design; location: string; plans: ProjectPlans | null; currency: string; aiPending: boolean;
  capture: () => string | null; renderConnected: boolean; onChange: () => void; onAdjust: () => void;
}) {
  const concept: DesignConcept = design.concept ?? conceptFor(design);
  const info = BUILDING_TYPES[design.brief.type];
  const b = plans?.budget.result;
  const [saved, setSaved] = useState('');
  const download = () => {
    const url = capture();
    if (!url) { setSaved('The 3D view is still loading; try again in a moment.'); return; }
    const a = document.createElement('a');
    a.href = url; a.download = `${concept.title.replace(/[^\w-]+/g, '-').toLowerCase()}.png`; a.click();
    setSaved('Image saved.');
  };
  const units = design.summary.split(', ')[0]!.split('. ')[0];
  return (
    <section className="concept card" aria-labelledby="step-h">
      <p className="kicker">{info.label}{location ? ` · ${location}` : ''} · concept design</p>
      <h1 id="step-h" tabIndex={-1}>{concept.title}</h1>
      <p className="lede-sm">{concept.story}</p>
      {aiPending && <p className="small muted" role="status"><Loader2 size={13} className="spin" aria-hidden="true" /> Your architect is writing the concept…</p>}
      <dl className="stat-tiles">
        <div><dt>Floor area</dt><dd>{Math.round(design.metrics.grossFloorM2).toLocaleString('en')} m²</dd></div>
        <div><dt>Storeys</dt><dd>{design.storeys}</dd></div>
        <div><dt>Holds</dt><dd className="small-dd">{units}</dd></div>
        <div><dt>Likely cost</dt><dd className="small-dd">{b ? `${fmtCompact(b.lowMinor, currency)} – ${fmtCompact(b.highMinor, currency)}` : '…'}</dd></div>
      </dl>
      {concept.moves.length > 0 && (
        <ul className="plain stack-sm moves">{concept.moves.map((m) => <li key={m}><Check size={15} aria-hidden="true" /> <span className="small">{m}</span></li>)}</ul>
      )}
      <div className="palette" aria-label="Materials">
        <span className="small"><strong>Walls</strong> {concept.palette.walls}</span>
        <span className="small"><strong>Details</strong> {concept.palette.accents}</span>
        <span className="small"><strong>Roof</strong> {concept.palette.roof}</span>
      </div>
      <div className="row wrap">
        <button type="button" className="btn" onClick={download}><Download size={16} aria-hidden="true" /> Download image</button>
        <Link className="btn" href="/build/drawings"><FileText size={16} aria-hidden="true" /> Concept drawings</Link>
        <button type="button" className="btn" onClick={onChange}><RefreshCw size={16} aria-hidden="true" /> Change the brief</button>
        <Link className="btn btn-primary" href="/studio"><PencilRuler size={16} aria-hidden="true" /> Open in Design Studio</Link>
        <button type="button" className="btn" onClick={onAdjust}>Quick adjust</button>
      </div>
      {saved && <p className="small muted" role="status">{saved}</p>}
      <RenderButton connected={renderConnected} capture={capture} type={info.label} style={design.brief.style} storeys={design.storeys} summary={design.summary.slice(0, 300)} />
      <p className="small muted"><CircleAlert size={13} aria-hidden="true" /> A concept design: a registered architect and engineers prepare the drawings you build from and get the permit.</p>
    </section>
  );
}

// ---------------------------------------------------------------- overview tab

/** A house plan listed in the marketplace that fits the plot. */
export interface PlanCard {
  id: string; path: string; title: string; sellerName: string | null; verified: boolean; price: { amountMinor: string; currency: string } | null;
  plan: { bedrooms: number; storeys: number; floorAreaM2: number; minPlot: { widthM: number; depthM: number }; drawingsIncluded: string };
}

export function OverviewTab({ design, designs, notes, overview, choose, view, setView, plans }: {
  design: Design; designs: Design[]; notes: string[]; overview: string | null; choose: (id: string) => void; view: View; setView: (v: View) => void; plans: PlanCard[];
}) {
  const warns = design.checks.filter((c) => c.status !== 'pass');
  const others = designs.filter((d) => d.id !== design.id);
  return (
    <div className="stack">
      {notes.map((n) => <p key={n} className="notice notice-warn small" role="status">{n}</p>)}
      <section className="stack-sm" aria-labelledby="fp-h">
        <h2 id="fp-h" className="h-sub">Floor by floor</h2>
        <div className="segs wrap" role="group" aria-label="3D view">
          <button type="button" className={`seg${view === 'outside' ? ' on' : ''}`} aria-pressed={view === 'outside'} onClick={() => setView('outside')}>Outside</button>
          {Array.from({ length: design.storeys }, (_, s) => (
            <button key={s} type="button" className={`seg${view === s ? ' on' : ''}`} aria-pressed={view === s} onClick={() => setView(s)}><Layers size={14} aria-hidden="true" /> {STOREY_LABEL(s)}{design.storeys <= 2 ? ' plan' : ''}</button>
          ))}
        </div>
        <p className="small muted">Each floor shows in the 3D view above with everything over it lifted off, and its rooms named.</p>
      </section>

      {design.planning && (
        <details className="checklist" open>
          <summary><strong>How it&rsquo;s planned</strong> <span className="small muted">the architect&rsquo;s plan before the drawing</span></summary>
          <dl className="plan-read small">
            <div><dt>Zones</dt><dd>{design.planning.zones}</dd></div>
            <div><dt>Arrival</dt><dd>{design.planning.arrival}</dd></div>
            <div><dt>Daily flow</dt><dd>{design.planning.flow}</dd></div>
          </dl>
          {design.planning.relationships.length > 0 && (
            <ul className="plain stack-sm">{design.planning.relationships.map((r) => <li key={r} className="check-row pass"><Check size={16} aria-hidden="true" /><span className="small">{r}</span></li>)}</ul>
          )}
        </details>
      )}
      <details className="checklist" open>
        <summary><strong>Architect&rsquo;s notes</strong> <span className="small muted">{design.review.source === 'ai' ? 'AI architect' : 'BuildWise design engine'} · score {design.review.score}/100</span></summary>
        {overview && <p className="small">{overview}</p>}
        <ul className="plain stack-sm">
          {design.review.highlights.map((h) => <li key={h} className="check-row pass"><Check size={16} aria-hidden="true" /><span className="small">{h}</span></li>)}
          {design.review.considerations.map((h) => <li key={h} className="check-row warn"><CircleAlert size={16} aria-hidden="true" /><span className="small"><span className="sr-only">To consider: </span>{h}</span></li>)}
        </ul>
      </details>
      <details className="checklist">
        <summary><strong>Architect&rsquo;s checklist</strong> <span className="small muted">{design.checks.length - warns.length} of {design.checks.length} pass{warns.length ? `, ${warns.length} to note` : ''}</span></summary>
        <ul className="plain stack-sm">
          {design.checks.map((c) => (
            <li key={c.code} className={`check-row ${c.status}`}>
              {c.status === 'pass' ? <Check size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
              <span><strong>{c.label}</strong> <span className="sr-only">{c.status === 'pass' ? 'passes' : 'needs attention'}.</span> <span className="small muted">{c.detail}</span></span>
            </li>
          ))}
        </ul>
      </details>
      <details className="checklist">
        <summary><strong>Rooms</strong> <span className="small muted">{design.rooms.filter((r) => r.kind !== 'corridor').length}</span></summary>
        <div className="table-wrap">
          <table className="table small">
            <thead><tr><th scope="col">Room</th><th scope="col">Floor</th><th scope="col">Size</th><th scope="col">Area</th></tr></thead>
            <tbody>{design.rooms.filter((r) => r.kind !== 'corridor').map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.block === 'bq' ? "Boys' quarters" : STOREY_LABEL(r.storey)}</td><td>{r.w.toFixed(1)} × {r.d.toFixed(1)} m</td><td>{(r.w * r.d).toFixed(1)} m²</td></tr>)}</tbody>
          </table>
        </div>
      </details>

      {others.length > 0 && (
        <section className="stack-sm" aria-labelledby="alt-h">
          <h2 id="alt-h" className="h-sub">Other directions</h2>
          <p className="small muted">BuildWise also laid these out; each fits your plot and passes the same checks.</p>
          <ul className="plain alt-list">
            {others.map((d) => (
              <li key={d.id}>
                <button type="button" className="alt-card card-inset" onClick={() => { choose(d.id); setView('outside'); }}>
                  <strong>{d.name}</strong>
                  <span className="small muted">{d.blurb}</span>
                  <span className="design-stats small"><span>{Math.round(d.metrics.grossFloorM2)} m²</span><span>{d.footprint.w.toFixed(1)} × {d.footprint.d.toFixed(1)} m</span><span>score {d.review.score}</span></span>
                  <span className="small accent-text">Use this one</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {plans.length > 0 && (
        <section className="stack-sm" aria-labelledby="plans-h">
          <h2 id="plans-h" className="h-sub">Ready-made plans from architects that fit your plot</h2>
          <p className="small muted">Listed in the marketplace by their designers; buy the drawing set from the seller. Check what is included before you pay.</p>
          <ul className="plain plan-list">
            {plans.map((p) => (
              <li key={p.id} className="plan-card card-inset">
                <Link href={p.path}><strong>{p.title}</strong></Link>
                <span className="small muted">{p.plan.bedrooms} bedrooms · {p.plan.storeys === 1 ? 'bungalow' : `${p.plan.storeys} storeys`} · {p.plan.floorAreaM2} m² · fits {p.plan.minPlot.widthM} × {p.plan.minPlot.depthM} m and larger</span>
                <span className="small">{p.price ? money(p.price) : 'Price on request'} · {p.sellerName}{p.verified ? ' (verified)' : ''}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
