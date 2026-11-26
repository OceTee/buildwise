/**
 * The free-form house solver: a new concept from every seed, not a fill-in of fixed layout families.
 *
 * A house is composed of zones, each sized from its own rooms:
 *  - the public zone: living, dining and kitchen in a row with the entrance hall (and a guest WC) set into it;
 *  - one or two private zones: a short lobby (never a corridor strip) with rooms down one or both sides and a master
 *    suite across its end, its ensuite and walk-in wardrobe in a column beside the bedroom.
 * A seed chooses every dimension (band depths, lobby widths, where the hall sits, which side each room goes) and how
 * the zones meet: behind the living rooms, offset into an L, beside the entrance as a side wing, split into a master
 * wing and a children's wing, or a sleeping pavilion across a courtyard reached by a short gallery. Two storeys put
 * the bedrooms upstairs in a two-storey sleeping block beside a single-storey living wing, the stair at the head of
 * the lobby on both floors.
 *
 * Every attempt goes through the engine's own pipeline (walls, doors, windows, checks, review); only designs that
 * pass every check are kept. The same seed always gives the same house, so a design is rebuilt from its id
 * (`free-<seed>-…`) by `findDesign`.
 */
import { isHouse } from './building';
import { DESIGN_IDEAS, ideaWeight, type IdeaPrefs, type IdeaPriors } from './ideas';
import { planningAnalysis } from './adjacency';
import {
  DEFAULT_DESIGN_CONFIG, ENGINE, candidateDesigns, conceptFor, normaliseBrief, validPlot,
  type Block, type Design, type DesignBrief, type DesignConfig, type EngineFiller, type EngineItem, type EnginePlaced, type Plot, type Rect, type RoomKind,
} from './design';

type Item = EngineItem;
const { item, programme, layBand, arrange, siteFrame, cmInside, finish, bandLength } = ENGINE;

// ---------------------------------------------------------------- randomness

/** A small, fast seeded generator (mulberry32): the same seed always gives the same house. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** A seed for the k-th attempt of a run (spread out so neighbouring runs share nothing). */
export function attemptSeed(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) % 1_000_000_000;
}
type Rng = () => number;
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const round = (n: number, dp = 3) => { const k = 10 ** dp; return Math.round(n * k) / k; };

// ---------------------------------------------------------------- zones, in their own frame

/** A room in a zone's own frame: `a` runs from the zone's entry along its lobby (or along the street for the public
 * zone), `b` across it. */
interface ZRoom { kind: RoomKind; name: string; storey: number; a: number; b: number; la: number; lb: number }
interface Zone { la: number; lb: number; rooms: ZRoom[]; /** Where the zone is entered, across `b` (its lobby). */ entry: [number, number]; storeys: number }

const BED: ReadonlySet<RoomKind> = new Set(['bedroom', 'master']);
const STUDY_FILLER: EngineFiller = { big: { kind: 'study', name: 'Study' }, small: { kind: 'store', name: 'Linen store' } };

/** Rooms that read as rooms only when they are not much longer one way than the other. */
const PROPORTIONED: ReadonlySet<RoomKind> = new Set(['living', 'dining', 'kitchen', 'living-kitchen', 'lounge', 'master', 'bedroom', 'study', 'gym', 'gaming', 'cinema', 'prayer', 'laundry']);
/** At least `depth / 1.8` along the band: no 2.1 m kitchen running six metres deep. */
const proportioned = (items: Item[], depth: number) => items.map((i) => (PROPORTIONED.has(i.kind) && !i.fixedW && !i.withEnsuite ? { ...i, minDim: Math.max(i.minDim, round(depth / 1.8, 2)) } : i));
function lay(itemsIn: Item[], band: { a: number; b: number; la: number; lb: number }, side: 'start' | 'end', cfg: DesignConfig, storey: number, filler: EngineFiller, out: ZRoom[]) {
  const items = proportioned(itemsIn, band.lb);
  // One filler study per floor at most: a second spare length becomes a store.
  const studied = out.some((z) => z.storey === storey && z.name === 'Study');
  const fill: EngineFiller = studied && filler.big?.kind === 'study' ? { big: null, small: filler.small } : filler;
  for (const p of layBand(items, band, side, cfg, fill)) {
    out.push({ kind: p.item.kind, name: p.item.name, storey, a: p.r.a, b: p.r.b, la: p.r.la, lb: p.r.lb });
    if (p.ensuite) out.push({ kind: 'ensuite', name: 'Ensuite', storey, a: p.ensuite.a, b: p.ensuite.b, la: p.ensuite.la, lb: p.ensuite.lb });
  }
}

/**
 * A private zone: a lobby from the entry, rooms down one side (single-loaded) or both, and across its end the master
 * suite (or, on a floor without one, the floor's largest room). `floors[0]` is the zone's ground floor. With a stair,
 * it heads the left band on every floor, so it stands in the same place on each.
 */
