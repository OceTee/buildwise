/**
 * Designs composed by an AI architect (the "designer"): it places the blocks (wings, towers, a boys' quarters) and
 * every room as rectangles on the plot. BuildWise turns that into a full design with the same pipeline as its own
 * engine (walls, doors, windows, checks, review, 3D, drawings, quantities) and lists what is wrong, so the AI can be
 * asked to fix it. Pure and deterministic: the browser rebuilds the same design from the saved layout.
 */
import { BUILDING_TYPES, isHouse } from './building';
import {
  DEFAULT_DESIGN_CONFIG, ROOF_OPTIONS, assembleFromRooms, normaliseBrief, siteLimits,
  type Block, type Design, type DesignBrief, type DesignConcept, type DesignConfig, type Plot, type RoofKind, type Room, type RoomKind,
} from './design';

export interface AiLayoutBlock { id: string; name: string; x: number; y: number; w: number; d: number; storeys: number; outbuilding?: boolean }
export interface AiLayoutRoom { block: string; storey: number; kind: RoomKind; name: string; x: number; y: number; w: number; d: number }
export interface AiLayout {
  name: string;
  idea: string;
  roof?: RoofKind;
  concept?: Omit<DesignConcept, 'source' | 'designId'>;
  blocks: AiLayoutBlock[];
  rooms: AiLayoutRoom[];
}

export const AI_ROOM_KINDS: RoomKind[] = [
  'living', 'dining', 'kitchen', 'living-kitchen', 'lounge', 'master', 'bedroom', 'study', 'bathroom', 'ensuite', 'wc', 'store', 'stair', 'corridor',
  'gym', 'gaming', 'cinema', 'laundry', 'prayer', 'lobby', 'lift', 'toilets', 'plant', 'office', 'open-office', 'meeting',
  'shop', 'flat', 'guest-room', 'restaurant', 'hall', 'stage', 'classroom', 'library', 'lab', 'consult', 'ward', 'warehouse', 'loading',
];

const snap = (n: number, step = 0.05) => Math.round(Number(n) / step) * step;
const r2 = (n: number) => Math.round(n * 100) / 100;

/** Tidies a layout: snapped coordinates, rooms nudged onto block edges, upper floors repeated in tall buildings. */
export function normaliseLayout(layout: AiLayout, briefIn: Partial<DesignBrief>): AiLayout {
  const brief = normaliseBrief(briefIn);
  const blocks = layout.blocks.map((b) => ({
    ...b, id: String(b.id).slice(0, 12), name: String(b.name).slice(0, 40),
    x: r2(snap(b.x)), y: r2(snap(b.y)), w: r2(snap(b.w)), d: r2(snap(b.d)), storeys: Math.max(1, Math.min(10, Math.round(b.storeys))),
  }));
  const byId = new Map(blocks.map((b) => [b.id, b]));
  let rooms = layout.rooms
    .filter((r) => byId.has(String(r.block)) && AI_ROOM_KINDS.includes(r.kind))
    .map((r) => {
      const b = byId.get(String(r.block))!;
      let x = snap(r.x); let y = snap(r.y); let x2 = snap(r.x + r.w); let y2 = snap(r.y + r.d);
      // Within 25 cm of a block edge means on it.
      const near = (a: number, e: number) => Math.abs(a - e) <= 0.25;
      if (near(x, b.x)) x = b.x; if (near(y, b.y)) y = b.y;
      if (near(x2, b.x + b.w)) x2 = b.x + b.w; if (near(y2, b.y + b.d)) y2 = b.y + b.d;
      return { block: b.id, storey: Math.max(0, Math.round(r.storey)), kind: r.kind, name: String(r.name).slice(0, 40), x: r2(x), y: r2(y), w: r2(x2 - x), d: r2(y2 - y) };
    })
    .filter((r) => r.w > 0.2 && r.d > 0.2);
  // Tall buildings: the AI draws the ground floor and one typical upper floor; the rest repeat it.
  const top = Math.max(0, ...rooms.map((r) => r.storey));
  if (brief.storeys >= 4 && top >= 1 && top < brief.storeys - 1) {
    const typical = rooms.filter((r) => r.storey === 1);
    for (let s = top + 1; s < brief.storeys; s++) rooms = [...rooms, ...typical.map((r) => ({ ...r, storey: s, name: r.name.replace(/\b1(\d{2})\b/, `${s}$1`).replace(/(Flat|Ward|Shop|Classroom|Office suite) 1/, `$1 ${s}`) }))];
    for (const b of blocks) if (typical.some((r) => r.block === b.id)) b.storeys = brief.storeys;
  }
  return { name: String(layout.name).slice(0, 60), idea: String(layout.idea).slice(0, 300), ...(layout.roof && Object.hasOwn(ROOF_OPTIONS, layout.roof) ? { roof: layout.roof } : {}), ...(layout.concept ? { concept: layout.concept } : {}), blocks, rooms };
}

