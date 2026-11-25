'use client';
import { useState } from 'react';
import {
  Briefcase, Building, Building2, Church, Home, Hospital, Hotel, Layers, MapPin, PartyPopper, Rows3, School, Search, Store, Wand2, Warehouse,
} from 'lucide-react';
import {
  BUILDING_FAMILIES, BUILDING_TYPES, BUILDING_TYPE_KEYS, FEATURES, FT, TASTES, TASTE_KEYS, PRIORITIES, PRIORITY_KEYS, chooseTaste, describePreferences, purposeQuestion, tasteBrief, isHouse, needsLift, suggestedParking, validPlot,
  type BuildingFamily, type BuildingType, type DesignBrief, type FeatureKey, type FinishBand, type Plot, type ProjectRecord, type Taste, type Purpose,
} from '@bw/domain';
import { fmtMinor } from './planning-ui';
import { Nav, StepHead, type StepRef } from './ui';

export const TYPE_ICON: Record<BuildingType, typeof Home> = {
  bungalow: Home, duplex: Building2, terrace: Rows3, apartments: Building, shops: Store, office: Briefcase, 'mixed-use': Layers,
  warehouse: Warehouse, hotel: Hotel, 'event-hall': PartyPopper, school: School, clinic: Hospital, worship: Church,
};

const PRESETS: { label: string; w: number; d: number; unit: 'ft' | 'm' }[] = [
  { label: '50 × 100 ft (full plot)', w: 50, d: 100, unit: 'ft' },
  { label: '60 × 120 ft', w: 60, d: 120, unit: 'ft' },
  { label: '100 × 100 ft (two plots)', w: 100, d: 100, unit: 'ft' },
  { label: '30 × 60 ft (half plot)', w: 30, d: 60, unit: 'ft' },
  { label: '30 × 40 m', w: 30, d: 40, unit: 'm' },
];

// ---------------------------------------------------------------- 1. what

