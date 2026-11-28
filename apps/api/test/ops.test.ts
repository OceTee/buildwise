import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, type Json } from './helpers.js';
import { one } from '../src/db/database.js';
import { publish } from '../src/platform/platform.js';
import { runWithContext } from '../src/platform/observability.js';
import { readiness, recordAiOutcome } from '../src/modules/ops.js';
import { catchUpAfterRequests, runWorkerCycle } from '../src/worker.js';
import { drainBackground } from '../src/platform/background.js';

const SECRET = 'test-cron-secret-0123456789';

describe('health, readiness and the detailed view', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  const prior = process.env.CRON_SECRET;
  beforeAll(async () => { process.env.CRON_SECRET = SECRET; h = await harness(); });
  afterAll(async () => { if (prior === undefined) delete process.env.CRON_SECRET; else process.env.CRON_SECRET = prior; await h.close(); });

  it('keeps /health (public: ok only; detailed with the cron secret) and answers /health/live without the database', async () => {
    const health = await h.call(null, 'GET', '/health');
    expect(health).toMatchObject({ status: 200, body: { ok: true } });
    expect(health.body.providers).toBeUndefined();
    const detailed = await h.call(null, 'GET', '/health', undefined, { authorization: `Bearer ${SECRET}` });
    expect(detailed.body).toMatchObject({ ok: true, db: 'pglite', env: 'test' });
    const live = await h.call(null, 'GET', '/health/live');
    expect(live).toMatchObject({ status: 200, body: { ok: true } });
  });

  it('is ready when the database answers and every migration is applied, without provider details', async () => {
    const r = await h.call(null, 'GET', '/health/ready');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, db: 'ok', migrations: 'current' });
    expect(r.body.providers).toBeUndefined();
  });

  it('answers 503 when the database is down, slow, or behind on migrations', async () => {
    const real = h.services.db.tx;
    h.services.db.tx = (() => Promise.reject(new Error('connect ECONNREFUSED'))) as typeof real;
    try {
      const r = await h.call(null, 'GET', '/health/ready');
      expect(r.status).toBe(503);
      expect(r.body).toMatchObject({ ok: false, db: 'down' });
      h.services.db.tx = (() => new Promise(() => undefined)) as typeof real;
      expect(await readiness(h.services, 50)).toMatchObject({ ok: false, db: 'timeout' });
    } finally {
      h.services.db.tx = real;
    }
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`delete from schema_migrations where name = '020_ops.sql'`));
    try {
      const behind = await h.call(null, 'GET', '/health/ready');
      expect(behind.status).toBe(503);
      expect(behind.body).toMatchObject({ db: 'ok', migrations: 'pending' });
    } finally {
      await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`insert into schema_migrations (name) values ('020_ops.sql')`));
    }
  });

  it('shows the detailed view only with the cron secret', async () => {
    expect((await h.call(null, 'GET', '/health/details')).status).toBe(401);
    expect((await h.call(null, 'GET', '/health/details', undefined, { authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await h.call(null, 'GET', '/health/details', undefined, { authorization: `Bearer ${SECRET}x` })).status).toBe(401);
    const signedIn = await h.signIn('Ada');
    expect((await h.call(signedIn.token, 'GET', '/health/details')).status).toBe(401);
    const r = await h.call(null, 'GET', '/health/details', undefined, { authorization: `Bearer ${SECRET}` });
    expect(r.status).toBe(200);
    expect(r.body.ready).toMatchObject({ ok: true });
    expect(r.body.outbox).toMatchObject({ pending: expect.any(Number) });
    expect(r.body.ai.jobs.map((j: Json) => j.kind)).toContain('designer');
  });

  it('reports the outbox backlog and the last worker cycle, and alerts when they go stale', async () => {
    const auth = { authorization: `Bearer ${SECRET}` };
    const cycle = await runWorkerCycle(h.services);
    expect(cycle.cycleId).toMatch(/^worker-/);
    let r = await h.call(null, 'GET', '/health/details', undefined, auth);
    expect(r.body.worker).toMatchObject({ ok: true, cycleId: cycle.cycleId });
    expect(r.body.worker.lastCycleSeconds).toBeLessThan(60);
    expect(r.body.alerts).toEqual([]);
    expect(r.body.ok).toBe(true);

    // An event that has waited 20 minutes and failed twice, and a worker that last ran 27 hours ago.
    await h.services.db.tx({ kind: 'system' }, async (sql) => {
      await sql.query(`insert into outbox (event_id, event_type, payload, occurred_at, attempts, last_error, correlation_id)
        values (gen_random_uuid(), 'RfqClosed', '{}', now() - interval '20 minutes', 2, 'SMS failed for +2348031234567', 'corr-stale')`);
      await sql.query(`update ops_heartbeats set at = now() - interval '27 hours' where name = 'worker_cycle'`);
    });
    r = await h.call(null, 'GET', '/health/details', undefined, auth);
    expect(r.body.ok).toBe(false);
    expect(r.body.outbox.oldestPendingSeconds).toBeGreaterThan(19 * 60);
    expect(r.body.outbox.retrying).toBeGreaterThanOrEqual(1);
    const err = r.body.outbox.recentErrors.find((e: Json) => e.correlationId === 'corr-stale');
    expect(err.lastError).toBe('SMS failed for [phone]');
    expect(r.body.alerts.join(' ')).toMatch(/outbox oldest pending event is 2\d min old/);
    expect(r.body.alerts.join(' ')).toMatch(/last worker cycle 27 h ago/);
    expect((await h.call(null, 'GET', '/health/details?strict=1', undefined, auth)).status).toBe(503);
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`delete from outbox where correlation_id = 'corr-stale'`));
  });

  it('records the catch-up run after requests under its own correlation id, not the triggering request', async () => {
    const hook = catchUpAfterRequests(h.services, 1);
    runWithContext({ correlationId: 'req-trigger' }, () => hook());
    await drainBackground();
    const r = await h.call(null, 'GET', '/health/details', undefined, { authorization: `Bearer ${SECRET}` });
    expect(r.body.catchUp).toMatchObject({ ok: true, cycleId: expect.stringMatching(/^catchup-/) });
    expect(r.body.catchUp.lastRunSeconds).toBeLessThan(60);
  });
});

