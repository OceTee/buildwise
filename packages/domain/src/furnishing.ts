/**
 * Furniture laid out the way an interior designer would, from the plan's own walls, doors and windows: not one item
 * pushed into a corner.
 *
 * Every item stands with its back to a wall side (`back`: n = the street side of the room, s, e, w), and the room's
 * doors keep a clear swing zone and a clear walk between them. Room by room:
 *  - living rooms and lounges: a focal wall (a TV or display unit on the longest solid wall, never the entrance wall,
 *    best without windows), the main sofa facing it 2.2–3.2 m away, a coffee table between, and armchairs or a second
 *    sofa closing the conversation group when the room is wide enough;
 *  - bedrooms: the bed's head on a solid wall (no door, ideally no window), not in line with the door, with clear space
 *    both sides and at the foot, bedside tables, and a wardrobe on another solid wall unless a walk-in wardrobe opens off
 *    the room;
 *  - dining rooms: a table sized to the room (four, six or eight seats) along its length, with room to pull chairs out;
 *  - kitchens: worktop runs on the door-free walls (an L or a galley with 1.1 m between), and a fridge at a run's end;
 *  - bathrooms, ensuites and WCs: the WC not facing the door, the shower in the far corner, a basin near the door;
 *  - studies, gyms and games rooms: a desk at the window, a bench in the middle.
 * Items that cannot keep their clearances are left out rather than squeezed in.
 */
import type { Design, Opening, Rect, Room, RoomKind } from './design';

export type FurnishingKind =
  | 'bed' | 'sofa' | 'armchair' | 'coffee-table' | 'tv-unit' | 'side-table' | 'wardrobe'
  | 'dining-table' | 'counter' | 'fridge' | 'toilet' | 'shower' | 'basin' | 'desk' | 'gaming-desk' | 'training-bench';
/** The side of the room an item has its back to: n (towards the street, low y), s, e (high x), w. */
export type Side = 'n' | 's' | 'e' | 'w';

export interface Furnishing extends Rect {
  id: string;
  roomId: string;
  kind: FurnishingKind;
  /** The wall the item's back is to (a sofa faces away from it, a bed's head is against it). */
  back: Side;
  /** True when the item's back is to an east or west wall (its width runs along y). */
  turn: boolean;
}

// ---------------------------------------------------------------- geometry

const EPS = 1e-6;
const r2 = (n: number) => Math.round(n * 100) / 100;
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.d - EPS && a.y + a.d > b.y + EPS;
const inside = (a: Rect, r: Rect) => a.x >= r.x - EPS && a.y >= r.y - EPS && a.x + a.w <= r.x + r.w + EPS && a.y + a.d <= r.y + r.d + EPS;
const along = (s: Side) => (s === 'n' || s === 's' ? 'x' : 'y');
/** The length of a room side. */
const sideLength = (r: Rect, s: Side) => (along(s) === 'x' ? r.w : r.d);
/** The room's depth measured away from a side. */
const depthFrom = (r: Rect, s: Side) => (along(s) === 'x' ? r.d : r.w);
const opposite: Record<Side, Side> = { n: 's', s: 'n', e: 'w', w: 'e' };

/**
 * An item `w` wide and `d` deep with its back to side `s`, its centre `at` metres along that side and `off` metres out
 * from the wall: the plan rectangle it covers.
 */
function against(r: Rect, s: Side, at: number, w: number, d: number, off = 0.03): Rect {
  switch (s) {
    case 'n': return { x: r.x + at - w / 2, y: r.y + off, w, d };
    case 's': return { x: r.x + at - w / 2, y: r.y + r.d - off - d, w, d };
    case 'w': return { x: r.x + off, y: r.y + at - w / 2, w: d, d: w };
    default: return { x: r.x + r.w - off - d, y: r.y + at - w / 2, w: d, d: w };
  }
}

