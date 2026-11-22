'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft, Box, Boxes, CircleAlert, Copy, Eye, Grid2x2, Layers, MousePointer2, Palette, Redo2, Save, Send, Trash2, Trees, Undo2,
} from 'lucide-react';
import {
  BUILDING_TYPES, DEFAULT_DESIGN_CONFIG, ELEMENT_KINDS, HOUSE_KINDS, MATERIALS, MATERIAL_KEYS, ROOF_OPTIONS, ROOM_KIND_LABELS,
  applyEdits, designFromLayout, designKey, generateDesigns, isHouse, layoutFromDesign, normaliseBrief, validPlot,
  type AiLayout, type AiLayoutBlock, type AiLayoutElement, type AiLayoutRoom, type DesignBrief, type DesignConfig, type DesignEdit,
  type EditableKind, type ElementKind, type Glazing, type MaterialKey, type Plot, type RoofKind,
} from '@bw/domain';
import { ApiFailure, call } from '@/lib/client';
import { softwareGl } from '../build/BuildWizard';

const Scene = dynamic(() => import('../build/Scene'), { ssr: false, loading: () => <div className="scene-loading">Preparing the 3D view…</div> });

/**
 * The Design Studio: a free editor for a whole building, in the spirit of home-design apps. A catalogue of rooms,
 * structure, outdoor architecture and materials on the left, the plan (or the 3D model) in the middle, the selected
 * item's properties and the live rule checks on the right. Everyone can edit and take the design back to their
 * build; certified architects can also publish it for sale in the marketplace.
 */
type Sel = { type: 'room' | 'element' | 'block'; index: number } | null;
type Tool = { kind: 'room'; room: EditableKind } | { kind: 'element'; element: ElementKind } | { kind: 'block' } | null;
type Tab = 'rooms' | 'structure' | 'outdoors' | 'materials';
type Drag = { mode: 'move' | 'resize'; handle: string; sel: NonNullable<Sel>; x0: number; y0: number; orig: AiLayout } | null;

const STORE_KEY = 'bw-build-v1';
const ELEMENT_LABEL: Record<ElementKind, string> = { porch: 'Porch', veranda: 'Veranda', balcony: 'Balcony', canopy: 'Canopy', pergola: 'Pergola', screen: 'Louvre screen', 'feature-wall': 'Feature wall', planter: 'Planter' };
const ELEMENT_SIZE: Record<ElementKind, [number, number, number?]> = { porch: [3.6, 2.4], veranda: [6, 2.7], balcony: [3.6, 1.5], canopy: [2.4, 1.2, 2.5], pergola: [4.2, 3, 2.7], screen: [2.4, 0.15, 6], 'feature-wall': [2.4, 0.12, 6], planter: [2.4, 0.6, 0.6] };
const snap = (n: number) => Math.round(n * 10) / 10;
const ROOM_FILL = (k: string) => (['bathroom', 'ensuite', 'wc', 'toilets', 'laundry'].includes(k) ? 'st-wet' : ['corridor', 'stair', 'lift', 'lobby'].includes(k) ? 'st-circ' : ['master', 'bedroom', 'guest-room', 'flat', 'ward'].includes(k) ? 'st-sleep' : ['store', 'plant', 'loading', 'warehouse'].includes(k) ? 'st-service' : 'st-live');

interface Loaded { plot: Plot; brief: DesignBrief; place: string; layout: AiLayout; fromBuild: boolean }

