import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANDSCAPE, ROOF_OPTIONS, applyEdits, billOfMaterials, designKey, generateDesigns, isVerticalPlane, landscapeMaterials,
  planLandscape, planeArea, roofParts, solidsFor,
  type Design, type DesignEdit, type RoofKind,
} from '../src/index';

const plot = { widthM: 18.29, depthM: 36.58 };
const base = (brief = {}) => generateDesigns(plot, { bedrooms: 3, ...brief }).designs[0]!;
const overlap = (a: { x: number; y: number; w: number; d: number }, b: typeof a) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 && Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y) > 0.01;

/** The rooms still tile their blocks exactly after editing. */
function tiles(d: Design) {
  for (let s = 0; s < d.storeys; s++) {
    const rooms = d.rooms.filter((r) => r.storey === s);
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) expect(overlap(rooms[i]!, rooms[j]!), `${rooms[i]!.name} / ${rooms[j]!.name}`).toBe(false);
    const blocks = d.blocks.filter((b) => b.storeys > s);
    expect(rooms.reduce((sum, r) => sum + r.w * r.d, 0)).toBeCloseTo(blocks.reduce((sum, b) => sum + b.w * b.d, 0), 1);
    for (const r of rooms) {
      const b = blocks.find((k) => k.id === r.block)!;
      expect(r.x).toBeGreaterThanOrEqual(b.x - 0.01); expect(r.x + r.w).toBeLessThanOrEqual(b.x + b.w + 0.01);
      expect(r.y).toBeGreaterThanOrEqual(b.y - 0.01); expect(r.y + r.d).toBeLessThanOrEqual(b.y + b.d + 0.01);
    }
  }
}