interface Wall { side: Side; doors: [number, number][]; windows: [number, number][] }
/** Each side of a room with its doors and windows, as intervals measured along the side from its start. */
function wallsOf(room: Room, openings: Opening[]): Wall[] {
  return (['n', 's', 'e', 'w'] as Side[]).map((side) => {
    const horiz = along(side) === 'x';
    const line = side === 'n' ? room.y : side === 's' ? room.y + room.d : side === 'w' ? room.x : room.x + room.w;
    const start = horiz ? room.x : room.y; const len = horiz ? room.w : room.d;
    const on = openings.filter((o) => o.storey === room.storey && o.dir === (horiz ? 'h' : 'v') && Math.abs(o.at - line) < 0.02
      && o.to > start + EPS && o.from < start + len - EPS);
    const span = (o: Opening): [number, number] => [Math.max(0, o.from - start), Math.min(len, o.to - start)];
    return { side, doors: on.filter((o) => o.kind === 'door').map(span), windows: on.filter((o) => o.kind === 'window').map(span) };
  });
}
/** The free stretches of a wall (no door), longest first. */
function solidStretches(room: Room, wall: Wall, avoidWindows = false): [number, number][] {
  const len = sideLength(room, wall.side);
  const cuts = [...wall.doors.map(([a, b]): [number, number] => [a - 0.15, b + 0.15]), ...(avoidWindows ? wall.windows : [])].sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [a, b] of cuts) { if (a > at + 0.3) out.push([at, a]); at = Math.max(at, b); }
  if (len > at + 0.3) out.push([at, len]);
  return out.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
}

/**
 * The swing and step zone inside the room in front of each of its doors, and (with `walks`) the walk between its
 * doors. People walk round a dining table and along worktops, so those rooms keep only the doorways clear.
 */
function keepClear(room: Room, walls: Wall[], walks = true, swing = 1.0): Rect[] {
  const zones: Rect[] = [];
  const centres: { x: number; y: number }[] = [];
  for (const wall of walls) for (const [a, b] of wall.doors) {
    const w = b - a + 0.2; const mid = (a + b) / 2;
    const z = against(room, wall.side, mid, w, Math.min(swing, depthFrom(room, wall.side)), 0);
    zones.push(z);
    centres.push({ x: z.x + z.w / 2, y: z.y + z.d / 2 });
  }
  // The walk between each pair of doors: an L of 0.9 m wide strips through the room.
  if (walks) for (let i = 0; i < centres.length; i++) for (let j = i + 1; j < centres.length; j++) {
    const p = centres[i]!; const q = centres[j]!; const h = 0.45;
    zones.push({ x: Math.min(p.x, q.x) - h, y: p.y - h, w: Math.abs(p.x - q.x) + 2 * h, d: 2 * h });
    zones.push({ x: q.x - h, y: Math.min(p.y, q.y) - h, w: 2 * h, d: Math.abs(p.y - q.y) + 2 * h });
  }
  return zones;
}

// ---------------------------------------------------------------- the layouts, room by room

type Piece = { kind: FurnishingKind; rect: Rect; back: Side };
const piece = (kind: FurnishingKind, rect: Rect, back: Side): Piece => ({ kind, rect: { x: r2(rect.x), y: r2(rect.y), w: r2(rect.w), d: r2(rect.d) }, back });
/** Pieces fit when every one is inside the room, clear of the doors' zones and of each other. */
function fits(room: Room, clear: Rect[], ps: Piece[], soft: Rect[] = []): boolean {
  return ps.every((p, i) => inside(p.rect, room) && !clear.some((c) => overlaps(p.rect, c)) && !soft.some((c) => overlaps(p.rect, c))
    && ps.every((q, j) => j <= i || !overlaps(p.rect, q.rect)));
}
/** Positions along a stretch for an item `w` long: its centre first, then either way in 0.1 m steps. */
function positions([a, b]: [number, number], w: number): number[] {
  const mid = (a + b) / 2; const room = (b - a - w) / 2;
  if (room < -EPS) return [];
  const out = [mid];
  for (let k = 1; k * 0.1 <= room + EPS; k++) out.push(mid - k * 0.1, mid + k * 0.1);
  return out;
}
const best = <T>(xs: T[], score: (x: T) => number): T | null => xs.reduce<T | null>((b, x) => (b === null || score(x) > score(b) ? x : b), null);

