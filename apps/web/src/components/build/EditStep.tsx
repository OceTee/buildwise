'use client';
import { useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, Layers, Redo2, RotateCcw, Scissors, TriangleAlert, Undo2 } from 'lucide-react';
import {
  EDITABLE_KINDS, HOUSE_KINDS, ROOF_COLOURS, isHouse, ROOF_FINISHES, ROOF_OPTIONS, ROOM_KIND_LABELS, applyEdits, normaliseBrief, roofPitchDeg,
  type Design, type DesignBrief, type DesignConfig, type DesignEdit, type EditSide, type EditableKind, type Room, type RoofColour, type RoofFinish, type RoofKind,
} from '@bw/domain';
import type { View } from './Scene';
import { Nav, StepHead, type StepRef } from './ui';

const SIDE_LABEL: Record<EditSide, string> = { front: 'Street-side wall', rear: 'Back wall', left: 'Left wall', right: 'Right wall' };
const STEP_M = 0.3;

/**
 * Adjust the chosen design as much as you like: drag walls, resize, rename, change a room's use, divide or join
 * rooms, and choose the roof. Each change is an edit replayed on the generated design, so it can be undone.
 */
export function EditStep({ stepRef, kicker, design, edits, results, setEdits, cfg, brief, setBrief, view, setView, onBack, onNext }: {
  stepRef: StepRef; kicker: string; design: Design; edits: DesignEdit[]; results: (string | null)[]; setEdits: (e: DesignEdit[]) => void; cfg: DesignConfig;
  brief: DesignBrief; setBrief: (f: (b: DesignBrief) => DesignBrief) => void; view: View; setView: (v: View) => void; onBack: () => void; onNext: () => void;
}) {
  const storey = typeof view === 'number' ? Math.min(view, design.storeys - 1) : 0;
  const [selected, setSelected] = useState<string | null>(null);
  const [redo, setRedo] = useState<DesignEdit[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const room = design.rooms.find((r) => r.id === selected) ?? null;
  const houseIds = design.blocks.filter((b) => b.kind === 'house').map((b) => b.id);
  const outIds = design.blocks.filter((b) => b.kind === 'outbuilding').map((b) => b.id);
  const applied = results.filter((r) => r === null).length;
  const refused = results.map((r, i) => (r ? { i, r } : null)).filter(Boolean) as { i: number; r: string }[];

  // Try an edit before keeping it, so a refused one explains itself and leaves the design as it was.
  const tryEdit = (e: DesignEdit): boolean => {
    const base = edits;
    // Re-run from the generated design: `design` already has the edits applied, so test on the full list.
    const out = applyEditsPreview(design, base, e, cfg);
    if (out) { setMessage(out); return false; }
    setEdits([...base, e]); setRedo([]); setMessage(null);
    return true;
  };
  const undo = () => { if (!edits.length) return; setRedo([edits[edits.length - 1]!, ...redo]); setEdits(edits.slice(0, -1)); setMessage(null); };
  const redoOne = () => { if (!redo.length) return; setEdits([...edits, redo[0]!]); setRedo(redo.slice(1)); setMessage(null); };
  const reset = () => { setRedo([...edits].reverse().concat(redo)); setEdits([]); setSelected(null); setMessage(null); };

  const warns = design.checks.filter((c) => c.status !== 'pass');
  const setRoof = <K extends keyof DesignBrief>(k: K, v: DesignBrief[K]) => setBrief((b) => normaliseBrief({ ...b, [k]: v }));

  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker={kicker} title={isHouse(design.brief.type) ? 'Adjust your home' : 'Adjust your building'}>Drag any wall to resize rooms, or pick a room to rename it, change its use, divide it or join it to the next room. Moving an outside wall makes the whole wing bigger or smaller. Doors, windows, the checklist and the materials follow every change.</StepHead>

      <div className="editor-bar" role="toolbar" aria-label="Editing">
        {design.storeys > 1 && (
          <div className="segs" role="group" aria-label="Floor">
            {Array.from({ length: design.storeys }, (_, s) => (
              <button key={s} type="button" className={`seg${storey === s ? ' on' : ''}`} aria-pressed={storey === s} onClick={() => { setView(s); setSelected(null); }}>
                <Layers size={14} aria-hidden="true" /> {s === 0 ? 'Ground floor' : s === 1 ? 'First floor' : `Floor ${s}`}
              </button>
            ))}
          </div>
        )}
        <button type="button" className="btn btn-small" onClick={undo} disabled={!edits.length}><Undo2 size={15} aria-hidden="true" /> Undo</button>
        <button type="button" className="btn btn-small" onClick={redoOne} disabled={!redo.length}><Redo2 size={15} aria-hidden="true" /> Redo</button>
        <button type="button" className="btn btn-small btn-ghost" onClick={reset} disabled={!edits.length}><RotateCcw size={15} aria-hidden="true" /> Start again</button>
        <span className="small muted" role="status">{applied ? `${applied} change${applied > 1 ? 's' : ''} · ${design.metrics.grossFloorM2} m²` : `As designed · ${design.metrics.grossFloorM2} m²`}</span>
      </div>

      <PlanEditor design={design} storey={storey} blockIds={houseIds} selected={selected} onSelect={setSelected} onEdit={tryEdit} preview={(e) => applyEditsPreview(design, edits, e, cfg)} />
      {outIds.length > 0 && storey === 0 && (
        <div className="stack-sm">
          <h2 className="h-sub">{design.blocks.filter((b) => b.kind === 'outbuilding').map((b) => b.name).join(', ')} (detached, at the back)</h2>
          <PlanEditor design={design} storey={0} blockIds={outIds} selected={selected} onSelect={setSelected} onEdit={tryEdit} preview={(e) => applyEditsPreview(design, edits, e, cfg)} small />
        </div>
      )}
      {message && <p className="notice notice-warn small" role="alert">{message}</p>}
      {refused.length > 0 && <p className="notice small" role="status">{refused.length} earlier change{refused.length > 1 ? 's' : ''} no longer fit{refused.length > 1 ? '' : 's'} this design and {refused.length > 1 ? 'are' : 'is'} skipped: {refused[0]!.r}</p>}

      {room ? <RoomPanel key={room.id} design={design} room={room} onEdit={tryEdit} onClose={() => setSelected(null)} /> : <p className="small muted">Select a room on the plan (click it, or Tab to it and press Enter) to change it.</p>}

      <details className="checklist" open={warns.some((c) => c.status === 'fail')}>
        <summary><strong>Checklist after your changes</strong> <span className="small muted">{design.checks.length - warns.length} of {design.checks.length} pass</span></summary>
        <ul className="plain stack-sm">
          {design.checks.map((c) => (
            <li key={c.code} className={`check-row ${c.status}`}>
              {c.status === 'pass' ? <Check size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}
              <span><strong>{c.label}</strong> <span className="sr-only">{c.status === 'pass' ? 'passes' : c.status === 'fail' ? 'fails' : 'needs attention'}.</span> <span className="small muted">{c.detail}</span></span>
            </li>
          ))}
        </ul>
      </details>

      <fieldset className="roof-panel stack-sm">
        <legend className="h-sub">Roof</legend>
        <div className="roof-grid" role="radiogroup" aria-label="Roof form">
          {(Object.keys(ROOF_OPTIONS) as RoofKind[]).map((k) => (
            <label key={k} className={`roof-card${brief.roof === k ? ' on' : ''}`}>
              <input type="radio" name="roof-form" checked={brief.roof === k} onChange={() => setRoof('roof', k)} />
              <RoofIcon kind={k} />
              <strong>{ROOF_OPTIONS[k].label}</strong>
              <span className="small muted">{ROOF_OPTIONS[k].blurb}</span>
            </label>
          ))}
        </div>
        {brief.roof !== 'flat' && (
          <div className="brief-grid">
            <div className="field">
              <label htmlFor="roof-finish" className="label">Covering</label>
              <select id="roof-finish" value={brief.roofFinish} onChange={(e) => setRoof('roofFinish', e.target.value as RoofFinish)}>
                {(Object.keys(ROOF_FINISHES) as RoofFinish[]).map((k) => <option key={k} value={k}>{ROOF_FINISHES[k].label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="roof-pitch" className="label">Pitch: {Math.round(roofPitchDeg({ kind: brief.roof, pitchDeg: brief.roofPitch }))}°{brief.roof === 'shed' || brief.roof === 'butterfly' ? ' (kept shallow for this form)' : brief.roof === 'hidden' ? ' (kept below the parapet)' : ''}</label>
              <input id="roof-pitch" type="range" min={10} max={45} step={1} value={brief.roofPitch} onChange={(e) => setRoof('roofPitch', Number(e.target.value))} />
            </div>
            <fieldset className="field">
              <legend className="label">Colour</legend>
              <div className="swatches">
                {(['auto', ...Object.keys(ROOF_COLOURS)] as RoofColour[]).map((c) => (
                  <label key={c} className={`swatch${brief.roofColour === c ? ' on' : ''}`} title={c === 'auto' ? 'Match the style' : ROOF_COLOURS[c as Exclude<RoofColour, 'auto'>].label}>
                    <input type="radio" name="roof-colour" checked={brief.roofColour === c} onChange={() => setRoof('roofColour', c)} />
                    <span className="chip-colour" style={{ background: c === 'auto' ? 'conic-gradient(#3f3f46 0 33%, #9a3b1f 0 66%, #3f6b4f 0)' : ROOF_COLOURS[c as Exclude<RoofColour, 'auto'>].hex }} aria-hidden="true" />
                    <span className="sr-only">{c === 'auto' ? 'Match the style' : ROOF_COLOURS[c as Exclude<RoofColour, 'auto'>].label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </fieldset>

      <p className="small muted"><CircleAlert size={14} aria-hidden="true" /> Your changes are kept in this browser with this plot and brief. Changing the number of rooms starts a fresh design; your edits come back if you change it back.</p>
      <Nav onBack={onBack} onNext={onNext} next="Plan the outdoors" />
    </div>
  );
}

/** Applies one more edit to an already-edited design; returns the reason it is refused, or null when it applies. */
function applyEditsPreview(design: Design, _prior: DesignEdit[], e: DesignEdit, cfg: DesignConfig): string | null {
  return applyEdits(design, [e], cfg).results[0] ?? null;
}

// ---------------------------------------------------------------- the plan editor

interface Drag { wallKey: string; room: string; side: EditSide; dir: 'h' | 'v'; start: number; by: number; error: string | null }

function PlanEditor({ design, storey, blockIds, selected, onSelect, onEdit, preview, small }: {
  design: Design; storey: number; blockIds: string[]; selected: string | null; onSelect: (id: string | null) => void;
  onEdit: (e: DesignEdit) => boolean; preview: (e: DesignEdit) => string | null; small?: boolean;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const blocks = design.blocks.filter((b) => b.storeys > storey && blockIds.includes(b.id));
  const minX = Math.min(...blocks.map((b) => b.x)) - 1.2; const maxX = Math.max(...blocks.map((b) => b.x + b.w)) + 1.2;
  const minY = Math.min(...blocks.map((b) => b.y)) - 1.2; const maxY = Math.max(...blocks.map((b) => b.y + b.d)) + 1.2;
  // Drawn in centimetres (S = 100): text under one SVG unit renders badly, so plan metres are scaled up.
  const S = 100;
  const X = (x: number) => x * S;
  const Y = (y: number) => (maxY - y) * S; // street at the bottom
  const L = (m: number) => m * S;
  const ids = new Set(blocks.map((b) => b.id));
  const rooms = design.rooms.filter((r) => r.storey === storey && ids.has(r.block));
  const inside = (x: number, y: number) => blocks.some((b) => x >= b.x - 0.3 && x <= b.x + b.w + 0.3 && y >= b.y - 0.3 && y <= b.y + b.d + 0.3);
  const walls = design.walls.filter((w) => w.storey === storey && (w.dir === 'h' ? inside((w.from + w.to) / 2, w.at) : inside(w.at, (w.from + w.to) / 2)));
  const roomIds = new Set(rooms.map((r) => r.id));

  // Every wall can be dragged; it is moved through the room on one side of it.
  const handles = useMemo(() => walls.map((w) => {
    const mid = (w.from + w.to) / 2;
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
    const r = rooms.find((x) => (w.dir === 'v' ? (near(x.x + x.w, w.at) || near(x.x, w.at)) && mid > x.y && mid < x.y + x.d : (near(x.y + x.d, w.at) || near(x.y, w.at)) && mid > x.x && mid < x.x + x.w));
    if (!r || r.kind === 'stair') return null;
    const side: EditSide = w.dir === 'v' ? (near(r.x + r.w, w.at) ? 'right' : 'left') : (near(r.y + r.d, w.at) ? 'rear' : 'front');
    return { w, r, side };
  }).filter(Boolean) as { w: (typeof walls)[number]; r: Room; side: EditSide }[], [walls, rooms]);

  const toPlan = (ev: React.PointerEvent) => {
    const el = svg.current!; const pt = el.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(el.getScreenCTM()!.inverse());
    return { x: p.x / S, y: maxY - p.y / S };
  };
  const byFor = (d: Drag, p: { x: number; y: number }) => {
    const delta = (d.dir === 'v' ? p.x : p.y) - d.start;
    const grow = d.side === 'right' || d.side === 'rear' ? delta : -delta;
    return Math.round(grow / 0.05) * 0.05;
  };

  const onDown = (ev: React.PointerEvent, h: (typeof handles)[number]) => {
    ev.preventDefault();
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const p = toPlan(ev);
    setDrag({ wallKey: h.w.id, room: h.r.id, side: h.side, dir: h.w.dir, start: h.w.dir === 'v' ? p.x : p.y, by: 0, error: null });
  };
  const onMove = (ev: React.PointerEvent) => {
    if (!drag) return;
    const by = byFor(drag, toPlan(ev));
    if (by === drag.by) return;
    setDrag({ ...drag, by, error: Math.abs(by) >= 0.05 ? preview({ op: 'move', room: drag.room, side: drag.side, by }) : null });
  };
  const onUp = () => {
    if (!drag) return;
    if (Math.abs(drag.by) >= 0.05) onEdit({ op: 'move', room: drag.room, side: drag.side, by: Math.round(drag.by * 100) / 100 });
    setDrag(null);
  };

  const dragged = drag ? walls.find((w) => w.id === drag.wallKey) : null;
  const ghostAt = dragged && drag ? dragged.at + (drag.side === 'right' || drag.side === 'rear' ? drag.by : -drag.by) : null;
  const fs = Math.max(0.28, Math.min(0.42, (maxX - minX) / 40));

  return (
    <div className="plan-editor">
      <svg ref={svg} className={small ? "pe-small" : undefined} viewBox={`${X(minX)} 0 ${L(maxX - minX)} ${L(maxY - minY)}`} role="group" aria-label={`Floor plan editor, ${storey === 0 ? 'ground floor' : storey === 1 ? 'first floor' : `floor ${storey}`}`}
        onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)} onClick={(e) => { if (e.target === svg.current) onSelect(null); }}>
        <rect x={X(minX)} y={0} width={L(maxX - minX)} height={L(maxY - minY)} className="pe-bg" />
        {rooms.map((r) => {
          const on = r.id === selected;
          const labelled = r.kind !== 'corridor' && Math.min(r.w, r.d) > 1;
          return (
            // The visible label is the accessible name; rooms too small to label get a spoken one.
            <g key={r.id} role="button" tabIndex={0} aria-pressed={on} aria-label={labelled ? undefined : `${r.name}, ${(r.w * r.d).toFixed(1)} m²`}
              className={`pe-room${on ? ' on' : ''} pe-${r.kind}`} onClick={() => onSelect(r.id)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.id); } }}>
              <rect x={X(r.x)} y={Y(r.y + r.d)} width={L(r.w)} height={L(r.d)} />
              {labelled && (
                <text x={X(r.x + r.w / 2)} y={Y(r.y + r.d / 2)} fontSize={L(fs)} textAnchor="middle">
                  <tspan x={X(r.x + r.w / 2)} dy={L(-fs * 0.2)}>{r.name}</tspan>
                  <tspan x={X(r.x + r.w / 2)} dy={L(fs * 1.2)} className="pe-sub">{(r.w * r.d).toFixed(1)} m² · {r.w.toFixed(1)}×{r.d.toFixed(1)}</tspan>
                </text>
              )}
            </g>
          );
        })}
        {walls.map((w) => (
          w.dir === 'h'
            ? <line key={w.id} x1={X(w.from)} x2={X(w.to)} y1={Y(w.at)} y2={Y(w.at)} strokeWidth={L(w.thickness)} className={w.external ? 'pe-wall ext' : 'pe-wall'} />
            : <line key={w.id} y1={Y(w.from)} y2={Y(w.to)} x1={X(w.at)} x2={X(w.at)} strokeWidth={L(w.thickness)} className={w.external ? 'pe-wall ext' : 'pe-wall'} />
        ))}
        {design.openings.filter((o) => o.storey === storey && roomIds.has(o.roomId)).map((o) => (
          o.dir === 'h'
            ? <line key={o.id} x1={X(o.from)} x2={X(o.to)} y1={Y(o.at)} y2={Y(o.at)} strokeWidth={L(0.12)} className={`pe-open ${o.kind}`} />
            : <line key={o.id} y1={Y(o.from)} y2={Y(o.to)} x1={X(o.at)} x2={X(o.at)} strokeWidth={L(0.12)} className={`pe-open ${o.kind}`} />
        ))}
        {handles.map(({ w, r, side }) => (
          w.dir === 'h'
            ? <line key={`h${w.id}`} x1={X(w.from + 0.15)} x2={X(w.to - 0.15)} y1={Y(w.at)} y2={Y(w.at)} strokeWidth={L(0.55)} className="pe-handle ns" onPointerDown={(e) => onDown(e, { w, r, side })}><title>Drag to move this wall</title></line>
            : <line key={`h${w.id}`} y1={Y(w.from + 0.15)} y2={Y(w.to - 0.15)} x1={X(w.at)} x2={X(w.at)} strokeWidth={L(0.55)} className="pe-handle ew" onPointerDown={(e) => onDown(e, { w, r, side })}><title>Drag to move this wall</title></line>
        ))}
        {dragged && ghostAt !== null && drag && (
          <g className={drag.error ? 'pe-ghost bad' : 'pe-ghost'}>
            {dragged.dir === 'h'
              ? <line x1={X(dragged.from)} x2={X(dragged.to)} y1={Y(ghostAt)} y2={Y(ghostAt)} strokeWidth={L(0.12)} />
              : <line y1={Y(dragged.from)} y2={Y(dragged.to)} x1={X(ghostAt)} x2={X(ghostAt)} strokeWidth={L(0.12)} />}
            <text x={X(dragged.dir === 'h' ? (dragged.from + dragged.to) / 2 : ghostAt + 0.3)} y={dragged.dir === 'h' ? Y(ghostAt + 0.3) : Y((dragged.from + dragged.to) / 2)} fontSize={L(fs * 1.1)}>
              {drag.by > 0 ? '+' : ''}{drag.by.toFixed(2)} m{drag.error ? ` · ${drag.error}` : ''}
            </text>
          </g>
        )}
        <text x={X((minX + maxX) / 2)} y={L(maxY - minY - 0.25)} fontSize={L(fs)} textAnchor="middle" className="pe-street">STREET SIDE</text>
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------- the selected room

function RoomPanel({ design, room, onEdit, onClose }: { design: Design; room: Room; onEdit: (e: DesignEdit) => boolean; onClose: () => void }) {
  const [name, setName] = useState(room.name);
  const fixed = room.kind === 'corridor' || room.kind === 'stair';
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;
  // Rooms it can be joined with: same floor and wing, sharing a whole wall.
  const neighbours = design.rooms.filter((o) => o.id !== room.id && o.storey === room.storey && o.block === room.block && o.kind !== 'stair' && (
    (near(o.y, room.y) && near(o.d, room.d) && (near(o.x + o.w, room.x) || near(room.x + room.w, o.x)))
    || (near(o.x, room.x) && near(o.w, room.w) && (near(o.y + o.d, room.y) || near(room.y + room.d, o.y)))));
  const [join, setJoin] = useState(neighbours[0]?.id ?? '');
  return (
    <section className="room-panel card-inset stack-sm" aria-labelledby="room-h">
      <div className="room-panel-head">
        <h2 id="room-h" className="h-sub">{room.name}</h2>
        <span className="small muted">{(room.w * room.d).toFixed(1)} m² · {room.w.toFixed(2)} × {room.d.toFixed(2)} m</span>
        <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>Done</button>
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (name.trim() && name.trim() !== room.name) onEdit({ op: 'rename', room: room.id, name }); }}>
        <div className="field">
          <label htmlFor="room-name" className="label">Name</label>
          <input id="room-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" className="btn btn-small" disabled={!name.trim() || name.trim() === room.name}>Rename</button>
      </form>
      {!fixed && (
        <div className="field">
          <label htmlFor="room-use" className="label">Use</label>
          <select id="room-use" value={room.kind} onChange={(e) => onEdit({ op: 'use', room: room.id, kind: e.target.value as EditableKind })}>
            {(isHouse(design.brief.type) ? HOUSE_KINDS : EDITABLE_KINDS).map((k) => <option key={k} value={k}>{ROOM_KIND_LABELS[k]}</option>)}
          </select>
        </div>
      )}
      {room.kind !== 'stair' && (
        <div className="wall-nudges" role="group" aria-label="Move this room's walls">
          {(['front', 'rear', 'left', 'right'] as EditSide[]).map((s) => (
            <div key={s} className="nudge">
              <span className="small">{SIDE_LABEL[s]}</span>
              <button type="button" className="btn btn-small" aria-label={`${SIDE_LABEL[s]}: move in ${STEP_M} m (smaller room)`} onClick={() => onEdit({ op: 'move', room: room.id, side: s, by: -STEP_M })}>−{STEP_M}</button>
              <button type="button" className="btn btn-small" aria-label={`${SIDE_LABEL[s]}: move out ${STEP_M} m (bigger room)`} onClick={() => onEdit({ op: 'move', room: room.id, side: s, by: STEP_M })}>+{STEP_M}</button>
            </div>
          ))}
        </div>
      )}
      {!fixed && (
        <div className="row wrap">
          <button type="button" className="btn btn-small" onClick={() => onEdit({ op: 'split', room: room.id, dir: room.w >= room.d ? 'v' : 'h' })}><Scissors size={14} aria-hidden="true" /> Divide in two</button>
          <button type="button" className="btn btn-small" onClick={() => onEdit({ op: 'split', room: room.id, dir: room.w >= room.d ? 'h' : 'v' })}><Scissors size={14} aria-hidden="true" /> Divide the other way</button>
        </div>
      )}
      {room.kind !== 'stair' && neighbours.length > 0 && (
        <div className="row wrap">
          <div className="field">
            <label htmlFor="room-join" className="label">Join with</label>
            <select id="room-join" value={join} onChange={(e) => setJoin(e.target.value)}>
              {neighbours.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}
            </select>
          </div>
          <button type="button" className="btn btn-small" onClick={() => join && onEdit({ op: 'merge', room: room.id, with: join })}>Remove the wall between them</button>
        </div>
      )}
    </section>
  );
}

/** Small elevation sketch of each roof form. */
function RoofIcon({ kind }: { kind: RoofKind }) {
  const body = <rect x={6} y={22} width={36} height={14} className="ri-wall" />;
  const shapes: Record<RoofKind, React.ReactNode> = {
    hip: <path d="M3 22 L14 10 L34 10 L45 22 Z" />,
    gable: <path d="M3 22 L24 6 L45 22 Z" />,
    dutch: <path d="M3 22 L12 14 L18 14 L24 6 L30 14 L36 14 L45 22 Z" />,
    mansard: <path d="M4 22 L9 11 L18 7 L30 7 L39 11 L44 22 Z" />,
    shed: <path d="M3 22 L45 12 L45 22 Z" />,
    butterfly: <path d="M3 13 L24 20 L45 13 L45 22 L3 22 Z" />,
    hidden: <><path d="M10 22 L24 16 L38 22 Z" /><rect x={6} y={16} width={36} height={6} className="ri-wall" /></>,
    flat: <rect x={5} y={18} width={38} height={4} />,
  };
  return <svg viewBox="0 0 48 38" className="roof-icon" aria-hidden="true">{body}<g className="ri-roof">{shapes[kind]}</g></svg>;
}
