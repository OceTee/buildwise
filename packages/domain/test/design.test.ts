import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESIGN_CONFIG, MAX_DESIGNS, applyAiReview, billOfMaterials, designDigest, generateDesigns, parsePlotSize, readBriefText, roofPlanes, solidsFor,
  type Design, type DesignBrief, type Plot,
} from '../src/index';

const CASES: [string, Plot, Partial<DesignBrief>][] = [
  ['50×100 ft, 3-bed bungalow', { widthM: 15.24, depthM: 30.48 }, { bedrooms: 3 }],
  ['50×100 ft, 5-bed duplex', { widthM: 15.24, depthM: 30.48 }, { bedrooms: 5, storeys: 2, bathrooms: 2 }],
  // The brief the end-to-end build test uses: a bungalow's lobby would run past its limit at the rooms' target sizes.
  ['50×100 ft, 4-bed bungalow with a gym', { widthM: 15.24, depthM: 30.48 }, { bedrooms: 4, features: ['gym'] }],
  ['15×18 m, 4-bed', { widthM: 15, depthM: 18 }, { bedrooms: 4 }],
  ['60×120 ft, open plan, flat roof', { widthM: 18.29, depthM: 36.58 }, { bedrooms: 4, kitchen: 'open', study: true, roof: 'flat' }],
  ['30×60 ft, narrow 2-bed', { widthM: 9.14, depthM: 18.29 }, { bedrooms: 2, parking: 0 }],
  ['40×100 ft, 3-bed with parking', { widthM: 12.19, depthM: 30.48 }, { bedrooms: 3, parking: 1, roof: 'gable' }],
  ['big plot, 1-bed', { widthM: 30, depthM: 40 }, { bedrooms: 1, bathrooms: 0, ensuite: true, guestWc: false, store: false }],
];

const overlap = (a: { x: number; y: number; w: number; d: number }, b: typeof a) =>
  Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.01 && Math.min(a.y + a.d, b.y + b.d) - Math.max(a.y, b.y) > 0.01;

function invariants(d: Design) {
  // Every block (house wings and outbuildings) is inside the buildable envelope.
  for (const b of d.blocks) {
    expect(b.x).toBeGreaterThanOrEqual(d.envelope.x - 1e-6);
    expect(b.y).toBeGreaterThanOrEqual(d.envelope.y - 1e-6);
    expect(b.x + b.w).toBeLessThanOrEqual(d.envelope.x + d.envelope.w + 1e-6);
    expect(b.y + b.d).toBeLessThanOrEqual(d.envelope.y + d.envelope.d + 1e-6);
  }
  expect(d.blocks.filter((b) => b.kind === 'house').length).toBeGreaterThanOrEqual(1);
  expect(d.checks.filter((c) => c.status === 'fail')).toEqual([]);
  for (let s = 0; s < d.storeys; s++) {
    const rooms = d.rooms.filter((r) => r.storey === s);
    const blocks = d.blocks.filter((b) => b.storeys > s);
    // Rooms tile their blocks exactly: inside one, never overlapping, adding up to the blocks' area.
    for (const r of rooms) {
      expect(r.w).toBeGreaterThan(0.5);
      expect(r.d).toBeGreaterThan(0.5);
      const b = blocks.find((k) => k.id === r.block)!;
      expect(b, `${r.name} is in a block`).toBeTruthy();
      expect(r.x).toBeGreaterThanOrEqual(b.x - 0.01);
      expect(r.y).toBeGreaterThanOrEqual(b.y - 0.01);
      expect(r.x + r.w).toBeLessThanOrEqual(b.x + b.w + 0.01);
      expect(r.y + r.d).toBeLessThanOrEqual(b.y + b.d + 0.01);
    }
    for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) expect(overlap(rooms[i]!, rooms[j]!), `${rooms[i]!.name} / ${rooms[j]!.name}`).toBe(false);
    // An upper floor may leave a loggia open (railed, inside its block, under the block's roof).
    const loggia = d.elements.filter((e) => e.label === 'Loggia' && e.storey === s);
    for (const l of loggia) for (const r of rooms) expect(overlap(l, r), `Loggia / ${r.name}`).toBe(false);
    expect(rooms.reduce((sum, r) => sum + r.w * r.d, 0) + loggia.reduce((sum, l) => sum + l.w * l.d, 0)).toBeCloseTo(blocks.reduce((sum, b) => sum + b.w * b.d, 0), 0);
  }
  // The architect's review is always there, from the engine by default.
  expect(d.review.source).toBe('engine');
  expect(d.review.highlights.length).toBeGreaterThan(0);
  // Every room you can enter has a door; every opening sits on a wall that exists.
  for (const r of d.rooms.filter((x) => x.kind !== 'corridor' && x.kind !== 'stair')) {
    expect(d.openings.some((o) => o.roomId === r.id && o.kind === 'door'), `${r.name} has a door`).toBe(true);
  }
  for (const o of d.openings) {
    const wall = d.walls.find((w) => w.storey === o.storey && w.dir === o.dir && Math.abs(w.at - o.at) < 1e-3 && w.from <= o.from + 1e-3 && w.to >= o.to - 1e-3);
    expect(wall, `${o.label} sits on a wall`).toBeTruthy();
    expect(o.to - o.from).toBeGreaterThan(0.29);
  }
  expect(d.openings.filter((o) => o.kind === 'door' && o.external).length).toBeGreaterThanOrEqual(1);
  // The stair is in the same place on every floor.
  if (d.storeys > 1) {
    const stairs = d.rooms.filter((r) => r.kind === 'stair');
    expect(stairs).toHaveLength(d.storeys);
    expect(new Set(stairs.map((s) => `${s.x},${s.y},${s.w},${s.d}`)).size).toBe(1);
  }
}

