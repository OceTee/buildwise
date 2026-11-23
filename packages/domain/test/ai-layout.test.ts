import { describe, expect, it } from 'vitest';
import { aiLayoutSchema, billOfMaterials, designFromLayout, designerBrief, requiredRooms, solidsFor, type AiLayout } from '../src/index';

const plot = { widthM: 18.29, depthM: 36.58 };
const brief = { type: 'bungalow' as const, bedrooms: 3, ensuite: false };
const L: AiLayout = {
  name: 'Garden L', idea: 'A living wing to the street and a bedroom wing around a garden.', roof: 'hip',
  concept: { title: 'The Garden House', story: 'You step in to a bright living room.', moves: ['Living wing to the street.', 'Bedrooms on the quiet side.'], palette: { walls: 'White render', accents: 'Timber louvres', roof: 'Charcoal tiles' } },
  blocks: [
    { id: 'A', name: 'Living wing', x: 1.5, y: 6, w: 15, d: 5, storeys: 1 },
    { id: 'B', name: 'Bedroom wing', x: 1.5, y: 11, w: 9.6, d: 12, storeys: 1 },
  ],
  rooms: [
    { block: 'A', storey: 0, kind: 'living', name: 'Living room', x: 1.5, y: 6, w: 7, d: 5 },
    { block: 'A', storey: 0, kind: 'dining', name: 'Dining', x: 8.5, y: 6, w: 4, d: 5 },
    { block: 'A', storey: 0, kind: 'kitchen', name: 'Kitchen', x: 12.5, y: 6, w: 4, d: 5 },
    // The bedroom wing round a short lobby (no hallway strip), a family lounge at its end.
    { block: 'B', storey: 0, kind: 'corridor', name: 'Bedroom lobby', x: 5.1, y: 11, w: 1.8, d: 6 },
    { block: 'B', storey: 0, kind: 'master', name: 'Master bedroom', x: 1.5, y: 11, w: 3.6, d: 4 },
    { block: 'B', storey: 0, kind: 'bathroom', name: 'Bathroom', x: 1.5, y: 15, w: 3.6, d: 2 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 2', x: 6.9, y: 11, w: 4.2, d: 3 },
    { block: 'B', storey: 0, kind: 'store', name: 'Store', x: 6.9, y: 14, w: 4.2, d: 1.5 },
    { block: 'B', storey: 0, kind: 'wc', name: 'Guest WC', x: 6.9, y: 15.5, w: 4.2, d: 1.5 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 3', x: 1.5, y: 17, w: 3.3, d: 6 },
    { block: 'B', storey: 0, kind: 'lounge', name: 'Family lounge', x: 4.8, y: 17, w: 6.3, d: 6 },
  ],
};

describe('AI-composed layouts', () => {
  it('become full designs: two wings, doors off a short lobby, checks, concept, 3D and quantities', () => {
    const r = designFromLayout(plot, brief, L, 'ai-test-1');
    expect(r.problems).toEqual([]);
    const d = r.design!;
    expect(d.typology).toBe('ai');
    expect(d.blocks).toHaveLength(2);
    expect(d.concept?.title).toBe('The Garden House');
    expect(d.openings.some((o) => o.label === 'Front door')).toBe(true);
    const master = d.rooms.find((x) => x.kind === 'master')!;
    expect(d.openings.some((o) => o.roomId === master.id && o.kind === 'door')).toBe(true);
    expect(solidsFor(d).length).toBeGreaterThan(10);
    expect(billOfMaterials(d).length).toBeGreaterThan(10);
  });

  it('lists what an architect must fix: gaps, overlaps, rooms outside the buildable area, missing rooms', () => {
    const broken: AiLayout = { ...L, rooms: L.rooms.filter((x) => x.name !== 'Study' && x.name !== 'Bedroom 3').map((x) => (x.name === 'Kitchen' ? { ...x, x: 12, w: 6 } : x)) };
    const r = designFromLayout(plot, brief, broken, 'ai-test-2');
    const all = r.problems.join(' | ');
    expect(all).toMatch(/not covered by any room/);
    expect(all).toMatch(/overlap/);
    expect(all).toMatch(/stick out/);
    expect(all).toMatch(/Only 2 bedrooms/);
  });

  it('repeats the typical floor of a tall building and gives the designer the site in numbers', () => {
    const tower: AiLayout = {
      name: 'Tower', idea: 'Offices around a core.', roof: 'flat',
      blocks: [{ id: 'T', name: 'Tower', x: 2, y: 8, w: 20, d: 12, storeys: 6 }],
      rooms: [0, 1].flatMap((s) => [
        { block: 'T', storey: s, kind: 'stair' as const, name: 'Stair', x: 2, y: 8, w: 1.5, d: 12 },
        { block: 'T', storey: s, kind: 'lift' as const, name: 'Lift', x: 3.5, y: 8, w: 2.5, d: 12 },
        { block: 'T', storey: s, kind: (s ? 'open-office' : 'lobby') as 'lobby', name: s ? 'Office suite 1' : 'Reception', x: 6, y: 8, w: 14.5, d: 12 },
        { block: 'T', storey: s, kind: 'stair' as const, name: 'Escape stair', x: 20.5, y: 8, w: 1.5, d: 12 },
      ]),
    };
    const r = designFromLayout({ widthM: 30, depthM: 40 }, { type: 'office', storeys: 6, units: 1 }, tower, 'ai-tower');
    expect(r.design!.storeys).toBe(6);
    expect(r.design!.rooms.filter((x) => x.kind === 'lift')).toHaveLength(6);
    expect(r.design!.rooms.some((x) => x.storey === 5 && x.name === 'Office suite 5')).toBe(true);
    const site = designerBrief(plot, { type: 'duplex', storeys: 2, bedrooms: 4, features: ['gym'] });
    expect(site).toMatchObject({ buildingType: 'Duplex', storeys: 2, buildableArea: { x: 1.5, y: 3 } });
    expect(requiredRooms({ type: 'duplex', storeys: 2, bedrooms: 4, features: ['gym'] }).floors[0]!.rooms.some((x) => x.kind === 'gym')).toBe(true);
    expect(JSON.stringify(aiLayoutSchema())).toMatch(/"guest-room"/);
  });
});
