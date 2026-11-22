import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT, budgetPlan, coolingPlan, defaultLoads, energyPlan, generateDesigns, impactOf, normaliseProject, projectChecks, projectFacts,
  recordDecision, settleDecision, stageProgress, verificationRegister, waterPlan,
} from '../src/index';

const plot = { widthM: 15.24, depthM: 30.48 };
const design = generateDesigns(plot, { bedrooms: 3, bathrooms: 1 }).designs[0]!;

describe('cooling', () => {
  it('sizes an air conditioner per habitable room from its area, people and windows', () => {
    const c = coolingPlan(design, { airConditioning: true, kitchenAc: false });
    const bedrooms = c.result.rooms.filter((r) => /bedroom/i.test(r.name));
    expect(bedrooms.length).toBe(3);
    for (const r of bedrooms) {
      expect(r.ac).not.toBeNull();
      expect(r.ac!.btu * r.ac!.units).toBeGreaterThanOrEqual(r.btu);
      expect([9000, 12000, 18000, 24000]).toContain(r.ac!.btu);
    }
    expect(c.result.rooms.find((r) => r.name === 'Kitchen')?.ac ?? null).toBeNull();
    expect(c.steps.length).toBeGreaterThan(2);
    expect(c.assumptions.join(' ')).toMatch(/engineer/);
    // Fans only: no units, no input power.
    const fans = coolingPlan(design, { airConditioning: false, kitchenAc: false });
    expect(fans.result.acUnits).toBe(0);
    expect(fans.result.inputKw).toBe(0);
  });
});

describe('water', () => {
  it('works out demand, storage in standard tanks, the pump and heaters', () => {
    const w = waterPlan(design, { occupants: 5, borehole: true, hotWater: true });
    expect(w.result.demandLPerDay).toBe(600);
    expect(w.result.storageL).toBeGreaterThanOrEqual(1200);
    expect(w.result.pump!.hp).toBeGreaterThan(0);
    expect(w.result.pump!.headM).toBeGreaterThan(60);
    expect(w.result.heaters).toBeGreaterThan(0);
    expect(waterPlan(design, { occupants: 5, borehole: false, hotWater: false }).result.pump).toBeNull();
  });
});

describe('energy', () => {
  const cooling = coolingPlan(design, { airConditioning: true, kitchenAc: false });
  const water = waterPlan(design, { occupants: 4, borehole: true, hotWater: true });
  const loads = defaultLoads(design, cooling, water);

  it('builds a load schedule from the house, cooling and water', () => {
    expect(loads.some((l) => l.id.startsWith('ac-'))).toBe(true);
    expect(loads.some((l) => l.id === 'pump')).toBe(true);
    expect(loads.find((l) => l.id === 'ev')!.category).toBe('future');
  });

  it('without solar: daily energy, peak demand and a generator size, no system', () => {
    const e = energyPlan(loads, { enabled: false, cover: 'most', autonomyDays: 1 });
    expect(e.result.solar).toBeNull();
    expect(e.result.dailyKwh).toBeGreaterThan(5);
    expect(e.result.peakKw).toBeLessThan(e.result.connectedKw);
    expect(e.result.generatorKva).toBeGreaterThan(e.result.peakKw);
  });

  it('with solar: array, battery (usable below nominal) and inverter, with kW and kWh kept apart', () => {
    const e = energyPlan(loads, { enabled: true, cover: 'most', autonomyDays: 1 });
    const s = e.result.solar!;
    expect(s.panels).toBeGreaterThan(0);
    expect(s.arrayKwp).toBeCloseTo((s.panels * 550) / 1000, 2);
    expect(s.batteryUsableKwh).toBeLessThan(s.batteryNominalKwh);
    expect(s.dailyYieldKwh).toBeGreaterThanOrEqual(s.coveredKwh * 0.95);
    expect(e.assumptions.join(' ')).toMatch(/kW is power.*kWh is energy/);
    // Covering more loads needs a bigger array.
    expect(energyPlan(loads, { enabled: true, cover: 'all', autonomyDays: 1 }).result.solar!.arrayKwp).toBeGreaterThan(energyPlan(loads, { enabled: true, cover: 'essential', autonomyDays: 1 }).result.solar!.arrayKwp);
  });
});

