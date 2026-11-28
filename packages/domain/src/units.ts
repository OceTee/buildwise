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
  set: { code: 'set', label: 'set', plural: 'sets', dimension: 'package' },
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

/** A display or market unit in its market code: plurals, `²`/`³` and case normalised ("bags" → bag, "m²" → m2). */
export function unitCode(u: string): string {
  const n = u.trim().toLowerCase().replace('²', '2').replace('³', '3');
  if (Object.hasOwn(UNITS, n)) return n;
  const single = n.replace(/es$/, '').replace(/s$/, '');
  if (Object.hasOwn(UNITS, single)) return single;
  return Object.values(UNITS).find((x) => x.plural === n || x.label === n)?.code ?? n;
}

/** How much of one dimension a quantity is, in that dimension's base unit; a pack gives packaged units a size. */
function measure(unit: string, amount: number, pack?: PackSize | null): { key: string; base: number } {
  const u = UNITS[unitCode(unit)];
  if (u?.toBase && u.dimension !== 'time') return { key: `dim:${u.dimension}`, base: amount * u.toBase };
  const pu = pack && pack.value > 0 ? UNITS[unitCode(pack.unit)] : undefined;
  if (pu?.toBase && pu.dimension !== 'time') return { key: `dim:${pu.dimension}`, base: amount * pack!.value * pu.toBase };
  return { key: `unit:${unitCode(unit)}`, base: amount };
}

/**
 * How many of a listing's units a bill-of-materials line needs, or null when the two cannot be compared. Units are
 * compared by what they hold, not by name: 607 bags of 50 kg cement need 1,214 bags of 25 kg (never 607), 68.5 tonnes
 * of sand need 4 trips of a 20 tonne tipper, and a line in tonnes priced per kilogram converts. Packaged offers (bags,
 * trips, pieces) are bought whole; a listing priced per kg, tonne, m² or m³ can be bought in parts.
 */
export function unitsNeeded(line: { unit: string; quantity: number; pack?: PackSize | null }, offer: { unit: string; pack?: PackSize | null }): { count: number; unit: string } | null {
  if (!(line.quantity > 0)) return null;
  // A line that does not say what its unit holds buys the same unit by name, as it always did.
  if (!line.pack && unitCode(line.unit) === unitCode(offer.unit)) return { count: Math.ceil(line.quantity - 1e-9), unit: unitCode(offer.unit) };
  const need = measure(line.unit, line.quantity, line.pack);
  const each = measure(offer.unit, 1, offer.pack);
  if (need.key !== each.key || !(each.base > 0)) return null;
  const raw = need.base / each.base;
  const ou = UNITS[unitCode(offer.unit)];
  const divisible = !!ou?.toBase && ou.dimension !== 'count' && ou.dimension !== 'time';
  return { count: divisible ? Math.ceil(raw * 100 - 1e-9) / 100 : Math.ceil(raw - 1e-9), unit: unitCode(offer.unit) };
}
