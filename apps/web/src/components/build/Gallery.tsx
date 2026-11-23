'use client';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import {
  BUILDING_TYPES, BUILDING_TYPE_KEYS, DEFAULT_DESIGN_CONFIG, FT, WET, candidateDesigns, planningAnalysis,
  type BuildingType, type Design, type DesignBrief, type RoomKind,
} from '@bw/domain';
import type { View } from './Scene';

const Scene = dynamic(() => import('./Scene'), { ssr: false, loading: () => <div className="scene-loading">Preparing the 3D view…</div> });

/** Which part of the home a room belongs to, for colouring the plans. */
const PUBLIC: ReadonlySet<RoomKind> = new Set(['living', 'living-kitchen', 'dining', 'lounge', 'lobby', 'gaming', 'cinema', 'restaurant', 'meeting', 'hall']);
const SERVICE: ReadonlySet<RoomKind> = new Set(['kitchen', 'laundry', 'store', 'plant', 'loading']);
const zone = (k: RoomKind) => (k === 'corridor' || k === 'stair' || k === 'lift' ? 'circ' : WET.has(k) ? 'wet' : PUBLIC.has(k) ? 'public' : SERVICE.has(k) ? 'service' : 'private');

const PLOTS: { label: string; w: number; d: number }[] = [
  { label: '50 × 100 ft', w: 50 * FT, d: 100 * FT },
  { label: '60 × 120 ft', w: 60 * FT, d: 120 * FT },
  { label: '100 × 100 ft', w: 100 * FT, d: 100 * FT },
  { label: '40 × 80 ft', w: 40 * FT, d: 80 * FT },
];

/**
 * Every design the engine can make for one brief, side by side: plans coloured by zone with the planning logic's
 * conflicts marked, the scores, and any one of them in 3D. A tool for judging and improving the engine offline.
 */
