/**
 * Fixed-point decimals for quantities and rates (spec §8.4–8.5). Quantities are NUMERIC(18,6): held here as
 * bigint scaled by 10^6, never as binary floating point. Money stays in integer minor units.
 */
export const SCALE = 1_000_000n;
const DP = 6;

/** Parses "12", "12.5", "-0.25", "1,250.75" into a scaled bigint; null if invalid or more than 6 decimals. */
export function parseDec(input: string | number | bigint): bigint | null {
  if (typeof input === 'bigint') return input * SCALE;
  const s = String(input).replace(/[,\s]/g, '');
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = m[3] ?? '';
  if (frac.length > DP) return null;
  const v = BigInt(m[2]!) * SCALE + BigInt((frac + '0'.repeat(DP)).slice(0, DP) || '0');
  return m[1] ? -v : v;
}

/** Scaled bigint → canonical decimal string without trailing zeros ("12.5", "3"). */
export function formatDec(v: bigint, maxDp = DP): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / SCALE;
  let frac = String(a % SCALE).padStart(DP, '0').slice(0, maxDp).replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** Round half away from zero of n / d, both bigint. */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError('division by zero');
  const neg = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  const q = (an * 2n + ad) / (ad * 2n);
  return neg ? -q : q;
}

/** a × b for two scaled decimals, result scaled. */
export const mulDec = (a: bigint, b: bigint) => divRound(a * b, SCALE);

/** Scaled decimal × percentage (a plain number with up to 4 dp), result scaled. */
export function pctOf(v: bigint, pct: number): bigint {
  const p = BigInt(Math.round(pct * 10_000));
  return divRound(v * p, 1_000_000n);
}

/** Number → scaled decimal (for geometry results computed in floating point and then fixed). */
export const decFromNumber = (n: number) => BigInt(Math.round(n * 1_000_000));
export const decToNumber = (v: bigint) => Number(v) / 1_000_000;
