/**
 * Core primitives: time-ordered IDs, money in minor units, a small state-machine helper and slugs.
 */

// ---------- IDs ----------
function rand(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** UUIDv7: time-ordered, safe to generate on clients (spec §8.6). */
export function uuidv7(now: number = Date.now()): string {
  const bytes = rand(16);
  const ts = BigInt(now);
  for (let i = 0; i < 6; i++) bytes[i] = Number((ts >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const h = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// ---------- Money (integer minor units; never floating point, §8.4) ----------
export interface Money { amountMinor: string; currency: string }

const MINOR_DIGITS: Record<string, number> = { NGN: 2, KES: 2, GHS: 2, USD: 2, EUR: 2, GBP: 2, XOF: 0, JPY: 0 };
export const minorDigits = (currency: string) => MINOR_DIGITS[currency] ?? 2;

/** Parses a major-unit decimal string ("9500", "9,500.50") into minor units. Returns null if invalid. */
export function parseMajor(input: string, currency: string): bigint | null {
  const s = input.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const d = minorDigits(currency);
  const [whole, frac = ''] = s.split('.');
  if (frac.length > d) return null;
  return BigInt(whole!) * 10n ** BigInt(d) + BigInt((frac + '0'.repeat(d)).slice(0, d) || '0');
}

export function formatMoney(m: Money, locale = 'en', opts: { compact?: boolean } = {}): string {
  const d = minorDigits(m.currency);
  const v = Number(BigInt(m.amountMinor)) / 10 ** d;
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency: m.currency, notation: opts.compact ? 'compact' : 'standard',
    maximumFractionDigits: opts.compact ? 1 : v % 1 === 0 ? 0 : d,
  }).format(v);
}

// ---------- State machines ----------
export class InvalidTransitionError extends Error {
  constructor(public readonly machine: string, public readonly state: string, public readonly command: string) {
    super(`${machine}: "${command}" is not allowed from "${state}"`);
  }
}

export interface Transition<S extends string, C extends string> { command: C; from: readonly S[]; to: S }

export interface StateMachine<S extends string, C extends string> {
  readonly name: string;
  readonly states: readonly S[];
  can(state: S, command: C): boolean;
  next(state: S, command: C): S;
  commandsFrom(state: S): C[];
}

export function defineMachine<S extends string, C extends string>(name: string, states: readonly S[], transitions: readonly Transition<S, C>[]): StateMachine<S, C> {
  const find = (s: S, c: C) => transitions.find((t) => t.command === c && t.from.includes(s));
  return {
    name, states,
    can: (s, c) => !!find(s, c),
    next(s, c) {
      const t = find(s, c);
      if (!t) throw new InvalidTransitionError(name, s, c);
      return t.to;
    },
    commandsFrom: (s) => [...new Set(transitions.filter((t) => t.from.includes(s)).map((t) => t.command))],
  };
}

// ---------- Slugs ----------
export function slugify(s: string, max = 70): string {
  return s
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, max).replace(/-+$/g, '') || 'item';
}

/** Listing URL path: /listing/{slug}-{shortId}; the id part is authoritative (old slugs 301 to current). */
export function listingPath(title: string, id: string): string {
  return `/listing/${slugify(title)}-${id.replace(/-/g, '').slice(-12)}`;
}

export function shortIdFromPath(slugAndId: string): string | null {
  const m = /-([0-9a-f]{12})$/i.exec(slugAndId);
  return m ? m[1]!.toLowerCase() : null;
}
