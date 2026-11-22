/**
 * The design editor: a person's own changes to a generated design, kept as a list of small operations that are
 * replayed on top of it (so they survive reloads and can be undone). After the operations the whole design is
 * rebuilt (walls, doors, windows, checks, notes), so the 3D view, the drawings and the bill of materials always
 * match the edited rooms. Every operation keeps the rooms tiling their blocks; anything that would break a rule the
 * editor enforces (minimum room sizes, the building line, the stair) is refused with a reason.
 */
import {
  DEFAULT_DESIGN_CONFIG, rebuildDesign,
  type Block, type Design, type DesignBrief, type DesignConfig, type Plot, type Room, type RoomKind,
} from './design';

export type EditSide = 'front' | 'rear' | 'left' | 'right';
export type EditableKind = Exclude<RoomKind, 'corridor' | 'stair' | 'lift'>;

export type DesignEdit =
  /** Move one wall of a room by `by` metres: positive makes the room bigger. Outside walls move the whole wing. */
  | { op: 'move'; room: string; side: EditSide; by: number }
  /** Divide a room with a new wall: 'v' runs front to back (splits the width), 'h' across (splits the depth). */
  | { op: 'split'; room: string; dir: 'v' | 'h'; at?: number }
  /** Take the wall out between two rooms that line up: the first room keeps its use and grows. */
  | { op: 'merge'; room: string; with: string }
  | { op: 'rename'; room: string; name: string }
  | { op: 'use'; room: string; kind: EditableKind };

export const ROOM_KIND_LABELS: Record<EditableKind, string> = {
  living: 'Living room', dining: 'Dining', kitchen: 'Kitchen', 'living-kitchen': 'Living, dining and kitchen', lounge: 'Family lounge',
  master: 'Master bedroom', bedroom: 'Bedroom', study: 'Study', bathroom: 'Bathroom', ensuite: 'Ensuite', wc: 'Toilet (WC)', store: 'Store',
  gym: 'Gym', gaming: 'Gaming room', cinema: 'Home cinema', laundry: 'Laundry', prayer: 'Prayer room',
  lobby: 'Lobby', toilets: 'Toilets', plant: 'Plant room', office: 'Office', 'open-office': 'Open-plan office', meeting: 'Meeting room',
  shop: 'Shop', flat: 'Flat', 'guest-room': 'Guest room', restaurant: 'Restaurant', hall: 'Hall', stage: 'Stage', classroom: 'Classroom',
  library: 'Library', lab: 'Laboratory', consult: 'Consulting room', ward: 'Ward', warehouse: 'Warehouse floor', loading: 'Loading bay',
};
/** Uses offered in the editor's list for a house (the rest appear only on larger buildings). */
export const HOUSE_KINDS: EditableKind[] = ['living', 'dining', 'kitchen', 'living-kitchen', 'lounge', 'master', 'bedroom', 'study', 'bathroom', 'ensuite', 'wc', 'store', 'gym', 'gaming', 'cinema', 'laundry', 'prayer'];
export const EDITABLE_KINDS = Object.keys(ROOM_KIND_LABELS) as EditableKind[];

/** Which saved edits belong to which design: the plot, the room programme and the layout (not the roof or style). */
export function designKey(plot: Plot, brief: DesignBrief, designId: string): string {
  const { roof: _r, roofFinish: _f, roofColour: _c, roofPitch: _p, style: _s, ...rooms } = brief;
  return JSON.stringify({ w: plot.widthM, d: plot.depthM, b: rooms, id: designId });
}

/** Applies the edits in order. `results[i]` is null when edit i applied, or the reason it was refused. */
export function applyEdits(base: Design, edits: DesignEdit[], cfg: DesignConfig = DEFAULT_DESIGN_CONFIG): { design: Design; results: (string | null)[] } {
  let state: State = { blocks: base.blocks.map((b) => ({ ...b })), rooms: base.rooms.map((r) => ({ ...r })) };
  const results = edits.map((e) => {
    const out = applyOne(base, state, e, cfg);
    if (typeof out === 'string') return out;
    state = out;
    return null;
  });
  const applied = results.filter((r) => r === null).length;
  return { design: applied ? rebuildDesign(base, state.blocks, state.rooms, applied, cfg) : base, results };
}