describe('design generator', () => {
  for (const [name, plot, brief] of CASES) {
    it(`${name}: produces valid designs that pass the checklist`, () => {
      const r = generateDesigns(plot, brief);
      expect(r.designs.length, r.notes.join(' ')).toBeGreaterThan(0);
      expect(r.designs.length).toBeLessThanOrEqual(MAX_DESIGNS);
      // Ranked best first.
      expect(r.designs.map((d) => d.review.score)).toEqual([...r.designs.map((d) => d.review.score)].sort((a, b) => b - a));
      for (const d of r.designs) invariants(d);
      expect(new Set(r.designs.map((d) => d.id)).size).toBe(r.designs.length);
    });
  }

  it('is deterministic', () => {
    const a = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { bedrooms: 3 });
    const b = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { bedrooms: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('goes up a storey, with a note, when a bungalow does not fit', () => {
    const r = generateDesigns({ widthM: 12.19, depthM: 30.48 }, { bedrooms: 3, parking: 1 });
    expect(r.designs[0]!.storeys).toBe(2);
    expect(r.notes.join(' ')).toMatch(/two storeys/);
  });

  it('says so when nothing fits', () => {
    const r = generateDesigns({ widthM: 7, depthM: 9 }, { bedrooms: 6, bathrooms: 4 });
    expect(r.designs).toEqual([]);
    expect(r.notes[0]).toMatch(/does not fit/);
  });

  it('every habitable room meets the daylight rule and minimum sizes', () => {
    for (const d of generateDesigns({ widthM: 18.29, depthM: 36.58 }, { bedrooms: 4 }).designs) {
      for (const r of d.rooms.filter((x) => ['living', 'bedroom', 'master', 'kitchen', 'dining', 'study'].includes(x.kind))) {
        const glass = d.openings.filter((o) => o.roomId === r.id && o.kind === 'window').reduce((s, o) => s + (o.to - o.from) * (o.headM - o.sillM), 0);
        expect(glass, r.name).toBeGreaterThanOrEqual(r.w * r.d * DEFAULT_DESIGN_CONFIG.minWindowPctOfFloor / 100 - 0.05);
      }
    }
  });
});

describe('more layouts', () => {
  const wide: Plot = { widthM: 18.29, depthM: 36.58 };

  it('plans every home round halls, lobbies and living spaces: never a hallway strip', () => {
    for (const [plot, brief] of [[wide, { bedrooms: 3 }], [wide, { bedrooms: 4 }], [wide, { type: 'duplex' as const, storeys: 2, bedrooms: 4 }], [{ widthM: 12.19, depthM: 30.48 }, { type: 'duplex' as const, storeys: 2, bedrooms: 3 }]] as const) {
      const r = generateDesigns(plot, brief);
      expect(r.designs.length, JSON.stringify(brief)).toBeGreaterThan(0);
      for (const d of r.designs) {
        expect(d.typology, d.name).toBe('hub');
        for (const c of d.rooms.filter((x) => x.kind === 'corridor')) {
          const narrow = Math.min(c.w, c.d) < 1.6;
          expect(Math.max(c.w, c.d), `${d.name} ${c.name}`).toBeLessThanOrEqual(narrow ? 4.5 : 7);
        }
        // The visitor arrives in a hall or the living room; every bedroom has its own door.
        const front = d.openings.find((o) => o.label === 'Front door')!;
        expect(['corridor', 'living', 'living-kitchen']).toContain(d.rooms.find((x) => x.id === front.roomId)!.kind);
        for (const b of d.rooms.filter((x) => x.kind === 'bedroom' || x.kind === 'master')) expect(d.openings.some((o) => o.roomId === b.id && o.kind === 'door'), `${d.name} ${b.name}`).toBe(true);
        expect(d.checks.filter((c) => c.status === 'fail'), d.name).toEqual([]);
      }
    }
  });


  it('adds a detached boys\' quarters at the back when asked', () => {
    const r = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { bedrooms: 3, bq: true });
    const withBq = r.designs.filter((d) => d.blocks.some((b) => b.kind === 'outbuilding'));
    expect(withBq.length).toBeGreaterThan(0);
    for (const d of withBq) {
      invariants(d);
      const bq = d.blocks.find((b) => b.kind === 'outbuilding')!;
      const rooms = d.rooms.filter((x) => x.block === bq.id);
      expect(rooms.map((x) => x.kind).sort()).toEqual(['bathroom', 'bedroom']);
      // Its own front door, and the shower opens off its room.
      expect(d.openings.some((o) => o.external && o.kind === 'door' && rooms.some((x) => x.id === o.roomId))).toBe(true);
      expect(d.checks.find((c) => c.code === 'outbuilding')!.status).toBe('pass');
      expect(d.id).toMatch(/-bq$/);
    }
  });

  it('leaves the boys\' quarters out, with a note, when it cannot fit', () => {
    const r = generateDesigns({ widthM: 9.14, depthM: 18.29 }, { bedrooms: 2, parking: 0, bq: true });
    expect(r.designs.length).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(/boys' quarters/);
  });
});

describe('plot sizes', () => {
  it('reads feet and metres', () => {
    expect(parsePlotSize('50x100 ft')).toEqual({ widthM: 15.24, depthM: 30.48 });
    expect(parsePlotSize('a 60 by 120 plot')).toEqual({ widthM: 18.29, depthM: 36.58 });
    expect(parsePlotSize('15 x 30 m')).toEqual({ widthM: 15, depthM: 30 });
    expect(parsePlotSize('30m × 15m')).toEqual({ widthM: 15, depthM: 30 });
    expect(parsePlotSize('no numbers here')).toBeNull();
    expect(parsePlotSize('2 x 3 m')).toBeNull();
  });
});

describe('3D geometry and bill of materials', () => {
  // One compact block keeps the geometry sums simple (the other forms are several volumes, tested elsewhere).
  const d = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { bedrooms: 3, roof: 'hip' }).designs.find((x) => x.blocks.length === 1)!;

  it('cuts walls around openings and adds slabs and a roof', () => {
    const solids = solidsFor(d);
    expect(solids.filter((s) => s.kind === 'slab')).toHaveLength(d.storeys);
    expect(solids.filter((s) => s.kind === 'lintel').length).toBe(d.openings.length);
    for (const s of solids) for (const v of [s.sx, s.sy, s.sz]) expect(v).toBeGreaterThan(0);
    // Solid wall area + opening area = gross wall area.
    const wallFace = solids.filter((s) => s.kind !== 'slab' && s.kind !== 'parapet').reduce((sum, s) => sum + Math.max(s.sx, s.sy) * s.sz, 0);
    const openings = d.openings.reduce((sum, o) => sum + (o.to - o.from) * (o.headM - o.sillM), 0);
    const gross = d.walls.reduce((sum, w) => sum + (w.to - w.from) * d.storeyHeightM, 0);
    expect(Math.abs(wallFace + openings - gross)).toBeLessThan(0.5); // tiny pieces shorter than the wall is thick are measured by thickness
    expect(roofPlanes(d)).toHaveLength(4);
  });

  it('itemises materials with their basis and a way to buy them', () => {
    const bom = billOfMaterials(d);
    const by = Object.fromEntries(bom.map((l) => [l.key, l]));
    for (const k of ['cement', 'blocks-9in', 'blocks-6in', 'sharp-sand', 'granite', 'rebar-y12', 'roofing-sheets', 'door-flush', 'windows', 'floor-tiles']) {
      expect(by[k], k).toBeTruthy();
      expect(by[k]!.quantity).toBeGreaterThan(0);
      expect(by[k]!.basis.length).toBeGreaterThan(5);
      expect(by[k]!.shop.q.length).toBeGreaterThan(1);
    }
    // Sanity ranges for a ~120 m² bungalow: about 10 blocks per m² of wall, a few hundred bags of cement.
    expect(by.cement!.quantity).toBeGreaterThan(150);
    expect(by.cement!.quantity).toBeLessThan(800);
    expect(by['blocks-9in']!.quantity + by['blocks-6in']!.quantity).toBeGreaterThan(2000);
    expect(by['door-flush']!.quantity).toBe(d.openings.filter((o) => o.kind === 'door' && !o.external).length);
    // A two-storey house needs more cement and steel than its bungalow equivalent.
    const two = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { bedrooms: 3, storeys: 2 }).designs[0]!;
    const b2 = Object.fromEntries(billOfMaterials(two).map((l) => [l.key, l]));
    expect(b2['rebar-y12']!.quantity).toBeGreaterThan(by['rebar-y12']!.quantity);
  });

  it('a flat roof swaps sheets and timber for waterproofing and parapets', () => {
    const flat = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { bedrooms: 3, roof: 'flat' }).designs.find((x) => x.blocks.length === 1)!;
    const keys = billOfMaterials(flat).map((l) => l.key);
    expect(keys).toContain('waterproofing');
    expect(keys).not.toContain('roofing-sheets');
    expect(solidsFor(flat).filter((s) => s.kind === 'parapet')).toHaveLength(4);
    expect(roofPlanes(flat)).toEqual([]);
  });
});

