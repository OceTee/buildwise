import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z, type ZodType } from 'zod';
import { uuidv7, type MarketPack, type StaffRole } from '@bw/domain';
import type { Config } from '../config.js';
import { one, type Database, type Sql } from '../db/database.js';
import { collectEvents } from '../platform/background.js';
import { ApiError, badRequest, forbidden, sha256, unauthorized, type MessageChannel, type Scanner, type Storage } from '../platform/platform.js';
import type { ArchitectProvider, BuilderProvider, PaymentProvider, RateLimiter } from '../platform/providers.js';
import type { BrainProvider } from '../platform/gemini.js';
import type { RenderProvider } from '../platform/render.js';
import type { DesignerProvider } from '../platform/designer.js';
import type { CheckerProvider, DreamProvider } from '../platform/dream.js';
import { currentContext, userHashOf, type ErrorTracker } from '../platform/observability.js';

export interface Services {
  config: Config;
  db: Database;
  pack: MarketPack;
  storage: Storage;
  sms: MessageChannel;
  email: MessageChannel;
  payments: PaymentProvider;
  limiter: RateLimiter;
  /** Malware scanning of uploaded documents (MALWARE_SCANNER). */
  scanner: Scanner;
  architect: ArchitectProvider;
  builder: BuilderProvider;
  /** The live brain behind the build assistant (Gemini), with BuildWise's local model as the fallback. */
  brain: BrainProvider;
  render: RenderProvider;
  designer: DesignerProvider;
  /** Error tracking (Sentry when SENTRY_DSN is set, otherwise nothing is sent). */
  errors: ErrorTracker;
  /** Dream renders (AI-painted impressions) and Claude checking them against the 3D model. */
  dream: DreamProvider;
  checker: CheckerProvider;
  /** Called with the ids of the outbox events a request wrote, once its transaction has committed (dispatches them). */
  afterCommit?: (eventIds: string[]) => void;
}

/**
 * The signed-in person. `isStaff` and `staffRole` hold only once the session has passed the staff second factor
 * (TOTP, §19.1); until then a staff member acts as an ordinary user and `staffPending` is set.
 */
export interface Actor { id: string; sessionId: string; isStaff: boolean; staffRole: string | null; staffPending?: boolean; mfaAt?: Date | null }
export interface Client { ip: string; deviceId: string | null }

type Infer<T> = T extends ZodType ? z.infer<T> : undefined;

export interface Ctx<B, Q, P> {
  sql: Sql;
  services: Services;
  user: Actor | null;
  client: Client;
  body: B; query: Q; params: P;
  req: FastifyRequest; reply: FastifyReply;
  status(code: number): void;
}

export interface RouteDef<B extends ZodType | undefined, Q extends ZodType | undefined, P extends ZodType | undefined, A extends 'public' | 'user' | 'staff'> {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: string;
  auth: A;
  body?: B; query?: Q; params?: P;
  successStatus?: number;
  /** Largest request body in bytes, when a route takes more than the 1 MiB default (e.g. an image as a data URL). */
  bodyLimit?: number;
  /** Run in system context: staff routes that span projects, and public routes that touch no user data (the assistant). */
  systemContext?: boolean;
  /** A tighter per-IP limit on top of the global one (scraping-prone pages such as search and listings). */
  rateLimit?: { bucket: string; perMinute: (c: Config) => number };
  /** Staff routes: the roles that may call it, from `STAFF_ACCESS` in `@bw/domain` (required with `auth: 'staff'`). */
  staffRoles?: readonly StaffRole[];
  handler: (ctx: Ctx<Infer<B>, Infer<Q>, Infer<P>> & { user: A extends 'public' ? Actor | null : Actor }) => Promise<unknown>;
}

export const registry: { method: string; url: string; auth: string }[] = [];

// ---------------------------------------------------------------- sessions
const SESSION_TTL_DAYS = 30;
/** A session nobody has used for this long stops working, even inside its 30-day lifetime. */
export const SESSION_IDLE_DAYS = 14;
const key = (s: Services) => new TextEncoder().encode(s.config.authSecret);

export async function issueSession(s: Services, userId: string, sessionId: string): Promise<string> {
  return new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId).setIssuer('bw-api').setAudience('bw')
    .setIssuedAt().setExpirationTime(`${SESSION_TTL_DAYS}d`).sign(key(s));
}

