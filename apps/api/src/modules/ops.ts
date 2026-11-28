import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { paidAiJobs } from '../config.js';
import { iso, many, type Sql } from '../db/database.js';
import { MIGRATIONS } from '../db/migrations.generated.js';
import { errorEnvelope, platformIp, secretEquals, type Services } from '../http/route.js';
import { ApiError } from '../platform/platform.js';
import { currentCorrelationId, scrubText } from '../platform/observability.js';

/**
 * Health, readiness and service status (spec §21.4, §28).
 * - `/health/live`: the process answers. No database, no secrets.
 * - `/health/ready`: the database answers within a timeout and every migration is applied. Public, no provider details.
 * - `/health/details`: behind `Authorization: Bearer $CRON_SECRET`: outbox backlog, last worker cycle, AI ceilings.
 * - `/health`: the original summary, kept for anything already probing it.
 * - `/v1/status`: what the website tells people: maintenance and degraded AI.
 */

const READY_TIMEOUT_MS = 2_000;
/** An AI job counts as degraded while its latest failure is newer than its latest success and this recent. */
export const AI_DEGRADED_WINDOW_SECONDS = 15 * 60;

/** AI jobs that fall back to BuildWise's own engine or assistant, with the plain words the website uses. */
const AI_JOBS: Record<string, string> = {
  designer: 'AI design', critique: 'AI design review', architect: 'AI architect', builder: 'Builder AI chat',
  brain: 'assistant', render: 'photoreal renders', dream: 'dream renders',
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<T>((_, reject) => { t = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

export async function readiness(s: Services, timeoutMs = READY_TIMEOUT_MS) {
  const started = Date.now();
  try {
    const rows = await withTimeout(s.db.tx({ kind: 'system' }, async (sql) => {
      if (s.db.driver === 'pg') await sql.query(`set local statement_timeout = ${Math.max(100, timeoutMs)}`);
      return many<{ name: string }>(sql, `select name from schema_migrations`);
    }), timeoutMs);
    const applied = new Set(rows.map((r) => r.name));
    const pending = MIGRATIONS.filter((m) => !applied.has(m.name)).length;
    return { ok: pending === 0, db: 'ok' as const, migrations: pending === 0 ? 'current' as const : 'pending' as const, latencyMs: Date.now() - started };
  } catch (e) {
    return { ok: false, db: (e as Error).message === 'timeout' ? 'timeout' as const : 'down' as const, migrations: 'unknown' as const, latencyMs: Date.now() - started };
  }
}

/**
 * The detailed view's gate, the same as `/health`'s detailed branch: `Authorization: Bearer $CRON_SECRET` (constant
 * time), or nothing at all in development and tests when no secret is set. Deployed envs refuse to start without one.
 */
export function hasCronSecret(req: FastifyRequest, s: Services): boolean {
  const { cronSecret, env } = s.config;
  return cronSecret ? secretEquals(req.headers.authorization, `Bearer ${cronSecret}`) : env === 'development' || env === 'test';
}

/** Public probes share `/health`'s per-IP bucket (HEALTH_PER_MINUTE): an uptime monitor needs a few a minute. */
async function limited(req: FastifyRequest, reply: FastifyReply, s: Services): Promise<boolean> {
  const wait = await s.limiter.hit(`health:${platformIp(req)}`, s.config.rateLimit.healthPerMinute);
  if (!wait) return false;
  reply.code(429).header('retry-after', String(wait)).send(errorEnvelope(new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'), req.id));
  return true;
}

// ---------------------------------------------------------------- heartbeats
export async function heartbeat(sql: Sql, name: string, detail: Record<string, unknown> = {}) {
  await sql.query(`insert into ops_heartbeats (name, at, detail) values ($1, now(), $2::jsonb) on conflict (name) do update set at = now(), detail = excluded.detail`, [name, JSON.stringify(detail)]);
}

/**
 * Records whether an AI provider answered, so `/v1/status` can tell people when designs fall back to the engine.
 * Never throws and never blocks the reply for long: the call is already outside the request transaction.
 */
export async function recordAiOutcome(s: Services, kind: keyof typeof AI_JOBS, ok: boolean, reason?: string) {
  try {
    await s.db.tx({ kind: 'system' }, (sql) => heartbeat(sql, `ai:${kind}:${ok ? 'ok' : 'fail'}`, ok ? {} : { reason: scrubText(String(reason ?? 'error')).slice(0, 200), correlationId: currentCorrelationId() }));
  } catch { /* the health record must never break the AI fallback */ }
}

interface Beat { name: string; at: unknown; detail: any }
const ageSeconds = (at: unknown) => (at == null ? null : Math.round((Date.now() - new Date(String(at)).getTime()) / 1000));

/** Which live AI jobs are falling back right now: a recent failure with no success since, or today's ceiling reached. */
async function aiState(s: Services, sql: Sql) {
  const beats = await many<Beat>(sql, `select name, at, detail from ops_heartbeats where name like 'ai:%'`);
  const usage = await many<{ kind: string; n: number }>(sql, `select kind, n from ai_usage where day = current_date`);
  const limits: Record<string, number> = {
    brain: s.config.assistantDailyLimit, builder: s.config.builderLimits.perDay, designer: s.config.designerLimits.perDay,
    critique: s.config.designerLimits.perDay, render: s.config.renderLimits.perDay, dream: s.config.dreamLimits.perDay,
  };
  const live: Record<string, boolean> = {
    designer: s.designer.live, critique: s.designer.live && !!s.designer.critique, architect: s.architect.live, builder: s.builder.live,
    brain: s.brain.live, render: s.render.kind !== 'none', dream: s.dream.kind !== 'none',
  };
  const at = (n: string) => beats.find((b) => b.name === n);
  return Object.keys(AI_JOBS).map((kind) => {
    const ok = at(`ai:${kind}:ok`);
    const fail = at(`ai:${kind}:fail`);
    const failAge = ageSeconds(fail?.at);
    const failing = !!fail && failAge != null && failAge <= AI_DEGRADED_WINDOW_SECONDS && (!ok || new Date(String(ok.at)) < new Date(String(fail.at)));
    const used = Number(usage.find((u) => u.kind === kind)?.n ?? 0);
    const limit = limits[kind];
    const ceiling = limit != null && used >= limit;
    return { kind, label: AI_JOBS[kind]!, live: live[kind] ?? false, used, limit: limit ?? null, ceilingReached: ceiling,
      lastOkAt: iso(ok?.at), lastFailAt: iso(fail?.at), lastFailReason: fail?.detail?.reason ?? null, failing,
      degraded: (live[kind] ?? false) && (failing || ceiling) };
  });
}

export async function serviceStatus(s: Services) {
  const ai = await s.db.tx({ kind: 'system' }, (sql) => aiState(s, sql)).catch(() => []);
  const down = ai.filter((a) => a.degraded);
  const message = s.config.degradedMessage
    ?? (down.length ? 'Some AI features are busy or unavailable, so BuildWise is using its own design engine and assistant. Designs may be simpler and replies shorter until they are back.' : null);
  return {
    maintenance: { on: s.config.maintenance.on, message: s.config.maintenance.on ? s.config.maintenance.message : null },
    degraded: { on: !!message, message, features: down.map((a) => a.label) },
  };
}

export function registerOps(app: FastifyInstance, s: Services) {
  const { config } = s;

  app.get('/health/live', async (_req, reply) => { reply.header('cache-control', 'no-store'); return { ok: true }; });

  app.get('/health/ready', async (req, reply) => {
    if (await limited(req, reply, s)) return reply;
    const r = await readiness(s);
    reply.header('cache-control', 'no-store');
    return reply.code(r.ok ? 200 : 503).send(r);
  });

  app.get('/health/details', async (req, reply) => {
    reply.header('cache-control', 'no-store');
    if (!hasCronSecret(req, s)) return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Not allowed.', correlationId: req.id } });
    const ready = await readiness(s);
    const body = await s.db.tx({ kind: 'system' }, async (sql) => {
      const [pending] = await many<{ n: number; oldest: unknown; failing: number; stuck: number }>(sql,
        `select count(*)::int as n, min(occurred_at) as oldest, count(*) filter (where attempts > 0)::int as failing, count(*) filter (where attempts >= 10)::int as stuck
           from outbox where dispatched_at is null`);
      const errors = await many<{ event_type: string; attempts: number; last_error: string | null; correlation_id: string | null; occurred_at: unknown }>(sql,
        `select event_type, attempts, last_error, correlation_id, occurred_at from outbox where dispatched_at is null and last_error is not null order by occurred_at limit 5`);
      const [worker] = await many<Beat>(sql, `select name, at, detail from ops_heartbeats where name = 'worker_cycle'`);
      const [catchUp] = await many<Beat>(sql, `select name, at, detail from ops_heartbeats where name = 'timed_work'`);
      const ai = await aiState(s, sql);
      const architectToday = await many<{ n: number }>(sql, `select count(*)::int as n from architect_reviews where created_at > now() - interval '1 day'`);
      return { pending: pending!, errors, worker, catchUp, ai, architectToday: architectToday[0]?.n ?? 0 };
    }).catch(() => null);
    if (!body) return reply.code(503).send({ ok: false, ready });
    const oldestAge = ageSeconds(body.pending.oldest);
    const workerAge = ageSeconds(body.worker?.at);
    const alerts: string[] = [];
    if (!ready.ok) alerts.push(`database ${ready.db}, migrations ${ready.migrations}`);
    // Alert thresholds (docs/ops/monitoring.md): OUTBOX_ALERT_MINUTES (10) and WORKER_ALERT_HOURS (26).
    if (oldestAge != null && oldestAge > config.alerts.outboxMinutes * 60) alerts.push(`outbox oldest pending event is ${Math.round(oldestAge / 60)} min old`);
    if (body.pending.stuck > 0) alerts.push(`${body.pending.stuck} outbox events gave up after 10 attempts`);
    if (workerAge == null || workerAge > config.alerts.workerHours * 3600) alerts.push(workerAge == null ? 'no worker cycle recorded yet' : `last worker cycle ${Math.round(workerAge / 3600)} h ago`);
    if (body.worker?.detail?.ok === false) alerts.push('last worker cycle failed');
    for (const a of body.ai.filter((x) => x.degraded)) alerts.push(`${a.label} ${a.ceilingReached ? 'reached its daily ceiling' : 'is failing'}`);
    const out = {
      ok: alerts.length === 0, alerts, env: config.env, release: config.errorTracking.kind === 'sentry' ? config.errorTracking.release ?? null : null,
      ready,
      outbox: { pending: body.pending.n, oldestPendingAt: iso(body.pending.oldest), oldestPendingSeconds: oldestAge, retrying: body.pending.failing, gaveUp: body.pending.stuck,
        recentErrors: body.errors.map((e) => ({ eventType: e.event_type, attempts: e.attempts, lastError: e.last_error ? scrubText(e.last_error).slice(0, 300) : null, correlationId: e.correlation_id, occurredAt: iso(e.occurred_at) })) },
      worker: { lastCycleAt: iso(body.worker?.at), lastCycleSeconds: workerAge, ...(body.worker?.detail ?? {}) },
      // The timed work that ordinary requests start in the background between cron runs (serverless catch-up).
      catchUp: { lastRunAt: iso(body.catchUp?.at), lastRunSeconds: ageSeconds(body.catchUp?.at), ...(body.catchUp?.detail ?? {}) },
      ai: { jobs: body.ai, architectReviewsToday: body.architectToday, architectDailyLimit: config.architectLimits.perDay, paidAi: paidAiJobs(config.providers) },
      maintenance: config.maintenance.on, errorTracking: config.errorTracking.kind,
    };
    // `?strict=1` turns alerts into a 503, for monitors that only look at the status code.
    const strict = (req.query as { strict?: string }).strict === '1';
    return reply.code(strict && !out.ok ? 503 : 200).send(out);
  });

  app.get('/v1/status', async (req, reply) => {
    if (await limited(req, reply, s)) return reply;
    reply.header('cache-control', 'public, max-age=30');
    return serviceStatus(s);
  });
}