/** Area of a block's floor not covered by rooms, and area covered twice, from a 0.1 m raster. */
function coverage(b: AiLayoutBlock, rooms: AiLayoutRoom[]): { gapM2: number; overlapM2: number; gapAt: [number, number] | null } {
  const step = 0.1;
  const nx = Math.max(1, Math.round(b.w / step)); const ny = Math.max(1, Math.round(b.d / step));
  if (nx * ny > 400_000) return { gapM2: 0, overlapM2: 0, gapAt: null };
  const grid = new Uint8Array(nx * ny);
  for (const r of rooms) {
    const x0 = Math.max(0, Math.round((r.x - b.x) / step)); const x1 = Math.min(nx, Math.round((r.x + r.w - b.x) / step));
    const y0 = Math.max(0, Math.round((r.y - b.y) / step)); const y1 = Math.min(ny, Math.round((r.y + r.d - b.y) / step));
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) grid[j * nx + i] = Math.min(255, grid[j * nx + i]! + 1);
  }
  let gaps = 0; let over = 0; let gapAt: [number, number] | null = null;
  for (let k = 0; k < grid.length; k++) {
    if (grid[k] === 0) { gaps++; if (!gapAt) gapAt = [r2(b.x + (k % nx) * step), r2(b.y + Math.floor(k / nx) * step)]; }
    else if (grid[k]! > 1) over++;
  }
  return { gapM2: r2(gaps * step * step), overlapM2: r2(over * step * step), gapAt };
}

