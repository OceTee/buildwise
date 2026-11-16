'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, ArrowRight, Bot, Check, CircleAlert, FileUp, Layers, Ruler, Send, ShoppingCart, Sparkles, TriangleAlert, Wand2,
} from 'lucide-react';
import {
  DEFAULT_BRIEF, DEFAULT_DESIGN_CONFIG, FT, billOfMaterials, generateDesigns, normaliseBrief, validPlot,
  type Design, type DesignBrief, type DesignConfig, type MaterialLine, type Plot,
} from '@bw/domain';
import { call, errorText } from '@/lib/client';
import { money } from '@/lib/format';
import type { View } from './Scene';

const Scene = dynamic(() => import('./Scene'), { ssr: false, loading: () => <div className="scene-loading">Preparing the 3D view…</div> });

type Step = 'land' | 'plan' | 'brief' | 'designs' | 'materials' | 'buy';
const STEPS: { key: Step; label: string }[] = [
  { key: 'land', label: 'Land' }, { key: 'plan', label: 'Plan' }, { key: 'brief', label: 'Your home' },
  { key: 'designs', label: 'Designs' }, { key: 'materials', label: 'Materials' }, { key: 'buy', label: 'Where to buy' },
];
const PRESETS: { label: string; w: number; d: number; unit: 'ft' | 'm' }[] = [
  { label: '50 × 100 ft (full plot)', w: 50, d: 100, unit: 'ft' },
  { label: '60 × 120 ft', w: 60, d: 120, unit: 'ft' },
  { label: '30 × 60 ft (half plot)', w: 30, d: 60, unit: 'ft' },
  { label: '15 × 30 m', w: 15, d: 30, unit: 'm' },
];
const SECTION_LABEL: Record<MaterialLine['section'], string> = {
  substructure: 'Foundations and ground floor', frame: 'Concrete frame and steel', walls: 'Walls', roof: 'Roof',
  openings: 'Doors and windows', finishes: 'Finishes', services: 'Electrical and plumbing',
};
const STORE_KEY = 'bw-build-v1';

interface Chat { from: 'you' | 'assistant'; text: string }
interface Sourcing {
  currency: string; pricedLines: number; total: { amountMinor: string; currency: string };
  lines: { key: string; name: string; unit: string; quantity: number; searchPath: string;
    offers: { listingId: string; path: string; title: string; sellerName: string | null; area: string | null; price: { amountMinor: string; currency: string } | null; unitLabel: string; deliveryOffered: boolean; promoted: boolean; lineTotal: { amountMinor: string; currency: string } | null }[] }[];
}

interface Saved { step: Step; plot: Plot | null; unit: 'ft' | 'm'; brief: DesignBrief; designId: string | null; chat: Chat[] }

function load(): Partial<Saved> {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<Saved>; } catch { return {}; }
}
function save(s: Saved) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode: the flow still works */ }
}

