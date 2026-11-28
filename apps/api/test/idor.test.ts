import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registry } from '../src/http/route.js';
import { harness, type Json } from './helpers.js';

/**
 * IDOR sweep (spec §19, §28): user A owns resources across the modules; a fresh user B, with no membership anywhere,
 * calls every signed-in route that takes an id with A's ids and must get 403 or 404. A direct check then reads and
 * writes as B inside a user-context transaction, so row-level security is tested without the handlers.
 */
let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let a: User, b: User, mod: User, sup: User;
const ids: Record<string, string> = {};

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const sys = async (q: string, p: unknown[] = []) => (await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(q, p))).rows as Json[];
const asB = <T>(fn: (sql: { query: (q: string, p?: unknown[]) => Promise<{ rows: Json[] }> }) => Promise<T>) => h.services.db.tx({ kind: 'user', userId: b.id }, fn as never) as Promise<T>;

beforeAll(async () => {
  h = await harness();
  mod = await h.signIn('Mona Moderator', { staff: 'moderator' });
  a = await h.veteranBusiness(await h.signIn('Ada Owner'), 'Ada Building Supplies');
  sup = await h.veteranBusiness(await h.signIn('Sam Supplier'), 'Sam Cement Depot');
  b = await h.signIn('Bola Outsider');
  await h.ok(mod.token, 'POST', `/v1/moderation/sellers/${sup.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup (test)' });

  // A as a seller: a draft, a live listing with a paid promotion (invoice), a pending one, a credit and a review.
  ids.draft = (await h.ok(a.token, 'POST', '/v1/listings', h.cementBody([await h.photo(a.token, a.orgId)], { orgId: a.orgId, title: 'Ada private draft cement' }))).id;
  ids.live = (await h.liveListing(a, mod, { title: 'Ada live cement bags' })).id;
  const paid = await h.ok(a.token, 'POST', '/v1/promotions', { listingId: ids.live, productCode: 'top-7' });
  await h.app.inject({ method: 'POST', url: `/v1/dev/checkout/${paid.checkoutRef}/pay` });
  ids.invoice = (await sys(`select invoice_number from platform_fees where purchase_id = $1`, [paid.id]))[0]!.invoice_number;
  ids.pendingPromo = (await h.ok(a.token, 'POST', '/v1/promotions', { listingId: ids.live, productCode: 'top-30' })).id;
  ids.credit = randomUUID();
  await sys(`insert into promotion_credits (id, org_id, source_purchase_id, seconds, kind) values ($1, $2, $3, 3600, 'top')`, [ids.credit, a.orgId, paid.id]);
  ids.review = randomUUID();
  await sys(`insert into reviews (id, seller_org_id, author_user_id, rating, body, basis, status) values ($1, $2, $3, 4, 'Good stock and quick replies.', 'chat', 'published')`, [ids.review, a.orgId, sup.id]);
  ids.pendingReview = randomUUID();
  await sys(`insert into reviews (id, seller_org_id, author_user_id, rating, body, basis, status) values ($1, $2, $3, 2, 'Held for moderation.', 'chat', 'pending')`, [ids.pendingReview, a.orgId, sup.id]);

  // A as a buyer of the supplier's listing: a thread, a quote request, a phone reveal, a favourite, a saved search.
  const supListing = (await h.liveListing(sup, mod, { title: 'Sam cement for projects' })).id;
  ids.thread = (await h.ok(a.token, 'POST', `/v1/listings/${supListing}/threads`, { body: 'Is this in stock?' })).threadId;
  ids.quoteRequest = (await h.ok(a.token, 'POST', `/v1/listings/${supListing}/quote-requests`, { quantity: '20', unit: 'bag', deliveryArea: 'hilltop' })).id;
  await h.ok(a.token, 'POST', `/v1/listings/${supListing}/reveal`);
  ids.reveal = (await sys(`select id from contact_reveals where viewer_user_id = $1`, [a.id]))[0]!.id;
  await h.ok(a.token, 'PUT', `/v1/favourites/${supListing}`, { saved: true });
  ids.savedSearch = (await h.ok(a.token, 'POST', '/v1/saved-searches', { label: 'Cement near me', query: { q: 'cement' } }, { 'idempotency-key': 'ada-saved-search-1' })).id;
  await h.ok(a.token, 'POST', '/v1/reports', { targetType: 'listing', targetId: supListing, reason: 'scam' });

  // A's project: a document, an estimate with lines, a payment record, an invitation, an RFQ and an awarded order.
  ids.project = (await h.ok(a.token, 'POST', '/v1/projects', { name: 'Ada bungalow', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'construction' })).id;
  const doc = await h.ok(a.token, 'POST', `/v1/projects/${ids.project}/documents`, { title: 'Ground floor plan', number: 'A-101', docType: 'drawing', discipline: 'architectural', revisionLabel: 'P1', fileName: 'A-101.pdf', bytes: 1000 });
  ids.document = doc.documentId; ids.revision = doc.revisionId;
  const est = await h.ok(a.token, 'POST', `/v1/projects/${ids.project}/estimates`, { maturity: 'client_specified', title: 'My list' });
  ids.version = est.versionId;
  ids.estimate = (await sys(`select estimate_id from estimate_versions where id = $1`, [ids.version]))[0]!.estimate_id;
  await h.ok(a.token, 'POST', `/v1/estimate-versions/${ids.version}/import`, { csv: 'description,qty,unit,section\nCement 42.5 in 50 kg bags,60,bags,substructure' });
  ids.line = (await sys(`select id from estimate_lines where version_id = $1`, [ids.version]))[0]!.id;
  await h.ok(a.token, 'POST', `/v1/projects/${ids.project}/payments`, { payee: 'Sam Cement Depot', description: 'Deposit', amount: '50000', paidOn: '2026-11-01', method: 'bank_transfer' });
  ids.payment = (await sys(`select id from payment_records where project_id = $1`, [ids.project]))[0]!.id;
  await h.ok(a.token, 'POST', `/v1/projects/${ids.project}/invitations`, { phone: '+2348079999999', role: 'viewer' });
  ids.invitation = (await sys(`select id from project_invitations where project_id = $1`, [ids.project]))[0]!.id;

  await h.ok(a.token, 'POST', `/v1/estimate-versions/${ids.version}/share`);
  ids.rfq = (await h.ok(a.token, 'POST', `/v1/projects/${ids.project}/rfqs`, { title: 'Cement for the slab', categorySlug: 'cement', estimateVersionId: ids.version, deadline: inDays(5), sourcingMode: 'open' })).id;
  const rfqView = await h.ok(a.token, 'GET', `/v1/rfqs/${ids.rfq}`);
  await h.ok(a.token, 'POST', `/v1/rfqs/${ids.rfq}/commands/publish`, { expectedVersion: rfqView.version });
  const draft = await h.ok(sup.token, 'POST', `/v1/rfqs/${ids.rfq}/quotes`);
  ids.quote = draft.quoteId; ids.quoteVersion = draft.versionId;
  const qv = await h.ok(sup.token, 'GET', `/v1/quote-versions/${draft.versionId}`);
  await h.ok(sup.token, 'PUT', `/v1/quote-versions/${draft.versionId}`, {
    expectedVersion: qv.version, validUntil: inDays(20).slice(0, 10), deliveryCharge: '15000', deliveryTaxRatePct: 7.5, paymentTerms: 'On delivery',
    lines: [{ rfqLineKey: rfqView.lines[0].lineKey, status: 'priced', unit: 'bag', quantity: '60', unitPrice: '9500', taxRatePct: 7.5 }],
  });
  await h.ok(sup.token, 'POST', `/v1/quote-versions/${draft.versionId}/submit`, { expectedVersion: (await h.ok(sup.token, 'GET', `/v1/quote-versions/${draft.versionId}`)).version });
  await h.ok(a.token, 'POST', `/v1/rfqs/${ids.rfq}/commands/close`, { expectedVersion: (await h.ok(a.token, 'GET', `/v1/rfqs/${ids.rfq}`)).version });
  ids.order = (await h.ok(a.token, 'POST', `/v1/rfqs/${ids.rfq}/award`, { quoteVersionId: draft.versionId, expectedVersion: (await h.ok(a.token, 'GET', `/v1/rfqs/${ids.rfq}`)).version, reason: 'Only quote' })).orderId;
}, 600_000);
afterAll(async () => { await h?.close(); });

/** Which of A's ids a route parameter takes, by the route's first path segment. */
const SEGMENT: Record<string, string> = {
  listings: 'draft', favourites: 'draft', 'studio/designs': 'draft', threads: 'thread', 'quote-requests': 'quoteRequest', reveals: 'reveal',
  'saved-searches': 'savedSearch', reviews: 'review', promotions: 'pendingPromo', 'promotion-credits': 'credit', 'my/invoices': 'invoice',
  projects: 'project', 'project-invitations': 'invitation', documents: 'document', revisions: 'revision', estimates: 'estimate',
  'estimate-versions': 'version', 'estimate-lines': 'line', 'payment-records': 'payment', rfqs: 'rfq', 'quote-versions': 'quoteVersion',
  quotes: 'quote', orders: 'order',
};
const SPECIAL: Record<string, () => string> = { orgId: () => a.orgId, userId: () => a.id, inviteId: () => ids.invitation!, revisionId: () => ids.revision!, number: () => ids.invoice! };
/** Enum path parameters: the first value of each. */
const ENUM_PARAM: Record<string, string> = { command: 'publish', action: 'approve' };
const ENUM_BY_URL: Record<string, Record<string, string>> = {
  '/v1/orders/:id/commands/:command': { command: 'cancel' }, '/v1/estimate-versions/:id/commands/:command': { command: 'submit' },
  '/v1/milestones/:id/commands/:command': { command: 'start' }, '/v1/variations/:id/commands/:command': { command: 'approve' },
  '/v1/payment-records/:id/:action': { action: 'acknowledge' },
};

/**
 * A body that satisfies most write schemas (zod strips unknown keys), so the call reaches the handler's own access
 * check instead of stopping at validation.
 */
const sink = () => ({
  ...h.cementBody([], { expectedVersion: 1 }),
  expectedVersion: 1, body: 'Testing access control here.', reason: 'Testing access control', note: 'Testing access control', statement: 'Testing access control here.',
  summary: 'Testing access control on this order.', saved: true, blocked: true, dealt: true, accept: true, confirmPrice: true, frequency: 'daily',
  rating: 4, price: '1000', quantity: '1', unit: 'bag', deliveryArea: 'hilltop', title: 'Access control test', name: 'Access control test',
  role: 'viewer', phone: '+2348070000999', listingId: ids.draft, type: 'non_delivery', action: 'acknowledge', outcome: 'ok', publish: false,
});

/** Routes that are open to any signed-in user by design, with the status B gets. */
const OPEN: Record<string, number[]> = {
  // B's own eligibility to review A's business: an answer about B, not A's data.
  'GET /v1/sellers/:orgId/review-eligibility': [200],
  // B has no basis to review A's business.
  'POST /v1/sellers/:orgId/reviews': [422],
  // Scoped to the caller's own rows: B's call changes nothing of A's (checked below).
  'PATCH /v1/saved-searches/:id': [200], 'DELETE /v1/saved-searches/:id': [204],
};

describe('IDOR sweep over every signed-in route with an id', () => {
  it('answers 403 or 404 to a user with no membership', async () => {
    const seen = new Set<string>();
    const routes = registry.filter((r) => r.auth === 'user' && r.url.includes(':') && !seen.has(`${r.method} ${r.url}`) && seen.add(`${r.method} ${r.url}`));
    const swept: string[] = [], realIds: string[] = [], randomIds: string[] = [], validationOnly: string[] = [], failures: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      const seg = r.url.replace(/^\/v1\//, '').split('/:')[0]!;
      let real = true;
      const url = r.url.replace(/:([a-zA-Z]+)/g, (_m, p: string) => {
        const e = ENUM_BY_URL[r.url]?.[p] ?? ENUM_PARAM[p];
        if (e) return e;
        if (SPECIAL[p]) return SPECIAL[p]!();
        const name = SEGMENT[seg];
        if (name && ids[name]) return ids[name]!;
        real = false;
        return randomUUID();
      });
      (real ? realIds : randomIds).push(key);
      let res = await h.call(b.token, r.method, url, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
      if (res.status === 400 && r.method !== 'GET') {
        const again = await h.call(b.token, r.method, url, r.method === 'DELETE' ? undefined : sink());
        res = again;
        if (again.status === 400) validationOnly.push(key);
      }
      swept.push(key);
      const ok = OPEN[key] ? OPEN[key]!.includes(res.status) : [403, 404].includes(res.status) || (res.status === 400 && r.method !== 'GET');
      if (!ok) failures.push(`${key} -> ${url} ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    console.info(`IDOR sweep: ${swept.length} routes, ${realIds.length} with A's real ids, ${randomIds.length} with unknown ids, ${validationOnly.length} stopped at validation, ${Object.keys(OPEN).length} open by design`);
    console.info(`  unknown ids: ${randomIds.join(', ')}`);
    console.info(`  validation only: ${validationOnly.join(', ')}`);
    expect(failures).toEqual([]);
    expect(swept.length).toBeGreaterThanOrEqual(100);
    // Most routes are tried against a resource A really owns, and most reach the handler's access check.
    expect(realIds.length / swept.length).toBeGreaterThan(0.6);
    expect(validationOnly.length / swept.length).toBeLessThan(0.35);
  }, 600_000);

  it('left A\'s resources as they were', async () => {
    expect((await sys(`select title, status from listings where id = $1`, [ids.draft]))[0]).toMatchObject({ title: 'Ada private draft cement', status: 'draft' });
    expect((await sys(`select frequency from saved_searches where id = $1`, [ids.savedSearch]))[0]!.frequency).toBe('daily');
    expect((await sys(`select buyer_blocked, seller_blocked from threads where id = $1`, [ids.thread]))[0]).toMatchObject({ buyer_blocked: false, seller_blocked: false });
    expect((await sys(`select status from promotion_purchases where id = $1`, [ids.pendingPromo]))[0]!.status).toBe('pending_payment');
    expect((await sys(`select used_by_purchase_id from promotion_credits where id = $1`, [ids.credit]))[0]!.used_by_purchase_id).toBeNull();
    expect((await sys(`select status from projects where id = $1`, [ids.project]))[0]!.status).toBe('active');
    expect((await sys(`select count(*)::int as n from project_members where project_id = $1`, [ids.project]))[0]!.n).toBe(1);
  });
});