/** Step 1: what to build, picked from pictures (or described in a sentence, which picks for you). */
export function WhatStep({ stepRef, kicker, type, purpose, onPurpose, onPick, onDescribe }: {
  stepRef: StepRef; kicker: string; type: BuildingType | null; purpose: Purpose | null; onPurpose: (p: Purpose) => void; onPick: (t: BuildingType) => void; onDescribe: (text: string) => void;
}) {
  const [family, setFamily] = useState<BuildingFamily>(type ? BUILDING_TYPES[type].family : 'home');
  const [text, setText] = useState('');
  const types = BUILDING_TYPE_KEYS.filter((t) => BUILDING_TYPES[t].family === family);
  const purposeOptions = type && purposeQuestion(type);
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker={kicker} title="What are you building?">Pick one. BuildWise does the designing: you only choose the plot, the size and a few extras.</StepHead>
      <div className="segs family-tabs" role="tablist" aria-label="Kinds of building">
        {(Object.keys(BUILDING_FAMILIES) as BuildingFamily[]).map((f) => (
          <button key={f} type="button" role="tab" aria-selected={family === f} className={`seg${family === f ? ' on' : ''}`} onClick={() => setFamily(f)}>{BUILDING_FAMILIES[f].label}</button>
        ))}
      </div>
      <ul className="plain type-grid" aria-label={BUILDING_FAMILIES[family].label}>
        {types.map((t) => {
          const Icon = TYPE_ICON[t];
          const info = BUILDING_TYPES[t];
          const floors = info.storeys.min === info.storeys.max ? `${info.storeys.min} storey` : `${info.storeys.min}–${info.storeys.max} storeys`;
          return (
            <li key={t}>
              <button type="button" className={`type-card${type === t ? ' on' : ''}`} aria-pressed={type === t} onClick={() => onPick(t)}>
                <span className="type-icon" aria-hidden="true"><Icon size={26} /></span>
                <strong>{info.label}</strong>
                <span className="small muted">{info.blurb}</span>
                <span className="small type-floors">{floors}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {purposeOptions && <fieldset className="field">
        <legend className="label">{purposeOptions.question}</legend>
        <div className="chips">{purposeOptions.options.map(({ key, label }) => (
          <button type="button" key={key} className="chip" aria-pressed={purpose === key} onClick={() => onPurpose(key)}>{label}</button>
        ))}</div>
      </fieldset>}
      <details className="describe">
        <summary className="small">Or describe it in a sentence</summary>
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (text.trim()) onDescribe(text.trim()); }}>
          <div className="field grow">
            <label htmlFor="describe" className="sr-only">Describe what you want to build</label>
            <input id="describe" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="e.g. a 4-storey hotel with 40 rooms on a 100 by 120 ft plot" />
          </div>
          <button type="submit" className="btn" disabled={!text.trim()}><Wand2 size={16} aria-hidden="true" /> Use this</button>
        </form>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------- 2. where

/** Step 2: the land (size, shown to scale) and where it is. */
export function WhereStep({ stepRef, kicker, plot, unit, setUnit, setPlot, project, setProject, onBack, onNext }: {
  stepRef: StepRef; kicker: string; plot: Plot | null; unit: 'ft' | 'm'; setUnit: (u: 'ft' | 'm') => void; setPlot: (p: Plot | null) => void;
  project: ProjectRecord; setProject: (f: (p: ProjectRecord) => ProjectRecord) => void; onBack: () => void; onNext: () => void;
}) {
  const k = unit === 'ft' ? FT : 1;
  const [w, setW] = useState(plot ? String(+(plot.widthM / k).toFixed(1)) : '');
  const [d, setD] = useState(plot ? String(+(plot.depthM / k).toFixed(1)) : '');
  const apply = (ws: string, ds: string, u = unit) => {
    const kk = u === 'ft' ? FT : 1;
    const p = { widthM: +(Number(ws) * kk).toFixed(2), depthM: +(Number(ds) * kk).toFixed(2) };
    setPlot(ws && ds && validPlot(p) ? p : null);
  };
  const setLoc = (key: keyof ProjectRecord['location'], v: string) => setProject((p) => ({ ...p, location: { ...p.location, [key]: v } }));
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker={kicker} title="Where will it stand?">The width along the road and the depth. Your land appears in 3D, to scale, as you type.</StepHead>
      <div className="chips" role="group" aria-label="Common plot sizes">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="chip" onClick={() => { setUnit(p.unit); setW(String(p.w)); setD(String(p.d)); apply(String(p.w), String(p.d), p.unit); }}>{p.label}</button>
        ))}
      </div>
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
      {plot && <p className="small muted" role="status">{plot.widthM} m × {plot.depthM} m = {(plot.widthM * plot.depthM).toFixed(0)} m² ({((plot.widthM * plot.depthM) / (FT * FT)).toFixed(0)} sq ft)</p>}
      <div className="row wrap">
        <div className="field">
          <label htmlFor="loc-city" className="small"><MapPin size={13} aria-hidden="true" /> Town or city (optional)</label>
          <input id="loc-city" value={project.location.city} maxLength={60} onChange={(e) => setLoc('city', e.target.value)} placeholder="e.g. Ibadan" />
        </div>
        <div className="field">
          <label htmlFor="loc-state" className="small">State, province or region (optional)</label>
          <input id="loc-state" value={project.location.state} maxLength={60} onChange={(e) => setLoc('state', e.target.value)} placeholder="e.g. Oyo" />
        </div>
        <div className="field">
          <label htmlFor="loc-country" className="small">Country (optional)</label>
          <input id="loc-country" value={project.location.country} maxLength={60} onChange={(e) => setLoc('country', e.target.value)} />
        </div>
      </div>
      <p className="small muted">Location is optional for your project record. Plan search works worldwide.</p>
      <button type="button" className="chip" aria-pressed={project.preferences.plotUnknown} onClick={() => {
        setW(''); setD(''); setPlot(null);
        setProject((p) => ({ ...p, preferences: { ...p.preferences, plotUnknown: true } }));
      }}>I don’t know my plot size yet</button>
      <Nav onBack={onBack} onNext={onNext} next="Next: make it yours" disabled={!plot && !project.preferences.plotUnknown} />
    </div>
  );
}

// ---------------------------------------------------------------- 3. make it yours

