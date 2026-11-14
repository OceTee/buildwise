import { decFromNumber, formatDec, parseDec, pctOf, SCALE, divRound } from './decimal';

/**
 * Takeoff geometry (spec §11.2). Points are in PDF page units (points, 1/72 in) on an unrotated page.
 * A page must be calibrated before length, area or volume can be measured on it; the system never assumes
 * a PDF unit equals a real-world unit.
 */
export interface Pt { x: number; y: number }
export type MeasureKind = 'count' | 'linear' | 'perimeter' | 'area' | 'volume' | 'manual';

export interface Calibration {
  /** Real-world metres per PDF unit. */
  metresPerUnit: number;
  a: Pt; b: Pt; knownLength: string; knownUnit: 'm' | 'mm';
  check?: { a: Pt; b: Pt; knownLength: string; knownUnit: 'm' | 'mm'; deviationPct: number } | null;
}

const dist = (p: Pt, q: Pt) => Math.hypot(q.x - p.x, q.y - p.y);
const toMetres = (v: string, unit: 'm' | 'mm') => { const d = parseDec(v); if (d == null || d <= 0n) return null; return Number(d) / 1e6 / (unit === 'mm' ? 1000 : 1); };

export class TakeoffError extends Error { constructor(public code: string, message: string) { super(message); } }

/**
 * Builds a calibration from a known dimension. When a second known dimension is given, the two scales must
 * agree within the tolerance; otherwise the calibration is refused (scale mismatch).
 */
export function calibrate(input: { a: Pt; b: Pt; knownLength: string; knownUnit: 'm' | 'mm'; check?: { a: Pt; b: Pt; knownLength: string; knownUnit: 'm' | 'mm' } | null }, tolerancePct: number): Calibration {
  const len = dist(input.a, input.b);
  const real = toMetres(input.knownLength, input.knownUnit);
  if (!(len > 1) || real == null) throw new TakeoffError('INVALID_CALIBRATION', 'Draw a line along a dimension you know and enter its real length.');
  const metresPerUnit = real / len;
  let check: Calibration['check'] = null;
  if (input.check) {
    const l2 = dist(input.check.a, input.check.b);
    const r2 = toMetres(input.check.knownLength, input.check.knownUnit);
    if (!(l2 > 1) || r2 == null) throw new TakeoffError('INVALID_CALIBRATION', 'The check dimension is not valid.');
    const deviationPct = Math.abs((r2 / l2) / metresPerUnit - 1) * 100;
    if (deviationPct > tolerancePct) throw new TakeoffError('SCALE_MISMATCH', `The two known dimensions disagree by ${deviationPct.toFixed(1)}%. Check the page is to scale and the dimensions are right.`);
    check = { ...input.check, deviationPct: Math.round(deviationPct * 100) / 100 };
  }
  return { metresPerUnit, a: input.a, b: input.b, knownLength: input.knownLength, knownUnit: input.knownUnit, check };
}

export function polylineLength(pts: Pt[], closed = false): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1]!, pts[i]!);
  if (closed && pts.length > 2) s += dist(pts[pts.length - 1]!, pts[0]!);
  return s;
}

/** Shoelace area (absolute) of a simple polygon. */
export function polygonArea(pts: Pt[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) { const p = pts[i]!; const q = pts[(i + 1) % pts.length]!; s += p.x * q.y - q.x * p.y; }
  return Math.abs(s) / 2;
}

export interface MeasureInput {
  kind: MeasureKind;
  points?: Pt[];
  /** For count: number of markers (points length if omitted). */
  count?: number;
  /** For volume: depth/thickness in metres (decimal string). */
  depth?: string | null;
  /** For manual: the value and unit typed by the measurer with their formula. */
  manualValue?: string | null; manualUnit?: string | null; formula?: string | null;
}

export interface MeasureResult { value: bigint; unit: string; derivation: string }

/** Computes a measurement's normalized value (scaled decimal) and a human-readable derivation. */
export function measure(m: MeasureInput, cal: Calibration | null): MeasureResult {
  const pts = m.points ?? [];
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  switch (m.kind) {
    case 'count': {
      const n = m.count ?? pts.length;
      if (!(n >= 1)) throw new TakeoffError('INVALID_MEASUREMENT', 'Place at least one marker.');
      return { value: BigInt(n) * SCALE, unit: 'piece', derivation: `${n} counted` };
    }
    case 'manual': {
      const v = parseDec(m.manualValue ?? '');
      if (v == null || v < 0n || !m.manualUnit) throw new TakeoffError('INVALID_MEASUREMENT', 'Enter a value and unit.');
      if (!m.formula?.trim()) throw new TakeoffError('FORMULA_REQUIRED', 'Record how the value was worked out.');
      return { value: v, unit: m.manualUnit, derivation: `manual: ${m.formula.trim()}` };
    }
  }
  if (!cal) throw new TakeoffError('NOT_CALIBRATED', 'Calibrate this page before measuring lengths or areas.');
  if (m.kind === 'linear' || m.kind === 'perimeter') {
    if (pts.length < 2) throw new TakeoffError('INVALID_MEASUREMENT', 'Draw at least two points.');
    const len = polylineLength(pts, m.kind === 'perimeter') * cal.metresPerUnit;
    return { value: decFromNumber(len), unit: 'm', derivation: `${m.kind === 'perimeter' ? 'perimeter' : 'length'} of ${pts.length} points × scale = ${r3(len)} m` };
  }
  if (pts.length < 3) throw new TakeoffError('INVALID_MEASUREMENT', 'Draw at least three points.');
  const area = polygonArea(pts) * cal.metresPerUnit ** 2;
  if (m.kind === 'area') return { value: decFromNumber(area), unit: 'm2', derivation: `area of ${pts.length}-point outline × scale² = ${r3(area)} m²` };
  const depth = parseDec(m.depth ?? '');
  if (depth == null || depth <= 0n) throw new TakeoffError('INVALID_MEASUREMENT', 'Enter the depth or thickness in metres.');
  const vol = decFromNumber(area) * depth / SCALE;
  return { value: vol, unit: 'm3', derivation: `area ${r3(area)} m² × depth ${formatDec(depth)} m = ${formatDec(vol, 3)} m³` };
}

/** Gross, deductions and waste kept as separate components (§8.5); net is derived, never typed. */
export function netQuantity(gross: bigint, deductions: bigint, wastePct: number): { net: bigint; waste: bigint } {
  const base = gross - deductions;
  if (base < 0n) throw new TakeoffError('NEGATIVE_QUANTITY', 'Deductions are larger than the gross quantity.');
  const waste = pctOf(base, wastePct);
  return { net: base + waste, waste };
}

export const roundDec = (v: bigint, dp: number) => { const f = 10n ** BigInt(6 - dp); return divRound(v, f) * f; };
