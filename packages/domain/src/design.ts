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

import {
  BUILDING_TYPES, FEATURES, isBuildingType, isHouse, needsLift, needsTwoStairs,
  type BuildingType, type BuildingTypeInfo, type FeatureKey,
} from './building';
import { affinity, planningAnalysis } from './adjacency';

// ---------------------------------------------------------------- configuration

export type RoomKind =
  | 'living' | 'dining' | 'kitchen' | 'living-kitchen' | 'lounge'
  | 'master' | 'bedroom' | 'study'
  | 'bathroom' | 'ensuite' | 'wc' | 'store'
  | 'stair' | 'corridor'
  // home extras
  | 'gym' | 'gaming' | 'cinema' | 'laundry' | 'prayer'
  // shared by larger buildings
  | 'lobby' | 'lift' | 'toilets' | 'plant' | 'office' | 'open-office' | 'meeting'
  // commercial, hospitality and institutional
  | 'shop' | 'flat' | 'guest-room' | 'restaurant' | 'hall' | 'stage' | 'classroom' | 'library' | 'lab' | 'consult' | 'ward'
  | 'warehouse' | 'loading';

/** Rooms people spend time in: they need daylight and air (and take spare length when a band is laid out). */
export const HABITABLE: ReadonlySet<RoomKind> = new Set([
  'living', 'dining', 'kitchen', 'living-kitchen', 'lounge', 'master', 'bedroom', 'study', 'gym', 'gaming', 'prayer',
  'office', 'open-office', 'meeting', 'shop', 'flat', 'guest-room', 'restaurant', 'classroom', 'library', 'lab', 'consult', 'ward',
]);
export const WET: ReadonlySet<RoomKind> = new Set(['bathroom', 'ensuite', 'wc', 'toilets']);
/** Kinds without a size rule: circulation and the lift shaft. */
type Unruled = 'corridor' | 'stair' | 'lift';
export type RuledKind = Exclude<RoomKind, Unruled>;

export interface RoomRule { targetM2: number; minM2: number; minDimM: number }

export interface DesignConfig {
  setbacksM: { front: number; side: number; rear: number };
  maxCoveragePct: number;
  storeyHeightM: number;
  minCeilingM: number;
  slabM: number;
  wallM: { external: number; internal: number };
  rooms: Record<RuledKind, RoomRule>;
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
  roof: { pitchDeg: number; overhangM: number; parapetM: number; /** Parapet that hides a concealed pitched roof. */ hiddenParapetM: number };
  /** Boys' quarters: a detached room and shower at the back of the plot, kept clear of the house. */
  outbuilding: { gapM: number; roomW: number; roomD: number; showerW: number };
  /** The market's climate in a sentence, for the architect's review. */
  climate: string;
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
    gym: { targetM2: 14, minM2: 9, minDimM: 2.7 },
    gaming: { targetM2: 14, minM2: 9, minDimM: 2.7 },
    cinema: { targetM2: 18, minM2: 12, minDimM: 3.0 },
    laundry: { targetM2: 5, minM2: 3.5, minDimM: 1.8 },
    prayer: { targetM2: 8, minM2: 5, minDimM: 2.1 },
    lobby: { targetM2: 24, minM2: 4, minDimM: 1.8 },
    toilets: { targetM2: 12, minM2: 5, minDimM: 1.8 },
    plant: { targetM2: 8, minM2: 4, minDimM: 1.8 },
    office: { targetM2: 12, minM2: 7, minDimM: 2.4 },
    'open-office': { targetM2: 90, minM2: 25, minDimM: 4.0 },
    meeting: { targetM2: 18, minM2: 10, minDimM: 3.0 },
    shop: { targetM2: 20, minM2: 10, minDimM: 2.7 },
    flat: { targetM2: 70, minM2: 30, minDimM: 4.5 },
    'guest-room': { targetM2: 24, minM2: 16, minDimM: 3.2 },
    restaurant: { targetM2: 60, minM2: 25, minDimM: 4.0 },
    hall: { targetM2: 300, minM2: 60, minDimM: 8.0 },
    stage: { targetM2: 40, minM2: 15, minDimM: 3.0 },
    classroom: { targetM2: 56, minM2: 40, minDimM: 6.0 },
    library: { targetM2: 50, minM2: 25, minDimM: 4.0 },
    lab: { targetM2: 56, minM2: 30, minDimM: 5.0 },
    consult: { targetM2: 14, minM2: 9, minDimM: 3.0 },
    ward: { targetM2: 30, minM2: 16, minDimM: 3.6 },
    warehouse: { targetM2: 400, minM2: 60, minDimM: 8.0 },
    loading: { targetM2: 30, minM2: 15, minDimM: 4.0 },
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
  roof: { pitchDeg: 25, overhangM: 0.6, parapetM: 0.9, hiddenParapetM: 1.2 },
  outbuilding: { gapM: 3, roomW: 3.3, roomD: 3.6, showerW: 1.5 },
  climate: 'Hot and humid tropical (West Africa): strong sun, two rainy seasons with heavy storms, and still air indoors without cross-ventilation.',
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
  /** What is being built. Bungalows and duplexes are designed room by room; the rest from their own programme. */
  type: BuildingType;
  /** 1 for a bungalow, up to 10 for the tallest types (see BUILDING_TYPES). */
  storeys: number;
  /** The number that sizes non-house buildings: flats per floor, guest rooms per floor, seats… (0 for houses). */
  units: number;
  /** Optional rooms and services (gym, cinema, conference room, lift…), limited to what the type offers. */
  features: FeatureKey[];
  bedrooms: number;            // 1–6, including the master (per home or flat for terraces and flats)
  bathrooms: number;           // shared bathrooms, besides the master's ensuite
  ensuite: boolean;
  kitchen: 'open' | 'closed';
  study: boolean;
  guestWc: boolean;
  store: boolean;
  /** Parking spaces: up to 2 in front of a house, more for larger buildings. */
  parking: number;
  style: 'modern' | 'classic' | 'tropical';
  roof: RoofKind;
  roofFinish: RoofFinish;
  /** 'auto' follows the style. */
  roofColour: RoofColour;
  /** Degrees, 10–45. Shed and butterfly roofs stay shallow; a concealed roof is kept below its parapet. */
  roofPitch: number;
  /** A detached boys' quarters (staff or guest room with its own shower) at the back of the plot. */
  bq: boolean;
}

export const DEFAULT_BRIEF: DesignBrief = {
  type: 'bungalow', storeys: 1, units: 0, features: [], bedrooms: 3, bathrooms: 1, ensuite: true, kitchen: 'closed', study: false, guestWc: true, store: true,
  parking: 1, style: 'modern', roof: 'hip', roofFinish: 'aluminium', roofColour: 'auto', roofPitch: 25, bq: false,
};

// ---------------------------------------------------------------- roof choices

export type RoofKind = 'gable' | 'hip' | 'flat' | 'shed' | 'butterfly' | 'dutch' | 'mansard' | 'hidden';
export type RoofFinish = 'aluminium' | 'stone-coated' | 'concrete-tile' | 'standing-seam';
export type RoofColour = 'auto' | 'charcoal' | 'brick-red' | 'terracotta' | 'forest-green' | 'ocean-blue' | 'coffee-brown' | 'silver';

export const ROOF_OPTIONS: Record<RoofKind, { label: string; blurb: string }> = {
  hip: { label: 'Hip', blurb: 'Slopes on all four sides. Strong in wind and the most common choice for bungalows.' },
  gable: { label: 'Gable', blurb: 'Two slopes with triangular end walls. Simple and economical to build.' },
  dutch: { label: 'Dutch gable', blurb: 'A hip roof with a small gable at the top of each end: more character and a vent for the roof space.' },
  mansard: { label: 'Mansard', blurb: 'Steep lower slopes and a gentle top: a classic, grand look with room in the roof.' },
  shed: { label: 'Shed (mono-pitch)', blurb: 'One shallow slope: modern and minimal, with tall windows on the high side.' },
  butterfly: { label: 'Butterfly', blurb: 'Two slopes falling to a central valley that collects rainwater. Striking and contemporary.' },
  hidden: { label: 'Concealed (parapet)', blurb: 'A low pitched roof hidden behind parapet walls: a clean, boxy modern facade without a flat roof slab.' },
  flat: { label: 'Flat with parapet', blurb: 'A concrete roof slab with parapets. Usable as a roof terrace, but needs good waterproofing.' },
};

export const ROOF_FINISHES: Record<RoofFinish, { label: string; name: string; unit: 'm²' | 'piece'; m2PerPiece?: number; battenM: number; shop: { category?: string; q: string } }> = {
  aluminium: { label: 'Long-span aluminium', name: 'Long-span aluminium roofing sheets (0.55 mm)', unit: 'm²', battenM: 0.9, shop: { category: 'roofing', q: 'long span aluminium' } },
  'stone-coated': { label: 'Stone-coated steel tiles', name: 'Stone-coated steel roof tiles', unit: 'piece', m2PerPiece: 0.46, battenM: 0.37, shop: { category: 'roofing', q: 'stone coated' } },
  'concrete-tile': { label: 'Concrete tiles', name: 'Concrete roof tiles', unit: 'piece', m2PerPiece: 0.095, battenM: 0.34, shop: { category: 'roofing', q: 'roof tiles' } },
  'standing-seam': { label: 'Standing-seam metal', name: 'Standing-seam metal roofing', unit: 'm²', battenM: 0.9, shop: { category: 'roofing', q: 'standing seam' } },
};

export const ROOF_COLOURS: Record<Exclude<RoofColour, 'auto'>, { label: string; hex: string }> = {
  charcoal: { label: 'Charcoal', hex: '#3f3f46' },
  'brick-red': { label: 'Brick red', hex: '#9a3b1f' },
  terracotta: { label: 'Terracotta', hex: '#c2622d' },
  'forest-green': { label: 'Forest green', hex: '#3f6b4f' },
  'ocean-blue': { label: 'Ocean blue', hex: '#2f5d8a' },
  'coffee-brown': { label: 'Coffee brown', hex: '#5b3a29' },
  silver: { label: 'Silver', hex: '#a8adb3' },
};
const STYLE_COLOUR: Record<DesignBrief['style'], Exclude<RoofColour, 'auto'>> = { modern: 'charcoal', classic: 'brick-red', tropical: 'forest-green' };

/** The roof colour to draw: the chosen one, or the style's. */
export function roofHex(b: Pick<DesignBrief, 'roofColour' | 'style'>): string {
  return ROOF_COLOURS[b.roofColour === 'auto' || !ROOF_COLOURS[b.roofColour as Exclude<RoofColour, 'auto'>] ? STYLE_COLOUR[b.style] : (b.roofColour as Exclude<RoofColour, 'auto'>)].hex;
}

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
  // Older briefs have no type: two storeys meant a duplex. A house asked for on another number of floors switches.
  let type: BuildingType = isBuildingType(x.type) ? x.type : Number(x.storeys) >= 2 ? 'duplex' : 'bungalow';
  if (type === 'bungalow' && Number(x.storeys) >= 2) type = 'duplex';
  if (type === 'duplex' && Number(x.storeys) === 1 && b.type !== 'duplex') type = 'bungalow';
  const info = BUILDING_TYPES[type];
  const units = info.units ? Math.round(clampInt(b.units ?? info.units.default, info.units.min, info.units.max) / info.units.step) * info.units.step : 0;
  const offered = new Set(info.features);
  const features = [...new Set(Array.isArray(x.features) ? x.features : [])].filter((f): f is FeatureKey => Object.hasOwn(FEATURES, f) && offered.has(f as FeatureKey));
  const house = isHouse(type);
  return {
    type,
    storeys: clampInt(x.storeys, info.storeys.min, info.storeys.max),
    units,
    features,
    bedrooms: info.bedrooms ? clampInt(x.bedrooms, info.bedrooms.min, info.bedrooms.max) : clampInt(x.bedrooms, 1, 6),
    bathrooms: clampInt(x.bathrooms, 0, 4),
    ensuite: !!x.ensuite,
    kitchen: x.kitchen === 'open' ? 'open' : 'closed',
    study: !!x.study, guestWc: !!x.guestWc, store: !!x.store,
    parking: clampInt(x.parking, 0, house ? 2 : 60),
    style: (['modern', 'classic', 'tropical'] as const).includes(x.style) ? x.style : 'modern',
    roof: Object.hasOwn(ROOF_OPTIONS, x.roof) ? x.roof : 'hip',
    roofFinish: Object.hasOwn(ROOF_FINISHES, x.roofFinish) ? x.roofFinish : 'aluminium',
    roofColour: x.roofColour === 'auto' || Object.hasOwn(ROOF_COLOURS, x.roofColour) ? x.roofColour : 'auto',
    roofPitch: clampInt(x.roofPitch, 10, 45),
    bq: house && !!x.bq,
  };
}

/** The type's details, for a brief. */
export const typeOf = (b: Pick<DesignBrief, 'type'>): BuildingTypeInfo => BUILDING_TYPES[b.type] ?? BUILDING_TYPES.bungalow;

// ---------------------------------------------------------------- outputs

export interface Rect { x: number; y: number; w: number; d: number }
export interface Room extends Rect {
  id: string; kind: RoomKind; name: string; storey: number; /** The block (wing or outbuilding) it is in. */ block: string;
  /** How generously it is glazed: standard windows, large windows, or floor-to-ceiling glass to a garden or view. */
  glazing?: Glazing;
}
export type Glazing = 'standard' | 'large' | 'full-height';

// ---------------------------------------------------------------- architecture beyond the rooms

/**
 * What makes a building more than boxes: porches and verandas (roofed outdoor rooms on columns), balconies
 * (cantilevered slabs with a rail), canopies (thin projecting roofs over doors), pergolas (open timber or steel
 * frames), screens (louvre panels), feature walls (cladding on part of a facade) and planters. Each is a rectangle in
 * plan metres; `storey` is the floor it sits on (a balcony on storey 1 projects from the first floor).
 */
export type ElementKind = 'porch' | 'veranda' | 'balcony' | 'canopy' | 'pergola' | 'screen' | 'feature-wall' | 'planter';
export type MaterialKey =
  | 'render-white' | 'render-cream' | 'render-sand' | 'render-grey' | 'render-charcoal'
  | 'stone' | 'brick' | 'timber' | 'concrete' | 'metal-dark' | 'tile-terracotta';
export interface ArchElement {
  id: string; kind: ElementKind; storey: number; x: number; y: number; w: number; d: number;
  /** Height for screens, feature walls, pergolas and planters (m); porches and verandas take the storey height. */
  heightM?: number;
  material?: MaterialKey;
  label?: string;
}
/** The materials of a block's facades: main walls, the base (plinth), and an accent for details and features. */
export interface BlockFinish { block: string; walls: MaterialKey; base?: MaterialKey; accent?: MaterialKey }
export const MATERIALS: Record<MaterialKey, { label: string; hex: string }> = {
  'render-white': { label: 'White render', hex: '#f3f0e8' },
  'render-cream': { label: 'Cream render', hex: '#ece0c4' },
  'render-sand': { label: 'Sand render', hex: '#d8c7a6' },
  'render-grey': { label: 'Grey render', hex: '#b9b6b0' },
  'render-charcoal': { label: 'Charcoal render', hex: '#45444a' },
  stone: { label: 'Natural stone cladding', hex: '#a8977a' },
  brick: { label: 'Facing brick', hex: '#9a4f34' },
  timber: { label: 'Timber cladding', hex: '#8a5a37' },
  concrete: { label: 'Fair-faced concrete', hex: '#9c9b96' },
  'metal-dark': { label: 'Dark metal', hex: '#2f3033' },
  'tile-terracotta': { label: 'Terracotta tiles', hex: '#c2622d' },
};

/**
 * A rectangular mass of the building: the house is one or more wings (an L-plan is two), all with the house's
 * number of storeys; an outbuilding such as a boys' quarters is a separate single-storey block.
 */
export interface Block extends Rect { id: string; name: string; kind: 'house' | 'outbuilding'; storeys: number; ridge: 'x' | 'y' }

/** The architect's reading of a design: what works, what to watch, and a score used to rank the options. */
export interface ArchitectReview {
  score: number;
  highlights: string[];
  considerations: string[];
  /** Who wrote the notes: the built-in engine, or the AI architect when one is connected. */
  source: 'engine' | 'ai';
}

/** A wall run on a plan line: horizontal walls lie on y = at (from..to along x), vertical walls on x = at. */
export interface Wall { id: string; storey: number; dir: 'h' | 'v'; at: number; from: number; to: number; thickness: number; external: boolean }
export interface Opening {
  id: string; storey: number; kind: 'door' | 'window'; dir: 'h' | 'v'; at: number; from: number; to: number;
  sillM: number; headM: number; external: boolean; roomId: string; label: string;
}
export interface Roof { kind: RoofKind; pitchDeg: number; overhangM: number; parapetM: number; ridge: 'x' | 'y'; finish: RoofFinish; colour: string }

export type DesignCheckStatus = 'pass' | 'warn' | 'fail';
export interface DesignCheck { code: string; label: string; status: DesignCheckStatus; detail: string }

export interface DesignPlanning { zones: string; arrival: string; relationships: string[]; flow: string }

export interface Design {
  id: string;
  name: string;
  summary: string;
  plot: Plot;
  brief: DesignBrief;
  /** Layout family: rooms off a central hallway, an L-plan with a bedroom wing, and so on. */
  typology: 'hallway' | 'l-plan' | 'pavilion' | 'core' | 'row' | 'ai';
  /** One sentence on the layout idea (the summary adds the numbers). */
  blurb: string;
  /** How many of the person's own edits are applied (0 for a generated design). */
  edits: number;
  envelope: Rect;
  /** Bounding box of the house (not the outbuildings). For areas use `blocks` and `metrics`. */
  footprint: Rect;
  blocks: Block[];
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
  review: ArchitectReview;
  /** The AI architect's concept, when it reviewed this design (else use conceptFor). */
  concept?: DesignConcept;
  /** How the architect planned it before drawing (AI designs): zones, arrival, the key relationships, daily flow. */
  planning?: DesignPlanning;
  /** Porches, balconies, canopies, screens and the like (see ArchElement). */
  elements: ArchElement[];
  /** Facade materials per block. */
  finishes: BlockFinish[];
}

export interface DesignResult { designs: Design[]; notes: string[] }

// ---------------------------------------------------------------- generator

interface Item {
  kind: RoomKind; name: string; target: number; min: number; minDim: number; fixedW?: number; withEnsuite?: boolean;
  /** Stays at the end of its band (an entrance hall or kitchen that must meet the neighbouring wing). */
  pinEnd?: boolean;
}

function item(cfg: DesignConfig, kind: RuledKind, name: string): Item {
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
  const has = (f: FeatureKey) => b.features.includes(f);
  const feat = (f: FeatureKey, kind: RuledKind, name: string): Item[] => (has(f) ? [item(cfg, kind, name)] : []);
  const lift = needsLift(b.type, b.storeys, b.features) ? [liftItem()] : [];

  if (b.storeys === 1) {
    // Interleave bathrooms between bedrooms so each is close to the rooms it serves.
    const rear: Item[] = [master];
    const rest = [...bedrooms];
    const bathQ = [...baths];
    while (rest.length || bathQ.length) {
      if (rest.length) rear.push(rest.shift()!);
      if (bathQ.length) rear.push(bathQ.shift()!);
    }
    rear.push(...extras, ...feat('gym', 'gym', 'Gym'), ...feat('prayer', 'prayer', 'Prayer room'));
    // The guest WC goes by the entrance, never beside the kitchen or dining room: at the street end of the living
    // band for a separate kitchen; with an open-plan kitchen, at the start of the hallway, away from the cooking.
    if (b.kitchen === 'open') rear.unshift(...wc);
    // The kitchen goes on the corner so it has a side wall for its door and window; the guest WC sits by the entrance.
    // Extra rooms for the family sit with the living rooms; the laundry beside the kitchen.
    const social = [...feat('family-lounge', 'lounge', 'Family lounge'), ...feat('gaming', 'gaming', 'Gaming room'), ...feat('cinema', 'cinema', 'Home cinema')];
    return [{ front: [...(b.kitchen === 'open' ? [] : wc), living[0]!, ...social, ...living.slice(1), ...feat('laundry', 'laundry', 'Laundry')], rear }];
  }
  // Two storeys: living spaces, a guest room when there are four or more bedrooms, and the guest WC downstairs;
  // the master and the other bedrooms upstairs. The stair sits at the same position on both floors.
  // A third floor is for the family: lounge, games, gym and cinema.
  const third = b.storeys >= 3;
  const downBeds = b.bedrooms >= 4 ? [bedrooms.shift()!] : [];
  const downBaths = downBeds.length && baths.length > 1 ? [baths.shift()!] : [];
  const groundExtras = [...feat('laundry', 'laundry', 'Laundry'), ...feat('prayer', 'prayer', 'Prayer room'), ...(third ? [] : [...feat('gym', 'gym', 'Gym'), ...feat('cinema', 'cinema', 'Home cinema')])];
  const ground = b.kitchen === 'open'
    ? { front: [living[0]!], rear: [stair(), ...lift, ...wc, ...downBeds, ...downBaths, ...extras, ...groundExtras] }
    : { front: [...wc, living[0]!, ...living.slice(1)], rear: [stair(), ...lift, ...downBeds, ...downBaths, ...extras, ...groundExtras] };
  const upFront = bedrooms.splice(0, Math.ceil(bedrooms.length / 2));
  const upRear: Item[] = [stair(), ...lift, ...bedrooms, ...baths, master]; // master on the far corner: two outside walls
  const upSocial = third ? [] : [...feat('family-lounge', 'lounge', 'Family lounge'), ...feat('gaming', 'gaming', 'Gaming room')];
  const upper = { front: upFront.length || upSocial.length ? [...upFront, ...upSocial] : [item(cfg, 'lounge', 'Upstairs lounge')], rear: upRear };
  if (ground.rear.length === 1 + lift.length) ground.rear.push(item(cfg, 'store', 'Store'));
  if (!third) return [ground, upper];
  const top = {
    front: [has('family-lounge') ? item(cfg, 'lounge', 'Family lounge') : item(cfg, 'lounge', 'Roof lounge'), ...feat('gaming', 'gaming', 'Gaming room')],
    rear: [stair(), ...lift, ...feat('gym', 'gym', 'Gym'), ...feat('cinema', 'cinema', 'Home cinema'), item(cfg, 'wc', 'Toilet'), item(cfg, 'store', 'Store')],
  };
  return [ground, upper, top];
}