interface State { blocks: Block[]; rooms: Room[] }
const EPS = 1e-3;
const r2 = (n: number) => Math.round(n * 100) / 100;
const near = (a: number, b: number) => Math.abs(a - b) < EPS;

function minDim(kind: RoomKind, cfg: DesignConfig): number {
  if (kind === 'corridor') return cfg.minCorridorM;
  if (kind === 'stair') return cfg.stair.minWidthM;
  if (kind === 'lift') return 2.4;
  return Math.max(0.9, cfg.rooms[kind].minDimM);
}

function applyOne(base: Design, s: State, e: DesignEdit, cfg: DesignConfig): State | string {
  const room = s.rooms.find((r) => r.id === e.room);
  if (!room) return 'That room is not in this design any more.';
  switch (e.op) {
    case 'rename': {
      const name = e.name.trim().replace(/\s+/g, ' ');
      if (!name || name.length > 40) return 'Room names are 1 to 40 characters.';
      return { ...s, rooms: s.rooms.map((r) => (r.id === room.id ? { ...r, name } : r)) };
    }
    case 'use': {
      if (room.kind === 'corridor' || room.kind === 'stair') return 'Hallways and stairs keep their use.';
      if (!Object.hasOwn(ROOM_KIND_LABELS, e.kind)) return 'Choose a room use from the list.';
      const others = s.rooms.filter((r) => r.id !== room.id);
      return { ...s, rooms: s.rooms.map((r) => (r.id === room.id ? { ...r, kind: e.kind, name: defaultName(e.kind, others) } : r)) };
    }
    case 'split': return split(s, room, e.dir, e.at ?? 0.5);
    case 'merge': return merge(s, room, e.with);
    case 'move': return move(base, s, room, e.side, e.by, cfg);
  }
}

function defaultName(kind: EditableKind, others: Room[]): string {
  if (kind !== 'bedroom') return ROOM_KIND_LABELS[kind];
  const n = others.filter((r) => r.kind === 'bedroom' || r.kind === 'master').length + 1;
  return `Bedroom ${n}`;
}

function nextId(rooms: Room[]): string {
  return `r${Math.max(0, ...rooms.map((r) => Number(r.id.slice(1)) || 0)) + 1}`;
}

function split(s: State, room: Room, dir: 'v' | 'h', at: number): State | string {
  if (room.kind === 'stair' || room.kind === 'corridor') return 'Hallways and stairs cannot be divided.';
  const f = Math.min(0.8, Math.max(0.2, at));
  const len = dir === 'v' ? room.w : room.d;
  const a = r2(len * f); const b = r2(len - a);
  if (a < 0.9 || b < 0.9) return 'Both parts would be under 0.9 m wide.';
  const areaB = (dir === 'v' ? b * room.d : room.w * b);
  const kind: EditableKind = areaB < 4 ? 'store' : room.kind === 'master' ? 'bedroom' : room.kind === 'living' || room.kind === 'living-kitchen' ? 'lounge' : room.kind as EditableKind;
  const first: Room = dir === 'v' ? { ...room, w: a } : { ...room, d: a };
  const second: Room = dir === 'v'
    ? { ...room, id: nextId(s.rooms), x: r2(room.x + a), w: b, kind, name: defaultName(kind, s.rooms) }
    : { ...room, id: nextId(s.rooms), y: r2(room.y + a), d: b, kind, name: defaultName(kind, s.rooms) };
  return { ...s, rooms: [...s.rooms.map((r) => (r.id === room.id ? first : r)), second] };
}