/** The same building as a full BuildWise design, plus everything an architect would have to fix. */
export function designFromLayout(plot: Plot, briefIn: Partial<DesignBrief>, raw: AiLayout, id: string, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): { design: Design | null; problems: string[]; layout: AiLayout } {
  const layout = normaliseLayout(raw, briefIn);
  const brief = normaliseBrief({ ...briefIn, ...(layout.roof ? { roof: layout.roof } : {}) });
  const problems: string[] = [];
  const { envelope, forecourtY } = siteLimits(plot, brief, cfg);
  if (!layout.blocks.length || !layout.rooms.length) return { design: null, problems: ['The layout has no blocks or no rooms.'], layout };

  for (const b of layout.blocks) {
    const inside = b.x >= envelope.x - 0.01 && b.y >= envelope.y - 0.01 && b.x + b.w <= envelope.x + envelope.w + 0.01 && b.y + b.d <= envelope.y + envelope.d + 0.01;
    if (!inside) problems.push(`Block ${b.id} (${b.x}, ${b.y}, ${b.w} × ${b.d} m) is outside the buildable area x ${envelope.x}–${r2(envelope.x + envelope.w)}, y ${envelope.y}–${r2(envelope.y + envelope.d)}.`);
    if (!b.outbuilding && brief.parking && b.y < forecourtY - 0.01) problems.push(`Block ${b.id} starts at y ${b.y}; keep y ≥ ${forecourtY} so the parking in front fits.`);
    for (let s = 0; s < b.storeys; s++) {
      const here = layout.rooms.filter((r) => r.block === b.id && r.storey === s);
      if (!here.length) { problems.push(`Block ${b.id} floor ${s} has no rooms: every floor of a block must be filled.`); continue; }
      const out = here.filter((r) => r.x < b.x - 0.01 || r.y < b.y - 0.01 || r.x + r.w > b.x + b.w + 0.01 || r.y + r.d > b.y + b.d + 0.01);
      if (out.length) problems.push(`On block ${b.id} floor ${s}, these rooms stick out of the block: ${out.map((r) => r.name).join(', ')}.`);
      const c = coverage(b, here);
      if (c.gapM2 > 0.5) problems.push(`Block ${b.id} floor ${s}: ${c.gapM2} m² is not covered by any room (first gap near x ${c.gapAt?.[0]}, y ${c.gapAt?.[1]}). Rooms and corridors must tile the block exactly.`);
      if (c.overlapM2 > 0.3) problems.push(`Block ${b.id} floor ${s}: rooms overlap by ${c.overlapM2} m².`);
    }
    const above = layout.rooms.filter((r) => r.block === b.id && r.storey >= b.storeys);
    if (above.length) problems.push(`Block ${b.id} has ${b.storeys} storey(s) but rooms on floor ${above[0]!.storey}.`);
  }
  for (let i = 0; i < layout.blocks.length; i++) for (let j = i + 1; j < layout.blocks.length; j++) {
    const a = layout.blocks[i]!; const c = layout.blocks[j]!;
    const ox = Math.min(a.x + a.w, c.x + c.w) - Math.max(a.x, c.x); const oy = Math.min(a.y + a.d, c.y + c.d) - Math.max(a.y, c.y);
    if (ox > 0.05 && oy > 0.05) problems.push(`Blocks ${a.id} and ${c.id} overlap; blocks may touch but not overlap.`);
  }
  // What the brief asked for.
  const count = (k: RoomKind[]) => layout.rooms.filter((r) => k.includes(r.kind)).length;
  const info = BUILDING_TYPES[brief.type];
  if (isHouse(brief.type) && count(['master', 'bedroom']) < brief.bedrooms) problems.push(`Only ${count(['master', 'bedroom'])} bedrooms; the brief asks for ${brief.bedrooms} (one master).`);
  if (isHouse(brief.type) && brief.ensuite && !count(['ensuite'])) problems.push('The master bedroom needs its own ensuite (kind "ensuite", entered from the master bedroom).');
  if (isHouse(brief.type) && count(['bathroom']) < brief.bathrooms) problems.push(`Only ${count(['bathroom'])} shared bathroom(s); the brief asks for ${brief.bathrooms} besides the ensuite.`);
  const unitKind: Partial<Record<string, RoomKind>> = { apartments: 'flat', hotel: 'guest-room', school: 'classroom', shops: 'shop' };
  const uk = unitKind[brief.type];
  if (uk && info.units?.perFloor) {
    const want = Math.max(1, Math.round(brief.units * Math.max(1, brief.storeys - (brief.type === 'hotel' ? 0.5 : 0)) * 0.8));
    if (count([uk]) < want) problems.push(`Only ${count([uk])} ${uk}s in the whole building; the brief asks for about ${brief.units} per floor.`);
  }
  for (const f of brief.features) {
    const need: Partial<Record<string, RoomKind>> = { gym: 'gym', gaming: 'gaming', cinema: 'cinema', laundry: 'laundry', prayer: 'prayer', restaurant: 'restaurant', library: 'library', lab: 'lab' };
    if (need[f] && !count([need[f]!])) problems.push(`The brief asks for a ${f} room.`);
  }

  const blocks: Block[] = layout.blocks.map((b) => ({ id: b.id, name: b.name, kind: b.outbuilding ? 'outbuilding' : 'house', storeys: b.storeys, x: b.x, y: b.y, w: b.w, d: b.d, ridge: b.w >= b.d ? 'x' : 'y' }));
  if (!blocks.some((b) => b.kind === 'house')) return { design: null, problems: [...problems, 'There is no main building (every block is marked as an outbuilding).'], layout };
  const rooms: Room[] = layout.rooms.map((r, i) => ({ id: `r${i + 1}`, kind: r.kind, name: r.name, storey: r.storey, block: r.block, x: r.x, y: r.y, w: r.w, d: r.d }));
  const design = assembleFromRooms(plot, brief, blocks, rooms, { id, name: layout.name, blurb: layout.idea }, cfg);
  for (const c of design.checks.filter((x) => x.status === 'fail')) problems.push(`${c.label}: ${c.detail}`);
  if (layout.concept) design.concept = { ...layout.concept, designId: id, source: 'ai' };
  return { design, problems, layout };
}