describe('reading a brief without AI', () => {
  it('picks out rooms, storeys, plot and roof', () => {
    const r = readBriefText('I want to build a 4 bedroom duplex with a home office and open plan kitchen on a 50x100 ft plot, flat roof, 2 cars');
    expect(r.intent).toBe('build_home');
    expect(r.plot).toEqual({ widthM: 15.24, depthM: 30.48 });
    expect(r.brief).toMatchObject({ bedrooms: 4, storeys: 2, study: true, kitchen: 'open', roof: 'flat', parking: 2 });
  });
  it('tells shopping and other projects apart', () => {
    expect(readBriefText('where can I buy cement and blocks').intent).toBe('shopping');
    expect(readBriefText('I need a fence around my land').intent).toBe('other_project');
    expect(readBriefText('three bedroom bungalow').brief).toMatchObject({ bedrooms: 3, storeys: 1 });
    expect(readBriefText('a duplex with a BQ').brief).toMatchObject({ storeys: 2, bq: true });
    expect(readBriefText("4 bed bungalow with boys quarters").brief).toMatchObject({ bq: true });
  });
});

describe('the AI architect review', () => {
  const { designs } = generateDesigns({ widthM: 18.29, depthM: 36.58 }, { bedrooms: 3 });

  it('describes each design in numbers only', () => {
    const g = designDigest(designs[0]!);
    expect(g.id).toBe(designs[0]!.id);
    expect(g.rooms.some((r) => r.name === 'Master bedroom')).toBe(true);
    expect(JSON.stringify(g)).not.toMatch(/undefined/);
  });

  it('applies its order and notes, ignoring ids it made up, and never touches geometry', () => {
    const [a, b] = designs;
    const out = applyAiReview(designs, {
      overview: 'x', order: ['nope', b!.id, a!.id],
      reviews: { [b!.id]: { score: 140, highlights: [' Cool bedrooms. '], considerations: ['Shade the west.'] } },
    });
    expect(out.map((d) => d.id).slice(0, 2)).toEqual([b!.id, a!.id]);
    expect(out[0]!.review).toEqual({ score: 100, highlights: ['Cool bedrooms.'], considerations: ['Shade the west.'], source: 'ai' });
    expect(out[1]!.review.source).toBe('engine');
    expect(out[0]!.rooms).toBe(b!.rooms);
    expect(out).toHaveLength(designs.length);
  });
});