describe('correlation ids', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => { h = await harness(); });
  afterAll(async () => { await h.close(); });

  it('reach the outbox events a request writes', async () => {
    const headers = { 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': '10.9.9.9' };
    const phone = '+2348099990001';
    const r = await h.ok(null, 'POST', '/v1/auth/otp/request', { phone }, headers);
    const v = await h.call(null, 'POST', '/v1/auth/otp/verify', { phone, code: r.devCode, displayName: 'Bola' }, headers);
    expect(v.status).toBeLessThan(300);
    const id = String(v.headers['x-correlation-id']);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const row = await h.services.db.tx({ kind: 'system' }, (sql) => one<{ correlation_id: string | null }>(sql,
      `select correlation_id from outbox where event_type = 'PhoneVerified' and payload->>'userId' = $1`, [v.body.me.id]));
    expect(row?.correlation_id).toBe(id);
  });

  it('reach the outbox events a worker cycle writes, and are empty outside any context', async () => {
    await runWithContext({ correlationId: 'worker-test-cycle' }, () => h.services.db.tx({ kind: 'system' }, (sql) => publish(sql, 'RfqClosed', { rfqId: 'x1' })));
    await h.services.db.tx({ kind: 'system' }, (sql) => publish(sql, 'RfqClosed', { rfqId: 'x2' }));
    const rows = await h.services.db.tx({ kind: 'system' }, async (sql) => (await sql.query<{ id: string; correlation_id: string | null }>(
      `select payload->>'rfqId' as id, correlation_id from outbox where event_type = 'RfqClosed' order by occurred_at`)).rows);
    expect(rows).toEqual(expect.arrayContaining([{ id: 'x1', correlation_id: 'worker-test-cycle' }, { id: 'x2', correlation_id: null }]));
  });

  it('tag 500 errors sent to the error tracker, with the route template and a hashed user', async () => {
    const seen: { err: unknown; ctx: Json }[] = [];
    const fresh = await harness();
    fresh.services.errors = { kind: 'sentry', capture: (err, ctx) => { seen.push({ err, ctx: ctx as Json }); }, flush: async () => undefined };
    fresh.app.get('/v1/boom/:id', async () => { throw new Error('boom'); });
    const r = await fresh.call(null, 'GET', '/v1/boom/123');
    expect(r.status).toBe(500);
    expect(r.body.error.correlationId).toBe(r.headers['x-correlation-id']);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.ctx).toMatchObject({ correlationId: r.headers['x-correlation-id'], route: '/v1/boom/:id', status: 500 });
    await fresh.close();
  });
});

