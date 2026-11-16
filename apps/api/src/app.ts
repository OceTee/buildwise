import Fastify, { type FastifyInstance } from 'fastify';
import { getMarket } from '@bw/domain';
import { loadConfig, type Config } from './config.js';
import { createPgDatabase, createPgliteDatabase, migrate, one, type Database } from './db/database.js';
import { errorEnvelope, newCorrelationId, type Services } from './http/route.js';
import { registerBuild } from './modules/build.js';
import { registerContact } from './modules/contact.js';
import { drainBackground, registerDocuments } from './modules/documents.js';
import { registerEstimates } from './modules/estimates.js';
import { registerProjects } from './modules/projects.js';
import { registerIdentity } from './modules/identity.js';
import { registerListings } from './modules/listings.js';
import { registerModeration } from './modules/moderation.js';
import { registerPromotions } from './modules/promotions.js';
import { ApiError, MAX_PHOTO_BYTES, createBlobStorage, createFileChannel, createLocalStorage, createLogChannel } from './platform/platform.js';
import { createDevPayments, createMemoryLimiter, createPaystack, createPostgresLimiter, createResendEmail, createTermiiSms, createTwilioSms } from './platform/providers.js';
import { runWorkerCycle } from './worker.js';

/** Category configuration comes from the market pack; a category that is missing is created at version 1. */
export async function syncCategories(db: Database, s: Pick<Services, 'pack'>) {
  await db.tx({ kind: 'system' }, async (sql) => {
    const ordered = [...s.pack.categories].sort((a, b) => Number(!!a.parent) - Number(!!b.parent));
    for (const [i, c] of ordered.entries()) {
      if (await one(sql, `select 1 from categories where slug = $1`, [c.slug])) continue;
      await sql.query(`insert into categories (slug, parent_slug, name, current_version, sort) values ($1, $2, $3, 1, $4)`, [c.slug, c.parent ?? null, c.name, i]);
      await sql.query(`insert into category_versions (slug, version, definition) values ($1, 1, $2::jsonb)`, [c.slug, JSON.stringify(c)]);
    }
  });
}

function smsChannel(config: Config) {
  const p = config.providers.sms;
  if (p.kind === 'twilio') return createTwilioSms(p);
  if (p.kind === 'termii') return createTermiiSms(p);
  return config.messages === 'log' ? createLogChannel('sms') : createFileChannel(config.outboxDir, 'sms');
}

export async function buildApp(overrides: Partial<Config> = {}): Promise<{ app: FastifyInstance; services: Services }> {
  const config = loadConfig(overrides);
  const db = config.databaseUrl ? await createPgDatabase(config.databaseUrl) : await createPgliteDatabase(config.pgliteDir);
  await migrate(db);
  const services: Services = {
    config, db, pack: getMarket(config.marketId),
    storage: config.storage === 'blob' ? await createBlobStorage() : createLocalStorage(config.storageDir),
    sms: smsChannel(config),
    email: config.providers.email.kind === 'resend' ? createResendEmail(config.providers.email)
      : config.messages === 'log' ? createLogChannel('email') : createFileChannel(config.outboxDir, 'email'),
    payments: config.providers.payments.kind === 'paystack' ? createPaystack(config.providers.payments) : createDevPayments(config.publicWebUrl),
    limiter: config.rateLimitStore === 'postgres' ? createPostgresLimiter(db) : createMemoryLimiter(),
  };
  await syncCategories(db, services);

  const app = Fastify({
    logger: config.env === 'test' ? false : { level: config.env === 'production' ? 'info' : 'warn', redact: ['req.headers.authorization', 'req.headers["x-internal-secret"]'] },
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    genReqId: () => newCorrelationId(),
    routerOptions: { maxParamLength: 2048 }, // signed file tokens travel in the path
  });

  // Money and quantities are bigint in the domain; they leave the API as strings, never as lossy numbers.
  app.setReplySerializer((payload) => JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));

  // JSON keeps its raw text so webhook signatures can be checked over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    if (!body) return done(null, {});
    try { done(null, JSON.parse(body as string)); } catch { done(new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON.'), undefined); }
  });
  app.addContentTypeParser(/^image\/.+/, { parseAs: 'buffer', bodyLimit: MAX_PHOTO_BYTES + 2 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  // Document uploads (any type; the real type is sniffed from the bytes). Size limits are set per route.
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    reply.header('x-correlation-id', req.id);
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'private, no-store');
    return payload;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(errorEnvelope(err, req.id));
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send(errorEnvelope(new ApiError(413, 'TOO_LARGE', 'The upload is too large.'), req.id));
    if (e.statusCode === 415 || e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(415).send(errorEnvelope(new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Unsupported content type.'), req.id));
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send(errorEnvelope(new ApiError(e.statusCode, 'BAD_REQUEST', 'The request could not be processed.'), req.id));
    req.log.error({ err }, 'unhandled error');
    if (config.env === 'test') console.error(err);
    return reply.code(500).send(errorEnvelope(new ApiError(500, 'INTERNAL', 'Something went wrong. Try again.'), req.id));
  });
  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorEnvelope(new ApiError(404, 'NOT_FOUND', 'Not found.'), req.id)));

  app.get('/health', async () => ({ ok: true, market: services.pack.id, db: db.driver, env: config.env, storage: config.storage,
    ai: !!config.anthropicApiKey, providers: { sms: config.providers.sms.kind, email: config.providers.email.kind, payments: config.providers.payments.kind }, rateLimit: config.rateLimitStore }));

  // Scheduled background work on serverless hosts (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
  app.get('/v1/internal/cron', async (req, reply) => {
    const secret = process.env.CRON_SECRET;
    if (!secret || req.headers.authorization !== `Bearer ${secret}`) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Not allowed.' } });
    return runWorkerCycle(services);
  });

  registerIdentity(app, services);
  registerListings(app, services);
  registerContact(app, services);
  registerModeration(app, services);
  registerPromotions(app, services);
  registerProjects(app, services);
  registerDocuments(app, services);
  registerEstimates(app, services);
  registerBuild(app, services);

  app.addHook('onClose', async () => { await drainBackground(); await db.close(); });
  return { app, services };
}
