/**
 * Landscaping the plot: fence and gates, driveway and walkway, a paved apron round the house, lawn, hedge, flower
 * beds, trees and palms, a pool, a gazebo and outdoor lights. The layout is generated around the chosen design from
 * a few choices; the person can then place more trees, shrubs, beds and lights, or remove any generated item.
 * Pure and deterministic like the design engine, so the 3D view, the site plan and the materials list agree.
 */
import { DEFAULT_DESIGN_CONFIG, type Design, type DesignConfig, type MaterialLine, type Rect } from './design';

export type PlaceableKind = 'tree' | 'palm' | 'shrub' | 'bed' | 'light';
export type PavingMaterial = 'interlock' | 'concrete' | 'gravel';

export interface LandscapeOptions {
  fence: 'none' | 'block' | 'block-railing';
  gate: 'sliding' | 'swing';
  driveway: 'none' | PavingMaterial;
  walkway: boolean;
  /** A paved strip round the house that keeps rain off the foundations. */
  apron: boolean;
  lawn: boolean;
  trees: 'none' | 'few' | 'many';
  hedge: boolean;
  flowerBeds: boolean;
  pool: boolean;
  gazebo: boolean;
  lights: boolean;
  /** Items the person placed themselves (plan metres), and generated items they removed (by id). */
  added: { kind: PlaceableKind; x: number; y: number }[];
  removed: string[];
}

export const DEFAULT_LANDSCAPE: LandscapeOptions = {
  // A low wall with railings and a hedge: secure but open to the street (a solid wall reads as a compound).
  fence: 'block-railing', gate: 'sliding', driveway: 'interlock', walkway: true, apron: true, lawn: true, trees: 'few',
  hedge: true, flowerBeds: true, pool: false, gazebo: false, lights: true, added: [], removed: [],
};

export type LandscapeKind = 'lawn' | 'fence' | 'gate' | 'paving' | 'hedge' | 'bed' | 'tree' | 'palm' | 'shrub' | 'pool' | 'gazebo' | 'light';

/** Every item is a rectangle in plan metres (plants: the canopy's square), with what it is and what it is made of. */
export interface LandscapeItem extends Rect {
  id: string;
  kind: LandscapeKind;
  label: string;
  material?: PavingMaterial;
  use?: 'driveway' | 'walkway' | 'apron';
  heightM?: number;
  railing?: boolean;
  /** Placed by the person rather than generated. */
  placed?: boolean;
}

export interface Landscape { options: LandscapeOptions; items: LandscapeItem[]; notes: string[] }

export const PLACEABLE: Record<PlaceableKind, { label: string; size: number }> = {
  tree: { label: 'Shade tree', size: 4 }, palm: { label: 'Palm', size: 3 }, shrub: { label: 'Shrub', size: 1.2 },
  bed: { label: 'Flower bed', size: 2 }, light: { label: 'Garden light', size: 0.25 },
};

export function normaliseLandscape(o: Partial<LandscapeOptions> | null | undefined): LandscapeOptions {
  const x = { ...DEFAULT_LANDSCAPE, ...(o ?? {}) };
  const pick = <T extends string>(v: unknown, ok: readonly T[], d: T): T => (ok.includes(v as T) ? (v as T) : d);
  return {
    fence: pick(x.fence, ['none', 'block', 'block-railing'], 'block'),
    gate: pick(x.gate, ['sliding', 'swing'], 'sliding'),
    driveway: pick(x.driveway, ['none', 'interlock', 'concrete', 'gravel'], 'interlock'),
    walkway: !!x.walkway, apron: !!x.apron, lawn: !!x.lawn,
    trees: pick(x.trees, ['none', 'few', 'many'], 'few'),
    hedge: !!x.hedge, flowerBeds: !!x.flowerBeds, pool: !!x.pool, gazebo: !!x.gazebo, lights: !!x.lights,
    added: Array.isArray(x.added) ? x.added.filter((a) => a && Object.hasOwn(PLACEABLE, a.kind) && Number.isFinite(a.x) && Number.isFinite(a.y)).slice(0, 200) : [],
    removed: Array.isArray(x.removed) ? x.removed.filter((r) => typeof r === 'string').slice(0, 500) : [],
  };
}