export function Gallery() {
  const [plotIdx, setPlotIdx] = useState(1);
  const [type, setType] = useState<BuildingType>('duplex');
  const [storeys, setStoreys] = useState(2);
  const [bedrooms, setBedrooms] = useState(4);
  const [kitchen, setKitchen] = useState<DesignBrief['kitchen']>('closed');
  const [style, setStyle] = useState<DesignBrief['style']>('modern');
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<View>('outside');
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const html = document.documentElement;
    const sync = () => setDark(html.dataset.theme === 'dark' || (!html.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches));
    sync();
    const mo = new MutationObserver(sync); mo.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  const info = BUILDING_TYPES[type];
  const p = PLOTS[plotIdx]!;
  const plot = useMemo(() => ({ widthM: Math.round(p.w * 100) / 100, depthM: Math.round(p.d * 100) / 100 }), [p]);
  const brief = useMemo(() => ({ type, storeys: Math.min(info.storeys.max, Math.max(info.storeys.min, storeys)), bedrooms, kitchen, style }), [type, storeys, bedrooms, kitchen, style, info]);
  const designs = useMemo(() => candidateDesigns(plot, brief), [plot, brief]);
  const current = designs.find((d) => d.id === chosen) ?? designs[0] ?? null;
  const house = type === 'bungalow' || type === 'duplex';

  return (
    <div className="stack gallery">
      <header className="stack-sm">
        <p className="kicker">Design engine</p>
        <h1>Every option, side by side</h1>
        <p className="muted">All the designs BuildWise&rsquo;s own engine makes for one brief, without any AI service: plans coloured by zone, planning conflicts marked in red, and any of them in 3D. Uses the default building rules.</p>
      </header>

      <form className="card gal-controls" onSubmit={(e) => e.preventDefault()} aria-label="Brief">
        <label className="field">Plot
          <select value={plotIdx} onChange={(e) => setPlotIdx(Number(e.target.value))}>{PLOTS.map((x, i) => <option key={x.label} value={i}>{x.label}</option>)}</select>
        </label>
        <label className="field">Building
          <select value={type} onChange={(e) => { const t = e.target.value as BuildingType; setType(t); setStoreys(BUILDING_TYPES[t].storeys.min); setChosen(null); }}>
            {BUILDING_TYPE_KEYS.map((k) => <option key={k} value={k}>{BUILDING_TYPES[k].label}</option>)}
          </select>
        </label>
        <label className="field">Storeys
          <input type="number" min={info.storeys.min} max={info.storeys.max} value={brief.storeys} onChange={(e) => setStoreys(Number(e.target.value))} />
        </label>
        {house && <label className="field">Bedrooms
          <input type="number" min={1} max={8} value={bedrooms} onChange={(e) => setBedrooms(Number(e.target.value))} />
        </label>}
        {house && <label className="field">Kitchen
          <select value={kitchen} onChange={(e) => setKitchen(e.target.value as DesignBrief['kitchen'])}><option value="closed">Separate</option><option value="open">Open plan</option></select>
        </label>}
        <label className="field">Style
          <select value={style} onChange={(e) => setStyle(e.target.value as DesignBrief['style'])}><option value="modern">Modern</option><option value="tropical">Tropical</option><option value="classic">Classic</option></select>
        </label>
      </form>

      {current && (
        <section className="stack-sm" aria-labelledby="gal-3d">
          <h2 id="gal-3d" className="h-sub">{current.name} in 3D</h2>
          <div className="segs" role="group" aria-label="3D view">
            <button type="button" className={`seg${view === 'outside' ? ' on' : ''}`} aria-pressed={view === 'outside'} onClick={() => setView('outside')}>Outside</button>
            {Array.from({ length: current.storeys }, (_, s) => <button key={s} type="button" className={`seg${view === s ? ' on' : ''}`} aria-pressed={view === s} onClick={() => setView(s)}>Floor {s}</button>)}
          </div>
          <div className="scene-frame glass">
            <Scene plot={plot} setbacks={DEFAULT_DESIGN_CONFIG.setbacksM} design={current} view={view} buildKey={current.id} dark={dark} mode="photo" />
          </div>
        </section>
      )}

      <p className="small muted" role="status">{designs.length ? `${designs.length} design${designs.length > 1 ? 's' : ''} pass every check on ${p.label}.` : 'Nothing fits this plot with this brief.'}</p>
      <ul className="plain gal-grid">
        {designs.map((d, i) => <li key={d.id}><GalleryCard design={d} rank={i + 1} on={current?.id === d.id} pick={() => { setChosen(d.id); setView('outside'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} /></li>)}
      </ul>
    </div>
  );
}

function GalleryCard({ design: d, rank, on, pick }: { design: Design; rank: number; on: boolean; pick: () => void }) {
  const a = planningAnalysis(d.rooms);
  return (
    <article className={`card gal-card${on ? ' on' : ''}`} aria-label={d.name}>
      <header className="gal-head">
        <span className="gal-rank" aria-label={`Rank ${rank}`}>{rank}</span>
        <div>
          <h2 className="h-sub">{d.name}</h2>
          <p className="small muted">{d.typology} · {Math.round(d.metrics.grossFloorM2)} m² · {d.blocks.filter((b) => b.kind === 'house').map((b) => `${b.w.toFixed(1)}×${b.d.toFixed(1)}`).join(' + ')} m</p>
        </div>
      </header>
      <dl className="gal-scores small">
        <div><dt>Score</dt><dd>{d.review.score}</dd></div>
        <div><dt>Planning</dt><dd>{a.score > 0 ? '+' : ''}{a.score}</dd></div>
        <div><dt>Works</dt><dd>{a.good.length}</dd></div>
        <div><dt>Conflicts</dt><dd className={a.bad.length ? 'bad' : ''}>{a.bad.length}</dd></div>
      </dl>
      <div className="gal-plans">{Array.from({ length: d.storeys }, (_, s) => <Plan key={s} design={d} storey={s} />)}</div>
      {a.bad.length > 0 && <ul className="plain small gal-bad">{a.bad.map((r) => <li key={`${r.a}-${r.b}`}>{r.a} / {r.b}: {r.why}</li>)}</ul>}
      <p className="small">{d.review.highlights[0]}</p>
      <button type="button" className="btn btn-small" onClick={pick} aria-pressed={on}>{on ? 'Showing in 3D' : 'Show in 3D'}</button>
    </article>
  );
}

/** One floor as a plan: rooms coloured by zone, doors as gaps in light, conflicting shared walls in red. */
function Plan({ design: d, storey }: { design: Design; storey: number }) {
  const rooms = d.rooms.filter((r) => r.storey === storey);
  const fp = d.footprint;
  const pad = 0.6;
  const vb = `${fp.x - pad} ${fp.y - pad} ${fp.w + 2 * pad} ${fp.d + 2 * pad}`;
  const bad = planningAnalysis(rooms).bad;
  const badRooms = new Set(bad.flatMap((r) => [r.a, r.b]));
  const doors = d.openings.filter((o) => o.storey === storey && o.kind === 'door');
  return (
    <figure className="gal-plan">
      <svg viewBox={vb} role="img" aria-label={`${storey === 0 ? 'Ground' : `Floor ${storey}`} plan of ${d.name}`}>
        {d.blocks.filter((b) => b.storeys > storey).map((b) => <rect key={b.id} x={b.x} y={b.y} width={b.w} height={b.d} className="gp-block" />)}
        {rooms.map((r) => (
          <g key={r.id}>
            <rect x={r.x} y={r.y} width={r.w} height={r.d} className={`gp-room z-${zone(r.kind)}${badRooms.has(r.name) ? ' gp-badroom' : ''}`} />
            {r.kind !== 'corridor' && Math.min(r.w, r.d) >= 1.4 && (
              <text x={r.x + r.w / 2} y={r.y + r.d / 2} className="gp-label" textAnchor="middle" dominantBaseline="middle" fontSize={Math.min(0.55, r.w / 7)}>{r.name.replace(/^Master bedroom$/, 'Master').replace(/ room$/, '')}</text>
            )}
          </g>
        ))}
        {doors.map((o) => (o.dir === 'h'
          ? <line key={o.id} x1={o.from} x2={o.to} y1={o.at} y2={o.at} className={`gp-door${o.external ? ' ext' : ''}`} />
          : <line key={o.id} y1={o.from} y2={o.to} x1={o.at} x2={o.at} className={`gp-door${o.external ? ' ext' : ''}`} />))}
      </svg>
      <figcaption className="small muted">{storey === 0 ? 'Ground floor' : `Floor ${storey}`}</figcaption>
    </figure>
  );
}
