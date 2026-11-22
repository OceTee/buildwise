import { describe, expect, it } from 'vitest';
import { BUILDING_TYPES, affinity, designFromLayout, generateDesigns, layoutFromDesign, planningAnalysis, planningPrinciples, type BuildingType } from '../src/index';

const plot = { widthM: 18.29, depthM: 36.58 };

describe('planning logic', () => {
  it('knows which rooms belong together and which must be kept apart', () => {
    expect(affinity('kitchen', 'dining')).toBeGreaterThan(0);
    expect(affinity('master', 'ensuite')).toBeGreaterThan(0);
    expect(affinity('wc', 'kitchen')).toBeLessThan(0);
    expect(affinity('kitchen', 'wc')).toBe(affinity('wc', 'kitchen'));
    expect(affinity('cinema', 'bedroom')).toBeLessThan(0);
    expect(planningPrinciples().some((l) => /toilet must never share a wall with food/.test(l))).toBe(true);
  });

  it('reads a plan: shared walls that work and those that fight', () => {
    const room = (id: string, kind: 'kitchen' | 'wc' | 'dining', x: number) => ({ id, kind, name: kind, storey: 0, x, y: 0, w: 3, d: 4 });
    const a = planningAnalysis([room('a', 'kitchen', 0), room('b', 'dining', 3), room('c', 'wc', 6)]);
    expect(a.good.map((r) => [r.a, r.b])).toEqual([['kitchen', 'dining']]);
    expect(a.bad.map((r) => [r.a, r.b])).toEqual([['dining', 'wc']]);
  });

  it('the engine arranges rooms so no toilet touches food and no kitchen or loud room touches a bedroom', () => {
    const briefs = [
      { bedrooms: 3 }, { bedrooms: 4, storeys: 2 }, { bedrooms: 5, storeys: 2, features: ['cinema', 'gym', 'laundry'] }, { bedrooms: 2, openPlan: true },
      ...(['apartments', 'hotel', 'office', 'school', 'clinic', 'mixed-use'] as BuildingType[]).map((type) => ({ type, storeys: Math.min(4, BUILDING_TYPES[type].storeys.max) })),
    ];
    for (const brief of briefs) {
      for (const d of generateDesigns({ widthM: 30, depthM: 45 }, brief).designs) {
        const worst = planningAnalysis(d.rooms).bad.filter((r) => r.score <= -2);
        expect(worst.map((r) => `${d.brief.type} ${d.name}: ${r.a} / ${r.b}`)).toEqual([]);
      }
    }
  });

  it('ranks designs by planning: the review names its best relationship', () => {
    const d = generateDesigns(plot, { bedrooms: 3 }).designs[0]!;
    expect(d.review.highlights.some((h) => / sits beside .*: /.test(h))).toBe(true);
  });

  it('an AI layout keeps its plan, and a kitchen against a bedroom goes back as a planning problem', () => {
    const base = generateDesigns(plot, { bedrooms: 3 }).designs[0]!;
    const layout = { ...layoutFromDesign(base), planning: { zones: 'Living to the street, bedrooms behind.', arrival: 'Porch to hall.', relationships: ['Kitchen beside dining because food goes to the table.'], flow: 'Guests stay in front.' } };
    const ok = designFromLayout(plot, base.brief, layout, 'ai-1');
    expect(ok.problems).toEqual([]);
    expect(ok.design!.planning!.relationships).toHaveLength(1);
    // Swap the kitchen's use with a bedroom's: now a bedroom sits in the kitchen's place and vice versa.
    const k = layout.rooms.findIndex((r) => r.kind === 'kitchen'); const b = layout.rooms.findIndex((r) => r.kind === 'bedroom');
    const rooms = layout.rooms.map((r, i) => (i === k ? { ...r, kind: 'bedroom' as const, name: 'Bedroom 9' } : i === b ? { ...r, kind: 'kitchen' as const, name: 'Kitchen' } : r));
    const bad = designFromLayout(plot, base.brief, { ...layout, rooms }, 'ai-2');
    expect(bad.problems.some((p) => /^Planning: |toilet|Hygiene/i.test(p))).toBe(true);
  });

  it('every engine design opens in the Studio clean: its layout passes the same checks (no false gaps, overlaps or setback breaches)', () => {
    const out: string[] = [];
    for (const p of [plot, { widthM: 15.24, depthM: 30.48 }, { widthM: 30, depthM: 45 }])
      for (const brief of [{ bedrooms: 3 }, { type: 'duplex' as const, storeys: 2, bedrooms: 4, features: ['laundry'] }, ...(['apartments', 'hotel', 'office'] as BuildingType[]).map((type) => ({ type, storeys: 3 }))])
        for (const d of generateDesigns(p, brief).designs) {
          const r = designFromLayout(p, d.brief, layoutFromDesign(d), 'x');
          if (r.problems.length) out.push(`${p.widthM} ${d.brief.type} ${d.name}: ${r.problems.join(' | ')}`);
        }
    expect(out).toEqual([]);
  });
});
