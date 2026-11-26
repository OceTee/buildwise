/**
 * Concept options: from every design the engine can make for a plot and brief, up to three that are genuinely
 * different in plan or massing, each with a measured reason to choose it.
 *
 *  - `conceptMetrics` measures a design the way a homeowner compares options: how much of the plot it covers, the
 *    outdoor rooms, circulation, how private the bedrooms are, how strong the arrival is, room to host.
 *  - `massingDistance` and `planDistance` compare two designs by geometry alone (names, colours and finishes do not
 *    count, and a mirror image is the same design), so a set is never padded with palette swaps.
 *  - `conceptSet` ranks by the engine's own review plus the person's taste and priorities, then keeps options that
 *    differ. If fewer than three differ, it returns those and says why.
 *  - `shapedBy` explains how the person's choices show up in the chosen design, only where the design really has them.
 *  - `reviseBrief` is the revision planner: it shrinks the plot or the building while keeping what the person asked
 *    to protect, and lists what changed.
 *
 * Everything is deterministic and uses the same generator and checks as the rest of the engine.
 */
import { planningAnalysis } from './adjacency';
import { BUILDING_TYPES, FEATURES, isHouse, type FeatureKey } from './building';
import { DEFAULT_DESIGN_CONFIG, candidateDesigns, conceptFor, generateDesigns, normaliseBrief, type Design, type DesignBrief, type DesignConcept, type DesignConfig, type Plot, type Room, type RoomKind } from './design';
import { PRIORITIES, TASTES, type BriefRevision, type Preferences, type Priority } from './preferences';
import { findDesign, freeDesigns } from './solver';
import type { IdeaPriors } from './ideas';

// ---------------------------------------------------------------- measuring a design

export type MassingForm = 'compact' | 'forward' | 'L' | 'T' | 'pavilion' | 'side' | 'wings' | 'block';

export interface ConceptMetrics {
  footprintM2: number; grossFloorM2: number; coveragePct: number;
  /** Ground left open on the plot (m² and share). */
  openM2: number; openPct: number;
  /** Open ground behind the building (m²): the garden. */
  gardenM2: number;
  /** Verandas, pergolas, porches, loggias and balconies (m²). */
  outdoorRoomM2: number;
  /** Halls, landings and stairs as a share of the floor. */
  circulationPct: number;
  /** Living, dining and lounge area on the ground floor (m²). */
  livingM2: number;
  /** 0–100: bedrooms away from the street, in their own wing, with the outdoor room behind the house. */
  privacy: number;
  /** Bedrooms in all, and how many sit behind the front rooms. */
  beds: number; bedsAway: number;
  /** 0–100: a recessed or projecting entrance, a porch or canopy, a wing beside the door, a proper hall. */
  arrival: number;
  /** Shared walls that work (kitchen by dining…) and ones that clash. */
  relations: { works: number; conflicts: number; score: number };
  blocks: number;
  form: MassingForm;
}

const PUBLIC: ReadonlySet<RoomKind> = new Set(['living', 'living-kitchen', 'dining', 'lounge']);
const CIRC: ReadonlySet<RoomKind> = new Set(['corridor', 'stair', 'lift']);
const r1 = (n: number) => Math.round(n * 10) / 10;
const area = (r: { w: number; d: number }) => r.w * r.d;

export function massingForm(d: Design): MassingForm {
  const house = d.blocks.filter((b) => b.kind === 'house');
  if (!isHouse(d.brief.type)) return 'block';
  if (house.length <= 1) {
    // One block along one boundary with the rest of the width left open is a side-garden house.
    const b = house[0]!;
    return b && d.storeys > 1 && b.d >= b.w * 1.05 && d.envelope.w - b.w >= 3 ? 'side' : 'compact';
  }
  const tall = Math.max(...house.map((b) => b.storeys));
  if (house.some((b) => b.storeys < tall)) return 'pavilion';
  // A wing that stands wholly behind the rest: past both sides of what is in front is a T, past one an L.
  const back = house.find((b) => house.every((o) => o === b || o.y + o.d <= b.y + 1e-3));
  if (back) {
    const front = house.filter((b) => b !== back);
    const x0 = Math.min(...front.map((b) => b.x)); const x1 = Math.max(...front.map((b) => b.x + b.w));
    const left = x0 - back.x >= 0.6; const right = back.x + back.w - x1 >= 0.6;
    if (left && right) return 'T';
    if (left || right) return 'L';
  }
  const frontY = Math.min(...house.map((b) => b.y));
  return house.some((b) => b.y - frontY >= 1) ? 'forward' : 'wings';
}