describe('the design editor', () => {
  /** Two rooms on one floor sharing a whole wall: the side of `r` it is on, and how much room the neighbour has. */
  type R = Design['rooms'][number];
  const pairs = (d: Design) => d.rooms.flatMap((r) => d.rooms.filter((o) => o !== r && o.storey === r.storey && !['stair', 'corridor', 'lift'].includes(o.kind)).flatMap((o): { r: R; o: R; side: 'left' | 'right' | 'front' | 'rear'; room: number }[] => {
    const e = 1e-3;
    if (Math.abs(o.y - r.y) < e && Math.abs(o.d - r.d) < e && Math.abs(o.x + o.w - r.x) < e) return [{ r, o, side: 'left', room: o.w }];
    if (Math.abs(o.y - r.y) < e && Math.abs(o.d - r.d) < e && Math.abs(r.x + r.w - o.x) < e) return [{ r, o, side: 'right', room: o.w }];
    if (Math.abs(o.x - r.x) < e && Math.abs(o.w - r.w) < e && Math.abs(o.y + o.d - r.y) < e) return [{ r, o, side: 'front', room: o.d }];
    if (Math.abs(o.x - r.x) < e && Math.abs(o.w - r.w) < e && Math.abs(r.y + r.d - o.y) < e) return [{ r, o, side: 'rear', room: o.d }];
    return [];
  }));

  it('moves an inside wall: the room grows, its neighbours shrink, and everything is rebuilt', () => {
    const roomy = (o: Design['rooms'][number]) => ['bedroom', 'master', 'living', 'lounge', 'dining', 'kitchen'].includes(o.kind);
    const found = [3, 4, 5].flatMap((n) => generateDesigns(plot, { bedrooms: n }).designs)
      .flatMap((d) => pairs(d).filter((p) => !['stair', 'corridor', 'lift'].includes(p.r.kind) && roomy(p.o) && p.room >= 3.6).map((p) => ({ d, ...p })))[0]!;
    const { d, r: bed, side } = found;
    const { design, results } = applyEdits(d, [{ op: 'move', room: bed.id, side, by: 0.5 }]);
    expect(results).toEqual([null]);
    const after = design.rooms.find((x) => x.id === bed.id)!;
    const along = side === 'left' || side === 'right';
    expect(along ? after.w : after.d).toBeCloseTo((along ? bed.w : bed.d) + 0.5, 1);
    if (side === 'left') expect(after.x).toBeCloseTo(bed.x - 0.5, 1);
    if (side === 'front') expect(after.y).toBeCloseTo(bed.y - 0.5, 1);
    expect(design.edits).toBe(1);
    expect(design.summary).toMatch(/Adjusted by you \(1 change\)/);
    tiles(design);
    expect(design.openings.some((o) => o.roomId === bed.id && o.kind === 'door')).toBe(true);
  });

  it('refuses a move that would make a room too small, with the reason', () => {
    const d = base();
    // Pushing a wall into a small neighbour (a bathroom, WC or store) until it would be under its minimum.
    const p = pairs(d).find((x) => ['bathroom', 'wc', 'store', 'ensuite'].includes(x.o.kind) && x.room < 2.2 && !['corridor', 'stair'].includes(x.r.kind))!;
    const { design, results } = applyEdits(d, [{ op: 'move', room: p.r.id, side: p.side, by: p.room - 0.5 }]);
    expect(results[0]).toMatch(/narrower than|smaller than|too small/);
    expect(design).toBe(d);
  });

  it('extends the house by moving an outside wall, within the building line', () => {
    const d = base();
    const rearRoom = d.rooms.find((r) => r.storey === 0 && Math.abs(r.y + r.d - (d.blocks[0]!.y + d.blocks[0]!.d)) < 1e-6)!;
    const { design, results } = applyEdits(d, [{ op: 'move', room: rearRoom.id, side: 'rear', by: 1.5 }]);
    expect(results).toEqual([null]);
    expect(design.blocks[0]!.d).toBeCloseTo(d.blocks[0]!.d + 1.5, 2);
    expect(design.metrics.grossFloorM2).toBeGreaterThan(d.metrics.grossFloorM2);
    tiles(design);
    // Far past the setback is refused, with how far it can go.
    const far = applyEdits(d, [{ op: 'move', room: rearRoom.id, side: 'rear', by: 40 }]);
    expect(far.results[0]).toMatch(/building line.*at most [\d.]+ m/);
  });

  it('splits, merges, renames and changes the use of rooms, replaying in order', () => {
    const d = base();
    const living = d.rooms.find((r) => r.kind === 'living' || r.kind === 'living-kitchen')!;
    const edits: DesignEdit[] = [
      { op: 'split', room: living.id, dir: 'v', at: 0.6 },
      { op: 'rename', room: living.id, name: 'Sitting room' },
    ];
    const one = applyEdits(d, edits);
    expect(one.results).toEqual([null, null]);
    const newRoom = one.design.rooms.find((r) => !d.rooms.some((x) => x.id === r.id))!;
    expect(newRoom).toBeTruthy();
    expect(one.design.rooms.find((r) => r.id === living.id)!.name).toBe('Sitting room');
    tiles(one.design);
    const two = applyEdits(d, [...edits, { op: 'use', room: newRoom.id, kind: 'study' }, { op: 'merge', room: living.id, with: newRoom.id }]);
    expect(two.results).toEqual([null, null, null, null]);
    expect(two.design.rooms.find((r) => r.id === living.id)!.w).toBeCloseTo(living.w, 2);
    expect(two.design.rooms.some((r) => r.id === newRoom.id)).toBe(false);
    tiles(two.design);
  });

  it('keeps the stair fixed and edits for a room that no longer exists are refused', () => {
    const d = generateDesigns(plot, { bedrooms: 4, storeys: 2 }).designs[0]!;
    const stair = d.rooms.find((r) => r.kind === 'stair')!;
    const r = applyEdits(d, [{ op: 'move', room: stair.id, side: 'left', by: 0.3 }, { op: 'rename', room: 'r999', name: 'x' }]);
    expect(r.results[0]).toMatch(/stair/);
    expect(r.results[1]).toMatch(/not in this design/);
  });

  it('keys saved edits by plot, rooms and layout, not by roof or style', () => {
    const d = base();
    expect(designKey(plot, { ...d.brief, roof: 'gable', style: 'classic' }, d.id)).toBe(designKey(plot, d.brief, d.id));
    expect(designKey(plot, { ...d.brief, bedrooms: 4 }, d.id)).not.toBe(designKey(plot, d.brief, d.id));
  });
});