export function BuildWizard({ initialMessage }: { initialMessage: string | null }) {
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<Step>('land');
  const [plot, setPlot] = useState<Plot | null>(null);
  const [unit, setUnit] = useState<'ft' | 'm'>('ft');
  const [brief, setBrief] = useState<DesignBrief>(DEFAULT_BRIEF);
  const [designId, setDesignId] = useState<string | null>(null);
  const [chat, setChat] = useState<Chat[]>([]);
  const [cfg, setCfg] = useState<DesignConfig>(DEFAULT_DESIGN_CONFIG);
  const [aiOn, setAiOn] = useState(false);
  const [view, setView] = useState<View>('outside');
  const [dark, setDark] = useState(false);
  const stepRef = useRef<HTMLHeadingElement>(null);

  // Restore a build in progress, and read the market's design rules.
  useEffect(() => {
    const s = load();
    if (s.plot && validPlot(s.plot)) setPlot(s.plot);
    if (s.unit) setUnit(s.unit);
    if (s.brief) setBrief(normaliseBrief(s.brief));
    if (s.designId) setDesignId(s.designId);
    if (s.chat) setChat(s.chat.slice(-12));
    if (s.step && !initialMessage) setStep(s.step);
    setReady(true);
    call<{ design: DesignConfig; ai: boolean }>('/v1/build/config').then((c) => { setCfg(c.design); setAiOn(c.ai); }).catch(() => undefined);
    const html = document.documentElement;
    const sync = () => setDark(html.dataset.theme === 'dark' || (!html.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [initialMessage]);
  useEffect(() => { if (ready) save({ step, plot, unit, brief, designId, chat }); }, [ready, step, plot, unit, brief, designId, chat]);

  const result = useMemo(() => (plot ? generateDesigns(plot, brief, cfg) : { designs: [], notes: [] }), [plot, brief, cfg]);
  const design: Design | null = result.designs.find((d) => d.id === designId) ?? result.designs[0] ?? null;
  const bom = useMemo(() => (design ? billOfMaterials(design, cfg) : []), [design, cfg]);

  const go = (s: Step) => {
    setStep(s);
    if (s !== 'designs') setView('outside');
    requestAnimationFrame(() => stepRef.current?.focus());
  };

  // The assistant: what someone types updates the plot and the brief.
  const [busy, setBusy] = useState(false);
  const ask = useCallback(async (message: string) => {
    setChat((c) => [...c, { from: 'you', text: message }]);
    setBusy(true);
    try {
      const r = await call<{ intent: string; reply: string; plot: Plot | null; brief: Partial<DesignBrief> }>('/v1/build/interpret', { body: { message, plot, brief } });
      if (r.intent === 'shopping') { window.location.href = `/search?q=${encodeURIComponent(message.slice(0, 100))}`; return; }
      if (r.plot) { setPlot(r.plot); }
      if (Object.keys(r.brief).length) setBrief((b) => normaliseBrief({ ...b, ...r.brief }));
      setChat((c) => [...c, { from: 'assistant', text: r.reply }]);
      return r;
    } catch (e) {
      setChat((c) => [...c, { from: 'assistant', text: `Sorry, that did not go through: ${errorText(e)}` }]);
    } finally { setBusy(false); }
  }, [plot, brief]);

  // Arriving from the welcome screen with a message: read it, then open the right step.
  const started = useRef(false);
  useEffect(() => {
    if (!ready || !initialMessage || started.current) return;
    started.current = true;
    setChat([]);
    ask(initialMessage).then((r) => {
      if (!r) return;
      if (r.plot) setStep(Object.keys(r.brief).length ? 'brief' : 'plan');
      else setStep('land');
      window.history.replaceState(null, '', '/build');
    });
  }, [ready, initialMessage, ask]);

  const index = STEPS.findIndex((s) => s.key === step);
  if (!ready) return <div className="build-shell"><div className="scene-loading">Loading…</div></div>;

  return (
    <div className="build-shell">
      <nav aria-label="Build steps" className="build-steps">
        <ol>
          {STEPS.map((s, i) => {
            const reachable = i <= index || (plot && (i <= 2 || (design && i <= 5)));
            return (
              <li key={s.key} aria-current={s.key === step ? 'step' : undefined} className={i < index ? 'done' : ''}>
                <button type="button" onClick={() => reachable && go(s.key)} disabled={!reachable}>
                  <span className="n" aria-hidden="true">{i < index ? <Check size={13} /> : i + 1}</span>{s.label}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <div className="build-grid">
        <section className="build-panel card" aria-labelledby="step-h">
          {step === 'land' && <LandStep plot={plot} unit={unit} setUnit={setUnit} setPlot={setPlot} stepRef={stepRef} chat={chat} onNext={() => go('plan')} />}
          {step === 'plan' && <PlanStep stepRef={stepRef} onBack={() => go('land')} onNext={() => go('brief')} />}
          {step === 'brief' && <BriefStep stepRef={stepRef} brief={brief} setBrief={setBrief} chat={chat} busy={busy} ask={ask} aiOn={aiOn} notes={result.notes} count={result.designs.length} onBack={() => go('plan')} onNext={() => go('designs')} />}
          {step === 'designs' && <DesignsStep stepRef={stepRef} result={result} design={design} setDesignId={setDesignId} view={view} setView={setView} onBack={() => go('brief')} onNext={() => go('materials')} />}
          {step === 'materials' && design && <MaterialsStep stepRef={stepRef} design={design} bom={bom} onBack={() => go('designs')} onNext={() => go('buy')} />}
          {step === 'buy' && design && <BuyStep stepRef={stepRef} bom={bom} onBack={() => go('materials')} />}
        </section>

        <section className="build-stage" aria-label="3D model">
          <div className="scene-frame glass">
            {plot
              ? <Scene plot={plot} setbacks={cfg.setbacksM} design={step === 'land' || step === 'plan' ? null : design} view={view} buildKey={design?.id ?? 'none'} dark={dark} />
              : <div className="scene-empty"><Ruler size={28} aria-hidden="true" /><p>Enter your land size and it appears here, to scale.</p></div>}
            {plot && (
              <div className="scene-hud">
                <span className="pill"><Ruler size={13} aria-hidden="true" /> {plot.widthM} × {plot.depthM} m · {(plot.widthM * plot.depthM).toFixed(0)} m²</span>
                <span className="pill">1 grid square = 1 m</span>
                {design && step !== 'land' && step !== 'plan' && <span className="pill">House {design.footprint.w.toFixed(1)} × {design.footprint.d.toFixed(1)} m</span>}
              </div>
            )}
          </div>
          {plot && <p className="small muted scene-hint">Drag to turn, scroll or pinch to zoom. The dashed line shows the building setbacks.</p>}
        </section>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- steps

type StepRef = React.RefObject<HTMLHeadingElement | null>;

function StepHead({ stepRef, kicker, title, children }: { stepRef: StepRef; kicker: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="stack-sm">
      <p className="kicker">{kicker}</p>
      <h1 id="step-h" ref={stepRef} tabIndex={-1}>{title}</h1>
      {children && <p className="muted">{children}</p>}
    </header>
  );
}

function Nav({ onBack, onNext, next = 'Continue', disabled }: { onBack?: () => void; onNext?: () => void; next?: string; disabled?: boolean }) {
  return (
    <div className="build-nav">
      {onBack ? <button type="button" className="btn btn-ghost" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Back</button> : <span />}
      {onNext && <button type="button" className="btn btn-primary" onClick={onNext} disabled={disabled}>{next} <ArrowRight size={16} aria-hidden="true" /></button>}
    </div>
  );
}

function LandStep({ plot, unit, setUnit, setPlot, stepRef, chat, onNext }: { plot: Plot | null; unit: 'ft' | 'm'; setUnit: (u: 'ft' | 'm') => void; setPlot: (p: Plot | null) => void; stepRef: StepRef; chat: Chat[]; onNext: () => void }) {
  const k = unit === 'ft' ? FT : 1;
  const [w, setW] = useState(plot ? String(+(plot.widthM / k).toFixed(1)) : '');
  const [d, setD] = useState(plot ? String(+(plot.depthM / k).toFixed(1)) : '');
  const apply = (ws: string, ds: string, u = unit) => {
    const kk = u === 'ft' ? FT : 1;
    const a = Number(ws) * kk; const b = Number(ds) * kk;
    const p = { widthM: +a.toFixed(2), depthM: +b.toFixed(2) };
    setPlot(ws && ds && validPlot(p) ? p : null);
  };
  const lastReply = [...chat].reverse().find((c) => c.from === 'assistant');
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Step 1 of 6" title="How big is your land?">Enter the width along the road and the depth. The plot appears in 3D as you type.</StepHead>
      {lastReply && <p className="assistant-note"><Bot size={16} aria-hidden="true" /> {lastReply.text}</p>}
      <fieldset className="unit-toggle">
        <legend className="sr-only">Units</legend>
        {(['ft', 'm'] as const).map((u) => (
          <label key={u} className={`seg${unit === u ? ' on' : ''}`}>
            <input type="radio" name="unit" value={u} checked={unit === u} onChange={() => {
              const conv = (v: string) => (v ? String(+((Number(v) * (unit === 'ft' ? FT : 1)) / (u === 'ft' ? FT : 1)).toFixed(1)) : v);
              const nw = conv(w); const nd = conv(d);
              setUnit(u); setW(nw); setD(nd); apply(nw, nd, u);
            }} />{u === 'ft' ? 'Feet' : 'Metres'}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <div className="field">
          <label htmlFor="plot-w">Width (frontage), {unit}</label>
          <input id="plot-w" inputMode="decimal" value={w} onChange={(e) => { setW(e.target.value); apply(e.target.value, d); }} placeholder={unit === 'ft' ? '50' : '15'} />
        </div>
        <div className="field">
          <label htmlFor="plot-d">Depth, {unit}</label>
          <input id="plot-d" inputMode="decimal" value={d} onChange={(e) => { setD(e.target.value); apply(w, e.target.value); }} placeholder={unit === 'ft' ? '100' : '30'} />
        </div>
      </div>
      <div className="chips" role="group" aria-label="Common plot sizes">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="chip" onClick={() => { setUnit(p.unit); setW(String(p.w)); setD(String(p.d)); apply(String(p.w), String(p.d), p.unit); }}>{p.label}</button>
        ))}
      </div>
      {plot && <p className="small muted" role="status">{plot.widthM} m × {plot.depthM} m = {(plot.widthM * plot.depthM).toFixed(0)} m² ({((plot.widthM * plot.depthM) / (FT * FT)).toFixed(0)} sq ft)</p>}
      <Nav onNext={onNext} disabled={!plot} />
    </div>
  );
}

function PlanStep({ stepRef, onBack, onNext }: { stepRef: StepRef; onBack: () => void; onNext: () => void }) {
  const [has, setHas] = useState<boolean | null>(null);
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Step 2 of 6" title="Do you already have an architectural plan?" />
      <div className="choice-grid">
        <button type="button" className={`choice${has === false ? ' on' : ''}`} onClick={() => { setHas(false); onNext(); }}>
          <Wand2 aria-hidden="true" /><strong>No, design one for me</strong><span>Tell us what you want and we generate designs that meet planning and building rules.</span>
        </button>
        <button type="button" className={`choice${has ? ' on' : ''}`} onClick={() => setHas(true)}>
          <FileUp aria-hidden="true" /><strong>Yes, I have a plan</strong><span>Build your existing drawings in 3D on your land.</span>
        </button>
      </div>
      {has && (
        <div className="notice" role="status">
          <p style={{ margin: 0 }}><strong>Reading uploaded plans is coming in the next update.</strong> For now, describe your plan (rooms, storeys) on the next step and we will model it, or pick the closest generated design.</p>
        </div>
      )}
      <Nav onBack={onBack} onNext={has ? onNext : undefined} />
    </div>
  );
}

function Stepper({ id, label, value, min, max, onChange }: { id: string; label: string; value: number; min: number; max: number; onChange: (n: number) => void }) {
  return (
    <div className="field stepper">
      <span id={id} className="label">{label}</span>
      <div role="group" aria-labelledby={id}>
        <button type="button" className="btn btn-small" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
        <output aria-live="polite">{value}</output>
        <button type="button" className="btn btn-small" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
      </div>
    </div>
  );
}

function BriefStep({ stepRef, brief, setBrief, chat, busy, ask, aiOn, notes, count, onBack, onNext }: {
  stepRef: StepRef; brief: DesignBrief; setBrief: (f: (b: DesignBrief) => DesignBrief) => void; chat: Chat[]; busy: boolean; ask: (m: string) => Promise<unknown>; aiOn: boolean; notes: string[]; count: number; onBack: () => void; onNext: () => void;
}) {
  const set = <K extends keyof DesignBrief>(k: K, v: DesignBrief[K]) => setBrief((b) => normaliseBrief({ ...b, [k]: v }));
  const [msg, setMsg] = useState('');
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [chat.length]);
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Step 3 of 6" title="Tell us about your home">Describe it in your own words or use the controls. The house updates on your land as you go.</StepHead>
      <div className="assistant card-inset">
        <div className="assistant-log" ref={log} aria-live="polite">
          {chat.length === 0 && <p className="muted small"><Sparkles size={14} aria-hidden="true" /> Try “4 bedrooms, two storeys, open-plan kitchen and a home office”.</p>}
          {chat.map((c, i) => <p key={i} className={`bubble ${c.from}`}><span className="sr-only">{c.from === 'you' ? 'You:' : 'Assistant:'} </span>{c.text}</p>)}
          {busy && <p className="bubble assistant muted">Thinking…</p>}
        </div>
        <form className="assistant-form" onSubmit={(e) => { e.preventDefault(); const m = msg.trim(); if (m) { setMsg(''); void ask(m); } }}>
          <label htmlFor="assist-msg" className="sr-only">Describe your home</label>
          <input id="assist-msg" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="Describe your home…" autoComplete="off" maxLength={2000} />
          <button className="btn btn-primary" type="submit" disabled={busy || !msg.trim()} aria-label="Send"><Send size={16} aria-hidden="true" /></button>
        </form>
        {!aiOn && <p className="small muted" style={{ margin: 0 }}>The AI assistant is not connected on this site yet; your words are read by simple rules.</p>}
      </div>

      <div className="brief-grid">
        <fieldset className="field">
          <legend className="label">Storeys</legend>
          <div className="segs">
            {([1, 2] as const).map((n) => <label key={n} className={`seg${brief.storeys === n ? ' on' : ''}`}><input type="radio" name="storeys" checked={brief.storeys === n} onChange={() => set('storeys', n)} />{n === 1 ? 'Bungalow' : 'Two storeys'}</label>)}
          </div>
        </fieldset>
        <Stepper id="st-bed" label="Bedrooms" value={brief.bedrooms} min={1} max={6} onChange={(n) => set('bedrooms', n)} />
        <Stepper id="st-bath" label="Shared bathrooms" value={brief.bathrooms} min={0} max={4} onChange={(n) => set('bathrooms', n)} />
        <Stepper id="st-park" label="Parking spaces" value={brief.parking} min={0} max={2} onChange={(n) => set('parking', n as 0 | 1 | 2)} />
        <fieldset className="field">
          <legend className="label">Kitchen</legend>
          <div className="segs">
            {(['closed', 'open'] as const).map((k) => <label key={k} className={`seg${brief.kitchen === k ? ' on' : ''}`}><input type="radio" name="kitchen" checked={brief.kitchen === k} onChange={() => set('kitchen', k)} />{k === 'open' ? 'Open plan' : 'Separate'}</label>)}
          </div>
        </fieldset>
        <div className="field">
          <label htmlFor="b-roof" className="label">Roof</label>
          <select id="b-roof" value={brief.roof} onChange={(e) => set('roof', e.target.value as DesignBrief['roof'])}>
            <option value="hip">Hip (sloped on all sides)</option><option value="gable">Gable (two slopes)</option><option value="flat">Flat with parapet</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="b-style" className="label">Style</label>
          <select id="b-style" value={brief.style} onChange={(e) => set('style', e.target.value as DesignBrief['style'])}>
            <option value="modern">Modern</option><option value="classic">Classic</option><option value="tropical">Tropical</option>
          </select>
        </div>
        <fieldset className="field checks">
          <legend className="label">Also include</legend>
          {([['ensuite', 'Ensuite for the master bedroom'], ['study', 'Study or home office'], ['guestWc', 'Guest toilet'], ['store', 'Store room']] as const).map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" checked={brief[k]} onChange={(e) => set(k, e.target.checked)} /> {l}</label>
          ))}
        </fieldset>
      </div>
      {notes.map((n) => <p key={n} className="notice notice-warn small" role="status">{n}</p>)}
      <Nav onBack={onBack} onNext={onNext} next={count ? `See ${count} design${count > 1 ? 's' : ''}` : 'Nothing fits yet'} disabled={!count} />
    </div>
  );
}

function DesignsStep({ stepRef, result, design, setDesignId, view, setView, onBack, onNext }: {
  stepRef: StepRef; result: { designs: Design[]; notes: string[] }; design: Design | null; setDesignId: (id: string) => void; view: View; setView: (v: View) => void; onBack: () => void; onNext: () => void;
}) {
  if (!design) return (<div className="stack"><StepHead stepRef={stepRef} kicker="Step 4 of 6" title="No design fits yet" />{result.notes.map((n) => <p key={n} className="notice notice-warn">{n}</p>)}<Nav onBack={onBack} /></div>);
  const warns = design.checks.filter((c) => c.status !== 'pass');
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Step 4 of 6" title="Choose a design">Each design is drawn to scale on your land and checked against the rules an architect checks first.</StepHead>
      <fieldset className="design-list">
        <legend className="sr-only">Designs</legend>
        {result.designs.map((d) => (
          <label key={d.id} className={`design-card${d.id === design.id ? ' on' : ''}`}>
            <input type="radio" name="design" checked={d.id === design.id} onChange={() => { setDesignId(d.id); setView('outside'); }} />
            <span className="design-name">{d.name}</span>
            <span className="small muted">{d.summary}</span>
            <span className="design-stats small">
              <span>{d.metrics.grossFloorM2} m² floor</span><span>{d.footprint.w.toFixed(1)} × {d.footprint.d.toFixed(1)} m</span><span>{d.metrics.coveragePct}% of plot</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="segs" role="group" aria-label="3D view">
        <button type="button" className={`seg${view === 'outside' ? ' on' : ''}`} aria-pressed={view === 'outside'} onClick={() => setView('outside')}>Outside</button>
        {Array.from({ length: design.storeys }, (_, s) => (
          <button key={s} type="button" className={`seg${view === s ? ' on' : ''}`} aria-pressed={view === s} onClick={() => setView(s)}><Layers size={14} aria-hidden="true" /> {s === 0 ? 'Ground floor plan' : 'First floor plan'}</button>
        ))}
      </div>
      <details className="checklist" open>
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
            <tbody>{design.rooms.filter((r) => r.kind !== 'corridor').map((r) => <tr key={r.id}><td>{r.name}</td><td>{r.storey === 0 ? 'Ground' : 'First'}</td><td>{r.w.toFixed(1)} × {r.d.toFixed(1)} m</td><td>{(r.w * r.d).toFixed(1)} m²</td></tr>)}</tbody>
          </table>
        </div>
      </details>
      <p className="small muted"><CircleAlert size={14} aria-hidden="true" /> These are concept designs, not construction drawings. Before you build, a registered architect should prepare stamped drawings for your building permit, and a structural engineer should size the foundations and frame.</p>
      <Nav onBack={onBack} onNext={onNext} next="List the materials" />
    </div>
  );
}

function fmtQty(n: number) { return Number.isInteger(n) ? n.toLocaleString('en') : n.toLocaleString('en', { maximumFractionDigits: 1 }); }

function MaterialsStep({ stepRef, design, bom, onBack, onNext }: { stepRef: StepRef; design: Design; bom: MaterialLine[]; onBack: () => void; onNext: () => void }) {
  const sections = [...new Set(bom.map((l) => l.section))];
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Step 5 of 6" title="Everything you need to build it">Quantities for the {design.name.toLowerCase()} design, {design.metrics.grossFloorM2} m², from the foundations up. Each line shows how it was worked out.</StepHead>
      {sections.map((sec) => (
        <section key={sec} aria-labelledby={`sec-${sec}`} className="stack-sm">
          <h2 id={`sec-${sec}`} className="h-sub">{SECTION_LABEL[sec]}</h2>
          <div className="table-wrap">
            <table className="table bom">
              <thead><tr><th scope="col">Item</th><th scope="col" className="num">Quantity</th></tr></thead>
              <tbody>
                {bom.filter((l) => l.section === sec).map((l) => (
                  <tr key={l.key}>
                    <td>{l.name}{l.provisional && <span className="tag-soft">Provisional</span>}<span className="basis">{l.basis}</span></td>
                    <td className="num"><strong>{fmtQty(l.quantity)}</strong> {l.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="small muted">Quantities are estimates with typical waste allowances. Labour, transport and items marked provisional depend on your site and trades; confirm with a quantity surveyor before ordering in bulk.</p>
      <Nav onBack={onBack} onNext={onNext} next="Find where to buy" />
    </div>
  );
}

function BuyStep({ stepRef, bom, onBack }: { stepRef: StepRef; bom: MaterialLine[]; onBack: () => void }) {
  const [data, setData] = useState<Sourcing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    call<Sourcing>('/v1/build/sourcing', { body: { items: bom.map(({ key, name, unit, quantity, shop }) => ({ key, name, unit, quantity, shop })) } })
      .then((r) => { if (alive) setData(r); }).catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [bom]);
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Step 6 of 6" title="Where to buy, and what it costs">Live prices from sellers on BuildWise for each item, cheapest comparable offer first.</StepHead>
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
      {!data && !error && <p className="muted" role="status">Finding sellers…</p>}
      {data && (
        <>
          <div className="buy-total card-inset" role="status">
            <ShoppingCart size={20} aria-hidden="true" />
            <div>
              <strong className="big">{money(data.total)}</strong>
              <span className="small muted">for the {data.pricedLines} of {data.lines.length} items with a matching price. Others need a quote or are not listed yet.</span>
            </div>
          </div>
          <ul className="plain stack buy-list">
            {[...data.lines].sort((a, b) => Number(b.offers.length > 0) - Number(a.offers.length > 0)).map((l) => (
              <li key={l.key} className="buy-line">
                <div className="buy-head"><strong>{l.name}</strong><span className="muted">{fmtQty(l.quantity)} {l.unit}</span></div>
                {l.offers.length === 0
                  ? <p className="small muted" style={{ margin: 0 }}>No listings yet. <Link href={l.searchPath}>Search the marketplace</Link> or post a request later.</p>
                  : (
                    <ul className="plain offers">
                      {l.offers.map((o) => (
                        <li key={o.listingId}>
                          <Link href={o.path} className="offer">
                            <span className="offer-title">{o.title}{o.promoted && <span className="tag-soft">Promoted</span>}</span>
                            <span className="small muted">{o.sellerName ?? 'Seller'}{o.area ? ` · ${o.area}` : ''}{o.deliveryOffered ? ' · Delivers' : ''}</span>
                            <span className="offer-price">{o.price ? `${money(o.price)} / ${o.unitLabel}` : 'Quote on request'}{o.lineTotal && <strong> = {money(o.lineTotal)}</strong>}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
              </li>
            ))}
          </ul>
          <p className="small muted">Prices are what sellers list today and can change. BuildWise never takes payment for goods: agree delivery and inspect before you pay.</p>
        </>
      )}
      <Nav onBack={onBack} />
    </div>
  );
}