export function conceptMetrics(d: Design): ConceptMetrics {
  const plotM2 = d.plot.widthM * d.plot.depthM;
  const built = d.blocks.reduce((s, b) => s + area(b), 0);
  const house = d.blocks.filter((b) => b.kind === 'house');
  const rear = Math.max(...house.map((b) => b.y + b.d));
  const frontY = Math.min(...house.map((b) => b.y));
  const depth = Math.max(1, rear - frontY);
  const out = d.blocks.filter((b) => b.kind === 'outbuilding').reduce((s, b) => s + area(b), 0);
  const floor = d.rooms.reduce((s, r) => s + area(r), 0);
  const circ = d.rooms.filter((r) => CIRC.has(r.kind)).reduce((s, r) => s + area(r), 0);
  const ground = d.rooms.filter((r) => r.storey === 0 && house.some((b) => b.id === r.block));
  const beds = d.rooms.filter((r) => r.kind === 'bedroom' || r.kind === 'master');
  const outdoor = d.elements.filter((e) => ['veranda', 'pergola', 'porch', 'balcony'].includes(e.kind));
  const outdoorRear = outdoor.filter((e) => e.storey === 0 && e.y + e.d / 2 > frontY + depth * 0.6);
  // Privacy: bedrooms set back from the street front, far down the plot, in a wing of their own.
  const away = beds.length ? beds.filter((r) => r.y >= frontY + 3).length / beds.length : 0;
  const deep = beds.length ? beds.reduce((s, r) => s + (r.y + r.d / 2 - frontY) / depth, 0) / beds.length : 0;
  const wing = house.some((b) => /bedroom wing/i.test(b.name)) ? 1 : 0;
  const privacy = Math.round(100 * Math.min(1, 0.45 * away + 0.3 * deep + 0.15 * wing + 0.1 * (outdoorRear.length ? 1 : 0)));
  // Arrival: where the front door sits against the building's front, and what frames it.
  const door = d.openings.find((o) => o.storey === 0 && o.kind === 'door' && o.external && /front door|main entrance/i.test(o.label));
  const recess = door && door.dir === 'h' ? door.at - frontY : 0;
  const hall = door ? d.rooms.find((r) => r.id === door.roomId) : undefined;
  const forward = house.length > 1 && house.some((b) => Math.abs(b.y - frontY) < 1e-6) && house.some((b) => b.y - frontY >= 1);
  const arrival = Math.min(100, Math.round(
    (recess >= 1 ? 30 : 0) + (forward ? 25 : 0) + (d.elements.some((e) => e.kind === 'porch') ? 20 : d.elements.some((e) => e.kind === 'canopy') ? 12 : 0)
    + (d.elements.some((e) => e.kind === 'feature-wall') ? 10 : 0) + (hall && area(hall) >= 8 ? 15 : hall && area(hall) >= 4 ? 8 : 0)));
  const rel = planningAnalysis(d.rooms);
  return {
    footprintM2: r1(d.metrics.footprintM2), grossFloorM2: r1(d.metrics.grossFloorM2), coveragePct: d.metrics.coveragePct,
    openM2: r1(plotM2 - built), openPct: Math.round(((plotM2 - built) / plotM2) * 100),
    gardenM2: r1(Math.max(0, (d.plot.depthM - rear) * d.plot.widthM - out)),
    outdoorRoomM2: r1(outdoor.reduce((s, e) => s + area(e), 0)),
    circulationPct: floor ? Math.round((circ / floor) * 100) : 0,
    livingM2: r1(ground.filter((r) => PUBLIC.has(r.kind)).reduce((s, r) => s + area(r), 0)),
    privacy, arrival, beds: beds.length, bedsAway: beds.filter((r) => r.y >= frontY + 3).length,
    relations: { works: rel.good.length, conflicts: rel.bad.length, score: rel.score },
    blocks: house.length,
    form: massingForm(d),
  };
}

// ---------------------------------------------------------------- telling two designs apart

const CELL = 0.5;
type Grid = { nx: number; ny: number; v: Uint8Array };

/** Zone of a room for comparing plans: 1 living, 2 bedrooms, 3 kitchen and stores, 4 wet rooms, 5 halls and stairs. */
const zoneOf = (k: RoomKind): number => (PUBLIC.has(k) ? 1 : k === 'bedroom' || k === 'master' || k === 'study' ? 2 : CIRC.has(k) ? 5
  : k === 'bathroom' || k === 'ensuite' || k === 'wc' || k === 'toilets' ? 4 : k === 'kitchen' || k === 'store' || k === 'laundry' ? 3 : 6);

function raster(plot: Plot, rects: { x: number; y: number; w: number; d: number; value: number }[], mirror: boolean): Grid {
  const nx = Math.ceil(plot.widthM / CELL); const ny = Math.ceil(plot.depthM / CELL);
  const v = new Uint8Array(nx * ny);
  for (const r of rects) {
    const x = mirror ? plot.widthM - r.x - r.w : r.x;
    const i0 = Math.max(0, Math.round(x / CELL)); const i1 = Math.min(nx, Math.round((x + r.w) / CELL));
    const j0 = Math.max(0, Math.round(r.y / CELL)); const j1 = Math.min(ny, Math.round((r.y + r.d) / CELL));
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) v[j * nx + i] = Math.max(v[j * nx + i]!, r.value);
  }
  return { nx, ny, v };
}
/** Share of the cells either design occupies where the two differ. */
function differ(a: Grid, b: Grid): number {
  let either = 0, diff = 0;
  for (let k = 0; k < a.v.length; k++) { if (a.v[k] || b.v[k]) { either++; if (a.v[k] !== b.v[k]) diff++; } }
  return either ? diff / either : 0;
}
const massRects = (d: Design) => d.blocks.filter((b) => b.kind === 'house').map((b) => ({ ...b, value: b.storeys }));
const planRects = (d: Design) => d.rooms.filter((r) => r.storey === 0).map((r: Room) => ({ ...r, value: zoneOf(r.kind) }));