function privateZone(cfg: DesignConfig, floors: Item[][], r: Rng, o: { stair: boolean; single: boolean; names: string[]; endLounge?: boolean }): Zone | null {
  // A single-loaded wing that would need too long a lobby is laid with rooms down both sides instead.
  if (o.single) return privateZoneOf(cfg, floors, r, o) ?? privateZoneOf(cfg, floors, r, { ...o, single: false });
  return privateZoneOf(cfg, floors, r, o);
}
function privateZoneOf(cfg: DesignConfig, floors: Item[][], r: Rng, o: { stair: boolean; single: boolean; names: string[]; endLounge?: boolean }): Zone | null {
  const run = cfg.stair.minRunM;
  const stairItem = (): Item => ({ kind: 'stair', name: 'Stair', target: cfg.stair.widthM * run, min: 0, minDim: cfg.stair.widthM, fixedW: cfg.stair.widthM });
  const flip = r() < 0.5;
  const planFor = (sdL: number, sdR: number) => floors.map((items, f) => {
    const all = items.filter((i) => i.kind !== 'stair' && i.kind !== 'lift');
    const mi = all.findIndex((i) => i.kind === 'master');
    let master = mi >= 0 ? all.splice(mi, 1)[0]! : null;
    let lounge: Item | null = null;
    if (o.endLounge && f > 0) {
      // The family lounge takes the end; the master suite moves down a side, its ensuite beside it.
      if (master) { all.push({ ...master, withEnsuite: false, target: cfg.rooms.master.targetM2 }); if (master.withEnsuite) all.push(item(cfg, 'ensuite', 'Ensuite')); }
      master = null;
      const li = all.findIndex((i) => i.kind === 'lounge');
      lounge = li >= 0 ? all.splice(li, 1)[0]! : item(cfg, 'lounge', 'Family lounge');
    }
    // A floor with a kitchen (a duplex's ground floor) keeps cooking and sleeping apart: the dining room and kitchen
    // down one side of the lobby, bedrooms and bathrooms down the other, a family room across the end.
    const food = all.filter((i) => i.kind === 'kitchen' || i.kind === 'dining' || i.kind === 'laundry');
    // A floor without a master suite puts its largest room across the end (a guest bedroom, else a family room).
    const ei = master || food.length ? -1 : all.findIndex((i) => i.kind === 'bedroom');
    const endItem = master ?? lounge ?? (ei >= 0 ? all.splice(ei, 1)[0]! : { ...item(cfg, 'lounge', 'Family room') });
    const L: Item[] = []; const R: Item[] = [];
    const stairSide = o.single ? R : L;
    if (o.stair) stairSide.push(stairItem());
    if (food.length && !o.single) {
      for (const f of food) all.splice(all.indexOf(f), 1);
      // Dining nearest the lobby's start (the hall), the kitchen beyond it, by the family room.
      const foodSide = stairSide === L ? R : L;
      foodSide.push(...food.filter((i) => i.kind === 'dining'), ...food.filter((i) => i.kind !== 'dining'));
      stairSide.push(...all.filter((i) => BED.has(i.kind) || i.kind === 'bathroom' || i.kind === 'wc'));
      const rest = all.filter((i) => !BED.has(i.kind) && i.kind !== 'bathroom' && i.kind !== 'wc');
      for (const it of rest) (bandLength(proportioned(L, sdL), sdL) <= bandLength(proportioned(R, sdR), sdR) ? L : R).push(it);
      return { master, endItem, L: stairSide === L ? arrangeKeepStair(L) : L, R: stairSide === R ? arrangeKeepStair(R) : R, f };
    }
    // Bedrooms first, each followed by the bathroom nearest it; then studies, stores and the rest. The side with less
    // length so far takes the next room, so both sides of the lobby end level.
    const beds = all.filter((i) => BED.has(i.kind)); const wet = all.filter((i) => i.kind === 'bathroom' || i.kind === 'wc');
    const rest = all.filter((i) => !beds.includes(i) && !wet.includes(i));
    const order: Item[] = [];
    while (beds.length || wet.length) { if (beds.length) order.push(beds.shift()!); if (wet.length) order.push(wet.shift()!); }
    order.push(...rest);
    for (const it of order) {
      if (o.single) { R.push(it); continue; }
      const lenL = bandLength(proportioned(L, sdL), sdL); const lenR = bandLength(proportioned(R, sdR), sdR);
      ((lenL < lenR) !== flip ? L : R).push(it);
    }
    // A stair never stands alone in its band (spare length would push it to the far end on one floor only).
    if (o.stair && stairSide.length === 1) stairSide.push({ ...item(cfg, 'store', 'Store') });
    return { master, endItem, L: o.single ? L : arrangeKeepStair(L), R: arrangeKeepStair(R), f };
  });
  // Band depths and lobby width: the seed's choice first, then deeper bands (shorter rooms along the lobby) until the
  // lobby stays within a lobby's length.
  const depths = [3.0, 3.3, 3.6, 3.9, 4.2];
  const start = pick(r, depths.slice(0, 4));
  const wl0 = pick(r, [1.6, 1.8, 2.0]);
  let sdL = 0; let sdR = 0; let wl = wl0; let plans: ReturnType<typeof planFor> | null = null; let Lc = 0;
  for (const d of depths.filter((x) => x >= start)) {
    sdL = o.single ? 0 : o.stair ? Math.max(run, d) : d;
    sdR = o.single && o.stair ? Math.max(run, d) : d;
    const ps = planFor(sdL, sdR);
    const len = round(Math.max(2.4, ...ps.map((p) => Math.max(sdL ? bandLength(proportioned(p.L, sdL), sdL) : 0, bandLength(proportioned(p.R, sdR), sdR)))), 2);
    if (len <= (wl >= 1.6 - 1e-6 ? cfg.maxHouseHallM : cfg.maxHousePassageM)) { plans = ps; Lc = len; break; }
  }
  if (!plans) return null;
  const Lb = round(sdL + wl + sdR, 2);
  // The end band: the master bedroom across the lobby's end, its ensuite and walk-in wardrobe in a column beside it.
  const colW = o.single ? 0 : (o.stair ? sdR : pick(r, [sdL, sdR]));
  const colRight = o.single ? false : o.stair ? true : colW === sdR ? r() < 0.7 : false;
  const ensD = pick(r, [1.8, 2.0, 2.2]);
  const endD = round(Math.max(3.3, ...plans.map((p) => {
    const w = Lb - colW;
    const t = p.master ? cfg.rooms.master.targetM2 : p.endItem.target;
    return Math.max(p.endItem.minDim, t / Math.max(1, w), p.master && colW ? ensD + 1.5 : 0) + (p.master?.withEnsuite && !colW ? ensD : 0);
  })) + pick(r, [0, 0, 0.3, 0.6]), 2);
  const La = round(Lc + endD, 2);
  const rooms: ZRoom[] = [];
  for (const p of plans) {
    const st = p.f;
    rooms.push({ kind: 'corridor', name: o.names[st] ?? 'Lobby', storey: st, a: 0, b: sdL, la: Lc, lb: wl });
    if (sdL) lay(p.L, { a: 0, b: 0, la: Lc, lb: sdL }, 'end', cfg, st, STUDY_FILLER, rooms);
    lay(p.R, { a: 0, b: round(sdL + wl, 3), la: Lc, lb: sdR }, 'start', cfg, st, STUDY_FILLER, rooms);
    const colB = colRight ? round(Lb - colW, 3) : 0;
    const mainB = colRight ? 0 : colW;
    const mainW = round(Lb - colW, 3);
    const endName = p.master ? p.master.name : p.endItem.name;
    if (!colW && p.master?.withEnsuite) {
      // No column beside it (a single-loaded wing): the ensuite and a wardrobe go across the far end.
      const ew = Lb - 2.4 >= 1.2 ? 2.4 : Lb;
      rooms.push({ kind: 'master', name: endName, storey: st, a: Lc, b: 0, la: round(endD - ensD, 3), lb: Lb });
      rooms.push({ kind: 'ensuite', name: 'Ensuite', storey: st, a: round(La - ensD, 3), b: 0, la: ensD, lb: ew });
      if (ew < Lb) rooms.push({ kind: 'store', name: 'Walk-in wardrobe', storey: st, a: round(La - ensD, 3), b: ew, la: ensD, lb: round(Lb - ew, 3) });
      continue;
    }
    rooms.push({ kind: p.master ? 'master' : p.endItem.kind, name: endName, storey: st, a: Lc, b: mainB, la: endD, lb: mainW });
    if (colW) {
      if (p.master?.withEnsuite) {
        rooms.push({ kind: 'ensuite', name: 'Ensuite', storey: st, a: round(La - ensD, 3), b: colB, la: ensD, lb: colW });
        rooms.push({ kind: 'store', name: 'Walk-in wardrobe', storey: st, a: Lc, b: colB, la: round(endD - ensD, 3), lb: colW });
      } else if (p.master) {
        rooms.push({ kind: 'store', name: 'Walk-in wardrobe', storey: st, a: Lc, b: colB, la: endD, lb: colW });
      } else {
        rooms.push({ kind: 'study', name: 'Study', storey: st, a: Lc, b: colB, la: endD, lb: colW });
      }
    }
  }
  return { la: La, lb: Lb, rooms, entry: [sdL, round(sdL + wl, 3)], storeys: floors.length };
}
/** The engine's affinity order for a band, keeping a stair at its head. */
function arrangeKeepStair(xs: Item[]): Item[] {
  const stair = xs.filter((i) => i.kind === 'stair');
  return [...stair, ...arrange(xs.filter((i) => i.kind !== 'stair'), stair.length ? 'stair' : 'corridor')];
}

