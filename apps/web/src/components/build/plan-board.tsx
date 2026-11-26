'use client';
import type { ReactNode } from 'react';
import { WET, furnishFloor, loggiaColumns, type ArchElement, type Design, type Furnishing, type Rect, type Room } from '@bw/domain';
import { EL_NAME, elPosts, elSides, elementsOnPlan, planFrame } from './DrawingSet';
import { FurnitureSymbol, Plant, rugsFor, type PlanFrame } from './plan-symbols';

/**
 * Presentation floor plans: every level of the house side by side on A3 at one scale, drawn the way a developer's
 * brochure shows a home: warm grey floors, dark solid walls, rugs under the seating, beds and dining sets, furniture in
 * detail, tiled wet rooms, paved terraces with outdoor furniture, the entrance marked, each room named with its size
 * (width × depth), and the total floor area underneath. Same geometry as the technical sheets.
 */

const A3 = { w: 420, h: 297 };
const FLOOR = '#e5e3de';
const RUG = '#d3cec6';
const WALL = '#4a4845';
const WALL_IN = '#5c5a56';
const TEXT = '#2b2a28';
const MUTED = '#77736d';
const PAVE = '#f1efeb';
/** Presentation plans fill the sheet, so they may use the in-between scales a brochure would. */
const BOARD_SCALES = [50, 60, 75, 80, 100, 125, 150, 200, 250, 300, 400, 500];
const FLOOR_NAMES = ['Ground Floor', 'First Floor', 'Second Floor', 'Third Floor', 'Fourth Floor', 'Fifth Floor', 'Sixth Floor', 'Seventh Floor', 'Eighth Floor', 'Ninth Floor'];
export const floorName = (s: number) => FLOOR_NAMES[s] ?? `Level ${s}`;

const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y));
const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/** The plan boards for a design: levels in pairs, side by side. */
export function PlanBoards({ design, name, project, date }: { design: Design; name: string; project: string; date: string }) {
  const house = design.blocks.filter((b) => b.kind === 'house');
  if (!house.length) return null;
  // One frame for every level so the plans line up: the house blocks and anything built onto them.
  const els = Array.from({ length: design.storeys }, (_, s) => elementsOnPlan(design, s)).flat()
    .filter((e) => house.some((b) => e.x <= b.x + b.w + 0.3 && e.x + e.w >= b.x - 0.3 && e.y <= b.y + b.d + 0.3 && e.y + e.d >= b.y - 0.3));
  const rs = [...house, ...els];
  const pad = 0.6;
  const ext = { minX: Math.min(...rs.map((r) => r.x)) - pad, maxX: Math.max(...rs.map((r) => r.x + r.w)) + pad, minY: Math.min(...rs.map((r) => r.y)) - pad, maxY: Math.max(...rs.map((r) => r.y + r.d)) + pad };
  const levels = Array.from({ length: design.storeys }, (_, s) => s).filter((s) => house.some((b) => b.storeys > s));
  const pages: number[][] = [];
  for (let i = 0; i < levels.length; i += 2) pages.push(levels.slice(i, i + 2));
  const cols = Math.min(2, levels.length);
  const gap = 14; const side = 16; const top = 10; const bottom = 40;
  const boxW = (A3.w - 2 * side - gap * (cols - 1)) / cols; const boxH = A3.h - top - bottom;
  const wM = ext.maxX - ext.minX; const hM = ext.maxY - ext.minY;
  const scale = BOARD_SCALES.find((s) => (wM * 1000) / s <= boxW && (hM * 1000) / s <= boxH) ?? 500;
  const gross = design.blocks.reduce((t, b) => t + b.w * b.d * b.storeys, 0);
  const out = design.blocks.find((b) => b.kind === 'outbuilding');
  return (
    <>
      {pages.map((page, pi) => {
        const no = `A-00${pi + 1}`;
        const used = page.length * boxW + gap * (page.length - 1);
        const x0 = (A3.w - used) / 2;
        return (
          <figure key={no} className="drawing-sheet">
            <svg viewBox={`0 0 ${A3.w} ${A3.h}`} role="img" aria-label={`${no} floor plans (${page.map(floorName).join(', ')}), ${name}`} fontFamily="Arial, Helvetica, sans-serif" fill={TEXT}>
              <rect x={0} y={0} width={A3.w} height={A3.h} fill="#fff" />
              {page.map((s, i) => {
                const box = { x: x0 + i * (boxW + gap), y: top, w: boxW, h: boxH };
                const f = planFrame(ext.minX, ext.minY, ext.maxX, ext.maxY, scale, box);
                const planBottom = f.Y(ext.minY);
                return (
                  <g key={s}>
                    {boardPlan(design, s, house, f, `${no}-${s}`)}
                    <text x={box.x + box.w / 2} y={Math.min(planBottom + 10, A3.h - bottom + 11)} fontSize={5.2} textAnchor="middle" fill={TEXT}>{floorName(s)}</text>
                  </g>
                );
              })}
              <text x={A3.w / 2} y={A3.h - 21} fontSize={6.4} fontWeight={700} textAnchor="middle" letterSpacing={0.2}>
                TOTAL AREA: {gross.toFixed(2)} SQM ({(gross * 10.7639).toFixed(2)} SQFT)
              </text>
              <ScaleBar x={side} y={A3.h - 25} k={1000 / scale} scale={scale} />
              <line x1={side} x2={A3.w - side} y1={A3.h - 14} y2={A3.h - 14} stroke="#d6d3ce" strokeWidth={0.3} />
              <text x={side} y={A3.h - 8.5} fontSize={2.4} fill={MUTED}>
                <tspan fontWeight={700} fill={TEXT}>BuildWise</tspan>  ·  {name}  ·  {project}{out ? `  ·  ${out.name} drawn on sheet A-101` : ''}
              </text>
              <text x={A3.w - side} y={A3.h - 8.5} fontSize={2.4} fill={MUTED} textAnchor="end">
                {no}  ·  1:{scale} at A3  ·  {date}  ·  Street at the bottom  ·  Concept design, not for construction
              </text>
            </svg>
          </figure>
        );
      })}
    </>
  );
}

