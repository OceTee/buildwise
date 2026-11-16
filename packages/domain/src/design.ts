/**
 * AI-first build flow: plot → brief → generated designs → 3D geometry → bill of materials.
 *
 * Everything here is pure and deterministic so it runs in the browser (live 3D as the user types) and on the
 * server (sourcing, saved projects) with identical results. Units are metres. Plan coordinates: x runs along the
 * plot frontage (left to right seen from the street), y runs from the front boundary (y = 0) to the rear.
 *
 * Generated designs are CONCEPT designs. They are checked against the planning and building rules an architect
 * checks first (setbacks, coverage, room sizes, light and ventilation, circulation, stairs), but they are not
 * stamped construction drawings; the user is always told so and offered an architect.
 *
 * All rule values live in DesignConfig, which belongs to the market pack. The defaults below are [Proposed]
 * placeholders until a market's code (for Nigeria, the National Building Code and state planning rules) is
 * confirmed by a registered architect.
 */

// ---------------------------------------------------------------- configuration

export type RoomKind =
  | 'living' | 'dining' | 'kitchen' | 'living-kitchen' | 'lounge'
  | 'master' | 'bedroom' | 'study'
  | 'bathroom' | 'ensuite' | 'wc' | 'store'
  | 'stair' | 'corridor';

export const HABITABLE: ReadonlySet<RoomKind> = new Set(['living', 'dining', 'kitchen', 'living-kitchen', 'lounge', 'master', 'bedroom', 'study']);
export const WET: ReadonlySet<RoomKind> = new Set(['bathroom', 'ensuite', 'wc']);

export interface RoomRule { targetM2: number; minM2: number; minDimM: number }

export interface DesignConfig {
  setbacksM: { front: number; side: number; rear: number };
  maxCoveragePct: number;
  storeyHeightM: number;
  minCeilingM: number;
  slabM: number;
  wallM: { external: number; internal: number };
  rooms: Record<Exclude<RoomKind, 'corridor' | 'stair'>, RoomRule>;
  corridorM: number;
  minCorridorM: number;
  /** Minimum depth of a room band, so rooms are never strips. */
  minBandM: number;
  doorM: { entrance: number; internal: number; wet: number; external: number };
  minDoorM: number;
  doorHeightM: number;
  window: { heightM: number; sillM: number; wetWidthM: number; wetHeightM: number; wetSillM: number };
  minWindowPctOfFloor: number;
  stair: { widthM: number; minRunM: number; minWidthM: number };
  parking: { widthM: number; depthM: number };
  roof: { pitchDeg: number; overhangM: number; parapetM: number };
  materials: MaterialFactors;
}

export interface MaterialFactors {
  block: { faceLengthM: number; faceHeightM: number; wastePct: number; external: string; internal: string };
  mortarM3PerBlock: { external: number; internal: number };
  mortarMix: number;          // 1 : n cement : sand
  plasterMix: number;
  plasterM: number;
  concreteMix: [number, number, number];
  dryFactor: { concrete: number; mortar: number };
  cementKgPerM3: number;
  bagKg: number;
  sandTPerM3: number;
  graniteTPerM3: number;
  foundation: { widthM: number; depthM: number; excavationM: number; coursesBelowDpc: number };
  hardcoreM: number;
  rebarKgPerM3: { slab: number; stair: number };
  ringBeamM: number;
  columnSpacingM: number;
  bar: { lengthM: number; y12KgPerM: number; r8KgPerM: number; wastePct: number };
  timber: { pieceLengthM: number; rafterSpacingM: number; purlinSpacingM: number };
  tile: { wastePct: number; adhesiveM2PerBag: number; wetWallHeightM: number };
  paint: { m2PerLitre: { internal: number; external: number }; coats: number; bucketLitres: number };
}

/** [Proposed] defaults. Real values come from the market's building code, confirmed by a registered architect. */
export const DEFAULT_DESIGN_CONFIG: DesignConfig = {
  setbacksM: { front: 3, side: 1.5, rear: 1.5 },
  maxCoveragePct: 60,
  storeyHeightM: 3.0,
  minCeilingM: 2.7,
  slabM: 0.15,
  wallM: { external: 0.225, internal: 0.15 },
  rooms: {
    living: { targetM2: 20, minM2: 13, minDimM: 3.0 },
    dining: { targetM2: 10, minM2: 7, minDimM: 2.4 },
    kitchen: { targetM2: 10, minM2: 6.5, minDimM: 2.1 },
    'living-kitchen': { targetM2: 32, minM2: 20, minDimM: 3.0 },
    lounge: { targetM2: 12, minM2: 7, minDimM: 2.4 },
    master: { targetM2: 15, minM2: 11, minDimM: 3.0 },
    bedroom: { targetM2: 11, minM2: 8, minDimM: 2.7 },
    study: { targetM2: 8, minM2: 6, minDimM: 2.1 },
    bathroom: { targetM2: 4.2, minM2: 3, minDimM: 1.5 },
    ensuite: { targetM2: 3.6, minM2: 2.8, minDimM: 1.5 },
    wc: { targetM2: 1.8, minM2: 1.2, minDimM: 1.0 },
    store: { targetM2: 2.5, minM2: 1.5, minDimM: 1.0 },
  },
  corridorM: 1.2,
  minCorridorM: 1.0,
  minBandM: 3.6,
  doorM: { entrance: 1.2, internal: 0.9, wet: 0.8, external: 0.9 },
  minDoorM: 0.75,
  doorHeightM: 2.1,
  window: { heightM: 1.2, sillM: 0.9, wetWidthM: 0.6, wetHeightM: 0.6, wetSillM: 1.5 },
  minWindowPctOfFloor: 10,
  stair: { widthM: 1.2, minRunM: 4.2, minWidthM: 0.9 },
  parking: { widthM: 3.0, depthM: 5.5 },
  roof: { pitchDeg: 25, overhangM: 0.6, parapetM: 0.9 },
  materials: {
    block: { faceLengthM: 0.45, faceHeightM: 0.225, wastePct: 5, external: '9 inch', internal: '6 inch' },
    mortarM3PerBlock: { external: 0.0022, internal: 0.0015 },
    mortarMix: 6,
    plasterMix: 4,
    plasterM: 0.015,
    concreteMix: [1, 2, 4],
    dryFactor: { concrete: 1.54, mortar: 1.33 },
    cementKgPerM3: 1440,
    bagKg: 50,
    sandTPerM3: 1.6,
    graniteTPerM3: 1.5,
    foundation: { widthM: 0.675, depthM: 0.225, excavationM: 0.9, coursesBelowDpc: 3 },
    hardcoreM: 0.3,
    rebarKgPerM3: { slab: 90, stair: 80 },
    ringBeamM: 0.225,
    columnSpacingM: 3.6,
    bar: { lengthM: 12, y12KgPerM: 0.888, r8KgPerM: 0.395, wastePct: 5 },
    timber: { pieceLengthM: 3.6, rafterSpacingM: 0.6, purlinSpacingM: 0.9 },
    tile: { wastePct: 10, adhesiveM2PerBag: 4, wetWallHeightM: 1.8 },
    paint: { m2PerLitre: { internal: 10, external: 8 }, coats: 2, bucketLitres: 20 },
  },
};

// ---------------------------------------------------------------- inputs

export interface Plot { widthM: number; depthM: number }

export interface DesignBrief {
  storeys: 1 | 2;
  bedrooms: number;            // 1–6, including the master
  bathrooms: number;           // shared bathrooms, besides the master's ensuite
  ensuite: boolean;
  kitchen: 'open' | 'closed';
  study: boolean;
  guestWc: boolean;
  store: boolean;
  parking: 0 | 1 | 2;
  style: 'modern' | 'classic' | 'tropical';
  roof: 'gable' | 'hip' | 'flat';
}

export const DEFAULT_BRIEF: DesignBrief = {
  storeys: 1, bedrooms: 3, bathrooms: 1, ensuite: true, kitchen: 'closed', study: false, guestWc: true, store: true,
  parking: 1, style: 'modern', roof: 'hip',
};

export const FT = 0.3048;