describe('row-level security as B, without the handlers', () => {
  const rowsAsB = (q: string, p: unknown[] = []) => asB((sql) => sql.query(q, p)).then((r) => r.rows);

  it('hides A\'s private marketplace rows and shows the public ones', async () => {
    expect(await rowsAsB(`select id from listings where id = $1`, [ids.draft])).toHaveLength(0);
    expect(await rowsAsB(`select id from listings where id = $1`, [ids.live])).toHaveLength(1);
    expect(await rowsAsB(`select id from listing_photos where listing_id = $1`, [ids.draft])).toHaveLength(0);
    expect(await rowsAsB(`select listing_id from listing_versions where listing_id = $1`, [ids.live])).toHaveLength(0);
    expect(await rowsAsB(`select id from promotion_purchases where id = $1`, [ids.pendingPromo])).toHaveLength(0);
    expect(await rowsAsB(`select id from promotion_credits where id = $1`, [ids.credit])).toHaveLength(0);
    expect(await rowsAsB(`select id from platform_fees where org_id = $1`, [a.orgId])).toHaveLength(0);
    expect(await rowsAsB(`select id from reviews where id = $1`, [ids.pendingReview])).toHaveLength(0);
    expect(await rowsAsB(`select id from reviews where id = $1`, [ids.review])).toHaveLength(1);
    expect(await rowsAsB(`select id from reports where reporter_user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rowsAsB(`select key from idempotency_keys where user_id = $1`, [a.id])).toHaveLength(0);
    expect(await rowsAsB(`select seq from audit_events`)).toHaveLength(0);
    expect(await rowsAsB(`select id from threads where id = $1`, [ids.thread])).toHaveLength(0);
    expect(await rowsAsB(`select id from saved_searches where id = $1`, [ids.savedSearch])).toHaveLength(0);
    expect(await rowsAsB(`select id from projects where id = $1`, [ids.project])).toHaveLength(0);
    expect(await rowsAsB(`select id from orders where id = $1`, [ids.order])).toHaveLength(0);
    // Public storefront data stays readable.
    expect(await rowsAsB(`select id from organizations where id = $1`, [a.orgId])).toHaveLength(1);
    expect((await rowsAsB(`select count(*)::int as n from categories`))[0]!.n).toBeGreaterThan(0);
  });

  it('refuses server-only tables outright', async () => {
    for (const t of ['otp_codes', 'payment_webhook_events', 'rate_limit_windows', 'assistant_messages', 'assistant_models', 'ai_usage', 'ai_designs', 'architect_reviews', 'concept_choices']) {
      await expect(rowsAsB(`select 1 from ${t} limit 1`), t).rejects.toThrow(/permission denied/);
    }
    await expect(rowsAsB(`select event_id from outbox limit 1`)).rejects.toThrow(/permission denied/);
  });

  it('writes to A\'s rows affect nothing or are refused', async () => {
    expect(await rowsAsB(`update listings set title = 'x' where id = $1 returning id`, [ids.draft])).toHaveLength(0);
    expect(await rowsAsB(`update listings set title = 'x' where id = $1 returning id`, [ids.live])).toHaveLength(0);
    expect(await rowsAsB(`update organizations set name = 'x' where id = $1 returning id`, [a.orgId])).toHaveLength(0);
    expect(await rowsAsB(`update users set display_name = 'x' where id = $1 returning id`, [a.id])).toHaveLength(0);
    expect(await rowsAsB(`update promotion_purchases set status = 'cancelled' where id = $1 returning id`, [ids.pendingPromo])).toHaveLength(0);
    expect(await rowsAsB(`update reviews set reply_body = 'x' where id = $1 returning id`, [ids.review])).toHaveLength(0);
    expect(await rowsAsB(`delete from org_members where org_id = $1 returning user_id`, [a.orgId])).toHaveLength(0);
    await expect(rowsAsB(`insert into org_members (org_id, user_id, role) values ($1, $2, 'admin')`, [a.orgId, b.id])).rejects.toThrow(/row-level security/);
    await expect(rowsAsB(`insert into listings (id, short_id, seller_org_id, created_by, category_slug, category_version, listing_type, status, title, currency, unit, region_code, area_code, lat, lng)
      values ($1, 'abcdefabcdef', $2, $3, 'cement', 1, 'product', 'live', 'Fake', 'NGN', 'bag', 'r', 'hilltop', 0, 0)`, [randomUUID(), a.orgId, b.id])).rejects.toThrow(/row-level security/);
    await expect(rowsAsB(`insert into verification_checks (id, org_id, check_type, state, source) values ($1, $2, 'business_registration', 'passed', 'self')`, [randomUUID(), b.orgId])).rejects.toThrow(/row-level security/);
  });

  it('a user cannot make themself staff, mark their own promotion paid or reserve a name', async () => {
    await expect(rowsAsB(`update users set is_staff = true where id = $1`, [b.id])).rejects.toThrow(/permission denied/);
    await expect(rowsAsB(`update organizations set reserved_name = true where id = $1`, [b.orgId])).rejects.toThrow(/Only staff/);
    const own = (await h.liveListing(b, mod, { orgId: b.orgId, title: 'Bola own cement listing' })).id;
    const p = await h.ok(b.token, 'POST', '/v1/promotions', { listingId: own, productCode: 'top-7' });
    await expect(rowsAsB(`update promotion_purchases set status = 'active', active_since = now() where id = $1`, [p.id])).rejects.toThrow(/not allowed/);
    await expect(rowsAsB(`insert into promotion_purchases (id, org_id, listing_id, product_code, kind, net_minor, tax_minor, gross_minor, currency, status, remaining_seconds, created_by)
      values ($1, $2, $3, 'top-7', 'top', 0, 0, 0, 'NGN', 'paid', 604800, $4)`, [randomUUID(), b.orgId, own, b.id])).rejects.toThrow(/paid through checkout/);
  }, 120_000);
});