function ScaleBar({ x, y, k, scale }: { x: number; y: number; k: number; scale: number }) {
  const steps = scale <= 100 ? [0, 1, 2, 5] : [0, 2, 5, 10];
  const end = steps[steps.length - 1]!;
  return (
    <g fontSize={2} fill={MUTED}>
      {steps.slice(0, -1).map((a, i) => <rect key={a} x={x + a * k} y={y} width={(steps[i + 1]! - a) * k} height={1.2} fill={i % 2 ? '#fff' : '#77736d'} stroke="#77736d" strokeWidth={0.2} />)}
      {steps.map((a) => <text key={a} x={x + a * k} y={y + 4} textAnchor="middle">{a}</text>)}
      <text x={x + end * k + 3} y={y + 1.3}>m</text>
    </g>
  );
}

/** One level of the house in presentation style. */
function boardPlan(d: Design, storey: number, blocks: Design['blocks'], f: PlanFrame, kp: string): ReactNode {
  const ids = new Set(blocks.map((b) => b.id));
  const rooms = d.rooms.filter((r) => r.storey === storey && ids.has(r.block));
  const inBlocks = (x: number, y: number) => blocks.some((b) => b.storeys > storey && x >= b.x - 0.3 && x <= b.x + b.w + 0.3 && y >= b.y - 0.3 && y <= b.y + b.d + 0.3);
  const walls = d.walls.filter((w) => w.storey === storey && (w.dir === 'h' ? inBlocks((w.from + w.to) / 2, w.at) : inBlocks(w.at, (w.from + w.to) / 2)));
  const ops = d.openings.filter((o) => o.storey === storey && rooms.some((r) => r.id === o.roomId));
  const items = furnishFloor(d, storey).filter((i) => rooms.some((r) => r.id === i.roomId));
  const R = (r: Rect) => ({ x: f.X(r.x), y: f.Y(r.y + r.d), width: r.w * f.k, height: r.d * f.k });
  const els: ReactNode[] = [];
  const k = f.k;

  els.push(
    <defs key="defs">
      <pattern id={`${kp}-pave`} width={0.6 * k} height={0.6 * k} patternUnits="userSpaceOnUse">
        <rect width={0.6 * k} height={0.6 * k} fill={PAVE} /><path d={`M0 0 H${0.6 * k} M0 0 V${0.6 * k}`} stroke="#d7d3cc" strokeWidth={0.15} />
      </pattern>
      <pattern id={`${kp}-tile`} width={0.3 * k} height={0.3 * k} patternUnits="userSpaceOnUse">
        <rect width={0.3 * k} height={0.3 * k} fill="#eceae6" /><path d={`M0 0 H${0.3 * k} M0 0 V${0.3 * k}`} stroke="#d9d6d0" strokeWidth={0.1} />
      </pattern>
    </defs>,
  );

  // Terraces, verandas, porches and balconies: paved, with their posts, rails and outdoor furniture.
  const touches = (e: ArchElement) => blocks.some((b) => e.x <= b.x + b.w + 0.3 && e.x + e.w >= b.x - 0.3 && e.y <= b.y + b.d + 0.3 && e.y + e.d >= b.y - 0.3);
  const planEls = elementsOnPlan(d, storey).filter(touches);
  const outdoorItems: Furnishing[] = [];
  const elLabels: ReactNode[] = [];
  for (const e of planEls) {
    const own = Math.max(0, e.storey) === storey;
    const a = elSides(d, e);
    if ((e.kind === 'porch' || e.kind === 'veranda' || e.kind === 'balcony') && own) {
      els.push(<rect key={`pv${e.id}`} {...R(e)} fill={`url(#${kp}-pave)`} stroke="#bdb8b0" strokeWidth={0.2} />);
      if (e.kind === 'balcony') {
        const t = 0.06;
        const rails = [!a.front && { x: e.x, y: e.y, w: e.w, d: t }, !a.rear && { x: e.x, y: e.y + e.d - t, w: e.w, d: t }, !a.left && { x: e.x, y: e.y, w: t, d: e.d }, !a.right && { x: e.x + e.w - t, y: e.y, w: t, d: e.d }].filter(Boolean) as Rect[];
        for (const [i, r] of rails.entries()) els.push(<rect key={`rl${e.id}${i}`} {...R(r)} fill="#8d8983" />);
      } else {
        for (const [i, [px, py]] of elPosts(e, a, 0.22, 3).entries()) els.push(<circle key={`po${e.id}${i}`} cx={f.X(px)} cy={f.Y(py)} r={0.17 * k} fill="#8d8983" />);
      }
      outdoorItems.push(...outdoorSet(e));
      if (Math.max(e.w, e.d) * k > 14) elLabels.push(elementLabel(e, a, f, `el${e.id}`, outdoorItems));
    } else if (e.kind === 'pergola' && own) {
      els.push(<rect key={`pg${e.id}`} {...R(e)} fill={`url(#${kp}-pave)`} stroke="#bdb8b0" strokeWidth={0.2} />);
      const alongY = a.front || a.rear || (!a.left && !a.right && e.d <= e.w);
      const L = alongY ? e.w : e.d; const n = Math.max(2, Math.floor((L - 0.1) / 0.42) + 1);
      for (let i = 0; i < n; i++) {
        const u = (alongY ? e.x : e.y) + 0.05 + ((L - 0.1) * i) / (n - 1);
        els.push(alongY
          ? <line key={`sl${e.id}${i}`} x1={f.X(u)} x2={f.X(u)} y1={f.Y(e.y)} y2={f.Y(e.y + e.d)} stroke="#b3ada4" strokeWidth={0.18} />
          : <line key={`sl${e.id}${i}`} y1={f.Y(u)} y2={f.Y(u)} x1={f.X(e.x)} x2={f.X(e.x + e.w)} stroke="#b3ada4" strokeWidth={0.18} />);
      }
      for (const [i, [px, py]] of elPosts(e, a, 0.12, 3).entries()) els.push(<circle key={`pp${e.id}${i}`} cx={f.X(px)} cy={f.Y(py)} r={0.12 * k} fill="#8d8983" />);
      outdoorItems.push(...outdoorSet(e));
      if (Math.max(e.w, e.d) * k > 14) elLabels.push(elementLabel(e, a, f, `el${e.id}`, outdoorItems));
    } else if (e.kind === 'canopy' || ((e.kind === 'porch' || e.kind === 'veranda') && !own)) {
      els.push(<rect key={`cn${e.id}`} {...R(e)} fill="none" stroke="#9c978f" strokeWidth={0.2} strokeDasharray="1.4 0.9" />);
    } else if (e.kind === 'screen') {
      const long = e.w >= e.d; const L = long ? e.w : e.d; const n = Math.max(2, Math.floor(L / 0.13) + 1);
      for (let i = 0; i < n; i++) {
        const u = (long ? e.x : e.y) + (L * i) / (n - 1);
        els.push(long
          ? <line key={`sc${e.id}${i}`} x1={f.X(u)} x2={f.X(u)} y1={f.Y(e.y)} y2={f.Y(e.y + e.d)} stroke="#7a756e" strokeWidth={0.15} />
          : <line key={`sc${e.id}${i}`} y1={f.Y(u)} y2={f.Y(u)} x1={f.X(e.x)} x2={f.X(e.x + e.w)} stroke="#7a756e" strokeWidth={0.15} />);
      }
    } else if (e.kind === 'feature-wall') {
      els.push(<rect key={`fw${e.id}`} {...R(e)} fill="#a8a196" />);
    } else if (e.kind === 'planter' && own) {
      els.push(<rect key={`pl${e.id}`} {...R(e)} fill="#dfe7d5" stroke="#8d9a7e" strokeWidth={0.2} />);
      const n = Math.max(1, Math.floor(Math.max(e.w, e.d) / 0.9));
      for (let i = 0; i < n; i++) {
        const cx = e.w >= e.d ? e.x + (e.w * (i + 0.5)) / n : e.x + e.w / 2; const cy = e.w >= e.d ? e.y + e.d / 2 : e.y + (e.d * (i + 0.5)) / n;
        els.push(<Plant key={`pt${e.id}${i}`} cx={f.X(cx)} cy={f.Y(cy)} r={Math.min(0.4, Math.min(e.w, e.d) / 2) * k} seed={i} />);
      }
    }
  }

  // Floors, wet rooms tiled.
  for (const r of rooms) els.push(<rect key={`f${r.id}`} {...R(r)} fill={WET.has(r.kind) ? `url(#${kp}-tile)` : FLOOR} />);
  for (const r of rooms) for (const [i, rug] of rugsFor(r, items).entries()) els.push(<rect key={`rug${r.id}${i}`} {...R(rug)} fill={RUG} rx={0.04 * k} />);
  for (const it of [...items, ...outdoorItems]) els.push(<FurnitureSymbol key={it.id} item={it} f={f} />);
  els.push(...elLabels);
  // A plant in a free corner of each living room and lounge.
  for (const r of rooms.filter((x) => x.kind === 'living' || x.kind === 'lounge' || x.kind === 'living-kitchen')) {
    const spot = plantCorner(r, items, ops);
    if (spot) els.push(<Plant key={`plant${r.id}`} cx={f.X(spot.x)} cy={f.Y(spot.y)} r={0.3 * k} seed={r.x} />);
  }
  // Stairs and lifts.
  for (const r of rooms.filter((x) => x.kind === 'stair')) els.push(<g key={`st${r.id}`}>{stair(r, f)}</g>);
  for (const r of rooms.filter((x) => x.kind === 'lift')) {
    const i = 0.12;
    els.push(<g key={`lf${r.id}`} stroke="#77736d" strokeWidth={0.2} fill="#fff">
      <rect x={f.X(r.x + i)} y={f.Y(r.y + r.d - i)} width={(r.w - 2 * i) * k} height={(r.d - 2 * i) * k} />
      <line x1={f.X(r.x + i)} y1={f.Y(r.y + i)} x2={f.X(r.x + r.w - i)} y2={f.Y(r.y + r.d - i)} />
      <line x1={f.X(r.x + i)} y1={f.Y(r.y + r.d - i)} x2={f.X(r.x + r.w - i)} y2={f.Y(r.y + i)} />
    </g>);
  }
  for (const [i, c] of loggiaColumns(d).filter((x) => x.storey === storey).entries()) els.push(<circle key={`lc${i}`} cx={f.X(c.x)} cy={f.Y(c.y)} r={(c.size / 2 + 0.05) * k} fill="#8d8983" />);

  // Walls, solid and dark, cut round their openings.
  for (const w of walls) {
    const cuts = ops.filter((o) => o.dir === w.dir && near(o.at, w.at) && o.from >= w.from - 1e-3 && o.to <= w.to + 1e-3).sort((a, b) => a.from - b.from);
    const t = w.thickness;
    const seg = (a: number, b: number, i: number) => {
      if (b - a < 0.01) return;
      const a0 = a - (near(a, w.from) ? t / 2 : 0); const b0 = b + (near(b, w.to) ? t / 2 : 0);
      els.push(w.dir === 'h'
        ? <rect key={`${w.id}-${i}`} x={f.X(a0)} y={f.Y(w.at + t / 2)} width={(b0 - a0) * k} height={t * k} fill={w.external ? WALL : WALL_IN} />
        : <rect key={`${w.id}-${i}`} x={f.X(w.at - t / 2)} y={f.Y(b0)} width={t * k} height={(b0 - a0) * k} fill={w.external ? WALL : WALL_IN} />);
    };
    let cur = w.from;
    cuts.forEach((o, i) => { seg(cur, o.from, i); cur = o.to; });
    seg(cur, w.to, cuts.length);
  }

  // Windows: a pale frame with the glass line; doors: a leaf and a fine swing.
  for (const o of ops) {
    const w = walls.find((x) => x.dir === o.dir && near(x.at, o.at) && o.from >= x.from - 1e-3 && o.to <= x.to + 1e-3);
    const t = w?.thickness ?? 0.2;
    if (o.kind === 'window') {
      const full = o.sillM < 0.3;
      els.push(o.dir === 'h'
        ? <g key={o.id} stroke="#6c6964" strokeWidth={0.15}><rect x={f.X(o.from)} y={f.Y(o.at + t / 2)} width={(o.to - o.from) * k} height={t * k} fill="#fff" /><line x1={f.X(o.from)} x2={f.X(o.to)} y1={f.Y(o.at)} y2={f.Y(o.at)} stroke={full ? '#6f9bb0' : '#6c6964'} strokeWidth={full ? 0.35 : 0.15} /></g>
        : <g key={o.id} stroke="#6c6964" strokeWidth={0.15}><rect x={f.X(o.at - t / 2)} y={f.Y(o.to)} width={t * k} height={(o.to - o.from) * k} fill="#fff" /><line y1={f.Y(o.from)} y2={f.Y(o.to)} x1={f.X(o.at)} x2={f.X(o.at)} stroke={full ? '#6f9bb0' : '#6c6964'} strokeWidth={full ? 0.35 : 0.15} /></g>);
      continue;
    }
    if (o.passage === 'open' || o.passage === 'arch') continue;
    const room = rooms.find((r) => r.id === o.roomId);
    const sign = !room ? 1 : o.dir === 'h' ? (near(room.y, o.at) ? 1 : -1) : (near(room.x, o.at) ? 1 : -1);
    const mid = (o.from + o.to) / 2;
    const leaves = o.passage === 'double' ? [[o.from, mid], [o.to, mid]] as const : [[o.from, o.to]] as const;
    els.push(<g key={o.id} fill="none">{leaves.map(([hinge, closed]) => {
      const len = Math.abs(closed - hinge);
      const across = o.at + (sign * t) / 2;
      const swing = across + sign * len;
      const [hx, hy, sx, sy, cx, cy] = o.dir === 'h'
        ? [f.X(hinge), f.Y(across), f.X(hinge), f.Y(swing), f.X(closed), f.Y(across)]
        : [f.X(across), f.Y(hinge), f.X(swing), f.Y(hinge), f.X(across), f.Y(closed)];
      const sweep = (o.dir === 'h' ? sign : -sign) * Math.sign(closed - hinge) > 0 ? 1 : 0;
      return <g key={hinge}>
        <line x1={hx} y1={hy} x2={sx} y2={sy} stroke="#55524d" strokeWidth={0.3} />
        <path d={`M ${sx} ${sy} A ${len * k} ${len * k} 0 0 ${sweep} ${cx} ${cy}`} stroke="#9c978f" strokeWidth={0.13} />
      </g>;
    })}</g>);
  }

  // The front door, marked.
  if (storey === 0) {
    const entry = entranceDoor(d, rooms);
    if (entry) {
      const { o, room } = entry;
      const sign = o.dir === 'h' ? (near(room.y, o.at) ? 1 : -1) : (near(room.x, o.at) ? 1 : -1);
      const mid = (o.from + o.to) / 2; const tip = o.at - sign * 0.45; const back = o.at - sign * 1.05; const half = 0.32;
      const pts = o.dir === 'h'
        ? [[mid, tip], [mid - half, back], [mid + half, back]]
        : [[tip, mid], [back, mid - half], [back, mid + half]];
      els.push(<polygon key="entry" points={pts.map(([x, y]) => `${f.X(x!)},${f.Y(y!)}`).join(' ')} fill="#c8372d" />);
    }
  }

  // Room names and sizes, set where the furniture leaves room.
  const fs = Math.max(1.3, Math.min(2.1, k * 0.15));
  for (const r of rooms) {
    if (r.kind === 'stair' || (r.kind === 'corridor' && r.w * r.d < 7)) continue;
    const label = r.name.toUpperCase();
    const size = r.kind === 'corridor' || r.kind === 'lift' ? null : `${r.w.toFixed(2)} X ${r.d.toFixed(2)}m`;
    // Door swings count as furniture: a name never sits in a doorway.
    const swings = ops.filter((o) => o.kind === 'door' && o.passage !== 'open')
      .map((o) => (o.dir === 'h' ? { x: o.from, y: o.at - (o.to - o.from), w: o.to - o.from, d: 2 * (o.to - o.from) } : { x: o.at - (o.to - o.from), y: o.from, w: 2 * (o.to - o.from), d: o.to - o.from }));
    els.push(<g key={`lb${r.id}`}>{roomLabel(r, label, size, [...items.filter((i) => i.roomId === r.id), ...swings], f, fs)}</g>);
  }
  return <g key={kp}>{els}</g>;
}