const T = 0.225; // fence wall thickness
const r2 = (n: number) => Math.round(n * 100) / 100;
const inflate = (r: Rect, m: number): Rect => ({ x: r.x - m, y: r.y - m, w: r.w + 2 * m, d: r.d + 2 * m });
const hits = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y) > 1e-6;
const inside = (r: Rect, W: number, D: number) => r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= W + 1e-6 && r.y + r.d <= D + 1e-6;
const area = (r: Rect) => r.w * r.d;

/** Cuts a strip into the pieces not covered by any obstacle, along its long axis. */
function subtract(strip: Rect, obstacles: Rect[], minLen = 0.5): Rect[] {
  const alongX = strip.w >= strip.d;
  let pieces: [number, number][] = [alongX ? [strip.x, strip.x + strip.w] : [strip.y, strip.y + strip.d]];
  for (const o of obstacles) {
    if (!hits(strip, o)) continue;
    const [c0, c1] = alongX ? [o.x, o.x + o.w] : [o.y, o.y + o.d];
    pieces = pieces.flatMap(([a, b]) => [[a, Math.min(b, c0)], [Math.max(a, c1), b]] as [number, number][]).filter(([a, b]) => b - a >= minLen);
  }
  return pieces.map(([a, b]) => (alongX ? { ...strip, x: r2(a), w: r2(b - a) } : { ...strip, y: r2(a), d: r2(b - a) }));
}