async function authenticate(req: FastifyRequest, s: Services): Promise<Actor | null> {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return null;
  let payload;
  try {
    ({ payload } = await jwtVerify(h.slice(7), key(s), { issuer: 'bw-api', audience: 'bw', algorithms: ['HS256'], requiredClaims: ['sub', 'exp'] }));
  } catch {
    throw unauthorized();
  }
  const row = await s.db.tx({ kind: 'system' }, async (sql) => {
    const r = await one<{ status: string; is_staff: boolean; staff_role: string | null; revoked_at: unknown; mfa_at: unknown; idle: boolean; stale: boolean }>(sql,
      `select u.status, u.is_staff, u.staff_role, se.revoked_at, se.mfa_at,
              se.last_seen_at < now() - make_interval(days => $3) as idle, se.last_seen_at < now() - interval '1 hour' as stale
         from users u join sessions se on se.user_id = u.id where u.id = $1 and se.id = $2`, [payload.sub, payload.sid, SESSION_IDLE_DAYS]);
    // Last use is recorded at most hourly, so a busy session does not write on every request.
    if (r && !r.revoked_at && !r.idle && r.stale) await sql.query(`update sessions set last_seen_at = now() where id = $1`, [payload.sid]);
    return r;
  });
  // Revoked sessions, deleted and suspended accounts stop working immediately (sign-out-everywhere, §3.11); idle ones expire.
  if (!row || row.revoked_at || row.idle || row.status !== 'active') throw unauthorized();
  const mfaAt = row.mfa_at ? new Date(String(row.mfa_at)) : null;
  const verified = staffSessionVerified(s, mfaAt);
  const staff = row.is_staff && verified;
  return { id: payload.sub!, sessionId: String(payload.sid), isStaff: staff, staffRole: staff ? row.staff_role : null, staffPending: row.is_staff && !verified, mfaAt };
}

/** A staff session counts as staff once its second factor was entered within the pack's window (or MFA is off in development). */
export function staffSessionVerified(s: Services, mfaAt: Date | null): boolean {
  if (s.config.staffMfa === 'off') return true;
  return !!mfaAt && Date.now() - mfaAt.getTime() < s.pack.privacy.staff.mfaSessionHours * 3_600_000;
}