/** A stair: treads across the flight, a walking line with its arrow, and UP. */
function stair(r: Room, f: PlanFrame): ReactNode {
  const along = r.d >= r.w;
  const len = along ? r.d : r.w;
  const n = Math.max(8, Math.round(len / 0.28));
  const lines = Array.from({ length: n - 1 }, (_, i) => {
    const t = (i + 1) / n;
    return along
      ? <line key={i} x1={f.X(r.x)} x2={f.X(r.x + r.w)} y1={f.Y(r.y + t * r.d)} y2={f.Y(r.y + t * r.d)} />
      : <line key={i} y1={f.Y(r.y)} y2={f.Y(r.y + r.d)} x1={f.X(r.x + t * r.w)} x2={f.X(r.x + t * r.w)} />;
  });
  const [x0, y0, x1, y1] = along ? [r.x + r.w / 2, r.y + 0.3, r.x + r.w / 2, r.y + r.d - 0.3] : [r.x + 0.3, r.y + r.d / 2, r.x + r.w - 0.3, r.y + r.d / 2];
  const ax = f.X(x1); const ay = f.Y(y1); const ah = 0.18 * f.k;
  const head = along ? `${ax - ah},${ay + ah} ${ax},${ay} ${ax + ah},${ay + ah}` : `${ax - ah},${ay - ah} ${ax},${ay} ${ax - ah},${ay + ah}`;
  return (
    <g>
      <rect x={f.X(r.x)} y={f.Y(r.y + r.d)} width={r.w * f.k} height={r.d * f.k} fill="#efede9" />
      <g stroke="#8d8983" strokeWidth={0.18}>{lines}</g>
      <line x1={f.X(x0)} y1={f.Y(y0)} x2={ax} y2={ay} stroke="#55524d" strokeWidth={0.18} />
      <polyline points={head} fill="none" stroke="#55524d" strokeWidth={0.18} />
      <circle cx={f.X(x0)} cy={f.Y(y0)} r={0.06 * f.k} fill="#55524d" />
      <text x={f.X(x0) + (along ? 0.25 * f.k : 0)} y={f.Y(y0) - (along ? 0 : 0.2 * f.k)} fontSize={1.6} fill="#55524d" textAnchor={along ? 'start' : 'middle'}>UP</text>
    </g>
  );
}

