import { describe, expect, it } from 'vitest';
import { conceptSet, conceptTitle, designConcept, generateDesigns, normaliseBrief, DEFAULT_DESIGN_CONFIG, type Design } from '../src/index';

const family = { purpose: 'family', taste: 'tropical', priorities: ['garden'] } as const;

describe('one name per design', () => {
  it('the name on the concept card is the name the design page and drawings use', () => {
    const plot = { widthM: 15.24, depthM: 30.48 };
    const brief = normaliseBrief({ type: 'duplex', bedrooms: 4, storeys: 2, style: 'tropical' });
    const set = conceptSet(plot, brief, family as never, { cfg: DEFAULT_DESIGN_CONFIG });
    expect(set.options.length).toBeGreaterThan(0);
    for (const o of set.options) {
      if (!/\(/.test(o.title)) expect(conceptTitle(o.design)).toBe(o.title);
      expect(designConcept(o.design).title).toBe(conceptTitle(o.design));
    }
  });

  it('an AI title wins, and non-house buildings are never called houses', () => {
    const plot = { widthM: 20, depthM: 40 };
    const offices = generateDesigns(plot, normaliseBrief({ type: 'office', storeys: 3 }), DEFAULT_DESIGN_CONFIG).designs;
    expect(offices.length).toBeGreaterThan(0);
    for (const d of offices) expect(conceptTitle(d)).toMatch(/^Office building: [a-z]/);
    const d = offices[0] as Design;
    const titled = { ...d, concept: { designId: d.id, title: 'The Lantern', story: 's', moves: [], palette: { walls: '', accents: '', roof: '' }, source: 'ai' as const } } as Design;
    expect(conceptTitle(titled)).toBe('The Lantern');
    expect(designConcept(titled).title).toBe('The Lantern');
  });
});
