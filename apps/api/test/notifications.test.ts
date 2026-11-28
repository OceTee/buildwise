import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getMarket } from '@bw/domain';
import { runProcurementTimers } from '../src/modules/procurement.js';
import { drainBackground } from '../src/platform/background.js';
import { publish, type MessageChannel } from '../src/platform/platform.js';
import { dispatchEvents, dispatchOutbox, runExpiries } from '../src/worker.js';
import { harness, type Json } from './helpers.js';

/** Public beta, workstream C: people hear about things on time (spec §16, §21.1). */
let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let seller: User, buyer: User, mod: User, ops: User;
let listing: Json;
const sent: { to: string; text: string; channel: string }[] = [];
const counting = (channel: string, live: boolean): MessageChannel => ({ live, async send(to, text) { sent.push({ to, text, channel }); } });
const sys = <R = Json>(q: string, p: unknown[] = []) => h.services.db.tx({ kind: 'system' }, (sql) => sql.query<R>(q, p)).then((r) => r.rows);
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const notes = async (u: User) => (await h.ok(u.token, 'GET', '/v1/notifications')).items as Json[];

beforeAll(async () => {
  h = await harness();
  mod = await h.signIn('Mo Moderator', { staff: 'moderator' });
  ops = await h.signIn('Opal Ops', { staff: 'ops_admin' });
  seller = await h.veteranBusiness(await h.signIn('Sade Seller'), 'Sade Cement Depot');
  buyer = await h.signIn('Bayo Buyer');
  await h.ok(seller.token, 'PATCH', '/v1/me', { email: 'sade@example.test' });
  await h.ok(buyer.token, 'PATCH', '/v1/me', { email: 'bayo@example.test' });
  listing = await h.liveListing(seller, mod, { title: 'Cement for chat tests' });
  await drainBackground();
  // From here on every copy is counted; email counts as a connected provider.
  h.services.email = counting('email', true);
  h.services.sms = counting('sms', false);
});
afterAll(async () => { await h?.close(); });

describe('dispatch after commit', () => {
  it('sends a request’s events as soon as it commits, without any worker run', async () => {
    sent.length = 0;
    const r = await h.ok(buyer.token, 'POST', `/v1/listings/${listing.id}/threads`, { body: 'Do you deliver to Hilltop?' });
    await drainBackground();
    expect(sent.filter((m) => m.to === 'sade@example.test')).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/New message from Bayo Buyer/);
    expect(sent[0]!.text).not.toMatch(/Hilltop/); // copies never carry the message itself
    const [row] = await sys<{ dispatched_at: unknown }>(`select dispatched_at from outbox where event_type = 'MessageSent' and payload->>'threadId' = $1`, [r.threadId]);
    expect(row!.dispatched_at).not.toBeNull();
  });

  it('never sends an event twice when the inline and the scheduled dispatch race', async () => {
    sent.length = 0;
    const id = await h.services.db.tx({ kind: 'system' }, async (sql) => {
      await publish(sql, 'ListingExpired', { listingId: listing.id, sellerOrgId: seller.orgId });
      return (await sql.query<{ event_id: string }>(`select event_id from outbox order by occurred_at desc limit 1`)).rows[0]!.event_id;
    });
    const results = await Promise.all([dispatchEvents(h.services, [id]), dispatchOutbox(h.services), dispatchEvents(h.services, [id]), dispatchOutbox(h.services)]);
    expect(results.reduce((a, b) => a + b, 0)).toBe(1);
    expect(sent.filter((m) => /expired/.test(m.text))).toHaveLength(1);
    expect(await dispatchOutbox(h.services)).toBe(0);
  });

  it('retries an event whose only copy failed, and releases the claim', async () => {
    h.services.email = { live: true, async send() { throw new Error('provider down'); } };
    const r = await h.ok(seller.token, 'POST', `/v1/threads/${(await h.ok(buyer.token, 'GET', '/v1/threads')).items[0].id}/messages`, { body: 'Yes, we deliver.' });
    await drainBackground();
    const [row] = await sys<Json>(`select dispatched_at, claimed_at, attempts, last_error from outbox where payload->>'messageId' = $1`, [r.id]);
    expect(row).toMatchObject({ dispatched_at: null, claimed_at: null, attempts: 1 });
    expect(row!.last_error).toMatch(/provider down/);
    h.services.email = counting('email', true);
    sent.length = 0;
    expect(await dispatchOutbox(h.services)).toBeGreaterThanOrEqual(1);
    expect(sent.filter((m) => m.to === 'bayo@example.test')).toHaveLength(1);
  });
});