/** Outdoor furniture for a terrace, veranda, porch or balcony: lounge chairs round a low table, and a dining set when long enough. */
function outdoorSet(e: ArchElement): Furnishing[] {
  const long = Math.max(e.w, e.d); const short = Math.min(e.w, e.d);
  if (short < 1.9 || e.w * e.d < 5) return [];
  const horiz = e.w >= e.d;
  const cx = e.x + e.w / 2; const cy = e.y + e.d / 2;
  const at = (u: number) => (horiz ? { x: cx + u, y: cy } : { x: cx, y: cy + u });
  const out: Furnishing[] = [];
  const add = (kind: Furnishing['kind'], c: { x: number; y: number }, w: number, d: number, back: Furnishing['back'], id: string) =>
    out.push({ id: `${e.id}:${id}`, roomId: e.id, kind, x: c.x - w / 2, y: c.y - d / 2, w, d, back, turn: back === 'e' || back === 'w' });
  const lounge = (u: number) => {
    const c = at(u);
    add('coffee-table', c, 0.6, 0.6, 'n', `t${u}`);
    // Two lounge chairs facing each other across the table, along the terrace.
    if (horiz) { add('armchair', { x: c.x - 0.85, y: c.y }, 0.8, 0.8, 'w', `a${u}`); add('armchair', { x: c.x + 0.85, y: c.y }, 0.8, 0.8, 'e', `b${u}`); }
    else { add('armchair', { x: c.x, y: c.y - 0.85 }, 0.8, 0.8, 'n', `a${u}`); add('armchair', { x: c.x, y: c.y + 0.85 }, 0.8, 0.8, 's', `b${u}`); }
  };
  if (long >= 6 && short >= 2.6) {
    const L = 2.0; const D = 1.8;
    const c = at(-long / 4);
    add('dining-table', c, horiz ? L : D, horiz ? D : L, horiz ? 'n' : 'w', 'dine');
    lounge(long / 4);
  } else if (long >= 2.8) lounge(0);
  return out;
}

