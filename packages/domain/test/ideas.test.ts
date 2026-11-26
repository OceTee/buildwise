import { describe, expect, it } from 'vitest';
import { DESIGN_IDEAS, ideaOf, ideaWeight, learnIdeaPriors } from '../src/index';

describe('design ideas', () => {
  it('every idea has a story, moves and someone it suits', () => {
    expect(new Set(DESIGN_IDEAS.map((i) => i.key)).size).toBe(DESIGN_IDEAS.length);
    for (const i of DESIGN_IDEAS) {
      expect(i.story.length).toBeGreaterThan(60);
      expect(i.moves.length).toBeGreaterThanOrEqual(2);
      expect(i.suits.tastes.length + i.suits.priorities.length).toBeGreaterThan(0);
    }
  });

  it('a design id names its idea', () => {
    expect(ideaOf('free-123-garden-court-1s-3b')).toBe('garden-court');
    expect(ideaOf('free-9-master-retreat-1s-4b-bq')).toBe('master-retreat');
    expect(ideaOf('hub-1s-3b')).toBeNull();
    expect(ideaOf('free-1-not-an-idea-1s-3b')).toBeNull();
  });

  it('learns which ideas people choose, per taste, only once there is enough evidence', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ chosen: i % 5 === 0 ? 'quiet-wing' : 'breezeway', shown: ['breezeway', 'quiet-wing', 'garden-court'], taste: 'tropical' }));
    const p = learnIdeaPriors(rows);
    expect(p.tropical!.breezeway!).toBeGreaterThan(0);
    expect(p.tropical!['garden-court']!).toBeLessThan(0);
    expect(p.any!.breezeway!).toBeLessThanOrEqual(1.5);
    // Too little evidence: no nudge at all.
    expect(learnIdeaPriors(rows.slice(0, 3))).toEqual({});
    // A nudge moves the weight, and never below a floor.
    const breezeway = DESIGN_IDEAS.find((i) => i.key === 'breezeway')!;
    expect(ideaWeight(breezeway, { taste: 'tropical' }, p.tropical)).toBeGreaterThan(ideaWeight(breezeway, { taste: 'tropical' }));
    expect(ideaWeight(breezeway, {}, { breezeway: -10 })).toBeGreaterThan(0);
  });
});