function living(room: Room, walls: Wall[], clear: Rect[], entrance: Side | null): Piece[] {
  const options: { ps: Piece[]; score: number }[] = [];
  for (const wall of walls) {
    const s = wall.side; const depth = depthFrom(room, s);
    if (depth < 3.2) continue;
    for (const stretch of solidStretches(room, wall).slice(0, 2)) {
      if (stretch[1] - stretch[0] < 1.6) continue;
      const tvW = Math.min(1.8, stretch[1] - stretch[0] - 0.1);
      for (const at of positions(stretch, tvW).slice(0, 7)) {
        // The sofa faces the focal wall from 2.2–3.2 m (to its front), its back free or against the far wall.
        const sofaW = sideLength(room, s) >= 3.4 ? 2.25 : 1.7; const sofaD = 0.9;
        const viewing = Math.min(3.2, Math.max(2.2, depth - sofaD - 0.15));
        const tv = against(room, s, at, tvW, 0.45);
        const sofa = against(room, s, at, sofaW, sofaD, 0.45 + viewing - 0.45);
        const sofaBackOff = depth - (0.45 + viewing - 0.45) - sofaD;
        const sofaPiece = piece('sofa', sofa, opposite[s]);
        const table = against(room, s, at, Math.min(1.2, sofaW - 0.5), 0.6, 0.45 + viewing - 0.45 - 0.45 - 0.6);
        const ps = [piece('tv-unit', tv, s), sofaPiece, piece('coffee-table', table, s)];
        if (!fits(room, clear, ps)) continue;
        // Close the group with two armchairs (or a second sofa in a big room) either side of the coffee table.
        const sideD = 0.85; const gap = 0.35;
        const sideKind: FurnishingKind = depthFrom(room, s) >= 4.6 && sideLength(room, s) >= 5 ? 'sofa' : 'armchair';
        const sideLen = sideKind === 'sofa' ? 1.7 : 0.85;
        const tableMid = { x: table.x + table.w / 2, y: table.y + table.d / 2 };
        const flank = (dir: -1 | 1): Piece => {
          const horiz = along(s) === 'x';
          const halfSpan = (horiz ? table.w : table.d) / 2 + gap + sideD / 2;
          const cx = horiz ? tableMid.x + dir * halfSpan : tableMid.x;
          const cy = horiz ? tableMid.y : tableMid.y + dir * halfSpan;
          const backSide: Side = horiz ? (dir < 0 ? 'w' : 'e') : (dir < 0 ? 'n' : 's');
          const w = horiz ? sideD : sideLen; const d = horiz ? sideLen : sideD;
          return piece(sideKind, { x: cx - w / 2, y: cy - d / 2, w, d }, backSide);
        };
        const flanks = [flank(-1), flank(1)].filter((f) => fits(room, clear, [...ps, f]));
        const all = [...ps, ...flanks];
        const glare = wall.windows.length ? 3 : 0;
        const score = 10 - glare - (entrance === s ? 6 : 0) + flanks.length * 2 - Math.abs(at - sideLength(room, s) / 2) * 0.4 + (sofaBackOff < 0.4 ? 1 : 0);
        options.push({ ps: all, score });
      }
    }
  }
  return best(options, (o) => o.score)?.ps ?? [];
}

function bedroom(room: Room, walls: Wall[], clear: Rect[], hasWalkIn: boolean): Piece[] {
  const minDim = Math.min(room.w, room.d); const area = room.w * room.d;
  const [bedW, bedD] = room.kind === 'master' && minDim >= 3.5 && area >= 13 ? [1.8, 2.0] : minDim >= 3.0 ? [1.5, 2.0] : minDim >= 2.7 ? [1.35, 1.9] : [0.9, 1.9];
  const sideGap = bedW >= 1.35 ? 0.55 : 0.4;
  const options: { ps: Piece[]; score: number }[] = [];
  for (const wall of walls) {
    const s = wall.side;
    if (depthFrom(room, s) < bedD + 0.7) continue; // room at the foot of the bed
    for (const stretch of [...solidStretches(room, wall, true), ...solidStretches(room, wall)].slice(0, 3)) {
      for (const at of positions(stretch, bedW + 2 * sideGap).slice(0, 9)) {
        const bed = piece('bed', against(room, s, at, bedW, bedD), s);
        if (!fits(room, clear, [bed])) continue;
        const tables = [-1, 1].map((k) => piece('side-table', against(room, s, at + k * (bedW / 2 + 0.25), 0.42, 0.4), s)).filter((t) => fits(room, clear, [bed, t]));
        // In line with a door: you would look straight at the bed from the landing.
        const facing = walls.find((x) => x.side === opposite[s])!.doors.some(([a, b]) => a < at + bedW / 2 && b > at - bedW / 2);
        const underWindow = wall.windows.some(([a, b]) => a < at + bedW / 2 && b > at - bedW / 2);
        const score = 10 + tables.length - (underWindow ? 3 : 0) - (facing ? 2 : 0) - Math.abs(at - sideLength(room, s) / 2) * 0.3;
        options.push({ ps: [bed, ...tables], score });
      }
    }
  }
  const chosen = best(options, (o) => o.score)?.ps ?? [];
  if (!chosen.length || hasWalkIn) return chosen;
  // A wardrobe on another solid wall, 0.6 m deep with 0.9 m clear in front of it.
  const wardrobes: { p: Piece; score: number }[] = [];
  for (const wall of walls) {
    if (wall.side === chosen[0]!.back) continue;
    for (const stretch of solidStretches(room, wall, true).slice(0, 2)) {
      // The longest that fits, from 2.4 m down to 1.2 m.
      for (let len = Math.min(2.4, stretch[1] - stretch[0] - 0.1); len >= 1.2 - EPS; len -= 0.3) {
        for (const at of positions(stretch, len).slice(0, 9)) {
          const p = piece('wardrobe', against(room, wall.side, at, len, 0.6), wall.side);
          const front = against(room, wall.side, at, len, 0.9, 0.65); // the space to open its doors and stand
          if (fits(room, clear, [...chosen, p]) && !chosen.some((c) => overlaps(c.rect, front)) && inside(front, room)) wardrobes.push({ p, score: len });
        }
      }
    }
  }
  const w = best(wardrobes, (x) => x.score);
  return w ? [...chosen, w.p] : chosen;
}