describe('chat notifications', () => {
  it('coalesces into one unread notification per thread and copies only the first message', async () => {
    const other = await h.signIn('Chidi Chatty');
    await h.ok(other.token, 'PATCH', '/v1/me', { email: 'chidi@example.test' });
    await drainBackground();
    sent.length = 0;
    const t = await h.ok(other.token, 'POST', `/v1/listings/${listing.id}/threads`, { body: 'Hello' });
    for (const body of ['Are you open today?', 'I need 40 bags']) await h.ok(other.token, 'POST', `/v1/threads/${t.threadId}/messages`, { body });
    await drainBackground();
    const mine = (await notes(seller)).filter((n) => n.kind === 'message' && n.link === `/messages/${t.threadId}` && !n.read);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ count: 3, title: '3 new messages from Chidi Chatty', body: 'Cement for chat tests' });
    expect(sent.filter((m) => m.to === 'sade@example.test')).toHaveLength(1);
    // The sender is not notified about their own messages.
    expect((await notes(other)).some((n) => n.kind === 'message')).toBe(false);

    // Opening the thread reads it; the next message starts a new notification and a new copy.
    await h.ok(seller.token, 'GET', `/v1/threads/${t.threadId}`);
    expect((await notes(seller)).filter((n) => n.link === `/messages/${t.threadId}` && !n.read)).toHaveLength(0);
    await h.ok(other.token, 'POST', `/v1/threads/${t.threadId}/messages`, { body: 'Still there?' });
    await drainBackground();
    const again = (await notes(seller)).filter((n) => n.link === `/messages/${t.threadId}` && !n.read);
    expect(again).toMatchObject([{ count: 1, title: 'New message from Chidi Chatty' }]);
    expect(sent.filter((m) => m.to === 'sade@example.test')).toHaveLength(2);

    // The seller's reply notifies the buyer.
    await h.ok(seller.token, 'POST', `/v1/threads/${t.threadId}/messages`, { body: 'Yes, open till 6.' });
    expect((await notes(other)).find((n) => n.kind === 'message')).toMatchObject({ title: 'New message from Sade Cement Depot', read: false });
  });

  it('follows the person’s preferences: chat copies off, SMS only when chosen', async () => {
    const p = await h.ok(seller.token, 'GET', '/v1/me/notification-preferences');
    expect(p.topics.find((t: Json) => t.topic === 'messages')).toMatchObject({ email: true, sms: false });
    await h.ok(seller.token, 'PUT', '/v1/me/notification-preferences', { messages: { email: false } });
    const t = await h.ok(buyer.token, 'GET', '/v1/threads');
    await h.ok(seller.token, 'GET', `/v1/threads/${t.items[0].id}`); // read, so the next message is a first unread one
    sent.length = 0;
    await h.ok(buyer.token, 'POST', `/v1/threads/${t.items[0].id}/messages`, { body: 'One more question' });
    await drainBackground();
    expect(sent.filter((m) => m.to === 'sade@example.test')).toHaveLength(0);
    expect((await notes(seller)).some((n) => n.kind === 'message' && !n.read)).toBe(true); // in-app is always kept

    await h.ok(seller.token, 'PUT', '/v1/me/notification-preferences', { messages: { sms: true } });
    await h.ok(seller.token, 'GET', `/v1/threads/${t.items[0].id}`);
    await h.ok(buyer.token, 'POST', `/v1/threads/${t.items[0].id}/messages`, { body: 'And another' });
    await drainBackground();
    expect(sent.filter((m) => m.channel === 'sms' && m.to === seller.phone)).toHaveLength(1);
    await h.ok(seller.token, 'PUT', '/v1/me/notification-preferences', { messages: { email: true, sms: false } });
  });

  it('notifies the seller of a quote request and the buyer of the answer', async () => {
    const q = await h.ok(buyer.token, 'POST', `/v1/listings/${listing.id}/quote-requests`, { quantity: '40', unit: 'bag', deliveryArea: 'hilltop' });
    const n = (await notes(seller)).find((x) => x.kind === 'quote_request');
    expect(n).toMatchObject({ title: 'New quote request', link: `/messages/${q.threadId}`, read: false });
    expect(n!.body).toMatch(/40 bags? for Cement for chat tests/);
    await h.ok(seller.token, 'POST', `/v1/quote-requests/${q.id}/answer`, { price: '9400' });
    expect((await notes(buyer)).find((x) => x.kind === 'quote_request')!.title).toMatch(/^Quote received: /);
  });
});