export function Stepper({ id, label, value, min, max, step = 1, format, onChange }: {
  id: string; label: string; value: number; min: number; max: number; step?: number; format?: (n: number) => string; onChange: (n: number) => void;
}) {
  return (
    <div className="field stepper">
      <span id={id} className="label">{label}</span>
      <div role="group" aria-labelledby={id}>
        <button type="button" className="btn btn-small" aria-label={`Fewer: ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
        <output aria-live="polite">{format ? format(value) : value}</output>
        <button type="button" className="btn btn-small" aria-label={`More: ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
      </div>
    </div>
  );
}

const FINISHES: { key: FinishBand; label: string; blurb: string }[] = [
  { key: 'basic', label: 'Basic', blurb: 'Simple, durable finishes' },
  { key: 'standard', label: 'Standard', blurb: 'Good tiles, fittings and ceilings' },
  { key: 'premium', label: 'Premium', blurb: 'High-end finishes and fittings' },
];

/** Step 3: the few choices that matter for this kind of building, then a search for published plans. */
export function YoursStep({ stepRef, kicker, brief, setBrief, project, setProject, currency, onBack, onFindPlans }: {
  stepRef: StepRef; kicker: string; brief: DesignBrief; setBrief: (patch: Partial<DesignBrief>) => void;
  project: ProjectRecord; setProject: (f: (p: ProjectRecord) => ProjectRecord) => void; currency: string;
  onBack: () => void; onFindPlans: () => void;
}) {
  const info = BUILDING_TYPES[brief.type];
  const house = isHouse(brief.type);
  const pickTaste = (taste: Taste, tasteChosenForMe = false) => {
    setBrief(tasteBrief(taste, project.decisions.some((d) => d.topic === 'roof' && d.status === 'confirmed')));
    setProject((p) => ({ ...p, preferences: { ...p.preferences, taste, tasteChosenForMe } }));
  };
  const toggle = (f: FeatureKey) => setBrief({ features: brief.features.includes(f) ? brief.features.filter((x) => x !== f) : [...brief.features, f] });
  const setBudget = (minor: number | null) => setProject((p) => ({ ...p, budget: { ...p.budget, amountMinor: minor } }));
  const toMinor = (s: string) => (s.trim() === '' ? null : Math.max(0, Math.round(Number(s.replace(/[^\d.]/g, '')) * 100)));
  const units = info.units;
  const big = units && units.max > 24;
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker={kicker} title="What should it feel like?">{[project.location.city, describePreferences(project.preferences)].filter(Boolean).join(' · ') || 'Pick a direction and we’ll develop the design.'}</StepHead>
      <div className="style-cards taste-cards" role="group" aria-label="Building taste">
        {TASTE_KEYS.map((key) => <button key={key} type="button" className={`style-card${project.preferences.taste === key ? ' on' : ''}`} aria-pressed={project.preferences.taste === key} onClick={() => pickTaste(key)}>
          <span className="swatches" aria-hidden="true">{TASTES[key].swatches.map((c) => <span key={c.name} style={{ background: c.hex }} />)}</span>
          <strong>{TASTES[key].label}</strong><span className="small muted">{TASTES[key].blurb}</span>
        </button>)}
      </div>
      <button className="btn btn-ghost" type="button" aria-pressed={project.preferences.tasteChosenForMe} onClick={() => pickTaste(chooseTaste(brief.type, project.preferences.purpose), true)}>Choose for me</button>
      <fieldset className="field">
        <legend className="label">What matters most? <span className="muted">Optional</span></legend>
        <div className="chips">{PRIORITY_KEYS.map((key) => <button key={key} type="button" aria-pressed={project.preferences.priorities.includes(key)} className={`chip${project.preferences.priorities.includes(key) ? ' on' : ''}`} onClick={() => setProject((p) => {
          const priorities = p.preferences.priorities;
          return { ...p, preferences: { ...p.preferences, priorities: priorities.includes(key) ? priorities.filter((it) => it !== key) : [...priorities, key] } };
        })}>{PRIORITIES[key].label}</button>)}</div>
      </fieldset>
      <details className="checklist stack"><summary><strong>Add details</strong></summary>
      <div className="brief-grid">
        {info.storeys.max > info.storeys.min && (
          <Stepper id="st-storeys" label="Storeys" value={brief.storeys} min={info.storeys.min} max={info.storeys.max}
            format={(n) => (n === 1 ? '1 (ground only)' : `${n} (G+${n - 1})`)} onChange={(n) => setBrief({ storeys: n })} />
        )}
        {units && (
          big
            ? (
              <div className="field">
                <label htmlFor="units" className="label">{units.label}: <strong>{brief.units.toLocaleString('en')}</strong></label>
                <input id="units" type="range" min={units.min} max={units.max} step={units.step} value={brief.units} onChange={(e) => setBrief({ units: Number(e.target.value) })} />
              </div>
            )
            : <Stepper id="st-units" label={units.label} value={brief.units} min={units.min} max={units.max} step={units.step} onChange={(n) => setBrief({ units: n })} />
        )}
        {info.bedrooms && <Stepper id="st-bed" label={info.bedrooms.label} value={brief.bedrooms} min={info.bedrooms.min} max={info.bedrooms.max} onChange={(n) => setBrief({ bedrooms: n })} />}
        <Stepper id="st-park" label="Parking spaces" value={brief.parking} min={0} max={house ? 2 : 60} onChange={(n) => setBrief({ parking: n })} />
      </div>
      {!house && brief.parking !== suggestedParking(brief.type, brief.storeys, brief.units) && (
        <p className="small muted">Planning offices often ask for about {suggestedParking(brief.type, brief.storeys, brief.units)} spaces for this. <button type="button" className="btn btn-small btn-ghost" onClick={() => setBrief({ parking: suggestedParking(brief.type, brief.storeys, brief.units) })}>Use that</button></p>
      )}

      {info.features.length > 0 && (
        <fieldset className="field">
          <legend className="label">Extras</legend>
          <div className="chips">
            {info.features.map((f) => {
              // A building this tall gets a lift whatever is chosen: show it as included.
              const auto = f === 'lift' && !brief.features.includes('lift') && needsLift(brief.type, brief.storeys, []);
              return auto
                ? <span key={f} className="chip on" title="Added automatically for this height">{FEATURES[f].label} · included</span>
                : <button key={f} type="button" className={`chip${brief.features.includes(f) ? ' on' : ''}`} aria-pressed={brief.features.includes(f)} title={FEATURES[f].blurb} onClick={() => toggle(f)}>{FEATURES[f].label}</button>;
            })}
          </div>
        </fieldset>
      )}

      {house && (
        <details className="checklist">
          <summary><strong>More about the rooms</strong> <span className="small muted">optional</span></summary>
          <div className="brief-grid">
            <Stepper id="st-bath" label="Shared bathrooms" value={brief.bathrooms} min={0} max={4} onChange={(n) => setBrief({ bathrooms: n })} />
            <fieldset className="field">
              <legend className="label">Kitchen</legend>
              <div className="segs">
                {(['closed', 'open'] as const).map((k) => <label key={k} className={`seg${brief.kitchen === k ? ' on' : ''}`}><input type="radio" name="kitchen" checked={brief.kitchen === k} onChange={() => setBrief({ kitchen: k })} />{k === 'open' ? 'Open plan' : 'Separate'}</label>)}
              </div>
            </fieldset>
            <fieldset className="field checks">
              <legend className="label">Also include</legend>
              {([['ensuite', 'Ensuite for the master bedroom'], ['study', 'Study or home office'], ['guestWc', 'Guest toilet'], ['store', 'Store room'], ['bq', "Boys' quarters (detached, at the back)"]] as const).map(([key, l]) => (
                <label key={key} className="check"><input type="checkbox" checked={brief[key]} onChange={(e) => setBrief({ [key]: e.target.checked })} /> {l}</label>
              ))}
            </fieldset>
          </div>
        </details>
      )}

      <div className="brief-grid">
        <div className="field">
          <label htmlFor="budget" className="label">Budget ({currency}, optional)</label>
          <input id="budget" inputMode="numeric" value={project.budget.amountMinor === null ? '' : String(Math.round(project.budget.amountMinor / 100))} onChange={(e) => setBudget(toMinor(e.target.value))} placeholder="e.g. 80000000" />
          {project.budget.amountMinor !== null && <span className="small muted">{fmtMinor(project.budget.amountMinor, currency)}</span>}
        </div>
        <fieldset className="field">
          <legend className="label">Finish level</legend>
          <div className="segs">
            {FINISHES.map((f) => <label key={f.key} className={`seg${project.budget.finish === f.key ? ' on' : ''}`} title={f.blurb}><input type="radio" name="finish" checked={project.budget.finish === f.key} onChange={() => setProject((p) => ({ ...p, budget: { ...p.budget, finish: f.key } }))} />{f.label}</label>)}
          </div>
        </fieldset>
      </div>

      </details>
      <div className="generate-bar card-inset">
        <p className="small" role="status" style={{ margin: 0 }}>
          Find published plans for your taste and priorities.
        </p>
        <div className="build-nav">
          <button type="button" className="btn btn-ghost" onClick={onBack}>Back</button>
          <button type="button" className="btn btn-primary btn-big" onClick={onFindPlans} disabled={!project.preferences.taste}><Search size={18} aria-hidden="true" /> Find plans</button>
        </div>
      </div>
    </div>
  );
}