/** 0–1: how different two designs' volumes are on the plot (storeys per cell); a mirror image scores 0. */
export function massingDistance(a: Design, b: Design): number {
  const g = raster(a.plot, massRects(a), false);
  return Math.min(differ(g, raster(a.plot, massRects(b), false)), differ(g, raster(a.plot, massRects(b), true)));
}
/** 0–1: how different two ground-floor plans are (which kind of room stands where); a mirror image scores 0. */
export function planDistance(a: Design, b: Design): number {
  const g = raster(a.plot, planRects(a), false);
  return Math.min(differ(g, raster(a.plot, planRects(b), false)), differ(g, raster(a.plot, planRects(b), true)));
}
export const DISTINCT = { massing: 0.14, plan: 0.4 };
/** Two designs a person could tell apart with names and finishes hidden. */
export function distinctDesigns(a: Design, b: Design): boolean {
  return massingDistance(a, b) >= DISTINCT.massing || planDistance(a, b) >= DISTINCT.plan;
}

// ---------------------------------------------------------------- the set of options

export interface ConceptOption {
  design: Design;
  /** A name for the direction, from its form (an AI design keeps its own concept title). */
  title: string;
  /** The reason to choose it, against the other options: measured, never decorative. */
  tag: string;
  reason: string;
  /** What it gives up against the others. */
  tradeoff: string;
  /** Three or four facts about the plan. */
  points: string[];
  metrics: ConceptMetrics;
}
export interface ConceptSet { options: ConceptOption[]; /** Why there are fewer than three, when there are. */ note: string | null; considered: number }

const FORM_TITLE: Record<MassingForm, string> = { compact: 'Compact House', forward: 'Forecourt House', L: 'Garden Wing House', T: 'Three-Wing House', pavilion: 'Pavilion House', side: 'Side Garden House', wings: 'Wing House', block: '' };

const FREE_TITLE: Record<string, string> = {
  'Sleeping wing behind': 'Garden Hall House', 'Offset bedroom wing': 'Garden L House', 'Two pavilions': 'Twin Pavilion House',
  'Side bedroom wing': 'Long Frontage House', 'Split bedroom wings': 'Split Wing House',
};
function titleOf(d: Design, form: MassingForm): string {
  // A title an AI gave (the designer's layout, or the architect's review of an engine design) is the design's name.
  if (d.concept?.title) return d.concept.title;
  if (d.typology === 'ai') return d.name;
  // Non-house buildings are named by type and plan ("Hotel: deep plan"), never as houses.
  if (form === 'block') return `${BUILDING_TYPES[d.brief.type].label}: ${d.name.charAt(0).toLowerCase()}${d.name.slice(1)}`;
  if (d.id.startsWith('hub-hosting-') || d.id.startsWith('hub-entry-court-')) return d.name;
  // The solver's concepts are named for how they are composed, not for the engine's families.
  if (d.id.startsWith('free-')) return FREE_TITLE[d.name] ?? d.name;
  if (/narrow/i.test(d.name) && form !== 'side') return 'Town House';
  return FORM_TITLE[form] || d.name;
}

/**
 * The one name a design goes by: on its concept card, as the person's choice in the project record, on the design
 * page and on the drawings. An AI title wins; otherwise the name of its form ("Town House", "Entry Court House").
 */
export function conceptTitle(d: Design): string {
  return titleOf(d, conceptMetrics(d).form);
}

/** The concept shown for a design: the AI's when there is one, else the engine's story under the design's own name. */
export function designConcept(d: Design): DesignConcept {
  return d.concept ?? { ...conceptFor(d), title: conceptTitle(d) };
}