describe('time-based state is right when read', () => {
  it('a listing past its end date reads as expired everywhere, and expires once', async () => {
    const l = await h.liveListing(seller, mod, { title: 'Granite that runs out' });
    await sys(`update listings set expires_at = now() - interval '1 minute' where id = $1`, [l.id]);
    const search = await h.ok(null, 'GET', '/v1/search?q=granite');
    expect(JSON.stringify(search)).not.toContain(l.id);
    expect((await h.ok(null, 'GET', `/v1/public/listings/${l.shortId}`)).available).toBe(false);
    expect((await h.call(buyer.token, 'POST', `/v1/listings/${l.id}/threads`, { body: 'Still available?' })).status).toBe(404);
    // The seller's own view settles it: expired now, with its event and side effects, not at the next cron run.
    const own = await h.ok(seller.token, 'GET', `/v1/listings/${l.id}`);
    expect(own.status).toBe('expired');
    expect(own.allowedCommands).toContain('renew');
    expect((await runExpiries(h.services)).listings).toBe(0);
    const events = await sys(`select 1 from outbox where event_type = 'ListingExpired' and payload->>'listingId' = $1`, [l.id]);
    expect(events).toHaveLength(1);
  });

  it('promotions past their end stop showing in slots', async () => {
    const ended = await h.liveListing(seller, mod, { title: 'Promoted gravel that ended' });
    const running = await h.liveListing(seller, mod, { title: 'Promoted gravel still running' });
    const promo = (listingId: string, endsAt: string) => sys(`insert into promotion_purchases (id, org_id, listing_id, product_code, kind, net_minor, tax_minor, gross_minor, currency, status, remaining_seconds, active_since, ends_at, created_by)
      values (gen_random_uuid(), $1, $2, 'top-7', 'top', 250000, 0, 250000, 'NGN', 'active', 0, now() - interval '7 days', ${endsAt}, $3)`, [seller.orgId, listingId, seller.id]);
    await promo(ended.id, `now() - interval '1 minute'`);
    await promo(running.id, `now() + interval '1 day'`);
    const s = await h.ok(null, 'GET', '/v1/search?q=gravel&sort=relevance');
    const items = (s.groups as Json[]).flatMap((g) => g.items as Json[]);
    expect(items.find((i) => i.listing.id === running.id)!.slot).toBe('top');
    expect(items.filter((i) => i.listing.id === ended.id).every((i) => i.slot !== 'top')).toBe(true);
  });

  it('an RFQ past its deadline reads as closed, and quotes past validity as expired', async () => {
    const owner = await h.signIn('Ola Owner');
    await h.ok(mod.token, 'POST', `/v1/moderation/sellers/${seller.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup (test)' });
    const projectId = (await h.ok(owner.token, 'POST', '/v1/projects', { name: 'Hilltop bungalow', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'construction' })).id;
    const qr = await h.ok(owner.token, 'POST', `/v1/listings/${listing.id}/quote-requests`, { quantity: '40', unit: 'bag', deliveryArea: 'hilltop' });
    const id = (await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/rfqs`, { title: 'Cement for the slab', categorySlug: 'cement', quoteRequestId: qr.id, deadline: inDays(3), sourcingMode: 'invited' })).id;
    const v0 = await h.ok(owner.token, 'GET', `/v1/rfqs/${id}`);
    await h.ok(owner.token, 'POST', `/v1/rfqs/${id}/commands/publish`, { expectedVersion: v0.version });
    const lines = (await h.ok(seller.token, 'GET', `/v1/rfqs/${id}`)).lines as Json[];
    const d = await h.ok(seller.token, 'POST', `/v1/rfqs/${id}/quotes`);
    const qv = await h.ok(seller.token, 'GET', `/v1/quote-versions/${d.versionId}`);
    await h.ok(seller.token, 'PUT', `/v1/quote-versions/${d.versionId}`, { expectedVersion: qv.version, lines: lines.map((l) => ({ rfqLineKey: l.lineKey, status: 'priced', unit: l.unit, quantity: l.quantity, unitPrice: '9000', taxRatePct: 7.5 })), validUntil: inDays(20).slice(0, 10), deliveryCharge: '0', deliveryTaxRatePct: 0, paymentTerms: 'On delivery' });
    await h.ok(seller.token, 'POST', `/v1/quote-versions/${d.versionId}/submit`, { expectedVersion: (await h.ok(seller.token, 'GET', `/v1/quote-versions/${d.versionId}`)).version });

    await sys(`update rfqs set deadline = now() - interval '1 minute' where id = $1`, [id]);
    // The provider cannot change the RFQ, but reads it as closed.
    expect(await h.ok(seller.token, 'GET', `/v1/rfqs/${id}`)).toMatchObject({ state: 'closed', acceptingQuotes: false, canQuote: false });
    expect((await h.ok(seller.token, 'GET', '/v1/provider/rfqs')).items.find((x: Json) => x.id === id).state).toBe('closed');
    // The client's read closes it for real and tells both sides, once.
    expect((await h.ok(owner.token, 'GET', `/v1/rfqs/${id}`)).state).toBe('closed');
    expect((await sys<{ state: string }>(`select state from rfqs where id = $1`, [id]))[0]!.state).toBe('closed');
    expect((await notes(owner)).find((n) => n.link === `/projects/${projectId}/rfqs/${id}`)!.title).toBe('Deadline reached: compare your quotes');
    expect((await notes(seller)).some((n) => n.title === 'Quoting has closed')).toBe(true);
    expect((await h.services.db.tx({ kind: 'system' }, (sql) => runProcurementTimers(sql, h.services))).closed).toBe(0);
    expect(await sys(`select 1 from outbox where event_type = 'RfqClosed' and payload->>'rfqId' = $1`, [id])).toHaveLength(1);

    // A quote past its validity date reads as expired and is expired once.
    await sys(`alter table quote_versions disable trigger quote_versions_immutable`);
    await sys(`update quote_versions set valid_until = current_date - 1 where id = $1`, [d.versionId]);
    await sys(`alter table quote_versions enable trigger quote_versions_immutable`);
    expect((await h.ok(seller.token, 'GET', `/v1/quote-versions/${d.versionId}`)).state).toBe('expired');
    await h.ok(owner.token, 'GET', `/v1/rfqs/${id}`);
    expect((await sys<{ state: string }>(`select state from quote_versions where id = $1`, [d.versionId]))[0]!.state).toBe('expired');
    expect((await h.services.db.tx({ kind: 'system' }, (sql) => runProcurementTimers(sql, h.services))).expired).toBe(0);
    expect((await notes(seller)).some((n) => n.title === 'Your quote has expired')).toBe(true);
  });
});