/** The JSON schema the AI designer answers in (Gemini / OpenAPI-style subset: types, enum, min/max, required). */
export function aiLayoutSchema(maxOptions = 2) {
  const num = { type: 'number' };
  const str = { type: 'string' };
  return {
    type: 'object',
    properties: {
      options: {
        type: 'array', minItems: 1, maxItems: maxOptions,
        items: {
          type: 'object',
          properties: {
            name: { ...str, description: 'Short name of the layout idea, e.g. "Courtyard plan".' },
            idea: { ...str, description: 'One sentence on the layout idea.' },
            roof: { type: 'string', enum: Object.keys(ROOF_OPTIONS) },
            concept: {
              type: 'object',
              properties: {
                title: { ...str, description: 'An evocative name for the design, under 6 words, no personal names.' },
                story: { ...str, description: 'Two or three sentences, second person, on living in or using it.' },
                moves: { type: 'array', items: str, minItems: 2, maxItems: 4 },
                palette: { type: 'object', properties: { walls: str, accents: str, roof: str }, required: ['walls', 'accents', 'roof'] },
              },
              required: ['title', 'story', 'moves', 'palette'],
            },
            blocks: {
              type: 'array', minItems: 1, maxItems: 6,
              items: {
                type: 'object',
                properties: { id: str, name: str, x: num, y: num, w: num, d: num, storeys: { type: 'integer', minimum: 1, maximum: 10 }, outbuilding: { type: 'boolean' } },
                required: ['id', 'name', 'x', 'y', 'w', 'd', 'storeys'],
              },
            },
            rooms: {
              type: 'array', minItems: 1,
              items: {
                type: 'object',
                properties: { block: str, storey: { type: 'integer', minimum: 0, maximum: 9 }, kind: { type: 'string', enum: AI_ROOM_KINDS }, name: str, x: num, y: num, w: num, d: num },
                required: ['block', 'storey', 'kind', 'name', 'x', 'y', 'w', 'd'],
              },
            },
          },
          required: ['name', 'idea', 'roof', 'concept', 'blocks', 'rooms'],
        },
      },
    },
    required: ['options'],
  };
}

/** Everything the designer needs to know about the site and the brief, as compact numbers (no personal data). */
export function designerBrief(plot: Plot, briefIn: Partial<DesignBrief>, cfg: DesignConfig = DEFAULT_DESIGN_CONFIG) {
  const brief = normaliseBrief(briefIn);
  const info = BUILDING_TYPES[brief.type];
  const { envelope, forecourtY } = siteLimits(plot, brief, cfg);
  return {
    buildingType: info.label,
    storeys: brief.storeys,
    ...(info.units ? { size: `${brief.units} ${info.units.short}` } : {}),
    ...(info.bedrooms ? { bedrooms: `${brief.bedrooms}${info.bedrooms.label === 'Bedrooms' ? '' : ` (${info.bedrooms.label.toLowerCase()})`}` } : {}),
    features: brief.features,
    style: brief.style,
    roofPreference: brief.roof,
    plot: { widthM: plot.widthM, depthM: plot.depthM, streetSide: 'y = 0 (the front boundary); x runs along the street from the left boundary' },
    buildableArea: { x: envelope.x, y: envelope.y, w: r2(envelope.w), d: r2(envelope.d), note: 'every block must sit inside this rectangle (the setbacks)' },
    keepClearForParkingUntilY: brief.parking ? forecourtY : envelope.y,
    parkingSpaces: brief.parking,
    maxSiteCoveragePct: cfg.maxCoveragePct,
    maxFootprintM2: r2((plot.widthM * plot.depthM * cfg.maxCoveragePct) / 100),
    storeyHeightM: isHouse(brief.type) ? cfg.storeyHeightM : info.storeyHeightM,
    ...(isHouse(brief.type) ? { houseOptions: { sharedBathrooms: brief.bathrooms, masterEnsuite: brief.ensuite, kitchen: brief.kitchen, study: brief.study, guestWc: brief.guestWc, store: brief.store, boysQuarters: brief.bq } } : {}),
  };
}