describe('roof forms', () => {
  const kinds = Object.keys(ROOF_OPTIONS) as RoofKind[];
  for (const kind of kinds) {
    it(`${kind}: builds closed, planar roof planes and prices the covering`, () => {
      for (const d of generateDesigns(plot, { bedrooms: 3, roof: kind }).designs) {
        const parts = roofParts(d);
        if (kind === 'flat') { expect(parts).toEqual([]); continue; }
        expect(parts.map((p) => p.blockId)).toEqual(d.blocks.map((b) => b.id));
        for (const p of parts.flatMap((x) => x.planes)) {
          expect(p.length).toBeGreaterThanOrEqual(3);
          expect(planeArea(p)).toBeGreaterThan(0.001);
          for (const pt of p) for (const v of pt) expect(Number.isFinite(v)).toBe(true);
        }
        const sloped = parts.flatMap((x) => x.planes).filter((p) => !isVerticalPlane(p));
        // The slopes cover at least the area of the buildings.
        expect(sloped.reduce((s, p) => s + planeArea(p), 0)).toBeGreaterThan(d.blocks.reduce((s, b) => s + b.w * b.d, 0) * 0.98);
        const bom = billOfMaterials(d);
        expect(bom.some((l) => l.section === 'roof' && l.key.startsWith('roofing'))).toBe(true);
      }
    });
  }

  it('a concealed roof stays under its parapets, which are taller than a flat roof\'s', () => {
    const d = generateDesigns(plot, { bedrooms: 3, roof: 'hidden', roofPitch: 30 }).designs[0]!;
    const top = Math.max(...roofParts(d).flatMap((p) => p.planes.flat().map((q) => q[2])));
    const parapets = solidsFor(d).filter((s) => s.kind === 'parapet');
    expect(parapets.length).toBeGreaterThan(0);
    expect(top).toBeLessThan(Math.max(...parapets.map((s) => s.cz + s.sz / 2)));
    expect(billOfMaterials(d).map((l) => l.key)).toContain('box-gutter');
  });

  it('tile finishes are counted in pieces with closer battens', () => {
    const d = generateDesigns(plot, { bedrooms: 3, roof: 'hip', roofFinish: 'stone-coated' }).designs[0]!;
    const by = Object.fromEntries(billOfMaterials(d).map((l) => [l.key, l]));
    expect(by['roofing-stone-coated']!.unit).toBe('piece');
    expect(by['timber-2x3']!.name).toMatch(/battens/i);
  });
});

describe('landscaping', () => {
  const d = base({ parking: 2 });

  it('lays out a fence with gates, a driveway to the parking, a walkway to the front door and trees clear of the house', () => {
    const l = planLandscape(d, DEFAULT_LANDSCAPE);
    const kinds = new Set(l.items.map((i) => i.kind));
    for (const k of ['lawn', 'fence', 'gate', 'paving', 'tree', 'light'] as const) expect(kinds.has(k), k).toBe(true);
    const drive = l.items.find((i) => i.use === 'driveway')!;
    for (const p of d.parking) expect(p.x >= drive.x - 0.01 && p.x + p.w <= drive.x + drive.w + 0.01).toBe(true);
    // A walkway to the front door, unless the door is right behind the driveway (which is then the path).
    const door = d.openings.find((o) => o.label === 'Front door')!;
    const doorX = (door.from + door.to) / 2;
    expect(l.items.some((i) => i.use === 'walkway') || (doorX > drive.x && doorX < drive.x + drive.w)).toBe(true);
    // Fence runs the whole boundary less the gate openings.
    const fence = l.items.filter((i) => i.kind === 'fence').reduce((s, f) => s + Math.max(f.w, f.d), 0);
    const gates = l.items.filter((i) => i.kind === 'gate').reduce((s, g) => s + g.w, 0);
    expect(fence + gates).toBeCloseTo(2 * (plot.widthM + plot.depthM) - 4 * 0.225, 0);
    for (const t of l.items.filter((i) => i.kind === 'tree' || i.kind === 'palm')) {
      for (const b of d.blocks) expect(overlap(t, b), t.id).toBe(false);
      expect(t.x).toBeGreaterThanOrEqual(0); expect(t.x + t.w).toBeLessThanOrEqual(plot.widthM);
    }
    const lines = landscapeMaterials(l, d);
    for (const k of ['fence-blocks', 'fence-cement', 'paving-interlock', 'lawn-grass', 'trees']) expect(lines.find((x) => x.key === k), k).toBeTruthy();
    expect(lines.every((x) => x.section === 'external' && x.quantity > 0)).toBe(true);
  });

  it('adds a pool and gazebo when they fit, and takes the person\'s own changes', () => {
    const l = planLandscape(d, { ...DEFAULT_LANDSCAPE, pool: true, gazebo: true, added: [{ kind: 'palm', x: 3, y: 30 }, { kind: 'tree', x: d.blocks[0]!.x + 1, y: d.blocks[0]!.y + 1 }], removed: ['tree-0'] });
    expect(l.items.find((i) => i.kind === 'pool')).toBeTruthy();
    expect(l.items.find((i) => i.kind === 'gazebo')).toBeTruthy();
    expect(l.items.some((i) => i.id === 'tree-0')).toBe(false);
    expect(l.items.filter((i) => i.placed)).toHaveLength(1); // the one on the house is left out
    expect(l.notes.join(' ')).toMatch(/left out/);
    expect(landscapeMaterials(l, d).map((x) => x.key)).toEqual(expect.arrayContaining(['pool', 'gazebo', 'palms']));
  });

  it('with nothing chosen, there is nothing to build', () => {
    const l = planLandscape(d, { fence: 'none', driveway: 'none', walkway: false, apron: false, lawn: false, trees: 'none', hedge: false, flowerBeds: false, pool: false, gazebo: false, lights: false });
    expect(l.items).toEqual([]);
    expect(landscapeMaterials(l, d)).toEqual([]);
  });
});
