import { describe, expect, it } from 'vitest';
import { billOfMaterials, designFromLayout, generateDesigns, type AiLayout } from '../src/index';

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
});
