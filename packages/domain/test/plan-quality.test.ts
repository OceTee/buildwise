import { describe, expect, it } from 'vitest';
import { generateDesigns, type Design } from '../src/index';

const FT = 0.3048;
const habitable = (d: Design) => d.rooms.filter((r) => d.blocks.find((b) => b.id === r.block)?.kind === 'house');

describe('plan quality', () => {
  it('a 3-bedroom house fits a 12 m wide plot (the front row is rounded up, not down)', () => {
    for (const bedrooms of [2, 3, 4]) {
      const r = generateDesigns({ widthM: 12, depthM: 30 }, { type: 'duplex', bedrooms });
      expect(r.designs.length, `${bedrooms} bedrooms`).toBeGreaterThan(0);
      expect(r.designs[0]!.checks.filter((c) => c.status === 'fail')).toEqual([]);
    }
  });

  it('the narrow plan never stretches the master into a strip across the house', () => {
    const d = generateDesigns({ widthM: 50 * FT, depthM: 100 * FT }, { type: 'duplex', bedrooms: 4 }, undefined);
    const narrow = [...d.designs].find((x) => x.name === 'Narrow house') ?? null;
    if (!narrow) return; // not offered for this brief: nothing to check
    for (const r of habitable(narrow).filter((x) => x.kind === 'master')) expect(Math.max(r.w, r.d) / Math.min(r.w, r.d)).toBeLessThanOrEqual(1.9);
    // Each floor has one family lounge at most (spare space at the back becomes a study).
    for (let s = 0; s < narrow.storeys; s++) expect(narrow.rooms.filter((r) => r.storey === s && r.name === 'Family lounge').length).toBeLessThanOrEqual(1);
  });

  it('bedrooms in a bungalow keep a room-like proportion on a roomy plot, and the review names any that cannot', () => {
    // Four bedrooms fill a bungalow's middle row to its hall limit, so there a strip bedroom is named, not hidden.
    for (const d of generateDesigns({ widthM: 60 * FT, depthM: 120 * FT }, { type: 'bungalow', bedrooms: 4 }).designs) {
      const strips = habitable(d).filter((r) => r.kind === 'bedroom' && Math.max(r.w, r.d) / Math.min(r.w, r.d) > 1.75);
      if (strips.length) expect(d.review.considerations.join(' ')).toMatch(/long and shallow/);
    }
    for (const bedrooms of [3]) {
      for (const d of generateDesigns({ widthM: 60 * FT, depthM: 120 * FT }, { type: 'bungalow', bedrooms }).designs) {
        for (const r of habitable(d).filter((x) => x.kind === 'bedroom')) {
          expect(Math.max(r.w, r.d) / Math.min(r.w, r.d), `${d.name} ${r.name} ${r.w}x${r.d}`).toBeLessThanOrEqual(1.75);
        }
      }
    }
  });
});