type Measure = { key: string; tag: string; value: (m: ConceptMetrics) => number; win: (m: ConceptMetrics, others: ConceptMetrics[]) => string; lose: (m: ConceptMetrics, best: ConceptMetrics) => string };
const most = (xs: number[]) => Math.max(...xs);
const MEASURES: Measure[] = [
  { key: 'outdoor', tag: 'More outdoor living', value: (m) => m.outdoorRoomM2,
    win: (m) => `${m.outdoorRoomM2} m² of covered outdoor room: terraces, verandas and balconies you can sit out on in the rain.`,
    lose: (m, b) => `Less covered outdoor room (${m.outdoorRoomM2} m² against ${b.outdoorRoomM2} m²).` },
  { key: 'privacy', tag: 'More privacy', value: (m) => m.privacy,
    win: (m) => `${m.bedsAway} of the ${m.beds} bedrooms sit behind the front rooms, away from the street${m.form === 'L' || m.form === 'T' ? ', in a wing of their own' : ''}.`,
    lose: () => 'Bedrooms are closer to the street than in the other options.' },
  { key: 'open', tag: 'More room on the plot', value: (m) => m.openM2,
    win: (m, o) => { const more = o.length ? Math.round(m.openM2 - most(o.map((x) => x.openM2))) : 0; return `The smallest footprint: ${m.openPct}% of the plot (${Math.round(m.openM2)} m²) stays open${more >= 1 ? `, about ${more} m² more than the next` : ''}, for a garden, a pool or a later extension.`; },
    lose: (m, b) => `Covers more of the plot (${m.coveragePct}% against ${b.coveragePct}%).` },
  { key: 'arrival', tag: 'A stronger arrival', value: (m) => m.arrival,
    win: () => 'The strongest entrance of the options: set in a recess or beside a projecting wing, under a porch or canopy, not at a flat wall.',
    lose: () => 'A plainer front than the other options.' },
  { key: 'cost', tag: 'Lower cost', value: (m) => -m.grossFloorM2,
    win: (m, o) => { const less = o.length ? Math.round(Math.min(...o.map((x) => x.grossFloorM2)) - m.grossFloorM2) : 0; return `The least floor to build: ${Math.round(m.grossFloorM2)} m²${less >= 1 ? `, ${less} m² less than the next` : ''}.`; },
    lose: (m, b) => `More floor to build (${Math.round(m.grossFloorM2)} m² against ${Math.round(b.grossFloorM2)} m²), so it costs more.` },
  { key: 'host', tag: 'More room to host', value: (m) => m.livingM2,
    win: (m) => `${Math.round(m.livingM2)} m² of living and dining on the ground floor.`,
    lose: (m, b) => `Smaller living and dining rooms (${Math.round(m.livingM2)} m² against ${Math.round(b.livingM2)} m²).` },
  { key: 'hall', tag: 'Less hallway', value: (m) => -m.circulationPct,
    win: (m) => `Only ${m.circulationPct}% of the floor is hall, landing and stair.`,
    lose: (m, b) => `More of the floor goes to halls and stairs (${m.circulationPct}% against ${b.circulationPct}%).` },
];

/** How well a design suits the person's taste and priorities, on top of the engine's own review score. */
export function preferenceFit(m: ConceptMetrics, all: ConceptMetrics[], prefs: Pick<Preferences, 'taste' | 'priorities' | 'purpose'>): number {
  const norm = (f: (x: ConceptMetrics) => number) => { const xs = all.map(f); const lo = Math.min(...xs); const hi = Math.max(...xs); return hi - lo < 1e-6 ? 0.5 : (f(m) - lo) / (hi - lo); };
  let s = 0;
  if (prefs.priorities.includes('garden')) s += 14 * norm((x) => x.gardenM2) + 6 * norm((x) => x.openM2);
  if (prefs.priorities.includes('privacy')) s += 20 * (m.privacy / 100);
  if (prefs.priorities.includes('host')) s += 15 * norm((x) => x.livingM2) + 5 * norm((x) => x.outdoorRoomM2);
  // Taste never rewards floor area: grand is arrival and living space, simple and rental are economy.
  if (prefs.taste === 'grand') s += 14 * (m.arrival / 100) + 6 * norm((x) => x.livingM2 / Math.max(1, x.grossFloorM2));
  if (prefs.taste === 'modern') s += 8 * (m.arrival / 100);
  if (prefs.taste === 'tropical') s += 10 * norm((x) => x.outdoorRoomM2) + 4 * norm((x) => x.openM2);
  if (prefs.taste === 'simple') s += 10 * norm((x) => -x.grossFloorM2);
  if (prefs.purpose === 'tenants') s += 8 * norm((x) => -x.grossFloorM2) + 4 * norm((x) => -x.circulationPct);
  return s;
}

function pointsOf(d: Design, m: ConceptMetrics): string[] {
  const out: string[] = [];
  const house = isHouse(d.brief.type);
  // The solver's own concepts say their idea in their own words (their massing can read like an engine form's).
  const free = d.id.startsWith('free-');
  if (d.id.startsWith('hub-entry-court-') || free) out.push(d.blurb);
  else if (m.form === 'compact') out.push('One compact block: the simplest to build and roof.');
  if (!free && m.form === 'side') out.push('One deep block along one boundary: the whole other side of the plot is garden, and every room looks onto it.');
  if (!free && m.form === 'forward') out.push('The living room steps forward as its own wing, and you arrive in the recess beside it.');
  if (!free && m.form === 'L') out.push('A bedroom wing runs out into the garden, making an L round a side terrace.');
  if (!free && m.form === 'T') out.push('The living room steps forward and the back wing runs past both sides: three volumes, not one box.');
  if (!free && m.form === 'pavilion') out.push('The living room is its own single-storey pavilion in front of the taller house.');
  if (!free && (m.form === 'block' || m.form === 'wings')) out.push(d.blurb.split('. ')[0]!.replace(/\.$/, '') + '.');
  const terrace = d.elements.find((e) => ['veranda', 'pergola'].includes(e.kind) && e.storey === 0);
  if (terrace) out.push(`${terrace.label ?? 'Garden terrace'}: ${r1(terrace.w)} × ${r1(terrace.d)} m of shaded outdoor room.`);
  if (d.elements.some((e) => e.label === 'Loggia')) out.push('A covered loggia upstairs, in front of a bedroom.');
  if (house) {
    const suites = d.rooms.filter((r) => r.kind === 'ensuite').length; const beds = d.rooms.filter((r) => r.kind === 'bedroom' || r.kind === 'master').length;
    if (beds) out.push(suites >= beds ? `All ${beds} bedrooms have their own bathroom.` : `${beds} bedrooms, ${suites} with their own bathroom.`);
  }
  out.push(`${m.openPct}% of the plot stays open; ${m.circulationPct}% of the floor is hall and stair.`);
  return out.slice(0, 4);
}