/**
 * The public zone: one band along the street, `Dp` deep, holding the living room, the dining room and kitchen (or the
 * open-plan room) and the entrance hall, with a guest WC and cloaks store in a column beside the hall.
 */
function publicZone(cfg: DesignConfig, items: Item[], wc: Item | null, r: Rng, hallAtIn: 'start' | 'middle' | 'end', wingAtStart = false, stacked = false, dpMin = 0): { zone: Zone; hall: [number, number]; column: { a: number; la: number; lb: number } | null; main: [number, number] } | null {
  // Stacked: the dining room and kitchen stand one behind the other in a kitchen wing at the end of the row, so the
  // frontage is short enough for a narrower plot (the kitchen at the back, by the yard).
  const hallAt = hallAtIn;
  const living = items.filter((i) => i.kind === 'living' || i.kind === 'living-kitchen');
  const rest = arrange(items.filter((i) => !living.includes(i)), 'corridor');
  const Dp = round(Math.max(pick(r, [4.2, 4.5, 4.8, 5.1, 5.4, 6.0]), dpMin, ...items.map((i) => i.minDim)), 2);
  const hallW = wc ? pick(r, [1.6, 1.8]) : pick(r, [1.8, 2.1, 2.4]);
  const colW = wc ? 1.2 : 0;
  const column = stacked && rest.length > 1;
  const parts: { kind: 'rooms' | 'hall' | 'column'; items?: Item[] }[] = column
    // The kitchen wing at the far end from the hall when the hall ends the row, so a block behind the hall never meets it.
    ? (hallAt === 'start' ? [{ kind: 'hall' }, { kind: 'rooms', items: living }, { kind: 'column', items: rest }]
      : hallAt === 'end' ? [{ kind: 'column', items: rest }, { kind: 'rooms', items: living }, { kind: 'hall' }]
        : [{ kind: 'rooms', items: living }, { kind: 'hall' }, { kind: 'column', items: rest }])
    : hallAt === 'start' ? [{ kind: 'hall' }, { kind: 'rooms', items: [...living, ...rest] }]
      : hallAt === 'end' ? [{ kind: 'rooms', items: [...living, ...rest] }, { kind: 'hall' }]
        : [{ kind: 'rooms', items: living }, { kind: 'hall' }, { kind: 'rooms', items: rest }];
  let col: { a: number; la: number; lb: number } | null = null;
  const rooms: ZRoom[] = [];
  let a = 0; let hall: [number, number] = [0, 0];
  for (const [k, p] of parts.entries()) {
    if (p.kind === 'hall') {
      // The WC column goes on the side away from food: toward the living room, or the outer end; when a wing meets
      // the hall's outer side, the column moves inside so the hall's own wall meets the wing's lobby.
      const colFirst = hallAt === 'start' ? !wingAtStart : hallAt === 'end' ? false : true;
      const colA = colFirst ? a : round(a + hallW, 3);
      const hA = colFirst ? round(a + colW, 3) : a;
      rooms.push({ kind: 'corridor', name: 'Entrance hall', storey: 0, a: hA, b: 0, la: hallW, lb: Dp });
      if (wc) {
        rooms.push({ kind: 'wc', name: wc.name, storey: 0, a: colA, b: 0, la: colW, lb: 1.8 });
        rooms.push({ kind: 'store', name: 'Cloaks', storey: 0, a: colA, b: 1.8, la: colW, lb: round(Dp - 1.8, 3) });
      }
      hall = [hA, round(hA + hallW, 3)];
      a = round(a + hallW + colW, 3);
      continue;
    }
    const xs = p.items!;
    if (!xs.length) continue;
    if (p.kind === 'column') {
      const cw = round(Math.max(pick(r, [3.3, 3.6, 3.9]), ...xs.map((i) => i.minDim)), 2);
      const cd = round(Math.max(Dp, bandLength(proportioned(xs, cw), cw)) + pick(r, [0, 0, 0.3]), 3);
      for (const q of layBand(proportioned(xs, cw), { a: 0, b: a, la: cd, lb: cw }, 'start', cfg, { big: null, small: { kind: 'store', name: 'Store' } })) {
        rooms.push({ kind: q.item.kind, name: q.item.name, storey: 0, a: q.r.b, b: q.r.a, la: q.r.lb, lb: q.r.la });
      }
      col = { a, la: cw, lb: cd };
      a = round(a + cw, 3); // the row continues after the wing (it can stand first)
      continue;
    }
    const len = round(bandLength(proportioned(xs, Dp), Dp) + (k === parts.length - 1 ? pick(r, [0, 0, 0.3, 0.6]) : 0), 3);
    lay(xs, { a, b: 0, la: len, lb: Dp }, 'start', cfg, 0, { big: null, small: null }, rooms);
    a = round(a + len, 3);
  }
  // The main row: everything but the kitchen wing, which stands at one end.
  const main: [number, number] = col ? (col.a < 1e-6 ? [col.la, a] : [0, col.a]) : [0, a];
  return { zone: { la: a, lb: Dp, rooms, entry: hall, storeys: 1 }, hall, column: col, main };
}

