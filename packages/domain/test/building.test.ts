import { describe, expect, it } from 'vitest';
import {
  BUILDING_TYPES, BUILDING_TYPE_KEYS, billOfMaterials, buildingOccupants, DEFAULT_PROJECT, generateDesigns, needsLift, needsTwoStairs,
  normaliseBrief, planProject, readBriefText, roofPlanes, solidsFor,
} from '../src/index';

const big = { widthM: 30, depthM: 40 };

describe('building types', () => {
  for (const type of BUILDING_TYPE_KEYS) {
    const info = BUILDING_TYPES[type];
    for (const storeys of [...new Set([info.storeys.min, info.storeys.max])]) {
      it(`${type}, ${storeys} storey(s): generates checked designs with stairs, lifts and doors in order`, () => {
        const r = generateDesigns(big, { type, storeys, features: info.defaultFeatures ?? [] });
        expect(r.designs.length).toBeGreaterThan(0);
        for (const d of r.designs) {
          expect(d.brief.type).toBe(type);
          expect(d.storeys).toBe(storeys);
          expect(d.checks.filter((c) => c.status === 'fail')).toEqual([]);
          // Every block is full height, except a pavilion plan's single-storey living pavilion.
          expect(d.blocks.every((b) => b.storeys === storeys || b.kind === 'outbuilding' || (d.typology === 'pavilion' && b.storeys === 1))).toBe(true);
          // Every storey has rooms, and the main entrance exists.
          for (let s = 0; s < storeys; s++) expect(d.rooms.some((x) => x.storey === s && x.kind !== 'corridor')).toBe(true);
          expect(d.openings.some((o) => o.external && o.kind === 'door')).toBe(true);
          if (needsLift(type, storeys, d.brief.features)) expect(d.rooms.filter((x) => x.kind === 'lift')).toHaveLength(storeys);
          if (needsTwoStairs(type, storeys)) expect(d.checks.find((c) => c.code === 'escape-stairs')?.status).toBe('pass');
          // Geometry and quantities stay finite.
          expect(solidsFor(d).every((x) => Number.isFinite(x.sx) && Number.isFinite(x.cz))).toBe(true);
          expect(roofPlanes(d).length).toBeGreaterThan(0);
          expect(billOfMaterials(d).every((l) => Number.isFinite(l.quantity) && l.quantity >= 0)).toBe(true);
          expect(d.summary).not.toMatch(/undefined|NaN/);
        }
      });
    }
  }

  it('plans water, power and cost for a hotel from its rooms', () => {
    const d = generateDesigns(big, { type: 'hotel', storeys: 4, units: 10 }).designs[0]!;
    expect(buildingOccupants(d, DEFAULT_PROJECT)).toBeGreaterThan(40);
    const p = planProject(d, DEFAULT_PROJECT);
    expect(p.water.result.fixtures.showers).toBeGreaterThanOrEqual(d.rooms.filter((r) => r.kind === 'guest-room').length);
    expect(p.loads.some((l) => l.id === 'lift')).toBe(true);
    expect(p.budget.result.lines[0]!.basis).toMatch(/hotel rate ×1.3/);
  });

  it('a terrace gives every house its own front door and stair, aligned on each floor', () => {
    const d = generateDesigns(big, { type: 'terrace', storeys: 2, units: 4 }).designs[0]!;
    expect(d.openings.filter((o) => o.label === 'Front door')).toHaveLength(4);
    expect(d.rooms.filter((r) => r.kind === 'corridor')).toHaveLength(0);
    expect(d.rooms.filter((r) => r.storey === 1 && r.kind === 'bedroom').every((r) => d.openings.some((o) => o.roomId === r.id && o.kind === 'door'))).toBe(true);
    expect(d.checks.find((c) => c.code === 'stair')?.status).toBe('pass');
  });

  it('a three-storey duplex puts the family rooms on top', () => {
    const d = generateDesigns(big, { type: 'duplex', storeys: 3, bedrooms: 4, features: ['gym', 'cinema', 'gaming', 'lift'] }).designs[0]!;
    const top = d.rooms.filter((r) => r.storey === 2).map((r) => r.kind);
    expect(top).toEqual(expect.arrayContaining(['gym', 'cinema', 'gaming', 'lift', 'stair']));
  });

  it('fits less on a small plot and says so, rather than nothing', () => {
    const r = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { type: 'hotel', storeys: 4, units: 10, features: ['restaurant'] });
    expect(r.designs.length).toBeGreaterThan(0);
    expect(r.notes.join(' ')).toMatch(/do not fit|leave out/);
  });

  it('keeps older briefs working: two storeys meant a duplex', () => {
    expect(normaliseBrief({ storeys: 2 }).type).toBe('duplex');
    expect(normaliseBrief({ type: 'bungalow', storeys: 2 }).type).toBe('duplex');
    expect(normaliseBrief({}).type).toBe('bungalow');
    expect(normaliseBrief({ type: 'office', storeys: 40 }).storeys).toBe(10);
    expect(normaliseBrief({ type: 'office', features: ['cinema', 'conference'] }).features).toEqual(['conference']);
  });

  it('reads building types, storeys and sizes from plain words', () => {
    expect(readBriefText('A 4-storey hotel with 40 rooms and a restaurant').brief).toMatchObject({ type: 'hotel', storeys: 4, units: 10, features: ['restaurant'] });
    expect(readBriefText('G+3 plaza with 24 shops').brief).toMatchObject({ type: 'shops', storeys: 4, units: 6 });
    expect(readBriefText('church for 800 people').brief).toMatchObject({ type: 'worship', units: 800 });
    expect(readBriefText('3 bedroom bungalow with a flat roof').brief).toMatchObject({ type: 'bungalow', storeys: 1, roof: 'flat' });
  });
});