/** Lays the landscape out around the design. */
export function planLandscape(d: Design, optsIn: Partial<LandscapeOptions>, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): Landscape {
  const o = normaliseLandscape(optsIn);
  const W = d.plot.widthM; const D = d.plot.depthM;
  const items: LandscapeItem[] = [];
  const notes: string[] = [];
  const add = (it: LandscapeItem) => { if (it.w > 0.05 && it.d > 0.05) items.push({ ...it, x: r2(it.x), y: r2(it.y), w: r2(it.w), d: r2(it.d) }); };
  const blocks = d.blocks;
  const front = d.footprint;
  const paved: Rect[] = [];

  if (o.lawn) add({ id: 'lawn', kind: 'lawn', label: 'Lawn', x: T, y: T, w: W - 2 * T, d: D - 2 * T });

  // Driveway from the gate to the parking in front of the house.
  let drive: Rect | null = null;
  if (o.driveway !== 'none') {
    if (d.parking.length) {
      const x0 = Math.max(T, Math.min(...d.parking.map((p) => p.x)) - 0.6);
      const x1 = Math.min(W - T, Math.max(...d.parking.map((p) => p.x + p.w)) + 0.6);
      drive = { x: x0, y: 0, w: x1 - x0, d: Math.max(...d.parking.map((p) => p.y + p.d)) };
      add({ id: 'driveway', kind: 'paving', use: 'driveway', material: o.driveway, label: `Driveway (${pavingLabel(o.driveway)})`, ...drive });
      paved.push(drive);
    } else notes.push('No parking in the brief, so there is no driveway; the walkway leads from the gate.');
  }

  // The front door, and a walkway to it.
  const door = d.openings.find((p) => p.label === 'Front door' && p.storey === 0);
  const doorRoom = door ? d.rooms.find((r) => r.id === door.roomId) : undefined;
  let walk: Rect | null = null;
  if (o.walkway && door && doorRoom) {
    const mid = (door.from + door.to) / 2;
    if (door.dir === 'h') {
      const start = drive && mid > drive.x && mid < drive.x + drive.w ? drive.y + drive.d : 0;
      if (door.at - start > 0.3) walk = { x: mid - 0.6, y: start, w: 1.2, d: door.at - start };
    } else {
      const left = Math.abs(doorRoom.x - door.at) < 1e-6;
      walk = { x: left ? door.at - 1.3 : door.at + 0.1, y: 0, w: 1.2, d: mid + 0.6 };
    }
    if (walk && inside(walk, W, D)) {
      add({ id: 'walkway', kind: 'paving', use: 'walkway', material: o.driveway === 'none' ? 'interlock' : o.driveway === 'gravel' ? 'interlock' : o.driveway, label: 'Walkway to the front door', ...walk });
      paved.push(walk);
    } else walk = null;
  }

  // Apron: a 0.9 m paved strip round each building, cut where wings meet.
  if (o.apron) {
    const m = o.driveway === 'interlock' ? 'interlock' : 'concrete';
    blocks.forEach((b, i) => {
      const others = blocks.filter((k) => k !== b);
      const strips = [
        { x: b.x - 0.9, y: b.y - 0.9, w: b.w + 1.8, d: 0.9 }, { x: b.x - 0.9, y: b.y + b.d, w: b.w + 1.8, d: 0.9 },
        { x: b.x - 0.9, y: b.y, w: 0.9, d: b.d }, { x: b.x + b.w, y: b.y, w: 0.9, d: b.d },
      ];
      strips.flatMap((s) => subtract(s, others)).forEach((s, j) => {
        const c: Rect = { x: Math.max(T, s.x), y: Math.max(T, s.y), w: 0, d: 0 };
        c.w = Math.min(W - T, s.x + s.w) - c.x; c.d = Math.min(D - T, s.y + s.d) - c.y;
        if (c.w > 0.3 && c.d > 0.3) { add({ id: `apron-${i}-${j}`, kind: 'paving', use: 'apron', material: m, label: 'Paved apron', ...c }); paved.push(c); }
      });
    });
  }

  // Fence round the plot, with a vehicle gate at the driveway and a pedestrian gate by the walkway.
  const gates: Rect[] = [];
  if (o.fence !== 'none') {
    const gw = o.gate === 'sliding' ? 4 : 3.6;
    if (drive) {
      const c = drive.x + drive.w / 2; const w = Math.min(gw, drive.w);
      const g = { x: Math.max(0.3, c - w / 2), y: 0, w, d: T };
      gates.push(g);
      add({ id: 'gate', kind: 'gate', label: `${o.gate === 'sliding' ? 'Sliding' : 'Swing'} vehicle gate`, heightM: 2.1, ...g });
    }
    const px = walk && walk.y < 0.5 ? walk.x + walk.w / 2 - 0.5 : gates[0] ? gates[0].x + gates[0].w + 0.4 : W / 2 - 0.5;
    const pg = { x: Math.min(W - 1.4, Math.max(0.3, px)), y: 0, w: 1, d: T };
    if (!gates.some((g) => hits(inflate(g, 0.2), pg))) {
      gates.push(pg);
      add({ id: 'gate-pedestrian', kind: 'gate', label: 'Pedestrian gate', heightM: 2.1, ...pg });
    }
    const h = 2.1; const railing = o.fence === 'block-railing';
    const label = railing ? 'Block fence with railing' : 'Block fence';
    subtract({ x: 0, y: 0, w: W, d: T }, gates, 0.2).forEach((s, i) => add({ id: `fence-front-${i}`, kind: 'fence', label, heightM: h, railing, ...s }));
    add({ id: 'fence-left', kind: 'fence', label, heightM: h, railing, x: 0, y: T, w: T, d: D - 2 * T });
    add({ id: 'fence-right', kind: 'fence', label, heightM: h, railing, x: W - T, y: T, w: T, d: D - 2 * T });
    add({ id: 'fence-rear', kind: 'fence', label, heightM: h, railing, x: 0, y: D - T, w: W, d: T });
  }

  // Hedge along the front, inside the fence.
  if (o.hedge) {
    const cut = [...gates, ...paved].map((r) => inflate(r, 0.3));
    subtract({ x: T + 0.1, y: T + 0.1, w: W - 2 * T - 0.2, d: 0.6 }, cut).forEach((s, i) => add({ id: `hedge-${i}`, kind: 'hedge', label: 'Hedge', heightM: 1.2, ...s }));
  }

  // Flower beds along the street side of the house, clear of the paving and parking.
  const beds: Rect[] = [];
  if (o.flowerBeds) {
    const off = o.apron ? 0.9 : 0.1;
    const blocked = [...paved.filter((p) => !items.some((it) => it.use === 'apron' && it.x === p.x && it.y === p.y)), ...d.parking].map((r) => inflate(r, 0.3));
    for (const b of blocks.filter((k) => k.kind === 'house' && !blocks.some((q) => q !== k && Math.abs(q.y + q.d - k.y) < 1e-6))) {
      const strip = { x: b.x, y: b.y - off - 0.8, w: b.w, d: 0.8 };
      if (strip.y < T + 0.2) continue;
      subtract(strip, blocked, 1).forEach((s, i) => { beds.push(s); add({ id: `bed-${b.id}-${i}`, kind: 'bed', label: 'Flower bed', ...s }); });
    }
  }

  const taken = (): Rect[] => [...blocks.map((b) => inflate(b, 1)), ...paved, ...d.parking, ...beds, ...items.filter((i) => i.kind === 'pool' || i.kind === 'gazebo')];
  const fits = (r: Rect, clear: Rect[]) => r.x >= T + 1 && r.y >= T + 1 && r.x + r.w <= W - T - 1 && r.y + r.d <= D - T - 1 && !clear.some((c) => hits(c, r));

  // Pool and gazebo in the back garden.
  const rearY = Math.max(...blocks.filter((b) => b.kind === 'house').map((b) => b.y + b.d));
  const scan = (w: number, dd: number, prefer: (r: Rect) => number): Rect | null => {
    const clear = taken().map((r) => inflate(r, 0.5));
    const found: Rect[] = [];
    for (let y = rearY + 2; y + dd <= D - T - 1; y += 0.5) for (let x = T + 1; x + w <= W - T - 1; x += 0.5) {
      const r = { x, y, w, d: dd };
      if (fits(r, clear)) found.push(r);
    }
    return found.sort((a, b) => prefer(a) - prefer(b))[0] ?? null;
  };
  if (o.pool) {
    const cx = front.x + front.w / 2;
    const p = scan(8, 4, (r) => Math.abs(r.x + r.w / 2 - cx) + (r.y - rearY) * 0.5) ?? scan(6, 3, (r) => Math.abs(r.x + r.w / 2 - cx));
    if (p) add({ id: 'pool', kind: 'pool', label: `Swimming pool (${p.w} × ${p.d} m)`, ...p });
    else notes.push('A swimming pool does not fit in the back garden with paths round it; a larger plot or a smaller house would make room.');
  }
  if (o.gazebo) {
    const bq = blocks.find((b) => b.kind === 'outbuilding');
    const g = scan(3.5, 3.5, (r) => (bq ? -Math.hypot(r.x - bq.x, r.y - bq.y) : -r.y));
    if (g) add({ id: 'gazebo', kind: 'gazebo', label: 'Gazebo', heightM: 3, ...g });
    else notes.push('A gazebo does not fit in the back garden.');
  }

  // Trees round the edges of the plot (palms near the street), kept clear of the buildings and paving.
  if (o.trees !== 'none') {
    const step = o.trees === 'many' ? 4.5 : 7; const max = o.trees === 'many' ? 18 : 7;
    const pts: { x: number; y: number }[] = [];
    const inset = 2.3; // a 2 m canopy stays inside the boundary
    const walkEdge = (x0: number, y0: number, x1: number, y1: number) => {
      const len = Math.hypot(x1 - x0, y1 - y0); const n = Math.max(1, Math.floor(len / step));
      for (let i = 0; i <= n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n });
    };
    walkEdge(inset, D - inset, W - inset, D - inset);
    walkEdge(inset, inset + 2, inset, D - inset - step / 2);
    walkEdge(W - inset, inset + 2, W - inset, D - inset - step / 2);
    walkEdge(inset + 2, inset, W - inset - 2, inset);
    let n = 0;
    const placed: Rect[] = [];
    for (const p of pts) {
      if (n >= max) break;
      const palm = p.y < 5;
      const r = palm ? 1.5 : 2;
      const c: Rect = { x: p.x - r, y: p.y - r, w: 2 * r, d: 2 * r };
      const clear = [...blocks.map((b) => inflate(b, palm ? 1.5 : 2.5)), ...[...paved, ...d.parking, ...gates].map((q) => inflate(q, 0.6)), ...items.filter((i) => i.kind === 'pool' || i.kind === 'gazebo').map((q) => inflate(q, 0.5)), ...placed];
      if (clear.some((q) => hits(q, { x: p.x - 0.4, y: p.y - 0.4, w: 0.8, d: 0.8 })) || placed.some((q) => hits(q, c))) continue;
      placed.push(c);
      add({ id: `tree-${n}`, kind: palm ? 'palm' : 'tree', label: palm ? 'Palm' : 'Shade tree', heightM: palm ? 6 : 7, ...c });
      n++;
    }
  }

  // Lights along the walkway and the driveway, and at the gates.
  if (o.lights) {
    let k = 0;
    const light = (x: number, y: number) => add({ id: `light-${k++}`, kind: 'light', label: 'Garden light', heightM: 0.8, x: x - 0.12, y: y - 0.12, w: 0.25, d: 0.25 });
    if (walk) for (let y = walk.y + 1.5, i = 0; y < walk.y + walk.d - 0.5; y += 3, i++) light(i % 2 ? walk.x - 0.3 : walk.x + walk.w + 0.3, y);
    if (drive) for (let y = 2; y < drive.y + drive.d - 0.5; y += 4) { light(drive.x - 0.3, y); if (drive.x + drive.w + 0.3 < W - T) light(drive.x + drive.w + 0.3, y); }
    for (const g of gates) { light(g.x - 0.2, T + 0.3); light(g.x + g.w + 0.2, T + 0.3); }
  }

  // The person's own changes: generated items removed, items they placed added.
  const removed = new Set(o.removed);
  const kept = items.filter((i) => !removed.has(i.id));
  o.added.forEach((a, i) => {
    const s = PLACEABLE[a.kind].size;
    const r: Rect = a.kind === 'bed' ? { x: a.x - 1, y: a.y - 0.5, w: 2, d: 1 } : { x: a.x - s / 2, y: a.y - s / 2, w: s, d: s };
    if (!inside(r, W, D) || blocks.some((b) => hits(b, { x: a.x - 0.1, y: a.y - 0.1, w: 0.2, d: 0.2 }))) { notes.push(`A ${PLACEABLE[a.kind].label.toLowerCase()} placed on a building or outside the plot was left out.`); return; }
    kept.push({ id: `added-${i}`, kind: a.kind, label: PLACEABLE[a.kind].label, placed: true, heightM: a.kind === 'tree' ? 7 : a.kind === 'palm' ? 6 : a.kind === 'shrub' ? 1.2 : a.kind === 'light' ? 0.8 : undefined, x: r2(r.x), y: r2(r.y), w: r2(r.w), d: r2(r.d) });
  });
  return { options: o, items: kept, notes };
}

