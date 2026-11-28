import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP: HMAC-SHA1, 30-second steps, 6 digits), the second
 * factor for staff sessions (spec §19.1). Works with any authenticator app. Secrets are stored encrypted.
 */
export const TOTP_STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const c of clean) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error('Invalid base32');
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 as authenticator apps expect. */
export const newTotpSecret = () => base32Encode(randomBytes(20));

export const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1]! & 0x0f;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export const totp = (secret: string, ms = Date.now()) => hotp(secret, stepAt(ms));

/**
 * The step a code matches, allowing one step of clock drift either way, or null. Steps at or before `lastStep`
 * are refused, so an observed code cannot be replayed.
 */
export function verifyTotp(secret: string, code: string, lastStep = 0, ms = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = stepAt(ms);
  for (let d = -window; d <= window; d++) {
    const step = now + d;
    if (step <= lastStep) continue;
    const want = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(want, Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = 'BuildWise'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ---------------------------------------------------------------- secrets at rest (AES-256-GCM)
const keyOf = (appSecret: string) => createHash('sha256').update(`${appSecret}:staff-totp:v1`).digest();

export function sealSecret(appSecret: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(appSecret), iv);
  const enc = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
}

export function openSecret(appSecret: string, sealed: string): string {
  const [v, iv, tag, enc] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !enc) throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', keyOf(appSecret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

// ---------------------------------------------------------------- recovery codes
/** One-time recovery codes like `K7QD-M2XP`, shown once; only their hashes are stored. */
export function newRecoveryCodes(n: number): string[] {
  return Array.from({ length: n }, () => {
    const s = base32Encode(randomBytes(5)).slice(0, 8);
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const normaliseRecoveryCode = (code: string) => code.toUpperCase().replace(/[^A-Z2-7]/g, '');
export const recoveryCodeHash = (appSecret: string, code: string) => createHash('sha256').update(`${appSecret}:recovery:${normaliseRecoveryCode(code)}`).digest('hex');
