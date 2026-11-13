import { createHash, createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import sharp from 'sharp';
import { uuidv7 } from '@bw/domain';
import { one, type Sql } from '../db/database.js';

// ---------------------------------------------------------------- errors (spec §15.3 envelope)
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: Record<string, unknown>, public fieldErrors?: { path: string; message: string }[]) {
    super(message);
  }
}
export const notFound = (what = 'Resource') => new ApiError(404, 'NOT_FOUND', `${what} not found.`);
export const forbidden = (m = 'You do not have permission for this action.') => new ApiError(403, 'FORBIDDEN', m);
export const unauthorized = () => new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
export const badRequest = (code: string, m: string, fieldErrors?: { path: string; message: string }[]) => new ApiError(400, code, m, undefined, fieldErrors);
export const conflict = (code: string, m: string, details?: Record<string, unknown>) => new ApiError(409, code, m, details);
export const unprocessable = (code: string, m: string, details?: Record<string, unknown>) => new ApiError(422, code, m, details);
export const tooMany = (m: string, retryAfter: number) => new ApiError(429, 'RATE_LIMITED', m, { retryAfter });

export const sha256 = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

// ---------------------------------------------------------------- audit (append-only, hash-chained, §20.4)
export async function audit(sql: Sql, e: { actorUserId: string | null; action: string; targetType: string; targetId: string; reason?: string | null; metadata?: Record<string, unknown> }) {
  // Serialise writers so the chain never forks; the app role may append but not update audit rows, so a
  // transaction-scoped advisory lock is used instead of a row lock.
  await sql.query(`select pg_advisory_xact_lock(727274)`);
  const prev = await one<{ hash: string }>(sql, `select hash from audit_events order by seq desc limit 1`);
  const id = uuidv7();
  const body = JSON.stringify({ id, ...e, at: new Date().toISOString() });
  const prevHash = prev?.hash ?? 'genesis';
  await sql.query(
    `insert into audit_events (id, actor_user_id, action, target_type, target_id, reason, metadata, prev_hash, hash) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
    [id, e.actorUserId, e.action, e.targetType, e.targetId, e.reason ?? null, JSON.stringify(e.metadata ?? {}), prevHash, sha256(prevHash + body)],
  );
}

// ---------------------------------------------------------------- outbox (facts, written in the business transaction)
export type EventType =
  | 'PhoneVerified' | 'ListingSubmitted' | 'ListingPublished' | 'ListingRejected' | 'ListingExpired' | 'ListingClosed' | 'ListingBlocked'
  | 'ListingReported' | 'ContactRevealed' | 'QuoteRequested' | 'QuoteRequestAnswered' | 'MessageSent' | 'SellerReviewPublished'
  | 'PromotionPurchased' | 'PromotionActivated' | 'PromotionPaused' | 'PromotionExpired' | 'SellerRestricted' | 'SellerRestrictionLifted'
  | 'AppealDecided' | 'SavedSearchMatched';

export async function publish(sql: Sql, type: EventType, payload: Record<string, unknown>) {
  await sql.query(`insert into outbox (event_id, event_type, payload) values ($1, $2, $3::jsonb)`, [uuidv7(), type, JSON.stringify(payload)]);
}

export async function notify(sql: Sql, userIds: (string | null | undefined)[], n: { kind: string; title: string; body: string; link?: string | null }) {
  for (const u of new Set(userIds.filter(Boolean) as string[])) {
    await sql.query(`insert into notifications (id, user_id, kind, title, body, link) values ($1, $2, $3, $4, $5, $6)`, [uuidv7(), u, n.kind, n.title, n.body, n.link ?? null]);
  }
}

// ---------------------------------------------------------------- object storage (local adapter; S3-compatible in production)
export interface Storage {
  put(key: string, data: Buffer): void;
  path(key: string): string | null;
  stream(key: string): NodeJS.ReadableStream;
}

export function createLocalStorage(dir: string): Storage {
  const safe = (key: string) => {
    const p = resolve(dir, key);
    if (!p.startsWith(resolve(dir))) throw new Error('Invalid storage key');
    return p;
  };
  return {
    put(key, data) { const p = safe(key); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, data); },
    path(key) { const p = safe(key); return existsSync(p) ? p : null; },
    stream(key) { return createReadStream(safe(key)); },
  };
}

// ---------------------------------------------------------------- photo pipeline (§3.16)
export const PHOTO_SIZES = { thumb: 320, card: 640, full: 1280 } as const;
export type PhotoSize = keyof typeof PHOTO_SIZES;
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

export class PhotoError extends Error {}

/**
 * Decodes the upload (rejecting anything that isn't a real image), strips EXIF/GPS and device metadata by
 * re-encoding, produces WebP sizes and a 64-bit difference hash for reused-photo detection.
 */
export async function processPhoto(input: Buffer): Promise<{ sizes: Record<PhotoSize, Buffer>; width: number; height: number; dhash: string }> {
  if (input.length > MAX_PHOTO_BYTES) throw new PhotoError('Photos must be 10 MB or smaller.');
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw new PhotoError('That file is not a supported image (JPEG, PNG, WebP or HEIC).');
  }
  if (!meta.width || !meta.height || !['jpeg', 'png', 'webp', 'heif', 'avif'].includes(meta.format ?? '')) throw new PhotoError('That file is not a supported image (JPEG, PNG, WebP or HEIC).');
  if (meta.width < 200 || meta.height < 200) throw new PhotoError('Photos must be at least 200 × 200 pixels.');
  const base = sharp(input).rotate(); // apply orientation, then metadata is dropped on re-encode
  const sizes = {} as Record<PhotoSize, Buffer>;
  for (const [name, w] of Object.entries(PHOTO_SIZES) as [PhotoSize, number][]) {
    sizes[name] = await base.clone().resize({ width: w, height: w, fit: 'inside', withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  }
  const px = await sharp(input).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (px[y * 9 + x]! > px[y * 9 + x + 1]! ? 1n : 0n);
  return { sizes, width: meta.width, height: meta.height, dhash: bits.toString(16).padStart(16, '0') };
}

// ---------------------------------------------------------------- SMS / email adapter (dev writes to a file)
export interface MessageChannel { send(to: string, text: string, kind: 'otp' | 'notification'): Promise<void> }

export function createFileChannel(outboxDir: string, name: 'sms' | 'email'): MessageChannel {
  return {
    async send(to, text, kind) {
      mkdirSync(outboxDir, { recursive: true });
      appendFileSync(join(outboxDir, `${name}.jsonl`), JSON.stringify({ at: new Date().toISOString(), to, kind, text }) + '\n');
    },
  };
}

export const newOtp = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

// ---------------------------------------------------------------- hosted checkout adapter (dev provider)
/**
 * Promotion purchases go through a provider's hosted checkout (§3.13). The dev adapter simulates the provider:
 * the web shows a test checkout page and the "provider" calls our webhook with an HMAC signature.
 * A real provider adapter implements the same two functions.
 */
export function signWebhook(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
}

export function verifyWebhook(secret: string, header: string | undefined, rawBody: string, toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const ts = Number(parts.t);
  if (!ts || Math.abs(Date.now() / 1000 - ts) > toleranceSec || !parts.v1) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex'));
  const got = Buffer.from(parts.v1);
  return expected.length === got.length && timingSafeEqual(expected, got);
}