function merge(s: State, room: Room, withId: string): State | string {
  const other = s.rooms.find((r) => r.id === withId);
  if (!other) return 'That room is not in this design any more.';
  if (other.storey !== room.storey || other.block !== room.block) return 'Only rooms side by side on the same floor can be joined.';
  if (room.kind === 'stair' || other.kind === 'stair') return 'The stair cannot be joined to a room.';
  let merged: Room | null = null;
  if (near(room.y, other.y) && near(room.d, other.d) && (near(room.x + room.w, other.x) || near(other.x + other.w, room.x))) {
    merged = { ...room, x: Math.min(room.x, other.x), w: r2(room.w + other.w) };
  } else if (near(room.x, other.x) && near(room.w, other.w) && (near(room.y + room.d, other.y) || near(other.y + other.d, room.y))) {
    merged = { ...room, y: Math.min(room.y, other.y), d: r2(room.d + other.d) };
  }
  if (!merged) return 'These rooms do not line up along a whole wall, so joining them would not make one room.';
  return { ...s, rooms: s.rooms.filter((r) => r.id !== other.id).map((r) => (r.id === room.id ? merged! : r)) };
}

function move(base: Design, s: State, room: Room, side: EditSide, by: number, cfg: DesignConfig): State | string {
  if (!Number.isFinite(by) || Math.abs(by) < 0.01) return 'Move a wall by at least 1 cm.';
  if (room.kind === 'stair') return 'The stair stays where it is so it lines up between floors.';
  const block = s.blocks.find((b) => b.id === room.block)!;
  const h = side === 'front' || side === 'rear';
  const at = side === 'front' ? room.y : side === 'rear' ? room.y + room.d : side === 'left' ? room.x : room.x + room.w;
  const out = side === 'rear' || side === 'right' ? 1 : -1;
  const to = r2(at + out * by);
  const blockEdge = h ? near(at, block.y) || near(at, block.y + block.d) : near(at, block.x) || near(at, block.x + block.w);
  return blockEdge ? extend(base, s, block, side, to, cfg) : partition(s, room, h, at, to, cfg);
}

/** Moves an inside wall: every room along it on that floor and wing changes, the line stays straight. */
function partition(s: State, seed: Room, h: boolean, at: number, to: number, cfg: DesignConfig): State | string {
  const same = s.rooms.filter((x) => x.storey === seed.storey && x.block === seed.block);
  const lowEdge = (x: Room) => (h ? x.y + x.d : x.x + x.w);
  const highEdge = (x: Room) => (h ? x.y : x.x);
  const span = (x: Room): [number, number] => (h ? [x.x, x.x + x.w] : [x.y, x.y + x.d]);
  let [a0, a1] = span(seed);
  const low = new Set<Room>(); const high = new Set<Room>();
  // Grow the stretch of wall until both sides are covered by whole rooms.
  for (let changed = true; changed;) {
    changed = false;
    for (const x of same) {
      const isLow = near(lowEdge(x), at); const isHigh = near(highEdge(x), at);
      if (!isLow && !isHigh) continue;
      const [p, q] = span(x);
      if (q <= a0 + EPS || p >= a1 - EPS) continue;
      (isLow ? low : high).add(x);
      if (p < a0 - EPS) { a0 = p; changed = true; }
      if (q > a1 + EPS) { a1 = q; changed = true; }
    }
  }
  const covered = (set: Set<Room>) => [...set].reduce((sum, x) => sum + span(x)[1] - span(x)[0], 0);
  if (!low.size || !high.size || Math.abs(covered(low) - (a1 - a0)) > 0.01 || Math.abs(covered(high) - (a1 - a0)) > 0.01) return 'This wall cannot move on its own here.';
  const all = [...low, ...high];
  if (all.some((x) => x.kind === 'stair')) return 'This wall is beside the stair, which has to line up between floors.';
  for (const x of low) if (to - highEdge(x) < minDim(x.kind, cfg) - EPS) return `${x.name} would be narrower than ${minDim(x.kind, cfg)} m.`;
  for (const x of high) if (lowEdge(x) - to < minDim(x.kind, cfg) - EPS) return `${x.name} would be narrower than ${minDim(x.kind, cfg)} m.`;
  const rooms = s.rooms.map((x) => {
    if (low.has(x)) return h ? { ...x, d: r2(to - x.y) } : { ...x, w: r2(to - x.x) };
    if (high.has(x)) return h ? { ...x, y: to, d: r2(x.y + x.d - to) } : { ...x, x: to, w: r2(x.x + x.w - to) };
    return x;
  });
  return { ...s, rooms };
}