function elementLabel(e: ArchElement, a: ReturnType<typeof elSides>, f: PlanFrame, key: string, furniture: Furnishing[]): ReactNode {
  const name = (e.label === 'Loggia' ? 'LOGGIA' : e.label && e.label.length < 18 ? e.label.toUpperCase() : EL_NAME[e.kind]);
  const fs = Math.max(1.2, Math.min(1.9, f.k * 0.14));
  const w = (Math.max(name.length * 0.66, 13 * 0.56) * fs) / f.k; const h = (fs * 2.3) / f.k;
  // At the open edge, clear of the furniture.
  const spots = [
    !a.front && { x: e.x + e.w / 2, y: e.y + h / 2 + 0.15 }, !a.rear && { x: e.x + e.w / 2, y: e.y + e.d - h / 2 - 0.15 },
    !a.left && { x: e.x + w / 2 + 0.15, y: e.y + e.d / 2 }, !a.right && { x: e.x + e.w - w / 2 - 0.15, y: e.y + e.d / 2 }, { x: e.x + e.w / 2, y: e.y + e.d / 2 },
  ].filter(Boolean) as { x: number; y: number }[];
  const box = (p: { x: number; y: number }) => ({ x: p.x - w / 2, y: p.y - h / 2, w, d: h });
  const best = spots.map((p) => ({ p, s: furniture.reduce((t, i) => t + overlapArea(box(p), i), 0) })).sort((p, q) => p.s - q.s)[0]!.p;
  return (
    <g key={key} textAnchor="middle" fill={TEXT}>
      <text x={f.X(best.x)} y={f.Y(best.y)} fontSize={fs} fontWeight={700} letterSpacing={0.15}>{name}</text>
      <text x={f.X(best.x)} y={f.Y(best.y) + fs * 1.05} fontSize={fs * 0.8} fill={MUTED}>{e.w.toFixed(2)} X {e.d.toFixed(2)}m</text>
    </g>
  );
}

