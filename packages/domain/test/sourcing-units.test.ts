import { describe, expect, it } from 'vitest';
import { billOfMaterials, generateDesigns, unitCode, unitsNeeded } from '../src/index';

describe('buying a bill-of-materials line from a listing', () => {
  it('compares bags by what they hold: 50 kg bags need twice as many 25 kg bags', () => {
    const cement = { unit: 'bag', quantity: 607, pack: { value: 50, unit: 'kg' } };
    expect(unitsNeeded(cement, { unit: 'bag', pack: { value: 50, unit: 'kg' } })).toEqual({ count: 607, unit: 'bag' });
    expect(unitsNeeded(cement, { unit: 'bag', pack: { value: 25, unit: 'kg' } })).toEqual({ count: 1214, unit: 'bag' });
    // A bag of unknown size cannot be compared with 50 kg bags.
    expect(unitsNeeded(cement, { unit: 'bag' })).toBeNull();
    // Cement sold by the tonne converts, in parts.
    expect(unitsNeeded(cement, { unit: 'tonne' })).toEqual({ count: 30.35, unit: 'tonne' });
  });

  it('turns tonnes of sand into whole tipper trips', () => {
    expect(unitsNeeded({ unit: 'tonne', quantity: 68.5 }, { unit: 'trip', pack: { value: 20, unit: 'tonne' } })).toEqual({ count: 4, unit: 'trip' });
    expect(unitsNeeded({ unit: 'tonne', quantity: 40 }, { unit: 'trip', pack: { value: 20, unit: 'tonne' } })).toEqual({ count: 2, unit: 'trip' });
    // A trip of unknown size is a quote, not a price.
    expect(unitsNeeded({ unit: 'tonne', quantity: 7 }, { unit: 'trip' })).toBeNull();
  });

  it('matches display units to market units, and never compares across dimensions', () => {
    expect(unitCode('m²')).toBe('m2');
    expect(unitCode('pieces')).toBe('piece');
    expect(unitCode('tonnes')).toBe('tonne');
    expect(unitsNeeded({ unit: 'm²', quantity: 147 }, { unit: 'm2' })).toEqual({ count: 147, unit: 'm2' });
    expect(unitsNeeded({ unit: 'piece', quantity: 3476 }, { unit: 'piece' })).toEqual({ count: 3476, unit: 'piece' });
    expect(unitsNeeded({ unit: 'm³', quantity: 2 }, { unit: 'bag', pack: { value: 50, unit: 'kg' } })).toBeNull();
    expect(unitsNeeded({ unit: 'piece', quantity: 0 }, { unit: 'piece' })).toBeNull();
  });

  it('the bill of materials says what each unit holds and which product it means', () => {
    const d = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { type: 'duplex', bedrooms: 4 }).designs[0]!;
    const bom = billOfMaterials(d);
    const by = (k: string) => bom.find((l) => l.key === k)!;
    expect(by('cement').shop.pack).toEqual({ value: 50, unit: 'kg' });
    expect(by('blocks-9in').shop.attrs).toEqual({ size: '9in' });
    expect(by('blocks-6in').shop.attrs).toEqual({ size: '6in' });
    expect(by('sharp-sand').shop.attrs).toEqual({ material: 'sharp-sand' });
    expect(by('granite').shop.attrs).toEqual({ material: 'granite-3-4' });
  });
});
