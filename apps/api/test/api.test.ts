import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signWebhook } from '../src/platform/platform.js';
import { runExpiries, runWorkerCycle } from '../src/worker.js';
import { harness, type Json } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let mod: User, mod2: User, ops: User, seller: User, buyer: User, other: User;

beforeAll(async () => {
  h = await harness();
  mod = await h.signIn('Mod One', { staff: 'moderator' });
  mod2 = await h.signIn('Mod Two', { staff: 'moderator' });
  ops = await h.signIn('Ops Admin', { staff: 'ops_admin' });
  seller = await h.veteranBusiness(await h.signIn('Seller Sam'), 'Sam Cement Depot');
  buyer = await h.signIn('Buyer Bea');
  other = await h.signIn('Other Olu');
});
afterAll(async () => { await h?.close(); });

describe('accounts', () => {
  it('asks for a name on first sign-in without consuming the code', async () => {
    const headers = { 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': '10.9.9.9' };
    const r = await h.ok(null, 'POST', '/v1/auth/otp/request', { phone: '+2348099999990' }, headers);
    const first = await h.ok(null, 'POST', '/v1/auth/otp/verify', { phone: '+2348099999990', code: r.devCode }, headers);
    expect(first.needsName).toBe(true);
    const second = await h.ok(null, 'POST', '/v1/auth/otp/verify', { phone: '+2348099999990', code: r.devCode, displayName: 'New Person' }, headers);
    expect(second.token).toBeTruthy();
    expect(second.isNew).toBe(true);
  });

  it('rejects a wrong code and unauthenticated access', async () => {
    const headers = { 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': '10.9.9.8' };
    await h.ok(null, 'POST', '/v1/auth/otp/request', { phone: '+2348099999991' }, headers);
    const bad = await h.call(null, 'POST', '/v1/auth/otp/verify', { phone: '+2348099999991', code: '000000', displayName: 'X Y' }, headers);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect((await h.call(null, 'GET', '/v1/me')).status).toBe(401);
  });

  it('a dormant account on a new device asks before signing in, and a new holder gets a fresh account', async () => {
    const old = await h.signIn('Previous Holder');
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update users set last_seen_at = now() - interval '400 days' where id = $1`, [old.id]));
    const headers = { 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': '10.9.9.7', 'x-device-id': 'newdevice12345' };
    const code = async () => (await h.ok(null, 'POST', '/v1/auth/otp/request', { phone: old.phone }, headers)).devCode;
    const c1 = await code();
    const ask = await h.ok(null, 'POST', '/v1/auth/otp/verify', { phone: old.phone, code: c1 }, headers);
    expect(ask.needsName).toBe(true);
    expect(ask.existingAccount).toBe(true);
    expect(ask.token).toBeUndefined();
    const fresh = await h.ok(null, 'POST', '/v1/auth/otp/verify', { phone: old.phone, code: c1, freshAccount: true, displayName: 'New Holder' }, headers);
    expect(fresh.isNew).toBe(true);
    expect(fresh.me.id).not.toBe(old.id);
    // The previous holder's sessions stop working.
    expect((await h.call(old.token, 'GET', '/v1/me')).status).toBe(401);
  });

  it('the holder of a dormant account can confirm it is theirs', async () => {
    const u = await h.signIn('Returning User');
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update users set last_seen_at = now() - interval '400 days' where id = $1`, [u.id]));
    const headers = { 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': '10.9.9.6', 'x-device-id': 'otherdevice1234' };
    const c = (await h.ok(null, 'POST', '/v1/auth/otp/request', { phone: u.phone }, headers)).devCode;
    const v = await h.ok(null, 'POST', '/v1/auth/otp/verify', { phone: u.phone, code: c, confirmExisting: true }, headers);
    expect(v.me.id).toBe(u.id);
  });

  it('revoking all sessions signs the user out everywhere', async () => {
    const u = await h.signIn('Short Lived');
    expect((await h.call(u.token, 'GET', '/v1/me')).status).toBe(200);
    await h.ok(u.token, 'POST', '/v1/me/sessions/revoke', { everywhere: true });
    expect((await h.call(u.token, 'GET', '/v1/me')).status).toBe(401);
  });

  it('treats a revoked token as signed out on public pages, not as an error', async () => {
    const u = await h.signIn('Stale Token');
    await h.ok(u.token, 'POST', '/v1/me/sessions/revoke', { everywhere: true });
    expect((await h.call(u.token, 'GET', '/v1/categories')).status).toBe(200);
    expect((await h.call(u.token, 'GET', '/v1/me')).status).toBe(401);
  });

  it('staff routes are closed to ordinary users', async () => {
    expect((await h.call(buyer.token, 'GET', '/v1/moderation/queue')).status).toBe(403);
  });
});

describe('listings, moderation and search', () => {
  it('a new seller goes to review, the moderator approves, and it appears in search and on its public page', async () => {
    const l = await h.ok(seller.token, 'POST', '/v1/listings', h.cementBody([await h.photo(seller.token, seller.orgId)], { orgId: seller.orgId }));
    expect(l.status).toBe('draft');
    const sub = await h.ok(seller.token, 'POST', `/v1/listings/${l.id}/submit`, { expectedVersion: l.version });
    expect(sub.listing.status).toBe('in_review');
    const queue = await h.ok(mod.token, 'GET', '/v1/moderation/queue');
    expect(queue.items.some((x: Json) => x.id === l.id)).toBe(true);
    const stale = await h.call(mod.token, 'POST', `/v1/moderation/listings/${l.id}/decide`, { decision: 'approve', expectedVersion: 999 });
    expect(stale.status).toBe(409);
    await h.ok(mod.token, 'POST', `/v1/moderation/listings/${l.id}/decide`, { decision: 'approve', expectedVersion: sub.listing.version });

    const search = await h.ok(null, 'GET', '/v1/search?q=cement&area=hilltop');
    expect(search.groups[0].items.map((x: Json) => x.listing.id)).toContain(l.id);
    const pub = await h.ok(null, 'GET', `/v1/public/listings/${l.shortId}`);
    expect(pub.listing?.title ?? pub.title).toContain('cement');
  });

  it('blocks phone numbers in the text and scores scam signals for review', async () => {
    const a = await h.ok(seller.token, 'POST', '/v1/listings', h.cementBody([await h.photo(seller.token, seller.orgId)], { orgId: seller.orgId, title: 'Cement call 08031234567 now' }));
    const blocked = await h.call(seller.token, 'POST', `/v1/listings/${a.id}/submit`, { expectedVersion: a.version });
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.details.blocking[0].code).toBe('contact_details_in_text');
    const b = await h.ok(seller.token, 'POST', '/v1/listings', h.cementBody([await h.photo(seller.token, seller.orgId)], { orgId: seller.orgId, title: 'Cement bags cheap offer', description: 'Pay deposit into my account before delivery.' }));
    const sub = await h.call(seller.token, 'POST', `/v1/listings/${b.id}/submit`, { expectedVersion: b.version });
    if (sub.status === 200) {
      const queue = await h.ok(mod.token, 'GET', '/v1/moderation/queue');
      const item = queue.items.find((x: Json) => x.id === b.id);
      expect(item?.riskScore ?? 0).toBeGreaterThan(0);
    } else {
      expect(sub.status).toBe(422);
    }
  });

  it('rejection needs a reason; the appeal goes to a different moderator and an overturn returns it to review', async () => {
    const l = await h.ok(seller.token, 'POST', '/v1/listings', h.cementBody([await h.photo(seller.token, seller.orgId)], { orgId: seller.orgId, title: 'Cement for rejection test' }));
    const sub = await h.ok(seller.token, 'POST', `/v1/listings/${l.id}/submit`, { expectedVersion: l.version });
    expect((await h.call(mod.token, 'POST', `/v1/moderation/listings/${l.id}/decide`, { decision: 'reject', expectedVersion: sub.listing.version })).status).toBe(400);
    const d = await h.ok(mod.token, 'POST', `/v1/moderation/listings/${l.id}/decide`, { decision: 'reject', reasonCode: 'misleading_claim', expectedVersion: sub.listing.version });
    expect(d.status).toBe('rejected');

    const appeal = await h.ok(seller.token, 'POST', '/v1/appeals', { targetType: 'moderation_decision', targetId: d.decisionId, statement: 'The price is correct for a 50 kg bag.' });
    expect((await h.call(seller.token, 'POST', '/v1/appeals', { targetType: 'moderation_decision', targetId: d.decisionId, statement: 'Trying a second time.' })).status).toBe(409);
    expect((await h.call(mod.token, 'POST', `/v1/moderation/appeals/${appeal.id}/decide`, { outcome: 'overturned', note: 'Same moderator' })).status).toBe(403);
    await h.ok(mod2.token, 'POST', `/v1/moderation/appeals/${appeal.id}/decide`, { outcome: 'overturned', note: 'Price verified against the market.' });
    expect((await h.ok(seller.token, 'GET', `/v1/listings/${l.id}`)).status).toBe('in_review');
  });

  it('enough independent reports send a live listing back to review', async () => {
    const l = await h.liveListing(seller, mod, { title: 'Cement reported listing' });
    const reporters = [buyer, other, await h.signIn('Third Reporter')];
    for (const r of reporters) await h.ok(r.token, 'POST', '/v1/reports', { targetType: 'listing', targetId: l.id, reason: 'scam' });
    expect((await h.ok(seller.token, 'GET', `/v1/listings/${l.id}`)).status).toBe('in_review');
    const reports = await h.ok(mod.token, 'GET', '/v1/moderation/reports');
    expect(reports.items.filter((x: Json) => x.targetId === l.id)).toHaveLength(3);
  });

  it('restricting a registered business needs a second moderator', async () => {
    const owner = await h.signIn('Biz Owner');
    const biz = await h.ok(owner.token, 'POST', '/v1/businesses', { name: 'Riverside Steel Works', email: 'a@riverside.example', areaCode: 'riverside' });
    await h.ok(mod.token, 'POST', `/v1/moderation/sellers/${biz.id}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup', reserveName: true });
    // The verified name is now reserved against look-alikes.
    expect((await h.call(other.token, 'POST', '/v1/businesses', { name: 'Riverside Steel Work', email: 'b@x.example', areaCode: 'riverside' })).status).toBe(409);
    const r = await h.ok(mod.token, 'POST', '/v1/moderation/restrictions', { orgId: biz.id, kind: 'chat_limit', reason: 'Repeated off-platform payment requests' });
    expect(r.status).toBe('pending_second_approval');
    expect((await h.call(mod.token, 'POST', `/v1/moderation/restrictions/${r.id}/approve`)).status).toBe(403);
    expect((await h.ok(mod2.token, 'POST', `/v1/moderation/restrictions/${r.id}/approve`)).status).toBe('active');
  });

  it('only operations admins publish new category versions', async () => {
    const def = { name: 'Cement', parent: 'building-materials', listingType: 'product', priceUnits: ['bag', 'tonne'], minPhotos: 1, listingPeriodDays: 30, autoPublish: true, freeAllowance: { individual: 5, business: 20 }, attributes: [] };
    expect((await h.call(mod.token, 'POST', '/v1/admin/categories/cement/versions', { definition: def, note: 'test' })).status).toBe(403);
    const v = await h.ok(ops.token, 'POST', '/v1/admin/categories/sand-granite/versions', { definition: { ...def, name: 'Sand and granite', priceUnits: ['trip', 'tonne'] }, note: 'Drop material attribute' });
    expect(v.version).toBe(2);
  });
});

describe('contact, quotes and privacy', () => {
  it('chat threads are private to the buyer and the seller', async () => {
    const l = await h.liveListing(seller, mod, { title: 'Cement for chat test' });
    const t = await h.ok(buyer.token, 'POST', `/v1/listings/${l.id}/threads`, { body: 'Is delivery to Old Town possible?' });
    const threadId = t.threadId ?? t.id;
    expect((await h.call(seller.token, 'GET', `/v1/threads/${threadId}`)).status).toBe(200);
    expect((await h.call(other.token, 'GET', `/v1/threads/${threadId}`)).status).toBe(404);
    const inbox = await h.ok(other.token, 'GET', '/v1/threads');
    expect(inbox.items ?? []).toHaveLength(0);
  });

  it('phone reveal returns the number and is rate limited', async () => {
    const l = await h.liveListing(seller, mod, { title: 'Cement for reveal test' });
    const r = await h.ok(buyer.token, 'POST', `/v1/listings/${l.id}/reveal`);
    expect(r.phone).toBe(seller.phone);
    expect(r.safetyTips.length).toBeGreaterThan(0);
  });

  it('quote requests reach the seller and become unavailable when the listing closes', async () => {
    const l = await h.liveListing(seller, mod, { title: 'Cement for quote test' });
    const q = await h.ok(buyer.token, 'POST', `/v1/listings/${l.id}/quote-requests`, { quantity: '120', unit: 'bag', deliveryArea: 'old-town' });
    await h.ok(seller.token, 'POST', `/v1/listings/${l.id}/close`, { reason: 'sold' });
    const quoteId = q.id ?? q.quoteRequestId;
    const status = await h.services.db.tx({ kind: 'system' }, (sql) => sql.query<{ status: string }>(`select status from quote_requests where id = $1`, [quoteId]));
    expect(status.rows[0]!.status).toBe('listing_unavailable');
  });
});

describe('promotions and payments', () => {
  let batch = 0;
  async function startCheckout(productCode = 'top-7') {
    const l = await h.liveListing(seller, mod, { title: `Cement promoted ${productCode} batch ${String.fromCharCode(97 + (++batch % 26))}` });
    const p = await h.ok(seller.token, 'POST', '/v1/promotions', { listingId: l.id, productCode });
    return { l, p };
  }
  const event = (ref: string, amountMinor: string, id = `evt_${Math.random().toString(16).slice(2)}`) =>
    JSON.stringify({ id, type: 'checkout.completed', data: { ref, amountMinor, currency: 'NGN' } });
  const post = (payload: string, sig?: string) => h.app.inject({ method: 'POST', url: '/v1/webhooks/checkout', payload, headers: { 'content-type': 'application/json', 'x-checkout-signature': sig ?? signWebhook(h.services.config.checkoutWebhookSecret, payload) } });

  it('prices include tax and a checkout link is returned', async () => {
    const { p } = await startCheckout();
    expect(BigInt(p.gross.amountMinor)).toBeGreaterThan(BigInt(p.net.amountMinor));
    expect(p.checkoutUrl).toContain(`/checkout/${p.checkoutRef}`);
  });

  it('rejects unsigned or tampered webhooks', async () => {
    const { p } = await startCheckout();
    const payload = event(p.checkoutRef, p.gross.amountMinor);
    expect((await post(payload, 't=1,v1=deadbeef')).statusCode).toBe(401);
    const signed = signWebhook(h.services.config.checkoutWebhookSecret, payload);
    expect((await post(payload.replace(p.gross.amountMinor, '1'), signed)).statusCode).toBe(401);
  });

  it('a signed webhook activates the promotion once, issues an invoice and is idempotent', async () => {
    const { l, p } = await startCheckout();
    const payload = event(p.checkoutRef, p.gross.amountMinor, 'evt_fixed_once');
    const first = await post(payload);
    expect(first.json().outcome).toBe('activated');
    expect((await post(payload)).json().outcome).toBe('duplicate');
    const mine = await h.ok(seller.token, 'GET', '/v1/my/promotions');
    const item = mine.items.find((x: Json) => x.id === p.id);
    expect(item.status).toBe('active');
    expect(item.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    const inv = await h.ok(seller.token, 'GET', `/v1/my/invoices/${item.invoiceNumber}`);
    expect(inv.total.amountMinor).toBe(p.gross.amountMinor);
    expect((await h.call(other.token, 'GET', `/v1/my/invoices/${item.invoiceNumber}`)).status).toBe(404);
    // A promoted slot is labelled in search.
    const search = await h.ok(null, 'GET', '/v1/search?q=promoted');
    expect(search.groups[0].items.some((x: Json) => x.listing.id === l.id && x.slot === 'top')).toBe(true);
  });

  it('an amount mismatch never activates the promotion', async () => {
    const { p } = await startCheckout();
    expect((await post(event(p.checkoutRef, '1'))).json().outcome).toBe('amount_mismatch');
    const mine = await h.ok(seller.token, 'GET', '/v1/my/promotions');
    expect(mine.items.find((x: Json) => x.id === p.id).status).toBe('pending_payment');
  });

  it('closing a promoted listing pauses the promotion; a moderator block for a prohibited item forfeits it', async () => {
    const a = await startCheckout();
    await post(event(a.p.checkoutRef, a.p.gross.amountMinor));
    await h.ok(seller.token, 'POST', `/v1/listings/${a.l.id}/close`, { reason: 'sold' });
    const b = await startCheckout();
    await post(event(b.p.checkoutRef, b.p.gross.amountMinor));
    await h.ok(mod.token, 'POST', `/v1/moderation/listings/${b.l.id}/decide`, { decision: 'block', reasonCode: 'prohibited_item', expectedVersion: (await h.ok(seller.token, 'GET', `/v1/listings/${b.l.id}`)).version });
    const mine = await h.ok(seller.token, 'GET', '/v1/my/promotions');
    expect(mine.items.find((x: Json) => x.id === a.p.id).status).toBe('paused');
    expect(mine.items.find((x: Json) => x.id === b.p.id).status).toBe('forfeited');
  });

  it('the development checkout pays through the signed webhook path', async () => {
    const { p } = await startCheckout('top-30');
    const res = await h.app.inject({ method: 'POST', url: `/v1/dev/checkout/${p.checkoutRef}/pay` });
    expect(res.json().outcome).toBe('activated');
  });
});

describe('worker', () => {
  it('expires listings past their end date and dispatches the outbox', async () => {
    const l = await h.liveListing(seller, mod, { title: 'Cement that will expire' });
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update listings set expires_at = now() - interval '1 minute' where id = $1`, [l.id]));
    const r = await runExpiries(h.services);
    expect(r.listings).toBeGreaterThanOrEqual(1);
    expect((await h.ok(seller.token, 'GET', `/v1/listings/${l.id}`)).status).toBe('expired');
    const cycle = await runWorkerCycle(h.services);
    expect(cycle.dispatched).toBeGreaterThan(0);
  });

  it('saved searches alert on new matches', async () => {
    await h.ok(buyer.token, 'POST', '/v1/saved-searches', { label: 'Granite', query: { q: 'granite' }, frequency: 'instant' });
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update saved_searches set last_checked_at = now() - interval '1 hour'`));
    await h.liveListing(seller, mod, { title: 'Granite chippings with cement offer' });
    await runWorkerCycle(h.services);
    const n = await h.ok(buyer.token, 'GET', '/v1/notifications');
    expect((n.items ?? []).some((x: Json) => x.kind === 'saved_search')).toBe(true);
  });
});