/** A room's name and size where the furniture leaves space: centre first, then round it; turned in a tall narrow room. */
function roomLabel(r: Room, name: string, size: string | null, mine: Rect[], f: PlanFrame, base: number): ReactNode {
  const measure = (fs: number) => ({ w: (Math.max(name.length * 0.8 * fs, size ? size.length * 0.5 * fs * 0.82 : 0)) / f.k, h: (fs * (size ? 2.2 : 1.2)) / f.k });
  let fs = base; let rot = false;
  for (; fs >= 1.05; fs -= 0.1) {
    const m = measure(fs);
    if (m.w <= r.w - 0.12 && m.h <= r.d - 0.08) { rot = false; break; }
    if (r.d > r.w && m.w <= r.d - 0.12 && m.h <= r.w - 0.08) { rot = true; break; }
  }
  const m = measure(fs);
  const [bw, bh] = rot ? [m.h, m.w] : [m.w, m.h];
  const cands: { x: number; y: number }[] = [];
  for (const fy of [0.5, 0.68, 0.32, 0.82, 0.18]) for (const fx of [0.5, 0.32, 0.68, 0.2, 0.8]) {
    const x = Math.min(Math.max(r.x + r.w * fx, r.x + bw / 2 + 0.06), r.x + r.w - bw / 2 - 0.06);
    const y = Math.min(Math.max(r.y + r.d * fy, r.y + bh / 2 + 0.04), r.y + r.d - bh / 2 - 0.04);
    cands.push({ x, y });
  }
  const cx = r.x + r.w / 2; const cy = r.y + r.d / 2;
  const score = (p: { x: number; y: number }) => {
    const box = { x: p.x - bw / 2, y: p.y - bh / 2, w: bw, d: bh };
    return mine.reduce((t, i) => t + overlapArea(box, i), 0) * 40 + Math.hypot(p.x - cx, p.y - cy) * 0.3;
  };
  const best = cands.reduce((b, p) => (score(p) < score(b) ? p : b), cands[0]!);
  const x = f.X(best.x); const y = f.Y(best.y);
  const lift = size ? fs * 0.25 : -fs * 0.35;
  return (
    <g textAnchor="middle" transform={rot ? `rotate(-90 ${x} ${y})` : undefined}>
      <text x={x} y={y - lift} fontSize={fs} fontWeight={700} fill={TEXT} letterSpacing={0.1}>{name}</text>
      {size && <text x={x} y={y - lift + fs * 1.05} fontSize={fs * 0.82} fill={MUTED}>{size}</text>}
    </g>
  );
}

