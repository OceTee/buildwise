import type { Design, Opening, Rect, RoomKind } from './design';

export type FurnishingKind = 'bed' | 'sofa' | 'dining-table' | 'counter' | 'toilet' | 'shower' | 'desk' | 'gaming-desk' | 'training-bench';

export interface Furnishing extends Rect {
  id: string;
  roomId: string;
  kind: FurnishingKind;
  /** True when the item's local frontage faces across the room rather than along the plan x axis. */
  turn: boolean;
}

type Item = [kind: FurnishingKind, width: number, depth: number];
const PROGRAMME: Partial<Record<RoomKind, Item[]>> = {
  master: [['bed', 1.8, 2]],
  bedroom: [['bed', 1.35, 1.9]],
  'guest-room': [['bed', 1.5, 2]],
  living: [['sofa', 2.25, 0.88]],
  lounge: [['sofa', 2.25, 0.88]],
  'living-kitchen': [['sofa', 2.25, 0.88], ['counter', 2.4, 0.62]],
  dining: [['dining-table', 2.2, 1.85]],
  kitchen: [['counter', 2.4, 0.62]],
  bathroom: [['toilet', 0.42, 0.72], ['shower', 0.9, 0.9]],
  ensuite: [['toilet', 0.42, 0.72], ['shower', 0.9, 0.9]],
  wc: [['toilet', 0.42, 0.72]],
  study: [['desk', 1.4, 1.2]],
  gaming: [['gaming-desk', 1.55, 1.25]],
  gym: [['training-bench', 1.55, 0.7]],
};

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.d && a.y + a.d > b.y;
}

/** A conservative reserved area on both sides of each doorway, measured from the same plan. */
function doorSpace(opening: Opening): Rect {
  const length = opening.to - opening.from;
  const along = opening.from - 0.1;
  const across = opening.at - Math.max(0.8, length);
  const depth = 2 * Math.max(0.8, length);
  return opening.dir === 'h'
    ? { x: along, y: across, w: length + 0.2, d: depth }
    : { x: across, y: along, w: depth, d: length + 0.2 };
}

/** Suggests fit-out for a concept. Items that cannot fit clear of doors and other items are omitted. */
export function furnishFloor(design: Pick<Design, 'rooms' | 'openings'>, storey: number): Furnishing[] {
  const reserved = design.openings.filter((o) => o.storey === storey && o.kind === 'door').map(doorSpace);
  const items: Furnishing[] = [];
  const margin = 0.18;

  for (const room of design.rooms) {
    if (room.storey !== storey) continue;
    const placed: Furnishing[] = [];
    for (const [kind, width, depth] of PROGRAMME[room.kind] ?? []) {
      for (const turn of [false, true]) {
        const w = turn ? depth : width;
        const d = turn ? width : depth;
        if (room.w < w + 2 * margin || room.d < d + 2 * margin) continue;
        const left = room.x + margin;
        const right = room.x + room.w - w - margin;
        const front = room.y + margin;
        const back = room.y + room.d - d - margin;
        const middle = { x: (left + right) / 2, y: (front + back) / 2 };
        const corners = [{ x: left, y: front }, { x: right, y: front }, { x: left, y: back }, { x: right, y: back }];
        const positions = kind === 'dining-table' ? [middle, ...corners] : [...corners, middle];
        const candidate = positions.map((p) => ({ ...p, id: `${room.id}:${kind}`, roomId: room.id, kind, w, d, turn }))
          .find((p) => !reserved.some((area) => overlaps(p, area)) && !placed.some((item) => overlaps(p, item)));
        if (candidate) {
          placed.push(candidate);
          break;
        }
      }
    }
    items.push(...placed);
  }
  return items;
}