/** Compares secrets without leaking, through timing, how much of a guess was right. */
export function secretEquals(given: unknown, expected: string): boolean {
  if (typeof given !== 'string' || !expected) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Where a request came from, for rate limits. The web server forwards the end user's IP and device id with a shared
 * secret. Anyone else gets the address the platform saw: on Vercel the edge's own `x-real-ip` /
 * `x-vercel-forwarded-for` (set by Vercel, not by the client), elsewhere the socket. A client-written
 * `x-forwarded-for` is never trusted, so nobody can pick their own rate-limit bucket.
 */
export function clientOf(req: FastifyRequest, s: Services): Client {
  const trusted = secretEquals(req.headers['x-internal-secret'], s.config.internalSecret);
  const fwdIp = req.headers['x-client-ip'];
  const dev = req.headers['x-device-id'];
  return {
    ip: trusted && typeof fwdIp === 'string' && fwdIp.length <= 64 ? fwdIp : platformIp(req),
    deviceId: trusted && typeof dev === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(dev) ? dev : null,
  };
}

/** The client address as the hosting platform saw it (never a header the client wrote). */
export function platformIp(req: FastifyRequest): string {
  if (process.env.VERCEL) {
    const h = req.headers['x-vercel-forwarded-for'] ?? req.headers['x-real-ip'];
    const v = (Array.isArray(h) ? h[0] : h)?.split(',')[0]?.trim();
    if (v) return v;
  }
  return req.ip;
}

function parse<T extends ZodType | undefined>(schema: T, value: unknown, where: string): Infer<T> {
  if (!schema) return undefined as Infer<T>;
  const r = schema.safeParse(value ?? (where === 'body' ? {} : value));
  if (!r.success) throw badRequest('VALIDATION_FAILED', `Check the ${where === 'body' ? 'form' : where}.`, r.error.issues.map((i) => ({ path: i.path.map(String).join('.') || where, message: i.message })));
  return r.data as Infer<T>;
}

export function route<B extends ZodType | undefined = undefined, Q extends ZodType | undefined = undefined, P extends ZodType | undefined = undefined, A extends 'public' | 'user' | 'staff' = 'public'>(
  app: FastifyInstance, s: Services, def: RouteDef<B, Q, P, A>,
) {
  if (def.auth === 'staff' && !def.staffRoles?.length) throw new Error(`Staff route ${def.method} ${def.url} must name its staffRoles`);
  registry.push({ method: def.method, url: def.url, auth: def.auth });
  app.route({
    method: def.method,
    url: def.url,
    ...(def.bodyLimit ? { bodyLimit: def.bodyLimit } : {}),
    handler: async (req, reply) => {
      const client = clientOf(req, s);
      const retry = await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute);
      const tight = !retry && def.rateLimit ? await s.limiter.hit(`${def.rateLimit.bucket}:${client.ip}`, def.rateLimit.perMinute(s.config)) : 0;
      if (retry || tight) { reply.header('retry-after', String(retry || tight)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
      // On public routes an expired or revoked token just means "signed out"; elsewhere it is a 401.
      const user = await authenticate(req, s).catch((e) => { if (def.auth === 'public') return null; throw e; });
      if (user) {
        // Logs and error reports name the user by a keyed hash only.
        (req as { bwUserId?: string }).bwUserId = user.id;
        const c = currentContext();
        if (c) c.userHash = userHashOf(s.config.authSecret, user.id);
      }
      if (def.auth !== 'public' && !user) throw unauthorized();
      if (def.auth === 'staff') {
        if (!user!.isStaff && user!.staffPending) throw new ApiError(403, 'MFA_REQUIRED', 'Enter the code from your authenticator app to use staff tools.');
        if (!user!.isStaff) throw forbidden();
        if (!def.staffRoles!.includes(user!.staffRole as StaffRole)) throw forbidden('Your staff role cannot do this.');
      }
      const params = parse(def.params as P, req.params, 'params');
      const query = parse(def.query as Q, req.query, 'query');
      const body = parse(def.body as B, req.body, 'body');
      const idem = req.headers['idempotency-key'];
      const idemKey = typeof idem === 'string' && idem.length >= 8 && idem.length <= 200 && user && def.method !== 'GET' ? idem : null;
      let status = def.successStatus ?? (def.method === 'POST' ? 201 : 200);
      if (def.systemContext && def.auth === 'user') throw new Error(`systemContext is not allowed on user routes (${def.url})`);
      const ctxKind = user && !def.systemContext ? ({ kind: 'user', userId: user.id, staff: user.isStaff } as const) : ({ kind: 'system' } as const);
      const tx = collectEvents(() => s.db.tx(ctxKind, async (sql) => {
        if (idemKey) {
          const prior = await one<{ request_hash: string; status: number; body: unknown }>(sql, `select request_hash, status, body from idempotency_keys where user_id = $1 and key = $2 and route = $3`, [user!.id, idemKey, `${def.method} ${def.url}`]);
          if (prior) {
            if (prior.request_hash !== sha256(JSON.stringify({ params, body }))) throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different request.');
            status = prior.status;
            reply.header('idempotent-replayed', 'true');
            return prior.body;
          }
        }
        const result = await def.handler({ sql, services: s, user: user as any, client, body, query, params, req, reply, status: (c) => { status = c; } });
        if (idemKey && !(result && typeof result === 'object' && '__raw' in result)) {
          await sql.query(`insert into idempotency_keys (user_id, key, route, request_hash, status, body) values ($1, $2, $3, $4, $5, $6::jsonb)`,
            [user!.id, idemKey, `${def.method} ${def.url}`, sha256(JSON.stringify({ params, body })), status, JSON.stringify(result ?? null)]);
        }
        return result;
      }));
      const out = await tx.run;
      // Committed: send this request's events now rather than at the next scheduled run.
      if (tx.events.length) s.afterCommit?.(tx.events);
      reply.code(status);
      if (out && typeof out === 'object' && '__raw' in out) {
        const raw = (out as { __raw: { contentType: string; body: string | Buffer | NodeJS.ReadableStream; cache?: string } }).__raw;
        reply.header('content-type', raw.contentType);
        reply.header('cache-control', raw.cache ?? 'private, no-store');
        return reply.send(raw.body);
      }
      return status === 204 ? reply.send() : reply.send(out ?? null);
    },
  });
}

export function errorEnvelope(err: ApiError, correlationId: string) {
  return { error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}), ...(err.fieldErrors ? { fieldErrors: err.fieldErrors } : {}), correlationId } };
}

export const newCorrelationId = () => uuidv7();