export interface ConceptSetOptions {
  max?: number; cfg?: DesignConfig;
  /** Designs to consider first (an AI designer's, already checked). */ extra?: Design[];
  /** New concepts from the free-form solver for this seed: a different seed, different houses. */ seed?: number;
  /** Designs already shown (by id): nothing too close to any of them is offered again. */ avoidIds?: string[];
  /** Learned nudges per idea (see `IdeaPriors`). */ priors?: IdeaPriors;
}

/**
 * Up to three checked concepts for one plot, brief and set of choices, best fit first, every pair distinct in plan or
 * massing. Fewer when the plot or brief allows fewer: the note says so.
 */
export function conceptSet(plot: Plot, briefIn: Partial<DesignBrief>, prefs: Pick<Preferences, 'taste' | 'priorities' | 'purpose'>, opts: ConceptSetOptions = {}): ConceptSet {
  const cfg = opts.cfg ?? DEFAULT_DESIGN_CONFIG; const max = opts.max ?? 3;
  const exact = candidateDesigns(plot, briefIn, cfg);
  const matching = exact.filter((d) => !d.id.startsWith('hub-hosting-') || prefs.priorities.includes('host'));
  const engine = matching.length ? matching : generateDesigns(plot, briefIn, cfg).designs;
  // Fresh concepts from the solver join the engine's own; anything too close to what was already shown is left out.
  const fresh = opts.seed !== undefined ? freeDesigns(plot, briefIn, { seed: opts.seed, cfg, tries: 200, count: 10, prefs, priors: opts.priors }) : [];
  const avoid = (opts.avoidIds ?? []).map((id) => findDesign(plot, briefIn, id, cfg)).filter((d): d is Design => !!d);
  const novel = (d: Design) => !avoid.some((a) => a.id === d.id || !distinctDesigns(a, d));
  const passing = [...(opts.extra ?? []), ...fresh, ...engine].filter((d) => d.checks.every((c) => c.status !== 'fail'));
  const unseen = passing.filter(novel);
  // When everything left is something already shown, show the freshest anyway rather than nothing.
  const pool = unseen.length ? unseen : passing;
  const seen = new Set<string>();
  const designs = pool.filter((d) => (seen.has(d.id) ? false : (seen.add(d.id), true)));
  if (!designs.length) return { options: [], note: generateDesigns(plot, briefIn, cfg).notes[0] ?? 'Nothing fits this plot with this brief.', considered: 0 };
  const metrics = new Map(designs.map((d) => [d.id, conceptMetrics(d)]));
  const all = [...metrics.values()];
  // An AI designer's own designs lead; the rest follow by review score plus fit to the person's choices.
  const preferenceScores = new Map(designs.map((d) => [d.id, preferenceFit(metrics.get(d.id)!, all, prefs)]));
  // Asked for new ideas, the solver's concepts lead the engine's familiar families.
  const freshness = (d: Design) => (fresh.includes(d) ? 6 : 0);
  const fit = (d: Design) => d.review.score + 2 * preferenceScores.get(d.id)! + freshness(d) + (opts.extra?.includes(d) ? 1000 : 0);
  const courtRequested = prefs.taste === 'tropical' || prefs.priorities.includes('privacy') || prefs.priorities.includes('garden');
  const ranked = [...designs].sort((a, b) => fit(b) - fit(a));
  // The largest set whose every pair differs; among those, the best fit that is also the most varied. (A greedy pick
  // can keep a near-twin of its first choice and lose the option that differs most.)
  const top = ranked.slice(0, 8);
  const dist = top.map((a) => top.map((b) => (a === b ? 1 : Math.max(massingDistance(a, b), planDistance(a, b) * (DISTINCT.massing / DISTINCT.plan)))));
  const ok = top.map((a, i) => top.map((b, j) => i === j || distinctDesigns(a, b)));
  let best: { idx: number[]; score: number } = { idx: top.length ? [0] : [], score: -Infinity };
  const consider = (idx: number[]) => {
    let min = 1;
    for (let p = 0; p < idx.length; p++) for (let q = p + 1; q < idx.length; q++) { if (!ok[idx[p]!]![idx[q]!]) return; min = Math.min(min, dist[idx[p]!]![idx[q]!]!); }
    const bestMatch = Math.max(...idx.map((k) => preferenceScores.get(top[k]!.id)!));
    const court = courtRequested && idx.some((k) => top[k]!.id.startsWith('hub-entry-court-')) ? 18 : 0;
    // Three ideas, not one idea three times: two concepts of the same composition cost the set.
    let same = 0;
    for (let p = 0; p < idx.length; p++) for (let q = p + 1; q < idx.length; q++) if (titleOf(top[idx[p]!]!, metrics.get(top[idx[p]!]!.id)!.form) === titleOf(top[idx[q]!]!, metrics.get(top[idx[q]!]!.id)!.form)) same++;
    const score = idx.length * 1000 - same * 400 + idx.reduce((t, k) => t + fit(top[k]!), 0) / idx.length + bestMatch + court + (idx.length > 1 ? 60 * min : 0);
    if (score > best.score) best = { idx, score };
  };
  for (let a = 0; a < top.length; a++) {
    consider([a]);
    for (let b = a + 1; b < top.length && max >= 2; b++) {
      consider([a, b]);
      for (let c = b + 1; c < top.length && max >= 3; c++) consider([a, b, c]);
    }
  }
  const chosen: Design[] = best.idx.map((k) => top[k]!);
  const ms = chosen.map((d) => metrics.get(d.id)!);
  // Each option gets the measure it leads the others on by the widest margin; no two share one.
  const pairs: { i: number; k: Measure; adv: number }[] = [];
  chosen.forEach((_, i) => {
    for (const k of MEASURES) {
      const vs = ms.map(k.value); const range = Math.max(...vs) - Math.min(...vs);
      if (range < 1e-6 || chosen.length < 2) continue;
      const others = vs.filter((_, j) => j !== i);
      const boost = prefs.priorities.includes(k.key === 'open' ? 'garden' : (k.key as Priority)) ? 0.15 : 0;
      pairs.push({ i, k, adv: (vs[i]! - Math.max(...others)) / range + boost });
    }
  });
  const tagOf = new Map<number, Measure>(); const used = new Set<string>();
  for (const p of pairs.sort((a, b) => b.adv - a.adv)) {
    if (p.adv <= 0 || tagOf.has(p.i) || used.has(p.k.key)) continue;
    tagOf.set(p.i, p.k); used.add(p.k.key);
  }
  const options = chosen.map((d, i): ConceptOption => {
    const m = ms[i]!; const others = ms.filter((_, j) => j !== i);
    const k = tagOf.get(i);
    // The trade-off: the measure where this option trails the best of the others by most.
    let worst: { k: Measure; gap: number; best: ConceptMetrics } | null = null;
    for (const q of MEASURES) {
      if (!others.length) break;
      const vs = ms.map(q.value); const range = Math.max(...vs) - Math.min(...vs);
      if (range < 1e-6) continue;
      const best = [...others].sort((a, b) => q.value(b) - q.value(a))[0]!;
      const gap = (q.value(best) - q.value(m)) / range;
      if (gap > 0 && (!worst || gap > worst.gap)) worst = { k: q, gap, best };
    }
    return {
      design: d, metrics: m, title: titleOf(d, m.form),
      tag: k ? k.tag : chosen.length > 1 ? 'The balanced plan' : 'Fits your plot',
      reason: k ? k.win(m, others) : chosen.length > 1 ? 'Sits between the other options on every measure: no strong trade-off either way.' : d.blurb,
      tradeoff: worst ? worst.k.lose(m, worst.best) : '',
      points: pointsOf(d, m),
    };
  });
  // Two options never share a name: a second one of the same form carries the engine's name for it.
  options.forEach((o, i) => {
    if (options.findIndex((x) => x.title === o.title) >= i) return;
    const alt = `${o.title} (${o.design.name.toLowerCase()})`;
    o.title = options.some((x) => x.title === alt) || o.design.name === options.find((x) => x.title === o.title)?.design.name
      ? `${o.title}, ${Math.round(o.design.metrics.grossFloorM2)} m²` : alt;
  });
  let note: string | null = null;
  if (options.length < max) {
    const n = options.length;
    note = designs.length <= n
      ? `Only ${n === 1 ? 'one layout passes' : `${n} layouts pass`} every check on this ${r1(plot.widthM)} × ${r1(plot.depthM)} m plot with this brief. A wider plot, fewer rooms or another storey would open up more.`
      : `${designs.length} layouts pass every check here, but only ${n === 1 ? 'one is' : `${n} are`} different enough to be a real choice; the rest are variations of ${n === 1 ? 'it' : 'these'}.`;
  }
  return { options, note, considered: designs.length };
}

