/**
 * Unit catalog and price comparison (spec §3.7, §8.5). Price sorting compares only comparable units; a declared
 * pack size (e.g. a 50 kg bag) lets a price be normalized to the category's base unit. Item-specific conversions
 * come from the listing itself, never from a global rule.
 */
export type Dimension = 'mass' | 'length' | 'area' | 'volume' | 'count' | 'time' | 'trip' | 'package' | 'job';

export interface UnitDef { code: string; label: string; plural: string; dimension: Dimension; toBase?: number }

export const UNITS: Record<string, UnitDef> = {
  kg: { code: 'kg', label: 'kg', plural: 'kg', dimension: 'mass', toBase: 1 },
  tonne: { code: 'tonne', label: 'tonne', plural: 'tonnes', dimension: 'mass', toBase: 1000 },
  m: { code: 'm', label: 'metre', plural: 'metres', dimension: 'length', toBase: 1 },
  m2: { code: 'm2', label: 'm²', plural: 'm²', dimension: 'area', toBase: 1 },
  m3: { code: 'm3', label: 'm³', plural: 'm³', dimension: 'volume', toBase: 1 },
  litre: { code: 'litre', label: 'litre', plural: 'litres', dimension: 'volume', toBase: 0.001 },
  piece: { code: 'piece', label: 'piece', plural: 'pieces', dimension: 'count', toBase: 1 },
  bag: { code: 'bag', label: 'bag', plural: 'bags', dimension: 'package' },
  bundle: { code: 'bundle', label: 'bundle', plural: 'bundles', dimension: 'package' },
  carton: { code: 'carton', label: 'carton', plural: 'cartons', dimension: 'package' },
  roll: { code: 'roll', label: 'roll', plural: 'rolls', dimension: 'package' },
  trip: { code: 'trip', label: 'trip', plural: 'trips', dimension: 'trip' },
  hour: { code: 'hour', label: 'hour', plural: 'hours', dimension: 'time', toBase: 1 },
  day: { code: 'day', label: 'day', plural: 'days', dimension: 'time', toBase: 8 },
  week: { code: 'week', label: 'week', plural: 'weeks', dimension: 'time', toBase: 40 },
  job: { code: 'job', label: 'job', plural: 'jobs', dimension: 'job' },
  engagement: { code: 'engagement', label: 'engagement', plural: 'engagements', dimension: 'job' },
};

export const isKnownUnit = (u: string) => Object.hasOwn(UNITS, u);
export const unitLabel = (u: string) => UNITS[u]?.label ?? u;

export interface PackSize { value: number; unit: string }

/**
 * The comparison key and per-base-unit price for a listing price.
 * - Same-dimension units with a base factor normalize directly (tonne → kg).
 * - Package units (bag, bundle…) normalize only through a declared pack size in a measurable unit.
 * - Otherwise the price is comparable only with listings in exactly the same unit.
 */
export function comparablePrice(priceMinor: bigint, unit: string, pack?: PackSize | null): { key: string; perBaseMinor: number | null; baseUnit: string } {
  const u = UNITS[unit];
  if (u?.toBase && u.dimension !== 'time') {
    const base = Object.values(UNITS).find((x) => x.dimension === u.dimension && x.toBase === 1)!;
    return { key: `dim:${u.dimension}`, perBaseMinor: Number(priceMinor) / u.toBase, baseUnit: base.code };
  }
  if (pack && pack.value > 0) {
    const pu = UNITS[pack.unit];
    if (pu?.toBase && pu.dimension !== 'time') {
      const base = Object.values(UNITS).find((x) => x.dimension === pu.dimension && x.toBase === 1)!;
      return { key: `dim:${pu.dimension}`, perBaseMinor: Number(priceMinor) / (pack.value * pu.toBase), baseUnit: base.code };
    }
  }
  return { key: `unit:${unit}`, perBaseMinor: null, baseUnit: unit };
}

/** Groups listings for price sorting so no "cheapest" claim is ever made across incomparable units. */
export function groupForPriceSort<T extends { priceMinor: bigint | null; unit: string; pack?: PackSize | null }>(items: T[], dir: 'asc' | 'desc'): { key: string; baseUnit: string; items: (T & { perBaseMinor: number | null })[] }[] {
  const groups = new Map<string, { key: string; baseUnit: string; items: (T & { perBaseMinor: number | null })[] }>();
  for (const it of items) {
    if (it.priceMinor == null) continue;
    const c = comparablePrice(it.priceMinor, it.unit, it.pack);
    const g = groups.get(c.key) ?? { key: c.key, baseUnit: c.baseUnit, items: [] };
    g.items.push({ ...it, perBaseMinor: c.perBaseMinor ?? Number(it.priceMinor) });
    groups.set(c.key, g);
  }
  const sorted = [...groups.values()].sort((a, b) => b.items.length - a.items.length);
  for (const g of sorted) g.items.sort((a, b) => (dir === 'asc' ? 1 : -1) * ((a.perBaseMinor ?? 0) - (b.perBaseMinor ?? 0)));
  return sorted;
}