describe('catch-up after requests', () => {
  it('runs the timed work from ordinary requests at most once per interval', async () => {
    const c = await harness({ catchUpSeconds: 60 });
    try {
      const m = await c.signIn('Mo Moderator', { staff: 'moderator' });
      const s = await c.veteranBusiness(await c.signIn('Sam Seller'), 'Sam Blocks');
      const l = await c.liveListing(s, m);
      await drainBackground();
      await c.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update listings set expires_at = now() - interval '1 minute' where id = $1`, [l.id]));
      // The last catch-up ran less than a minute ago, so this request does not start another.
      await c.ok(null, 'GET', '/v1/market');
      await drainBackground();
      const status = async () => (await c.services.db.tx({ kind: 'system' }, (sql) => sql.query<{ status: string }>(`select status from listings where id = $1`, [l.id]))).rows[0]!.status;
      expect(await status()).toBe('live');
    } finally { await c.close(); }
  });

  it('persists time-based transitions and sends their events without a cron run', async () => {
    const c = await harness({ catchUpSeconds: 0.001 });
    try {
      const m = await c.signIn('Mo Moderator', { staff: 'moderator' });
      const s = await c.veteranBusiness(await c.signIn('Sam Seller'), 'Sam Blocks');
      const l = await c.liveListing(s, m);
      await drainBackground();
      await c.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update listings set expires_at = now() - interval '1 minute' where id = $1`, [l.id]));
      await new Promise((r) => setTimeout(r, 5));
      await c.ok(null, 'GET', '/v1/market');
      await drainBackground();
      const rows = await c.services.db.tx({ kind: 'system' }, (sql) => sql.query<Json>(`select l.status, (select dispatched_at from outbox o where o.event_type = 'ListingExpired' and o.payload->>'listingId' = l.id::text) as sent from listings l where l.id = $1`, [l.id]));
      expect(rows.rows[0]!.status).toBe('expired');
      expect(rows.rows[0]!.sent).not.toBeNull();
    } finally { await c.close(); }
  });
});