function dining(room: Room, clear: Rect[]): Piece[] {
  const long = Math.max(room.w, room.d); const short = Math.min(room.w, room.d);
  // The footprint includes the chairs: the table plus 0.45 m each side, and space round it to pull them out.
  const sizes: [number, number][] = [[2.2, 1.0], [1.8, 1.0], [1.4, 0.9], [1.0, 0.9]];
  for (const [tl, td] of sizes) {
    const L = tl + 0.2; const D = td + 0.9;
    // The footprint already holds the chairs; a little more each side lets people pass behind them.
    if (L + 0.8 > long + EPS || D + 0.4 > short + EPS) continue;
    const horiz = room.w >= room.d;
    const w = horiz ? L : D; const d = horiz ? D : L;
    const cx = room.x + room.w / 2; const cy = room.y + room.d / 2;
    for (let k = 0; k <= 20; k++) for (const dir of [1, -1]) {
      const shift = k * 0.1 * dir;
      const rect = { x: cx - w / 2 + (horiz ? shift : 0), y: cy - d / 2 + (horiz ? 0 : shift), w, d };
      const p = piece('dining-table', rect, horiz ? 'n' : 'w');
      if (fits(room, clear, [p])) return [p];
    }
  }
  return [];
}

function kitchen(room: Room, walls: Wall[], clear: Rect[]): Piece[] {
  const ps: Piece[] = [];
  const runs = walls.flatMap((wall) => solidStretches(room, wall).map((st) => ({ wall, st, len: st[1] - st[0] })))
    .filter((x) => x.len >= 1.2).sort((a, b) => b.len - a.len);
  const first = runs[0];
  if (!first) return ps;
  const len1 = Math.min(4.2, first.len - 0.05);
  const run1 = piece('counter', against(room, first.wall.side, (first.st[0] + first.st[1]) / 2, len1, 0.62, 0.02), first.wall.side);
  if (!fits(room, clear, [run1])) return ps;
  ps.push(run1);
  // A second run: the facing wall when it leaves 1.1 m between (a galley), else a return wall (an L).
  const facing = runs.find((x) => x.wall.side === opposite[first.wall.side] && depthFrom(room, first.wall.side) >= 0.62 * 2 + 1.1);
  const second = facing ?? runs.find((x) => x.wall.side !== first.wall.side && x.wall.side !== opposite[first.wall.side]);
  if (second) {
    const len2 = Math.min(3.0, second.len - 0.05);
    for (const at of positions(second.st, len2).slice(0, 9)) {
      const run2 = piece('counter', against(room, second.wall.side, at, len2, 0.62, 0.02), second.wall.side);
      if (fits(room, clear, [...ps, run2])) { ps.push(run2); break; }
    }
  }
  // The fridge at the end of the longest run.
  for (const end of [-1, 1]) {
    const at = (first.st[0] + first.st[1]) / 2 + end * (len1 / 2 + 0.4);
    const fridge = piece('fridge', against(room, first.wall.side, at, 0.72, 0.7, 0.02), first.wall.side);
    if (fits(room, clear, [...ps, fridge])) { ps.push(fridge); break; }
  }
  return ps;
}