function liftItem(): Item { return { kind: 'lift', name: 'Lift', target: 2.4 * 2.4, min: 0, minDim: 2.4, fixedW: 2.4 }; }

/** What a layout needs besides the rooms: the corridor's width and names, and what fills spare length in a band. */
interface Programme {
  floors: { front: Item[]; rear: Item[] }[];
  corridorM: number;
  corridorNames: [string, string];
  filler: Filler;
  noCorridor?: boolean;
}
interface Filler { big: { kind: RuledKind; name: string } | null; small: { kind: RuledKind; name: string } | null }
const HOME_FILLER: Filler = { big: { kind: 'lounge', name: 'Family lounge' }, small: { kind: 'store', name: 'Linen store' } };

const FILLERS: Partial<Record<BuildingType, Filler>> = {
  terrace: { big: null, small: null },
  apartments: { big: { kind: 'lounge', name: "Residents' lounge" }, small: { kind: 'store', name: 'Store' } },
  shops: { big: { kind: 'shop', name: 'Kiosk' }, small: { kind: 'store', name: 'Store' } },
  office: { big: { kind: 'meeting', name: 'Breakout space' }, small: { kind: 'store', name: 'Store' } },
  'mixed-use': { big: { kind: 'office', name: 'Management office' }, small: { kind: 'store', name: 'Store' } },
  warehouse: { big: { kind: 'office', name: 'Office' }, small: { kind: 'store', name: 'Store' } },
  hotel: { big: { kind: 'lounge', name: 'Guest lounge' }, small: { kind: 'store', name: 'Linen store' } },
  'event-hall': { big: { kind: 'office', name: 'Bridal room' }, small: { kind: 'store', name: 'Store' } },
  school: { big: { kind: 'office', name: 'Resource room' }, small: { kind: 'store', name: 'Store' } },
  clinic: { big: { kind: 'lobby', name: 'Waiting area' }, small: { kind: 'store', name: 'Store' } },
  worship: { big: { kind: 'office', name: 'Meeting room' }, small: { kind: 'store', name: 'Store' } },
};

/** Floor-area of a flat or home with this many bedrooms, m² (a [proposed] concept allowance). */
export const flatAreaM2 = (beds: number) => 28 + 22 * beds;

/** The programme for any building type: houses room by room, everything else from its type. */
function programmeFor(cfg: DesignConfig, b: DesignBrief): Programme {
  const info = typeOf(b);
  if (isHouse(b.type)) return { floors: programme(cfg, b), corridorM: cfg.corridorM, corridorNames: ['Hallway', 'Landing'], filler: HOME_FILLER };
  const S = b.storeys; const n = b.units;
  const has = (f: FeatureKey) => b.features.includes(f);
  const it = (kind: RuledKind, name: string, target?: number): Item => ({ ...item(cfg, kind, name), ...(target ? { target: Math.max(target, cfg.rooms[kind].minM2) } : {}) });
  const stairW = b.type === 'terrace' ? 1.0 : 1.5;
  const stair = (name = 'Stair'): Item => ({ kind: 'stair', name, target: stairW * cfg.stair.minRunM, min: 0, minDim: stairW, fixedW: stairW });
  const lift = needsLift(b.type, S, b.features);
  const two = needsTwoStairs(b.type, S);
  const toilets = (pair: boolean): Item[] => (pair ? [it('toilets', 'Toilets (men)'), it('toilets', 'Toilets (women)')] : [it('toilets', 'Toilets')]);
  const halves = <T,>(xs: T[]): [T[], T[]] => { const k = Math.ceil(xs.length / 2); return [xs.slice(0, k), xs.slice(k)]; };
  const tag = (s: number) => (s === 0 ? 'G' : String(s));
  const letter = (i: number) => String.fromCharCode(65 + i);
  /** The core starts the rear band on every floor (aligned), an escape stair ends it in tall buildings. */
  const floor = (front: Item[], rear: Item[]) => ({
    front,
    rear: [...(S > 1 ? [stair(), ...(lift ? [liftItem()] : [])] : []), ...rear, ...(S > 1 && two ? [stair('Escape stair')] : [])],
  });
  const floors: { front: Item[]; rear: Item[] }[] = [];
  const flats = (s: number, count: number) => Array.from({ length: count }, (_, i) => it('flat', `Flat ${tag(s)}${letter(i)} (${b.bedrooms}-bed)`, flatAreaM2(b.bedrooms)));
  const suites = (s: number, count: number) => Array.from({ length: count }, (_, i) => it('open-office', `Office suite ${tag(s)}${i + 1}`, 90));
  const shops = (s: number, count: number) => Array.from({ length: count }, (_, i) => it('shop', `Shop ${tag(s)}${i + 1}`, 20));
  const topGym = (s: number, name: string) => (has('gym') && s === S - 1 ? [it('gym', name, 36)] : []);

  switch (b.type) {
    case 'terrace': {
      // Pairs of houses share a party wall; each house has its own stair, so stairs come in pairs between pairs.
      const w = round(Math.min(7.5, Math.max(5.4, 4.2 + b.bedrooms * 0.75)), 2);
      const house = (i: number, s: number): Item => {
        const name = s === 0 ? `House ${i + 1}: living and kitchen` : S === 2 ? `House ${i + 1}: ${b.bedrooms} bedrooms` : s === 1 ? `House ${i + 1}: bedrooms` : `House ${i + 1}: bedroom and family room`;
        const kind: RuledKind = s === 0 ? 'living-kitchen' : 'bedroom';
        return { ...item(cfg, kind, name), fixedW: w, target: w * 8 };
      };
      for (let s = 0; s < S; s++) {
        const row: Item[] = [];
        for (let i = 0; i < n; i += 2) {
          row.push(stair(`House ${i + 1} stair`), house(i, s));
          if (i + 1 < n) row.push(house(i + 1, s), stair(`House ${i + 2} stair`));
        }
        floors.push({ front: [], rear: row });
      }
      break;
    }
    case 'apartments':
      for (let s = 0; s < S; s++) {
        const [f, r] = halves(flats(s, n));
        floors.push(s === 0
          ? floor([it('lobby', 'Entrance lobby', 16), ...f], [...r, ...(has('laundry') ? [it('laundry', 'Shared laundry', 12)] : []), ...(has('gym') ? [it('gym', "Residents' gym", 30)] : [])])
          : floor(f, r));
      }
      break;
    case 'shops':
      for (let s = 0; s < S; s++) {
        const [f, r] = halves(shops(s, n));
        floors.push(floor(f, [...toilets(n > 6), ...(s === 0 ? [it('store', 'Store', 6)] : []), ...r]));
      }
      break;
    case 'office':
      for (let s = 0; s < S; s++) {
        if (s === 0) {
          const [f, r] = halves(suites(s, S === 1 ? n : Math.max(0, n - 1)));
          floors.push(floor([it('lobby', 'Reception', 30), ...(has('conference') ? [it('meeting', 'Conference room', 40)] : []), ...f],
            [...(has('canteen') ? [it('restaurant', 'Canteen', 40), it('meeting', 'Meeting room', 16)] : []), ...toilets(true), ...r]));
        } else {
          const [f, r] = halves(suites(s, n));
          floors.push(floor([...f, ...topGym(s, 'Staff gym')], [...toilets(true), it('meeting', 'Meeting room', 16), ...r]));
        }
      }
      break;
    case 'mixed-use': {
      const offices = has('upper-offices');
      for (let s = 0; s < S; s++) {
        if (s === 0) {
          const [f, r] = halves(shops(s, n));
          floors.push(floor([it('lobby', 'Entrance lobby', 12), ...f], [...toilets(false), ...r]));
        } else {
          const units = offices ? suites(s, Math.max(1, Math.round(n / 3))) : flats(s, Math.max(2, Math.round(n / 2)));
          const [f, r] = halves(units);
          floors.push(floor([...f, ...topGym(s, 'Gym')], [...(offices ? toilets(false) : []), ...r]));
        }
      }
      break;
    }
    case 'warehouse': {
      const area = n / S;
      floors.push(floor(
        [it('office', 'Office and reception', 24), ...toilets(false), ...(has('canteen') ? [it('restaurant', 'Canteen', 30)] : []), it('plant', 'Plant room', 8), it('loading', 'Loading bay', 40)],
        [it('warehouse', 'Warehouse floor', area)],
      ));
      if (S > 1) floors.push(floor([it('office', 'Offices', 40), ...toilets(false)], [it('warehouse', 'Upper storage floor', area)]));
      break;
    }
    case 'hotel':
      for (let s = 0; s < S; s++) {
        const rooms = Array.from({ length: s === 0 ? Math.floor(n / 2) : n }, (_, i) => it('guest-room', `Room ${s}${String(i + 1).padStart(2, '0')}`, 24));
        const [f, r] = halves(rooms);
        if (s === 0) {
          floors.push(floor(
            [it('lobby', 'Lobby and reception', Math.max(20, n * 3)), ...(has('restaurant') ? [it('restaurant', 'Restaurant', Math.max(40, n * 4))] : []), ...(has('conference') ? [it('meeting', 'Conference hall', 80)] : []), ...f],
            [...(has('restaurant') ? [it('kitchen', 'Hotel kitchen', 30)] : []), it('laundry', 'Laundry', 12), it('office', "Manager's office", 12), ...toilets(true), ...r],
          ));
        } else floors.push(floor([...f, ...topGym(s, 'Fitness room')], [it('store', 'Linen store', 4), ...r]));
      }
      break;
    case 'event-hall':
      floors.push(floor(
        [it('lobby', 'Entrance hall', Math.max(30, n * 0.12)), ...toilets(true), it('office', 'Green room', 16), it('store', 'Chair store', Math.max(12, n * 0.04))],
        [it('stage', 'Stage', Math.max(30, n * 0.08)), it('hall', 'Main hall', n), it('kitchen', 'Catering kitchen', Math.max(20, n * 0.06))],
      ));
      if (S > 1) floors.push(floor([it('meeting', 'VIP lounge', 40), it('office', 'Office', 12), ...toilets(false)], [it('hall', 'Banquet hall', n * 0.5)]));
      break;
    case 'school':
      for (let s = 0; s < S; s++) {
        const [f, r] = halves(Array.from({ length: n }, (_, i) => it('classroom', `Classroom ${tag(s)}${i + 1}`, 56)));
        const lab = has('lab') && s === Math.min(1, S - 1) ? [it('lab', 'Science laboratory', 56)] : [];
        floors.push(s === 0
          ? floor([it('lobby', 'Reception', 16), it('office', 'Head teacher', 14), it('office', 'Staff room', 30), ...f],
            [...(has('canteen') ? [it('restaurant', 'Canteen', 60)] : []), ...(has('library') ? [it('library', 'Library', 60)] : []), ...lab, ...toilets(true), ...r])
          : floor(f, [...toilets(true), ...lab, ...r]));
      }
      break;
    case 'clinic':
      for (let s = 0; s < S; s++) {
        if (s === 0) {
          const [f, r] = halves(Array.from({ length: n }, (_, i) => it('consult', `Consulting room ${i + 1}`, 14)));
          floors.push(floor([it('lobby', 'Reception and waiting', 40), ...(has('pharmacy') ? [it('office', 'Pharmacy', 16)] : []), ...f],
            [...toilets(true), ...(has('lab') ? [it('lab', 'Laboratory', 24)] : []), it('office', 'Records', 10), ...r]));
        } else {
          const [f, r] = halves(Array.from({ length: n }, (_, i) => it('ward', `Ward ${s}${letter(i)}`, 30)));
          floors.push(floor(f, [it('office', "Nurses' station", 12), ...toilets(true), it('store', 'Linen store', 4), ...r]));
        }
      }
      break;
    case 'worship':
      floors.push(floor(
        [it('lobby', 'Entrance hall', Math.max(30, n * 0.1)), ...toilets(true), it('office', 'Office', 12), it('office', 'Vestry', 12), it('store', 'Store', 8)],
        [it('stage', 'Altar and pulpit', Math.max(25, n * 0.06)), it('hall', 'Main auditorium', n * 0.8)],
      ));
      if (S > 1) floors.push(floor([it('meeting', "Children's hall", Math.max(40, n * 0.15)), it('office', 'Counselling room', 12), ...toilets(false)], [it('meeting', 'Fellowship hall', Math.max(60, n * 0.3))]));
      break;
    default:
      break;
  }
  return {
    floors, corridorM: info.corridorM, corridorNames: info.corridorNames,
    filler: FILLERS[b.type] ?? HOME_FILLER, noCorridor: info.noCorridor,
  };
}

/**
 * Orders a band's rooms the way an architect plans them: each room beside the rooms it works with (kitchen, dining,
 * living in one line; a bathroom between bedrooms), never beside the rooms it fights (a toilet against the kitchen,
 * a cinema against a bedroom). The stair and lift keep their place at the start so they stack, an escape stair and
 * the master suite (its far corner, with two outside walls) keep the end; a kitchen likes a corner for its side door.
 */
function arrange(items: Item[]): Item[] {
  const start: Item[] = []; const end: Item[] = []; const free: Item[] = [];
  items.forEach((it, i) => {
    if ((it.kind === 'stair' && it.name !== 'Escape stair' && i <= 1) || (it.kind === 'lift' && i <= 2)) start.push(it);
    else if ((it.kind === 'stair' && it.name === 'Escape stair') || it.withEnsuite || it.pinEnd) end.push(it);
    else free.push(it);
  });
  if (free.length < 2) return items;
  const score = (seq: Item[]) => {
    const all = [...start, ...seq, ...end];
    let v = 0;
    for (let i = 0; i + 1 < all.length; i++) v += affinity(all[i]!.kind, all[i + 1]!.kind);
    const k = all.findIndex((x) => x.kind === 'kitchen');
    if (k === 0 || k === all.length - 1) v += 1; // a corner kitchen gets its own outside door
    seq.forEach((x, i) => { v -= 0.01 * Math.abs(i - free.indexOf(x)); }); // otherwise keep the planned order
    return v;
  };
  let best = [...free]; let bestV = score(best);
  if (free.length <= 7) {
    const permute = (rest: Item[], acc: Item[]) => {
      if (!rest.length) { const v = score(acc); if (v > bestV + 1e-9) { best = acc; bestV = v; } return; }
      rest.forEach((x, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, x]));
    };
    permute(free, []);
  } else {
    // Many rooms (hotels, schools): improve by swapping pairs while it helps.
    for (let pass = 0, better = true; pass < 6 && better; pass++) {
      better = false;
      for (let i = 0; i < best.length; i++) for (let j = i + 1; j < best.length; j++) {
        if (best[i]!.kind === best[j]!.kind) continue;
        const t = [...best]; [t[i], t[j]] = [t[j]!, t[i]!];
        const v = score(t);
        if (v > bestV + 1e-9) { best = t; bestV = v; better = true; }
      }
    }
  }
  return [...start, ...best, ...end];
}

/** A rectangle in the layout's own frame: a runs along the bands, b across them (band, hallway, band). */
interface Local { a: number; b: number; la: number; lb: number }

const baseWidth = (i: Item, D: number) => i.fixedW ?? Math.max(i.target / D, i.minDim, i.min / D);
const bandLength = (items: Item[], D: number) => items.reduce((s, i) => s + baseWidth(i, D), 0);