function loadFromBuild(cfg: DesignConfig): Loaded {
  let s: Record<string, any> = {};
  try { s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}'); } catch { /* fresh */ }
  const plot: Plot = s.plot && validPlot(s.plot) ? s.plot : { widthM: 18.29, depthM: 36.58 };
  const brief = normaliseBrief(s.brief ?? {});
  const loc = s.project?.location ?? {};
  const place = [loc.city, loc.state].map((x: string) => (x ?? '').trim()).filter(Boolean).join(', ').replace(/[^\p{L}\p{M} ,.'-]/gu, '').slice(0, 80);
  const ai = typeof s.designId === 'string' && s.designId.startsWith('ai-') && Array.isArray(s.aiLayouts?.layouts) ? s.aiLayouts.layouts[Number(s.designId.slice(3)) - 1] : undefined;
  if (ai) return { plot, brief, place, layout: ai, fromBuild: true };
  const { designs } = generateDesigns(plot, brief, cfg);
  const base = designs.find((d) => d.id === s.designId) ?? designs[0];
  if (!base) return { plot, brief, place, layout: { name: 'New design', idea: '', blocks: [], rooms: [], elements: [], finishes: [] }, fromBuild: false };
  const edits: DesignEdit[] = s.edits?.[designKey(plot, brief, base.id)] ?? [];
  return { plot, brief, place, layout: layoutFromDesign(applyEdits(base, edits, cfg).design), fromBuild: !!s.plot };
}

export function Studio() {
  const router = useRouter();
  const [cfg, setCfg] = useState<DesignConfig>(DEFAULT_DESIGN_CONFIG);
  const [base, setBase] = useState<Loaded | null>(null);
  const [layout, setLayoutRaw] = useState<AiLayout | null>(null);
  const [past, setPast] = useState<AiLayout[]>([]);
  const [future, setFuture] = useState<AiLayout[]>([]);
  const [sel, setSel] = useState<Sel>(null);
  const [tool, setTool] = useState<Tool>(null);
  const [tab, setTab] = useState<Tab>('rooms');
  const [storey, setStorey] = useState(0);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [dark, setDark] = useState(false);
  const [me, setMe] = useState<{ certified: boolean; orgs: { id: string; name: string; certified: boolean }[] } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const capture = useRef<(() => string | null) | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag>(null);

  useEffect(() => {
    const l = loadFromBuild(DEFAULT_DESIGN_CONFIG);
    setBase(l); setLayoutRaw(l.layout);
    call<{ design: DesignConfig }>('/v1/build/config').then((c) => setCfg(c.design)).catch(() => undefined);
    call<{ certified: boolean; orgs: { id: string; name: string; certified: boolean }[] }>('/v1/studio/me').then(setMe).catch(() => setMe(null));
    const html = document.documentElement;
    const sync = () => setDark(html.dataset.theme === 'dark' || (!html.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);

  /** Every change goes through here, so it can be undone. */
  const commit = useCallback((next: AiLayout, from?: AiLayout) => {
    setLayoutRaw((cur) => { const prev = from ?? cur; if (prev) setPast((p) => [...p.slice(-80), prev]); return next; });
    setFuture([]);
  }, []);
  const undo = () => { if (!past.length || !layout) return; setFuture((f) => [layout, ...f]); setLayoutRaw(past[past.length - 1]!); setPast((p) => p.slice(0, -1)); };
  const redo = () => { if (!future.length || !layout) return; setPast((p) => [...p, layout]); setLayoutRaw(future[0]!); setFuture((f) => f.slice(1)); };

  const checked = useMemo(() => (base && layout ? designFromLayout(base.plot, base.brief, layout, 'studio', cfg) : null), [base, layout, cfg]);
  const design = checked?.design ?? null;
  const problems = checked?.problems ?? [];
  const storeys = Math.max(1, ...(layout?.blocks ?? []).map((b) => b.storeys));

  // ---------------------------------------------------------------- editing helpers
  const rectOf = (l: AiLayout, s: NonNullable<Sel>) => (s.type === 'room' ? l.rooms[s.index] : s.type === 'element' ? l.elements?.[s.index] : l.blocks[s.index]);
  const withRect = (l: AiLayout, s: NonNullable<Sel>, r: { x: number; y: number; w: number; d: number }): AiLayout => {
    if (s.type === 'room') return { ...l, rooms: l.rooms.map((x, i) => (i === s.index ? { ...x, ...r } : x)) };
    if (s.type === 'element') return { ...l, elements: (l.elements ?? []).map((x, i) => (i === s.index ? { ...x, ...r } : x)) };
    // Moving a block carries its rooms and elements with it.
    const b = l.blocks[s.index]!; const dx = r.x - b.x; const dy = r.y - b.y; const moved = r.w === b.w && r.d === b.d;
    const inBlock = (e: { x: number; y: number; w: number; d: number }) => e.x >= b.x - 0.3 && e.y >= b.y - 0.3 && e.x + e.w <= b.x + b.w + 0.3 && e.y + e.d <= b.y + b.d + 0.3;
    return {
      ...l,
      blocks: l.blocks.map((x, i) => (i === s.index ? { ...x, ...r } : x)),
      rooms: moved ? l.rooms.map((x) => (x.block === b.id ? { ...x, x: snap(x.x + dx), y: snap(x.y + dy) } : x)) : l.rooms,
      elements: moved ? (l.elements ?? []).map((e) => (inBlock(e) || touches(e, b) ? { ...e, x: snap(e.x + dx), y: snap(e.y + dy) } : e)) : l.elements,
    };
  };
  const patchSel = (patch: Record<string, unknown>) => {
    if (!layout || !sel) return;
    if (sel.type === 'room') commit({ ...layout, rooms: layout.rooms.map((x, i) => (i === sel.index ? { ...x, ...patch } as AiLayoutRoom : x)) });
    else if (sel.type === 'element') commit({ ...layout, elements: (layout.elements ?? []).map((x, i) => (i === sel.index ? { ...x, ...patch } as AiLayoutElement : x)) });
    else commit({ ...layout, blocks: layout.blocks.map((x, i) => (i === sel.index ? { ...x, ...patch } as AiLayoutBlock : x)) });
  };
  const remove = () => {
    if (!layout || !sel) return;
    if (sel.type === 'room') commit({ ...layout, rooms: layout.rooms.filter((_, i) => i !== sel.index) });
    else if (sel.type === 'element') commit({ ...layout, elements: (layout.elements ?? []).filter((_, i) => i !== sel.index) });
    else { const id = layout.blocks[sel.index]!.id; commit({ ...layout, blocks: layout.blocks.filter((_, i) => i !== sel.index), rooms: layout.rooms.filter((r) => r.block !== id), finishes: (layout.finishes ?? []).filter((f) => f.block !== id) }); }
    setSel(null);
  };
  const duplicate = () => {
    if (!layout || !sel) return;
    if (sel.type === 'room') { const r = layout.rooms[sel.index]!; commit({ ...layout, rooms: [...layout.rooms, { ...r, name: `${r.name} copy`, x: snap(r.x + 0.6), y: snap(r.y + 0.6) }] }); setSel({ type: 'room', index: layout.rooms.length }); }
    else if (sel.type === 'element') { const e = layout.elements![sel.index]!; commit({ ...layout, elements: [...layout.elements!, { ...e, x: snap(e.x + 0.6), y: snap(e.y + 0.6) }] }); setSel({ type: 'element', index: layout.elements!.length }); }
  };

  // Keyboard: delete, nudge with the arrows (Shift: 1 m), undo and redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input, select, textarea')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
      if (!sel || !layout) { if (e.key === 'Escape') setTool(null); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); return; }
      if (e.key === 'Escape') { setSel(null); setTool(null); return; }
      const step = e.shiftKey ? 1 : 0.1;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      const mv = d[e.key];
      if (mv) { e.preventDefault(); const r = rectOf(layout, sel)!; commit(withRect(layout, sel, { x: snap(r.x + mv[0]), y: snap(r.y + mv[1]), w: r.w, d: r.d })); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ---------------------------------------------------------------- plan canvas: pointer to metres
  const toPlan = (ev: { clientX: number; clientY: number }) => {
    const el = svg.current!; const pt = el.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(el.getScreenCTM()!.inverse());
    return { x: p.x, y: base!.plot.depthM - p.y };
  };
  const startDrag = (ev: React.PointerEvent, s: NonNullable<Sel>, mode: 'move' | 'resize', handle = '') => {
    if (tool || !layout) return;
    ev.stopPropagation();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = toPlan(ev);
    setSel(s);
    drag.current = { mode, handle, sel: s, x0: p.x, y0: p.y, orig: layout };
  };
  const onMove = (ev: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const p = toPlan(ev); const dx = snap(p.x - d.x0); const dy = snap(p.y - d.y0);
    const r = rectOf(d.orig, d.sel)!;
    let n = { x: r.x, y: r.y, w: r.w, d: r.d };
    if (d.mode === 'move') n = { ...n, x: snap(r.x + dx), y: snap(r.y + dy) };
    else {
      if (d.handle.includes('w')) { n.x = snap(Math.min(r.x + r.w - 0.3, r.x + dx)); n.w = snap(r.x + r.w - n.x); }
      if (d.handle.includes('e')) n.w = snap(Math.max(0.3, r.w + dx));
      if (d.handle.includes('s')) { n.y = snap(Math.min(r.y + r.d - 0.3, r.y + dy)); n.d = snap(r.y + r.d - n.y); }
      if (d.handle.includes('n')) n.d = snap(Math.max(0.3, r.d + dy));
    }
    setLayoutRaw(withRect(d.orig, d.sel, n));
  };
  const endDrag = () => { const d = drag.current; if (!d) return; drag.current = null; if (layout && layout !== d.orig) commit(layout, d.orig); };

  const place = (ev: React.MouseEvent) => {
    if (!tool || !layout || !base) { if (ev.target === svg.current) setSel(null); return; }
    const p = toPlan(ev);
    if (tool.kind === 'room') {
      const rule = cfg.rooms[tool.room as keyof DesignConfig['rooms']];
      const side = snap(Math.max(rule?.minDimM ?? 2.4, Math.sqrt(rule?.targetM2 ?? 9)));
      const block = layout.blocks.find((b) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.d && b.storeys > storey) ?? layout.blocks[0];
      if (!block) return;
      const count = layout.rooms.filter((r) => r.kind === tool.room).length;
      commit({ ...layout, rooms: [...layout.rooms, { block: block.id, storey, kind: tool.room, name: `${ROOM_KIND_LABELS[tool.room]}${count ? ` ${count + 1}` : ''}`, x: snap(p.x - side / 2), y: snap(p.y - side / 2), w: side, d: side }] });
      setSel({ type: 'room', index: layout.rooms.length });
    } else if (tool.kind === 'element') {
      const [w, d, h] = ELEMENT_SIZE[tool.element];
      commit({ ...layout, elements: [...(layout.elements ?? []), { kind: tool.element, storey: tool.element === 'balcony' ? Math.max(1, storey) : storey, x: snap(p.x - w / 2), y: snap(p.y - d / 2), w, d, ...(h ? { heightM: h } : {}), material: tool.element === 'feature-wall' ? 'stone' : tool.element === 'balcony' ? 'metal-dark' : 'timber' }] });
      setSel({ type: 'element', index: (layout.elements ?? []).length });
    } else {
      const id = `B${layout.blocks.length + 1}`;
      commit({ ...layout, blocks: [...layout.blocks, { id, name: `Wing ${layout.blocks.length + 1}`, x: snap(p.x - 3), y: snap(p.y - 2.5), w: 6, d: 5, storeys: 1 }] });
      setSel({ type: 'block', index: layout.blocks.length });
    }
    setTool(null);
  };

  // ---------------------------------------------------------------- back to the build, publish
  const saveToBuild = () => {
    if (!layout || !base) return;
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
      // The build keys AI-style layouts by plot, brief and place; the edited design becomes the first one.
      const key = JSON.stringify({ plot: base.plot, brief: base.brief, place: base.place });
      localStorage.setItem(STORE_KEY, JSON.stringify({ ...s, plot: base.plot, brief: base.brief, picked: true, step: 'overview', designId: 'ai-1', aiLayouts: { key, layouts: [layout] } }));
    } catch { /* private mode */ }
    router.push('/build');
  };

  if (!base || !layout) return <div className="studio"><div className="scene-loading">Opening the studio…</div></div>;
  const W = base.plot.widthM; const D = base.plot.depthM; const Y = (y: number) => D - y;
  const env = design?.envelope;
  const selRect = sel ? rectOf(layout, sel) : null;
  const handles = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  const handlePos = (r: { x: number; y: number; w: number; d: number }, h: string): [number, number] => [
    h.includes('w') ? r.x : h.includes('e') ? r.x + r.w : r.x + r.w / 2,
    h.includes('n') ? r.y + r.d : h.includes('s') ? r.y : r.y + r.d / 2,
  ];
  const kinds = isHouse(base.brief.type) ? HOUSE_KINDS : (Object.keys(ROOM_KIND_LABELS) as EditableKind[]);
  const certified = !!me?.certified;

  return (
    <div className="studio">
      <header className="studio-bar">
        <button type="button" className="btn btn-small btn-ghost" onClick={saveToBuild}><ArrowLeft size={16} aria-hidden="true" /> {base.fromBuild ? 'Back to my build' : 'Use in a build'}</button>
        <input aria-label="Design name" className="studio-name" value={layout.name} maxLength={60} onChange={(e) => setLayoutRaw({ ...layout, name: e.target.value })} onBlur={() => commit({ ...layout })} />
        <div className="segs" role="group" aria-label="History">
          <button type="button" className="seg" onClick={undo} disabled={!past.length} aria-label="Undo"><Undo2 size={15} aria-hidden="true" /></button>
          <button type="button" className="seg" onClick={redo} disabled={!future.length} aria-label="Redo"><Redo2 size={15} aria-hidden="true" /></button>
        </div>
        <div className="segs" role="group" aria-label="View">
          <button type="button" className={`seg${view === '2d' ? ' on' : ''}`} aria-pressed={view === '2d'} onClick={() => setView('2d')}><Grid2x2 size={15} aria-hidden="true" /> 2D plan</button>
          <button type="button" className={`seg${view === '3d' ? ' on' : ''}`} aria-pressed={view === '3d'} onClick={() => setView('3d')}><Box size={15} aria-hidden="true" /> 3D</button>
        </div>
        <div className="segs" role="group" aria-label="Floor">
          {Array.from({ length: storeys }, (_, s) => <button key={s} type="button" className={`seg${storey === s ? ' on' : ''}`} aria-pressed={storey === s} onClick={() => { setStorey(s); setSel(null); }}><Layers size={14} aria-hidden="true" /> {s === 0 ? 'Ground' : `Floor ${s}`}</button>)}
        </div>
        <span className={`pill ${problems.length ? 'pill-warn' : 'pill-good'}`} role="status">{problems.length ? `${problems.length} to fix` : 'Passes the checks'}</span>
        <div className="studio-bar-end">
          <button type="button" className="btn btn-small" onClick={saveToBuild}><Save size={15} aria-hidden="true" /> Save to my build</button>
          {certified
            ? <button type="button" className="btn btn-small btn-primary" onClick={() => setPublishing(true)} disabled={!!problems.length} title={problems.length ? 'Fix the checks first' : undefined}><Send size={15} aria-hidden="true" /> Publish design</button>
            : <Link className="btn btn-small btn-ghost" href="/sign-in?next=/studio" title="Certified architects can sell their designs">Architect? Sign in to sell</Link>}
        </div>
      </header>

      <div className="studio-grid">
        <aside className="studio-panel card" aria-label="Catalogue">
          <div className="segs studio-tabs" role="tablist" aria-label="Catalogue">
            {([['rooms', 'Rooms', Boxes], ['structure', 'Structure', Layers], ['outdoors', 'Outdoors', Trees], ['materials', 'Materials', Palette]] as const).map(([k, label, Icon]) => (
              <button key={k} type="button" role="tab" aria-selected={tab === k} className={`seg${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}><Icon size={14} aria-hidden="true" /> {label}</button>
            ))}
          </div>
          <p className="small muted" role="status">{tool ? 'Click on the plan to place it (Esc to cancel).' : 'Pick something, then click on the plan. Drag to move, pull the handles to resize.'}</p>
          {tab === 'rooms' && (
            <ul className="plain studio-cat">
              {kinds.map((k) => <li key={k}><button type="button" className={`studio-item${tool?.kind === 'room' && tool.room === k ? ' on' : ''}`} onClick={() => { setTool({ kind: 'room', room: k }); setView('2d'); }}><span className={`swatch-dot ${ROOM_FILL(k)}`} aria-hidden="true" />{ROOM_KIND_LABELS[k]}</button></li>)}
            </ul>
          )}
          {tab === 'structure' && (
            <div className="stack-sm">
              <button type="button" className={`studio-item${tool?.kind === 'block' ? ' on' : ''}`} onClick={() => { setTool({ kind: 'block' }); setView('2d'); }}><Copy size={15} aria-hidden="true" /> Add a wing (block)</button>
              <label htmlFor="roof" className="small">Roof</label>
              <select id="roof" value={layout.roof ?? base.brief.roof} onChange={(e) => commit({ ...layout, roof: e.target.value as RoofKind })}>
                {(Object.keys(ROOF_OPTIONS) as RoofKind[]).map((k) => <option key={k} value={k}>{ROOF_OPTIONS[k].label}</option>)}
              </select>
              <p className="small muted">Select a wing on the plan to change its storeys, size and materials.</p>
            </div>
          )}
          {tab === 'outdoors' && (
            <ul className="plain studio-cat">
              {ELEMENT_KINDS.map((k) => <li key={k}><button type="button" className={`studio-item${tool?.kind === 'element' && tool.element === k ? ' on' : ''}`} onClick={() => { setTool({ kind: 'element', element: k }); setView('2d'); }}><Trees size={14} aria-hidden="true" /> {ELEMENT_LABEL[k]}</button></li>)}
            </ul>
          )}
          {tab === 'materials' && (
            <div className="stack-sm">
              {sel?.type === 'block' ? (['walls', 'base', 'accent'] as const).map((part) => {
                const b = layout.blocks[sel.index]!;
                const f = (layout.finishes ?? []).find((x) => x.block === b.id) ?? { block: b.id, walls: 'render-white' as MaterialKey };
                return (
                  <fieldset key={part} className="field">
                    <legend className="small">{part === 'walls' ? 'Walls' : part === 'base' ? 'Base (plinth)' : 'Accent (frames, trims)'}</legend>
                    <div className="studio-swatches">
                      {MATERIAL_KEYS.map((m) => (
                        <button key={m} type="button" title={MATERIALS[m].label} aria-label={`${MATERIALS[m].label} for ${part}`} aria-pressed={f[part] === m} className={`studio-swatch${f[part] === m ? ' on' : ''}`} style={{ background: MATERIALS[m].hex }}
                          onClick={() => commit({ ...layout, finishes: [...(layout.finishes ?? []).filter((x) => x.block !== b.id), { ...f, [part]: m }] })} />
                      ))}
                    </div>
                  </fieldset>
                );
              }) : <p className="small muted">Select a wing on the plan (click its outline) to choose its materials.</p>}
            </div>
          )}
        </aside>

        <section className="studio-canvas card" aria-label={view === '2d' ? 'Plan' : '3D model'}>
          {view === '2d' ? (
            <svg ref={svg} viewBox={`-1 -1 ${W + 2} ${D + 4}`} className={`studio-plan${tool ? ' placing' : ''}`} role="group" aria-label={`Plan of floor ${storey}: click an item to select it`}
              onClick={place} onPointerMove={onMove} onPointerUp={endDrag} onPointerLeave={endDrag}>
              <defs><pattern id="grid1" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 L 0 0 0 1" className="st-grid" /></pattern></defs>
              <rect x={0} y={0} width={W} height={D} className="st-plot" />
              <rect x={0} y={0} width={W} height={D} fill="url(#grid1)" />
              {env && <rect x={env.x} y={Y(env.y + env.d)} width={env.w} height={env.d} className="st-env" />}
              <rect x={-1} y={D} width={W + 2} height={3} className="st-road" />
              <text x={W / 2} y={D + 2} className="st-road-label" textAnchor="middle" fontSize={0.9}>ROAD</text>
              {layout.blocks.map((b, i) => (
                <rect key={`b${i}`} x={b.x} y={Y(b.y + b.d)} width={b.w} height={b.d} className={`st-block${b.storeys > storey ? '' : ' faded'}${sel?.type === 'block' && sel.index === i ? ' on' : ''}`}
                  onPointerDown={(e) => startDrag(e, { type: 'block', index: i }, 'move')} onClick={(e) => { if (!tool) { e.stopPropagation(); setSel({ type: 'block', index: i }); } }}><title>{`${b.name}: ${b.storeys} storey(s)`}</title></rect>
              ))}
              {layout.rooms.map((r, i) => (r.storey !== storey ? null : (
                <g key={`r${i}`} onPointerDown={(e) => startDrag(e, { type: 'room', index: i }, 'move')} onClick={(e) => { if (!tool) e.stopPropagation(); }}>
                  <rect x={r.x} y={Y(r.y + r.d)} width={r.w} height={r.d} className={`st-room ${ROOM_FILL(r.kind)}${sel?.type === 'room' && sel.index === i ? ' on' : ''}`} />
                  {r.w > 1.6 && r.d > 1.2 && <text x={r.x + r.w / 2} y={Y(r.y + r.d / 2)} textAnchor="middle" className="st-label" fontSize={Math.min(0.5, r.w / 9)}>{r.name}<tspan x={r.x + r.w / 2} dy="1.2em" className="st-area">{(r.w * r.d).toFixed(1)} m²</tspan></text>}
                </g>
              )))}
              {(layout.elements ?? []).map((e, i) => (e.storey !== storey && !(storey > 0 && e.kind === 'screen') ? null : (
                <g key={`e${i}`} onPointerDown={(ev) => startDrag(ev, { type: 'element', index: i }, 'move')} onClick={(ev) => { if (!tool) ev.stopPropagation(); }}>
                  <rect x={e.x} y={Y(e.y + e.d)} width={e.w} height={e.d} className={`st-element${sel?.type === 'element' && sel.index === i ? ' on' : ''}`} />
                  {e.w > 1.5 && e.d > 0.8 && <text x={e.x + e.w / 2} y={Y(e.y + e.d / 2)} textAnchor="middle" className="st-label el" fontSize={0.4}>{e.label ?? ELEMENT_LABEL[e.kind]}</text>}
                </g>
              )))}
              {selRect && sel && handles.map((h) => {
                const [hx, hy] = handlePos(selRect, h);
                return <rect key={h} x={hx - 0.22} y={Y(hy) - 0.22} width={0.44} height={0.44} className={`st-handle h-${h}`} onPointerDown={(e) => startDrag(e, sel, 'resize', h)} />;
              })}
            </svg>
          ) : (
            <div className="scene-frame studio-3d">
              <Scene plot={base.plot} setbacks={cfg.setbacksM} design={design} view="outside" buildKey="studio" dark={dark} mode="photo" quality={softwareGl() ? 'live' : 'still'} captureRef={capture} />
            </div>
          )}
          <p className="small muted studio-hint"><MousePointer2 size={13} aria-hidden="true" /> Grid squares are 1 m; moves snap to 10 cm. Arrows nudge (Shift: 1 m), Delete removes, Ctrl+Z undoes.</p>
        </section>

        <aside className="studio-panel card" aria-label="Properties and checks">
          {sel && selRect ? (
            <Properties sel={sel} layout={layout} kinds={kinds} patch={patchSel} remove={remove} duplicate={duplicate} />
          ) : (
            <div className="stack-sm">
              <h2 className="h-sub">{BUILDING_TYPES[base.brief.type].label}</h2>
              <p className="small muted">Plot {W} × {D} m{base.place ? ` · ${base.place}` : ''}</p>
              {design && (
                <dl className="stat-tiles">
                  <div><dt>Floor area</dt><dd>{Math.round(design.metrics.grossFloorM2)} m²</dd></div>
                  <div><dt>Site coverage</dt><dd>{design.metrics.coveragePct}%</dd></div>
                  <div><dt>Storeys</dt><dd>{design.storeys}</dd></div>
                  <div><dt>Rooms</dt><dd>{layout.rooms.filter((r) => r.kind !== 'corridor').length}</dd></div>
                </dl>
              )}
            </div>
          )}
          <section className="stack-sm" aria-labelledby="chk-h">
            <h2 id="chk-h" className="h-sub"><Eye size={15} aria-hidden="true" /> Checks</h2>
            {problems.length
              ? <ul className="plain stack-sm">{problems.slice(0, 12).map((p) => <li key={p} className="check-row warn small"><CircleAlert size={15} aria-hidden="true" /><span>{p}</span></li>)}</ul>
              : <p className="small">Everything passes: setbacks, coverage, room sizes, light, stairs and doors.</p>}
          </section>
        </aside>
      </div>
      {publishing && design && <PublishDialog layout={layout} base={base} design={design} orgs={me?.orgs.filter((o) => o.certified) ?? []} capture={capture} needs3d={() => setView('3d')} onClose={() => setPublishing(false)} />}
    </div>
  );
}

function touches(e: { x: number; y: number; w: number; d: number }, b: { x: number; y: number; w: number; d: number }) {
  const ox = Math.min(e.x + e.w, b.x + b.w) - Math.max(e.x, b.x); const oy = Math.min(e.y + e.d, b.y + b.d) - Math.max(e.y, b.y);
  return ox >= -0.05 && oy >= -0.05;
}

function Num({ id, label, value, onChange, step = 0.1, min = 0 }: { id: string; label: string; value: number; onChange: (n: number) => void; step?: number; min?: number }) {
  return (
    <div className="field">
      <label htmlFor={id} className="small">{label}</label>
      <input id={id} type="number" step={step} min={min} value={value} onChange={(e) => { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.round(n * 100) / 100); }} className="num" />
    </div>
  );
}

function Properties({ sel, layout, kinds, patch, remove, duplicate }: {
  sel: NonNullable<Sel>; layout: AiLayout; kinds: EditableKind[]; patch: (p: Record<string, unknown>) => void; remove: () => void; duplicate: () => void;
}) {
  const r = sel.type === 'room' ? layout.rooms[sel.index] : sel.type === 'element' ? layout.elements?.[sel.index] : layout.blocks[sel.index];
  if (!r) return null;
  return (
    <div className="stack-sm">
      <h2 className="h-sub">{sel.type === 'room' ? 'Room' : sel.type === 'element' ? ELEMENT_LABEL[(r as AiLayoutElement).kind] : 'Wing'}</h2>
      {'name' in r && (
        <div className="field"><label htmlFor="p-name" className="small">Name</label><input id="p-name" value={(r as AiLayoutRoom).name} maxLength={40} onChange={(e) => patch({ name: e.target.value })} /></div>
      )}
      {sel.type === 'room' && (
        <>
          <div className="field"><label htmlFor="p-kind" className="small">Use</label>
            <select id="p-kind" value={(r as AiLayoutRoom).kind} onChange={(e) => patch({ kind: e.target.value })}>{kinds.map((k) => <option key={k} value={k}>{ROOM_KIND_LABELS[k]}</option>)}</select></div>
          <div className="field"><label htmlFor="p-glazing" className="small">Glazing</label>
            <select id="p-glazing" value={(r as AiLayoutRoom).glazing ?? 'standard'} onChange={(e) => patch({ glazing: e.target.value as Glazing })}>
              <option value="standard">Standard windows</option><option value="large">Large windows</option><option value="full-height">Floor-to-ceiling glass</option>
            </select></div>
        </>
      )}
      {sel.type === 'element' && (
        <>
          <div className="field"><label htmlFor="p-material" className="small">Material</label>
            <select id="p-material" value={(r as AiLayoutElement).material ?? 'timber'} onChange={(e) => patch({ material: e.target.value })}>{MATERIAL_KEYS.map((m) => <option key={m} value={m}>{MATERIALS[m].label}</option>)}</select></div>
          <Num id="p-storey" label="On floor" value={(r as AiLayoutElement).storey} step={1} onChange={(n) => patch({ storey: Math.max(0, Math.round(n)) })} />
          {(['screen', 'feature-wall', 'pergola', 'canopy', 'planter'] as ElementKind[]).includes((r as AiLayoutElement).kind) && <Num id="p-h" label="Height (m)" value={(r as AiLayoutElement).heightM ?? 2.7} onChange={(n) => patch({ heightM: Math.max(0.3, n) })} />}
        </>
      )}
      {sel.type === 'block' && <Num id="p-storeys" label="Storeys" value={(r as AiLayoutBlock).storeys} step={1} min={1} onChange={(n) => patch({ storeys: Math.max(1, Math.min(10, Math.round(n))) })} />}
      <div className="row wrap">
        <Num id="p-x" label="x (m)" value={r.x} onChange={(n) => patch({ x: n })} />
        <Num id="p-y" label="y (m)" value={r.y} onChange={(n) => patch({ y: n })} />
        <Num id="p-w" label="Width (m)" value={r.w} onChange={(n) => patch({ w: Math.max(0.1, n) })} />
        <Num id="p-d" label="Depth (m)" value={r.d} onChange={(n) => patch({ d: Math.max(0.1, n) })} />
      </div>
      {sel.type !== 'block' && <p className="small muted">{(r.w * r.d).toFixed(1)} m²</p>}
      <div className="row wrap">
        {sel.type !== 'block' && <button type="button" className="btn btn-small" onClick={duplicate}><Copy size={14} aria-hidden="true" /> Duplicate</button>}
        <button type="button" className="btn btn-small btn-ghost" onClick={remove}><Trash2 size={14} aria-hidden="true" /> Delete</button>
      </div>
    </div>
  );
}

/** Certified architects: sell the design as a house plan in the marketplace (it goes to review first). */
function PublishDialog({ layout, base, design, orgs, capture, needs3d, onClose }: {
  layout: AiLayout; base: Loaded; design: NonNullable<ReturnType<typeof designFromLayout>['design']>; orgs: { id: string; name: string }[];
  capture: React.RefObject<(() => string | null) | null>; needs3d: () => void; onClose: () => void;
}) {
  const [title, setTitle] = useState(design.concept?.title ?? layout.name);
  const [description, setDescription] = useState(design.concept?.story ?? layout.idea);
  const [price, setPrice] = useState('');
  const [drawings, setDrawings] = useState('Floor plans, elevations, sections, roof plan');
  const [reg, setReg] = useState('');
  const [rights, setRights] = useState(false);
  const [orgId, setOrgId] = useState(orgs[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { needs3d(); dialog.current?.showModal(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      await new Promise((r) => setTimeout(r, 2500)); // let the 3D view settle for the listing photo
      const photo = capture.current?.() ?? null;
      if (!photo) throw new Error('The 3D view is still loading; try again in a moment.');
      const r = await call<{ listingId: string; status: string }>('/v1/studio/designs', {
        idempotencyKey: `studio-${Date.now()}`,
        body: { orgId, layout, brief: base.brief, plot: base.plot, title, description, priceNaira: Math.round(Number(price.replace(/[^\d.]/g, ''))), drawingsIncluded: drawings, architectRegistration: reg, rightsConfirmed: rights, photo },
      });
      setDone(r.listingId);
    } catch (err) {
      setError(err instanceof ApiFailure || err instanceof Error ? err.message : 'Could not publish. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <dialog ref={dialog} className="studio-dialog card" aria-labelledby="pub-h" onClose={onClose}>
      <h2 id="pub-h" className="h-sub">Publish this design for sale</h2>
      {done ? (
        <div className="stack-sm">
          <p className="notice notice-good" role="status">Sent for review. It goes live in the marketplace under House plans once a moderator approves it; buyers can then try it on their own plot.</p>
          <button type="button" className="btn" onClick={() => dialog.current?.close()}>Close</button>
        </div>
      ) : (
        <form className="stack-sm" onSubmit={submit}>
          {orgs.length > 1 && <div className="field"><label htmlFor="pub-org" className="small">Sell as</label><select id="pub-org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>}
          <div className="field"><label htmlFor="pub-title" className="small">Title</label><input id="pub-title" required maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div className="field"><label htmlFor="pub-desc" className="small">Description</label><textarea id="pub-desc" required rows={3} maxLength={1500} value={description} onChange={(e) => setDescription(e.target.value)} /></div>
          <div className="field"><label htmlFor="pub-price" className="small">Price for the drawing set (NGN)</label><input id="pub-price" required inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 450000" /></div>
          <div className="field"><label htmlFor="pub-draw" className="small">Drawings included</label><input id="pub-draw" required maxLength={160} value={drawings} onChange={(e) => setDrawings(e.target.value)} /></div>
          <div className="field"><label htmlFor="pub-reg" className="small">Your architect registration number</label><input id="pub-reg" required maxLength={40} value={reg} onChange={(e) => setReg(e.target.value)} /></div>
          <label className="check"><input type="checkbox" checked={rights} onChange={(e) => setRights(e.target.checked)} required /> I designed this or hold the right to sell it</label>
          <p className="small muted">Fits plots from {base.plot.widthM} × {base.plot.depthM} m · {Math.round(design.metrics.grossFloorM2)} m² · {design.storeys} storey(s). BuildWise never takes payment: buyers contact you.</p>
          {error && <p className="notice notice-bad small" role="alert">{error}</p>}
          <div className="build-nav">
            <button type="button" className="btn btn-ghost" onClick={() => dialog.current?.close()}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy || !rights || !price.trim() || !orgId}>{busy ? 'Publishing…' : 'Publish for review'}</button>
          </div>
        </form>
      )}
    </dialog>
  );
}
