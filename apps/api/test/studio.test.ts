import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { designFromLayout, type AiLayout } from '@bw/domain';
import { one } from '../src/db/database.js';
import { harness, type Json } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h?.close(); });

const plot = { widthM: 18.29, depthM: 36.58 };
const brief = { type: 'bungalow' as const, bedrooms: 3, ensuite: false };

const L: AiLayout = {
  name: 'Garden L', idea: 'A living wing to the street and a bedroom wing around a garden.', roof: 'hip',
  concept: { title: 'The Garden House', story: 'You step in to a bright living room.', moves: ['Living wing to the street.', 'Bedrooms on the quiet side.'], palette: { walls: 'White render', accents: 'Timber louvres', roof: 'Charcoal tiles' } },
  blocks: [{ id: 'A', name: 'Living wing', x: 1.5, y: 6, w: 15, d: 5, storeys: 1 }, { id: 'B', name: 'Bedroom wing', x: 1.5, y: 11, w: 9.6, d: 12, storeys: 1 }],
  rooms: [
    { block: 'A', storey: 0, kind: 'living', name: 'Living room', x: 1.5, y: 6, w: 7, d: 5 },
    { block: 'A', storey: 0, kind: 'dining', name: 'Dining', x: 8.5, y: 6, w: 4, d: 5 },
    { block: 'A', storey: 0, kind: 'kitchen', name: 'Kitchen', x: 12.5, y: 6, w: 4, d: 5 },
    { block: 'B', storey: 0, kind: 'corridor', name: 'Bedroom lobby', x: 5.1, y: 11, w: 1.8, d: 6 },
    { block: 'B', storey: 0, kind: 'master', name: 'Master bedroom', x: 1.5, y: 11, w: 3.6, d: 4 },
    { block: 'B', storey: 0, kind: 'bathroom', name: 'Bathroom', x: 1.5, y: 15, w: 3.6, d: 2 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 2', x: 6.9, y: 11, w: 4.2, d: 3 },
    { block: 'B', storey: 0, kind: 'store', name: 'Store', x: 6.9, y: 14, w: 4.2, d: 1.5 },
    { block: 'B', storey: 0, kind: 'wc', name: 'Guest WC', x: 6.9, y: 15.5, w: 4.2, d: 1.5 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 3', x: 1.5, y: 17, w: 3.3, d: 6 },
    { block: 'B', storey: 0, kind: 'lounge', name: 'Family lounge', x: 4.8, y: 17, w: 6.3, d: 6 },
  ],
};
const broken: AiLayout = { ...L, name: 'Broken', rooms: L.rooms.filter((r) => r.name !== 'Bedroom 3') };

let shade = 0;
async function snapshot() {
  shade += 53;
  const png = await sharp({ create: { width: 800, height: 500, channels: 3, background: { r: 120 + (shade % 100), g: 170, b: 220 } } })
    .composite([{ input: Buffer.from(`<svg width="800" height="500"><rect x="${150 + (shade % 200)}" y="200" width="420" height="200" fill="#f3f0e8"/><polygon points="130,200 600,200 400,${90 + (shade % 60)}" fill="#333"/></svg>`), top: 0, left: 0 }])
    .png().toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

const publishBody = async (orgId: string, over: Json = {}) => ({
  orgId, layout: L, brief, plot, title: 'The Garden House, 3-bedroom L bungalow', description: 'Living wing to the street, bedrooms around a quiet garden.',
  priceNaira: 350000, drawingsIncluded: 'Architectural plans, elevations and sections', architectRegistration: 'ARC-TEST-0042', rightsConfirmed: true,
  photo: await snapshot(), ...over,
});

let moderator: Awaited<ReturnType<typeof h.signIn>>;
let architect: Awaited<ReturnType<typeof h.signIn>>;
let listingId = '';

describe('Design Studio publishing', () => {
  beforeAll(async () => {
    moderator = await h.signIn('Mo (moderator)', { staff: 'moderator' });
    architect = await h.veteranBusiness(await h.signIn('Ada (architect)'), 'Ada Design Studio');
  });

  it('refuses an architect whose organisation has no passed professional credential', async () => {
    const me = await h.ok(architect.token, 'GET', '/v1/studio/me');
    expect(me.certified).toBe(false);
    expect(me.orgs.find((o: Json) => o.id === architect.orgId)).toMatchObject({ name: 'Ada Design Studio', certified: false });
    const r = await h.call(architect.token, 'POST', '/v1/studio/designs', await publishBody(architect.orgId));
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('NOT_CERTIFIED');
    expect(r.body.error.message).toMatch(/verif/i);
    // A business registration alone is not enough.
    await h.ok(moderator.token, 'POST', `/v1/moderation/sellers/${architect.orgId}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Registry lookup' });
    expect((await h.call(architect.token, 'POST', '/v1/studio/designs', await publishBody(architect.orgId))).status).toBe(403);
    // Someone else cannot publish for the studio.
    const stranger = await h.signIn('Stranger');
    expect((await h.call(stranger.token, 'POST', '/v1/studio/designs', await publishBody(architect.orgId))).status).toBe(403);
  });

  it('a certified architect publishes: the listing goes to review with attributes from the design, and the file is stored', async () => {
    await h.ok(moderator.token, 'POST', `/v1/moderation/sellers/${architect.orgId}/checks`, { checkType: 'professional_credential', state: 'passed', source: 'Architects register lookup' });
    const me = await h.ok(architect.token, 'GET', '/v1/studio/me');
    expect(me.certified).toBe(true);
    expect(me.orgs.find((o: Json) => o.id === architect.orgId).certified).toBe(true);

    const body = await publishBody(architect.orgId);
    const r = await h.call(architect.token, 'POST', '/v1/studio/designs', body, { 'idempotency-key': 'studio-publish-1' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: 'in_review' });
    listingId = r.body.listingId;
    // Retrying with the same key returns the same listing instead of a second one.
    const again = await h.call(architect.token, 'POST', '/v1/studio/designs', body, { 'idempotency-key': 'studio-publish-1' });
    expect(again.body.listingId).toBe(listingId);

    const l = await h.ok(architect.token, 'GET', `/v1/listings/${listingId}`);
    const design = designFromLayout(plot, brief, L, 'x', h.services.pack.design).design!;
    expect(l).toMatchObject({ categorySlug: 'house-plans', status: 'in_review', unit: 'set', price: { amountMinor: '35000000', currency: 'NGN' }, sellerOrgId: architect.orgId });
    expect(l.attributes).toEqual({
      bedrooms: 3, storeys: '1', floor_area_m2: Math.round(design.metrics.grossFloorM2), min_plot_width_m: 18.29, min_plot_depth_m: 36.58,
      drawings_included: 'Architectural plans, elevations and sections', architect_registration: 'ARC-TEST-0042', rights_confirmed: true,
    });
    expect(l.photos).toHaveLength(1);

    const file = await h.services.db.tx({ kind: 'system' }, (sql) => one<Json>(sql, `select org_id, layout, brief, plot from design_files where listing_id = $1`, [listingId]));
    expect(file).toMatchObject({ org_id: architect.orgId, plot, brief: { type: 'bungalow', bedrooms: 3, ensuite: false } });
    expect(file!.layout.name).toBe('Garden L');
    expect(file!.layout.rooms).toHaveLength(L.rooms.length);
    const audited = await h.services.db.tx({ kind: 'system' }, (sql) => one<Json>(sql, `select metadata from audit_events where action = 'listing.created' and target_id = $1`, [listingId]));
    expect(audited!.metadata).toEqual({ source: 'studio' });
    // It is in the moderation queue.
    const q = await h.ok(moderator.token, 'GET', '/v1/moderation/queue');
    expect(q.items.some((i: Json) => i.id === listingId)).toBe(true);
  });

  it('refuses a design that fails BuildWise checks, with the problems, and creates nothing', async () => {
    const before = await h.services.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql, `select count(*)::int as n from listings where seller_org_id = $1`, [architect.orgId]));
    const r = await h.call(architect.token, 'POST', '/v1/studio/designs', await publishBody(architect.orgId, { layout: broken }));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('DESIGN_PROBLEMS');
    expect(r.body.error.details.problems.join(' ')).toMatch(/not covered by any room/);
    const bad = await h.call(architect.token, 'POST', '/v1/studio/designs', await publishBody(architect.orgId, { priceNaira: 0, rightsConfirmed: false, photo: 'data:image/jpeg;base64,AAAA' }));
    expect(bad.status).toBe(400);
    expect(bad.body.error.fieldErrors.map((f: Json) => f.path)).toEqual(expect.arrayContaining(['priceNaira', 'rightsConfirmed', 'photo']));
    const after = await h.services.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql, `select count(*)::int as n from listings where seller_org_id = $1`, [architect.orgId]));
    expect(after!.n).toBe(before!.n);
  });

  it('the design file is hidden until the listing is live, then public; the listing page says it has one', async () => {
    const buyer = await h.signIn('Bola (buyer)');
    expect((await h.call(null, 'GET', `/v1/studio/designs/${listingId}`)).status).toBe(404);
    expect((await h.call(buyer.token, 'GET', `/v1/studio/designs/${listingId}`)).status).toBe(404);
    expect((await h.ok(architect.token, 'GET', `/v1/studio/designs/${listingId}`)).status).toBe('in_review');
    expect((await h.call(moderator.token, 'GET', `/v1/studio/designs/${listingId}`)).status).toBe(200);

    const l = await h.ok(architect.token, 'GET', `/v1/listings/${listingId}`);
    await h.ok(moderator.token, 'POST', `/v1/moderation/listings/${listingId}/decide`, { decision: 'approve', expectedVersion: l.version });

    const d = await h.ok(null, 'GET', `/v1/studio/designs/${listingId}`);
    expect(d).toMatchObject({ listingId, title: 'The Garden House, 3-bedroom L bungalow', status: 'live', plot, sellerName: 'Ada Design Studio', verified: true, certified: true });
    expect(d.layout.name).toBe('Garden L');
    expect(d.brief).toMatchObject({ type: 'bungalow', bedrooms: 3 });

    // Anonymous and signed-in visitors (row-level security applies to them) both see the flag.
    const shortId = l.shortId as string;
    expect((await h.ok(null, 'GET', `/v1/public/listings/${shortId}`)).hasDesignFile).toBe(true);
    expect((await h.ok(buyer.token, 'GET', `/v1/public/listings/${shortId}`)).hasDesignFile).toBe(true);
    // An ordinary listing has none.
    const supplier = await h.veteranBusiness(await h.signIn('Sam (supplier)'), 'Sam Supplies');
    const cement = await h.liveListing(supplier, moderator);
    expect((await h.ok(null, 'GET', `/v1/public/listings/${cement.shortId}`)).hasDesignFile).toBe(false);
    expect((await h.call(null, 'GET', `/v1/studio/designs/${cement.id}`)).status).toBe(404);
    // Signed-in non-owners cannot read the file straight from the table.
    const direct = await h.services.db.tx({ kind: 'user', userId: buyer.id }, (sql) => one<Json>(sql, `select listing_id from design_files where listing_id = $1`, [listingId]));
    expect(direct).toBeNull();
  });

  it('the owner replaces the design: it is re-checked, and a live listing goes back to review', async () => {
    const stranger = await h.signIn('Not the owner');
    expect((await h.call(stranger.token, 'PUT', `/v1/studio/designs/${listingId}`, { layout: L })).status).toBe(404);

    const bad = await h.call(architect.token, 'PUT', `/v1/studio/designs/${listingId}`, { layout: broken });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('DESIGN_PROBLEMS');
    expect((await h.ok(null, 'GET', `/v1/studio/designs/${listingId}`)).layout.name).toBe('Garden L');

    const before = await h.ok(architect.token, 'GET', `/v1/listings/${listingId}`);
    const renamed = { ...L, name: 'Garden L, revised', idea: 'The same L with a calmer garden side.' };
    const r = await h.ok(architect.token, 'PUT', `/v1/studio/designs/${listingId}`, { layout: renamed, photo: await snapshot(), expectedVersion: before.version });
    expect(r).toMatchObject({ listingId, status: 'in_review', version: before.version + 1 });
    expect(r.listing.photos).toHaveLength(1);
    expect(r.listing.photos[0].id).not.toBe(before.photos[0].id);
    expect((await h.call(null, 'GET', `/v1/studio/designs/${listingId}`)).status).toBe(404);
    const own = await h.ok(architect.token, 'GET', `/v1/studio/designs/${listingId}`);
    expect(own.layout.name).toBe('Garden L, revised');
    const stale = await h.call(architect.token, 'PUT', `/v1/studio/designs/${listingId}`, { layout: L, expectedVersion: before.version });
    expect(stale.status).toBe(409);
  });
});
