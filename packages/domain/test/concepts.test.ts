import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_EVAL, ASSISTANT_EVAL_BLIND, CONVERSATION_EVAL, SEED_EXAMPLES, SEED_KNOWLEDGE, TASTES, buildBrain, conceptMetrics, conceptSet, distinctDesigns,
  evaluateAssistant, evaluateConversations, generateDesigns, massingDistance, normalisePreferences, planDistance, preferenceFit, readPreferences, readRevision,
  respond, reviseBrief, shapedBy, tasteBrief, trainIntentModel, type Design, type Plot,
} from '../src/index';

const brain = buildBrain(trainIntentModel(SEED_EXAMPLES), [], SEED_KNOWLEDGE);
const P50: Plot = { widthM: 15.24, depthM: 30.48 }; const P60: Plot = { widthM: 18.29, depthM: 36.58 }; const P100: Plot = { widthM: 30.48, depthM: 30.48 };
const none: { taste: null; priorities: never[]; purpose: null } = { taste: null, priorities: [], purpose: null };

describe('preferences: purpose, taste and priorities are read apart from the brief', () => {
  it('grand is a feeling: it sets the look, never rooms, floors, a budget or a finish level', () => {
    const r = respond(brain, 'a grand and striking home for my family', { plot: null, brief: {} });
    expect(r.intent).toBe('build_home');
    expect(r.preferences).toMatchObject({ taste: 'grand', purpose: 'family' });
    expect(r.brief).toEqual({ style: TASTES.grand.style });
    expect(r.preferences.budgetMinor).toBeUndefined();
    expect(r.preferences.finish).toBeUndefined();
    // Spend needs its own words.
    expect(readPreferences('a grand home with premium finishes, budget 120 million')).toMatchObject({ taste: 'grand', finish: 'premium', budgetMinor: 12_000_000_000 });
    expect(tasteBrief('grand')).not.toHaveProperty('bedrooms');
    expect(tasteBrief('modern', true)).not.toHaveProperty('roof'); // a roof the person picked stays
  });
  it('a correction replaces the purpose, and a revision says what shrinks and what must stay', () => {
    expect(readPreferences('it is for tenants, not my family').purpose).toBe('tenants');
    expect(readRevision('make the plot smaller but keep the gym')).toEqual({ smaller: ['plot'], keep: ['gym'] });
    expect(readRevision('keep the gym')).toBeNull();
    expect(respond(brain, 'is a duplex cheaper than a bungalow', { plot: null, brief: {} }).revision).toBeNull();
    expect(normalisePreferences({ taste: 'nope' as never, priorities: ['garden', 'garden', 'x'] as never })).toMatchObject({ taste: null, priorities: ['garden'] });
  });
});

describe('the assistant on held-out messages and conversations', () => {
  it('reads the tuned held-out set, the conversations and the blind set', () => {
    const single = evaluateAssistant(brain, ASSISTANT_EVAL);
    const conv = evaluateConversations(brain, CONVERSATION_EVAL);
    const blind = evaluateAssistant(brain, ASSISTANT_EVAL_BLIND);
    expect(single.accuracy, JSON.stringify(single.failures)).toBeGreaterThanOrEqual(0.97);
    expect(conv.accuracy, JSON.stringify(conv.failures)).toBeGreaterThanOrEqual(0.97);
    // The blind set is not tuned against: it may miss a few, but must stay well above the old model's 0.37.
    expect(blind.accuracy).toBeGreaterThanOrEqual(0.9);
    // Nothing said earlier in a conversation is lost by the end.
    expect(conv.byGroup.retained).toMatchObject({ accuracy: 1 });
  });
});