/** Moves an outside wall of a wing: the wing and every room along that side, on every floor, change. */
function extend(base: Design, s: State, block: Block, side: EditSide, to: number, cfg: DesignConfig): State | string {
  const env = base.envelope;
  const ov = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0) > 0.05;
  const at = side === 'front' ? block.y : side === 'rear' ? block.y + block.d : side === 'left' ? block.x : block.x + block.w;
  const attached = s.blocks.some((o) => o.id !== block.id && (side === 'front' || side === 'rear'
    ? near(side === 'front' ? o.y + o.d : o.y, at) && ov(o.x, o.x + o.w, block.x, block.x + block.w)
    : near(side === 'left' ? o.x + o.w : o.x, at) && ov(o.y, o.y + o.d, block.y, block.y + block.d)));
  if (attached) return 'This wall joins two wings, so it cannot move.';
  const nb: Block = { ...block };
  if (side === 'front') { nb.y = to; nb.d = r2(block.y + block.d - to); }
  if (side === 'rear') nb.d = r2(to - block.y);
  if (side === 'left') { nb.x = to; nb.w = r2(block.x + block.w - to); }
  if (side === 'right') nb.w = r2(to - block.x);
  // The building line, and the parking in front of the house.
  const frontMin = block.kind === 'house' && base.brief.parking ? Math.max(env.y, cfg.parking.depthM + 0.5) : env.y;
  if (nb.x < env.x - EPS || nb.x + nb.w > env.x + env.w + EPS || nb.y < frontMin - EPS || nb.y + nb.d > env.y + env.d + EPS) {
    const room = side === 'front' ? block.y - frontMin : side === 'rear' ? env.y + env.d - (block.y + block.d) : side === 'left' ? block.x - env.x : env.x + env.w - (block.x + block.w);
    return `That crosses the building line${side === 'front' && base.brief.parking ? ' or the parking in front' : ''}; this wall can move out at most ${Math.max(0, r2(room))} m.`;
  }
  for (const o of s.blocks) {
    if (o.id === block.id) continue;
    if (ov(o.x, o.x + o.w, nb.x, nb.x + nb.w) && ov(o.y, o.y + o.d, nb.y, nb.y + nb.d)) return `That would run into the ${o.name.toLowerCase()}.`;
  }
  const h = side === 'front' || side === 'rear';
  const edge = (x: Room) => (side === 'front' ? x.y : side === 'rear' ? x.y + x.d : side === 'left' ? x.x : x.x + x.w);
  const touching = s.rooms.filter((x) => x.block === block.id && near(edge(x), at));
  const rooms = s.rooms.map((x) => {
    if (!touching.includes(x)) return x;
    if (side === 'front') return { ...x, y: to, d: r2(x.y + x.d - to) };
    if (side === 'rear') return { ...x, d: r2(to - x.y) };
    if (side === 'left') return { ...x, x: to, w: r2(x.x + x.w - to) };
    return { ...x, w: r2(to - x.x) };
  });
  for (const x of rooms.filter((r) => touching.some((t) => t.id === r.id))) {
    const dim = h ? x.d : x.w;
    if (dim < minDim(x.kind, cfg) - EPS) return `${x.name} would be narrower than ${minDim(x.kind, cfg)} m.`;
    if (x.kind === 'stair' && Math.max(x.w, x.d) < cfg.stair.minRunM - EPS) return 'The stair would be too short.';
  }
  return { blocks: s.blocks.map((b) => (b.id === block.id ? nb : b)), rooms };
}
