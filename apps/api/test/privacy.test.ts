import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuidv7 } from '@bw/domain';
import { runRetention } from '../src/worker.js';
import { harness, type Json } from './helpers.js';

/** Data rights for the public beta (spec §20.2, §20.3, §28): export, correction, deletion and retention. */
let h: Awaited<ReturnType<typeof harness>>;
type U = Awaited<ReturnType<typeof h.signIn>>;
let mod: U;
const sys = <T>(fn: (sql: { query: (t: string, p?: unknown[]) => Promise<{ rows: any[] }> }) => Promise<T>) => h.services.db.tx({ kind: 'system' }, fn as never) as Promise<T>;
const one = async (q: string, p: unknown[] = []) => (await sys((sql) => sql.query(q, p))).rows[0];

beforeAll(async () => {
  h = await harness();
  mod = await h.signIn('Privacy Moderator', { staff: 'moderator' });
});
afterAll(() => h.close());

describe('data export', () => {
  it('holds the person’s own records and nothing about unrelated people', async () => {
    const buyer = await h.signIn('Amara Exporter');
    const seller = await h.signIn('Bisi Seller');
    const stranger = await h.signIn('Chuka Stranger');
    const listing = await h.liveListing(seller, mod, { title: 'Cement for the export test' });
    const strangerListing = await h.liveListing(stranger, mod, { title: 'Stranger granite never exported' });

    const t = await h.ok(buyer.token, 'POST', `/v1/listings/${listing.id}/threads`, { body: 'Do you deliver to Old Town?' });
    await h.ok(seller.token, 'POST', `/v1/threads/${t.threadId}/messages`, { body: 'Yes, every Tuesday.' });
    await h.ok(buyer.token, 'POST', `/v1/listings/${listing.id}/quote-requests`, { quantity: '40', unit: 'bag', deliveryArea: 'old-town', notes: 'Export test quote' });
    await h.ok(buyer.token, 'POST', '/v1/saved-searches', { label: 'Export cement', query: { q: 'cement' }, frequency: 'daily' });
    await h.ok(buyer.token, 'PUT', `/v1/favourites/${listing.id}`, { saved: true });
    await h.ok(buyer.token, 'POST', '/v1/projects', { name: 'Export family house', buildingUse: 'house', areaCode: 'hilltop' });
    await sys((sql) => sql.query(`insert into reviews (id, seller_org_id, author_user_id, rating, body, basis) values ($1, $2, $3, 4, 'Good cement, fair price.', 'chat')`, [uuidv7(), seller.orgId, buyer.id]));
    // A conversation the buyer is not part of.
    await h.ok(stranger.token, 'POST', `/v1/listings/${listing.id}/threads`, { body: 'Stranger private question' });
    await h.ok(buyer.token, 'POST', `/v1/listings/${strangerListing.id}/reveal`);

    const r = await h.ok(buyer.token, 'POST', '/v1/me/export');
    expect(r.url).toMatch(/^\/v1\/files\//);
    const file = await h.app.inject({ method: 'GET', url: r.url });
    expect(file.statusCode).toBe(200);
    expect(String(file.headers['content-disposition'])).toMatch(/attachment; filename="buildwise-data-/);
    const text = file.body;
    const x = JSON.parse(text) as Json;

    expect(x.format).toBe('buildwise-export/v1');
    expect(x.profile).toMatchObject({ id: buyer.id, displayName: 'Amara Exporter', phone: buyer.phone });
    expect(x.chats).toHaveLength(1);
    const said = x.chats[0].messages.map((m: Json) => [m.from, m.text]);
    expect(said.slice(0, 2)).toEqual([['you', 'Do you deliver to Old Town?'], ['seller', 'Yes, every Tuesday.']]);
    expect(said[2][0]).toBe('you'); // the quote request is posted into the chat
    expect(said[2][1]).toMatch(/^Quote request: 40/);
    expect(x.quoteRequests[0]).toMatchObject({ youAre: 'buyer', notes: 'Export test quote', unit: 'bag' });
    expect(x.savedSearches[0].label).toBe('Export cement');
    expect(x.favourites[0].listingId).toBe(listing.id);
    expect(x.reviewsWritten[0]).toMatchObject({ rating: 4, text: 'Good cement, fair price.' });
    expect(x.projects.map((p: Json) => p.name)).toEqual(['Export family house']);
    expect(x.phoneNumbersRevealed).toHaveLength(1);
    expect(x.organizations.map((o: Json) => o.kind)).toEqual(['personal']);

    // Nothing that identifies other people, and nothing from conversations the person is not in.
    for (const secret of [seller.phone, stranger.phone, seller.id, stranger.id, 'Chuka Stranger', 'Stranger private question']) expect(text).not.toContain(secret);
    expect(x.listings).toHaveLength(0);

    // The seller's own export holds their listing and both buyers' chats on it, without the buyers' identities.
    const sx = JSON.parse((await h.app.inject({ method: 'GET', url: (await h.ok(seller.token, 'POST', '/v1/me/export')).url })).body) as Json;
    expect(sx.listings.map((l: Json) => l.title)).toEqual(['Cement for the export test']);
    expect(sx.chats.every((c: Json) => c.youAre === 'seller')).toBe(true);
    expect(sx.reviewsOfYourBusinesses[0].text).toBe('Good cement, fair price.');
    // Ids and phone numbers of other people never appear. Names appear only inside the seller's own notifications,
    // copied as they were shown ("New message from …").
    const sText = JSON.stringify(sx);
    for (const secret of [buyer.phone, buyer.id, stranger.phone, stranger.id]) expect(sText).not.toContain(secret);
    const { notifications, ...rest } = sx;
    for (const name of ['Amara Exporter', 'Chuka Stranger']) expect(JSON.stringify(rest)).not.toContain(name);
    expect(notifications.some((n: Json) => n.title === 'New message from Amara Exporter')).toBe(true);

    const audit = await one(`select count(*)::int as n from audit_events where action = 'account.exported' and target_id = $1`, [buyer.id]);
    expect(audit.n).toBe(1);
  });

  it('is limited to a few a day and the link expires', async () => {
    const u = await h.signIn('Limit Exporter');
    const per = h.services.pack.privacy.export.perDay;
    for (let i = 0; i < per; i++) await h.ok(u.token, 'POST', '/v1/me/export');
    expect((await h.call(u.token, 'POST', '/v1/me/export')).status).toBe(429);
    expect((await h.call(null, 'POST', '/v1/me/export')).status).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/v1/files/not-a-token' })).statusCode).toBe(404);
  });
});

describe('correction', () => {
  it('changes the phone number only with a code sent to the new number', async () => {
    const u = await h.signIn('Dayo Mover');
    const taken = await h.signIn('Taken Number');
    expect((await h.call(u.token, 'POST', '/v1/me/phone/request', { phone: taken.phone })).body.error.code).toBe('PHONE_IN_USE');
    const next = '+2348099900001';
    const r = await h.ok(u.token, 'POST', '/v1/me/phone/request', { phone: next });
    expect(r.devCode).toMatch(/^\d{6}$/);
    // The code moves the account; it never signs anyone in.
    expect((await h.call(null, 'POST', '/v1/auth/otp/verify', { phone: next, code: r.devCode, displayName: 'Intruder' })).body.error.code).toBe('CODE_EXPIRED');
    expect((await h.call(u.token, 'POST', '/v1/me/phone/verify', { phone: next, code: r.devCode === '000000' ? '111111' : '000000' })).body.error.code).toBe('WRONG_CODE');
    const me = await h.ok(u.token, 'POST', '/v1/me/phone/verify', { phone: next, code: r.devCode });
    expect(me.phone).toBe(next);
    // A used code cannot be replayed.
    expect((await h.call(u.token, 'POST', '/v1/me/phone/verify', { phone: next, code: r.devCode })).status).toBe(422);
    expect((await one(`select metadata from audit_events where action = 'account.phone_changed' and target_id = $1`, [u.id])).metadata.to).not.toContain('9990000');
    // The old number now signs up a new account, not this one.
    const fresh = await h.session(u.phone, 'New Holder');
    expect(fresh.me.id).not.toBe(u.id);
  });

  it('edits the display name (and the personal seller name), email and business details', async () => {
    const u = await h.signIn('Efe Editor');
    const me = await h.ok(u.token, 'PATCH', '/v1/me', { displayName: 'Efe Edited', email: 'efe@example.test' });
    expect(me).toMatchObject({ displayName: 'Efe Edited', email: 'efe@example.test' });
    expect(me.organizations[0].name).toBe('Efe Edited');
    const b = await h.ok(u.token, 'POST', '/v1/businesses', { name: 'Efe Blocks', email: 'old@example.test', areaCode: 'hilltop' });
    const after = await h.ok(u.token, 'PATCH', `/v1/organizations/${b.id}`, { name: 'Efe Blocks and Sand', businessEmail: 'sales@example.test', areaCode: 'harbour' });
    expect(after.organizations.find((o: Json) => o.id === b.id)).toMatchObject({ name: 'Efe Blocks and Sand', businessEmail: 'sales@example.test', areaCode: 'harbour' });
    expect((await h.call(u.token, 'PATCH', `/v1/organizations/${me.organizations[0].id}`, { name: 'Not a business' })).status).toBe(400);
    await sys((sql) => sql.query(`update organizations set reserved_name = true where id = $1`, [b.id]));
    expect((await h.call(u.token, 'PATCH', `/v1/organizations/${b.id}`, { name: 'Renamed verified' })).body.error.code).toBe('NAME_VERIFIED');
  });
});

describe('deletion', () => {
  it('closes, archives and leaves per the §20.3 defaults, and keeps what the law requires', async () => {
    const d = await h.veteranBusiness(await h.signIn('Funke Leaving'), 'Funke Hardware');
    const bizId = d.orgId;
    const partner = await h.veteranBusiness(await h.signIn('Gbenga Partner'), 'Gbenga Timber');
    const buyer = await h.signIn('Hauwa Buyer');
    const personalOrg = (await h.ok(d.token, 'GET', '/v1/me')).organizations.find((o: Json) => o.kind === 'personal').id;

    const bizListing = await h.liveListing({ token: d.token, orgId: bizId }, mod, { title: 'Funke business cement' });
    const ownListing = await h.liveListing({ token: d.token, orgId: personalOrg }, mod, { title: 'Funke personal cement' });
    const partnerListing = await h.liveListing(partner, mod, { title: 'Gbenga timber stays' });
    // Funke is an admin of Gbenga's business, and a member of Gbenga's project.
    await sys((sql) => sql.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'admin')`, [partner.orgId, d.id]));
    const own = await h.ok(d.token, 'POST', '/v1/projects', { name: 'Funke solo house', buildingUse: 'house', areaCode: 'hilltop' });
    const shared = await h.ok(partner.token, 'POST', '/v1/projects', { name: 'Gbenga shared house', buildingUse: 'house', areaCode: 'hilltop' });
    await sys((sql) => sql.query(`insert into project_members (project_id, user_id, role) values ($1, $2, 'collaborator')`, [shared.id, d.id]));
    const t = await h.ok(buyer.token, 'POST', `/v1/listings/${ownListing.id}/threads`, { body: 'Still available?' });
    await h.ok(d.token, 'POST', '/v1/saved-searches', { label: 'Funke search', query: { q: 'sand' }, frequency: 'daily' });
    await sys((sql) => sql.query(`insert into reviews (id, seller_org_id, author_user_id, rating, body, basis) values ($1, $2, $3, 5, 'Funke wrote this review.', 'chat')`, [uuidv7(), partner.orgId, d.id]));
    await h.ok(d.token, 'POST', '/v1/me/export');

    const plan = await h.ok(d.token, 'GET', '/v1/me/deletion');
    expect(plan.closesBusinesses.map((o: Json) => o.name)).toEqual(['Funke Hardware']);
    expect(plan.leavesBusinesses.map((o: Json) => o.name)).toEqual(['Gbenga Timber']);
    expect(plan.archivesProjects.map((p: Json) => p.name)).toEqual(['Funke solo house']);
    expect(plan.leavesProjects.map((p: Json) => p.name)).toEqual(['Gbenga shared house']);
    expect(plan.retained.join(' ')).toMatch(/audit log/i);

    expect((await h.call(d.token, 'DELETE', '/v1/me', { confirm: 'nope' })).status).toBe(400);
    const r = await h.ok(d.token, 'DELETE', '/v1/me', { confirm: 'DELETE' });
    expect(r).toMatchObject({ deleted: true, closedListings: 2, closedBusinesses: 1, archivedProjects: 1, leftBusinesses: 1, leftProjects: 1 });
    expect(r.retained.length).toBeGreaterThan(2);

    expect((await h.call(d.token, 'GET', '/v1/me')).status).toBe(401);
    const status = async (id: string) => (await one(`select status, close_reason from listings where id = $1`, [id]));
    expect(await status(bizListing.id)).toMatchObject({ status: 'closed', close_reason: 'account_deleted' });
    expect(await status(ownListing.id)).toMatchObject({ status: 'closed', close_reason: 'account_deleted' });
    expect((await status(partnerListing.id)).status).toBe('live');
    expect((await one(`select closed_at from organizations where id = $1`, [bizId])).closed_at).not.toBeNull();
    expect(await one(`select 1 as x from org_members where org_id = $1 and user_id = $2`, [partner.orgId, d.id])).toBeUndefined();
    expect((await one(`select status from projects where id = $1`, [own.id])).status).toBe('archived');
    expect(await one(`select 1 as x from project_members where project_id = $1 and user_id = $2`, [shared.id, d.id])).toBeUndefined();
    expect((await one(`select status from reviews where author_user_id = $1`, [d.id])).status).toBe('removed');
    expect((await one(`select count(*)::int as n from saved_searches where user_id = $1`, [d.id])).n).toBe(0);
    expect((await one(`select count(*)::int as n from data_exports where user_id = $1 and purged_at is null`, [d.id])).n).toBe(0);
    const u = await one(`select * from users where id = $1`, [d.id]);
    expect(u).toMatchObject({ status: 'deleted', display_name: 'Deleted user', phone_e164: null, email: null });
    expect(u.erasure_snapshot.phone).toBe(d.phone);
    expect(u.deleted_at).not.toBeNull();
    // The other party keeps the chat, shown from "Deleted user".
    const thread = await h.ok(buyer.token, 'GET', `/v1/threads/${t.threadId}`);
    expect(JSON.stringify(thread)).not.toContain('Funke Leaving');
    expect((await one(`select count(*)::int as n from audit_events where action = 'account.deleted' and target_id = $1`, [d.id])).n).toBe(1);
  });

  it('refuses to delete the only operations admin', async () => {
    const h2 = await harness();
    try {
      const ops = await h2.signIn('Only Ops', { staff: 'ops_admin' });
      expect((await h2.call(ops.token, 'DELETE', '/v1/me', { confirm: 'DELETE' })).body.error.code).toBe('LAST_OPS_ADMIN');
    } finally { await h2.close(); }
  });
});

describe('retention jobs', () => {
  it('purge and pseudonymise on the pack windows, and a second run changes nothing', async () => {
    const r = h.services.pack.privacy.retention;
    const leaver = await h.signIn('Ifeoma Retained');
    const seller = await h.signIn('Jide Seller');
    const keeper = await h.signIn('Kemi Keeps Chatting');
    const listing = await h.liveListing(seller, mod, { title: 'Cement for retention' });
    const t = await h.ok(leaver.token, 'POST', `/v1/listings/${listing.id}/threads`, { body: 'Leaver message to be redacted' });
    const kept = await h.ok(keeper.token, 'POST', `/v1/listings/${listing.id}/threads`, { body: 'Active member message stays' });
    await h.ok(leaver.token, 'POST', `/v1/listings/${listing.id}/reveal`);
    // A live account's old export archive (a deleted account's archives go at deletion).
    await h.ok(keeper.token, 'POST', '/v1/me/export');
    const exportKey = (await one(`select storage_key from data_exports where user_id = $1`, [keeper.id])).storage_key;
    expect(await h.services.storage.exists(exportKey)).toBe(true);
    await h.ok(leaver.token, 'DELETE', '/v1/me', { confirm: 'DELETE' });

    // Age everything past its window.
    await sys(async (sql) => {
      await sql.query(`update users set deleted_at = now() - make_interval(days => $2) where id = $1`, [leaver.id, r.deletedAccountDays + 1]);
      await sql.query(`update threads set last_message_at = now() - make_interval(days => $2) where id = any($1::uuid[])`, [[t.threadId, kept.threadId], r.deletedUserChatDays + 1]);
      await sql.query(`update contact_reveals set created_at = now() - make_interval(days => $2), device_id = 'device-retention-1' where viewer_user_id = $1`, [leaver.id, r.contactRevealPseudonymiseDays + 1]);
      await sql.query(`update sessions set revoked_at = now() - make_interval(days => $2) where user_id = $1`, [leaver.id, r.sessionDays + 1]);
      await sql.query(`update data_exports set created_at = now() - make_interval(days => $2) where user_id = $1`, [keeper.id, h.services.pack.privacy.export.keepDays + 1]);
    });
    // An old reveal by someone else, past the full window.
    await h.ok(keeper.token, 'POST', `/v1/listings/${listing.id}/reveal`);
    await sys((sql) => sql.query(`update contact_reveals set created_at = now() - make_interval(days => $2) where viewer_user_id = $1`, [keeper.id, r.contactRevealDays + 1]));

    const first = await runRetention(h.services);
    expect(first.accountsPseudonymised).toBeGreaterThanOrEqual(1);
    expect(first.chatThreadsRedacted).toBe(1);
    expect(first.revealsDeleted).toBeGreaterThanOrEqual(1);
    expect(first.revealsPseudonymised).toBeGreaterThanOrEqual(1);
    expect(first.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect(first.exportsPurged).toBeGreaterThanOrEqual(1);

    const u = await one(`select * from users where id = $1`, [leaver.id]);
    expect(u.erasure_snapshot).toBeNull();
    expect(u.pseudonymised_at).not.toBeNull();
    const msgs = (await sys((sql) => sql.query(`select thread_id, body, redacted_at from messages where thread_id = any($1::uuid[])`, [[t.threadId, kept.threadId]]))).rows;
    expect(msgs.find((m) => m.thread_id === t.threadId)).toMatchObject({ body: '' });
    expect(msgs.find((m) => m.thread_id === kept.threadId)).toMatchObject({ body: 'Active member message stays', redacted_at: null });
    expect((await one(`select device_id from contact_reveals where viewer_user_id = $1`, [leaver.id])).device_id).toBeNull();
    expect(await one(`select 1 as x from contact_reveals where viewer_user_id = $1`, [keeper.id])).toBeUndefined();
    expect((await one(`select count(*)::int as n from sessions where user_id = $1`, [leaver.id])).n).toBe(0);
    expect(await h.services.storage.exists(exportKey)).toBe(false);
    expect((await one(`select count(*)::int as n from audit_events where action = 'account.pseudonymised' and target_id = $1`, [leaver.id])).n).toBe(1);

    const second = await runRetention(h.services);
    expect(Object.values(second).every((n) => n === 0)).toBe(true);
    expect((await one(`select count(*)::int as n from audit_events where action = 'account.pseudonymised' and target_id = $1`, [leaver.id])).n).toBe(1);
  });

  it('keeps a deleted user’s chat while a report holds it', async () => {
    const leaver = await h.signIn('Lola Reported');
    const seller = await h.signIn('Musa Seller');
    const listing = await h.liveListing(seller, mod, { title: 'Cement under report' });
    const t = await h.ok(leaver.token, 'POST', `/v1/listings/${listing.id}/threads`, { body: 'Reported message kept' });
    const msg = await one(`select id from messages where thread_id = $1`, [t.threadId]);
    await sys((sql) => sql.query(`insert into reports (id, target_type, target_id, reason, reporter_user_id) values ($1, 'message', $2, 'scam', $3)`, [uuidv7(), msg.id, seller.id]));
    await h.ok(leaver.token, 'DELETE', '/v1/me', { confirm: 'DELETE' });
    await sys((sql) => sql.query(`update threads set last_message_at = now() - interval '800 days' where id = $1`, [t.threadId]));
    await runRetention(h.services);
    expect((await one(`select body from messages where id = $1`, [msg.id])).body).toBe('Reported message kept');
  });
});