// ---------------------------------------------------------------- composition

type Orient = 'down' | 'right' | 'left';
/** A zone room in world coordinates, the zone's entry corner at (x0, y0). */
function place(z: ZRoom, x0: number, y0: number, o: Orient): Rect {
  switch (o) {
    case 'down': return { x: round(x0 + z.b), y: round(y0 + z.a), w: round(z.lb), d: round(z.la) };
    case 'right': return { x: round(x0 + z.a), y: round(y0 + z.b), w: round(z.la), d: round(z.lb) };
    default: return { x: round(x0 - z.a - z.la), y: round(y0 + z.b), w: round(z.la), d: round(z.lb) };
  }
}
function zoneRect(z: Zone, x0: number, y0: number, o: Orient): Rect { return place({ kind: 'corridor', name: '', storey: 0, a: 0, b: 0, la: z.la, lb: z.lb }, x0, y0, o); }
const overlaps = (p: Rect, q: Rect) => Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x) > 0.01 && Math.min(p.y + p.d, q.y + q.d) - Math.max(p.y, q.y) > 0.01;

export type FreeParti = 'behind' | 'offset' | 'pavilion' | 'side-wing' | 'split-wings';
const PARTI_NAMES: Record<FreeParti, { name: string; blurb: string }> = {
  behind: { name: 'Sleeping wing behind', blurb: 'Living rooms across the front round the entrance hall; behind them a quiet bedroom wing off its own short lobby.' },
  offset: { name: 'Offset bedroom wing', blurb: 'The bedroom wing steps out past the living rooms into an L, leaving a sheltered garden corner beside it.' },
  pavilion: { name: 'Two pavilions', blurb: 'Living and sleeping in two pavilions across a garden court, joined by a short gallery: light and air on every side.' },
  'side-wing': { name: 'Side bedroom wing', blurb: 'The entrance hall in the middle of the frontage: living rooms one side, the bedroom wing the other, each with its own garden.' },
  'split-wings': { name: 'Split bedroom wings', blurb: 'The master suite in a wing of its own beside the entrance; the other bedrooms in a second wing behind, round a garden court.' },
};

/**
 * One attempt: a concept from one seed. Null when the seed's choices do not fit the plot; the caller tries another.
 */
