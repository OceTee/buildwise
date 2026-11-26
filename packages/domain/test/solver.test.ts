import { describe, expect, it } from 'vitest';
import { DESIGN_IDEAS, conceptSet, distinctDesigns, findDesign, freeDesign, freeDesigns, attemptSeed, type Design } from '../src/index';

const FT = 0.3048;
const PLOT = { widthM: 60 * FT, depthM: 120 * FT };
const prefs = { purpose: 'family', taste: 'modern', priorities: [] } as never;
const plan = (d: Design) => d.rooms.map((r) => `${r.name}@${r.storey}:${r.x},${r.y},${r.w}x${r.d}`).sort().join('|');

describe('free-form solver', () => {
  it('the same seed always gives the same house, and its id rebuilds it', () => {
    const seed = [...Array(40).keys()].map((k) => attemptSeed(11, k)).find((s) => freeDesign(PLOT, { type: 'bungalow', bedrooms: 3 }, s))!;
    const a = freeDesign(PLOT, { type: 'bungalow', bedrooms: 3 }, seed)!;
    const b = freeDesign(PLOT, { type: 'bungalow', bedrooms: 3 }, seed)!;
    expect(a.id).toMatch(/^free-\d+-[a-z-]+-1s-3b/);
    expect(a.concept?.title).toBeTruthy();
    expect(plan(b)).toBe(plan(a));
    expect(plan(findDesign(PLOT, { type: 'bungalow', bedrooms: 3 }, a.id)!)).toBe(plan(a));
  });

  for (const [label, brief] of [['3-bed bungalow', { type: 'bungalow', bedrooms: 3 }], ['4-bed duplex', { type: 'duplex', bedrooms: 4 }]] as const) {
    it(`${label}: every concept passes every check, with bedrooms off a lobby and a stair on both floors`, () => {
      const ds = freeDesigns(PLOT, brief, { seed: 5 });
      expect(ds.length).toBeGreaterThanOrEqual(3);
      for (const d of ds) {
        expect(d.checks.filter((c) => c.status === 'fail'), d.id).toEqual([]);
        // No hallway strips: every hall within a lobby's length.
        for (const c of d.rooms.filter((r) => r.kind === 'corridor')) expect(Math.max(c.w, c.d), `${d.id} ${c.name}`).toBeLessThanOrEqual(7.001);
      }
    });
  }

  it('different seeds give different houses, not the same few layouts', () => {
    const a = freeDesigns(PLOT, { type: 'bungalow', bedrooms: 4 }, { seed: 1, count: 6 });
    const b = freeDesigns(PLOT, { type: 'bungalow', bedrooms: 4 }, { seed: 2, count: 6 });
    expect(a.length).toBeGreaterThan(2);
    expect(b.some((x) => a.every((y) => distinctDesigns(x, y)))).toBe(true);
    // More than one way of composing the house across the two runs.
    expect(new Set([...a, ...b].map((d) => d.name)).size).toBeGreaterThanOrEqual(3);
  });

  it('new ideas never repeat what was already shown', () => {
    const first = conceptSet(PLOT, { type: 'bungalow', bedrooms: 3 }, prefs, { seed: 21 });
    expect(first.options.length).toBe(3);
    const seen = first.options.map((o) => o.design.id);
    const next = conceptSet(PLOT, { type: 'bungalow', bedrooms: 3 }, prefs, { seed: 22, avoidIds: seen });
    expect(next.options.length).toBeGreaterThan(0);
    for (const o of next.options) {
      expect(seen).not.toContain(o.design.id);
      for (const id of seen) expect(distinctDesigns(findDesign(PLOT, { type: 'bungalow', bedrooms: 3 }, id)!, o.design)).toBe(true);
    }
  });

  it("the person's taste and priorities steer which ideas are drawn", () => {
    const share = (prefs: { taste: 'tropical' | 'grand'; priorities: ('garden' | 'host')[] }, taste: string) => {
      const ds = [1, 2, 3, 4].flatMap((seed) => freeDesigns({ widthM: 100 * FT, depthM: 100 * FT }, { type: 'bungalow', bedrooms: 4 }, { seed, count: 10, prefs }));
      const suits = ds.filter((d) => DESIGN_IDEAS.find((i) => i.title === d.concept?.title)?.suits.tastes.includes(taste as never));
      return suits.length / Math.max(1, ds.length);
    };
    expect(share({ taste: 'tropical', priorities: ['garden'] }, 'tropical')).toBeGreaterThan(share({ taste: 'grand', priorities: ['host'] }, 'tropical'));
  });
});