describe('SMS caps and the sign-in code limits', () => {
  const pack = getMarket('demo-2026.1');
  const otp = (phone: string, ip: string) => h.call(null, 'POST', '/v1/auth/otp/request', { phone }, { 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': ip });

  it('pauses sign-in by SMS at the per-country cap, says so, and tells ops once', async () => {
    h.services.pack = { ...pack, messaging: { smsDailyCap: 100, smsDailyCapByCallingCode: { '+234': 2 }, smsWarnAtPct: 50 } };
    await sys(`delete from sms_usage`);
    try {
      expect((await otp('+2348091110001', '10.9.0.1')).status).toBe(201);
      expect((await otp('+2348091110002', '10.9.0.2')).status).toBe(201);
      const refused = await otp('+2348091110003', '10.9.0.3');
      expect(refused.status).toBe(503);
      expect(refused.body.error).toMatchObject({ code: 'SMS_UNAVAILABLE', message: expect.stringMatching(/try again later/i) });
      expect((await otp('+2348091110004', '10.9.0.4')).status).toBe(503);
      await drainBackground();
      const usage = await sys<Json>(`select scope, sent, refused, warned_at, capped_at from sms_usage order by scope`);
      expect(usage.find((u) => u.scope === '+234')).toMatchObject({ sent: 2, refused: 2 });
      expect(usage.find((u) => u.scope === 'all')).toMatchObject({ sent: 2, refused: 0 });
      const alerts = (await notes(ops)).filter((n) => n.kind === 'ops');
      expect(alerts.filter((n) => /cap reached/.test(n.title))).toHaveLength(1);
      expect(alerts.filter((n) => /SMS use is at 1 of 2/.test(n.title))).toHaveLength(1);
      expect(await sys(`select 1 from audit_events where action = 'ops.sms_cap_reached'`)).toHaveLength(1);
      expect(await sys(`select 1 from outbox where event_type = 'SmsCapReached'`)).toHaveLength(2);
      // Other SMS stop too: an SMS copy of a notification is held back, not sent.
      await h.ok(seller.token, 'PUT', '/v1/me/notification-preferences', { listings: { email: false, sms: true } });
      sent.length = 0;
      await h.services.db.tx({ kind: 'system' }, (sql) => publish(sql, 'ListingExpired', { listingId: listing.id, sellerOrgId: seller.orgId }));
      await dispatchOutbox(h.services);
      expect(sent.filter((m) => m.channel === 'sms')).toHaveLength(0);
      expect((await sys<Json>(`select last_error, dispatched_at from outbox where event_type = 'ListingExpired' order by occurred_at desc limit 1`))[0]).toMatchObject({ last_error: expect.stringMatching(/sms cap/) });
    } finally {
      h.services.pack = pack;
      await h.ok(seller.token, 'PUT', '/v1/me/notification-preferences', { listings: { email: true, sms: true } });
    }
  });

  it('applies the daily total across countries', async () => {
    h.services.pack = { ...pack, messaging: { smsDailyCap: 1, smsDailyCapByCallingCode: { '+234': 100 }, smsWarnAtPct: 80 } };
    await sys(`delete from sms_usage`);
    try {
      expect((await otp('+2348091110011', '10.9.1.1')).status).toBe(201);
      expect((await otp('+2348091110012', '10.9.1.2')).status).toBe(503);
      await drainBackground();
      // The refused send was not counted against the country, only recorded against the total.
      expect(await sys(`select scope, sent, refused from sms_usage order by scope`)).toEqual([{ scope: '+234', sent: 1, refused: 0 }, { scope: 'all', sent: 1, refused: 1 }]);
    } finally { h.services.pack = pack; }
  });

  it('counts concurrent code requests atomically: never more than the per-number limit', async () => {
    const phone = '+2348091119999';
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => otp(phone, `10.9.2.${i + 1}`)));
    const limit = h.services.config.otpLimitPerHour ?? pack.limits.otpPerNumberPerHour;
    expect(results.filter((r) => r.status === 201)).toHaveLength(limit);
    expect(results.filter((r) => r.status === 429)).toHaveLength(8 - limit);
    expect((await sys<{ n: number }>(`select count(*)::int as n from otp_codes where phone_e164 = $1`, [phone]))[0]!.n).toBe(limit);
  });
});