/** The house's front door: an outside door on the ground floor, from the entrance hall or lobby if there is one, nearest the street. */
function entranceDoor(d: Design, rooms: Room[]): { o: Design['openings'][number]; room: Room } | null {
  const doors = d.openings.filter((o) => o.storey === 0 && o.kind === 'door' && o.external)
    .map((o) => ({ o, room: rooms.find((r) => r.id === o.roomId) }))
    .filter((x): x is { o: Design['openings'][number]; room: Room } => !!x.room);
  if (!doors.length) return null;
  const rank = (x: { o: Design['openings'][number]; room: Room }) => (/entrance|lobby|foyer/i.test(x.room.name) || x.room.kind === 'lobby' ? 0 : x.room.kind === 'corridor' ? 1 : x.room.kind === 'living' ? 2 : 3) * 100
    + (x.o.dir === 'h' ? x.o.at : 50 + x.room.y);
  return [...doors].sort((a, b) => rank(a) - rank(b))[0]!;
}

/** A free corner of a room for a potted plant: clear of the furniture and at least 1 m from any door. */
function plantCorner(r: Room, items: Furnishing[], ops: Design['openings']): { x: number; y: number } | null {
  const s = 0.6;
  const doors = ops.filter((o) => o.kind === 'door' && o.storey === r.storey)
    .map((o) => (o.dir === 'h' ? { x: o.from - 0.4, y: o.at - 1, w: o.to - o.from + 0.8, d: 2 } : { x: o.at - 1, y: o.from - 0.4, w: 2, d: o.to - o.from + 0.8 }));
  const corners = [{ x: r.x + 0.08, y: r.y + r.d - s - 0.08 }, { x: r.x + r.w - s - 0.08, y: r.y + r.d - s - 0.08 }, { x: r.x + 0.08, y: r.y + 0.08 }, { x: r.x + r.w - s - 0.08, y: r.y + 0.08 }];
  for (const c of corners) {
    const box = { ...c, w: s, d: s };
    if (items.some((i) => overlapArea(box, i) > 0) || doors.some((dz) => overlapArea(box, dz) > 0)) continue;
    return { x: c.x + s / 2, y: c.y + s / 2 };
  }
  return null;
}
