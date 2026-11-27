import { describe, expect, it } from 'vitest';
import { freeDesigns, furnishFloor, generateDesigns, type Furnishing, type Opening, type Rect, type Room } from '../src/index';

const room: Room = { id: 'bedroom', kind: 'master', name: 'Master bedroom', storey: 0, block: 'house', x: 1, y: 1, w: 4, d: 4 };
// A door in the bedroom's north wall, at its west end.
const door: Opening = { id: 'door', kind: 'door', storey: 0, roomId: 'hall', dir: 'h', at: 1, from: 1.2, to: 2.1, sillM: 0, headM: 2, external: false, label: 'Door' };
const overlap = (a: Rect, b: Rect) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 && Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y) > 0.01;
const within = (a: Rect, r: Rect) => a.x >= r.x - 0.01 && a.y >= r.y - 0.01 && a.x + a.w <= r.x + r.w + 0.01 && a.y + a.d <= r.y + r.d + 0.01;

describe('furniture laid out by the rules', () => {
  it('puts the bed on a solid wall, clear of the door, with bedside tables and a wardrobe', () => {
    const design = { rooms: [room, { ...room, id: 'upstairs', storey: 1 }], openings: [door] };
    const items = furnishFloor(design, 0);
    const bed = items.find((i) => i.kind === 'bed')!;
    expect(bed.back).not.toBe('n'); // not against the door's wall
    expect(items.filter((i) => i.kind === 'side-table')).toHaveLength(2);
    expect(items.some((i) => i.kind === 'wardrobe')).toBe(true);
    // Nothing in the door's swing.
    const swing = { x: 1.1, y: 1, w: 1.1, d: 0.9 };
    expect(items.every((i) => !overlap(i, swing))).toBe(true);
    expect(furnishFloor(design, 1).every((i) => i.roomId === 'upstairs')).toBe(true);
  });

  it('gathers a living room round a focal wall: the sofa faces the TV across a coffee table', () => {
    const lounge: Room = { ...room, id: 'lounge', kind: 'living', name: 'Living room', w: 5.4, d: 4.8 };
    const items = furnishFloor({ rooms: [lounge], openings: [door] }, 0);
    const tv = items.find((i) => i.kind === 'tv-unit')!; const sofa = items.find((i) => i.kind === 'sofa')!;
    expect(tv && sofa && items.some((i) => i.kind === 'coffee-table')).toBeTruthy();
    expect(sofa.back).not.toBe(tv.back); // facing it
    const gap = tv.turn ? Math.abs((sofa.x + sofa.w / 2) - (tv.x + tv.w / 2)) : Math.abs((sofa.y + sofa.d / 2) - (tv.y + tv.d / 2));
    expect(gap).toBeGreaterThan(2);
  });

  it('gives a bedroom a bed even when a door sits close to the corner the bed needs', () => {
    // 3.0 × 4.17 m with one door near the middle of a long wall: the bed shifts along the wall rather than vanish.
    const small: Room = { id: 'b2', kind: 'bedroom', name: 'Bedroom 2', storey: 0, block: 'house', x: 1.5, y: 10.5, w: 3, d: 4.17 };
    const side: Opening = { id: 'd2', kind: 'door', storey: 0, roomId: 'b2', dir: 'v', at: 4.5, from: 12.13, to: 13.04, sillM: 0, headM: 2.1, external: false, label: 'Door' };
    const bed = furnishFloor({ rooms: [small], openings: [side] }, 0).find((i) => i.kind === 'bed');
    expect(bed && Math.min(bed.w, bed.d)).toBeGreaterThanOrEqual(1.35);
  });

  it('leaves furniture out rather than squeezing it in', () => {
    expect(furnishFloor({ rooms: [{ ...room, w: 1.7, d: 2.2 }], openings: [] }, 0)).toEqual([]);
  });

  it('across real designs: every item inside its room, none overlapping, none in a doorway', () => {
    const plot = { widthM: 18.29, depthM: 36.58 };
    const designs = [...generateDesigns(plot, { type: 'bungalow', bedrooms: 3 }).designs, ...freeDesigns(plot, { type: 'duplex', bedrooms: 4 }, { seed: 3, count: 3 })];
    let bedrooms = 0; let beds = 0;
    for (const d of designs) for (let s = 0; s < d.storeys; s++) {
      const items: Furnishing[] = furnishFloor(d, s);
      const doors = d.openings.filter((o) => o.storey === s && o.kind === 'door');
      for (const [i, it] of items.entries()) {
        const r = d.rooms.find((x) => x.id === it.roomId)!;
        expect(within(it, r), `${d.id} ${r.name} ${it.kind}`).toBe(true);
        for (const other of items.slice(i + 1)) expect(overlap(it, other), `${d.id} ${it.id} ${other.id}`).toBe(false);
        // The doorway itself (the opening plus 0.6 m into the room either side) stays free.
        for (const o of doors) {
          const zone = o.dir === 'h' ? { x: o.from, y: o.at - 0.6, w: o.to - o.from, d: 1.2 } : { x: o.at - 0.6, y: o.from, w: 1.2, d: o.to - o.from };
          expect(overlap(it, zone), `${d.id} ${r.name} ${it.kind} in ${o.label}`).toBe(false);
        }
      }
      for (const r of d.rooms.filter((x) => x.storey === s && (x.kind === 'bedroom' || x.kind === 'master'))) { bedrooms++; if (items.some((i) => i.roomId === r.id && i.kind === 'bed')) beds++; }
    }
    // Every bedroom gets its bed.
    expect(beds).toBe(bedrooms);
  });
});