/** Lays one band out along a; spare length goes to habitable rooms (never to the stair). */
function layBand(itemsIn: Item[], band: Local, corridorSide: 'start' | 'end', cfg: DesignConfig, filler: Filler = HOME_FILLER): { item: Item; r: Local; ensuite?: Local }[] {
  const D = band.lb; const W = band.la;
  let items = itemsIn;
  const base = items.map((i) => baseWidth(i, D));
  let spare = Math.max(0, W - base.reduce((x, y) => x + y, 0));
  const widths = [...base];
  // Habitable rooms take the spare length, but never beyond twice their depth (no corridor-like rooms).
  for (let pass = 0; pass < 4 && spare > 0.01; pass++) {
    // A kitchen stays a working kitchen (about 1.4 times its target), not a hall-sized room.
    const cap = (i: Item) => (i.kind === 'living' || i.kind === 'living-kitchen' ? 2.4 * D
      : i.kind === 'kitchen' ? Math.max(i.minDim, (i.target * 1.4) / D)
        : 1.5 * (i.withEnsuite ? D - cfg.rooms.ensuite.minDimM : D));
    const open = items.map((i, k) => (!i.fixedW && HABITABLE.has(i.kind) && widths[k]! < cap(i) - 0.01 ? i.target : 0));
    const sum = open.reduce((x, y) => x + y, 0);
    if (!sum) break;
    let used = 0;
    widths.forEach((w, k) => { if (open[k]) { const add = Math.max(0, Math.min((open[k]! / sum) * spare, cap(items[k]!) - w)); widths[k] = w + add; used += add; } });
    spare -= used;
  }
  // Fillers never go after a stair at the end of a band, so the stair stays aligned between floors.
  const insertFiller = (it: Item, w: number) => {
    const last = items[items.length - 1];
    // ...nor after the master suite (it keeps its corner and outside walls) or a room pinned to the end.
    const at = last && (last.kind === 'stair' || last.pinEnd || last.withEnsuite) ? items.length - 1 : items.length;
    items = [...items.slice(0, at), it, ...items.slice(at)];
    widths.splice(at, 0, w);
  };
  // Leftover length becomes a useful room when it is big enough (a lounge in a home), else a store.
  const fits = (k: RuledKind) => spare >= Math.max(cfg.rooms[k].minDimM, cfg.rooms[k].minM2 / D);
  if (filler.big && fits(filler.big.kind)) {
    const r = cfg.rooms[filler.big.kind];
    insertFiller({ kind: filler.big.kind, name: filler.big.name, target: spare * D, min: r.minM2, minDim: r.minDimM }, spare);
    spare = 0;
  }
  if (filler.small && fits(filler.small.kind)) {
    const r = cfg.rooms[filler.small.kind];
    insertFiller({ kind: filler.small.kind, name: filler.small.name, target: spare * D, min: r.minM2, minDim: r.minDimM }, spare);
    spare = 0;
  }
  if (spare > 0.01) {
    // What is left goes to a living room or bedroom, not to a kitchen, store or toilet.
    const roomy = widths.findIndex((_, i) => !items[i]!.fixedW && HABITABLE.has(items[i]!.kind) && items[i]!.kind !== 'kitchen');
    const k = roomy >= 0 ? roomy : widths.findIndex((_, i) => !items[i]!.fixedW);
    if (k >= 0) widths[k] = widths[k]! + spare;
  }
  const out: { item: Item; r: Local; ensuite?: Local }[] = [];
  let a = band.a;
  items.forEach((it, k) => {
    const w = k === items.length - 1 && !it.fixedW ? round(band.a + W - a, 3) : round(widths[k]!, 3);
    if (it.withEnsuite) {
      // The ensuite sits behind the master, away from the hallway: entered from the bedroom, with an outside window.
      const ens = cfg.rooms.ensuite;
      const ensD = round(Math.max(ens.minDimM, Math.min(ens.targetM2 / w, D - it.minDim)), 3);
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

interface Variant {
  key: string; name: string; orient: 'across' | 'along'; depth: number; mirror: boolean; single?: boolean; blurb: string;
  /** Depth of the rear band when it differs from the front (deep halls behind a shallow foyer band). */
  depthRear?: number;
}
const VARIANTS: Variant[] = [
  { key: 'wide', name: 'Wide frontage', orient: 'across', depth: 3.6, mirror: false, blurb: 'A long, shallow plan facing the street: every room gets daylight from the front or back.' },
  { key: 'balanced', name: 'Balanced', orient: 'across', depth: 4.5, mirror: true, blurb: 'Well-proportioned rooms either side of a central hallway, with a side passage for access and air flow.' },
  { key: 'compact', name: 'Compact', orient: 'across', depth: 5.4, mirror: false, blurb: 'Deeper rooms and a shorter house, leaving the most garden.' },
  { key: 'long', name: 'Long plan', orient: 'along', depth: 3.9, mirror: false, blurb: 'Rooms run front to back off a central hallway: suits narrow, deep plots.' },
  { key: 'narrow', name: 'Narrow plan', orient: 'along', depth: 3.6, mirror: true, single: true, blurb: 'One row of rooms along a side hallway: fits the narrowest plots.' },
];

/** Proportions tried for a non-house type: its band depths, facing the street and (first pair) running back. */
function typeVariants(type: BuildingType): Variant[] {
  const info = BUILDING_TYPES[type];
  const sizes = ['Classic', 'Generous', 'Compact', 'Slim'];
  const corridor = info.noCorridor ? '' : info.corridorNames[1].toLowerCase();
  const out: Variant[] = info.bands.map(([f, r], i) => ({
    key: `front-${i}`, name: `${sizes[i] ?? 'Alternative'} street front`, orient: 'across', depth: f || r, depthRear: r, mirror: false, single: f === 0,
    blurb: info.noCorridor
      ? 'The homes stand side by side along the street, each with its own front door, garden behind and stair.'
      : `A long front to the street, with rooms either side of a central ${corridor} and the stair core at one end.`,
  }));
  const [f, r] = info.bands[0] ?? [0, 8];
  // Rooms on one side of the corridor only: the narrowest building, for tight plots.
  if (!info.noCorridor && f === r) {
    out.push({
      key: 'narrow', name: 'Narrow plan', orient: 'along', depth: r, mirror: false, single: true,
      blurb: `One row of rooms along a side ${corridor}, running back from the street: fits narrow plots and gives every room cross-ventilation.`,
    });
  }
  out.push({
    key: 'deep', name: 'Deep plan', orient: 'along', depth: f || r, depthRear: r, mirror: false, single: f === 0,
    blurb: info.noCorridor
      ? 'The homes run back from the street side by side: suits deep plots.'
      : `Runs from the street to the back of the plot, rooms either side of the ${corridor}: suits narrow, deep plots.`,
  });
  return out;
}

/** How many options the generator offers, best first. */
export const MAX_DESIGNS = 4;

export function generateDesigns(plot: Plot, briefIn: Partial<DesignBrief>, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): DesignResult {
  const notes: string[] = [];
  if (!validPlot(plot)) return { designs: [], notes: ['Enter a plot between 6 m and 200 m on each side.'] };
  let brief = normaliseBrief(briefIn);
  let designs = tryAll(plot, brief, cfg);
  if (!designs.length && brief.type === 'bungalow') {
    const up = normaliseBrief({ ...brief, type: 'duplex', storeys: 2 });
    const two = tryAll(plot, up, cfg);
    if (two.length) {
      notes.push(`A ${brief.bedrooms}-bedroom bungalow does not fit this plot within the setbacks and coverage limit, so these designs are two storeys.`);
      brief = up; designs = two;
    }
  }
  // Larger buildings: when the programme is too big for the plot, offer the most that fits rather than nothing:
  // first without the optional extras, then with fewer units, and last without the parking row in front.
  const info = typeOf(brief);
  if (!designs.length && !isHouse(brief.type)) {
    const asked = brief;
    const unitSteps: number[] = [asked.units];
    if (info.units) {
      let u = asked.units;
      while (u > info.units.min) {
        u = Math.max(info.units.min, info.units.max <= 24 ? u - info.units.step : Math.min(u - info.units.step, Math.floor((u * 0.85) / info.units.step) * info.units.step));
        unitSteps.push(u);
      }
    }
    search: for (const parking of [...new Set([asked.parking, 0])]) {
      for (const features of asked.features.length ? [asked.features, []] : [asked.features]) {
        for (const units of unitSteps) {
          if (units === asked.units && features === asked.features && parking === asked.parking) continue;
          const tryBrief = normaliseBrief({ ...asked, units, features, parking });
          const found = tryAll(plot, tryBrief, cfg);
          if (!found.length) continue;
          if (features !== asked.features) notes.push(`To fit this plot, these designs leave out: ${asked.features.map((f) => FEATURES[f].label.toLowerCase()).join(', ')}.`);
          if (units !== asked.units && info.units) notes.push(`${asked.units} ${info.units.short} do not fit this plot within the setbacks and coverage limit, so these designs have ${units}.`);
          if (parking !== asked.parking) notes.push('To fit this plot, there is no parking in front of the building; plan for parking nearby.');
          brief = tryBrief; designs = found;
          break search;
        }
      }
    }
  }
  if (!designs.length) {
    notes.push(isHouse(brief.type)
      ? 'This programme does not fit the plot within the setbacks and site coverage limit. Try fewer rooms, two storeys or a larger plot.'
      : `This ${info.label.toLowerCase()} does not fit the plot within the setbacks and site coverage limit. Try a larger plot or more storeys.`);
  }
  else if (brief.bq && !designs.some((d) => d.blocks.some((b) => b.kind === 'outbuilding'))) {
    notes.push(`The boys' quarters does not fit behind the house with ${cfg.outbuilding.gapM} m clear and the coverage limit kept; it is left out.`);
  }
  return { designs, notes };
}

/** Every design the engine can make for this brief and plot that passes its checks, best first (the gallery shows them all). */
export function candidateDesigns(plot: Plot, briefIn: Partial<DesignBrief>, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): Design[] {
  return validPlot(plot) ? tryAll(plot, normaliseBrief(briefIn), cfg, Infinity) : [];
}

function tryAll(plot: Plot, brief: DesignBrief, cfg: DesignConfig, max = MAX_DESIGNS): Design[] {
  const candidates = isHouse(brief.type)
    ? [
      ...VARIANTS.map((v) => layout(plot, brief, cfg, v)),
      ...(brief.storeys === 1 ? L_VARIANTS.map((v) => lPlan(plot, brief, cfg, v)) : PAV_VARIANTS.map((v) => pavilion(plot, brief, cfg, v))),
    ]
    : typeVariants(brief.type).map((v) => layout(plot, brief, cfg, v));
  const out: Design[] = [];
  const seen = new Set<string>();
  for (const d of candidates) {
    if (!d || d.checks.some((c) => c.status === 'fail')) continue;
    const sig = `${d.typology}:${d.blocks.filter((b) => b.kind === 'house').map((b) => `${b.w.toFixed(1)}x${b.d.toFixed(1)}`).join('+')}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(d);
  }
  // Best first, as an architect would rank them; ties go to the squarer (cheaper to build) house.
  const squareness = (d: Design) => Math.max(d.footprint.w, d.footprint.d) / Math.min(d.footprint.w, d.footprint.d);
  out.sort((p, q) => q.review.score - p.review.score || squareness(p) - squareness(q));
  // Show different ideas, not four versions of one box: the best of each form first, then the next best.
  const varied: Design[] = [];
  for (const d of out) if (!varied.some((x) => x.typology === d.typology)) varied.push(d);
  const chosen = new Set([...varied, ...out].slice(0, max));
  return out.filter((d) => chosen.has(d));
}

/** Moves movable rooms from the longer band to the shorter while that shortens the house. */
function balance(f: { front: Item[]; rear: Item[] }, Df: number, Dr: number) {
  const front = [...f.front]; const rear = [...f.rear];
  const movable = (i: Item) => !['stair', 'lift', 'master', 'living', 'living-kitchen', 'dining', 'kitchen', 'lobby', 'toilets'].includes(i.kind);
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

/** The buildable area inside the setbacks, and where the house can start once the parking in front is kept clear. */
function siteFrame(plot: Plot, brief: DesignBrief, cfg: DesignConfig) {
  const sb = cfg.setbacksM;
  const parkDepth = brief.parking ? cfg.parking.depthM + 0.5 : 0;
  const envelope: Rect = { x: sb.side, y: sb.front, w: plot.widthM - 2 * sb.side, d: plot.depthM - sb.front - sb.rear };
  return { envelope, fy0: round(Math.max(envelope.y, parkDepth), 2) };
}

type Placed = Omit<Room, 'id'>;

/** Hallway plans: one rectangle, rooms in bands either side of a hallway (or one band beside it). */
function layout(plot: Plot, brief: DesignBrief, cfg: DesignConfig, v: Variant): Design | null {
  const { envelope, fy0 } = siteFrame(plot, brief, cfg);
  if (envelope.w < 4 || envelope.d < 6) return null;
  const across = v.orient === 'across';
  // The layout frame: a along the bands, b across them.
  const A0 = across ? envelope.x : fy0;
  const AL = across ? envelope.w : envelope.y + envelope.d - fy0;
  const B0 = across ? fy0 : envelope.x;
  const BL = across ? envelope.y + envelope.d - fy0 : envelope.w;

  const P = programmeFor(cfg, brief);
  if (!P.floors.length) return null;
  const corr = P.noCorridor ? 0 : P.corridorM;
  const ens = cfg.rooms.ensuite.minDimM;
  const masterStack = Math.max(0, ...P.floors.flatMap((f) => [...f.front, ...f.rear]).filter((i) => i.withEnsuite).map((i) => i.minDim + ens));
  const stairRun = brief.storeys >= 2 ? cfg.stair.minRunM : 0;
  const Df = round(Math.max(cfg.minBandM, v.depth), 2);
  const Dr = round(Math.max(cfg.minBandM, v.depthRear ?? v.depth, stairRun, masterStack), 2);
  // A single row puts every room in one band beside the hallway (a terrace keeps its own order: no hallway at all).
  const fl = v.single
    ? P.floors.map((f) => {
      const all = [...f.front, ...f.rear];
      const core = (i: Item) => (i.kind === 'stair' && i.name !== 'Escape stair') || i.kind === 'lift';
      const escape = (i: Item) => i.kind === 'stair' && i.name === 'Escape stair';
      return { front: [] as Item[], rear: P.noCorridor ? all : [...all.filter(core), ...all.filter((i) => !core(i) && !escape(i)), ...all.filter(escape)] };
    })
    : P.floors.map((f) => balance(f, Df, Dr));
  // Plan each band so neighbours work together (not for a terrace, whose houses and stairs alternate on purpose).
  if (!P.noCorridor) fl.forEach((f) => { f.front = arrange(f.front); f.rear = arrange(f.rear); });
  // The building is as long as its longest band needs: sized to the programme, not stretched to the plot.
  const L = round(Math.max(...fl.flatMap((f) => [bandLength(f.front, Df), bandLength(f.rear, Dr)])), 2);
  const Dt = round((v.single ? 0 : Df) + corr + Dr, 2);
  if (L > AL + 1e-6 || Dt > BL + 1e-6) return null;
  const a0 = round(across && v.mirror ? A0 + AL - L : A0, 2);
  const b0 = round(!across && v.mirror ? B0 + BL - Dt : B0, 2);
  const toPlan = (r: Local): Rect => (across ? { x: r.a, y: r.b, w: r.la, d: r.lb } : { x: r.b, y: r.a, w: r.lb, d: r.la });
  const block: Block = { id: 'b1', name: isHouse(brief.type) ? 'House' : typeOf(brief).label, kind: 'house', storeys: fl.length, ...roundRect(toPlan({ a: a0, b: b0, la: L, lb: Dt })), ridge: 'x' };
  block.ridge = block.w >= block.d ? 'x' : 'y';

  const rooms: Placed[] = [];
  const place = (kind: RoomKind, name: string, storey: number, r: Local) => rooms.push({ kind, name, storey, block: block.id, ...roundRect(toPlan(r)) });
  fl.forEach((f, s) => {
    const order = (items: Item[]) => (v.mirror && across ? [...items].reverse() : items);
    let b = b0;
    if (!v.single) {
      for (const x of layBand(order(f.front), { a: a0, b, la: L, lb: Df }, 'end', cfg, P.filler)) place(x.item.kind, x.item.name, s, x.r);
      b = round(b + Df, 3);
    }
    if (corr) {
      place('corridor', s === 0 ? P.corridorNames[0] : P.corridorNames[1], s, { a: a0, b, la: L, lb: corr });
      b = round(b + corr, 3);
    }
    for (const x of layBand(order(f.rear), { a: a0, b, la: L, lb: Dr }, 'start', cfg, P.filler)) {
      place(x.item.kind, x.item.name, s, x.r);
      if (x.ensuite) place('ensuite', 'Ensuite', s, x.ensuite);
    }
  });
  const typology: Design['typology'] = isHouse(brief.type) ? 'hallway' : P.noCorridor ? 'row' : 'core';
  return finish(plot, brief, cfg, envelope, { key: v.key, name: v.name, blurb: v.blurb, typology }, [block], rooms);
}

interface LVariant { key: string; name: string; depth: number; single: boolean; mirror: boolean; blurb: string }
const L_VARIANTS: LVariant[] = [
  { key: 'l-plan', name: 'L-plan', depth: 4.2, single: false, mirror: false, blurb: 'Living rooms across the front and the bedrooms in their own wing behind, around a private garden.' },
  { key: 'l-gallery', name: 'Garden L', depth: 3.9, single: true, mirror: true, blurb: 'A single row of bedrooms off a gallery that looks onto the side garden; every bedroom has its own outside wall.' },
];

/**
 * L-plan bungalows: a living wing across the front (living, dining, kitchen) and a bedroom wing running back
 * along one side, its hallway opening off the living room. Bedrooms stay away from guests and the street.
 */
function lPlan(plot: Plot, brief: DesignBrief, cfg: DesignConfig, v: LVariant): Design | null {
  if (brief.storeys !== 1) return null;
  const { envelope, fy0 } = siteFrame(plot, brief, cfg);
  if (envelope.w < 9 || envelope.d < 10) return null;
  const c = cfg.corridorM;
  const masterStack = brief.ensuite ? cfg.rooms.master.minDimM + cfg.rooms.ensuite.minDimM : 0;
  const Dp = round(Math.max(cfg.minBandM, v.depth), 2);
  const D = round(Math.max(cfg.minBandM, v.depth, masterStack), 2);
  const [prog] = programme(cfg, brief);
  const wc = prog!.front.filter((i) => i.kind === 'wc');
  // The living room must reach past the bedroom wing's hallway so the hallway opens off it.
  const reach = round(D + c + 0.3, 2);
  const pub = prog!.front.filter((i) => i.kind !== 'wc').map((i) => (i.kind === 'living' || i.kind === 'living-kitchen' ? { ...i, minDim: Math.max(i.minDim, reach) } : i));
  // The master goes to the far end of the bedroom wing: the quietest spot, with the wing's back wall for light.
  const priv = [...wc, ...prog!.rear.filter((i) => i.kind !== 'master'), ...prog!.rear.filter((i) => i.kind === 'master')];
  const bands0 = v.single ? { front: priv, rear: [] as Item[] } : balance({ front: priv, rear: [] }, D, D);
  const bands = { front: arrange(bands0.front), rear: arrange(bands0.rear) };
  const Lb = round(Math.max(bandLength(bands.front, D), bandLength(bands.rear, D)), 2);
  const Wb = round(v.single ? D + c : 2 * D + c, 2);
  // The living wing runs at least a room's width past the bedroom wing, or it would just be a rectangle.
  const Lp = round(Math.max(bandLength(pub, Dp), Wb + cfg.rooms.bedroom.minDimM), 2);
  if (Lp > envelope.w + 1e-6 || Dp + Lb > envelope.y + envelope.d - fy0 + 1e-6) return null;

  const x0 = envelope.x;
  const pubBlock: Block = { id: 'b1', name: 'Living wing', kind: 'house', storeys: 1, ...roundRect({ x: x0, y: fy0, w: Lp, d: Dp }), ridge: 'x' };
  const bedBlock: Block = { id: 'b2', name: 'Bedroom wing', kind: 'house', storeys: 1, ...roundRect({ x: x0, y: fy0 + Dp, w: Wb, d: Lb }), ridge: 'y' };
  const rooms: Placed[] = [];
  for (const x of layBand(pub, { a: x0, b: fy0, la: Lp, lb: Dp }, 'end', cfg)) {
    rooms.push({ kind: x.item.kind, name: x.item.name, storey: 0, block: pubBlock.id, ...roundRect({ x: x.r.a, y: x.r.b, w: x.r.la, d: x.r.lb }) });
  }
  // Bedroom wing in its own frame: a runs back into the plot (y), b across it (x).
  const along = (r: Local): Rect => roundRect({ x: r.b, y: r.a, w: r.lb, d: r.la });
  const y1 = round(fy0 + Dp, 3);
  const putBand = (items: Item[], b: number, side: 'start' | 'end') => {
    for (const x of layBand(items, { a: y1, b, la: Lb, lb: D }, side, cfg)) {
      rooms.push({ kind: x.item.kind, name: x.item.name, storey: 0, block: bedBlock.id, ...along(x.r) });
      if (x.ensuite) rooms.push({ kind: 'ensuite', name: 'Ensuite', storey: 0, block: bedBlock.id, ...along(x.ensuite) });
    }
  };
  putBand(bands.front, x0, 'end');
  rooms.push({ kind: 'corridor', name: 'Hallway', storey: 0, block: bedBlock.id, ...roundRect({ x: x0 + D, y: y1, w: c, d: Lb }) });
  if (!v.single) putBand(bands.rear, round(x0 + D + c, 3), 'start');

  let blocks = [pubBlock, bedBlock];
  let placed = rooms;
  if (v.mirror) {
    // Flip across the buildable area so the bedroom wing runs down the other side of the plot.
    const flip = <T extends Rect>(r: T): T => ({ ...r, x: round(envelope.x + envelope.w - (r.x - envelope.x) - r.w, 3) });
    blocks = blocks.map(flip); placed = placed.map(flip);
  }
  return finish(plot, brief, cfg, envelope, { key: v.key, name: v.name, blurb: v.blurb, typology: 'l-plan' }, blocks, placed);
}

interface PVariant { key: string; name: string; depth: number; pav: number; mirror: boolean; blurb: string }
const PAV_VARIANTS: PVariant[] = [
  { key: 'pavilion', name: 'Garden pavilion', depth: 4.2, pav: 5.0, mirror: false, blurb: 'A two-storey house beside a single-storey living pavilion that reaches into the garden: the day rooms get light and breeze from three sides.' },
  { key: 'pavilion-court', name: 'Pavilion and entry court', depth: 4.5, pav: 5.4, mirror: true, blurb: 'The living pavilion steps back from the street to make an entrance court by the front door; the bedrooms are upstairs in the main house.' },
];

/**
 * Pavilion plans (two or three storeys): the bedrooms, stair and service rooms in a compact main house, and the
 * living and dining rooms in a single-storey pavilion beside it. The pavilion starts at the line of the hallway, so
 * it steps back from the street and leaves an entrance court by the front door; the hallway runs straight into the
 * dining room, the kitchen sits at the pavilion end of the house sharing a wall with the dining room, and the living
 * room ends the pavilion on the garden side.
 */
function pavilion(plot: Plot, brief: DesignBrief, cfg: DesignConfig, v: PVariant): Design | null {
  if (!isHouse(brief.type) || brief.storeys < 2) return null;
  const { envelope, fy0 } = siteFrame(plot, brief, cfg);
  const floors = programme(cfg, brief);
  const g = floors[0]!;
  const ground = [...g.front, ...g.rear];
  const day = (i: Item) => i.kind === 'living' || i.kind === 'living-kitchen' || i.kind === 'dining';
  // The pavilion: dining first (it meets the hallway and the kitchen), the living room last (the garden end).
  const pav = [...ground.filter((i) => i.kind === 'dining' || i.kind === 'living-kitchen'), ...ground.filter((i) => i.kind === 'living')];
  if (!pav.length) return null;
  const c = cfg.corridorM;
  const ens = cfg.rooms.ensuite.minDimM;
  const masterStack = Math.max(0, ...floors.flatMap((f) => [...f.front, ...f.rear]).filter((i) => i.withEnsuite).map((i) => i.minDim + ens));
  const Df = round(Math.max(cfg.minBandM, v.depth), 2);
  const Dr = round(Math.max(cfg.minBandM, v.depth, cfg.stair.minRunM, masterStack), 2);
  const entry: Item = { kind: 'corridor', name: 'Entrance hall', target: 0, min: 0, minDim: 2.2, fixedW: 2.4, pinEnd: true };
  const core = ground.filter((i) => i.kind === 'stair' || i.kind === 'lift');
  const kitchen = ground.filter((i) => i.kind === 'kitchen').map((i) => ({ ...i, pinEnd: true }));
  // The guest WC goes in the back corner of the entrance hall (guests never pass the kitchen or a bedroom), when the
  // hall is deep enough to keep a proper lobby in front of it.
  const wcHall = Df >= 3.8 ? ground.filter((i) => i.kind === 'wc') : [];
  // The ground-floor store becomes the kitchen's pantry (it sits beside the kitchen; spare length widens it).
  const rest = ground.filter((i) => !day(i) && i.kind !== 'kitchen' && i.kind !== 'stair' && i.kind !== 'lift' && !wcHall.includes(i))
    .map((i) => (i.kind === 'store' && kitchen.length ? { ...i, name: 'Pantry and store' } : i));
  const pantry = (i: Item) => i.name === 'Pantry and store';
  const split0 = balance({ front: rest.filter((i) => !pantry(i)), rear: [...core, ...rest.filter(pantry)] }, Df, Dr);
  // The pantry stays in the kitchen's band whatever the balancing did.
  const split = { front: split0.front.filter((i) => !pantry(i)), rear: [...split0.rear, ...split0.front.filter(pantry)] };
  const fl = [
    { front: arrange([...split.front, entry]), rear: arrange([...split.rear, ...kitchen]) },
    ...floors.slice(1).map((f) => { const b = balance(f, Df, Dr); return { front: arrange(b.front), rear: arrange(b.rear) }; }),
  ];
  const L = round(Math.max(...fl.flatMap((f) => [bandLength(f.front, Df), bandLength(f.rear, Dr)])), 2);
  const Da = round(Df + c + Dr, 2);
  // Pavilion rooms run back from the hallway line; the dining room overlaps the kitchen enough for a door between them.
  const Wp = round(Math.max(v.pav, ...pav.map((i) => i.minDim)), 2);
  const lengths = pav.map((i, k) => round(Math.max(i.target / Wp, i.minDim, i.min / Wp, k === 0 && pav.length > 1 ? c + 1.6 : 0), 2));
  const Lp = round(lengths.reduce((x, y) => x + y, 0), 2);
  const yB = round(fy0 + Df, 2);
  if (L + Wp > envelope.w + 1e-6 || Math.max(fy0 + Da, yB + Lp) > envelope.y + envelope.d + 1e-6) return null;

  const x0 = envelope.x;
  const main: Block = { id: 'b1', name: 'Main house', kind: 'house', storeys: fl.length, ...roundRect({ x: x0, y: fy0, w: L, d: Da }), ridge: L >= Da ? 'x' : 'y' };
  const pv: Block = { id: 'b2', name: 'Living pavilion', kind: 'house', storeys: 1, ...roundRect({ x: x0 + L, y: yB, w: Wp, d: Lp }), ridge: 'y' };
  const rooms: Placed[] = [];
  const toPlan = (r: Local): Rect => roundRect({ x: r.a, y: r.b, w: r.la, d: r.lb });
  // Spare length in the service band: a home office if it fits, else a pantry when there is no store yet.
  const hasStore = ground.some((i) => i.kind === 'store');
  const service: Filler = { big: { kind: 'study', name: 'Home office' }, small: hasStore ? null : { kind: 'store', name: 'Pantry' } };
  fl.forEach((f, s) => {
    for (const x of layBand(f.front, { a: x0, b: fy0, la: L, lb: Df }, 'end', cfg)) {
      const r = toPlan(x.r);
      if (s === 0 && x.item.name === 'Entrance hall' && wcHall.length) {
        // Lobby across the front; behind it the WC on the court side (its window) and a short passage to the hallway.
        const wcD = round(Math.max(cfg.rooms.wc.minM2 / cfg.rooms.wc.minDimM, 1.8), 2);
        const wcW = round(Math.max(cfg.rooms.wc.minDimM, 1.0), 2);
        const yWc = round(r.y + r.d - wcD, 3);
        rooms.push({ kind: 'corridor', name: 'Entrance hall', storey: 0, block: main.id, ...roundRect({ x: r.x, y: r.y, w: r.w, d: yWc - r.y }) });
        rooms.push({ kind: 'corridor', name: 'Lobby', storey: 0, block: main.id, ...roundRect({ x: r.x, y: yWc, w: r.w - wcW, d: wcD }) });
        rooms.push({ kind: 'wc', name: wcHall[0]!.name, storey: 0, block: main.id, ...roundRect({ x: r.x + r.w - wcW, y: yWc, w: wcW, d: wcD }) });
        continue;
      }
      rooms.push({ kind: x.item.kind, name: x.item.name, storey: s, block: main.id, ...r });
    }
    rooms.push({ kind: 'corridor', name: s === 0 ? 'Hallway' : 'Landing', storey: s, block: main.id, ...roundRect({ x: x0, y: yB, w: L, d: c }) });
    for (const x of layBand(f.rear, { a: x0, b: round(yB + c, 3), la: L, lb: Dr }, 'start', cfg, s === 0 ? service : HOME_FILLER)) {
      rooms.push({ kind: x.item.kind, name: x.item.name, storey: s, block: main.id, ...toPlan(x.r) });
      if (x.ensuite) rooms.push({ kind: 'ensuite', name: 'Ensuite', storey: s, block: main.id, ...toPlan(x.ensuite) });
    }
  });
  let y = yB;
  pav.forEach((i, k) => {
    const d = k === pav.length - 1 ? round(yB + Lp - y, 3) : lengths[k]!;
    rooms.push({ kind: i.kind, name: i.name, storey: 0, block: pv.id, ...roundRect({ x: x0 + L, y, w: Wp, d }) });
    y = round(y + d, 3);
  });
  let blocks = [main, pv];
  let placed = rooms;
  if (v.mirror) {
    const flip = <T extends Rect>(r: T): T => ({ ...r, x: round(envelope.x + envelope.w - (r.x - envelope.x) - r.w, 3) });
    blocks = blocks.map(flip); placed = placed.map(flip);
  }
  return finish(plot, brief, cfg, envelope, { key: v.key, name: v.name, blurb: v.blurb, typology: 'pavilion' }, blocks, placed);
}

/** A boys' quarters at a back corner of the buildable area, kept clear of the house; null when it does not fit. */
function outbuildingFor(plot: Plot, cfg: DesignConfig, envelope: Rect, house: Block[]): { block: Block; rooms: Placed[] } | null {
  const o = cfg.outbuilding;
  const W = round(o.roomW + o.showerW, 3); const D = o.roomD;
  const houseM2 = house.reduce((s, b) => s + b.w * b.d, 0);
  if (((houseM2 + W * D) / (plot.widthM * plot.depthM)) * 100 > cfg.maxCoveragePct) return null;
  const y = round(envelope.y + envelope.d - D, 3);
  for (const x of [round(envelope.x + envelope.w - W, 3), envelope.x]) {
    const r: Rect = { x, y, w: W, d: D };
    if (r.y < envelope.y - 1e-6 || r.x < envelope.x - 1e-6) continue;
    if (!house.every((b) => clearance(b, r) >= o.gapM - 1e-6)) continue;
    const block: Block = { id: 'bq', name: "Boys' quarters", kind: 'outbuilding', storeys: 1, ...r, ridge: 'x' };
    // The shower sits on the outer side, so the room's door and window face into the plot.
    const showerFirst = x === envelope.x;
    const roomX = showerFirst ? round(x + o.showerW, 3) : x;
    const showerX = showerFirst ? x : round(x + o.roomW, 3);
    return {
      block,
      rooms: [
        { kind: 'bedroom', name: "Boys' quarters room", storey: 0, block: block.id, x: roomX, y, w: o.roomW, d: D },
        { kind: 'bathroom', name: "Boys' quarters shower and WC", storey: 0, block: block.id, x: showerX, y, w: o.showerW, d: D },
      ],
    };
  }
  return null;
}

/** Clear distance between two rectangles (0 when they touch or overlap). */
function clearance(a: Rect, b: Rect): number {
  const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w));
  const dy = Math.max(0, b.y - (a.y + a.d), a.y - (b.y + b.d));
  return Math.hypot(dx, dy);
}

/** Everything after the rooms are placed: outbuilding, parking, walls, openings, metrics, checks and the review. */
function finish(plot: Plot, brief: DesignBrief, cfg: DesignConfig, envelope: Rect,
  meta: { key: string; name: string; blurb: string; typology: Design['typology'] }, houseBlocks: Block[], placed: Placed[]): Design {
  const blocks = [...houseBlocks];
  const all = [...placed];
  if (brief.bq) {
    const bq = outbuildingFor(plot, cfg, envelope, houseBlocks);
    if (bq) { blocks.push(bq.block); all.push(...bq.rooms); }
  }
  const rooms: Room[] = all.map((r, i) => ({ id: `r${i + 1}`, ...r }));
  const storeys = Math.max(...houseBlocks.map((b) => b.storeys));
  const bq = blocks.some((b) => b.kind === 'outbuilding');
  const id = isHouse(brief.type) ? `${meta.key}-${storeys}s-${brief.bedrooms}b${bq ? '-bq' : ''}` : `${brief.type}-${meta.key}-${storeys}s-${brief.units}u`;
  return assemble(plot, brief, cfg, envelope, blocks, rooms, { id, name: meta.name, blurb: meta.blurb, typology: meta.typology, edits: 0 });
}

/** Rebuilds everything that follows from the rooms: parking, walls, openings, metrics, roof, checks and the review. */
function assemble(plot: Plot, brief: DesignBrief, cfg: DesignConfig, envelope: Rect, blocks: Block[], roomsIn: Room[],
  meta: { id: string; name: string; blurb: string; typology: Design['typology']; edits: number; elements?: ArchElement[]; finishes?: BlockFinish[] }): Design {
  // Designs without their own architecture (BuildWise's engine) get it from the style: glazing first, so the
  // windows follow; porches, balconies and the rest after the openings are known.
  const own = meta.elements !== undefined;
  const plan = own ? null : architecturePlan(roomsIn, brief);
  const rooms = plan ? roomsIn.map((r) => (plan.glazing.has(r.id) && !r.glazing ? { ...r, glazing: plan.glazing.get(r.id)! } : r)) : roomsIn;
  const houseBlocks = blocks.filter((b) => b.kind === 'house');
  const storeys = Math.max(...houseBlocks.map((b) => b.storeys));
  const footprint = bbox(houseBlocks);

  const house = isHouse(brief.type);
  const parking: Rect[] = [];
  // Houses park in front of the house; larger buildings use one row across the whole frontage.
  const startX = house ? footprint.x : 0.3;
  for (let i = 0; i < brief.parking; i++) {
    const px = startX + i * (cfg.parking.widthM + 0.3);
    if (px + cfg.parking.widthM <= plot.widthM - 0.3) parking.push({ x: round(px, 2), y: round(Math.max(0.3, footprint.y - cfg.parking.depthM - 0.3), 2), w: cfg.parking.widthM, d: cfg.parking.depthM });
  }

  const walls = wallsFor(rooms, storeys, cfg);
  const openings = openingsFor(rooms, cfg, house);
  const area = (bs: Block[]) => bs.reduce((s, b) => s + b.w * b.d, 0);
  const footprintM2 = round(area(houseBlocks), 1);
  const metrics = {
    footprintM2,
    grossFloorM2: round(blocks.reduce((s, b) => s + b.w * b.d * b.storeys, 0), 1),
    coveragePct: round((area(blocks) / (plot.widthM * plot.depthM)) * 100, 1),
    plotM2: round(plot.widthM * plot.depthM, 1),
  };
  const main = [...houseBlocks].sort((p, q) => q.w * q.d - p.w * p.d)[0]!;
  const roof: Roof = {
    kind: brief.roof, pitchDeg: brief.roofPitch, overhangM: cfg.roof.overhangM,
    parapetM: brief.roof === 'hidden' ? cfg.roof.hiddenParapetM : cfg.roof.parapetM,
    ridge: main.ridge, finish: brief.roofFinish, colour: roofHex(brief),
  };
  const houseIds = new Set(houseBlocks.map((b) => b.id));
  const beds = rooms.filter((r) => houseIds.has(r.block) && (r.kind === 'bedroom' || r.kind === 'master')).length;
  const extra = blocks.some((b) => b.kind === 'outbuilding') ? " Boys' quarters at the back." : '';
  const what = house ? `${beds}-bedroom ${storeys === 1 ? 'bungalow' : storeys === 2 ? 'two-storey house' : `${storeyWord(storeys)}-storey house`}` : describeBuilding(brief, rooms, storeys);
  const design: Design = {
    id: meta.id,
    name: meta.name,
    summary: `${what}, ${metrics.grossFloorM2} m². ${meta.blurb}${extra}${meta.edits ? ` Adjusted by you (${meta.edits} change${meta.edits > 1 ? 's' : ''}).` : ''}`,
    typology: meta.typology, blurb: meta.blurb, edits: meta.edits,
    plot, brief, envelope, footprint, blocks, parking, storeys, storeyHeightM: house ? cfg.storeyHeightM : typeOf(brief).storeyHeightM, slabM: cfg.slabM,
    rooms, walls, openings, roof, metrics, checks: [], review: { score: 0, highlights: [], considerations: [], source: 'engine' },
    elements: [], finishes: [],
  };
  if (own) { design.elements = meta.elements!; design.finishes = meta.finishes ?? defaultFinishes(blocks, brief); }
  else { const a = defaultArchitecture(design, plan!, cfg); design.elements = a.elements; design.finishes = a.finishes; }
  design.checks = checkDesign(design, cfg);
  design.review = reviewDesign(design, cfg);
  return design;
}

// ---------------------------------------------------------------- default architecture (by style and type)

const LIVING_KINDS: ReadonlySet<RoomKind> = new Set(['living', 'living-kitchen', 'lounge', 'dining']);

/** Which rooms get generous glazing, and which get a balcony, before the windows are placed. */
function architecturePlan(rooms: Room[], brief: DesignBrief): { glazing: Map<string, Glazing>; balconies: Set<string> } {
  const glazing = new Map<string, Glazing>();
  const balconies = new Set<string>();
  const house = isHouse(brief.type) || brief.type === 'terrace';
  const outer = (r: Room) => outsidePieces(r, rooms).filter((e) => (e.side === 'front' || e.side === 'rear') && e.to - e.from >= 2.4);
  for (const r of rooms) {
    if (r.storey === 0 && LIVING_KINDS.has(r.kind)) glazing.set(r.id, brief.style === 'classic' ? 'large' : 'full-height');
    if (r.storey === 0 && r.kind === 'shop') glazing.set(r.id, 'full-height');
    if (['open-office', 'classroom', 'restaurant', 'lobby', 'meeting'].includes(r.kind)) glazing.set(r.id, 'large');
  }
  const upper = rooms.filter((r) => r.storey > 0 && outer(r).length);
  // Homes: the master suite and an upstairs lounge first; when neither has a front or back wall, a bedroom does.
  const wants = house
    ? [...upper.filter((r) => r.kind === 'master' || r.kind === 'lounge'), ...upper.filter((r) => r.kind === 'bedroom')].slice(0, 2)
    : upper.filter((r) => r.kind === 'flat' || r.kind === 'guest-room' || r.kind === 'ward').slice(0, 80);
  for (const r of wants) { balconies.add(r.id); glazing.set(r.id, 'full-height'); }
  return { glazing, balconies };
}

function defaultFinishes(blocks: Block[], brief: DesignBrief): BlockFinish[] {
  const commercial = !isHouse(brief.type) && brief.type !== 'terrace' && brief.type !== 'apartments';
  const by: Record<DesignBrief['style'], Omit<BlockFinish, 'block'>> = commercial
    ? { modern: { walls: 'render-grey', base: 'concrete', accent: 'metal-dark' }, tropical: { walls: 'render-white', base: 'stone', accent: 'timber' }, classic: { walls: 'render-cream', base: 'stone', accent: 'render-white' } }
    : { modern: { walls: 'render-white', base: 'render-charcoal', accent: 'timber' }, tropical: { walls: 'render-white', base: 'stone', accent: 'timber' }, classic: { walls: 'render-cream', base: 'stone', accent: 'render-white' } };
  return blocks.map((b) => ({ block: b.id, ...by[brief.style] }));
}

/** A rectangle projecting `depth` metres out from an outside edge (centred along it, `width` long). */
function projectFrom(e: Edge, depth: number, width: number): Rect {
  const len = e.to - e.from; const w = Math.min(width, len); const a = round(e.from + (len - w) / 2, 2);
  switch (e.side) {
    case 'front': return { x: a, y: round(e.at - depth, 2), w, d: depth };
    case 'rear': return { x: a, y: round(e.at, 2), w, d: depth };
    case 'left': return { x: round(e.at - depth, 2), y: a, w: depth, d: w };
    default: return { x: round(e.at, 2), y: a, w: depth, d: w };
  }
}

/** Porch or canopy at the entrance, balconies, a veranda or pergola to the garden, a feature wall and finishes. */
function defaultArchitecture(d: Design, plan: { balconies: Set<string> }, cfg: DesignConfig): { elements: ArchElement[]; finishes: BlockFinish[] } {
  const b = d.brief; const house = isHouse(b.type);
  const finishes = defaultFinishes(d.blocks, b);
  const accent = finishes[0]?.accent ?? 'timber';
  const els: Omit<ArchElement, 'id'>[] = [];
  const pieceOf = (roomId: string, o: Opening): Edge | undefined => {
    const r = d.rooms.find((x) => x.id === roomId);
    return r ? outsidePieces(r, d.rooms).find((e) => e.dir === o.dir && Math.abs(e.at - o.at) < 1e-6 && e.from <= o.from + 1e-6 && e.to >= o.to - 1e-6) : undefined;
  };
  // Entrance: a porch on columns for tropical and classic homes, a crisp canopy otherwise.
  const entry = d.openings.find((o) => o.storey === 0 && (o.label === 'Front door' || o.label === 'Main entrance'));
  const ep = entry ? pieceOf(entry.roomId, entry) : undefined;
  if (entry && ep) {
    const porch = house && b.style !== 'modern';
    els.push({ kind: porch ? 'porch' : 'canopy', storey: 0, ...projectFrom({ ...ep, from: entry.from - (porch ? 1.5 : 0.9), to: entry.to + (porch ? 1.5 : 0.9) }, porch ? 2.4 : 1.4, (entry.to - entry.from) + (porch ? 3 : 1.8)), heightM: porch ? undefined : entry.headM + 0.25, material: porch ? accent : 'metal-dark', label: porch ? 'Entrance porch' : 'Entrance canopy' });
  }
  // Balconies off upper rooms (cantilevered slabs with a rail).
  for (const id of plan.balconies) {
    const r = d.rooms.find((x) => x.id === id);
    if (!r) continue;
    const e = outsidePieces(r, d.rooms).filter((x) => x.side === 'front' || x.side === 'rear').sort((p, q) => (q.to - q.from) - (p.to - p.from))[0];
    if (e) els.push({ kind: 'balcony', storey: r.storey, ...projectFrom(e, house ? 1.5 : 1.2, house ? 4.2 : Math.max(2, (e.to - e.from) * 0.75)), material: 'metal-dark', label: `${r.name} balcony` });
  }
  // The garden side of the main living room: a veranda (tropical), else a pergola.
  if (house || b.type === 'terrace') {
    // The living room's garden or side wall, else any ground-floor room's back wall.
    const pick = (ok: (r: Room) => boolean, sides: Edge['side'][]) => {
      for (const r of d.rooms.filter((x) => x.storey === 0 && ok(x))) {
        const e = outsidePieces(r, d.rooms).filter((x) => sides.includes(x.side) && x.to - x.from >= 3).sort((p, q) => sides.indexOf(p.side) - sides.indexOf(q.side) || (q.to - q.from) - (p.to - p.from))[0];
        if (e) return e;
      }
      return undefined;
    };
    const e = pick((r) => LIVING_KINDS.has(r.kind), ['rear', 'left', 'right']) ?? pick((r) => HABITABLE.has(r.kind), ['rear']);
    if (e) els.push(b.style === 'tropical'
      ? { kind: 'veranda', storey: 0, ...projectFrom(e, 2.4, e.to - e.from), material: 'timber', label: 'Garden veranda' }
      : { kind: 'pergola', storey: 0, ...projectFrom(e, 3, Math.min(6, e.to - e.from)), heightM: 2.7, material: b.style === 'classic' ? 'render-white' : 'timber', label: 'Garden pergola' });
  }
  // A feature wall beside the entrance (modern and commercial), and a louvre screen over a stair window.
  if (ep && (b.style === 'modern' || !house) && b.type !== 'terrace') {
    const block = d.blocks.find((x) => x.id === d.rooms.find((r) => r.id === entry!.roomId)?.block);
    const h = (block?.storeys ?? 1) * d.storeyHeightM;
    const side = entry!.from - ep.from > ep.to - entry!.to ? { ...ep, to: entry!.from - 0.3 } : { ...ep, from: entry!.to + 0.3 };
    if (side.to - side.from >= 1.2) els.push({ kind: 'feature-wall', storey: 0, ...projectFrom(side, 0.12, Math.min(3, side.to - side.from)), heightM: round(h, 2), material: house ? 'stone' : accent, label: 'Feature wall' });
  }
  const stair = d.rooms.find((r) => r.kind === 'stair' && r.storey === 0 && outsidePieces(r, d.rooms).some((e) => e.to - e.from >= 1));
  if (stair && d.storeys > 1 && b.style !== 'classic') {
    const e = outsidePieces(stair, d.rooms).sort((p, q) => (q.to - q.from) - (p.to - p.from))[0]!;
    els.push({ kind: 'screen', storey: 0, ...projectFrom(e, 0.15, Math.min(2.4, e.to - e.from)), heightM: round(d.storeys * d.storeyHeightM, 2), material: accent, label: 'Stair screen' });
  }
  // Keep everything on the plot; an outdoor room clipped too shallow to use is left out.
  const W = d.plot.widthM; const Dp = d.plot.depthM;
  const kept = els.map((e) => {
    const x = Math.max(0.2, e.x); const y = Math.max(0.2, e.y);
    const x2 = Math.min(W - 0.2, e.x + e.w); const y2 = Math.min(Dp - 0.2, e.y + e.d);
    return { ...e, x: round(x, 2), y: round(y, 2), w: round(x2 - x, 2), d: round(y2 - y, 2) };
  }).filter((e) => e.w > 0.05 && e.d > 0.05 && (['screen', 'feature-wall', 'planter'].includes(e.kind) || Math.min(e.w, e.d) >= 0.9));
  return { elements: kept.map((x, i) => ({ id: `e${i + 1}`, ...x })), finishes };
}

/** The buildable area inside the setbacks, and the front depth kept for parking. */
export function siteLimits(plot: Plot, brief: Partial<DesignBrief>, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): { envelope: Rect; forecourtY: number } {
  const f = siteFrame(plot, normaliseBrief(brief), cfg);
  return { envelope: f.envelope, forecourtY: f.fy0 };
}

/** The rooms the brief asks for, floor by floor (what the engine would lay out), for an AI architect to work from. */
export function requiredRooms(brief: Partial<DesignBrief>, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG) {
  const b = normaliseBrief(brief);
  const P = programmeFor(cfg, b);
  return {
    corridorM: P.noCorridor ? 0 : P.corridorM,
    floors: P.floors.map((f, storey) => ({ storey, rooms: [...f.front, ...f.rear].map((i) => ({ kind: i.kind, name: i.name, areaM2: round(i.fixedW ? i.fixedW * cfg.stair.minRunM : i.target, 1) })) })),
  };
}

/** Builds a design from blocks and rooms composed elsewhere (an AI architect): walls, doors, windows, checks, review. */
export function assembleFromRooms(plot: Plot, briefIn: Partial<DesignBrief>, blocks: Block[], rooms: Room[], meta: { id: string; name: string; blurb: string; elements?: ArchElement[]; finishes?: BlockFinish[] }, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): Design {
  const brief = normaliseBrief(briefIn);
  const { envelope } = siteFrame(plot, brief, cfg);
  return assemble(plot, brief, cfg, envelope, blocks.map((b) => ({ ...b, ...roundRect(b) })), rooms.map((r) => ({ ...r, ...roundRect(r) })), { ...meta, typology: 'ai', edits: 0, elements: meta.elements ?? [], finishes: meta.finishes });
}

const WORDS = ['', 'single', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
/** "three" for 3, "12" past ten: for "three-storey". */
export const storeyWord = (n: number) => WORDS[n] ?? String(n);

/** One line on what a non-house building holds: "4-storey block of 16 flats (2-bed)". */
export function describeBuilding(brief: DesignBrief, rooms: Pick<Room, 'kind'>[], storeys: number): string {
  const info = typeOf(brief);
  const count = (k: RoomKind) => rooms.filter((r) => r.kind === k).length;
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const tall = storeys === 1 ? 'single-storey' : `${storeyWord(storeys)}-storey`;
  switch (brief.type) {
    case 'terrace': return `Terrace of ${plural(count('living-kitchen'), 'house')}, ${tall}, ${brief.bedrooms} bedrooms each`;
    case 'apartments': return `${tall[0]!.toUpperCase()}${tall.slice(1)} block of ${plural(count('flat'), 'flat')} (${brief.bedrooms}-bed)`;
    case 'shops': return `${tall[0]!.toUpperCase()}${tall.slice(1)} plaza with ${plural(count('shop'), 'shop')}`;
    case 'office': return `${tall[0]!.toUpperCase()}${tall.slice(1)} office building with ${plural(count('open-office'), 'office suite')}`;
    case 'mixed-use': return `${tall[0]!.toUpperCase()}${tall.slice(1)} mixed-use building: ${plural(count('shop'), 'shop')} below, ${count('flat') ? plural(count('flat'), 'flat') : plural(count('open-office'), 'office suite')} above`;
    case 'warehouse': return `${tall[0]!.toUpperCase()}${tall.slice(1)} warehouse with about ${brief.units} m² of storage`;
    case 'hotel': return `${tall[0]!.toUpperCase()}${tall.slice(1)} hotel with ${plural(count('guest-room'), 'guest room')}`;
    case 'event-hall': return `Event centre seating ${brief.units}`;
    case 'school': return `${tall[0]!.toUpperCase()}${tall.slice(1)} school with ${plural(count('classroom'), 'classroom')}`;
    case 'clinic': return `${tall[0]!.toUpperCase()}${tall.slice(1)} clinic with ${plural(count('consult'), 'consulting room')}${count('ward') ? ` and ${plural(count('ward'), 'ward')}` : ''}`;
    case 'worship': return `${info.label} seating ${brief.units}`;
    default: return info.label;
  }
}

/**
 * Recomputes a design after its blocks or rooms changed (the editor): walls, doors, windows, parking, metrics,
 * roof, checks and review all follow from the rooms. `edits` is how many of the person's changes it carries.
 */
export function rebuildDesign(d: Design, blocks: Block[], rooms: Room[], edits: number, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): Design {
  const fixed = blocks.map((b) => ({ ...b, ...roundRect(b), ridge: (b.w >= b.d ? 'x' : 'y') as Block['ridge'] }));
  const keep = d.typology === 'ai' ? { elements: d.elements, finishes: d.finishes } : {};
  return assemble(d.plot, d.brief, cfg, d.envelope, fixed, rooms.map((r) => ({ ...r, ...roundRect(r) })), { id: d.id, name: d.name, blurb: d.blurb, typology: d.typology, edits, ...keep });
}

function bbox(rs: Rect[]): Rect {
  const x = Math.min(...rs.map((r) => r.x)); const y = Math.min(...rs.map((r) => r.y));
  return roundRect({ x, y, w: Math.max(...rs.map((r) => r.x + r.w)) - x, d: Math.max(...rs.map((r) => r.y + r.d)) - y });
}

function roundRect(r: Rect): Rect { return { x: round(r.x, 3), y: round(r.y, 3), w: round(r.w, 3), d: round(r.d, 3) }; }

// ---------------------------------------------------------------- walls and openings

const key = (n: number) => Math.round(n * 1000);

/** Strictly inside a rectangle (points on its edge are not). */
const within = (r: Rect, x: number, y: number) => x > r.x + 1e-4 && x < r.x + r.w - 1e-4 && y > r.y + 1e-4 && y < r.y + r.d - 1e-4;
/** A probe this far either side of a plan line tells which side has a room. */
const PROBE = 0.05;

/**
 * Unions every room edge per plan line, so a wall shared by two rooms is one wall. A stretch of wall is external
 * when one side of it is open air (no room of that storey), which works for any arrangement of wings.
 */
function wallsFor(rooms: Room[], storeys: number, cfg: DesignConfig): Wall[] {
  const walls: Wall[] = [];
  let n = 0;
  for (let s = 0; s < storeys; s++) {
    const here = rooms.filter((x) => x.storey === s);
    const inside = (x: number, y: number) => here.some((r) => within(r, x, y));
    const lines = new Map<string, { dir: 'h' | 'v'; at: number; spans: [number, number][] }>();
    const add = (dir: 'h' | 'v', at: number, a: number, b: number) => {
      const k = `${dir}:${key(at)}`;
      const l = lines.get(k) ?? { dir, at, spans: [] };
      l.spans.push([Math.min(a, b), Math.max(a, b)]);
      lines.set(k, l);
    };
    for (const r of here) {
      add('h', r.y, r.x, r.x + r.w); add('h', r.y + r.d, r.x, r.x + r.w);
      add('v', r.x, r.y, r.y + r.d); add('v', r.x + r.w, r.y, r.y + r.d);
    }
    for (const l of lines.values()) {
      // Cut the line at every span end, keep the pieces some room touches, and classify each by its two sides.
      const cuts = [...new Set(l.spans.flatMap(([a, b]) => [key(a), key(b)]))].sort((p, q) => p - q).map((k) => k / 1000);
      const pieces: { a: number; b: number; external: boolean }[] = [];
      for (let i = 0; i + 1 < cuts.length; i++) {
        const a = cuts[i]!; const b = cuts[i + 1]!;
        const mid = (a + b) / 2;
        if (!l.spans.some(([p, q]) => p <= mid && q >= mid)) continue;
        const [x1, y1, x2, y2] = l.dir === 'h' ? [mid, l.at - PROBE, mid, l.at + PROBE] : [l.at - PROBE, mid, l.at + PROBE, mid];
        const external = !(inside(x1, y1) && inside(x2, y2));
        const last = pieces[pieces.length - 1];
        if (last && Math.abs(last.b - a) < 1e-6 && last.external === external) last.b = b;
        else pieces.push({ a, b, external });
      }
      for (const p of pieces) {
        if (p.b - p.a < 0.05) continue;
        walls.push({ id: `w${++n}`, storey: s, dir: l.dir, at: round(l.at, 3), from: round(p.a, 3), to: round(p.b, 3), thickness: p.external ? cfg.wallM.external : cfg.wallM.internal, external: p.external });
      }
    }
  }
  return walls;
}

type Side = 'front' | 'rear' | 'left' | 'right';
type Edge = { side: Side; dir: 'h' | 'v'; at: number; from: number; to: number };

function edges(r: Rect): Edge[] {
  return [
    { side: 'front', dir: 'h', at: r.y, from: r.x, to: r.x + r.w },
    { side: 'rear', dir: 'h', at: r.y + r.d, from: r.x, to: r.x + r.w },
    { side: 'left', dir: 'v', at: r.x, from: r.y, to: r.y + r.d },
    { side: 'right', dir: 'v', at: r.x + r.w, from: r.y, to: r.y + r.d },
  ];
}

const OUTWARD: Record<Side, [number, number]> = { front: [0, -1], rear: [0, 1], left: [-1, 0], right: [1, 0] };

/** The parts of a room's edges with open air beyond them: where outside doors and windows can go. */
function outsidePieces(r: Room, rooms: Room[]): Edge[] {
  const others = rooms.filter((o) => o.storey === r.storey && o.id !== r.id);
  const out: Edge[] = [];
  for (const e of edges(r)) {
    const cuts = new Set([key(e.from), key(e.to)]);
    for (const o of others) for (const v of e.dir === 'h' ? [o.x, o.x + o.w] : [o.y, o.y + o.d]) if (v > e.from && v < e.to) cuts.add(key(v));
    const ks = [...cuts].sort((p, q) => p - q).map((k) => k / 1000);
    const [nx, ny] = OUTWARD[e.side];
    for (let i = 0; i + 1 < ks.length; i++) {
      const a = ks[i]!; const b = ks[i + 1]!; const mid = (a + b) / 2;
      const [px, py] = e.dir === 'h' ? [mid, e.at + ny * PROBE] : [e.at + nx * PROBE, mid];
      if (others.some((o) => within(o, px, py))) continue;
      const last = out[out.length - 1];
      if (last && last.side === e.side && Math.abs(last.to - a) < 1e-6) last.to = b;
      else out.push({ ...e, from: a, to: b });
    }
  }
  return out;
}

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

/** Rooms other rooms may open off when no hallway reaches them, best first. */
const HUBS: RoomKind[] = ['living', 'living-kitchen', 'dining', 'lounge', 'lobby', 'hall', 'open-office', 'restaurant', 'warehouse'];
/** Rooms lit by small high windows only. */
const HIGH_LIT: ReadonlySet<RoomKind> = new Set(['store', 'stair', 'plant', 'loading', 'laundry']);

function openingsFor(rooms: Room[], cfg: DesignConfig, house = true): Opening[] {
  const out: Opening[] = [];
  let n = 0;
  const add = (o: Omit<Opening, 'id'>) => out.push({ id: `o${++n}`, ...o });
  const centred = (from: number, to: number, w: number) => { const c = (from + to) / 2; return [round(c - w / 2, 3), round(c + w / 2, 3)] as const; };
  const door = (r: Room, e: Edge, w: number, external: boolean, label: string, at: 'centre' | 'end' = 'centre') => {
    const width = Math.min(w, e.to - e.from - 0.2);
    const [a, b] = at === 'centre' ? centred(e.from, e.to, width) : [round(e.to - 0.3 - width, 3), round(e.to - 0.3, 3)];
    add({ storey: r.storey, kind: 'door', dir: e.dir, at: round(e.at, 3), from: a, to: b, sillM: 0, headM: cfg.doorHeightM, external, roomId: r.id, label });
  };
  const longest = (es: Edge[]) => [...es].sort((p, q) => (q.to - q.from) - (p.to - p.from))[0];
  // Street-facing first: the lowest front edge, then the longest.
  const streetward = (es: Edge[]) => es.filter((e) => e.side === 'front').sort((p, q) => p.at - q.at || (q.to - q.from) - (p.to - p.from))[0];
  const outsideOf = new Map(rooms.map((r) => [r.id, outsidePieces(r, rooms)]));

  for (const r of rooms) {
    if (r.kind === 'corridor') continue;
    const same = rooms.filter((o) => o.storey === r.storey && o.id !== r.id);
    const outside = outsideOf.get(r.id)!;
    // Door: from a hallway; else off a living space; a wet room in an outbuilding off its room; else from outside.
    if (r.kind === 'ensuite') {
      const master = same.find((m) => m.kind === 'master' && shared(r, m));
      if (master) door(r, shared(r, master)!, cfg.doorM.wet, false, 'Ensuite door');
    } else if (r.kind !== 'stair' && r.kind !== 'lift') {
      const width = WET.has(r.kind) ? cfg.doorM.wet : cfg.doorM.internal;
      const hall = same.find((c) => c.kind === 'corridor' && shared(r, c));
      const hub = HUBS.map((k) => same.find((h) => h.kind === k && h.block === r.block && shared(r, h))).find(Boolean);
      const host = WET.has(r.kind) ? same.find((h) => (h.kind === 'bedroom' || h.kind === 'master') && h.block === r.block && shared(r, h)) : undefined;
      const living = r.kind === 'living' || r.kind === 'living-kitchen';
      // Upper floors with no landing open off their stair (each house in a terrace).
      const landing = r.storey > 0 ? same.find((st) => st.kind === 'stair' && shared(r, st)) : undefined;
      if (hall) door(r, shared(r, hall)!, width, false, `${r.name} door`);
      else if (hub && !living) door(r, shared(r, hub)!, width, false, `${r.name} door`);
      else if (host) door(r, shared(r, host)!, width, false, `${r.name} door`);
      else if (landing) door(r, shared(r, landing)!, width, false, `${r.name} door`);
      else if (!living && r.storey === 0) {
        const e = streetward(outside) ?? longest(outside);
        if (e) door(r, e, cfg.doorM.external, true, `${r.name} entrance`);
      }
    }
    // Front door into the living space (on the street side when it reaches it), else into the hallway.
    if (r.storey === 0 && (r.kind === 'living' || r.kind === 'living-kitchen')) {
      const front = streetward(outside);
      // The living room's own hallway, else an entrance hall elsewhere that reaches the street (a pavilion plan).
      const hall = rooms.find((c) => c.kind === 'corridor' && c.storey === 0 && c.block === r.block)
        ?? rooms.find((c) => c.kind === 'corridor' && c.storey === 0 && !!streetward(outsideOf.get(c.id)!));
      const hallFront = hall ? streetward(outsideOf.get(hall.id)!) : undefined;
      if (front) door(r, front, cfg.doorM.entrance, true, 'Front door');
      else if (hall && hallFront) door(hall, hallFront, Math.min(cfg.doorM.entrance, hall.w - 0.2), true, 'Front door');
      else if (outside.length) door(r, longest(outside)!, cfg.doorM.entrance, true, 'Front door');
    }
    // A living room with no door yet opens wide off the dining room or lounge beside it.
    if (r.storey === 0 && (r.kind === 'living' || r.kind === 'living-kitchen') && !out.some((o) => o.roomId === r.id && o.kind === 'door')) {
      const hub = same.find((h) => (h.kind === 'dining' || h.kind === 'lounge') && shared(r, h));
      const e = hub ? shared(r, hub)! : undefined;
      if (e && e.to - e.from >= 1.4) door(r, e, Math.min(2.4, e.to - e.from - 0.4), false, `${r.name} opening`);
    }
    // The kitchen serves straight into the dining room when they share a wall.
    if (r.kind === 'kitchen') {
      const dining = same.find((h) => h.kind === 'dining' && shared(r, h));
      const e = dining ? shared(r, dining)! : undefined;
      if (e && e.to - e.from >= 1.2 && !out.some((o) => o.roomId === r.id && o.kind === 'door' && Math.abs(o.at - e.at) < 1e-6 && o.dir === e.dir)) door(r, e, cfg.doorM.internal, false, 'Kitchen to dining door');
    }
    if (r.storey === 0 && r.kind === 'kitchen') {
      const side = longest(outside.filter((e) => e.side !== 'front'));
      if (side && side.to - side.from >= cfg.doorM.external + 2.1) door(r, side, cfg.doorM.external, true, 'Kitchen door', 'end');
    }
    // Shops open to the street; loading bays and halls get wide doors and fire exits to the outside.
    if (r.storey === 0 && r.kind === 'shop') {
      const front = streetward(outside);
      if (front && front.to - front.from >= 1.5) door(r, front, Math.min(2.4, front.to - front.from - 0.4), true, `${r.name} front`);
    }
    if (r.storey === 0 && r.kind === 'loading') {
      const e = streetward(outside) ?? longest(outside);
      if (e && e.to - e.from >= 3.4) door(r, e, 3.0, true, 'Loading door');
    }
    if (r.storey === 0 && (r.kind === 'hall' || r.kind === 'warehouse')) {
      const e = longest(outside.filter((x) => x.side !== 'front')) ?? longest(outside);
      if (e && e.to - e.from >= 2.2) door(r, e, 1.8, true, 'Fire exit', 'end');
    }
    if (r.kind === 'lift' || r.kind === 'cinema') continue;
    // Windows on outside walls: wet rooms get a small high window; habitable rooms enough glass for daylight.
    const sorted = [...outside].sort((p, q) => (q.to - q.from) - (p.to - p.from));
    if (!sorted.length) continue;
    if (WET.has(r.kind) || HIGH_LIT.has(r.kind) || r.kind === 'warehouse') {
      const e = sorted[0]!;
      const w = Math.min(cfg.window.wetWidthM, e.to - e.from - 0.3);
      if (w < 0.3) continue;
      const [a, b] = centred(e.from, e.to, w);
      add({ storey: r.storey, kind: 'window', dir: e.dir, at: round(e.at, 3), from: a, to: b, sillM: cfg.window.wetSillM, headM: cfg.window.wetSillM + cfg.window.wetHeightM, external: true, roomId: r.id, label: `${r.name} window` });
      continue;
    }
    let needM2 = (r.w * r.d * cfg.minWindowPctOfFloor) / 100;
    // A second, smaller window on another wall when there is one, so air can move through the room.
    let crossDone = false;
    for (const e of sorted) {
      if (needM2 <= 0 && crossDone) break;
      const doorOps = out.filter((o) => o.kind === 'door' && o.storey === r.storey && o.dir === e.dir && Math.abs(o.at - e.at) < 1e-6);
      // Free stretches of this wall after any door, keeping 0.3 m returns at the ends and beside the door.
      let free: [number, number][] = [[e.from + 0.3, e.to - 0.3]];
      for (const o of doorOps) free = free.flatMap(([p, q]) => [[p, Math.min(q, o.from - 0.3)], [Math.max(p, o.to + 0.3), q]] as [number, number][]).filter(([p, q]) => q - p >= 0.6);
      free.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
      const span = free[0];
      if (!span) continue;
      const want = needM2 > 0 ? Math.max(0.9, Math.ceil((needM2 / cfg.window.heightM) * 10 * 1.2) / 10) : 0.9;
      // Generous glazing on the main wall of rooms that ask for it: large windows, or floor-to-ceiling glass.
      const first = !out.some((o) => o.roomId === r.id && o.kind === 'window');
      const g = first ? r.glazing ?? 'standard' : 'standard';
      const len = span[1] - span[0];
      const w = g === 'full-height' ? Math.min(len, Math.max(want, 2.4, round(len * 0.7, 1))) : g === 'large' ? Math.min(len, Math.max(want, 1.8, round(len * 0.55, 1))) : Math.min(len, want);
      const [sill, head] = g === 'full-height' ? [0.05, Math.max(cfg.doorHeightM, Math.min(2.7, cfg.storeyHeightM - cfg.slabM - 0.3))] : g === 'large' ? [0.6, 2.4] : [cfg.window.sillM, cfg.window.sillM + cfg.window.heightM];
      if (needM2 <= 0 && out.some((o) => o.roomId === r.id && o.kind === 'window' && o.dir === e.dir && Math.abs(o.at - e.at) < 1e-6)) continue;
      const [a, b] = centred(span[0], span[1], w);
      add({ storey: r.storey, kind: 'window', dir: e.dir, at: round(e.at, 3), from: a, to: b, sillM: sill, headM: head, external: true, roomId: r.id, label: g === 'full-height' ? `${r.name} glazed wall` : `${r.name} window` });
      if (needM2 <= 0) crossDone = true;
      needM2 -= w * (head - sill);
    }
  }
  // Larger buildings: a main entrance into the lobby, else into the ground-floor corridor.
  if (!house && !out.some((o) => o.label === 'Front door' || o.label === 'Main entrance')) {
    const lobby = rooms.find((r) => r.storey === 0 && r.kind === 'lobby');
    const hall = rooms.find((r) => r.storey === 0 && r.kind === 'corridor');
    for (const r of [lobby, hall]) {
      if (!r) continue;
      const outside = outsideOf.get(r.id)!;
      const e = streetward(outside) ?? longest(outside);
      if (e && e.to - e.from >= 1.2) { door(r, e, Math.min(1.8, e.to - e.from - 0.2), true, 'Main entrance'); break; }
    }
  }
  return out;
}

// ---------------------------------------------------------------- the architect's checklist

export function checkDesign(d: Design, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): DesignCheck[] {
  const out: DesignCheck[] = [];
  const push = (code: string, label: string, ok: boolean | DesignCheckStatus, detail: string) => out.push({ code, label, status: typeof ok === 'string' ? ok : ok ? 'pass' : 'fail', detail });
  const env = d.envelope;
  const inside = d.blocks.every((b) => b.x >= env.x - 1e-6 && b.y >= env.y - 1e-6 && b.x + b.w <= env.x + env.w + 1e-6 && b.y + b.d <= env.y + env.d + 1e-6);
  push('setbacks', 'Building lines and setbacks', inside, `At least ${cfg.setbacksM.front} m front, ${cfg.setbacksM.side} m sides, ${cfg.setbacksM.rear} m rear kept clear.`);
  push('coverage', 'Site coverage', d.metrics.coveragePct <= cfg.maxCoveragePct, `${d.metrics.coveragePct}% of the plot is built on (limit ${cfg.maxCoveragePct}%).`);
  const house = isHouse(d.brief.type);
  push('ceiling', 'Ceiling height', d.storeyHeightM - cfg.slabM >= cfg.minCeilingM, `${round(d.storeyHeightM - cfg.slabM, 2)} m clear (minimum ${cfg.minCeilingM} m).`);

  const small = d.rooms.filter((r) => r.kind !== 'corridor' && r.kind !== 'stair' && r.kind !== 'lift').filter((r) => {
    const rule = cfg.rooms[r.kind as RuledKind];
    return r.w * r.d < rule.minM2 - 0.05 || Math.min(r.w, r.d) < rule.minDimM - 0.02;
  });
  // Say which limit each room misses, so a person (or the AI designer on its repair round) knows what to change.
  const why = (r: Room) => {
    const rule = cfg.rooms[r.kind as RuledKind];
    const narrow = Math.min(r.w, r.d) < rule.minDimM - 0.02;
    return `${r.name} (${round(r.w * r.d, 1)} m², ${round(Math.min(r.w, r.d), 2)} m wide; ${narrow ? `needs at least ${rule.minDimM} m wide` : `needs at least ${rule.minM2} m²`}${narrow && r.kind === 'lobby' ? ', or make a narrow hall a corridor' : ''})`;
  };
  push('room-sizes', 'Minimum room sizes', !small.length, small.length ? `Too small: ${small.map(why).join(', ')}.` : 'Every room meets its minimum floor area and width.');

  const dark = d.rooms.filter((r) => HABITABLE.has(r.kind)).filter((r) => {
    const glass = d.openings.filter((o) => o.roomId === r.id && o.kind === 'window').reduce((s, o) => s + (o.to - o.from) * (o.headM - o.sillM), 0);
    return glass < (r.w * r.d * cfg.minWindowPctOfFloor) / 100 - 0.05;
  });
  push('daylight', 'Natural light and ventilation', dark.length ? (house ? false : 'warn') : true, dark.length ? `Not enough window area: ${dark.map((r) => r.name).join(', ')}.` : `Every habitable room has windows of at least ${cfg.minWindowPctOfFloor}% of its floor area.`);

  const unvented = d.rooms.filter((r) => WET.has(r.kind) && !d.openings.some((o) => o.roomId === r.id && o.kind === 'window'));
  push('wet-ventilation', 'Bathroom and WC ventilation', unvented.length ? 'warn' : 'pass', unvented.length ? `${unvented.map((r) => r.name).join(', ')} need mechanical extract ventilation.` : 'Every bathroom and WC has an outside window.');

  const corridors = d.rooms.filter((r) => r.kind === 'corridor');
  push('corridors', 'Corridor width', corridors.every((c) => Math.min(c.w, c.d) >= cfg.minCorridorM - 1e-6), `Hallways are ${cfg.corridorM} m wide (minimum ${cfg.minCorridorM} m).`);
  const narrow = d.openings.filter((o) => o.kind === 'door' && o.to - o.from < cfg.minDoorM - 1e-6);
  push('doors', 'Door widths', !narrow.length, narrow.length ? `${narrow.length} door(s) narrower than ${cfg.minDoorM} m.` : `Every door is at least ${cfg.minDoorM} m wide; the front door is ${cfg.doorM.entrance} m.`);

  const bedrooms = d.rooms.filter((r) => r.kind === 'bedroom' || r.kind === 'master');
  const privateAccess = bedrooms.every((b) => d.openings.some((o) => o.roomId === b.id && o.kind === 'door'));
  if (bedrooms.length) push('privacy', 'Bedrooms reached from circulation', privateAccess, 'Each bedroom opens off a hallway or landing, never through another bedroom.');
  const shut = d.rooms.filter((r) => r.kind !== 'corridor' && r.kind !== 'stair' && r.kind !== 'lift' && r.kind !== 'ensuite' && !d.openings.some((o) => o.roomId === r.id && o.kind === 'door'));
  if (!house && shut.length) push('access', 'Every room has a door', 'warn', `No door yet: ${shut.slice(0, 4).map((r) => r.name).join(', ')}${shut.length > 4 ? '…' : ''}.`);
  const escape = d.rooms.filter((r) => r.storey === 0 && r.kind !== 'corridor').length > 0 && d.openings.some((o) => o.external && o.kind === 'door');
  push('escape', 'Entrance and escape', escape && d.openings.filter((o) => o.external && o.kind === 'door').length >= (d.storeys > 1 ? 1 : 1), `${d.openings.filter((o) => o.external && o.kind === 'door').length} external door(s).`);
  const groundWc = d.rooms.some((r) => r.storey === 0 && WET.has(r.kind));
  // Toilets and bathrooms never share a wall with a kitchen or a dining room (hygiene, smell and noise).
  const DIRTY = new Set<RoomKind>(['wc', 'toilets', 'bathroom']);
  const CLEAN = new Set<RoomKind>(['kitchen', 'dining', 'living-kitchen', 'restaurant']);
  const beside = d.rooms.filter((r) => DIRTY.has(r.kind)).flatMap((r) => d.rooms.filter((c) => CLEAN.has(c.kind) && c.storey === r.storey && shared(r, c)).map((c) => `${r.name} beside ${c.name}`));
  push('hygiene', 'Toilets away from cooking and eating', beside.length ? 'warn' : 'pass', beside.length
    ? `Move these apart (a toilet should open off a hall or lobby, not share a wall with food): ${beside.slice(0, 4).join('; ')}.`
    : 'No toilet or bathroom shares a wall with the kitchen or dining room.');
  if (house) push('ground-wc', 'Toilet on the entrance floor', groundWc ? 'pass' : 'warn', groundWc ? 'There is a toilet on the ground floor.' : 'No toilet on the ground floor; consider a guest WC.');
  if (d.storeys > 1) {
    // Every stair (and lift) must sit in the same place on every floor it serves.
    const spots = (kind: RoomKind) => {
      const m = new Map<string, number>();
      for (const r of d.rooms.filter((x) => x.kind === kind)) { const k = `${round(r.x, 2)},${round(r.y, 2)},${round(r.w, 2)},${round(r.d, 2)}`; m.set(k, (m.get(k) ?? 0) + 1); }
      return m;
    };
    const stairs = d.rooms.filter((r) => r.kind === 'stair');
    const stairSpots = spots('stair');
    const okStair = stairs.length > 0 && stairs.every((s) => Math.min(s.w, s.d) >= cfg.stair.minWidthM - 0.02 && Math.max(s.w, s.d) >= cfg.stair.minRunM - 0.02)
      && [...stairSpots.values()].every((n) => n === d.storeys);
    const many = stairSpots.size > 1;
    push('stair', 'Stair width and run', okStair, `${many ? `${stairSpots.size} stairs, each at least` : ''} ${Math.min(...stairs.map((s) => Math.min(s.w, s.d))).toFixed(1)} m wide with a ${cfg.stair.minRunM} m run, aligned on ${d.storeys === 2 ? 'both floors' : 'every floor'}.`.trim());
    if (!house && d.brief.type !== 'terrace') {
      const liftSpots = spots('lift');
      if (needsLift(d.brief.type, d.storeys, d.brief.features)) {
        push('lift', 'Lift', liftSpots.size > 0 && [...liftSpots.values()].every((n) => n === d.storeys), `A passenger lift serves all ${d.storeys} floors.`);
      }
      if (needsTwoStairs(d.brief.type, d.storeys)) {
        push('escape-stairs', 'Two ways out of every floor', stairSpots.size >= 2 ? 'pass' : 'warn', stairSpots.size >= 2 ? 'Two separate stairs, one at each end, so a fire never blocks the only way down.' : 'Only one stair: a building this tall needs a second protected stair.');
      }
    }
  }
  if (!house && !['terrace', 'apartments'].includes(d.brief.type)) {
    // Flats and hotel rooms have their own bathrooms.
    const dry = Array.from({ length: d.storeys }, (_, s) => s).filter((s) => !d.rooms.some((r) => r.storey === s && (WET.has(r.kind) || r.kind === 'flat' || r.kind === 'guest-room')));
    push('toilets', 'Toilets on every floor', dry.length ? 'warn' : 'pass', dry.length ? `No toilets on floor ${dry.join(', ')}.` : 'Every floor has toilets.');
  }
  if (d.brief.parking) {
    push('parking', 'Off-street parking', d.parking.length === d.brief.parking ? 'pass' : 'warn', d.parking.length === d.brief.parking
      ? `${d.parking.length} parking space(s) in front of the ${house ? 'house' : 'building'}.`
      : `${d.parking.length} of ${d.brief.parking} parking space(s) fit in front of the ${house ? 'house' : 'building'}${house ? '' : '; the rest need a car park nearby or a basement'}.`);
  }
  if (d.brief.bq) {
    const bq = d.blocks.find((b) => b.kind === 'outbuilding');
    const gap = bq ? Math.min(...d.blocks.filter((b) => b.kind === 'house').map((b) => clearance(b, bq))) : 0;
    push('outbuilding', "Boys' quarters", bq ? (gap >= cfg.outbuilding.gapM - 1e-6) : 'warn',
      bq ? `Detached at the back, ${round(gap, 1)} m clear of the house (minimum ${cfg.outbuilding.gapM} m), with its own entrance and shower.` : 'Does not fit behind this layout within the setbacks, separation and coverage limit.');
  }
  return out;
}

// ---------------------------------------------------------------- the architect's review (built-in defaults)

/**
 * How an architect would read the design: zoning, air and light, circulation, cost of the outline, open ground.
 * These are the engine's own notes (no AI needed); the score ranks the options. An AI architect, when connected,
 * can replace the notes and the order, but never the geometry or the checks.
 */
export function reviewDesign(d: Design, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): ArchitectReview {
  if (!isHouse(d.brief.type)) return reviewBuilding(d, cfg);
  const hi: string[] = []; const co: string[] = [];
  let score = 70;
  const warns = d.checks.filter((c) => c.status === 'warn');
  score -= warns.length * 8;
  co.push(...warns.map((c) => c.detail));
  const houseIds = new Set(d.blocks.filter((b) => b.kind === 'house').map((b) => b.id));
  const house = d.rooms.filter((r) => houseIds.has(r.block));

  // Zoning: public rooms to the street, private rooms away from it.
  const living = house.find((r) => r.storey === 0 && (r.kind === 'living' || r.kind === 'living-kitchen'));
  const master = house.find((r) => r.kind === 'master');
  planningNotes(d, hi, co, (n) => { score += n; });
  if (d.typology === 'l-plan') { hi.push('Bedrooms sit in their own wing off the living room, so sleeping rooms stay quiet and away from visitors.'); score += 6; }
  else if (d.typology === 'pavilion') { hi.push('The living rooms are a single-storey pavilion: light and breeze from three sides, a taller ceiling under the roof, and the bedrooms quiet upstairs in the main house.'); score += 7; }
  else if (d.storeys > 1 && master && master.storey > 0) { hi.push('Living spaces are downstairs and the master suite upstairs, keeping visitors and family rooms apart.'); score += 4; }
  else if (living && master && master.y > living.y + 0.5) { hi.push('Living rooms face the street and the bedrooms the quieter back of the plot.'); score += 3; }

  // Air movement: windows on two walls let breezes through (the single most useful thing in a hot climate).
  const hab = house.filter((r) => HABITABLE.has(r.kind));
  const walls = (r: Room) => new Set(d.openings.filter((o) => o.roomId === r.id && o.kind === 'window').map((o) => `${o.dir}:${key(o.at)}`)).size;
  const cross = hab.filter((r) => walls(r) >= 2).length;
  const share = hab.length ? cross / hab.length : 0;
  score += round(share * 12, 1);
  if (share >= 0.5) hi.push(`${cross} of ${hab.length} living rooms and bedrooms have windows on two walls, so air can flow straight through.`);
  else co.push(`Only ${cross} of ${hab.length} living rooms and bedrooms have windows on two walls; ceiling fans or high louvres will help air move.`);

  // Circulation: hallways are floor you pay for but cannot use.
  const gross = house.reduce((s, r) => s + r.w * r.d, 0);
  const circ = house.filter((r) => r.kind === 'corridor').reduce((s, r) => s + r.w * r.d, 0);
  const circPct = gross ? round((circ / gross) * 100, 0) : 0;
  if (circPct <= 12) { hi.push(`Hallways take only ${circPct}% of the floor area, so nearly everything you build is usable room.`); score += 4; }
  else if (circPct > 18) { co.push(`Hallways take ${circPct}% of the floor area: easy to move around, but that floor costs as much as a room.`); score -= 4; }

  // Outline: the longer the outside walls for the area, the more foundations, walling and roof edge.
  const extLen = d.walls.filter((w) => w.storey === 0 && w.external && d.rooms.some((r) => houseIds.has(r.block) && r.storey === 0 && touches(r, w))).reduce((s, w) => s + (w.to - w.from), 0);
  const ratio = d.metrics.footprintM2 ? extLen / (4 * Math.sqrt(d.metrics.footprintM2)) : 1;
  if (ratio <= 1.12) { hi.push('A compact outline keeps outside walls, foundations and roof edge short, which keeps the cost down.'); score += 4; }
  else if (ratio > 1.3) { co.push('The longer outline costs more in outside walls, foundations and roofing than a squarer plan; that buys light, air and privacy.'); score -= 3; }

  // Open ground for a garden, drainage and the soakaway.
  const open = round(d.metrics.plotM2 * (1 - d.metrics.coveragePct / 100) - d.parking.reduce((s, p) => s + p.w * p.d, 0), 0);
  if (open > 0) hi.push(`Leaves about ${open} m² of open ground for a garden, rainwater soakage and the septic tank.`);
  if (d.metrics.coveragePct > cfg.maxCoveragePct - 5) { co.push(`Covers ${d.metrics.coveragePct}% of the plot, close to the ${cfg.maxCoveragePct}% limit; check the local planning office's figure early.`); score -= 3; }

  // Plumbing: wet rooms above wet rooms share stacks and drains.
  if (d.storeys > 1) {
    const wetAt = (s: number) => house.filter((r) => r.storey === s && (WET.has(r.kind) || r.kind === 'kitchen'));
    const stacked = wetAt(1).filter((u) => wetAt(0).some((g) => Math.min(u.x + u.w, g.x + g.w) - Math.max(u.x, g.x) > 0.3 && Math.min(u.y + u.d, g.y + g.d) - Math.max(u.y, g.y) > 0.3));
    if (stacked.length) { hi.push(`${stacked.length} upstairs bathroom(s) sit over wet rooms below, sharing pipes and drains.`); score += 2; }
  }
  if (d.openings.some((o) => o.label === 'Kitchen door')) hi.push('The kitchen has its own outside door for deliveries, gas cylinders and refuse.');
  const bq = d.blocks.find((b) => b.kind === 'outbuilding');
  if (bq) hi.push("The boys' quarters is detached at the back with its own entrance and shower, private for both household and staff.");

  co.push('Confirm north on site: keep the largest windows off the west, where the afternoon sun is hottest, or shade them with deep eaves.');
  if (d.roof.kind === 'flat') co.push('Flat roofs need falls to the outlets and a good waterproofing membrane; allow for upkeep.');
  return { score: Math.max(0, Math.min(100, round(score, 0))), highlights: hi.slice(0, 5), considerations: co.slice(0, 4), source: 'engine' };
}

/** How the rooms relate (from the affinity logic): the best relationship as a note, every conflict as a concern. */
function planningNotes(d: Design, hi: string[], co: string[], add: (n: number) => void) {
  const a = planningAnalysis(d.rooms);
  add(Math.max(-16, Math.min(12, a.score)));
  const best = a.good[0];
  if (best) hi.unshift(`${best.a} sits beside ${best.b}: ${best.why}.`);
  for (const r of a.bad.slice(0, 2)) co.unshift(`${r.a} is beside ${r.b}, but ${r.why}.`);
}

/** The architect's read of a larger building: core and escape, repeatable floors, light and air, cost of the outline. */
function reviewBuilding(d: Design, cfg: DesignConfig): ArchitectReview {
  const hi: string[] = []; const co: string[] = [];
  let score = 70;
  const warns = d.checks.filter((c) => c.status === 'warn');
  score -= warns.length * 6;
  co.push(...warns.map((c) => c.detail));
  const t = d.brief.type;
  const count = (k: RoomKind) => d.rooms.filter((r) => r.kind === k).length;
  const stairs = new Set(d.rooms.filter((r) => r.kind === 'stair').map((r) => `${round(r.x, 1)},${round(r.y, 1)}`)).size;
  const lifts = count('lift') > 0;

  planningNotes(d, hi, co, (n) => { score += n; });
  if (t === 'terrace') { hi.push('Each house has its own front door, stair and garden; pairs share a party wall, which saves walling and keeps neighbours quiet.'); score += 4; }
  else if (d.storeys > 1) {
    hi.push(`${stairs > 1 ? `Two stairs${lifts ? ' and a lift' : ''}` : `A stair${lifts ? ' and lift' : ''}`} serve every floor from the same spot, so structure, lift shaft and services stack straight up.`);
    score += 4;
    hi.push('Upper floors repeat one plan: one structural grid, the same formwork floor after floor, and pipes and cables that run straight down. That is the cheapest way to build tall.');
    score += 3;
  }
  if (t === 'shops' || t === 'mixed-use') { const front = d.openings.filter((o) => o.label.endsWith(' front')).length; if (front) { hi.push(`${front} shop${front > 1 ? 's' : ''} open straight onto the street, where passing trade sees them.`); score += 4; } }
  if (t === 'hotel') hi.push(`${count('guest-room')} guest rooms off central corridors: an efficient floor where every room gets an outside window.`);
  if (t === 'school') hi.push('Classrooms open off wide corridors with windows on the outside wall, for daylight and air without glare on the boards.');
  if (t === 'clinic') hi.push('Outpatients stay on the ground floor near the entrance; wards are upstairs, away from the waiting crowd.');
  if (t === 'apartments') hi.push(`Every flat has its own outside wall for windows; ${count('flat')} flats share one entrance and ${stairs > 1 ? 'two stairs' : 'a stair'}.`);
  if (t === 'event-hall' || t === 'worship') hi.push('The hall is a clear span behind a foyer band of toilets, offices and stores, so crowds gather inside before an event, not on the road.');
  if (t === 'warehouse') hi.push('A clear-span floor behind the office band, with the loading bay on the street side for trucks.');

  // Air and light: rooms with windows on two walls.
  const occ = d.rooms.filter((r) => HABITABLE.has(r.kind));
  const walls = (r: Room) => new Set(d.openings.filter((o) => o.roomId === r.id && o.kind === 'window').map((o) => `${o.dir}:${key(o.at)}`)).size;
  const lit = occ.filter((r) => walls(r) >= 1).length;
  const share = occ.length ? lit / occ.length : 1;
  score += round(share * 10, 1);
  if (share < 0.9 && occ.length) co.push(`${occ.length - lit} room(s) have no outside window; plan for mechanical ventilation and good lighting there.`);

  // Circulation share.
  const gross = d.rooms.reduce((s, r) => s + r.w * r.d, 0);
  const circ = d.rooms.filter((r) => r.kind === 'corridor' || r.kind === 'stair' || r.kind === 'lift').reduce((s, r) => s + r.w * r.d, 0);
  const circPct = gross ? round((circ / gross) * 100, 0) : 0;
  if (circPct <= 20) { hi.push(`Corridors, stairs and lifts take ${circPct}% of the floor area: efficient for this kind of building.`); score += 3; }
  else if (circPct > 28) { co.push(`Corridors, stairs and lifts take ${circPct}% of the floor area; a deeper plan would let more of it earn rent.`); score -= 3; }

  const open = round(d.metrics.plotM2 * (1 - d.metrics.coveragePct / 100) - d.parking.reduce((s, p) => s + p.w * p.d, 0), 0);
  if (open > 0) hi.push(`Leaves about ${open} m² of open ground for parking overflow, drainage, the septic tank and landscaping.`);
  if (d.metrics.coveragePct > cfg.maxCoveragePct - 5) { co.push(`Covers ${d.metrics.coveragePct}% of the plot, close to the ${cfg.maxCoveragePct}% limit; check the local planning office's figure early.`); score -= 3; }
  if (d.storeys >= 4) co.push(`At ${d.storeys} storeys, a structural engineer sizes the frame and foundations early (after a soil test), and a fire engineer confirms escape routes and fire-fighting access.`);
  co.push('Confirm north on site and keep the largest glazing off the west, or shade it with fins and deep overhangs.');
  return { score: Math.max(0, Math.min(100, round(score, 0))), highlights: hi.slice(0, 5), considerations: co.slice(0, 4), source: 'engine' };
}

// ---------------------------------------------------------------- the AI architect (optional)

/** Bumped whenever the generator changes what it produces, so cached AI reviews of old designs are not reused. */
export const DESIGN_ENGINE_VERSION = 'design-2026.11f';

/** What an AI architect returns: an order (best first) and its notes per design. Geometry is never its to change. */
export interface AiArchitectReview {
  overview: string;
  order: string[];
  reviews: Record<string, { score: number; highlights: string[]; considerations: string[] }>;
  /** The architect's concept for the design it recommends: a name, the idea, the moves and a material palette. */
  concept?: Omit<DesignConcept, 'source'>;
}

/** The idea behind a design, told the way an architect presents it to a client. */
export interface DesignConcept {
  designId: string;
  title: string;
  story: string;
  moves: string[];
  palette: { walls: string; accents: string; roof: string };
  source: 'engine' | 'ai';
}

const CONCEPT_NOUN: Record<BuildingType, string> = {
  bungalow: 'Bungalow', duplex: 'Residence', terrace: 'Terraces', apartments: 'Residences', shops: 'Plaza', office: 'Offices',
  'mixed-use': 'Court', warehouse: 'Logistics Hub', hotel: 'Hotel', 'event-hall': 'Event Centre', school: 'Academy', clinic: 'Medical Centre', worship: 'Sanctuary',
};
const STYLE_WORD: Record<DesignBrief['style'], string> = { modern: 'Modern', classic: 'Classic', tropical: 'Tropical' };
const PALETTES: Record<DesignBrief['style'], { walls: string; accents: string }> = {
  modern: { walls: 'Off-white render with charcoal bands at each floor', accents: 'Dark aluminium window frames, timber-look cladding by the entrance' },
  classic: { walls: 'Warm cream render on a stone-clad plinth', accents: 'White window surrounds and cornices, dark hardwood doors' },
  tropical: { walls: 'White render under deep, shading eaves', accents: 'Hardwood louvres, terracotta tiles and planted verandas' },
};

/** The engine's own concept for a design (the AI architect's, when connected, replaces it). */
export function conceptFor(d: Design): DesignConcept {
  const b = d.brief;
  const colour = b.roofColour === 'auto' ? STYLE_COLOUR[b.style] : b.roofColour;
  const roof = d.roof.kind === 'flat' || d.roof.kind === 'hidden'
    ? `${d.roof.kind === 'flat' ? 'Flat roof' : 'Roof hidden behind a parapet'}, ${ROOF_FINISHES[b.roofFinish].label.toLowerCase()} in ${ROOF_COLOURS[colour].label.toLowerCase()}`
    : `${ROOF_OPTIONS[d.roof.kind].label} roof in ${ROOF_COLOURS[colour].label.toLowerCase()} ${ROOF_FINISHES[b.roofFinish].label.toLowerCase()}`;
  const tall = d.storeys > 1 ? ` on ${d.storeys} floors` : '';
  const story = `${d.summary.split('. ')[0]}${tall && !d.summary.includes('storey') ? tall : ''}. ${d.blurb} ${d.review.highlights[0] ?? ''}`.trim();
  return {
    designId: d.id,
    title: `The ${STYLE_WORD[b.style]} ${CONCEPT_NOUN[b.type] ?? 'Building'}`,
    story,
    moves: d.review.highlights.slice(1, 4),
    palette: { ...PALETTES[b.style], roof },
    source: 'engine',
  };
}

/** A compact, numbers-only description of a design for an AI architect to read (no personal data). */
export function designDigest(d: Design) {
  const r1 = (n: number) => round(n, 1);
  // Tall buildings repeat their upper floors: the ground and first floor are enough to judge, with a count per floor.
  const shown = d.storeys > 2 ? d.rooms.filter((r) => r.storey <= 1) : d.rooms;
  const house = shown.filter((r) => r.kind !== 'corridor');
  const gross = d.rooms.reduce((s, r) => s + r.w * r.d, 0);
  const floorName = (s: number) => (s === 0 ? 'ground' : s === 1 ? 'first' : `floor ${s}`);
  return {
    id: d.id,
    name: d.name,
    buildingType: typeOf(d.brief).label,
    summary: d.summary,
    layout: d.typology,
    ...(d.storeys > 2 ? { upperFloorsRepeatFirstFloor: d.storeys - 2, roomsPerFloor: Array.from({ length: d.storeys }, (_, s) => d.rooms.filter((r) => r.storey === s && r.kind !== 'corridor').length) } : {}),
    storeys: d.storeys,
    grossFloorM2: d.metrics.grossFloorM2,
    coveragePct: d.metrics.coveragePct,
    roof: d.roof.kind,
    blocks: d.blocks.map((b) => ({ name: b.name, w: r1(b.w), d: r1(b.d), storeys: b.storeys })),
    circulationPct: gross ? round((d.rooms.filter((r) => r.kind === 'corridor').reduce((s, r) => s + r.w * r.d, 0) / gross) * 100, 0) : 0,
    rooms: house.map((r) => ({
      name: r.name,
      floor: d.blocks.find((b) => b.id === r.block)?.kind === 'outbuilding' ? 'outbuilding' : floorName(r.storey),
      size: `${r1(r.w)} x ${r1(r.d)} m`,
      areaM2: r1(r.w * r.d),
      windowWalls: new Set(d.openings.filter((o) => o.roomId === r.id && o.kind === 'window').map((o) => `${o.dir}:${key(o.at)}`)).size,
      outsideDoor: d.openings.some((o) => o.roomId === r.id && o.kind === 'door' && o.external),
      metresFromStreet: r1(r.y), // the front boundary is y = 0
    })),
    checksToNote: d.checks.filter((c) => c.status !== 'pass').map((c) => `${c.label}: ${c.detail}`),
    engineNotes: { score: d.review.score, highlights: d.review.highlights, considerations: d.review.considerations },
  };
}

/**
 * Applies an AI architect's review: its notes replace the engine's for the designs it reviewed, and its order
 * ranks them. Unknown ids are ignored and any design it left out keeps the engine's notes, after the ranked ones.
 */
export function applyAiReview(designs: Design[], ai: AiArchitectReview): Design[] {
  const byId = new Map(designs.map((d) => [d.id, d]));
  const clean = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean).slice(0, 5);
  const reviewed = designs.map((d) => {
    const r = ai.reviews[d.id];
    if (!r || !r.highlights.length) return d;
    return { ...d, review: { score: Math.max(0, Math.min(100, Math.round(r.score))), highlights: clean(r.highlights), considerations: clean(r.considerations), source: 'ai' as const } };
  });
  const rank = new Map(ai.order.filter((id) => byId.has(id)).map((id, i) => [id, i]));
  const c = ai.concept;
  const withConcept = c && byId.has(c.designId)
    ? reviewed.map((d) => (d.id === c.designId ? { ...d, concept: { ...c, moves: clean(c.moves).slice(0, 4), source: 'ai' as const } } : d))
    : reviewed;
  return [...withConcept].sort((p, q) => (rank.get(p.id) ?? 1e9) - (rank.get(q.id) ?? 1e9));
}

/** True when a wall lies along one of the room's edges. */
function touches(r: Rect, w: Wall): boolean {
  return w.dir === 'h'
    ? (Math.abs(w.at - r.y) < 1e-6 || Math.abs(w.at - (r.y + r.d)) < 1e-6) && Math.min(w.to, r.x + r.w) - Math.max(w.from, r.x) > 0.05
    : (Math.abs(w.at - r.x) < 1e-6 || Math.abs(w.at - (r.x + r.w)) < 1e-6) && Math.min(w.to, r.y + r.d) - Math.max(w.from, r.y) > 0.05;
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
  for (const b of d.blocks) {
    for (let s = 0; s < b.storeys; s++) {
      out.push({ kind: 'slab', storey: s, external: false, cx: b.x + b.w / 2, cy: b.y + b.d / 2, cz: s * H - d.slabM / 2 + (s === 0 ? d.slabM : 0), sx: b.w + 0.2, sy: b.d + 0.2, sz: d.slabM });
    }
    if (d.roof.kind === 'flat') {
      const z = b.storeys * H;
      out.push({ kind: 'slab', storey: b.storeys, external: true, cx: b.x + b.w / 2, cy: b.y + b.d / 2, cz: z + d.slabM / 2, sx: b.w + 0.2, sy: b.d + 0.2, sz: d.slabM });
    }
  }
  if (d.roof.kind === 'flat' || d.roof.kind === 'hidden') {
    // Parapets stand on the outside walls of each block's top floor (on the roof slab, or hiding a pitched roof).
    const t = 0.225; const ph = d.roof.parapetM;
    for (const w of d.walls.filter((x) => x.external)) {
      const b = d.blocks.find((k) => onRect(k, w));
      if (!b || w.storey !== b.storeys - 1) continue;
      const z = b.storeys * H; const zc = z + (d.roof.kind === 'flat' ? d.slabM : 0) + ph / 2; const len = w.to - w.from + t; const mid = (w.from + w.to) / 2;
      out.push(w.dir === 'h'
        ? { kind: 'parapet', storey: b.storeys, external: true, cx: mid, cy: w.at, cz: zc, sx: len, sy: t, sz: ph }
        : { kind: 'parapet', storey: b.storeys, external: true, cx: w.at, cy: mid, cz: zc, sx: t, sy: len, sz: ph });
    }
  }
  return out;
}

/** True when a wall lies on the boundary of a block. */
function onRect(b: Rect, w: Wall): boolean {
  const mid = (w.from + w.to) / 2;
  return w.dir === 'h'
    ? (Math.abs(w.at - b.y) < 1e-6 || Math.abs(w.at - (b.y + b.d)) < 1e-6) && mid >= b.x - 1e-6 && mid <= b.x + b.w + 1e-6
    : (Math.abs(w.at - b.x) < 1e-6 || Math.abs(w.at - (b.x + b.w)) < 1e-6) && mid >= b.y - 1e-6 && mid <= b.y + b.d + 1e-6;
}

type Ends = { x0: boolean; x1: boolean; y0: boolean; y1: boolean };
export type RoofPlane = [number, number, number][];

/** True for an upright face (a gable end or an infill wall under a roof), as opposed to a roof slope. */
export function isVerticalPlane(p: RoofPlane): boolean {
  const n = normal(p);
  return Math.abs(n[2]) < 1e-6 * Math.max(1, Math.hypot(n[0], n[1]));
}
function normal(p: RoofPlane): [number, number, number] {
  // Newell's method: robust for any planar polygon.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1, z1] = p[i]!; const [x2, y2, z2] = p[(i + 1) % p.length]!;
    nx += (y1 - y2) * (z1 + z2); ny += (z1 - z2) * (x1 + x2); nz += (x1 - x2) * (y1 + y2);
  }
  return [nx, ny, nz];
}
/** Area of a planar polygon in 3D. */
export function planeArea(p: RoofPlane): number { const n = normal(p); return Math.hypot(n[0], n[1], n[2]) / 2; }

/** Effective pitch of a roof: shed and butterfly roofs stay shallow. */
export function roofPitchDeg(r: Pick<Roof, 'kind' | 'pitchDeg'>): number {
  return r.kind === 'shed' || r.kind === 'butterfly' ? Math.min(r.pitchDeg, 12) : r.pitchDeg;
}

/**
 * Roof planes per block: each plane a list of 3D points (x, y plan; z up). Every block gets its own roof; where
 * two wings meet, the one whose ridge runs into the join carries on into the other roof as far as its ridge line,
 * which is how an L- or T-shaped roof is framed (the planes meet in a valley). Upright faces (gable ends, the
 * infill walls under shed and butterfly roofs) are included; tell them apart with `isVerticalPlane`.
 */
export function roofParts(d: Design): { blockId: string; planes: RoofPlane[] }[] {
  if (d.roof.kind === 'flat') return [];
  const span = (b: Block) => (b.ridge === 'x' ? b.d : b.w);
  return d.blocks.map((b) => {
    const inner: Ends = { x0: false, x1: false, y0: false, y1: false };
    let r: Rect = { ...b };
    for (const o of d.blocks) {
      if (o === b) continue;
      if (o.storeys > b.storeys) {
        // A lower wing against a taller one: its roof meets that wall, with no eave running into it.
        if (Math.abs(b.x + b.w - o.x) < 1e-6 && overlaps(b.y, b.d, o.y, o.d)) inner.x1 = true;
        if (Math.abs(b.x - (o.x + o.w)) < 1e-6 && overlaps(b.y, b.d, o.y, o.d)) inner.x0 = true;
        if (Math.abs(b.y + b.d - o.y) < 1e-6 && overlaps(b.x, b.w, o.x, o.w)) inner.y1 = true;
        if (Math.abs(b.y - (o.y + o.d)) < 1e-6 && overlaps(b.x, b.w, o.x, o.w)) inner.y0 = true;
        continue;
      }
      if (o.storeys !== b.storeys) continue;
      const yJoin = (Math.abs(b.y - (o.y + o.d)) < 1e-6 || Math.abs(b.y + b.d - o.y) < 1e-6) && overlaps(b.x, b.w, o.x, o.w);
      const xJoin = (Math.abs(b.x - (o.x + o.w)) < 1e-6 || Math.abs(b.x + b.w - o.x) < 1e-6) && overlaps(b.y, b.d, o.y, o.d);
      if (!yJoin && !xJoin) continue;
      // The wing whose ridge runs into the join carries on into the other roof; if both or neither do, the narrower.
      const endOn = (k: Block) => (yJoin ? k.ridge === 'y' : k.ridge === 'x');
      const extends_ = endOn(b) !== endOn(o) ? endOn(b) : span(b) < span(o) - 1e-6 || (Math.abs(span(b) - span(o)) < 1e-6 && b.id > o.id);
      if (!extends_ || d.roof.kind === 'hidden') continue; // a concealed roof stays inside its own parapets
      const ext = span(o) / 2; // as far as the other roof's ridge line
      if (yJoin && Math.abs(b.y - (o.y + o.d)) < 1e-6) { inner.y0 = true; r = { ...r, y: r.y - ext, d: r.d + ext }; }
      if (yJoin && Math.abs(b.y + b.d - o.y) < 1e-6) { inner.y1 = true; r = { ...r, d: r.d + ext }; }
      if (xJoin && Math.abs(b.x - (o.x + o.w)) < 1e-6) { inner.x0 = true; r = { ...r, x: r.x - ext, w: r.w + ext }; }
      if (xJoin && Math.abs(b.x + b.w - o.x) < 1e-6) { inner.x1 = true; r = { ...r, w: r.w + ext }; }
    }
    return { blockId: b.id, planes: blockRoof(r, b, b.ridge, b.storeys * d.storeyHeightM, d.roof, inner) };
  });
}

/** Every roof plane, all blocks together. */
export function roofPlanes(d: Design): RoofPlane[] { return roofParts(d).flatMap((p) => p.planes); }

const overlaps = (a: number, la: number, b: number, lb: number) => Math.min(a + la, b + lb) - Math.max(a, b) > 0.3;

/**
 * One block's roof, built in a local frame (u along the ridge, v across it) and turned into plan coordinates.
 * `fp` is the roofed rectangle (it may run on into a neighbouring wing), `wall` the block's own walls.
 * Ends marked inner sit inside another wing's roof: they get no overhang.
 */
function blockRoof(fp: Rect, wall: Rect, ridge: 'x' | 'y', z: number, roof: Roof, inner: Ends): RoofPlane[] {
  const kind = roof.kind;
  const o = kind === 'hidden' ? 0 : roof.overhangM;
  const X = ridge === 'x';
  // Local frame.
  const iu0 = X ? inner.x0 : inner.y0; const iu1 = X ? inner.x1 : inner.y1;
  const iv0 = X ? inner.y0 : inner.x0; const iv1 = X ? inner.y1 : inner.x1;
  const [fu, fv, fU, fV] = X ? [fp.x, fp.y, fp.w, fp.d] : [fp.y, fp.x, fp.d, fp.w];
  const u0 = fu - (iu0 ? 0 : o), u1 = fu + fU + (iu1 ? 0 : o), v0 = fv - (iv0 ? 0 : o), v1 = fv + fV + (iv1 ? 0 : o);
  const [wu0, wv0, wu1, wv1] = X ? [wall.x, wall.y, wall.x + wall.w, wall.y + wall.d] : [wall.y, wall.x, wall.y + wall.d, wall.x + wall.w];
  const P = (u: number, v: number, h: number): [number, number, number] => (X ? [u, v, h] : [v, u, h]);
  const half = (v1 - v0) / 2; const vm = (v0 + v1) / 2;
  let t = Math.tan((roofPitchDeg(roof) * Math.PI) / 180);
  if (kind === 'hidden') t = Math.min(t, Math.max(0.05, (roof.parapetM - 0.15) / Math.max(half, 0.5)));

  const hip = (a0: number, a1: number, b0: number, b1: number, zz: number, tt: number): RoofPlane[] => {
    const h2 = (b1 - b0) / 2; const bm = (b0 + b1) / 2; const am = (a0 + a1) / 2; const zr = zz + h2 * tt;
    const ra = Math.min(a0 + h2, am); const rb = Math.max(a1 - h2, am);
    return [
      [P(a0, b0, zz), P(a1, b0, zz), P(rb, bm, zr), P(ra, bm, zr)],
      [P(a0, b1, zz), P(a1, b1, zz), P(rb, bm, zr), P(ra, bm, zr)],
      [P(a0, b0, zz), P(a0, b1, zz), P(ra, bm, zr)],
      [P(a1, b0, zz), P(a1, b1, zz), P(rb, bm, zr)],
    ];
  };
  const zr = z + half * t;
  switch (kind) {
    case 'flat': return [];
    case 'gable':
      return [
        [P(u0, v0, z), P(u1, v0, z), P(u1, vm, zr), P(u0, vm, zr)],
        [P(u0, v1, z), P(u1, v1, z), P(u1, vm, zr), P(u0, vm, zr)],
        [P(u0, v0, z), P(u0, v1, z), P(u0, vm, zr)],
        [P(u1, v0, z), P(u1, v1, z), P(u1, vm, zr)],
      ];
    case 'hip': case 'hidden':
      return hip(u0, u1, v0, v1, z, t);
    case 'dutch': {
      // A hip cut halfway up, with a small upright gable (gablet) above the cut at each end.
      const fh = half * 0.5; const zf = z + fh * t;
      if (u1 - u0 < 2 * fh + 0.6) return hip(u0, u1, v0, v1, z, t);
      return [
        [P(u0, v0, z), P(u1, v0, z), P(u1 - fh, v0 + fh, zf), P(u1 - fh, vm, zr), P(u0 + fh, vm, zr), P(u0 + fh, v0 + fh, zf)],
        [P(u0, v1, z), P(u1, v1, z), P(u1 - fh, v1 - fh, zf), P(u1 - fh, vm, zr), P(u0 + fh, vm, zr), P(u0 + fh, v1 - fh, zf)],
        [P(u0, v0, z), P(u0, v1, z), P(u0 + fh, v1 - fh, zf), P(u0 + fh, v0 + fh, zf)],
        [P(u1, v0, z), P(u1, v1, z), P(u1 - fh, v1 - fh, zf), P(u1 - fh, v0 + fh, zf)],
        [P(u0 + fh, v0 + fh, zf), P(u0 + fh, v1 - fh, zf), P(u0 + fh, vm, zr)],
        [P(u1 - fh, v0 + fh, zf), P(u1 - fh, v1 - fh, zf), P(u1 - fh, vm, zr)],
      ];
    }
    case 'mansard': {
      // Steep lower slopes (70°) to a curb, then a gentle hip on top.
      const hm = Math.min(1.3, half * 0.9); const a = hm / Math.tan((70 * Math.PI) / 180); const zc = z + hm;
      if (u1 - u0 < 2 * a + 0.6 || v1 - v0 < 2 * a + 0.6) return hip(u0, u1, v0, v1, z, t);
      return [
        [P(u0, v0, z), P(u1, v0, z), P(u1 - a, v0 + a, zc), P(u0 + a, v0 + a, zc)],
        [P(u0, v1, z), P(u1, v1, z), P(u1 - a, v1 - a, zc), P(u0 + a, v1 - a, zc)],
        [P(u0, v0, z), P(u0, v1, z), P(u0 + a, v1 - a, zc), P(u0 + a, v0 + a, zc)],
        [P(u1, v0, z), P(u1, v1, z), P(u1 - a, v1 - a, zc), P(u1 - a, v0 + a, zc)],
        ...hip(u0 + a, u1 - a, v0 + a, v1 - a, zc, Math.tan((18 * Math.PI) / 180)),
      ];
    }
    case 'shed': {
      // One slope rising across the span; the walls under it are built up to meet it.
      const at = (v: number) => z + (v - v0) * t;
      return [
        [P(u0, v0, z), P(u1, v0, z), P(u1, v1, at(v1)), P(u0, v1, at(v1))],
        [P(wu0, wv0, z), P(wu0, wv1, z), P(wu0, wv1, at(wv1)), P(wu0, wv0, at(wv0))],
        [P(wu1, wv0, z), P(wu1, wv1, z), P(wu1, wv1, at(wv1)), P(wu1, wv0, at(wv0))],
        [P(wu0, wv1, z), P(wu1, wv1, z), P(wu1, wv1, at(wv1)), P(wu0, wv1, at(wv1))],
        [P(wu0, wv0, z), P(wu1, wv0, z), P(wu1, wv0, at(wv0)), P(wu0, wv0, at(wv0))],
      ];
    }
    case 'butterfly': {
      // Two slopes falling to a central valley gutter; the walls rise to meet the high outer edges.
      const at = (v: number) => z + Math.abs(v - vm) * t; const zh = z + half * t;
      return [
        [P(u0, v0, zh), P(u1, v0, zh), P(u1, vm, z), P(u0, vm, z)],
        [P(u0, v1, zh), P(u1, v1, zh), P(u1, vm, z), P(u0, vm, z)],
        ...[wu0, wu1].flatMap((u) => [[P(u, wv0, z), P(u, wv0, at(wv0)), P(u, vm, z)], [P(u, wv1, z), P(u, wv1, at(wv1)), P(u, vm, z)]] as RoofPlane[]),
        [P(wu0, wv0, z), P(wu1, wv0, z), P(wu1, wv0, at(wv0)), P(wu0, wv0, at(wv0))],
        [P(wu0, wv1, z), P(wu1, wv1, z), P(wu1, wv1, at(wv1)), P(wu0, wv1, at(wv1))],
      ];
    }
  }
}

// ---------------------------------------------------------------- bill of materials

export interface MaterialLine {
  key: string;
  section: 'substructure' | 'frame' | 'walls' | 'roof' | 'openings' | 'finishes' | 'services' | 'external';
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
  // Every block counts: the house wings and any outbuilding.
  const fpArea = d.blocks.reduce((s, b) => s + b.w * b.d, 0);
  const allFloors = d.blocks.reduce((s, b) => s + b.w * b.d * b.storeys, 0);
  const lines: MaterialLine[] = [];
  const add = (l: MaterialLine) => { if (l.quantity > 0) lines.push(l); };

  // Wall lengths and net areas per type (openings deducted).
  const len = (pred: (w: Wall) => boolean) => d.walls.filter(pred).reduce((s, w) => s + (w.to - w.from), 0);
  const openArea = (external: boolean) => d.openings.filter((o) => o.external === external).reduce((s, o) => s + (o.to - o.from) * (o.headM - o.sillM), 0);
  const extLen = len((w) => w.external); const intLen = len((w) => !w.external);
  const groundLen = len((w) => w.storey === 0);
  const extArea = extLen * H - openArea(true);
  const intArea = intLen * H - openArea(false);
  const topExtLen = len((w) => w.external && d.blocks.some((b) => onRect(b, w) && w.storey === b.storeys - 1));
  const parapetArea = d.roof.kind === 'flat' || d.roof.kind === 'hidden' ? topExtLen * d.roof.parapetM : 0;
  // The roof as built: sloped planes take the covering; upright faces (gable ends, infill under shed and butterfly
  // roofs) are built in blockwork like the walls.
  const roofPlanesAll = roofPlanes(d);
  const roofArea = roofPlanesAll.filter((p) => !isVerticalPlane(p)).reduce((sum, p) => sum + planeArea(p), 0);
  const gableArea = roofPlanesAll.filter(isVerticalPlane).reduce((sum, p) => sum + planeArea(p), 0);
  const perM2 = 1 / (m.block.faceLengthM * m.block.faceHeightM);
  const waste = 1 + m.block.wastePct / 100;
  const foundationArea = groundLen * m.foundation.coursesBelowDpc * m.block.faceHeightM;

  const blocksExt = Math.ceil((extArea + parapetArea + gableArea + foundationArea) * perM2 * waste);
  const blocksInt = Math.ceil(intArea * perM2 * waste);

  // Concrete volumes (1:2:4 unless configured otherwise).
  const vFoundation = groundLen * m.foundation.widthM * m.foundation.depthM;
  const vGroundSlab = fpArea * d.slabM;
  const vUpperSlabs = (allFloors - fpArea) * d.slabM + (d.roof.kind === 'flat' ? fpArea * d.slabM : 0);
  const allWallLen = len(() => true);
  const vRingBeams = allWallLen * m.ringBeamM * m.ringBeamM;
  const perimeter = len((w) => w.external && w.storey === 0);
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
  const plasterArea = intArea * 2 + extArea * 2 + (parapetArea + gableArea) * 2;
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
  add({ key: 'blocks-9in', section: 'walls', name: `Sandcrete blocks, ${m.block.external}`, unit: 'piece', quantity: blocksExt, basis: `${round(extArea + parapetArea + gableArea, 1)} m² of outside walls${gableArea ? ' (with gable and roof infill walls)' : ''} plus ${round(foundationArea, 1)} m² below ground, ${round(perM2, 2)} blocks/m² + ${m.block.wastePct}% waste`, shop: { category: 'blocks', q: '9 inch block' } });
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
  const kind = d.roof.kind;
  const roofLabel = ROOF_OPTIONS[kind].label;
  if (kind === 'flat') {
    add({ key: 'waterproofing', section: 'roof', name: 'Roof waterproofing membrane', unit: 'm²', quantity: Math.ceil(fpArea * 1.15), basis: 'Roof slab + 15% upstands and laps', shop: { q: 'waterproofing membrane' } });
  } else {
    const fin = ROOF_FINISHES[d.roof.finish];
    const pitch = Math.round(roofPitchDeg(d.roof));
    const area = roofArea * 1.08;
    add({
      key: d.roof.finish === 'aluminium' ? 'roofing-sheets' : `roofing-${d.roof.finish}`, section: 'roof', name: fin.name, unit: fin.unit,
      quantity: fin.unit === 'piece' ? Math.ceil(area / fin.m2PerPiece!) : Math.ceil(area),
      basis: `${roofLabel} roof at ${pitch}°, ${round(roofArea, 1)} m² of slopes${d.blocks.length > 1 ? ` over ${d.blocks.length} blocks` : ''}${kind === 'hidden' ? ', behind the parapets' : `, ${o} m overhang`}, + 8% laps${fin.m2PerPiece ? `; about ${round(1 / fin.m2PerPiece, 1)} per m²` : ''}`,
      shop: fin.shop,
    });
    // Rafters at fixed spacing, purlins or battens to suit the covering, a wall plate on every outside wall.
    const rafters = Math.ceil((roofArea / m.timber.rafterSpacingM / m.timber.pieceLengthM) * 1.1);
    const battens = Math.ceil((roofArea / fin.battenM / m.timber.pieceLengthM) * 1.1);
    add({ key: 'timber-2x4', section: 'roof', name: 'Timber 2" × 4" (rafters, wall plate)', unit: 'piece', quantity: rafters + Math.ceil(perimeter / m.timber.pieceLengthM), basis: `Rafters at ${m.timber.rafterSpacingM} m over ${round(roofArea, 0)} m² of roof, plus the wall plate; ${m.timber.pieceLengthM} m lengths`, shop: { q: '2x4 timber' } });
    add({ key: 'timber-2x3', section: 'roof', name: fin.battenM < 0.5 ? 'Timber battens 2" × 2" (for tiles)' : 'Timber 2" × 3" (purlins)', unit: 'piece', quantity: battens, basis: `${fin.battenM < 0.5 ? 'Battens' : 'Purlins'} at ${fin.battenM} m to suit ${fin.label.toLowerCase()}; ${m.timber.pieceLengthM} m lengths`, shop: { q: fin.battenM < 0.5 ? '2x2 timber' : '2x3 timber' } });
    const along = d.blocks.reduce((sum, b) => sum + (b.ridge === 'x' ? b.w : b.d), 0);
    if (kind === 'hidden') {
      add({ key: 'box-gutter', section: 'roof', name: 'Box gutter and downpipes (behind the parapets)', unit: 'm', quantity: Math.ceil(topExtLen), basis: 'Along the inside of every parapet; outlets sized by the plumber', shop: { q: 'gutter' }, provisional: true });
    } else {
      add({ key: 'fascia', section: 'roof', name: 'Fascia board', unit: 'm', quantity: Math.ceil(d.blocks.reduce((sum, b) => sum + 2 * (b.w + b.d + 4 * o), 0)), basis: 'Roof edge', shop: { q: 'fascia board' } });
    }
    if (kind === 'butterfly') add({ key: 'valley-gutter', section: 'roof', name: 'Valley gutter and outlets (butterfly roof)', unit: 'm', quantity: Math.ceil(along + 2 * o * d.blocks.length), basis: 'Along the central valley of each block', shop: { q: 'gutter' }, provisional: true });
    if (kind !== 'shed' && kind !== 'butterfly') {
      const hips = kind === 'gable' ? 1 : 1.8;
      add({ key: 'ridge-capping', section: 'roof', name: kind === 'gable' ? 'Ridge capping' : 'Ridge and hip capping', unit: 'm', quantity: Math.ceil(along * hips), basis: kind === 'gable' ? 'Along each ridge' : 'Along each ridge and hip', shop: { category: 'roofing', q: 'ridge cap' } });
    }
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
  add({ key: 'ceiling', section: 'finishes', name: 'PVC ceiling panels', unit: 'm²', quantity: Math.ceil(allFloors * 1.05), basis: 'Ceilings on every floor + 5%', shop: { q: 'pvc ceiling' } });
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
  // Public toilet rooms hold about one WC per 4 m²; flats and hotel rooms have their own bathrooms (and flats a kitchen).
  const flatsN = d.rooms.filter((r) => r.kind === 'flat').length;
  const ownBaths = flatsN * (1 + Math.floor(d.brief.bedrooms / 2)) + d.rooms.filter((r) => r.kind === 'guest-room').length;
  const wcs = wetRooms.reduce((n, r) => n + (r.kind === 'toilets' ? Math.max(2, Math.round((r.w * r.d) / 4)) : 1), 0) + ownBaths;
  const ownNote = ownBaths ? `; ${ownBaths} in flats and guest rooms` : '';
  add({ key: 'wc-sets', section: 'services', name: 'WC sets', unit: 'piece', quantity: wcs, basis: `${wetRooms.length > 8 ? `${wetRooms.length} toilet and bathroom rooms` : wetRooms.map((r) => r.name).join(', ')}${ownNote}`, shop: { q: 'wc set' } });
  add({ key: 'basins', section: 'services', name: 'Wash-hand basins', unit: 'piece', quantity: wcs, basis: 'One per WC', shop: { q: 'wash hand basin' } });
  add({ key: 'showers', section: 'services', name: 'Shower sets', unit: 'piece', quantity: wetRooms.filter((r) => r.kind !== 'wc' && r.kind !== 'toilets').length + ownBaths, basis: 'One per bathroom and ensuite', shop: { q: 'shower' } });
  add({ key: 'kitchen-sink', section: 'services', name: 'Kitchen sink', unit: 'piece', quantity: Math.max(1, flatsN + d.rooms.filter((r) => r.kind === 'kitchen' || r.kind === 'living-kitchen').length), basis: flatsN ? 'One per flat and kitchen' : 'One', shop: { q: 'kitchen sink' } });
  add({ key: 'pipes', section: 'services', name: 'PVC pipes and fittings', unit: 'lot', quantity: 1, basis: 'Water supply and drainage, sized by the plumber', shop: { q: 'pvc pipe' }, provisional: true });
  add({ key: 'water-tank', section: 'services', name: 'Water storage tank (2,000 L)', unit: 'piece', quantity: 1, basis: 'One', shop: { q: 'water tank' } });
  add({ key: 'septic', section: 'services', name: 'Septic tank and soakaway', unit: 'lot', quantity: 1, basis: 'Sized by the engineer for the number of users', shop: { category: 'trades', q: 'septic tank' }, provisional: true });

  // Porches, balconies, canopies, pergolas, screens and cladding (provisional: sized by the architect and engineer).
  const els = d.elements ?? [];
  const sum = (k: ElementKind[]) => els.filter((e) => k.includes(e.kind)).reduce((s2, e) => s2 + e.w * e.d, 0);
  const n = (k: ElementKind) => els.filter((e) => e.kind === k).length;
  const balconyM2 = sum(['balcony']);
  if (balconyM2) {
    add({ key: 'balcony-slabs', section: 'frame', name: 'Balcony slabs (reinforced concrete, 200 mm)', unit: 'm³', quantity: round(balconyM2 * 0.2, 2), basis: `${n('balcony')} balcony slab(s), ${round(balconyM2, 1)} m² × 0.2 m`, shop: { category: 'cement', q: 'ready mix concrete' }, provisional: true });
    const rail = els.filter((e) => e.kind === 'balcony').reduce((s2, e) => s2 + Math.max(e.w, e.d) + 2 * Math.min(e.w, e.d), 0);
    add({ key: 'balcony-railing', section: 'finishes', name: 'Balcony railing (glass or steel)', unit: 'm', quantity: Math.ceil(rail), basis: 'Open sides of each balcony', shop: { q: 'balcony railing' }, provisional: true });
  }
  const roofed = sum(['porch', 'veranda']);
  if (roofed) {
    add({ key: 'porch-roof', section: 'roof', name: 'Porch and veranda roofs (slab or light roof)', unit: 'm²', quantity: Math.ceil(roofed), basis: `${n('porch') + n('veranda')} roofed outdoor area(s)`, shop: { category: 'roofing', q: 'roofing sheet' }, provisional: true });
    const posts = els.filter((e) => e.kind === 'porch' || e.kind === 'veranda').reduce((c, e) => c + 2 + Math.max(0, Math.floor(Math.max(e.w, e.d) / 3)), 0);
    add({ key: 'porch-columns', section: 'frame', name: 'Porch and veranda columns', unit: 'piece', quantity: posts, basis: 'Two outer columns plus one every 3 m', shop: { q: 'column' }, provisional: true });
  }
  if (n('canopy')) add({ key: 'canopies', section: 'roof', name: 'Entrance canopies', unit: 'm²', quantity: Math.ceil(sum(['canopy'])), basis: `${n('canopy')} canopy(ies)`, shop: { q: 'canopy' }, provisional: true });
  if (n('pergola')) add({ key: 'pergolas', section: 'external', name: 'Pergolas (timber or steel)', unit: 'm²', quantity: Math.ceil(sum(['pergola'])), basis: `${n('pergola')} pergola(s)`, shop: { category: 'timber', q: 'pergola' }, provisional: true });
  const faceM2 = (k: ElementKind) => els.filter((e) => e.kind === k).reduce((s2, e) => s2 + Math.max(e.w, e.d) * (e.heightM ?? d.storeyHeightM), 0);
  if (n('screen')) add({ key: 'screens', section: 'finishes', name: 'Louvre screens', unit: 'm²', quantity: Math.ceil(faceM2('screen')), basis: `${n('screen')} screen(s), face area`, shop: { q: 'louvre' }, provisional: true });
  if (n('feature-wall')) add({ key: 'cladding', section: 'finishes', name: 'Feature wall cladding (stone, timber or brick)', unit: 'm²', quantity: Math.ceil(faceM2('feature-wall')), basis: `${n('feature-wall')} feature wall(s), face area`, shop: { q: 'wall cladding' }, provisional: true });
  return lines;
}

// ---------------------------------------------------------------- helpers

function round(n: number, dp: number) { const k = 10 ** dp; return Math.round(n * k) / k; }
function clampInt(n: unknown, lo: number, hi: number) { const v = Math.round(Number(n)); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; }

// ---------------------------------------------------------------- reading a brief from plain words (no AI needed)

export type BuildIntent = 'build_home' | 'other_project' | 'shopping' | 'unclear';
export interface BriefReading { intent: BuildIntent; plot: Plot | null; brief: Partial<DesignBrief> }

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
const NUM = '(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)';

/** Building types recognised in plain words, most specific first. */
const TYPE_WORDS: [BuildingType, RegExp][] = [
  ['mixed-use', /\b(mixed[- ]use|shops? (?:below|downstairs|on the ground floor)|(?:flats|apartments|offices) (?:above|upstairs|on top of) (?:the )?shops)\b/],
  ['hotel', /\b(hotel|guest ?house|motel|hostel|lodge|inn|short[- ]let)\b/],
  ['event-hall', /\b(event (?:centre|center|hall)|events? centre|wedding hall|banquet hall|multi-?purpose hall|town hall)\b/],
  ['worship', /\b(church|mosque|chapel|cathedral|parish|place of worship|worship centre)\b/],
  ['school', /\b(school|college|nursery|creche|crèche|academy|classrooms?)\b/],
  ['clinic', /\b(clinic|hospital|health ?cent(?:re|er)|maternity|medical cent(?:re|er))\b/],
  ['warehouse', /\b(warehouse|factory|depot|storage facility|cold room|godown)\b/],
  ['office', /\b(office (?:block|building|complex|space|tower)|offices|head ?office|corporate (?:hq|headquarters))\b/],
  ['shops', /\b(plaza|shopping (?:complex|centre|center|mall)|shops|lock[- ]?up shops?|mall|stalls)\b/],
  ['terrace', /\b(terraced? (?:houses?|duplex(?:es)?|bungalows?)|townhouses?|town houses?|row houses?)\b/],
  ['apartments', /\b(block of (?:flats|apartments)|apartment (?:block|building|complex)|blocks? of \d+ flats|\d+ flats|apartments|\d+ units)\b/],
];

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
  const type = TYPE_WORDS.find(([, re]) => re.test(t))?.[0];
  if (type) brief.type = type;
  // Storeys: "4-storey", "four floors", or the Nigerian "G+3" (ground plus three = four storeys).
  const gplus = t.match(/\bg\s*\+\s*(\d{1,2})\b/);
  const floors = t.match(new RegExp(`\\b${NUM}[- ]?(?:stor(?:e)?y|stories|storeys|floors?|levels?)\\b`));
  if (gplus) brief.storeys = Math.min(10, num(gplus[1]!) + 1);
  else if (floors && num(floors[1]!) >= 1 && num(floors[1]!) <= 10) brief.storeys = num(floors[1]!);
  else if (/\b(duplex|storey building|upstairs)\b/.test(t)) brief.storeys = 2;
  else if (/\b(bungalow|single[- ]stor(?:e)?y)\b/.test(t)) brief.storeys = 1;
  if (type === 'bungalow' || (!type && /\bbungalow\b/.test(t))) brief.type = 'bungalow';
  if (!type && /\bduplex\b/.test(t)) brief.type = 'duplex';
  // How big: rooms, flats, shops, classrooms, seats or floor area, as the type counts it.
  const count = (re: string) => { const m = t.match(new RegExp(`\\b${NUM}\\s*-?\\s*(?:${re})\\b`)); return m ? num(m[1]!) : undefined; };
  const per = (n: number | undefined) => (n === undefined ? undefined : Math.ceil(n / Math.max(1, brief.storeys ?? BUILDING_TYPES[type ?? 'bungalow'].storeys.default)));
  const units = type === 'hotel' ? per(count('(?:guest )?rooms?|keys|suites'))
    : type === 'apartments' ? per(count('flats|apartments|units'))
    : type === 'shops' ? per(count('shops|stores|lock[- ]?ups|stalls'))
    : type === 'mixed-use' ? count('shops|stores|lock[- ]?ups')
    : type === 'school' ? per(count('classrooms?'))
    : type === 'clinic' ? count('consulting rooms?|wards?')
    : type === 'office' ? per(count('office suites|suites'))
    : type === 'terrace' ? count('(?:terraced? )?(?:houses|homes|units|townhouses|duplexes)')
    : type === 'event-hall' || type === 'worship' ? count('seats?|seater|people|guests|worshippers|capacity') ?? (t.match(/capacity (?:of )?(\d+)/) ? Number(t.match(/capacity (?:of )?(\d+)/)![1]) : undefined)
    : type === 'warehouse' ? count('m2|m²|sqm|square met(?:re|er)s')
    : undefined;
  if (units !== undefined && units > 0) brief.units = units;
  const feats: [FeatureKey, RegExp][] = [
    ['gym', /\b(gym|fitness)\b/], ['cinema', /\b(cinema|movie room|theatre room|theater room)\b/], ['gaming', /\b(gaming|game room|games room|playstation)\b/],
    ['laundry', /\blaundry\b/], ['prayer', /\bprayer room\b/], ['family-lounge', /\bfamily (?:lounge|room)\b/], ['lift', /\b(lift|elevator)\b/],
    ['conference', /\b(conference|boardroom)\b/], ['restaurant', /\b(restaurant|bar and restaurant)\b/], ['canteen', /\b(canteen|cafeteria)\b/],
    ['library', /\blibrary\b/], ['lab', /\b(lab|labs|laboratory)\b/], ['pharmacy', /\bpharmacy\b/], ['upper-offices', /\boffices (?:above|upstairs)\b/],
  ];
  const found = feats.filter(([, re]) => re.test(t)).map(([f]) => f);
  if (found.length) brief.features = found;
  if (/\bopen[- ]plan\b/.test(t)) brief.kitchen = 'open';
  if (/\b(study|home office)\b/.test(t) || (!type && /\boffice\b/.test(t))) brief.study = true;
  if (/\b(no|without) (an? )?ensuite\b/.test(t)) brief.ensuite = false;
  else if (/\b(ensuite|en-suite|master bath)\b/.test(t)) brief.ensuite = true;
  if (/\b(no|without) (a )?(bq|boys'? ?quarters?)\b/.test(t)) brief.bq = false;
  else if (/\b(bq|boys'? ?quarters?|staff quarters?|servants'? quarters?|domestic quarters?)\b/.test(t)) brief.bq = true;
  if (/\b(parapet|concealed|hidden) roof\b/.test(t)) brief.roof = 'hidden';
  else if (/\bflat roof\b/.test(t)) brief.roof = 'flat';
  else if (/\bdutch gable\b/.test(t)) brief.roof = 'dutch';
  else if (/\bmansard\b/.test(t)) brief.roof = 'mansard';
  else if (/\bbutterfly\b/.test(t)) brief.roof = 'butterfly';
  else if (/\b(shed|skillion|mono[- ]?pitch(ed)?|lean[- ]to) roof\b/.test(t)) brief.roof = 'shed';
  else if (/\bgable\b/.test(t)) brief.roof = 'gable';
  else if (/\bhip(ped)? roof\b/.test(t)) brief.roof = 'hip';
  if (/\bstone[- ]coated\b/.test(t)) brief.roofFinish = 'stone-coated';
  else if (/\b(concrete|clay) (roof )?tiles?\b/.test(t)) brief.roofFinish = 'concrete-tile';
  else if (/\bstanding[- ]seam\b/.test(t)) brief.roofFinish = 'standing-seam';
  else if (/\b(long[- ]?span|aluminium|aluminum) (roof|roofing|sheets?)\b/.test(t)) brief.roofFinish = 'aluminium';
  const cars = t.match(/(\d|one|two)\s*-?\s*(?:car|parking)/);
  if (cars) brief.parking = num(cars[1]!);
  else if (/\b(garage|parking|car port|carport)\b/.test(t)) brief.parking = 1;
  if (/\b(modern|contemporary|minimalist)\b/.test(t)) brief.style = 'modern';
  else if (/\b(classic|traditional|colonial)\b/.test(t)) brief.style = 'classic';
  else if (/\b(tropical|veranda|verandah|breezy)\b/.test(t)) brief.style = 'tropical';
  const plot = parsePlotSize(t);
  const building = /\b(build|house|home|bungalow|duplex|bedroom|bed\b|flat|apartment|storey)/.test(t) || brief.bedrooms !== undefined || !!type;
  const shopping = /\b(buy|shop|shopping|price|prices|cost of|where can i get|supplier|order)\b/.test(t);
  const other = /\b(fence|fencing|shop front|renovat|extension|borehole|swimming pool)\b/.test(t);
  const intent: BuildIntent = building && !shopping ? 'build_home' : other ? 'other_project' : shopping ? 'shopping' : plot ? 'build_home' : 'unclear';
  return { intent, plot, brief };
}