/** Accepts sizes like "50x100 ft", "15 by 30 m", "60 × 120"; feet when stated, else metres unless the numbers only make sense as feet. */
export function parsePlotSize(text: string): Plot | null {
  const m = text.toLowerCase().match(/(\d+(?:\.\d+)?)\s*(ft|feet|foot|'|m|metres?|meters?)?\s*(?:x|×|by|\*)\s*(\d+(?:\.\d+)?)\s*(ft|feet|foot|'|m|metres?|meters?)?/);
  if (!m) return null;
  const a = Number(m[1]); const b = Number(m[3]);
  const unit = m[4] ?? m[2];
  const feet = unit ? /^(ft|feet|foot|')$/.test(unit) : Math.max(a, b) > 60; // a 50×100 plot is feet; 15×30 is metres
  const k = feet ? FT : 1;
  const plot = { widthM: round(Math.min(a, b) * k, 2), depthM: round(Math.max(a, b) * k, 2) };
  return validPlot(plot) ? plot : null;
}

export function validPlot(p: Plot): boolean {
  return Number.isFinite(p.widthM) && Number.isFinite(p.depthM) && p.widthM >= 6 && p.depthM >= 6 && p.widthM <= 200 && p.depthM <= 400;
}

export function normaliseBrief(b: Partial<DesignBrief>): DesignBrief {
  const x = { ...DEFAULT_BRIEF, ...b };
  return {
    storeys: x.storeys === 2 ? 2 : 1,
    bedrooms: clampInt(x.bedrooms, 1, 6),
    bathrooms: clampInt(x.bathrooms, 0, 4),
    ensuite: !!x.ensuite,
    kitchen: x.kitchen === 'open' ? 'open' : 'closed',
    study: !!x.study, guestWc: !!x.guestWc, store: !!x.store,
    parking: (clampInt(x.parking, 0, 2) as 0 | 1 | 2),
    style: (['modern', 'classic', 'tropical'] as const).includes(x.style) ? x.style : 'modern',
    roof: (['gable', 'hip', 'flat'] as const).includes(x.roof) ? x.roof : 'hip',
  };
}

// ---------------------------------------------------------------- outputs

export interface Rect { x: number; y: number; w: number; d: number }
export interface Room extends Rect { id: string; kind: RoomKind; name: string; storey: number }

/** A wall run on a plan line: horizontal walls lie on y = at (from..to along x), vertical walls on x = at. */
export interface Wall { id: string; storey: number; dir: 'h' | 'v'; at: number; from: number; to: number; thickness: number; external: boolean }
export interface Opening {
  id: string; storey: number; kind: 'door' | 'window'; dir: 'h' | 'v'; at: number; from: number; to: number;
  sillM: number; headM: number; external: boolean; roomId: string; label: string;
}
export interface Roof { kind: DesignBrief['roof']; pitchDeg: number; overhangM: number; parapetM: number; ridge: 'x' | 'y' }

export type DesignCheckStatus = 'pass' | 'warn' | 'fail';
export interface DesignCheck { code: string; label: string; status: DesignCheckStatus; detail: string }

export interface Design {
  id: string;
  name: string;
  summary: string;
  plot: Plot;
  brief: DesignBrief;
  envelope: Rect;
  footprint: Rect;
  parking: Rect[];
  storeys: number;
  storeyHeightM: number;
  slabM: number;
  rooms: Room[];
  walls: Wall[];
  openings: Opening[];
  roof: Roof;
  metrics: { footprintM2: number; grossFloorM2: number; coveragePct: number; plotM2: number };
  checks: DesignCheck[];
}

export interface DesignResult { designs: Design[]; notes: string[] }

// ---------------------------------------------------------------- generator

interface Item { kind: RoomKind; name: string; target: number; min: number; minDim: number; fixedW?: number; withEnsuite?: boolean }

function item(cfg: DesignConfig, kind: Exclude<RoomKind, 'corridor' | 'stair'>, name: string): Item {
  const r = cfg.rooms[kind];
  return { kind, name, target: r.targetM2, min: r.minM2, minDim: r.minDimM };
}

/** The room programme per storey and band (front = public side facing the street, rear = private side). */
function programme(cfg: DesignConfig, b: DesignBrief): { front: Item[]; rear: Item[] }[] {
  const living = b.kitchen === 'open'
    ? [{ ...item(cfg, 'living-kitchen', 'Living, dining and kitchen'), target: cfg.rooms['living-kitchen'].targetM2 + b.bedrooms * 2 }]
    : [{ ...item(cfg, 'living', 'Living room'), target: cfg.rooms.living.targetM2 + b.bedrooms * 1.5 }, item(cfg, 'dining', 'Dining'), item(cfg, 'kitchen', 'Kitchen')];
  const master: Item = { ...item(cfg, 'master', 'Master bedroom'), withEnsuite: b.ensuite, ...(b.ensuite ? { target: cfg.rooms.master.targetM2 + cfg.rooms.ensuite.targetM2 } : {}) };
  const bedrooms = Array.from({ length: b.bedrooms - 1 }, (_, i) => item(cfg, 'bedroom', `Bedroom ${i + 2}`));
  const baths = Array.from({ length: b.bathrooms }, (_, i) => item(cfg, 'bathroom', b.bathrooms > 1 ? `Bathroom ${i + 1}` : 'Bathroom'));
  const extras = [...(b.study ? [item(cfg, 'study', 'Study')] : []), ...(b.store ? [item(cfg, 'store', 'Store')] : [])];
  const wc = b.guestWc ? [item(cfg, 'wc', 'Guest WC')] : [];
  const stair = (): Item => ({ kind: 'stair', name: 'Stair', target: cfg.stair.widthM * cfg.stair.minRunM, min: 0, minDim: cfg.stair.widthM, fixedW: cfg.stair.widthM });

  if (b.storeys === 1) {
    // Interleave bathrooms between bedrooms so each is close to the rooms it serves.
    const rear: Item[] = [master];
    const rest = [...bedrooms];
    const bathQ = [...baths];
    while (rest.length || bathQ.length) {
      if (rest.length) rear.push(rest.shift()!);
      if (bathQ.length) rear.push(bathQ.shift()!);
    }
    rear.push(...extras);
    // The kitchen goes on the corner so it has a side wall for its door and window; the guest WC sits by the entrance.
    return [{ front: [living[0]!, ...wc, ...living.slice(1)], rear }];
  }
  // Two storeys: living spaces, a guest room when there are four or more bedrooms, and the guest WC downstairs;
  // the master and the other bedrooms upstairs. The stair sits at the same position on both floors.
  const downBeds = b.bedrooms >= 4 ? [bedrooms.shift()!] : [];
  const downBaths = downBeds.length && baths.length > 1 ? [baths.shift()!] : [];
  const ground = { front: [living[0]!, ...wc, ...living.slice(1)], rear: [stair(), ...downBeds, ...downBaths, ...extras] };
  const upFront = bedrooms.splice(0, Math.ceil(bedrooms.length / 2));
  const upRear: Item[] = [stair(), ...bedrooms, ...baths, master]; // master on the far corner: two outside walls
  const upper = { front: upFront.length ? upFront : [item(cfg, 'lounge', 'Upstairs lounge')], rear: upRear };
  if (ground.rear.length === 1) ground.rear.push(item(cfg, 'store', 'Store'));
  return [ground, upper];
}


/** A rectangle in the layout's own frame: a runs along the bands, b across them (band, hallway, band). */
interface Local { a: number; b: number; la: number; lb: number }

const baseWidth = (i: Item, D: number) => i.fixedW ?? Math.max(i.target / D, i.minDim, i.min / D);
const bandLength = (items: Item[], D: number) => items.reduce((s, i) => s + baseWidth(i, D), 0);

/** Lays one band out along a; spare length goes to habitable rooms (never to the stair). */
function layBand(itemsIn: Item[], band: Local, corridorSide: 'start' | 'end', cfg: DesignConfig): { item: Item; r: Local; ensuite?: Local }[] {
  const D = band.lb; const W = band.la;
  let items = itemsIn;
  const base = items.map((i) => baseWidth(i, D));
  let spare = Math.max(0, W - base.reduce((x, y) => x + y, 0));
  const widths = [...base];
  // Habitable rooms take the spare length, but never beyond twice their depth (no corridor-like rooms).
  for (let pass = 0; pass < 4 && spare > 0.01; pass++) {
    const cap = (i: Item) => (i.kind === 'living' || i.kind === 'living-kitchen' ? 2.4 * D : 1.5 * (i.withEnsuite ? D - cfg.rooms.ensuite.minDimM : D));
    const open = items.map((i, k) => (!i.fixedW && HABITABLE.has(i.kind) && widths[k]! < cap(i) - 0.01 ? i.target : 0));
    const sum = open.reduce((x, y) => x + y, 0);
    if (!sum) break;
    let used = 0;
    widths.forEach((w, k) => { if (open[k]) { const add = Math.max(0, Math.min((open[k]! / sum) * spare, cap(items[k]!) - w)); widths[k] = w + add; used += add; } });
    spare -= used;
  }
  // Fillers never go after a stair at the end of a band, so the stair stays aligned between floors.
  const insertFiller = (it: Item, w: number) => {
    const at = items[items.length - 1]?.kind === 'stair' ? items.length - 1 : items.length;
    items = [...items.slice(0, at), it, ...items.slice(at)];
    widths.splice(at, 0, w);
  };
  if (spare >= cfg.rooms.lounge.minDimM) {
    insertFiller({ kind: 'lounge', name: 'Family lounge', target: spare * D, min: cfg.rooms.lounge.minM2, minDim: cfg.rooms.lounge.minDimM }, spare);
    spare = 0;
  }
  if (spare >= cfg.rooms.store.minDimM) {
    insertFiller({ kind: 'store', name: 'Linen store', target: spare * D, min: cfg.rooms.store.minM2, minDim: cfg.rooms.store.minDimM }, spare);
    spare = 0;
  }
  if (spare > 0.01) {
    const k = widths.findIndex((_, i) => !items[i]!.fixedW);
    if (k >= 0) widths[k] = widths[k]! + spare;
  }
  const out: { item: Item; r: Local; ensuite?: Local }[] = [];
  let a = band.a;
  items.forEach((it, k) => {
    const w = k === items.length - 1 && !it.fixedW ? round(band.a + W - a, 3) : round(widths[k]!, 3);
    if (it.withEnsuite) {
      // The ensuite sits behind the master, away from the hallway: entered from the bedroom, with an outside window.
      const ens = cfg.rooms.ensuite;
      const ensD = round(Math.max(ens.minDimM, Math.min(ens.targetM2 / w, D - cfg.rooms.master.minDimM)), 3);
      const mD = round(D - ensD, 3);
      const nearB = corridorSide === 'start' ? band.b : band.b + ensD;
      const farB = corridorSide === 'start' ? band.b + mD : band.b;
      out.push({ item: it, r: { a, b: nearB, la: w, lb: mD }, ensuite: { a, b: farB, la: w, lb: ensD } });
    } else {
      out.push({ item: it, r: { a, b: band.b, la: w, lb: D } });
    }
    a = round(a + w, 3);
  });
  return out;
}

interface Variant { key: string; name: string; orient: 'across' | 'along'; depth: number; mirror: boolean; single?: boolean; blurb: string }
const VARIANTS: Variant[] = [
  { key: 'wide', name: 'Wide frontage', orient: 'across', depth: 3.6, mirror: false, blurb: 'A long, shallow plan facing the street: every room gets daylight from the front or back.' },
  { key: 'balanced', name: 'Balanced', orient: 'across', depth: 4.5, mirror: true, blurb: 'Well-proportioned rooms either side of a central hallway, with a side passage for access and air flow.' },
  { key: 'compact', name: 'Compact', orient: 'across', depth: 5.4, mirror: false, blurb: 'Deeper rooms and a shorter house, leaving the most garden.' },
  { key: 'long', name: 'Long plan', orient: 'along', depth: 3.9, mirror: false, blurb: 'Rooms run front to back off a central hallway: suits narrow, deep plots.' },
  { key: 'narrow', name: 'Narrow plan', orient: 'along', depth: 3.6, mirror: true, single: true, blurb: 'One row of rooms along a side hallway: fits the narrowest plots.' },
];

export function generateDesigns(plot: Plot, briefIn: Partial<DesignBrief>, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): DesignResult {
  const notes: string[] = [];
  if (!validPlot(plot)) return { designs: [], notes: ['Enter a plot between 6 m and 200 m on each side.'] };
  let brief = normaliseBrief(briefIn);
  let designs = tryAll(plot, brief, cfg);
  if (!designs.length && brief.storeys === 1) {
    const up = { ...brief, storeys: 2 as const };
    const two = tryAll(plot, up, cfg);
    if (two.length) {
      notes.push(`A ${brief.bedrooms}-bedroom bungalow does not fit this plot within the setbacks and coverage limit, so these designs are two storeys.`);
      brief = up; designs = two;
    }
  }
  if (!designs.length) notes.push('This programme does not fit the plot within the setbacks and site coverage limit. Try fewer rooms, two storeys or a larger plot.');
  return { designs, notes };
}

function tryAll(plot: Plot, brief: DesignBrief, cfg: DesignConfig): Design[] {
  const out: Design[] = [];
  const seen = new Set<string>();
  for (const v of VARIANTS) {
    const d = layout(plot, brief, cfg, v);
    if (!d || d.checks.some((c) => c.status === 'fail')) continue;
    const sig = `${d.footprint.w.toFixed(1)}x${d.footprint.d.toFixed(1)}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(d);
  }
  // Best fit first: fewer warnings, then the squarer (cheaper to build) footprint.
  const squareness = (d: Design) => Math.max(d.footprint.w, d.footprint.d) / Math.min(d.footprint.w, d.footprint.d);
  out.sort((p, q) => p.checks.filter((c) => c.status !== 'pass').length - q.checks.filter((c) => c.status !== 'pass').length || squareness(p) - squareness(q));
  return out.slice(0, 3);
}

/** Moves movable rooms from the longer band to the shorter while that shortens the house. */
function balance(f: { front: Item[]; rear: Item[] }, Df: number, Dr: number) {
  const front = [...f.front]; const rear = [...f.rear];
  const movable = (i: Item) => !['stair', 'master', 'living', 'living-kitchen', 'dining', 'kitchen'].includes(i.kind);
  for (let guard = 0; guard < 12; guard++) {
    const lf = bandLength(front, Df); const lr = bandLength(rear, Dr);
    const [from, to, dFrom, dTo] = lr > lf ? [rear, front, Dr, Df] as const : [front, rear, Df, Dr] as const;
    let k = -1;
    for (let i = from.length - 1; i >= 0; i--) if (movable(from[i]!)) { k = i; break; }
    if (k < 0) break;
    const it = from[k]!;
    const after = Math.max(bandLength(from, dFrom) - baseWidth(it, dFrom), bandLength(to, dTo) + baseWidth(it, dTo));
    if (after >= Math.max(lf, lr) - 1e-6) break;
    from.splice(k, 1); to.push(it);
  }
  return { front, rear };
}

function layout(plot: Plot, brief: DesignBrief, cfg: DesignConfig, v: Variant): Design | null {
  const sb = cfg.setbacksM;
  const parkDepth = brief.parking ? cfg.parking.depthM + 0.5 : 0;
  const envelope: Rect = { x: sb.side, y: sb.front, w: plot.widthM - 2 * sb.side, d: plot.depthM - sb.front - sb.rear };
  if (envelope.w < 4 || envelope.d < 6) return null;
  const fy0 = round(Math.max(envelope.y, parkDepth), 2);
  const across = v.orient === 'across';
  // The layout frame: a along the bands, b across them.
  const A0 = across ? envelope.x : fy0;
  const AL = across ? envelope.w : envelope.y + envelope.d - fy0;
  const B0 = across ? fy0 : envelope.x;
  const BL = across ? envelope.y + envelope.d - fy0 : envelope.w;

  const masterStack = brief.ensuite ? cfg.rooms.master.minDimM + cfg.rooms.ensuite.minDimM : 0;
  const stairRun = brief.storeys === 2 ? cfg.stair.minRunM : 0;
  const Df = round(Math.max(cfg.minBandM, v.depth), 2);
  const Dr = round(Math.max(cfg.minBandM, v.depth, stairRun, masterStack), 2);
  const prog = programme(cfg, brief);
  // A single row puts every room in one band beside the hallway.
  const fl = v.single
    ? prog.map((f) => { const all = [...f.front, ...f.rear]; return { front: [] as Item[], rear: [...all.filter((i) => i.kind === 'stair'), ...all.filter((i) => i.kind !== 'stair')] }; })
    : prog.map((f) => balance(f, Df, Dr));
  // The house is as long as its longest band needs: sized to the programme, not stretched to the plot.
  const L = round(Math.max(...fl.flatMap((f) => [bandLength(f.front, Df), bandLength(f.rear, Dr)])), 2);
  const Dt = round((v.single ? 0 : Df) + cfg.corridorM + Dr, 2);
  if (L > AL + 1e-6 || Dt > BL + 1e-6) return null;
  const a0 = round(across && v.mirror ? A0 + AL - L : A0, 2);
  const b0 = round(!across && v.mirror ? B0 + BL - Dt : B0, 2);
  const toPlan = (r: Local): Rect => (across ? { x: r.a, y: r.b, w: r.la, d: r.lb } : { x: r.b, y: r.a, w: r.lb, d: r.la });
  const footprint = roundRect(toPlan({ a: a0, b: b0, la: L, lb: Dt }));

  let n = 0;
  const rooms: Room[] = [];
  const place = (kind: RoomKind, name: string, storey: number, r: Local) => rooms.push({ id: `r${++n}`, kind, name, storey, ...roundRect(toPlan(r)) });
  fl.forEach((f, s) => {
    const order = (items: Item[]) => (v.mirror && across ? [...items].reverse() : items);
    let b = b0;
    if (!v.single) {
      for (const x of layBand(order(f.front), { a: a0, b, la: L, lb: Df }, 'end', cfg)) place(x.item.kind, x.item.name, s, x.r);
      b = round(b + Df, 3);
    }
    place('corridor', s === 0 ? 'Hallway' : 'Landing', s, { a: a0, b, la: L, lb: cfg.corridorM });
    b = round(b + cfg.corridorM, 3);
    for (const x of layBand(order(f.rear), { a: a0, b, la: L, lb: Dr }, 'start', cfg)) {
      place(x.item.kind, x.item.name, s, x.r);
      if (x.ensuite) place('ensuite', 'Ensuite', s, x.ensuite);
    }
  });

  const parking: Rect[] = [];
  for (let i = 0; i < brief.parking; i++) {
    const px = footprint.x + i * (cfg.parking.widthM + 0.3);
    if (px + cfg.parking.widthM <= plot.widthM - 0.3) parking.push({ x: round(px, 2), y: round(Math.max(0.3, footprint.y - cfg.parking.depthM - 0.3), 2), w: cfg.parking.widthM, d: cfg.parking.depthM });
  }

  const walls = wallsFor(rooms, footprint, fl.length, cfg);
  const openings = openingsFor(rooms, footprint, cfg);
  const footprintM2 = round(footprint.w * footprint.d, 1);
  const metrics = { footprintM2, grossFloorM2: round(footprintM2 * fl.length, 1), coveragePct: round((footprintM2 / (plot.widthM * plot.depthM)) * 100, 1), plotM2: round(plot.widthM * plot.depthM, 1) };
  const roof: Roof = { kind: brief.roof, pitchDeg: cfg.roof.pitchDeg, overhangM: cfg.roof.overhangM, parapetM: cfg.roof.parapetM, ridge: footprint.w >= footprint.d ? 'x' : 'y' };
  const beds = brief.bedrooms;
  const design: Design = {
    id: `${v.key}-${brief.storeys}s-${beds}b`,
    name: v.name,
    summary: `${beds}-bedroom ${brief.storeys === 2 ? 'two-storey house' : 'bungalow'}, ${metrics.grossFloorM2} m². ${v.blurb}`,
    plot, brief, envelope, footprint, parking, storeys: fl.length, storeyHeightM: cfg.storeyHeightM, slabM: cfg.slabM,
    rooms, walls, openings, roof, metrics, checks: [],
  };
  design.checks = checkDesign(design, cfg);
  return design;
}

function roundRect(r: Rect): Rect { return { x: round(r.x, 3), y: round(r.y, 3), w: round(r.w, 3), d: round(r.d, 3) }; }

// ---------------------------------------------------------------- walls and openings

const key = (n: number) => Math.round(n * 1000);

/** Unions every room edge per plan line, so a wall shared by two rooms is one wall. Boundary lines are external. */
function wallsFor(rooms: Room[], fp: Rect, storeys: number, cfg: DesignConfig): Wall[] {
  const walls: Wall[] = [];
  let n = 0;
  for (let s = 0; s < storeys; s++) {
    const lines = new Map<string, { dir: 'h' | 'v'; at: number; spans: [number, number][] }>();
    const add = (dir: 'h' | 'v', at: number, a: number, b: number) => {
      const k = `${dir}:${key(at)}`;
      const l = lines.get(k) ?? { dir, at, spans: [] };
      l.spans.push([Math.min(a, b), Math.max(a, b)]);
      lines.set(k, l);
    };
    for (const r of rooms.filter((x) => x.storey === s)) {
      add('h', r.y, r.x, r.x + r.w); add('h', r.y + r.d, r.x, r.x + r.w);
      add('v', r.x, r.y, r.y + r.d); add('v', r.x + r.w, r.y, r.y + r.d);
    }
    for (const l of lines.values()) {
      l.spans.sort((p, q) => p[0] - q[0]);
      const merged: [number, number][] = [];
      for (const sp of l.spans) {
        const last = merged[merged.length - 1];
        if (last && sp[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], sp[1]);
        else merged.push([...sp]);
      }
      const external = l.dir === 'h' ? (Math.abs(l.at - fp.y) < 1e-6 || Math.abs(l.at - (fp.y + fp.d)) < 1e-6) : (Math.abs(l.at - fp.x) < 1e-6 || Math.abs(l.at - (fp.x + fp.w)) < 1e-6);
      for (const [a, b] of merged) {
        if (b - a < 0.05) continue;
        walls.push({ id: `w${++n}`, storey: s, dir: l.dir, at: round(l.at, 3), from: round(a, 3), to: round(b, 3), thickness: external ? cfg.wallM.external : cfg.wallM.internal, external });
      }
    }
  }
  return walls;
}

function edges(r: Rect): Edge[] {
  return [
    { side: 'front', dir: 'h', at: r.y, from: r.x, to: r.x + r.w },
    { side: 'rear', dir: 'h', at: r.y + r.d, from: r.x, to: r.x + r.w },
    { side: 'left', dir: 'v', at: r.x, from: r.y, to: r.y + r.d },
    { side: 'right', dir: 'v', at: r.x + r.w, from: r.y, to: r.y + r.d },
  ];
}

function onBoundary(e: { dir: 'h' | 'v'; at: number }, fp: Rect) {
  return e.dir === 'h' ? Math.abs(e.at - fp.y) < 1e-6 || Math.abs(e.at - (fp.y + fp.d)) < 1e-6 : Math.abs(e.at - fp.x) < 1e-6 || Math.abs(e.at - (fp.x + fp.w)) < 1e-6;
}

type Edge = { side: 'front' | 'rear' | 'left' | 'right'; dir: 'h' | 'v'; at: number; from: number; to: number };

/** The stretch of wall two rectangles share, if any. */
function shared(r: Rect, o: Rect): Edge | null {
  for (const e of edges(r)) {
    for (const f of edges(o)) {
      if (e.dir !== f.dir || Math.abs(e.at - f.at) > 1e-6) continue;
      const from = Math.max(e.from, f.from); const to = Math.min(e.to, f.to);
      if (to - from > 0.3) return { ...e, from, to };
    }
  }
  return null;
}

function openingsFor(rooms: Room[], fp: Rect, cfg: DesignConfig): Opening[] {
  const out: Opening[] = [];
  let n = 0;
  const add = (o: Omit<Opening, 'id'>) => out.push({ id: `o${++n}`, ...o });
  const centred = (from: number, to: number, w: number) => { const c = (from + to) / 2; return [round(c - w / 2, 3), round(c + w / 2, 3)] as const; };
  const door = (r: Room, e: Edge, w: number, external: boolean, label: string, at: 'centre' | 'end' = 'centre') => {
    const width = Math.min(w, e.to - e.from - 0.2);
    const [a, b] = at === 'centre' ? centred(e.from, e.to, width) : [round(e.to - 0.3 - width, 3), round(e.to - 0.3, 3)];
    add({ storey: r.storey, kind: 'door', dir: e.dir, at: round(e.at, 3), from: a, to: b, sillM: 0, headM: cfg.doorHeightM, external, roomId: r.id, label });
  };

  for (const r of rooms) {
    if (r.kind === 'corridor') continue;
    const corridor = rooms.find((c) => c.kind === 'corridor' && c.storey === r.storey)!;
    const es = edges(r);
    // Door: from the hallway, except the ensuite (from the master) and the stair (open to the hallway).
    if (r.kind === 'ensuite') {
      const master = rooms.find((m) => m.kind === 'master' && m.storey === r.storey && shared(r, m));
      if (master) door(r, shared(r, master)!, cfg.doorM.wet, false, 'Ensuite door');
    } else if (r.kind !== 'stair') {
      const e = shared(r, corridor);
      if (e) door(r, e, WET.has(r.kind) ? cfg.doorM.wet : cfg.doorM.internal, false, `${r.name} door`);
    }
    // Front door into the living space (on the street side when it reaches it); a side door from the kitchen.
    const outsideEdges = es.filter((e) => onBoundary(e, fp));
    if (r.storey === 0 && (r.kind === 'living' || r.kind === 'living-kitchen')) {
      const front = outsideEdges.find((e) => e.dir === 'h' && Math.abs(e.at - fp.y) < 1e-6);
      const hallFront = edges(corridor).find((e) => e.dir === 'h' && Math.abs(e.at - fp.y) < 1e-6);
      if (front) door(r, front, cfg.doorM.entrance, true, 'Front door');
      else if (hallFront) door(corridor, hallFront, Math.min(cfg.doorM.entrance, corridor.w - 0.2), true, 'Front door');
      else if (outsideEdges[0]) door(r, outsideEdges[0], cfg.doorM.entrance, true, 'Front door');
    }
    if (r.storey === 0 && r.kind === 'kitchen') {
      const side = outsideEdges.filter((e) => !(e.dir === 'h' && Math.abs(e.at - fp.y) < 1e-6)).sort((p, q) => (q.to - q.from) - (p.to - p.from))[0];
      if (side && side.to - side.from >= cfg.doorM.external + 2.1) door(r, side, cfg.doorM.external, true, 'Kitchen door', 'end');
    }
    // Windows on outside walls: wet rooms get a small high window; habitable rooms enough glass for daylight.
    const outside = [...outsideEdges].sort((p, q) => (q.to - q.from) - (p.to - p.from));
    if (!outside.length) continue;
    if (WET.has(r.kind) || r.kind === 'store' || r.kind === 'stair') {
      const e = outside[0]!;
      const w = Math.min(cfg.window.wetWidthM, e.to - e.from - 0.3);
      if (w < 0.3) continue;
      const [a, b] = centred(e.from, e.to, w);
      add({ storey: r.storey, kind: 'window', dir: e.dir, at: round(e.at, 3), from: a, to: b, sillM: cfg.window.wetSillM, headM: cfg.window.wetSillM + cfg.window.wetHeightM, external: true, roomId: r.id, label: `${r.name} window` });
      continue;
    }
    let needM2 = (r.w * r.d * cfg.minWindowPctOfFloor) / 100;
    for (const e of outside) {
      if (needM2 <= 0) break;
      const doorOps = out.filter((o) => o.roomId === r.id && o.kind === 'door' && o.dir === e.dir && Math.abs(o.at - e.at) < 1e-6);
      // Free stretches of this wall after any door, keeping 0.3 m returns at the ends and beside the door.
      let free: [number, number][] = [[e.from + 0.3, e.to - 0.3]];
      for (const o of doorOps) free = free.flatMap(([p, q]) => [[p, Math.min(q, o.from - 0.3)], [Math.max(p, o.to + 0.3), q]] as [number, number][]).filter(([p, q]) => q - p >= 0.6);
      free.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
      const span = free[0];
      if (!span) continue;
      const w = Math.min(span[1] - span[0], Math.max(0.9, Math.ceil((needM2 / cfg.window.heightM) * 10 * 1.2) / 10));
      const [a, b] = centred(span[0], span[1], w);
      add({ storey: r.storey, kind: 'window', dir: e.dir, at: round(e.at, 3), from: a, to: b, sillM: cfg.window.sillM, headM: cfg.window.sillM + cfg.window.heightM, external: true, roomId: r.id, label: `${r.name} window` });
      needM2 -= w * cfg.window.heightM;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the architect's checklist

export function checkDesign(d: Design, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): DesignCheck[] {
  const out: DesignCheck[] = [];
  const push = (code: string, label: string, ok: boolean | DesignCheckStatus, detail: string) => out.push({ code, label, status: typeof ok === 'string' ? ok : ok ? 'pass' : 'fail', detail });
  const fp = d.footprint; const env = d.envelope;
  const inside = fp.x >= env.x - 1e-6 && fp.y >= env.y - 1e-6 && fp.x + fp.w <= env.x + env.w + 1e-6 && fp.y + fp.d <= env.y + env.d + 1e-6;
  push('setbacks', 'Building lines and setbacks', inside, `At least ${cfg.setbacksM.front} m front, ${cfg.setbacksM.side} m sides, ${cfg.setbacksM.rear} m rear kept clear.`);
  push('coverage', 'Site coverage', d.metrics.coveragePct <= cfg.maxCoveragePct, `${d.metrics.coveragePct}% of the plot is built on (limit ${cfg.maxCoveragePct}%).`);
  push('ceiling', 'Ceiling height', cfg.storeyHeightM - cfg.slabM >= cfg.minCeilingM, `${round(cfg.storeyHeightM - cfg.slabM, 2)} m clear (minimum ${cfg.minCeilingM} m).`);

  const small = d.rooms.filter((r) => r.kind !== 'corridor' && r.kind !== 'stair').filter((r) => {
    const rule = cfg.rooms[r.kind as keyof DesignConfig['rooms']];
    return r.w * r.d < rule.minM2 - 0.05 || Math.min(r.w, r.d) < rule.minDimM - 0.02;
  });
  push('room-sizes', 'Minimum room sizes', !small.length, small.length ? `Too small: ${small.map((r) => `${r.name} (${round(r.w * r.d, 1)} m²)`).join(', ')}.` : 'Every room meets its minimum floor area and width.');

  const dark = d.rooms.filter((r) => HABITABLE.has(r.kind)).filter((r) => {
    const glass = d.openings.filter((o) => o.roomId === r.id && o.kind === 'window').reduce((s, o) => s + (o.to - o.from) * (o.headM - o.sillM), 0);
    return glass < (r.w * r.d * cfg.minWindowPctOfFloor) / 100 - 0.05;
  });
  push('daylight', 'Natural light and ventilation', !dark.length, dark.length ? `Not enough window area: ${dark.map((r) => r.name).join(', ')}.` : `Every habitable room has windows of at least ${cfg.minWindowPctOfFloor}% of its floor area.`);

  const unvented = d.rooms.filter((r) => WET.has(r.kind) && !d.openings.some((o) => o.roomId === r.id && o.kind === 'window'));
  push('wet-ventilation', 'Bathroom and WC ventilation', unvented.length ? 'warn' : 'pass', unvented.length ? `${unvented.map((r) => r.name).join(', ')} need mechanical extract ventilation.` : 'Every bathroom and WC has an outside window.');

  const corridors = d.rooms.filter((r) => r.kind === 'corridor');
  push('corridors', 'Corridor width', corridors.every((c) => c.d >= cfg.minCorridorM), `Hallways are ${cfg.corridorM} m wide (minimum ${cfg.minCorridorM} m).`);
  const narrow = d.openings.filter((o) => o.kind === 'door' && o.to - o.from < cfg.minDoorM - 1e-6);
  push('doors', 'Door widths', !narrow.length, narrow.length ? `${narrow.length} door(s) narrower than ${cfg.minDoorM} m.` : `Every door is at least ${cfg.minDoorM} m wide; the front door is ${cfg.doorM.entrance} m.`);

  const bedrooms = d.rooms.filter((r) => r.kind === 'bedroom' || r.kind === 'master');
  const privateAccess = bedrooms.every((b) => d.openings.some((o) => o.roomId === b.id && o.kind === 'door'));
  push('privacy', 'Bedrooms reached from circulation', privateAccess, 'Each bedroom opens off a hallway or landing, never through another bedroom.');
  const escape = d.rooms.filter((r) => r.storey === 0 && r.kind !== 'corridor').length > 0 && d.openings.some((o) => o.external && o.kind === 'door');
  push('escape', 'Entrance and escape', escape && d.openings.filter((o) => o.external && o.kind === 'door').length >= (d.storeys > 1 ? 1 : 1), `${d.openings.filter((o) => o.external && o.kind === 'door').length} external door(s).`);
  const groundWc = d.rooms.some((r) => r.storey === 0 && WET.has(r.kind));
  push('ground-wc', 'Toilet on the entrance floor', groundWc ? 'pass' : 'warn', groundWc ? 'There is a toilet on the ground floor.' : 'No toilet on the ground floor; consider a guest WC.');
  if (d.storeys > 1) {
    const stairs = d.rooms.filter((r) => r.kind === 'stair');
    const okStair = stairs.length === d.storeys && stairs.every((s) => Math.min(s.w, s.d) >= cfg.stair.minWidthM - 0.02 && Math.max(s.w, s.d) >= cfg.stair.minRunM - 0.02)
      && stairs.every((s) => Math.abs(s.x - stairs[0]!.x) < 0.01 && Math.abs(s.y - stairs[0]!.y) < 0.01);
    push('stair', 'Stair width and run', okStair, `${cfg.stair.widthM} m wide with a ${cfg.stair.minRunM} m run, aligned on both floors.`);
  }
  if (d.brief.parking) {
    push('parking', 'Off-street parking', d.parking.length === d.brief.parking ? 'pass' : 'warn', `${d.parking.length} of ${d.brief.parking} parking space(s) fit in front of the house.`);
  }
  return out;
}

// ---------------------------------------------------------------- 3D solids

/** A box in plan coordinates: x along the frontage, y into the plot, z up. Centre plus size, in metres. */
export interface Solid { kind: 'wall' | 'lintel' | 'sill' | 'slab' | 'parapet'; storey: number; external: boolean; cx: number; cy: number; cz: number; sx: number; sy: number; sz: number }

/** Walls cut around their doors and windows, plus floor slabs: what the 3D view draws and the quantities count. */
export function solidsFor(d: Design): Solid[] {
  const out: Solid[] = [];
  const H = d.storeyHeightM;
  for (const w of d.walls) {
    const z0 = w.storey * H;
    const ops = d.openings.filter((o) => o.storey === w.storey && o.dir === w.dir && Math.abs(o.at - w.at) < 1e-6 && o.from >= w.from - 1e-6 && o.to <= w.to + 1e-6).sort((a, b) => a.from - b.from);
    const box = (kind: Solid['kind'], a: number, b: number, zA: number, zB: number) => {
      if (b - a < 1e-3 || zB - zA < 1e-3) return;
      const len = b - a; const mid = (a + b) / 2;
      out.push(w.dir === 'h'
        ? { kind, storey: w.storey, external: w.external, cx: mid, cy: w.at, cz: (zA + zB) / 2, sx: len, sy: w.thickness, sz: zB - zA }
        : { kind, storey: w.storey, external: w.external, cx: w.at, cy: mid, cz: (zA + zB) / 2, sx: w.thickness, sy: len, sz: zB - zA });
    };
    let cur = w.from;
    for (const o of ops) {
      box('wall', cur, o.from, z0, z0 + H);
      box('sill', o.from, o.to, z0, z0 + o.sillM);
      box('lintel', o.from, o.to, z0 + o.headM, z0 + H);
      cur = o.to;
    }
    box('wall', cur, w.to, z0, z0 + H);
  }
  const fp = d.footprint;
  for (let s = 0; s < d.storeys; s++) {
    out.push({ kind: 'slab', storey: s, external: false, cx: fp.x + fp.w / 2, cy: fp.y + fp.d / 2, cz: s * H - d.slabM / 2 + (s === 0 ? d.slabM : 0), sx: fp.w + 0.2, sy: fp.d + 0.2, sz: d.slabM });
  }
  if (d.roof.kind === 'flat') {
    const z = d.storeys * H;
    out.push({ kind: 'slab', storey: d.storeys, external: true, cx: fp.x + fp.w / 2, cy: fp.y + fp.d / 2, cz: z + d.slabM / 2, sx: fp.w + 0.2, sy: fp.d + 0.2, sz: d.slabM });
    const t = 0.225; const ph = d.roof.parapetM; const zc = z + d.slabM + ph / 2;
    out.push({ kind: 'parapet', storey: d.storeys, external: true, cx: fp.x + fp.w / 2, cy: fp.y, cz: zc, sx: fp.w + t, sy: t, sz: ph });
    out.push({ kind: 'parapet', storey: d.storeys, external: true, cx: fp.x + fp.w / 2, cy: fp.y + fp.d, cz: zc, sx: fp.w + t, sy: t, sz: ph });
    out.push({ kind: 'parapet', storey: d.storeys, external: true, cx: fp.x, cy: fp.y + fp.d / 2, cz: zc, sx: t, sy: fp.d, sz: ph });
    out.push({ kind: 'parapet', storey: d.storeys, external: true, cx: fp.x + fp.w, cy: fp.y + fp.d / 2, cz: zc, sx: t, sy: fp.d, sz: ph });
  }
  return out;
}

/** Roof planes for pitched roofs: each a list of 3D points (x, y plan; z up). */
export function roofPlanes(d: Design): [number, number, number][][] {
  if (d.roof.kind === 'flat') return [];
  const o = d.roof.overhangM; const fp = d.footprint;
  const x0 = fp.x - o, x1 = fp.x + fp.w + o, y0 = fp.y - o, y1 = fp.y + fp.d + o;
  const z = d.storeys * d.storeyHeightM;
  const t = Math.tan((d.roof.pitchDeg * Math.PI) / 180);
  const alongX = d.roof.ridge === 'x';
  const half = alongX ? (y1 - y0) / 2 : (x1 - x0) / 2;
  const zr = z + half * t;
  if (d.roof.kind === 'gable') {
    if (alongX) {
      const ym = (y0 + y1) / 2;
      return [[[x0, y0, z], [x1, y0, z], [x1, ym, zr], [x0, ym, zr]], [[x0, y1, z], [x1, y1, z], [x1, ym, zr], [x0, ym, zr]], [[x0, y0, z], [x0, y1, z], [x0, ym, zr]], [[x1, y0, z], [x1, y1, z], [x1, ym, zr]]];
    }
    const xm = (x0 + x1) / 2;
    return [[[x0, y0, z], [x0, y1, z], [xm, y1, zr], [xm, y0, zr]], [[x1, y0, z], [x1, y1, z], [xm, y1, zr], [xm, y0, zr]], [[x0, y0, z], [x1, y0, z], [xm, y0, zr]], [[x0, y1, z], [x1, y1, z], [xm, y1, zr]]];
  }
  // Hip: the ridge is shortened by the half-span at both ends.
  if (alongX) {
    const ym = (y0 + y1) / 2; const ra = Math.min(x0 + half, (x0 + x1) / 2); const rb = Math.max(x1 - half, (x0 + x1) / 2);
    return [[[x0, y0, z], [x1, y0, z], [rb, ym, zr], [ra, ym, zr]], [[x0, y1, z], [x1, y1, z], [rb, ym, zr], [ra, ym, zr]], [[x0, y0, z], [x0, y1, z], [ra, ym, zr]], [[x1, y0, z], [x1, y1, z], [rb, ym, zr]]];
  }
  const xm = (x0 + x1) / 2; const ra = Math.min(y0 + half, (y0 + y1) / 2); const rb = Math.max(y1 - half, (y0 + y1) / 2);
  return [[[x0, y0, z], [x0, y1, z], [xm, rb, zr], [xm, ra, zr]], [[x1, y0, z], [x1, y1, z], [xm, rb, zr], [xm, ra, zr]], [[x0, y0, z], [x1, y0, z], [xm, ra, zr]], [[x0, y1, z], [x1, y1, z], [xm, rb, zr]]];
}

// ---------------------------------------------------------------- bill of materials

export interface MaterialLine {
  key: string;
  section: 'substructure' | 'frame' | 'walls' | 'roof' | 'openings' | 'finishes' | 'services';
  name: string;
  unit: string;
  quantity: number;
  basis: string;
  /** How to find it in the marketplace: a category when one exists, and search words. */
  shop: { category?: string; q: string };
  provisional?: boolean;
}

export function billOfMaterials(d: Design, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): MaterialLine[] {
  const m = cfg.materials;
  const H = d.storeyHeightM;
  const fp = d.footprint;
  const fpArea = fp.w * fp.d;
  const lines: MaterialLine[] = [];
  const add = (l: MaterialLine) => { if (l.quantity > 0) lines.push(l); };

  // Wall lengths and net areas per type (openings deducted).
  const len = (pred: (w: Wall) => boolean) => d.walls.filter(pred).reduce((s, w) => s + (w.to - w.from), 0);
  const openArea = (external: boolean) => d.openings.filter((o) => o.external === external).reduce((s, o) => s + (o.to - o.from) * (o.headM - o.sillM), 0);
  const extLen = len((w) => w.external); const intLen = len((w) => !w.external);
  const groundLen = len((w) => w.storey === 0);
  const extArea = extLen * H - openArea(true);
  const intArea = intLen * H - openArea(false);
  const parapetArea = d.roof.kind === 'flat' ? 2 * (fp.w + fp.d) * d.roof.parapetM : 0;
  const perM2 = 1 / (m.block.faceLengthM * m.block.faceHeightM);
  const waste = 1 + m.block.wastePct / 100;
  const foundationArea = groundLen * m.foundation.coursesBelowDpc * m.block.faceHeightM;

  const blocksExt = Math.ceil((extArea + parapetArea + foundationArea) * perM2 * waste);
  const blocksInt = Math.ceil(intArea * perM2 * waste);

  // Concrete volumes (1:2:4 unless configured otherwise).
  const vFoundation = groundLen * m.foundation.widthM * m.foundation.depthM;
  const vGroundSlab = fpArea * d.slabM;
  const vUpperSlabs = fpArea * d.slabM * (d.storeys - 1) + (d.roof.kind === 'flat' ? fpArea * d.slabM : 0);
  const allWallLen = len(() => true);
  const vRingBeams = allWallLen * m.ringBeamM * m.ringBeamM;
  const perimeter = 2 * (fp.w + fp.d);
  const columns = Math.ceil(perimeter / m.columnSpacingM) + (d.storeys > 1 ? Math.ceil(intLen / d.storeys / (m.columnSpacingM * 2)) : 0);
  const vColumns = columns * m.ringBeamM * m.ringBeamM * H * d.storeys;
  const lintelLen = d.openings.reduce((s, o) => s + (o.to - o.from) + 0.3, 0);
  const vLintels = lintelLen * m.ringBeamM * m.ringBeamM;
  const stairs = d.storeys - 1;
  const vStair = stairs * cfg.stair.widthM * Math.hypot(cfg.stair.minRunM, H) * 0.2;
  const vConcrete = vFoundation + vGroundSlab + vUpperSlabs + vRingBeams + vColumns + vLintels + vStair;

  const [c, s, g] = m.concreteMix; const parts = c + s + g;
  const dryC = vConcrete * m.dryFactor.concrete;
  const cementConcreteM3 = (dryC * c) / parts;
  const sandConcreteM3 = (dryC * s) / parts;
  const graniteM3 = (dryC * g) / parts;

  const mortarM3 = (blocksExt * m.mortarM3PerBlock.external + blocksInt * m.mortarM3PerBlock.internal);
  const dryMortar = mortarM3 * m.dryFactor.mortar;
  const cementMortarM3 = dryMortar / (1 + m.mortarMix);
  const sandMortarM3 = dryMortar - cementMortarM3;

  // Plaster: both faces of internal walls, inside face of external walls; render outside.
  const plasterArea = intArea * 2 + extArea * 2 + parapetArea * 2;
  const plasterM3 = plasterArea * m.plasterM * m.dryFactor.mortar;
  const cementPlasterM3 = plasterM3 / (1 + m.plasterMix);
  const sandPlasterM3 = plasterM3 - cementPlasterM3;

  const bags = (m3: number) => Math.ceil((m3 * m.cementKgPerM3) / m.bagKg);
  const tonnes = (m3: number, t: number) => round(Math.ceil(m3 * t * 2) / 2, 1);

  add({ key: 'excavation', section: 'substructure', name: 'Trench excavation', unit: 'm³', quantity: round(groundLen * m.foundation.widthM * m.foundation.excavationM, 1), basis: `${round(groundLen, 1)} m of ground-floor walls × ${m.foundation.widthM} m × ${m.foundation.excavationM} m deep`, shop: { category: 'plant-hire', q: 'excavator' }, provisional: true });
  add({ key: 'hardcore', section: 'substructure', name: 'Laterite filling (hardcore)', unit: 'm³', quantity: round(fpArea * m.hardcoreM, 1), basis: `${round(fpArea, 1)} m² floor × ${m.hardcoreM} m`, shop: { q: 'laterite filling' } });
  add({ key: 'dpm', section: 'substructure', name: 'Damp-proof membrane', unit: 'm²', quantity: Math.ceil(fpArea * 1.1), basis: 'Ground floor area + 10% laps', shop: { q: 'damp proof membrane' } });
  add({ key: 'brc-mesh', section: 'substructure', name: 'BRC mesh (A142) for ground slab', unit: 'm²', quantity: Math.ceil(fpArea * 1.1), basis: 'Ground floor area + 10% laps', shop: { category: 'reinforcement', q: 'BRC mesh' } });

  add({ key: 'cement', section: 'walls', name: 'Cement (50 kg bags)', unit: 'bag', quantity: bags(cementConcreteM3) + bags(cementMortarM3) + bags(cementPlasterM3), basis: `Concrete ${round(vConcrete, 1)} m³ at ${c}:${s}:${g}, block mortar 1:${m.mortarMix}, plaster and render 1:${m.plasterMix}`, shop: { category: 'cement', q: 'cement' } });
  add({ key: 'blocks-9in', section: 'walls', name: `Sandcrete blocks, ${m.block.external}`, unit: 'piece', quantity: blocksExt, basis: `${round(extArea + parapetArea, 1)} m² of outside walls plus ${round(foundationArea, 1)} m² below ground, ${round(perM2, 2)} blocks/m² + ${m.block.wastePct}% waste`, shop: { category: 'blocks', q: '9 inch block' } });
  add({ key: 'blocks-6in', section: 'walls', name: `Sandcrete blocks, ${m.block.internal}`, unit: 'piece', quantity: blocksInt, basis: `${round(intArea, 1)} m² of internal walls, ${round(perM2, 2)} blocks/m² + ${m.block.wastePct}% waste`, shop: { category: 'blocks', q: '6 inch block' } });
  add({ key: 'sharp-sand', section: 'walls', name: 'Sharp sand', unit: 'tonne', quantity: tonnes(sandConcreteM3 + sandMortarM3, m.sandTPerM3), basis: 'Concrete and block-laying mortar', shop: { category: 'sand-granite', q: 'sharp sand' } });
  add({ key: 'plaster-sand', section: 'finishes', name: 'Plaster sand', unit: 'tonne', quantity: tonnes(sandPlasterM3, m.sandTPerM3), basis: `${round(plasterArea, 0)} m² of plaster and render, ${m.plasterM * 1000} mm`, shop: { category: 'sand-granite', q: 'plaster sand' } });
  add({ key: 'granite', section: 'frame', name: 'Granite chippings ¾"', unit: 'tonne', quantity: tonnes(graniteM3, m.graniteTPerM3), basis: `Concrete ${round(vConcrete, 1)} m³ (foundations, slabs, columns, beams, lintels${stairs ? ', stair' : ''})`, shop: { category: 'sand-granite', q: 'granite' } });

  // Reinforcement: columns, ring beams and lintels (4 × Y12 with R8 links at 200 mm), slabs and stairs by weight.
  const y12Len = (columns * H * d.storeys + allWallLen + lintelLen) * 4;
  const linkCount = (columns * H * d.storeys + allWallLen + lintelLen) / 0.2;
  const r8Len = linkCount * 0.8;
  const slabKg = vUpperSlabs * m.rebarKgPerM3.slab + vStair * m.rebarKgPerM3.stair;
  const bw = 1 + m.bar.wastePct / 100;
  add({ key: 'rebar-y12', section: 'frame', name: 'Reinforcement bars, 12 mm', unit: 'piece', quantity: Math.ceil(((y12Len + slabKg / m.bar.y12KgPerM) * bw) / m.bar.lengthM), basis: `${columns} columns, ${round(allWallLen, 0)} m of ring beams, lintels${slabKg ? ` and ${round(slabKg, 0)} kg for slabs and stairs` : ''}; ${m.bar.lengthM} m lengths`, shop: { category: 'reinforcement', q: '12mm' } });
  add({ key: 'rebar-r8', section: 'frame', name: 'Reinforcement bars, 8 mm (links)', unit: 'piece', quantity: Math.ceil((r8Len * bw) / m.bar.lengthM), basis: `Links at 200 mm in columns, beams and lintels; ${m.bar.lengthM} m lengths`, shop: { category: 'reinforcement', q: '8mm' } });
  add({ key: 'binding-wire', section: 'frame', name: 'Binding wire', unit: 'roll', quantity: Math.max(1, Math.ceil((y12Len * m.bar.y12KgPerM) / 1000 / 0.5)), basis: 'About one 20 kg roll per 500 kg of bars', shop: { category: 'reinforcement', q: 'binding wire' } });

  // Roof.
  const o = d.roof.overhangM;
  if (d.roof.kind === 'flat') {
    add({ key: 'waterproofing', section: 'roof', name: 'Roof waterproofing membrane', unit: 'm²', quantity: Math.ceil(fpArea * 1.15), basis: 'Roof slab + 15% upstands and laps', shop: { q: 'waterproofing membrane' } });
  } else {
    const cos = Math.cos((d.roof.pitchDeg * Math.PI) / 180);
    const roofArea = ((fp.w + 2 * o) * (fp.d + 2 * o)) / cos * (d.roof.kind === 'hip' ? 1.05 : 1);
    const ridgeLen = d.roof.ridge === 'x' ? fp.w + 2 * o : fp.d + 2 * o;
    const span = d.roof.ridge === 'x' ? fp.d + 2 * o : fp.w + 2 * o;
    const rafterLen = span / 2 / cos;
    const pairs = Math.ceil(ridgeLen / m.timber.rafterSpacingM) + 1;
    const rafters = pairs * 2 * Math.ceil(rafterLen / m.timber.pieceLengthM);
    const purlinRows = (Math.ceil(rafterLen / m.timber.purlinSpacingM) + 1) * 2;
    const purlins = Math.ceil((purlinRows * ridgeLen) / m.timber.pieceLengthM * (d.roof.kind === 'hip' ? 1.15 : 1));
    add({ key: 'roofing-sheets', section: 'roof', name: 'Long-span aluminium roofing sheets (0.55 mm)', unit: 'm²', quantity: Math.ceil(roofArea * 1.08), basis: `${d.roof.kind === 'hip' ? 'Hip' : 'Gable'} roof at ${d.roof.pitchDeg}°, ${o} m overhang, + 8% laps`, shop: { category: 'roofing', q: 'long span aluminium' } });
    add({ key: 'timber-2x4', section: 'roof', name: 'Timber 2" × 4" (rafters, wall plate)', unit: 'piece', quantity: rafters + Math.ceil((2 * (fp.w + fp.d)) / m.timber.pieceLengthM), basis: `${pairs} rafter pairs at ${m.timber.rafterSpacingM} m; ${m.timber.pieceLengthM} m lengths`, shop: { q: '2x4 timber' } });
    add({ key: 'timber-2x3', section: 'roof', name: 'Timber 2" × 3" (purlins)', unit: 'piece', quantity: purlins, basis: `Purlins at ${m.timber.purlinSpacingM} m; ${m.timber.pieceLengthM} m lengths`, shop: { q: '2x3 timber' } });
    add({ key: 'fascia', section: 'roof', name: 'Fascia board', unit: 'm', quantity: Math.ceil(2 * (fp.w + fp.d + 4 * o)), basis: 'Roof edge', shop: { q: 'fascia board' } });
  }

  // Openings.
  const extDoors = d.openings.filter((x) => x.kind === 'door' && x.external);
  const intDoors = d.openings.filter((x) => x.kind === 'door' && !x.external);
  const windows = d.openings.filter((x) => x.kind === 'window');
  add({ key: 'door-security', section: 'openings', name: 'Steel security doors (external)', unit: 'piece', quantity: extDoors.length, basis: extDoors.map((x) => x.label).join(', '), shop: { q: 'security door' } });
  add({ key: 'door-flush', section: 'openings', name: 'Flush doors with frames (internal)', unit: 'piece', quantity: intDoors.length, basis: `${intDoors.length} internal doors`, shop: { q: 'flush door' } });
  add({ key: 'windows', section: 'openings', name: 'Aluminium casement windows', unit: 'm²', quantity: round(windows.reduce((sum, x) => sum + (x.to - x.from) * (x.headM - x.sillM), 0), 1), basis: `${windows.length} windows`, shop: { q: 'aluminium window' } });

  // Finishes.
  const rooms = d.rooms.filter((r) => r.kind !== 'stair');
  const floorArea = rooms.reduce((sum, r) => sum + r.w * r.d, 0);
  const wet = d.rooms.filter((r) => WET.has(r.kind) || r.kind === 'kitchen');
  const wallTile = wet.reduce((sum, r) => sum + 2 * (r.w + r.d) * m.tile.wetWallHeightM, 0) * (1 - 0.1);
  add({ key: 'floor-tiles', section: 'finishes', name: 'Floor tiles', unit: 'm²', quantity: Math.ceil(floorArea * (1 + m.tile.wastePct / 100)), basis: `${round(floorArea, 1)} m² of floors + ${m.tile.wastePct}%`, shop: { q: 'floor tiles' } });
  add({ key: 'wall-tiles', section: 'finishes', name: 'Wall tiles (bathrooms and kitchen)', unit: 'm²', quantity: Math.ceil(wallTile * (1 + m.tile.wastePct / 100)), basis: `${m.tile.wetWallHeightM} m high in wet rooms and the kitchen`, shop: { q: 'wall tiles' } });
  add({ key: 'tile-adhesive', section: 'finishes', name: 'Tile adhesive (20 kg bags)', unit: 'bag', quantity: Math.ceil((floorArea + wallTile) / m.tile.adhesiveM2PerBag), basis: `About ${m.tile.adhesiveM2PerBag} m² per bag`, shop: { q: 'tile adhesive' } });
  const topArea = fpArea;
  add({ key: 'ceiling', section: 'finishes', name: 'PVC ceiling panels', unit: 'm²', quantity: Math.ceil(topArea * d.storeys * 1.05), basis: 'Ceilings on every floor + 5%', shop: { q: 'pvc ceiling' } });
  const paintInt = ((intArea * 2 + extArea) * m.paint.coats) / m.paint.m2PerLitre.internal;
  const paintExt = ((extArea + parapetArea) * m.paint.coats) / m.paint.m2PerLitre.external;
  add({ key: 'paint-emulsion', section: 'finishes', name: `Emulsion paint (${m.paint.bucketLitres} L buckets)`, unit: 'bucket', quantity: Math.ceil(paintInt / m.paint.bucketLitres), basis: `${round(intArea * 2 + extArea, 0)} m² inside, ${m.paint.coats} coats`, shop: { q: 'emulsion paint' } });
  add({ key: 'paint-exterior', section: 'finishes', name: `Exterior textured paint (${m.paint.bucketLitres} L buckets)`, unit: 'bucket', quantity: Math.ceil(paintExt / m.paint.bucketLitres), basis: `${round(extArea + parapetArea, 0)} m² outside, ${m.paint.coats} coats`, shop: { q: 'exterior paint' } });

  // Services: provisional counts per room, to be confirmed by the electrician and plumber.
  const habitable = d.rooms.filter((r) => HABITABLE.has(r.kind));
  const wetRooms = d.rooms.filter((r) => WET.has(r.kind));
  add({ key: 'light-points', section: 'services', name: 'Light points (fittings, switches)', unit: 'point', quantity: d.rooms.filter((r) => r.kind !== 'store').reduce((sum, r) => sum + (r.w * r.d > 16 ? 2 : 1), 0), basis: 'One per room, two in rooms over 16 m²', shop: { q: 'light fitting' }, provisional: true });
  add({ key: 'sockets', section: 'services', name: 'Socket outlets', unit: 'point', quantity: habitable.length * 3 + (d.rooms.some((r) => r.kind === 'kitchen' || r.kind === 'living-kitchen') ? 3 : 0), basis: 'Three per habitable room, three more in the kitchen', shop: { q: 'socket' }, provisional: true });
  add({ key: 'cable', section: 'services', name: 'Electrical cable, 2.5 mm² (100 m coils)', unit: 'coil', quantity: Math.max(2, Math.ceil((d.metrics.grossFloorM2 * 3) / 100)), basis: 'About 3 m per m² of floor', shop: { q: '2.5mm cable' }, provisional: true });
  add({ key: 'wc-sets', section: 'services', name: 'WC sets', unit: 'piece', quantity: wetRooms.length, basis: wetRooms.map((r) => r.name).join(', '), shop: { q: 'wc set' } });
  add({ key: 'basins', section: 'services', name: 'Wash-hand basins', unit: 'piece', quantity: wetRooms.length, basis: 'One per bathroom and WC', shop: { q: 'wash hand basin' } });
  add({ key: 'showers', section: 'services', name: 'Shower sets', unit: 'piece', quantity: wetRooms.filter((r) => r.kind !== 'wc').length, basis: 'One per bathroom and ensuite', shop: { q: 'shower' } });
  add({ key: 'kitchen-sink', section: 'services', name: 'Kitchen sink', unit: 'piece', quantity: 1, basis: 'One', shop: { q: 'kitchen sink' } });
  add({ key: 'pipes', section: 'services', name: 'PVC pipes and fittings', unit: 'lot', quantity: 1, basis: 'Water supply and drainage, sized by the plumber', shop: { q: 'pvc pipe' }, provisional: true });
  add({ key: 'water-tank', section: 'services', name: 'Water storage tank (2,000 L)', unit: 'piece', quantity: 1, basis: 'One', shop: { q: 'water tank' } });
  add({ key: 'septic', section: 'services', name: 'Septic tank and soakaway', unit: 'lot', quantity: 1, basis: 'Sized by the engineer for the number of users', shop: { category: 'trades', q: 'septic tank' }, provisional: true });
  return lines;
}

// ---------------------------------------------------------------- helpers

function round(n: number, dp: number) { const k = 10 ** dp; return Math.round(n * k) / k; }
function clampInt(n: unknown, lo: number, hi: number) { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }

// ---------------------------------------------------------------- reading a brief from plain words (no AI needed)

export type BuildIntent = 'build_home' | 'other_project' | 'shopping' | 'unclear';
export interface BriefReading { intent: BuildIntent; plot: Plot | null; brief: Partial<DesignBrief> }

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

/**
 * A rule-based reading of what someone typed, used when the AI is not connected (and as a cross-check).
 * It only fills what the words clearly say; everything else stays unset.
 */
export function readBriefText(text: string): BriefReading {
  const t = ` ${text.toLowerCase().replace(/[‐–—]/g, '-')} `;
  const brief: Partial<DesignBrief> = {};
  const num = (s: string) => NUMBER_WORDS[s] ?? Number(s);
  const beds = t.match(/(\d|one|two|three|four|five|six)\s*-?\s*(?:bed(?:room)?s?|br)\b/);
  if (beds) brief.bedrooms = num(beds[1]!);
  const baths = t.match(/(\d|one|two|three|four)\s*-?\s*bath(?:room)?s?\b/);
  if (baths) brief.bathrooms = num(baths[1]!);
  if (/\b(duplex|two[- ]stor(?:e)?y|2[- ]stor(?:e)?y|storey building|upstairs)\b/.test(t)) brief.storeys = 2;
  else if (/\b(bungalow|single[- ]stor(?:e)?y|one[- ]stor(?:e)?y)\b/.test(t)) brief.storeys = 1;
  if (/\bopen[- ]plan\b/.test(t)) brief.kitchen = 'open';
  if (/\b(study|home office|office)\b/.test(t)) brief.study = true;
  if (/\b(no|without) (an? )?ensuite\b/.test(t)) brief.ensuite = false;
  else if (/\b(ensuite|en-suite|master bath)\b/.test(t)) brief.ensuite = true;
  if (/\b(flat|parapet) roof\b/.test(t)) brief.roof = 'flat';
  else if (/\bgable\b/.test(t)) brief.roof = 'gable';
  else if (/\bhip(ped)? roof\b/.test(t)) brief.roof = 'hip';
  const cars = t.match(/(\d|one|two)\s*-?\s*(?:car|parking)/);
  if (cars) brief.parking = Math.min(2, num(cars[1]!)) as 0 | 1 | 2;
  else if (/\b(garage|parking|car port|carport)\b/.test(t)) brief.parking = 1;
  if (/\b(modern|contemporary|minimalist)\b/.test(t)) brief.style = 'modern';
  else if (/\b(classic|traditional|colonial)\b/.test(t)) brief.style = 'classic';
  else if (/\b(tropical|veranda|verandah|breezy)\b/.test(t)) brief.style = 'tropical';
  const plot = parsePlotSize(t);
  const building = /\b(build|house|home|bungalow|duplex|bedroom|bed\b|flat|apartment|storey)/.test(t) || brief.bedrooms !== undefined;
  const shopping = /\b(buy|shop|shopping|price|prices|cost of|where can i get|supplier|order)\b/.test(t);
  const other = /\b(fence|fencing|shop front|warehouse|church|school|hostel|office block|renovat|extension|borehole|swimming pool)\b/.test(t);
  const intent: BuildIntent = building && !shopping ? 'build_home' : other ? 'other_project' : shopping ? 'shopping' : plot ? 'build_home' : 'unclear';
  return { intent, plot, brief };
}
