import { describe, expect, it } from 'vitest';
import { DESIGN_IDEAS, conceptSet, distinctDesigns, wellPlanned, findDesign, freeDesign, freeDesigns, attemptSeed, type Design } from '../src/index';

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

  it('two-storey ideas plan their upper floors differently: a lounge landing, a master above the living room, a roof terrace', () => {
    const plot60 = { widthM: 60 * FT, depthM: 120 * FT };
    const first = (idea: string, roof: string) => {
      for (let k = 0; k < 60; k++) {
        const d = freeDesign(plot60, { type: 'duplex', bedrooms: 4, roof } as never, attemptSeed(99, k), undefined, { idea });
        if (d && !d.checks.some((c) => c.status === 'fail') && wellPlanned(d)) return d;
      }
      return null;
    };
    const lounge = first('lounge-landing', 'hip')!;
    const upLounge = lounge.rooms.find((r) => r.storey === 1 && r.kind === 'lounge');
    expect(upLounge?.name).toBe('Family lounge');
    const above = first('master-above', 'hip')!;
    const living = above.rooms.find((r) => r.storey === 0 && r.kind === 'living')!;
    const master = above.rooms.find((r) => r.storey === 1 && r.kind === 'master')!;
    // The master suite stands over the living room, reached by a gallery over the entrance hall.
    expect(Math.min(master.x + master.w, living.x + living.w) - Math.max(master.x, living.x)).toBeGreaterThan(2);
    expect(above.rooms.some((r) => r.storey === 1 && r.name === 'Gallery')).toBe(true);
    const terrace = first('sky-terrace', 'flat')!;
    expect(terrace.elements.some((e) => e.label === 'Roof terrace' && e.storey === 1)).toBe(true);
    expect(terrace.rooms.some((r) => r.storey === 1 && r.glazing === 'full-height')).toBe(true);
    // A roof terrace needs a flat roof: never drawn over a pitched one.
    expect(freeDesign(plot60, { type: 'duplex', bedrooms: 4, roof: 'hip' } as never, attemptSeed(99, 0), undefined, { idea: 'sky-terrace' })).toBeNull();
  });

  it('a narrow 12 m plot still gets fresh two-storey concepts, every one well planned', () => {
    const set = conceptSet({ widthM: 12, depthM: 30 }, { type: 'duplex', bedrooms: 3 }, prefs, { seed: 77 });
    expect(set.options.some((o) => o.design.id.startsWith('free-'))).toBe(true);
    for (const o of set.options.filter((x) => x.design.id.startsWith('free-'))) expect(wellPlanned(o.design)).toBe(true);
  });

  it('every concept keeps the whole programme: living, dining, kitchen, every bedroom, on every plot', () => {
    const plots = [{ widthM: 50 * FT, depthM: 100 * FT }, { widthM: 60 * FT, depthM: 120 * FT }, { widthM: 12, depthM: 30 }, { widthM: 100 * FT, depthM: 100 * FT }];
    for (const plot of plots) for (const brief of [{ type: 'bungalow', bedrooms: 3 }, { type: 'duplex', bedrooms: 4 }] as const) {
      for (const d of freeDesigns(plot, brief, { seed: 13, tries: 120, count: 8 })) {
        const kinds = d.rooms.map((r) => r.kind);
        expect(kinds.filter((k) => k === 'living').length, d.id).toBe(1);
        expect(kinds.includes('dining') && kinds.includes('kitchen'), d.id).toBe(true);
        expect(kinds.filter((k) => k === 'bedroom' || k === 'master').length, d.id).toBe(brief.bedrooms);
      }
    }
  });
});