describe('budget', () => {
  it('prices the building and systems, and shows options when the budget falls short', () => {
    const energy = energyPlan(defaultLoads(design, null, null), { enabled: true, cover: 'most', autonomyDays: 1 });
    const b = budgetPlan(design, { budgetMinor: 10_000_000_00, landIncluded: false, landCostMinor: 0, finish: 'standard', externalWorks: true, furniture: true }, { energy });
    expect(b.result.lines.map((l) => l.key)).toEqual(expect.arrayContaining(['building', 'solar', 'fees', 'permits', 'contingency', 'furniture']));
    expect(b.result.lowMinor).toBeLessThan(b.result.totalMinor);
    expect(b.result.highMinor).toBeGreaterThan(b.result.totalMinor);
    expect(b.result.gapMinor!).toBeGreaterThan(0);
    expect(b.result.options.length).toBeGreaterThan(2);
    expect(b.result.stages.reduce((s, x) => s + x.minor, 0)).toBeCloseTo(b.result.lines[0]!.minor, -3);
    const rich = budgetPlan(design, { budgetMinor: 10_000_000_000_00, landIncluded: false, landCostMinor: 0, finish: 'standard', externalWorks: true, furniture: false }, {});
    expect(rich.result.gapMinor!).toBeLessThan(0);
    expect(rich.result.options).toEqual([]);
  });
});

describe('the project record', () => {
  it('keeps confirmed, assumed and AI-proposed apart, and records revisions with their impact', () => {
    let p = normaliseProject({ briefSource: { bedrooms: 'you' } });
    const facts = projectFacts(p, plot, design.brief, design);
    expect(facts.find((f) => f.id === 'brief-bedrooms')!.status).toBe('confirmed');
    expect(facts.find((f) => f.id === 'brief-roof')!.status).toBe('assumed');
    expect(facts.find((f) => f.id === 'soil')!.status).toBe('needs_verification');

    p = recordDecision(p, 'layout', 'Compact', 'you');
    p = recordDecision(p, 'layout', 'L-plan', 'you');
    expect(p.decisions.filter((d) => d.topic === 'layout').map((d) => d.status)).toEqual(['superseded', 'confirmed']);
    expect(p.revisions[0]!.summary).toBe('layout: Compact → L-plan');
    expect(p.revisions[0]!.affects).toEqual(impactOf('layout'));

    // The AI only proposes; the person confirms.
    p = recordDecision(p, 'solar', 'Solar for essential loads', 'ai');
    const proposal = p.decisions.find((d) => d.topic === 'solar')!;
    expect(proposal.status).toBe('proposed');
    p = settleDecision(p, proposal.id, 'confirmed');
    expect(p.decisions.find((d) => d.topic === 'solar')!).toMatchObject({ status: 'confirmed', by: 'you' });
    expect(impactOf('room size')).toEqual(expect.arrayContaining(['cooling load', 'electrical outlets', 'furniture layout']));
  });

  it('checks the systems against each other and lists what professionals must verify', () => {
    const p = normaliseProject({ ...DEFAULT_PROJECT, systems: { ...DEFAULT_PROJECT.systems, solar: { enabled: true, cover: 'all', autonomyDays: 1 } } });
    const cooling = coolingPlan(design, { airConditioning: true, kitchenAc: true });
    const energy = energyPlan(defaultLoads(design, cooling, null).map((l) => (l.id.startsWith('ac-') ? { ...l, watts: l.watts * 4 } : l)), p.systems.solar);
    const issues = projectChecks(p, design, { cooling, energy });
    expect(issues.some((i) => /Location not given/.test(i.text))).toBe(true);
    expect(verificationRegister(p, design).map((v) => v.professional)).toEqual(expect.arrayContaining(['Structural engineer', 'Qualified solar installer']));
    expect(stageProgress(p, plot, design, {})[0]!.key).toBe('understand');
  });
});
