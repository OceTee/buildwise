import { describe, expect, it } from 'vitest';
import { billOfMaterials, candidateDesigns, designFromLayout, generateDesigns, roofParts, type AiLayout } from '../src/index';

describe('architecture beyond the rooms', () => {
  it('every engine design gets an entrance, balconies, a garden-side room, materials and generous glazing', () => {
    for (const style of ['modern', 'tropical', 'classic'] as const) {
      const d = generateDesigns({ widthM: 18.29, depthM: 36.58 }, { type: 'duplex', storeys: 2, bedrooms: 4, style }).designs[0]!;
      const kinds = d.elements.map((e) => e.kind);
      expect(kinds.some((k) => k === 'porch' || k === 'canopy')).toBe(true);
      expect(kinds).toContain('balcony');
      expect(kinds.some((k) => k === 'veranda' || k === 'pergola')).toBe(true);
      expect(d.finishes.length).toBe(d.blocks.length);
      expect(d.openings.some((o) => o.kind === 'window' && o.sillM < 0.1 && o.headM >= 2.1)).toBe(true);
      for (const e of d.elements) {
        expect(e.x).toBeGreaterThanOrEqual(-0.01); expect(e.y).toBeGreaterThanOrEqual(-0.01);
        expect(e.x + e.w).toBeLessThanOrEqual(d.plot.widthM + 0.01); expect(e.y + e.d).toBeLessThanOrEqual(d.plot.depthM + 0.01);
      }
      expect(d.checks.filter((c) => c.status === 'fail')).toEqual([]);
      const bom = billOfMaterials(d).map((l) => l.key);
      expect(bom).toContain('balcony-slabs');
    }
  });

  it('a hotel gets balconies on its guest rooms and an entrance canopy', () => {
    const d = generateDesigns({ widthM: 30, depthM: 40 }, { type: 'hotel', storeys: 4, units: 10 }).designs[0]!;
    expect(d.elements.filter((e) => e.kind === 'balcony').length).toBeGreaterThan(5);
    expect(d.elements.some((e) => e.kind === 'canopy')).toBe(true);
  });

  it('an AI layout keeps its own elements, glazing and finishes (and drops unknown ones)', () => {
    const L = {
      name: 'Pavilion', idea: 'One wing.', roof: 'flat',
      blocks: [{ id: 'A', name: 'House', x: 1.5, y: 6, w: 12, d: 8, storeys: 1 }],
      rooms: [
        { block: 'A', storey: 0, kind: 'living-kitchen', name: 'Living', x: 1.5, y: 6, w: 6, d: 8, glazing: 'full-height' },
        { block: 'A', storey: 0, kind: 'master', name: 'Master', x: 7.5, y: 6, w: 4, d: 4 },
        { block: 'A', storey: 0, kind: 'ensuite', name: 'Ensuite', x: 11.5, y: 6, w: 2, d: 4 },
        { block: 'A', storey: 0, kind: 'corridor', name: 'Hall', x: 7.5, y: 10, w: 6, d: 1.2 },
        { block: 'A', storey: 0, kind: 'bedroom', name: 'Bedroom 2', x: 7.5, y: 11.2, w: 3.3, d: 2.8 },
        { block: 'A', storey: 0, kind: 'bathroom', name: 'Bathroom', x: 10.8, y: 11.2, w: 2.7, d: 2.8 },
      ],
      elements: [{ kind: 'veranda', storey: 0, x: 1.5, y: 14, w: 6, d: 3, material: 'timber' }, { kind: 'spaceship', storey: 0, x: 0, y: 0, w: 1, d: 1 }],
      finishes: [{ block: 'A', walls: 'render-sand', base: 'stone', accent: 'timber' }],
    } as unknown as AiLayout;
    const r = designFromLayout({ widthM: 18.29, depthM: 36.58 }, { type: 'bungalow', bedrooms: 2, ensuite: true }, L, 'ai-x');
    expect(r.design!.elements.map((e) => e.kind)).toEqual(['veranda']);
    expect(r.design!.finishes).toEqual([{ block: 'A', walls: 'render-sand', base: 'stone', accent: 'timber' }]);
    expect(r.design!.openings.some((o) => o.label === 'Living glazed wall')).toBe(true);
  });

  it('a duplex is planned like a home: entrance hall with the stair, family lounge and master suite upstairs', () => {
    const r = generateDesigns({ widthM: 18.29, depthM: 36.58 }, { type: 'duplex', storeys: 2, bedrooms: 4 });
    const d = r.designs[0]!;
    expect(d.typology).toBe('hub');
    const room = (s: number, name: RegExp) => d.rooms.find((x) => x.storey === s && name.test(x.name));
    const front = d.openings.find((o) => o.label === 'Front door')!;
    expect(d.rooms.find((x) => x.id === front.roomId)!.name).toBe('Entrance hall');
    expect(room(0, /^Stair$/)).toBeTruthy();
    expect(room(1, /^Family lounge$/)).toBeTruthy();
    // The master suite is upstairs on the quiet side, and every upstairs bedroom has its own ensuite.
    const master = d.rooms.find((x) => x.kind === 'master')!;
    expect(master.storey).toBe(1);
    expect(master.y).toBeGreaterThan(d.footprint.y + 2);
    const upBeds = d.rooms.filter((x) => x.storey === 1 && (x.kind === 'bedroom' || x.kind === 'master'));
    for (const bed of upBeds) expect(d.rooms.some((x) => x.kind === 'ensuite' && x.storey === 1 && d.openings.some((o) => o.roomId === x.id && o.kind === 'door')), bed.name).toBe(true);
    expect(d.rooms.filter((x) => x.kind === 'ensuite' && x.storey === 1).length).toBeGreaterThanOrEqual(upBeds.length);
    const door = (label: RegExp) => d.openings.some((o) => o.kind === 'door' && label.test(o.label));
    expect(door(/^Kitchen to dining door$/)).toBe(true);
    expect(d.checks.filter((c) => c.status !== 'pass')).toEqual([]);
    // A working kitchen and a proper guest WC off the entrance hall, with a window.
    const kitchen = d.rooms.find((x) => x.kind === 'kitchen')!;
    expect(kitchen.w * kitchen.d).toBeLessThanOrEqual(14.5);
    const wc = d.rooms.find((x) => x.kind === 'wc')!;
    expect(Math.max(wc.w, wc.d)).toBeLessThanOrEqual(2);
    expect(d.openings.some((o) => o.roomId === wc.id && o.kind === 'window')).toBe(true);
  });


  it('a guest WC keeps its window and is reached through a short lobby, never a 1 x 4 m strip', () => {
    for (const brief of [{ bedrooms: 3 }, { bedrooms: 3, kitchen: 'open' as const }, { type: 'duplex' as const, storeys: 2, bedrooms: 4 }]) {
      for (const d of candidateDesigns({ widthM: 18.29, depthM: 36.58 }, brief)) {
        const wc = d.rooms.find((r) => r.kind === 'wc' && r.storey === 0)!;
        expect(Math.max(wc.w, wc.d), d.name).toBeLessThanOrEqual(2);
        expect(d.openings.some((o) => o.roomId === wc.id && o.kind === 'window'), d.name).toBe(true);
        expect(d.checks.filter((c) => c.status !== 'pass').map((c) => c.code), d.name).toEqual([]);
      }
    }
  });

  it('halls that meet stay open to each other (no wall between a lobby and the hallway)', () => {
    const d = generateDesigns({ widthM: 18.29, depthM: 36.58 }, { bedrooms: 3 }).designs.find((x) => x.rooms.filter((r) => r.kind === 'corridor' && r.storey === 0).length >= 2)!;
    const halls = d.rooms.filter((r) => r.kind === 'corridor' && r.storey === 0);
    const touching = (p: typeof halls[number], q: typeof halls[number]) => Math.abs(q.x - (p.x + p.w)) < 1e-3 || Math.abs(p.x - (q.x + q.w)) < 1e-3 || Math.abs(q.y - (p.y + p.d)) < 1e-3 || Math.abs(p.y - (q.y + q.d)) < 1e-3;
    const lobby = halls.find((p) => halls.some((q) => q !== p && touching(p, q)))!;
    const hall = halls.find((q) => q !== lobby && touching(lobby, q))!;
    expect(hall).toBeTruthy();
    const vertical = Math.abs(hall.x - (lobby.x + lobby.w)) < 1e-3 || Math.abs(lobby.x - (hall.x + hall.w)) < 1e-3;
    const at = vertical ? (Math.abs(hall.x - (lobby.x + lobby.w)) < 1e-3 ? hall.x : lobby.x) : (Math.abs(hall.y - (lobby.y + lobby.d)) < 1e-3 ? hall.y : lobby.y);
    const [lo, hi] = vertical ? [Math.max(lobby.y, hall.y), Math.min(lobby.y + lobby.d, hall.y + hall.d)] : [Math.max(lobby.x, hall.x), Math.min(lobby.x + lobby.w, hall.x + hall.w)];
    const walls = d.walls.filter((w) => w.storey === 0 && w.dir === (vertical ? 'v' : 'h') && Math.abs(w.at - at) < 1e-3 && Math.min(w.to, hi) - Math.max(w.from, lo) > 0.1);
    expect(walls).toEqual([]);
  });


  it('bathrooms, stores and ensuites are proper rooms, not strips: lobbies, pantries and wardrobes take the rest', () => {
    for (const [brief, plot] of [[{ bedrooms: 3 }, { widthM: 15.24, depthM: 30.48 }], [{ type: 'duplex' as const, storeys: 2, bedrooms: 4 }, { widthM: 18.29, depthM: 36.58 }]] as const) {
      for (const d of candidateDesigns(plot, brief)) {
        const wet = d.rooms.filter((r) => r.kind === 'bathroom' || r.kind === 'ensuite' || r.kind === 'wc');
        for (const r of wet) expect(Math.max(r.w, r.d) / Math.min(r.w, r.d), `${d.name} ${r.name}`).toBeLessThanOrEqual(2.5); // 1.5 x 3.6 m at most
        // Every room has a door; pantries and wardrobes open from the room they serve.
        const rooms = d.rooms.filter((r) => !['corridor', 'stair', 'lift'].includes(r.kind));
        for (const r of rooms) expect(d.openings.some((o) => o.roomId === r.id && o.kind === 'door'), `${d.name} ${r.name}`).toBe(true);
        expect(d.checks.filter((c) => c.status !== 'pass').map((c) => c.code), d.name).toEqual([]);
      }
    }
  });

  it('houses have form: a living wing stepping forward, a recessed entrance, a bedroom wing behind, a compact option too', () => {
    const r = generateDesigns({ widthM: 18.29, depthM: 36.58 }, { bedrooms: 3 });
    const formed = r.designs.find((d) => d.blocks.some((b) => b.name === 'Living wing'))!;
    expect(formed).toBeTruthy();
    expect(r.designs.some((d) => d.blocks.length === 1)).toBe(true);
    const wing = formed.blocks.find((b) => b.name === 'Living wing')!;
    const rest = formed.blocks.find((b) => b.name === 'House')!;
    // The living wing steps forward of the entrance by at least the 0.6 m a facade needs to read as two planes.
    expect(rest.y - wing.y).toBeGreaterThanOrEqual(0.6);
    const front = formed.openings.find((o) => o.label === 'Front door')!;
    expect(front.at).toBeCloseTo(rest.y, 1);
    expect(formed.blocks.some((b) => b.name === 'Bedroom wing')).toBe(true);
    // Every volume has its own roof and every room sits in one of them.
    expect(roofParts(formed).map((p) => p.blockId).sort()).toEqual(formed.blocks.filter((b) => b.kind === 'house').map((b) => b.id).sort());
    expect(formed.checks.filter((c) => c.status !== 'pass')).toEqual([]);
  });
});