function bathroom(room: Room, walls: Wall[], clear: Rect[]): Piece[] {
  const doorSide = walls.find((w) => w.doors.length)?.side ?? 'n';
  const ps: Piece[] = [];
  const tryPut = (kind: FurnishingKind, w: number, d: number, sides: Side[], far: boolean) => {
    for (const s of sides) {
      const wall = walls.find((x) => x.side === s)!;
      for (const stretch of solidStretches(room, wall)) {
        const cands = positions(stretch, w);
        // Far from the door: the end of the stretch away from it, else near it.
        const ordered = far ? [...cands].sort((a, b) => b - a) : cands;
        for (const at of ordered) {
          const p = piece(kind, against(room, s, at, w, d, 0.02), s);
          const front = against(room, s, at, w, 0.55, d);
          if (fits(room, clear, [...ps, p], kind === 'toilet' ? [front] : []) && !ps.some((q) => overlaps(q.rect, front))) { ps.push(p); return; }
        }
      }
    }
  };
  // The WC never faces the door: its back to a side wall first.
  const sides = (['n', 's', 'e', 'w'] as Side[]).filter((s) => s !== doorSide && s !== opposite[doorSide]);
  if (room.kind !== 'wc') tryPut('shower', 0.9, 0.9, [opposite[doorSide], ...sides], true);
  tryPut('toilet', 0.45, 0.7, [...sides, opposite[doorSide]], false);
  tryPut('basin', 0.55, 0.45, [...sides, opposite[doorSide], doorSide], false);
  return ps;
}

function study(room: Room, walls: Wall[], clear: Rect[], kind: FurnishingKind): Piece[] {
  // At the window for daylight across the desk, else on the longest solid wall.
  const ordered = [...walls].sort((a, b) => b.windows.length - a.windows.length);
  for (const wall of ordered) {
    for (const stretch of solidStretches(room, wall)) {
      for (const at of positions(stretch, 1.4).slice(0, 7)) {
        const p = piece(kind, against(room, wall.side, at, 1.4, 1.2), wall.side);
        if (fits(room, clear, [p])) return [p];
      }
    }
  }
  return [];
}

function gym(room: Room, clear: Rect[]): Piece[] {
  const horiz = room.w >= room.d;
  const w = horiz ? 1.55 : 0.7; const d = horiz ? 0.7 : 1.55;
  const p = piece('training-bench', { x: room.x + room.w / 2 - w / 2, y: room.y + room.d / 2 - d / 2, w, d }, horiz ? 'n' : 'w');
  return fits(room, clear, [p]) ? [p] : [];
}

const LIVING: ReadonlySet<RoomKind> = new Set(['living', 'lounge', 'living-kitchen']);
const BEDS: ReadonlySet<RoomKind> = new Set(['bedroom', 'master', 'guest-room']);
const WETS: ReadonlySet<RoomKind> = new Set(['bathroom', 'ensuite', 'wc']);

/** Suggests the fit-out for one floor of a concept. Items that cannot keep their clearances are left out. */
export function furnishFloor(design: Pick<Design, 'rooms' | 'openings'>, storey: number): Furnishing[] {
  const items: Furnishing[] = [];
  const rooms = design.rooms.filter((r) => r.storey === storey);
  for (const room of rooms) {
    const walls = wallsOf(room, design.openings);
    // A guest WC is too small for an inward swing: its door opens out, so only the doorway itself stays clear.
    const clear = keepClear(room, walls, !(room.kind === 'dining' || room.kind === 'kitchen' || WETS.has(room.kind)), room.kind === 'wc' ? 0.6 : 1.0);
    // The side the room is entered from: the focal wall is never there.
    const entrance = walls.find((w) => w.doors.length)?.side ?? null;
    const hasWalkIn = rooms.some((o) => o.kind === 'store' && /wardrobe/i.test(o.name)
      && Math.min(o.x + o.w, room.x + room.w) - Math.max(o.x, room.x) > -EPS && Math.min(o.y + o.d, room.y + room.d) - Math.max(o.y, room.y) > -EPS);
    let ps: Piece[] = [];
    if (LIVING.has(room.kind)) {
      ps = living(room, walls, clear, entrance);
      if (room.kind === 'living-kitchen') ps = [...ps, ...kitchen(room, walls, [...clear, ...ps.map((p) => p.rect)])];
    } else if (BEDS.has(room.kind)) ps = bedroom(room, walls, clear, hasWalkIn);
    else if (room.kind === 'dining') ps = dining(room, clear);
    else if (room.kind === 'kitchen') ps = kitchen(room, walls, clear);
    else if (WETS.has(room.kind)) ps = bathroom(room, walls, clear);
    else if (room.kind === 'study' || room.kind === 'office') ps = study(room, walls, clear, 'desk');
    else if (room.kind === 'gaming') ps = study(room, walls, clear, 'gaming-desk');
    else if (room.kind === 'gym') ps = gym(room, clear);
    ps.forEach((p, i) => items.push({ id: `${room.id}:${p.kind}:${i}`, roomId: room.id, kind: p.kind, ...p.rect, back: p.back, turn: p.back === 'e' || p.back === 'w' }));
  }
  return items;
}