// ---------------------------------------------------------------- how the person's choices shaped a design

export interface Shaped { choice: string; effect: string }

/** Two or three of the person's choices and what each one did in this design (only effects the design really has). */
export function shapedBy(d: Design, prefs: Preferences, m: ConceptMetrics = conceptMetrics(d)): Shaped[] {
  const out: Shaped[] = [];
  const count = (kind: string, label?: string) => d.elements.filter((e) => e.kind === kind && (!label || e.label === label)).length;
  if (prefs.taste) {
    const t = TASTES[prefs.taste]; const bits: string[] = [];
    const roof = d.roof.kind === 'hidden' ? 'a roof hidden behind a parapet' : d.roof.kind === 'flat' ? 'a flat roof' : `a ${d.roof.kind} roof with ${d.roof.overhangM >= 0.6 ? 'deep' : 'modest'} eaves`;
    bits.push(roof);
    if (count('veranda')) bits.push(`${count('veranda') > 1 ? `${count('veranda')} verandas` : 'a veranda'}`);
    else if (count('pergola')) bits.push('a pergola terrace');
    if (count('screen') > 1) bits.push(`${count('screen')} louvre screens`);
    if (count('porch')) bits.push('an entrance porch on columns'); else if (count('canopy')) bits.push('a crisp entrance canopy');
    if (count('feature-wall')) bits.push('a stone feature wall by the door');
    const tall = d.rooms.filter((r) => r.glazing === 'full-height').length;
    if (tall) bits.push(`floor-to-ceiling glass in ${tall} room${tall > 1 ? 's' : ''}`);
    out.push({ choice: `${prefs.tasteChosenForMe ? 'BuildWise chose' : 'You chose'} ${t.label}`, effect: `${bits.slice(0, 4).join(', ')}.`.replace(/^./, (c) => c.toUpperCase()) });
  }
  for (const p of prefs.priorities) {
    if (p === 'garden') out.push({ choice: `You asked for a ${PRIORITIES.garden.label.toLowerCase()}`, effect: `${m.openPct}% of your plot (${Math.round(m.openM2)} m²) stays open, ${Math.round(m.gardenM2)} m² of it behind the house.` });
    if (p === 'privacy') {
      const beds = d.rooms.filter((r) => r.kind === 'bedroom' || r.kind === 'master');
      const front = Math.min(...d.blocks.filter((b) => b.kind === 'house').map((b) => b.y));
      const away = beds.filter((r) => r.y >= front + 3).length;
      out.push({ choice: 'You asked for more privacy', effect: `${away} of ${beds.length} bedrooms sit behind the front rooms, away from the street${m.form === 'L' || m.form === 'T' ? ', in their own wing' : ''}.` });
    }
    if (p === 'host') out.push({ choice: 'You wanted room to host', effect: `Living and dining together are ${Math.round(m.livingM2)} m²${m.outdoorRoomM2 ? `, opening to ${m.outdoorRoomM2} m² of covered terrace` : ''}.` });
  }
  if (prefs.purpose && out.length < 3) {
    const beds = d.rooms.filter((r) => r.kind === 'bedroom' || r.kind === 'master').length; const suites = d.rooms.filter((r) => r.kind === 'ensuite').length;
    if (prefs.purpose === 'family' && beds) out.push({ choice: 'A home for your family', effect: `${suites >= beds ? `Every one of the ${beds} bedrooms has its own bathroom` : `${beds} bedrooms, ${suites} ensuite`}${d.rooms.some((r) => r.kind === 'lounge' && r.storey > 0) ? ', with a family lounge upstairs' : ''}.` });
    if (prefs.purpose === 'tenants' || prefs.purpose === 'both') out.push({ choice: prefs.purpose === 'both' ? 'For your family and tenants' : 'A building for tenants', effect: `${Math.round(m.grossFloorM2)} m² of floor with ${m.circulationPct}% in halls and stairs, so most of what you build is lettable.` });
    if (prefs.purpose === 'own' || prefs.purpose === 'community') out.push({ choice: prefs.purpose === 'own' ? 'For your own use' : 'For a community', effect: `${BUILDING_TYPES[d.brief.type].label} on ${d.storeys} floor${d.storeys > 1 ? 's' : ''}, ${Math.round(m.grossFloorM2)} m², with ${m.openPct}% of the plot left open.` });
  }
  if (out.length < 2) out.push({ choice: `Your ${r1(d.plot.widthM)} × ${r1(d.plot.depthM)} m plot`, effect: `The building covers ${m.coveragePct}% of it and sits ${r1(Math.min(...d.blocks.filter((b) => b.kind === 'house').map((b) => b.y)))} m back from the street${d.parking.length ? `, with parking for ${d.parking.length}` : ''}.` });
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- revisions: smaller, but keep what matters

/** Plot sizes people know, largest first (metres). */
export const COMMON_PLOTS: { label: string; plot: Plot }[] = [
  { label: '100 × 100 ft', plot: { widthM: 30.48, depthM: 30.48 } },
  { label: '60 × 120 ft', plot: { widthM: 18.29, depthM: 36.58 } },
  { label: '50 × 100 ft', plot: { widthM: 15.24, depthM: 30.48 } },
  { label: '40 × 80 ft', plot: { widthM: 12.19, depthM: 24.38 } },
  { label: '50 × 50 ft', plot: { widthM: 15.24, depthM: 15.24 } },
  { label: '30 × 60 ft', plot: { widthM: 9.14, depthM: 18.29 } },
];

export interface RevisedBrief {
  fits: boolean;
  plot: Plot; brief: DesignBrief;
  /** What had to change to make it fit, in plain words (empty when it fits as it is). */
  changes: string[];
  /** What was asked to be kept, and is. */
  kept: string[];
  designs: Design[];
  note: string;
}

type Step = { label: string; apply: (b: DesignBrief) => DesignBrief | null; protects: string };

/**
 * Shrinks the plot (to the size given, or the next common sizes down) or the building while keeping what the person
 * protected. It tries the brief as it is, then gives up unprotected things one at a time (extras, the boys' quarters,
 * a parking space), then another storey, then a bedroom, and reports the first that passes every check.
 */
export function reviseBrief(plot: Plot, briefIn: Partial<DesignBrief>, revision: BriefRevision, opts: { cfg?: DesignConfig; toPlot?: Plot | null; /** A further test the designs must pass (a budget ceiling, say). */ accept?: (designs: Design[]) => boolean; /** Words for what the test is, e.g. "within ₦60m". */ goal?: string } = {}): RevisedBrief {
  const cfg = opts.cfg ?? DEFAULT_DESIGN_CONFIG;
  const brief = normaliseBrief(briefIn);
  const keep = new Set(revision.keep);
  const info = BUILDING_TYPES[brief.type];
  const plots: Plot[] = opts.toPlot ? [opts.toPlot]
    : revision.smaller.includes('plot') ? COMMON_PLOTS.map((p) => p.plot).filter((p) => p.widthM * p.depthM < plot.widthM * plot.depthM - 1).slice(0, 3)
      : [plot];
  const all: Step[] = [
    ...brief.features.filter((f) => !keep.has(f)).map((f): Step => ({ label: `no ${FEATURES[f as FeatureKey].label.toLowerCase()}`, protects: f, apply: (b) => (b.features.includes(f) ? { ...b, features: b.features.filter((x) => x !== f) } : null) })),
    { label: 'no study', protects: 'study', apply: (b) => (b.study ? { ...b, study: false } : null) },
    { label: "no boys' quarters", protects: 'bq', apply: (b) => (b.bq ? { ...b, bq: false } : null) },
    { label: 'one parking space fewer', protects: 'parking', apply: (b) => (b.parking > 1 ? { ...b, parking: b.parking - 1 } : null) },
    { label: 'one more storey', protects: 'storeys', apply: (b) => (b.storeys < info.storeys.max && (isHouse(b.type) ? b.storeys < 3 : true) ? normaliseBrief({ ...b, storeys: b.storeys + 1, ...(b.type === 'bungalow' ? { type: 'duplex' as const } : {}) }) : null) },
    { label: 'one bedroom fewer', protects: 'bedrooms', apply: (b) => (info.bedrooms && b.bedrooms > Math.max(2, info.bedrooms.min) ? { ...b, bedrooms: b.bedrooms - 1 } : null) },
  ];
  const steps = all.filter((x) => !keep.has(x.protects));
  const kept = [...keep].filter((k) => (k in FEATURES ? brief.features.includes(k as FeatureKey) : k === 'study' ? brief.study : k === 'bq' ? brief.bq : true));
  let last: RevisedBrief | null = null;
  for (const p of plots) {
    // The brief as it is, then each allowed sacrifice added in turn (cumulative), smallest first.
    let b = brief; const changes: string[] = [];
    for (let i = -1; i < steps.length; i++) {
      if (i >= 0) { const next = steps[i]!.apply(b); if (!next) continue; b = next; changes.push(steps[i]!.label); }
      const designs = generateDesigns(p, b, cfg).designs;
      if (designs.length && (opts.accept ? opts.accept(designs) : true)) {
        const size = `${r1(p.widthM)} × ${r1(p.depthM)} m`;
        return { fits: true, plot: p, brief: b, changes: [...changes], kept, designs,
          note: changes.length ? `On ${size} it ${opts.goal ? `comes ${opts.goal}` : 'fits'} with ${changes.join(', ')}${kept.length ? `; ${kept.join(', ')} kept` : ''}.` : `It ${opts.goal ? `already comes ${opts.goal}` : 'still fits'} on ${size} as it is${kept.length ? `, ${kept.join(', ')} included` : ''}.` };
      }
    }
    last = { fits: false, plot: p, brief: b, changes, kept, designs: [], note: '' };
  }
  const tried = plots.map((p) => `${r1(p.widthM)} × ${r1(p.depthM)} m`).join(', ');
  return { ...(last ?? { plot, brief, changes: [], kept, designs: [] }), fits: false,
    note: opts.goal
      ? `Nothing comes ${opts.goal} while keeping ${kept.join(', ') || 'the brief'}, even after giving up everything unprotected. A lower finish level, building in phases, or giving up something protected would be next.`
      : `Nothing passes every check on ${tried || 'a smaller plot'} while keeping ${kept.join(', ') || 'the brief'}${keep.has('bedrooms') ? '' : ', even with one bedroom fewer'}. Something protected would have to give, or the plot stay larger.` };
}