export interface FreeOptions {
  /** Design from this idea (its key); else one is drawn by the seed, weighted by the person's choices. */
  idea?: string;
  prefs?: IdeaPrefs;
  priors?: IdeaPriors;
}
/** A weighted draw: weight w of the total. */
function draw<T>(r: Rng, xs: readonly T[], weight: (x: T) => number): T | null {
  const total = xs.reduce((t, x) => t + weight(x), 0);
  let at = r() * total;
  for (const x of xs) { at -= weight(x); if (at <= 0) return x; }
  return xs[xs.length - 1] ?? null;
}

export function freeDesign(plot: Plot, briefIn: Partial<DesignBrief>, seed: number, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG, opts: FreeOptions = {}): Design | null {
  const brief = normaliseBrief(briefIn);
  if (!validPlot(plot) || !isHouse(brief.type) || brief.storeys > 2) return null;
  const r = seededRandom(seed);
  const two = brief.storeys === 2;
  const floors = programme(cfg, brief);
  const g = [...floors[0]!.front, ...floors[0]!.rear].filter((i) => i.kind !== 'stair' && i.kind !== 'lift');
  const { envelope: site, fy0 } = siteFrame(plot, brief, cfg);
  const env = cmInside(site);
  // On a narrow plot the frontage cannot spare a WC column beside the hall: the guest WC moves just inside, heading the
  // lobby behind the hall (still the first door a guest passes).
  const narrowPlot = env.w < 13;
  const wcFound = g.find((i) => i.kind === 'wc') ?? null;
  const wc = narrowPlot ? null : wcFound;
  // Two storeys: the living room (or open-plan room) is a single-storey wing; the dining room, kitchen and the rest of
  // the ground floor go under the bedrooms, so the two-storey block has a real ground floor, not spare rooms.
  const pub = g.filter((i) => (two ? ['living', 'living-kitchen', 'gaming', 'cinema'] : ['living', 'living-kitchen', 'dining', 'kitchen', 'laundry', 'gaming', 'cinema', 'lounge']).includes(i.kind));
  const groundPrivate = g.filter((i) => i !== wc && !pub.includes(i));
  if (narrowPlot && wcFound) { groundPrivate.splice(groundPrivate.indexOf(wcFound), 1); groundPrivate.unshift(wcFound); }
  // ...and a bungalow's store joins the kitchen wing (a pantry by the kitchen), keeping the bedroom lobby short.
  if (narrowPlot && !two) for (const st of groundPrivate.filter((i) => i.kind === 'store')) { groundPrivate.splice(groundPrivate.indexOf(st), 1); pub.push(st); }
  const upper = two ? [...floors[1]!.front, ...floors[1]!.rear].filter((i) => i.kind !== 'stair' && i.kind !== 'lift').map((i) => (i.name === 'Upstairs lounge' ? { ...i, name: 'Family lounge' } : i)) : [];

  // Wings beside the entrance need a wide plot; on a narrower one the bedrooms go behind the living rooms.
  const wide = env.w >= 16;
  // The idea: the one asked for, else drawn by the seed among those this plot and brief allow, weighted by how well
  // each suits the person (and what people have chosen before).
  const allowed = DESIGN_IDEAS.filter((i) => (!i.storeys || i.storeys === brief.storeys)
    && (i.upper !== 'terrace' || brief.roof === 'flat' || brief.roof === 'hidden')
    && (i.parti !== 'side-wing' || wide) && (i.parti !== 'split-wings' || (wide && !two && brief.bedrooms >= 3)));
  // The draw always happens (one random number), so a design rebuilt from its id follows the very same sequence.
  const drawn = draw(r, allowed, (i) => ideaWeight(i, opts.prefs, opts.priors));
  const idea = opts.idea ? allowed.find((i) => i.key === opts.idea) ?? null : drawn;
  if (!idea) return null;
  const parti: FreeParti = idea.parti;
  const wingSide = parti === 'side-wing' || parti === 'split-wings';
  const hallDraw = pick(r, ['middle', 'middle', 'end'] as const);
  const stackDraw = r() < 0.45;
  const stacked = env.w < 14 || (idea.stacked ?? stackDraw);
  // With a kitchen wing, the hall ends the row and the wing stands at the far end, clear of the bedrooms behind the hall.
  const hallAt = wingSide ? 'start' as const : idea.upper === 'over-living' || stacked ? 'end' as const : hallDraw;
  // The row's depth is the seed's choice; where that makes the frontage wider than the plot allows, a deeper row (shorter
  // rooms along the street) is tried before giving up.
  const widthOf = (z: NonNullable<ReturnType<typeof publicZone>>) => z.zone.la;
  let P: ReturnType<typeof publicZone> = null;
  for (const dpMin of [0, 5.4, 6.0, 6.6]) {
    P = publicZone(cfg, pub, wc, r, hallAt, wingSide, stacked, dpMin);
    if (P && widthOf(P) <= env.w + 1e-6) break;
  }
  if (!P) return null;

  // The private side: one zone, or for split wings a master wing and a children's wing.
  const zones: { z: Zone; o: Orient; x0: number; y0: number; name: string }[] = [];
  const names = two ? ['Stair hall', 'Landing'] : ['Bedroom lobby'];
  // Master above the living room: the back block's upper floor keeps the children's rooms round the family lounge.
  const aboveLiving = two && idea.upper === 'over-living' ? upper.find((i) => i.kind === 'master') ?? null : null;
  const upperBack = aboveLiving ? upper.filter((i) => i !== aboveLiving) : upper;
  const privateFloors = two ? [groundPrivate.length ? groundPrivate : [item(cfg, 'study', 'Study')], upperBack] : [groundPrivate];
  const endLounge = two && (idea.upper === 'lounge' || idea.upper === 'over-living');
  const hallX = P.hall; // along the public zone's a axis (world x before the shift)
  const [m0, m1] = P.main; const Pw = m1; const Dp = P.zone.lb;
  // World frame first with the public zone's left end at x = 0, its front at y = 0; shifted onto the plot at the end.
  const pubRooms = P.zone.rooms.map((z) => ({ ...z, rect: place(z, 0, 0, 'right') }));
  const inRect = (q: Rect, b: Rect) => q.x >= b.x - 1e-6 && q.x + q.w <= b.x + b.w + 1e-6 && q.y >= b.y - 1e-6 && q.y + q.d <= b.y + b.d + 1e-6;
  const mainRect: Rect = { x: m0, y: 0, w: m1 - m0, d: Dp };
  const placedZones: { rect: Rect; rooms: { z: ZRoom; rect: Rect }[]; name: string; storeys: number }[] = [
    { rect: mainRect, rooms: pubRooms.filter((p) => inRect(p.rect, mainRect)).map((p) => ({ z: p, rect: p.rect })), name: 'Living wing', storeys: 1 },
  ];
  if (aboveLiving) {
    // Upstairs over the living wing: the master suite over the living room, a gallery over the entrance hall (it meets
    // the landing behind), a linen store over the WC column. Anything else in the wing is left open as a loggia.
    const lv = pubRooms.find((p) => p.kind === 'living' || p.kind === 'living-kitchen');
    const hall = pubRooms.find((p) => p.name === 'Entrance hall');
    if (!lv || !hall) return null;
    const ups: ZRoom[] = [];
    lay([aboveLiving], { a: lv.rect.x, b: 0, la: lv.rect.w, lb: Dp }, 'start', cfg, 1, { big: null, small: null }, ups);
    ups.push({ kind: 'corridor', name: 'Gallery', storey: 1, a: hall.rect.x, b: 0, la: hall.rect.w, lb: Dp });
    for (const c of pubRooms.filter((p) => p.kind === 'wc')) ups.push({ kind: 'store', name: 'Linen store', storey: 1, a: c.rect.x, b: 0, la: c.rect.w, lb: Dp });
    placedZones[0]!.rooms.push(...ups.map((z) => ({ z, rect: place(z, 0, 0, 'right') })));
    placedZones[0]!.storeys = 2;
    placedZones[0]!.name = 'House';
  }
  // Every room of the public zone belongs to its row or its kitchen wing: none may silently drop out.
  const colRect: Rect | null = P.column ? { x: P.column.a, y: 0, w: P.column.la, d: P.column.lb } : null;
  if (pubRooms.some((p) => !inRect(p.rect, mainRect) && !(colRect && inRect(p.rect, colRect)))) return null;
  if (P.column) {
    const cr: Rect = { x: P.column.a, y: 0, w: P.column.la, d: P.column.lb };
    placedZones.push({ rect: cr, rooms: pubRooms.filter((p) => inRect(p.rect, cr) && !inRect(p.rect, mainRect)).map((p) => ({ z: p, rect: p.rect })), name: 'Kitchen wing', storeys: 1 });
  }
  const links: { rect: Rect; name: string }[] = [];
  const hallMid = (hallX[0] + hallX[1]) / 2;
  const fitLobby = (z: Zone, centreAt: number, slack: number) => {
    // The lobby's centre lands within `slack` of the hall's centre, keeping at least 1.2 m of shared wall.
    const lob = (z.entry[0] + z.entry[1]) / 2;
    return round(centreAt + (r() * 2 - 1) * slack - lob, 2);
  };
  const hallW = hallX[1] - hallX[0];
  if (parti === 'split-wings') {
    const all = [...groundPrivate];
    const mi = all.findIndex((i) => i.kind === 'master');
    if (mi < 0) return null;
    const master = all.splice(mi, 1)[0]!;
    const wingA = [master, ...all.filter((i) => i.kind === 'study' || i.kind === 'store').slice(0, 1)];
    const wingB = all.filter((i) => !wingA.includes(i));
    if (!wingB.some((i) => BED.has(i.kind))) return null;
    // The master wing runs out to the left of the hall (entered from the hall's side), single-loaded so it stays
    // shallow; the children's wing runs back behind the living rooms from the hall's far end.
    const A = privateZone(cfg, [wingA], r, { stair: false, single: true, names: ['Master lobby'] });
    const B = privateZone(cfg, [wingB], r, { stair: false, single: true, names: ['Bedroom lobby'] });
    if (!A || !B) return null;
    // The master wing beside the hall, within the living rooms' depth where it fits (so the children's wing behind
    // never meets it); its lobby keeps 1.2 m of the hall's side wall.
    const aMid = (A.entry[0] + A.entry[1]) / 2;
    const ay = round(A.lb <= Dp ? (Dp - A.lb) * r() : Math.min(Dp - A.entry[1] + Math.max(0, (A.entry[1] - A.entry[0]) - 1.2), Math.max(0, Dp / 2 - aMid)), 2);
    zones.push({ z: A, o: 'left', x0: hallX[0], y0: ay, name: 'Master wing' });
    // The children's wing behind, its lobby over the hall.
    const bx = B.entry[0] === 0 ? hallX[0] : round((hallX[0] + hallX[1]) / 2 - (B.entry[0] + B.entry[1]) / 2, 2);
    zones.push({ z: B, o: 'down', x0: bx, y0: Dp, name: 'Bedroom wing' });
  } else if (parti === 'side-wing') {
    const Z = privateZone(cfg, privateFloors, r, { stair: two, single: false, names, endLounge });
    if (!Z) return null;
    // Beside the entrance hall, entered from its side: the lobby's centre lands somewhere along the hall's depth,
    // keeping 1.2 m of shared wall.
    if (hallX[0] > 1e-6) return null;
    const lob = (Z.entry[0] + Z.entry[1]) / 2; const half = (Z.entry[1] - Z.entry[0]) / 2;
    const at = Math.min(Dp - Math.max(0, 1.2 - half), Math.max(Math.max(0, 1.2 - half), Dp / 2 + (r() * 2 - 1) * (Dp / 2)));
    const y0 = round(at - lob, 2);
    zones.push({ z: Z, o: 'left', x0: 0, y0, name: two ? 'House' : 'Bedroom wing' });
  } else {
    const singleDraw = r() < 0.3;
    const single = !two && (idea.single ?? singleDraw);
    const Z = privateZone(cfg, privateFloors, r, { stair: two, single, names, endLounge });
    if (!Z) return null;
    const slack = Math.max(0, (hallW + (Z.entry[1] - Z.entry[0])) / 2 - 1.2);
    let x0: number;
    if (parti === 'offset') {
      // Pushed as far to one side as the hall allows: the wing steps past the living rooms into an L.
      const side = r() < 0.5 ? -1 : 1;
      x0 = round(hallMid + side * slack - (Z.entry[0] + Z.entry[1]) / 2, 2);
    } else x0 = fitLobby(Z, hallMid, slack * 0.5);
    // Never a bedroom block against the kitchen: slide it along the hall (its lobby still meeting it) until it is clear.
    {
      const lo = hallX[0] + 1.2 - Z.entry[1]; const hi = hallX[1] - 1.2 - Z.entry[0];
      const kitchens = pubRooms.filter((p) => p.kind === 'kitchen' || p.kind === 'living-kitchen').map((p) => p.rect);
      const touches = (a: Rect, b: Rect) => {
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x); const oy = Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y);
        return (ox > 0.3 && oy > -0.01) || (oy > 0.3 && ox > -0.01);
      };
      const wing = P.column ? { x: P.column.a, y: 0, w: P.column.la, d: P.column.lb } : null;
      const clear = (x: number) => !kitchens.some((k) => touches(zoneRect(Z, x, Dp, 'down'), k)) && !(wing && overlaps(zoneRect(Z, x, Dp, 'down'), wing));
      if ((kitchens.length || wing) && !clear(x0)) {
        const options: number[] = [];
        for (let x = lo; x <= hi + 1e-6; x += 0.3) if (clear(x)) options.push(round(x, 2));
        if (options.length) x0 = options.sort((a, b) => Math.abs(a - x0) - Math.abs(b - x0))[0]!;
      }
    }
    if (narrowPlot) {
      // On a narrow plot the bedroom block stays within the living row's width where its lobby still meets the hall,
      // and where that keeps it clear of a kitchen wing beside the row.
      const lo = hallX[0] + 1.2 - Z.entry[1]; const hi = hallX[1] - 1.2 - Z.entry[0];
      const tucked = round(Math.min(hi, Math.max(lo, Math.min(Math.max(x0, Math.min(m0, Pw - Z.lb)), Math.max(m0, Pw - Z.lb)))), 2);
      const col = P.column ? { x: P.column.a, y: 0, w: P.column.la, d: P.column.lb } : null;
      if (!col || !overlaps(zoneRect(Z, tucked, Dp, 'down'), col)) x0 = tucked;
    }
    let y0 = Dp;
    if (parti === 'pavilion') {
      // A garden court between the pavilions; a gallery over the shared span joins the hall to the lobby.
      const gap = pick(r, [2.4, 3.0, 3.6]);
      const lo = Math.max(hallX[0], x0 + Z.entry[0]); const hi = Math.min(hallX[1], x0 + Z.entry[1]);
      if (hi - lo < 1.2 - 1e-6) return null;
      links.push({ rect: { x: round(lo), y: Dp, w: round(hi - lo), d: gap }, name: 'Gallery' });
      y0 = round(Dp + gap, 2);
    }
    zones.push({ z: Z, o: 'down', x0, y0, name: two ? 'House' : 'Bedroom wing' });
  }

  // Into world coordinates, checking nothing overlaps.
  for (const zz of zones) {
    const rect = zoneRect(zz.z, zz.x0, zz.y0, zz.o);
    placedZones.push({ rect, rooms: zz.z.rooms.map((z) => ({ z, rect: place(z, zz.x0, zz.y0, zz.o) })), name: zz.name, storeys: zz.z.storeys });
  }
  const rects = [...placedZones.map((p) => p.rect), ...links.map((l) => l.rect)];
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlaps(rects[i]!, rects[j]!)) return null;
  // Onto the plot: the whole group inside the buildable area, its front on the building line, placed across the
  // width by the seed (hugging a side leaves one generous side garden).
  const x0 = Math.min(...rects.map((q) => q.x)); const x1 = Math.max(...rects.map((q) => q.x + q.w));
  const y1 = Math.max(...rects.map((q) => q.y + q.d)); const y0g = Math.min(...rects.map((q) => q.y));
  const W = x1 - x0; const D = y1 - y0g;
  if (W > env.w + 1e-6 || fy0 + D > env.y + env.d + 1e-6) return null;
  const slackX = env.w - W;
  const dx = round(env.x - x0 + pick(r, [0, 0.5, 0.5, 1]) * slackX, 2);
  const dy = round(fy0 - y0g, 2);
  const mirror = r() < 0.5;
  const mx = (q: Rect): Rect => {
    const s = { x: round(q.x + dx), y: round(q.y + dy), w: q.w, d: q.d };
    return mirror ? { ...s, x: round(env.x + env.w - (s.x - env.x) - s.w) } : s;
  };
  const blocks: Block[] = []; const placed: EnginePlaced[] = [];
  // A roof terrace needs the bedroom block right behind a single-storey living wing.
  const terrace = idea.upper === 'terrace' && two && zones.length === 1 && Math.abs(zones[0]!.y0 - Dp) < 0.01 && zones[0]!.o === 'down';
  if (idea.upper === 'terrace' && !terrace) return null;
  placedZones.forEach((p, i) => {
    const b = mx(p.rect);
    const id = `b${i + 1}`;
    blocks.push({ id, name: p.name, kind: 'house', storeys: p.storeys, ...b, ridge: b.w >= b.d ? 'x' : 'y' });
    for (const q of p.rooms) {
      // Sky terrace: the upstairs rooms on the living wing's side open onto the terrace through full-height glass.
      const ontoTerrace = terrace && i > 0 && q.z.storey === 1 && Math.abs(q.rect.y - mainRect.d) < 0.01 && q.rect.x < mainRect.x + mainRect.w - 0.5 && q.rect.x + q.rect.w > mainRect.x + 0.5 && q.z.kind !== 'corridor' && q.z.kind !== 'stair';
      placed.push({ kind: q.z.kind, name: q.z.name, storey: q.z.storey, block: id, ...mx(q.rect), ...(ontoTerrace ? { glazing: 'full-height' as const } : {}) });
    }
  });
  links.forEach((l, i) => {
    const b = mx(l.rect); const id = `l${i + 1}`;
    blocks.push({ id, name: l.name, kind: 'house', storeys: 1, ...b, ridge: b.w >= b.d ? 'x' : 'y' });
    placed.push({ kind: 'corridor', name: l.name, storey: 0, block: id, ...b });
  });
  const d = finish(plot, brief, cfg, site, { key: `free-${seed}-${idea.key}`, name: idea.title, blurb: idea.story, typology: 'hub' }, blocks, placed);
  if (terrace) {
    // The terrace itself: a railed deck on the living wing's flat roof, set in from its edges.
    const t = mx({ x: mainRect.x + 0.15, y: 0.15, w: mainRect.w - 0.3, d: mainRect.d - 0.15 });
    d.elements = [...d.elements, { id: 'roof-terrace', kind: 'balcony', storey: 1, ...t, label: 'Roof terrace', material: d.finishes[0]?.accent ?? 'timber' }];
  }
  // The idea is the design's concept: its name, its story and its moves; the palette follows the style.
  d.concept = { designId: d.id, title: idea.title, story: idea.story, moves: idea.moves, palette: conceptFor(d).palette, source: 'engine' };
  void PARTI_NAMES;
  return d;
}

