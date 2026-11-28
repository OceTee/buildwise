import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEMO_MARKET } from '@bw/domain';
import { harness, type Json } from './helpers.js';

/**
 * Public-beta feedback: anyone can send it (validated, contact details removed, limited per IP and device), only
 * staff list it, and status changes are audited. `/v1/policies` serves the pack's public rules.
 */
let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let mod: User, person: User;

let ipSeq = 0;
const from = (device?: string) => ({
  'x-internal-secret': h.services.config.internalSecret,
  'x-client-ip': `192.0.2.${++ipSeq}`,
  ...(device ? { 'x-device-id': device } : {}),
});
const send = (body: Json, headers: Json, token: string | null = null) => h.call(token, 'POST', '/v1/feedback', body, headers);

beforeAll(async () => {
  h = await harness();
  mod = await h.signIn('Ada Moderator', { staff: 'moderator' });
  person = await h.signIn('Tunde Builder');
});
afterAll(() => h.close());

describe('POST /v1/feedback', () => {
  it('accepts a report from someone signed out, keeping only the page path and removing contact details', async () => {
    const r = await send({ category: 'bug', message: 'The plan does not load. Call me on 0803 123 4567 or a@b.example', pageUrl: 'https://buildwise.example/build?q=my+secret+plot', contactOk: true, contact: 'ada@example.test' }, from('device-aaaa-1111'));
    expect(r.status).toBe(201);
    expect(r.body.contactRemoved).toBe(true);
    const list = await h.ok(mod.token, 'GET', '/v1/moderation/feedback');
    const item = list.items.find((x: Json) => x.id === r.body.id);
    expect(item.message).toContain('[number]');
    expect(item.message).toContain('[email]');
    expect(item.message).not.toContain('0803');
    expect(item.pagePath).toBe('/build');
    expect(item.contact).toBe('ada@example.test');
    expect(item.flags).toContain('contact_removed');
    expect(item.status).toBe('open');
    expect(item.signedIn).toBe(false);
  });

  it('validates the category, the message and the contact', async () => {
    expect((await send({ category: 'complaint', message: 'This is long enough.' }, from())).status).toBe(400);
    const short = await send({ category: 'idea', message: 'too short' }, from());
    expect(short.status).toBe(400);
    expect(short.body.error.fieldErrors[0].path).toBe('message');
    const onlyNumber = await send({ category: 'other', message: '+234 803 123 4567' }, from());
    expect(onlyNumber.status).toBe(400);
    const badContact = await send({ category: 'idea', message: 'Please add a dark mode for drawings.', contactOk: true, contact: 'not a contact' }, from());
    expect(badContact.status).toBe(400);
    expect(badContact.body.error.fieldErrors[0].path).toBe('contact');
    const noConsent = await send({ category: 'idea', message: 'Please add a dark mode for drawings.', contact: 'me@example.test' }, from());
    expect(noConsent.status).toBe(400);
    expect(noConsent.body.error.fieldErrors[0].path).toBe('contactOk');
    expect((await send({ category: 'idea', message: 'x'.repeat(2001) }, from())).status).toBe(400);
  });

  it('flags links and scam phrases for staff without refusing them', async () => {
    const r = await send({ category: 'other', message: 'A seller asked me for a booking fee, see https://scam.example' }, from());
    expect(r.status).toBe(201);
    const item = (await h.ok(mod.token, 'GET', '/v1/moderation/feedback')).items.find((x: Json) => x.id === r.body.id);
    expect(item.flags).toEqual(expect.arrayContaining(['link', 'scam_signals']));
  });

  it('limits feedback per device and per IP each hour', async () => {
    const perDevice = DEMO_MARKET.limits.feedbackPerDevicePerHour;
    for (let i = 0; i < perDevice; i++) expect((await send({ category: 'idea', message: `Idea number ${i} for the build page.` }, from('device-limit-0001'))).status).toBe(201);
    const blocked = await send({ category: 'idea', message: 'One idea too many from this device.' }, from('device-limit-0001'));
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');

    const ip = { 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': '198.51.100.7' };
    for (let i = 0; i < DEMO_MARKET.limits.feedbackPerIpPerHour; i++) expect((await send({ category: 'bug', message: `Bug number ${i} on the market page.` }, ip)).status).toBe(201);
    expect((await send({ category: 'bug', message: 'One bug too many from this IP.' }, ip)).status).toBe(429);
  });

  it('records who sent it when signed in, and shows their number to staff only with consent', async () => {
    const quiet = await send({ category: 'idea', message: 'Show the price per bag on cards.' }, from(), person.token);
    const reply = await send({ category: 'idea', message: 'Let me compare two designs side by side.', contactOk: true }, from(), person.token);
    const items = (await h.ok(mod.token, 'GET', '/v1/moderation/feedback')).items as Json[];
    const q = items.find((x) => x.id === quiet.body.id)!;
    const r = items.find((x) => x.id === reply.body.id)!;
    expect(q.signedIn).toBe(true);
    expect(q.sender).toBe('Tunde Builder');
    expect(q.contact).toBeNull();
    expect(r.contact).toBe(person.phone);
  });
});

describe('staff feedback list', () => {
  it('is staff only', async () => {
    expect((await h.call(null, 'GET', '/v1/moderation/feedback')).status).toBe(401);
    expect((await h.call(person.token, 'GET', '/v1/moderation/feedback')).status).toBe(403);
    const any = (await h.ok(mod.token, 'GET', '/v1/moderation/feedback')).items[0];
    expect((await h.call(person.token, 'POST', `/v1/moderation/feedback/${any.id}/commands/triage`, {})).status).toBe(403);
    // Staff roles outside STAFF_ACCESS.feedback are refused too.
    const qs = await h.signIn('Quinn Reviewer', { staff: 'qs_reviewer' });
    expect((await h.call(qs.token, 'GET', '/v1/moderation/feedback')).status).toBe(403);
  });

  it('moves feedback open → triaged → closed → open, refuses invalid moves and audits each change', async () => {
    const r = await send({ category: 'bug', message: 'Drawings page prints blank in Firefox.' }, from());
    const id = r.body.id as string;
    expect((await h.call(mod.token, 'POST', `/v1/moderation/feedback/${id}/commands/reopen`, {})).status).toBe(409);
    const t = await h.ok(mod.token, 'POST', `/v1/moderation/feedback/${id}/commands/triage`, { note: 'Reproduced on Firefox 140.' });
    expect(t.status).toBe('triaged');
    expect(t.staffNote).toBe('Reproduced on Firefox 140.');
    expect(t.updatedBy).toBe('Ada Moderator');
    expect((await h.ok(mod.token, 'POST', `/v1/moderation/feedback/${id}/commands/close`, {})).status).toBe('closed');
    expect((await h.ok(mod.token, 'GET', '/v1/moderation/feedback?status=closed')).items.map((x: Json) => x.id)).toContain(id);
    expect((await h.ok(mod.token, 'POST', `/v1/moderation/feedback/${id}/commands/reopen`, {})).status).toBe('open');
    const audit = await h.services.db.tx({ kind: 'system' }, async (sql) => (await sql.query(`select action, actor_user_id, reason from audit_events where target_type = 'feedback' and target_id = $1 order by seq`, [id])).rows as Json[]);
    expect(audit.map((a) => a.action)).toEqual(['feedback.triage', 'feedback.close', 'feedback.reopen']);
    expect(audit[0]!.actor_user_id).toBe(mod.id);
    expect(audit[0]!.reason).toBe('Reproduced on Firefox 140.');
  });

  it('a signed-in person cannot read feedback through RLS, other than their own', async () => {
    const rows = await h.services.db.tx({ kind: 'user', userId: person.id }, async (sql) => (await sql.query(`select user_id from feedback`)).rows as Json[]);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((x) => x.user_id === person.id)).toBe(true);
  });

  it('from user context nobody inserts or deletes feedback, a non-staff user changes nothing, and staff change only triage columns', async () => {
    const asUser = (userId: string, q: string, p: unknown[] = [], staff = false) => h.services.db.tx({ kind: 'user', userId, staff }, async (sql) => (await sql.query(q, p)).rows as Json[]);
    const mine = (await asUser(person.id, `select id from feedback limit 1`))[0]!.id;
    await expect(asUser(person.id, `insert into feedback (id, category, message, ip_hash) values (gen_random_uuid(), 'bug', 'Injected from user context.', 'x')`)).rejects.toThrow(/permission denied/);
    await expect(asUser(person.id, `delete from feedback where id = $1`, [mine])).rejects.toThrow(/permission denied/);
    expect(await asUser(person.id, `update feedback set status = 'closed' where id = $1 returning id`, [mine])).toEqual([]);
    expect((await asUser(mod.id, `select count(*)::int as n from feedback`, [], true))[0]!.n).toBeGreaterThan(2);
    // Without a verified staff session (B's app_is_staff), a moderator's account sees only its own rows.
    expect((await asUser(mod.id, `select count(*)::int as n from feedback`))[0]!.n).toBe(0);
    await expect(asUser(mod.id, `update feedback set message = 'rewritten' where id = $1`, [mine], true)).rejects.toThrow(/permission denied/);
  });
});

describe('GET /v1/policies', () => {
  it('serves the pack rules for the public pages', async () => {
    const p = await h.ok(null, 'GET', '/v1/policies');
    expect(p.market.illustrative).toBe(true);
    expect(p.itemRules.prohibited.map((x: Json) => x.title)).toContain('Land, plots and property');
    expect(p.prohibitedTerms).toEqual(DEMO_MARKET.prohibitedTerms);
    expect(p.retention.length).toBeGreaterThan(5);
    expect(p.privacy.deletedAccountDays).toBe(DEMO_MARKET.privacy.retention.deletedAccountDays);
    expect(p.privacy.retainedAfterDeletion.length).toBeGreaterThan(0);
    expect(p.categories.find((c: Json) => c.slug === 'cement').listingPeriodDays).toBe(30);
  });
});
