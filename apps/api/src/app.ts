import Fastify, { LogController, type FastifyInstance } from 'fastify';
import { getMarket } from '@bw/domain';
import { loadConfig, paidAiJobs, type Config } from './config.js';
import { createPgDatabase, createPgliteDatabase, migrate, one, type Database } from './db/database.js';
import { errorEnvelope, newCorrelationId, platformIp, secretEquals, type Services } from './http/route.js';
import { redactUrl } from './platform/log-redact.js';
import { registerBuild } from './modules/build.js';
import { registerContact } from './modules/contact.js';
import { registerDocuments } from './modules/documents.js';
import { drainBackground, inBackground } from './platform/background.js';
import { registerNotifications } from './modules/notifications.js';
import { registerPrivacy } from './modules/privacy.js';
import { registerStaff } from './modules/staff.js';
import { registerEstimates } from './modules/estimates.js';
import { registerProjects } from './modules/projects.js';
import { registerProcurement } from './modules/procurement.js';
import { registerFulfilment } from './modules/fulfilment.js';
import { registerCases } from './modules/cases.js';
import { registerTenders } from './modules/tenders.js';
import { registerContracts } from './modules/contracts.js';
import { registerSupplierLists } from './modules/supplier-lists.js';
import { registerOrderFiles } from './modules/order-files.js';
import { registerTransactionReviews } from './modules/transaction-reviews.js';
import { registerLiquidity } from './modules/liquidity.js';
import { registerFeedback } from './modules/feedback.js';
import { registerPolicies } from './modules/policies.js';
import { registerIdentity } from './modules/identity.js';
import { registerListings } from './modules/listings.js';
import { registerModeration } from './modules/moderation.js';
import { registerPromotions } from './modules/promotions.js';
import { registerStudio } from './modules/studio.js';
import { ApiError, MAX_PHOTO_BYTES, createBlobStorage, createFileChannel, createLocalStorage, createLogChannel } from './platform/platform.js';
import { createClaudeArchitect, createClaudeBuilder, createDevPayments, createScanner, noBuilder, createMemoryLimiter, noArchitect, createPaystack, createPostgresLimiter, createResendEmail, createTermiiSms, createTwilioSms } from './platform/providers.js';
import { createOpenAiRender, noRender } from './platform/render.js';
import { registerRender } from './modules/render.js';
import { createClaudeChecker, createGeminiDream, createOpenAiDream, noChecker, noDream } from './platform/dream.js';
import { registerDream } from './modules/dream.js';
import { chainDesigners, createClaudeDesigner, createGeminiDesigner, noDesigner, type DesignerProvider } from './platform/designer.js';
import { createGeminiArchitect, createGeminiBrain, createGeminiBuilder, noBrain } from './platform/gemini.js';
import { BRAIN_SYSTEM_PROMPT } from './ai/brain-prompt.js';
import type { DesignerSpec } from './config.js';
import { registerAiDesign, registerCritique } from './modules/ai-design.js';
import { catchUpAfterRequests, dispatchEvents, runWorkerCycle } from './worker.js';
import { createSentryTracker, noTracker, runWithContext, userHashOf, type ErrorTracker } from './platform/observability.js';
import { registerOps } from './modules/ops.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** The design tool's POSTs compute designs and replies (they write only caches and anonymous assistant rows), so it keeps working in maintenance. */
const MAINTENANCE_EXEMPT = /^\/v1\/build\//;

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
  const errors: ErrorTracker = config.errorTracking.kind === 'sentry' ? await createSentryTracker(config.errorTracking) : noTracker;
  const db = config.databaseUrl ? await createPgDatabase(config.databaseUrl) : await createPgliteDatabase(config.pgliteDir);
  await migrate(db);
  const services: Services = {
    config, db, errors, pack: getMarket(config.marketId),
    storage: config.storage === 'blob' ? await createBlobStorage() : createLocalStorage(config.storageDir),
    sms: smsChannel(config),
    email: config.providers.email.kind === 'resend' ? createResendEmail(config.providers.email)
      : config.messages === 'log' ? createLogChannel('email') : createFileChannel(config.outboxDir, 'email'),
    payments: config.providers.payments.kind === 'paystack' ? createPaystack(config.providers.payments) : createDevPayments(config.publicWebUrl),
    limiter: config.rateLimitStore === 'postgres' ? createPostgresLimiter(db) : createMemoryLimiter(),
    scanner: createScanner(config.malwareScanner),
    architect: config.providers.architect.kind === 'anthropic' ? await createClaudeArchitect(config.providers.architect)
      : config.providers.architect.kind === 'gemini' ? createGeminiArchitect(config.providers.architect) : noArchitect,
    builder: config.providers.builder.kind === 'anthropic' ? await createClaudeBuilder(config.providers.builder)
      : config.providers.builder.kind === 'gemini' ? createGeminiBuilder(config.providers.builder) : noBuilder,
    brain: config.providers.brain?.kind === 'gemini' ? createGeminiBrain(config.providers.brain, BRAIN_SYSTEM_PROMPT) : noBrain,
    render: config.providers.render.kind === 'openai' ? createOpenAiRender(config.providers.render) : noRender,
    designer: withCritique(await designerFor(config.providers.designer), config.providers.critique),
    dream: config.providers.dream?.kind === 'gemini' ? createGeminiDream(config.providers.dream) : config.providers.dream?.kind === 'openai' ? createOpenAiDream(config.providers.dream) : noDream,
    // Claude checks dream renders only when both are connected (it reuses the AI architect's key and model).
    checker: (config.providers.dream?.kind ?? 'none') !== 'none' && config.providers.architect.kind === 'anthropic' ? await createClaudeChecker({ apiKey: config.providers.architect.apiKey, model: config.providers.architect.model }) : noChecker,
  };
  await syncCategories(db, services);
  // A request's events go out as soon as its transaction commits; the scheduled worker is the safety net.
  if (config.dispatchAfterCommit) services.afterCommit = (ids) => inBackground(() => dispatchEvents(services, ids));

  const app = Fastify({
    logger: config.env === 'test' ? false : {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers["x-internal-secret"]', 'req.headers.cookie'],
      // Signed links, checkout references, phone numbers and emails never reach the logs (§19).
      serializers: {
        req: (req: { method: string; url: string; id?: string }) => ({ method: req.method, url: redactUrl(req.url), id: req.id }),
      },
    },
    // One structured line per request is written in onResponse below (route template, never the raw URL).
    logController: new LogController({ disableRequestLogging: true }),
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

  // Maintenance mode: writes stop with a clear 503 before any body is read; reads keep working.
  app.addHook('onRequest', async (req, reply) => {
    if (!config.maintenance.on || !WRITE_METHODS.has(req.method) || MAINTENANCE_EXEMPT.test(req.url)) return;
    reply.header('retry-after', '300');
    return reply.code(503).send(errorEnvelope(new ApiError(503, 'MAINTENANCE', config.maintenance.message), req.id));
  });

  // The request context carries the correlation id into outbox events, provider logs and error reports.
  // preHandler runs after the body is parsed, so the handler's whole async chain sees it.
  app.addHook('preHandler', (req, _reply, done) => {
    runWithContext({ correlationId: req.id, route: req.routeOptions.url ?? undefined }, done);
  });

  app.addHook('onResponse', async (req, reply) => {
    const u = (req as { bwUserId?: string }).bwUserId;
    const fields = { correlationId: req.id, method: req.method, route: req.routeOptions.url ?? null, status: reply.statusCode, durationMs: Math.round(reply.elapsedTime), ...(u ? { userHash: userHashOf(config.authSecret, u) } : {}) };
    if (reply.statusCode >= 500) req.log.error(fields, 'request failed');
    else req.log.info(fields, 'request');
  });

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'strict-origin-when-cross-origin');
    // The API answers JSON and files, never pages: nothing it serves may run scripts or be framed.
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; sandbox");
    reply.header('cross-origin-resource-policy', 'same-site');
    if (config.env === 'staging' || config.env === 'production') reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
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
    const u = (req as { bwUserId?: string }).bwUserId;
    const userHash = u ? userHashOf(config.authSecret, u) : null;
    req.log.error({ err, correlationId: req.id, route: req.routeOptions.url ?? null, userHash }, 'unhandled error');
    services.errors.capture(err, { correlationId: req.id, route: req.routeOptions.url ?? null, userHash, status: 500 });
    if (config.env === 'test') console.error(err);
    return reply.code(500).send(errorEnvelope(new ApiError(500, 'INTERNAL', 'Something went wrong. Try again.'), req.id));
  });
  // Without an in-process worker (serverless), ordinary requests keep time-based state and the outbox moving.
  const catchUp = catchUpAfterRequests(services, (config.catchUpSeconds ?? (config.runWorkerInProcess || config.env === 'test' ? 0 : 60)) * 1000, (m, e) => app.log.error({ err: e }, m));
  app.addHook('onResponse', async (req) => { if (!req.url.startsWith('/v1/internal/') && req.url !== '/health') catchUp(); });

  app.setNotFoundHandler((req, reply) => reply.code(404).send(errorEnvelope(new ApiError(404, 'NOT_FOUND', 'Not found.'), req.id)));

  // Liveness for anyone (rate-limited); the provider configuration only with the cron secret (or locally, when none is set).
  app.get('/health', async (req, reply) => {
    const wait = await services.limiter.hit(`health:${platformIp(req)}`, config.rateLimit.healthPerMinute);
    if (wait) return reply.code(429).header('retry-after', String(wait)).send(errorEnvelope(new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'), req.id));
    const detailed = config.cronSecret ? secretEquals(req.headers.authorization, `Bearer ${config.cronSecret}`) : config.env === 'development' || config.env === 'test';
    if (!detailed) return { ok: true };
    return { ok: true, market: services.pack.id, db: db.driver, env: config.env, storage: config.storage, malwareScanner: config.malwareScanner,
      providers: { sms: config.providers.sms.kind, email: config.providers.email.kind, payments: config.providers.payments.kind, architect: config.providers.architect.kind, builder: config.providers.builder.kind, brain: config.providers.brain?.kind ?? 'none', render: config.providers.render.kind, designer: config.providers.designer.kind === 'chain' ? config.providers.designer.list.map((d) => d.kind).join(',') : config.providers.designer.kind, critique: config.providers.critique?.kind ?? 'designer', dream: config.providers.dream?.kind ?? 'none', checker: services.checker.live ? 'anthropic' : 'none' }, paidAi: paidAiJobs(config.providers), rateLimit: config.rateLimitStore };
  });

  // Scheduled background work on serverless hosts (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`).
  app.get('/v1/internal/cron', async (req, reply) => {
    if (!config.cronSecret || !secretEquals(req.headers.authorization, `Bearer ${config.cronSecret}`)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Not allowed.' } });
    return runWorkerCycle(services, req.log);
  });

  registerOps(app, services);
  registerIdentity(app, services);
  registerPrivacy(app, services);
  registerStaff(app, services);
  registerListings(app, services);
  registerContact(app, services);
  registerNotifications(app, services);
  registerModeration(app, services);
  registerPromotions(app, services);
  registerStudio(app, services);
  registerProjects(app, services);
  registerDocuments(app, services);
  registerEstimates(app, services);
  registerProcurement(app, services);
  registerFulfilment(app, services);
  registerCases(app, services);
  registerTenders(app, services);
  registerContracts(app, services);
  registerSupplierLists(app, services);
  registerOrderFiles(app, services);
  registerTransactionReviews(app, services);
  registerLiquidity(app, services);
  registerFeedback(app, services);
  registerPolicies(app, services);
  registerBuild(app, services);
  registerRender(app, services);
  registerDream(app, services);
  registerAiDesign(app, services);
  registerCritique(app, services);

  app.addHook('onClose', async () => { await drainBackground(); await db.close(); });
  return { app, services };
}

/** With CRITIQUE_PROVIDER=gemini, Gemini looks at the 3D snapshot whatever composes the layouts. */
function withCritique(d: DesignerProvider, c: Config['providers']['critique']): DesignerProvider {
  if (c?.kind !== 'gemini') return d;
  const seer = createGeminiDesigner(c);
  return d.live ? { ...d, critique: seer.critique! } : d;
}

/** One designer, or a chain of them (Claude first, a free model as the fallback). */
async function designerFor(d: { kind: 'none' } | DesignerSpec | { kind: 'chain'; list: DesignerSpec[] }): Promise<DesignerProvider> {
  const one = async (x: DesignerSpec) => (x.kind === 'anthropic' ? createClaudeDesigner(x) : createGeminiDesigner({ ...x, transport: 'generateContent' }));
  if (d.kind === 'none') return noDesigner;
  if (d.kind === 'chain') return chainDesigners(await Promise.all(d.list.map(one)));
  const provider = await one(d);
  // Gemini supplies planning directions. The engine owns the geometry and no image critique can replace it.
  return d.kind === 'gemini' ? { ...provider, engineGeometry: true } : provider;
}