describe('maintenance mode', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => { h = await harness({ maintenance: { on: true, message: 'Back by 14:00 WAT.' } }); });
  afterAll(async () => { await h.close(); });

  it('answers every write with 503 MAINTENANCE and keeps reads working', async () => {
    const w = await h.call(null, 'POST', '/v1/auth/otp/request', { phone: '+2348031110000' });
    expect(w.status).toBe(503);
    expect(w.headers['retry-after']).toBe('300');
    expect(w.body.error).toMatchObject({ code: 'MAINTENANCE', message: 'Back by 14:00 WAT.', correlationId: expect.any(String) });
    for (const [method, url] of [['PUT', '/v1/favourites/abc'], ['PATCH', '/v1/me'], ['DELETE', '/v1/favourites/abc'], ['POST', '/v1/listings'], ['POST', '/v1/webhooks/checkout']] as const) {
      expect((await h.call(null, method, url, {})).status).toBe(503);
    }
    // The design tool keeps working: it computes designs and replies, and holds no one's records.
    const interpret = await h.call(null, 'POST', '/v1/build/interpret', { message: 'a 3 bedroom bungalow on 15 by 30' });
    expect(interpret.status).toBeLessThan(300);
    expect((await h.call(null, 'GET', '/v1/market')).status).toBe(200);
    expect((await h.call(null, 'GET', '/v1/categories')).status).toBe(200);
    expect((await h.call(null, 'GET', '/health/ready')).status).toBe(200);
    const status = await h.call(null, 'GET', '/v1/status');
    expect(status.body.maintenance).toEqual({ on: true, message: 'Back by 14:00 WAT.' });
  });
});

describe('service status', () => {
  it('says nothing when all is well, and names AI features that are falling back', async () => {
    const h = await harness();
    try {
      let s = await h.call(null, 'GET', '/v1/status');
      expect(s.body).toEqual({ maintenance: { on: false, message: null }, degraded: { on: false, message: null, features: [] } });
      // A provider that is not connected is never "degraded": the engine is simply what answers.
      await recordAiOutcome(h.services, 'brain', false, 'no answer');
      expect((await h.call(null, 'GET', '/v1/status')).body.degraded.on).toBe(false);

      h.services.brain = { live: true, model: 'fake', read: async () => null };
      s = await h.call(null, 'GET', '/v1/status');
      expect(s.body.degraded).toMatchObject({ on: true, features: ['assistant'] });
      expect(s.body.degraded.message).toMatch(/simpler/);
      await recordAiOutcome(h.services, 'brain', true);
      expect((await h.call(null, 'GET', '/v1/status')).body.degraded.on).toBe(false);

      // Today's ceiling reached counts too.
      await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`insert into ai_usage (day, kind, n) values (current_date, 'brain', $1)`, [h.services.config.assistantDailyLimit]));
      expect((await h.call(null, 'GET', '/v1/status')).body.degraded.features).toEqual(['assistant']);
    } finally { await h.close(); }
  });

  it('shows an operator message set with DEGRADED_MESSAGE', async () => {
    const h = await harness({ degradedMessage: 'Sign-in codes are slow today.' });
    try {
      expect((await h.call(null, 'GET', '/v1/status')).body.degraded).toMatchObject({ on: true, message: 'Sign-in codes are slow today.' });
    } finally { await h.close(); }
  });
});