/**
 * Up to `count` new concepts for a brief from one run, every one passing every check, best first. Different seeds give
 * different houses; a run never returns two near-identical ones (same plan signature).
 */
export function freeDesigns(plot: Plot, briefIn: Partial<DesignBrief>, opts: { seed: number; tries?: number; count?: number; cfg?: DesignConfig } & FreeOptions): Design[] {
  const cfg = opts.cfg ?? DEFAULT_DESIGN_CONFIG;
  const out: Design[] = []; const seen = new Set<string>(); const perIdea = new Map<string, number>();
  const tries = opts.tries ?? 60; const count = opts.count ?? 12;
  for (let k = 0; k < tries && out.length < count; k++) {
    const d = freeDesign(plot, briefIn, attemptSeed(opts.seed, k), cfg, opts);
    if (!d || d.checks.some((c) => c.status === 'fail') || !wellPlanned(d)) continue;
    const sig = d.blocks.map((b) => `${Math.round(b.x)}:${Math.round(b.y)}:${Math.round(b.w)}:${Math.round(b.d)}`).sort().join('|');
    if (seen.has(sig)) continue;
    // Variety: at most two houses from one idea in a run, so the ideas that fit most easily do not crowd out the rest.
    const idea = d.concept?.title ?? d.name;
    if ((perIdea.get(idea) ?? 0) >= 2) continue;
    perIdea.set(idea, (perIdea.get(idea) ?? 0) + 1);
    seen.add(sig); out.push(d);
  }
  return out.sort((a, b) => b.review.score - a.review.score);
}

/** The standard an AI layout is held to: no toilet beside food, no clash such as a kitchen against a bedroom. */
export function wellPlanned(d: Design): boolean {
  return !d.checks.some((c) => c.code === 'hygiene' && c.status !== 'pass') && !planningAnalysis(d.rooms).bad.some((x) => x.score <= -2);
}

/** Any design by its id: a free design is rebuilt from the seed in its id, an engine design found among the candidates. */
export function findDesign(plot: Plot, briefIn: Partial<DesignBrief>, id: string, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): Design | null {
  // free-<seed>-<idea>-<storeys>s-<bedrooms>b…: the seed and the idea rebuild the very same house.
  const m = /^free-(\d+)-(.+?)-\d+s-\d+b/.exec(id);
  if (m) { const d = freeDesign(plot, briefIn, Number(m[1]), cfg, { idea: m[2] }); return d && d.id === id ? d : null; }
  return candidateDesigns(plot, briefIn, cfg).find((d) => d.id === id) ?? null;
}