function pavingLabel(m: PavingMaterial) { return m === 'interlock' ? 'interlocking paving' : m === 'concrete' ? 'concrete' : 'gravel'; }

/** What the landscape takes to build, priced through the marketplace like the house. */
export function landscapeMaterials(l: Landscape, d: Design, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): MaterialLine[] {
  const m = cfg.materials;
  const lines: MaterialLine[] = [];
  const add = (x: Omit<MaterialLine, 'section'>) => { if (x.quantity > 0) lines.push({ section: 'external', ...x }); };
  const of = (k: LandscapeKind) => l.items.filter((i) => i.kind === k);
  const bags = (m3: number) => Math.ceil((m3 * m.cementKgPerM3) / m.bagKg);
  const tonnes = (m3: number, t: number) => Math.round(Math.ceil(m3 * t * 2) / 2 * 10) / 10;

  // Fence: 9" blockwork on a strip footing with reinforced pillars every 3 m, plastered both sides.
  const fence = of('fence');
  const L = fence.reduce((s, f) => s + Math.max(f.w, f.d), 0);
  if (L > 0) {
    const h = fence[0]!.heightM ?? 2.1;
    const wallArea = L * (h + m.foundation.coursesBelowDpc * m.block.faceHeightM);
    const blocks = Math.ceil(wallArea / (m.block.faceLengthM * m.block.faceHeightM) * (1 + m.block.wastePct / 100));
    const pillars = Math.ceil(L / 3) + 1;
    const concrete = L * 0.45 * 0.225 + pillars * (0.225 * 0.225 * (h + 0.6));
    const [c, sd, g] = m.concreteMix; const parts = c + sd + g; const dry = concrete * m.dryFactor.concrete;
    const mortar = blocks * m.mortarM3PerBlock.external * m.dryFactor.mortar;
    const plaster = L * h * 2 * m.plasterM * m.dryFactor.mortar;
    const cement = (dry * c) / parts + mortar / (1 + m.mortarMix) + plaster / (1 + m.plasterMix);
    const sand = (dry * sd) / parts + mortar - mortar / (1 + m.mortarMix) + plaster - plaster / (1 + m.plasterMix);
    add({ key: 'fence-excavation', name: 'Fence trench excavation', unit: 'm³', quantity: Math.round(L * 0.45 * 0.6 * 10) / 10, basis: `${Math.round(L)} m of fence × 0.45 m × 0.6 m deep`, shop: { category: 'plant-hire', q: 'excavator' }, provisional: true });
    add({ key: 'fence-blocks', name: 'Fence blocks, 9 inch sandcrete', unit: 'piece', quantity: blocks, basis: `${Math.round(L)} m of fence, ${h} m high plus ${m.foundation.coursesBelowDpc} courses below ground, + ${m.block.wastePct}% waste`, shop: { category: 'blocks', q: '9 inch block', attrs: { size: '9in' } } });
    add({ key: 'fence-cement', name: 'Cement for the fence (50 kg bags)', unit: 'bag', quantity: bags(cement), basis: `Footing and ${pillars} pillars at 1:2:4, block mortar, plaster both sides`, shop: { category: 'cement', q: 'cement', pack: { value: 50, unit: 'kg' } } });
    add({ key: 'fence-sand', name: 'Sharp sand for the fence', unit: 'tonne', quantity: tonnes(sand, m.sandTPerM3), basis: 'Concrete, mortar and plaster', shop: { category: 'sand-granite', q: 'sharp sand', attrs: { material: 'sharp-sand' } } });
    add({ key: 'fence-granite', name: 'Granite chippings for the fence', unit: 'tonne', quantity: tonnes((dry * g) / parts, m.graniteTPerM3), basis: 'Footing and pillars', shop: { category: 'sand-granite', q: 'granite', attrs: { material: 'granite-3-4' } } });
    add({ key: 'fence-rebar', name: 'Fence pillar bars, 12 mm', unit: 'piece', quantity: Math.ceil((pillars * 4 * (h + 0.9)) / m.bar.lengthM), basis: `${pillars} pillars with 4 bars each; ${m.bar.lengthM} m lengths`, shop: { category: 'reinforcement', q: '12mm' } });
    if (fence.some((f) => f.railing)) add({ key: 'fence-railing', name: 'Steel railing on top of the fence', unit: 'm', quantity: Math.ceil(L), basis: 'Along the whole fence', shop: { q: 'railing' } });
  }
  for (const g of of('gate')) {
    add({ key: g.id, name: g.label === 'Pedestrian gate' ? 'Pedestrian steel gate (1 m)' : `${g.label.split(' ')[0]} steel gate (${Math.round(g.w * 10) / 10} m)`, unit: 'piece', quantity: 1, basis: 'Fabricated and installed, with lock', shop: { category: 'landscaping', q: 'gate' } });
  }

  // Paving.
  const paving = of('paving');
  const byMat = (mt: PavingMaterial) => paving.filter((p) => p.material === mt);
  const sum = (rs: Rect[]) => rs.reduce((s, r) => s + area(r), 0);
  const inter = sum(byMat('interlock')); const conc = sum(byMat('concrete')); const grav = sum(byMat('gravel'));
  if (inter > 0) {
    add({ key: 'paving-interlock', name: 'Interlocking paving stones (60–80 mm)', unit: 'm²', quantity: Math.ceil(inter * 1.05), basis: `${Math.round(inter)} m² of driveway, walkway and apron + 5%`, shop: { category: 'landscaping', q: 'interlocking stones' } });
    const kerbs = byMat('interlock').filter((p) => p.use !== 'apron').reduce((s, p) => s + 2 * Math.max(p.w, p.d), 0);
    add({ key: 'paving-kerbs', name: 'Kerb stones', unit: 'piece', quantity: Math.ceil(kerbs / 0.5), basis: `${Math.round(kerbs)} m of edging along the driveway and walkway, 0.5 m kerbs`, shop: { category: 'landscaping', q: 'kerb' } });
    add({ key: 'paving-sand', name: 'Sharp sand for the paving bed (50 mm)', unit: 'tonne', quantity: tonnes(inter * 0.05, m.sandTPerM3), basis: 'Bedding and joint sand', shop: { category: 'sand-granite', q: 'sharp sand', attrs: { material: 'sharp-sand' } } });
  }
  if (conc > 0) {
    const v = conc * 0.1; const [c, sd, g] = m.concreteMix; const parts = c + sd + g; const dry = v * m.dryFactor.concrete;
    add({ key: 'paving-concrete-cement', name: 'Cement for concrete paving (100 mm, 1:2:4)', unit: 'bag', quantity: bags((dry * c) / parts), basis: `${Math.round(conc)} m² of concrete paving`, shop: { category: 'cement', q: 'cement', pack: { value: 50, unit: 'kg' } } });
    add({ key: 'paving-concrete-granite', name: 'Granite chippings for concrete paving', unit: 'tonne', quantity: tonnes((dry * g) / parts, m.graniteTPerM3), basis: 'Concrete paving', shop: { category: 'sand-granite', q: 'granite', attrs: { material: 'granite-3-4' } } });
    add({ key: 'paving-concrete-sand', name: 'Sharp sand for concrete paving', unit: 'tonne', quantity: tonnes((dry * sd) / parts, m.sandTPerM3), basis: 'Concrete paving', shop: { category: 'sand-granite', q: 'sharp sand', attrs: { material: 'sharp-sand' } } });
  }
  if (grav > 0) add({ key: 'paving-gravel', name: 'Granite chippings for a gravel driveway (80 mm)', unit: 'tonne', quantity: tonnes(grav * 0.08, m.graniteTPerM3), basis: `${Math.round(grav)} m² of gravel`, shop: { category: 'sand-granite', q: 'granite', attrs: { material: 'granite-3-4' } } });
  if (inter + conc + grav > 0) add({ key: 'paving-base', name: 'Laterite base for paving (150 mm, compacted)', unit: 'm³', quantity: Math.ceil((inter + conc + grav) * 0.15), basis: 'Under all paving', shop: { q: 'laterite filling' } });

  // Soft landscaping.
  if (of('lawn').length) {
    const lawnM2 = lawnArea(l, d);
    add({ key: 'lawn-grass', name: 'Carpet grass (turf)', unit: 'm²', quantity: Math.ceil(lawnM2 * 1.05), basis: `${lawnM2} m² of lawn + 5%`, shop: { category: 'landscaping', q: 'carpet grass' } });
    add({ key: 'lawn-topsoil', name: 'Topsoil for the lawn (100 mm)', unit: 'm³', quantity: Math.ceil(lawnM2 * 0.1), basis: 'Spread and levelled under the grass', shop: { category: 'landscaping', q: 'topsoil' } });
  }
  const hedge = of('hedge').reduce((s, h) => s + Math.max(h.w, h.d), 0);
  if (hedge > 0) add({ key: 'hedge-plants', name: 'Hedge plants (ixora, hibiscus or similar)', unit: 'piece', quantity: Math.ceil(hedge * 3), basis: `${Math.round(hedge)} m of hedge, 3 plants per metre`, shop: { category: 'landscaping', q: 'hedge plants' } });
  const bedArea = sum(of('bed'));
  if (bedArea > 0) {
    add({ key: 'bed-plants', name: 'Flowers and bedding plants', unit: 'piece', quantity: Math.ceil(bedArea * 6), basis: `${Math.round(bedArea * 10) / 10} m² of beds, 6 plants per m²`, shop: { category: 'landscaping', q: 'flowers' } });
    add({ key: 'bed-soil', name: 'Garden soil and compost for beds', unit: 'm³', quantity: Math.ceil(bedArea * 0.25), basis: '250 mm deep', shop: { category: 'landscaping', q: 'garden soil' } });
  }
  add({ key: 'trees', name: 'Shade and ornamental trees (nursery stock)', unit: 'piece', quantity: of('tree').length, basis: 'Planted at least 2.5 m from the house', shop: { category: 'landscaping', q: 'trees' } });
  add({ key: 'palms', name: 'Palm trees (nursery stock)', unit: 'piece', quantity: of('palm').length, basis: 'Along the street side', shop: { category: 'landscaping', q: 'palm' } });
  add({ key: 'shrubs', name: 'Shrubs', unit: 'piece', quantity: of('shrub').length, basis: 'Placed by you', shop: { category: 'landscaping', q: 'shrubs' } });
  for (const p of of('pool')) {
    add({ key: 'pool-excavation', name: 'Pool excavation', unit: 'm³', quantity: Math.ceil(area(p) * 1.6), basis: `${p.w} × ${p.d} m, about 1.6 m deep on average`, shop: { category: 'plant-hire', q: 'excavator' }, provisional: true });
    add({ key: 'pool', name: `Swimming pool (shell, tiling, pump and filter), ${p.w} × ${p.d} m`, unit: 'lot', quantity: 1, basis: 'Designed and built by a pool contractor; reinforced shell sized by the engineer', shop: { category: 'trades', q: 'swimming pool' }, provisional: true });
  }
  for (const g of of('gazebo')) add({ key: 'gazebo', name: `Gazebo, ${g.w} × ${g.d} m`, unit: 'piece', quantity: 1, basis: 'Timber or steel frame with a roof', shop: { category: 'landscaping', q: 'gazebo' } });
  const lights = of('light').length;
  if (lights) {
    add({ key: 'garden-lights', name: 'Outdoor bollard and gate lights', unit: 'piece', quantity: lights, basis: 'Along the paths and at the gates', shop: { category: 'landscaping', q: 'outdoor light' } });
    add({ key: 'garden-cable', name: 'Armoured cable for outdoor lights', unit: 'm', quantity: Math.ceil(lights * 6), basis: 'About 6 m per light, routed by the electrician', shop: { q: 'armoured cable' }, provisional: true });
  }
  return lines;
}

/** Open ground left for the lawn: the plot less buildings, paving, beds, pool and gazebo. */
export function lawnArea(l: Landscape, d: Design): number {
  const lawn = l.items.find((i) => i.kind === 'lawn');
  if (!lawn) return 0;
  const hard = l.items.filter((i) => ['paving', 'bed', 'pool', 'gazebo', 'hedge'].includes(i.kind)).reduce((s, r) => s + area(r), 0);
  return Math.max(0, Math.round(area(lawn) - hard - d.blocks.reduce((s, b) => s + area(b), 0) - d.parking.reduce((s, p) => s + area(p), 0)));
}
