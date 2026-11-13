import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z, type ZodType } from 'zod';
import { uuidv7, type MarketPack } from '@bw/domain';
import type { Config } from '../config.js';
import { one, type Database, type Sql } from '../db/database.js';
import { ApiError, badRequest, forbidden, sha256, unauthorized, type MessageChannel, type Storage } from '../platform/platform.js';

export interface Services {
  config: Config;
  db: Database;
  pack: MarketPack;
  storage: Storage;
  sms: MessageChannel;
  email: MessageChannel;
}

export interface Actor { id: string; sessionId: string; isStaff: boolean; staffRole: string | null }
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
  handler: (ctx: Ctx<Infer<B>, Infer<Q>, Infer<P>> & { user: A extends 'public' ? Actor | null : Actor }) => Promise<unknown>;
}

export const registry: { method: string; url: string; auth: string }[] = [];

// ---------------------------------------------------------------- sessions
const SESSION_TTL_DAYS = 30;
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
  const row = await s.db.tx({ kind: 'system' }, (sql) => one<{ status: string; is_staff: boolean; staff_role: string | null; revoked_at: unknown }>(sql,
    `select u.status, u.is_staff, u.staff_role, se.revoked_at from users u join sessions se on se.user_id = u.id where u.id = $1 and se.id = $2`, [payload.sub, payload.sid]));
  // Revoked sessions, deleted and suspended accounts stop working immediately (sign-out-everywhere, §3.11).
  if (!row || row.revoked_at || row.status !== 'active') throw unauthorized();
  return { id: payload.sub!, sessionId: String(payload.sid), isStaff: row.is_staff, staffRole: row.staff_role };
}

/** The web server forwards the end user's IP and device id with a shared secret; anything else uses the socket. */
function clientOf(req: FastifyRequest, s: Services): Client {
  const trusted = req.headers['x-internal-secret'] === s.config.internalSecret;
  const fwdIp = req.headers['x-client-ip'];
  const dev = req.headers['x-device-id'];
  return {
    ip: trusted && typeof fwdIp === 'string' ? fwdIp : req.ip,
    deviceId: trusted && typeof dev === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(dev) ? dev : null,
  };
}

// ---------------------------------------------------------------- per-IP rate limit (in memory, per instance)
const windows = new Map<string, { start: number; n: number }>();
function rateLimited(keyName: string, limit: number): number {
  const now = Date.now();
  const w = windows.get(keyName);
  if (!w || now - w.start > 60_000) { windows.set(keyName, { start: now, n: 1 }); return 0; }
  w.n += 1;
  return w.n > limit ? Math.ceil((w.start + 60_000 - now) / 1000) : 0;
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
  registry.push({ method: def.method, url: def.url, auth: def.auth });
  app.route({
    method: def.method,
    url: def.url,
    handler: async (req, reply) => {
      const client = clientOf(req, s);
      const retry = rateLimited(`ip:${client.ip}`, s.config.rateLimit.perMinute);
      if (retry) { reply.header('retry-after', String(retry)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
      const user = await authenticate(req, s);
      if (def.auth !== 'public' && !user) throw unauthorized();
      if (def.auth === 'staff' && !user!.isStaff) throw forbidden();
      const params = parse(def.params as P, req.params, 'params');
      const query = parse(def.query as Q, req.query, 'query');
      const body = parse(def.body as B, req.body, 'body');
      const idem = req.headers['idempotency-key'];
      const idemKey = typeof idem === 'string' && idem.length >= 8 && idem.length <= 200 && user && def.method !== 'GET' ? idem : null;
      let status = def.successStatus ?? (def.method === 'POST' ? 201 : 200);
      const ctxKind = user ? ({ kind: 'user', userId: user.id } as const) : ({ kind: 'system' } as const);
      const out = await s.db.tx(ctxKind, async (sql) => {
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
      });
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