describe('concept options: up to three, each pair different in plan or massing', () => {
  const cases: [string, Plot, Record<string, unknown>][] = [
    ['3-bed bungalow', P50, { bedrooms: 3 }], ['4-bed duplex', P60, { type: 'duplex', storeys: 2, bedrooms: 4 }],
    ['5-bed duplex', P100, { type: 'duplex', storeys: 2, bedrooms: 5 }], ['4-bed bungalow with a gym', P50, { bedrooms: 4, features: ['gym'] }],
    ['flats', P60, { type: 'apartments', storeys: 4, units: 2 }],
  ];
  for (const [name, plot, brief] of cases) {
    it(`${name}: three checked options with different names and reasons`, () => {
      const set = conceptSet(plot, brief as never, { taste: 'tropical', priorities: ['garden'], purpose: 'family' });
      expect(set.options.length, set.note ?? '').toBe(3);
      for (const o of set.options) expect(o.design.checks.filter((c) => c.status === 'fail')).toEqual([]);
      for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) expect(distinctDesigns(set.options[i]!.design, set.options[j]!.design), `${set.options[i]!.title} / ${set.options[j]!.title}`).toBe(true);
      expect(new Set(set.options.map((o) => o.title)).size).toBe(3);
      expect(new Set(set.options.map((o) => o.tag)).size).toBe(3);
      for (const o of set.options) { expect(o.reason.length).toBeGreaterThan(20); expect(o.points.length).toBeGreaterThanOrEqual(2); }
    });
  }
  it('a mirror image or a recolour is the same design, never a second option', () => {
    const d = generateDesigns(P60, { bedrooms: 3 }).designs[0]!;
    const flip = <T extends { x: number; w: number }>(r: T): T => ({ ...r, x: P60.widthM - r.x - r.w });
    const mirrored: Design = { ...d, id: 'm', blocks: d.blocks.map(flip), rooms: d.rooms.map(flip) };
    expect(massingDistance(d, mirrored)).toBe(0);
    expect(planDistance(d, mirrored)).toBe(0);
    const recoloured: Design = { ...d, id: 'c', name: 'Another name', brief: { ...d.brief, style: 'classic' }, finishes: [] };
    expect(distinctDesigns(d, recoloured)).toBe(false);
  });
  it('shows fewer options and says why when the plot allows fewer', () => {
    const set = conceptSet({ widthM: 12.19, depthM: 30.48 }, { type: 'duplex', storeys: 2, bedrooms: 4 }, none);
    expect(set.options.length).toBeGreaterThanOrEqual(1);
    expect(set.options.length).toBeLessThan(3);
    expect(set.note).toMatch(/pass(es)? every check|different enough/);
    expect(conceptSet({ widthM: 7, depthM: 9 }, { bedrooms: 5 }, none)).toMatchObject({ options: [], considered: 0 });
  });
  it('changes the checked comparison when the same household switches from garden to hosting', () => {
    const brief = { type: 'duplex', storeys: 2, bedrooms: 4, ...tasteBrief('modern') } as const;
    const prefs = { taste: 'modern', purpose: 'family' } as const;
    const garden = conceptSet(P60, brief, { ...prefs, priorities: ['garden'] });
    const hosting = conceptSet(P60, brief, { ...prefs, priorities: ['host'] });
    expect(garden.options).toHaveLength(3);
    expect(hosting.options).toHaveLength(3);
    const wide = hosting.options.find((option) => option.design.id.startsWith('hub-hosting-'));
    expect(wide).toBeDefined();
    expect(garden.options.some((option) => option.design.id === wide?.design.id)).toBe(false);
    const dining = wide?.design.rooms.find((room) => room.kind === 'dining');
    expect(dining && dining.w * dining.d).toBeGreaterThan(20);
    expect(wide?.design.checks.every((check) => check.status === 'pass')).toBe(true);
  });
  it('offers a recessed outdoor entry court in the tropical garden comparison', () => {
    const set = conceptSet(P60, { type: 'duplex', storeys: 2, bedrooms: 4, style: 'tropical' },
      { taste: 'tropical', purpose: 'family', priorities: ['garden'] });
    const court = set.options.find((option) => option.title === 'Entry Court House')?.design;
    expect(court).toBeDefined();
    const wings = court!.blocks.filter((block) => block.name === 'Living wing' || block.name === 'Dining wing');
    const entrance = court!.blocks.find((block) => block.name === 'Entrance and hall')!;
    expect(wings).toHaveLength(2);
    expect(wings.every((wing) => entrance.y - wing.y >= 2)).toBe(true);
    expect(court!.checks.every((check) => check.status !== 'fail')).toBe(true);
  });
  it('priorities and taste weigh the fit, and grand never rewards a bigger building', () => {
    const ds = generateDesigns(P60, { bedrooms: 3 }).designs;
    const ms = ds.map(conceptMetrics);
    const open = [...ms].sort((a, b) => b.openM2 - a.openM2);
    expect(preferenceFit(open[0]!, ms, { ...none, priorities: ['garden'] })).toBeGreaterThan(preferenceFit(open[open.length - 1]!, ms, { ...none, priorities: ['garden'] }));
    const big = { ...ms[0]!, grossFloorM2: ms[0]!.grossFloorM2 * 2 };
    expect(preferenceFit(big, [big, ...ms.slice(1)], { ...none, taste: 'grand' })).toBeLessThanOrEqual(preferenceFit(ms[0]!, ms, { ...none, taste: 'grand' }));
  });
  it('explains how the person\'s choices shaped the chosen design, from what the design really has', () => {
    const d = conceptSet(P60, { type: 'duplex', storeys: 2, bedrooms: 4, style: 'tropical' }, { taste: 'tropical', priorities: ['garden'], purpose: 'family' }).options[0]!.design;
    const s = shapedBy(d, normalisePreferences({ taste: 'tropical', priorities: ['garden'], purpose: 'family' }));
    expect(s.length).toBeGreaterThanOrEqual(2);
    expect(s.length).toBeLessThanOrEqual(3);
    expect(s[0]!.choice).toBe('You chose Tropical & open');
    expect(s.some((x) => /% of your plot/.test(x.effect))).toBe(true);
  });
});

describe('revisions keep what the person protected', () => {
  it('a smaller plot that keeps the gym: the first common size down that passes every check', () => {
    const r = reviseBrief(P60, { type: 'duplex', storeys: 2, bedrooms: 4, features: ['gym'] }, { smaller: ['plot'], keep: ['gym'] });
    expect(r.fits).toBe(true);
    expect(r.plot.widthM * r.plot.depthM).toBeLessThan(P60.widthM * P60.depthM);
    expect(r.brief.features).toContain('gym');
    expect(r.kept).toContain('gym');
    expect(r.designs.length).toBeGreaterThan(0);
    for (const d of r.designs) { expect(d.rooms.some((x) => x.kind === 'gym')).toBe(true); expect(d.checks.filter((c) => c.status === 'fail')).toEqual([]); }
    expect(r.note).toMatch(/gym/);
  });
  it('gives up unprotected things before protected ones, and says so', () => {
    const r = reviseBrief(P60, { bedrooms: 4, study: true, bq: true, features: ['gym'] }, { smaller: ['plot'], keep: ['gym', 'bedrooms'] }, { toPlot: { widthM: 12.19, depthM: 24.38 } });
    expect(r.brief.features).toContain('gym');
    expect(r.brief.bedrooms).toBe(4);
    if (r.fits) expect(r.changes.length).toBeGreaterThan(0);
    else expect(r.note).toMatch(/Nothing passes/);
  });
});
