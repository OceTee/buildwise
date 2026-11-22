import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { designFromLayout, findArea, listingPath, normaliseBrief, validPlot, type AiLayout, type Design, type DesignBrief, type Plot } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { ApiError, audit, badRequest, conflict, notFound } from '../platform/platform.js';
import { actingOrg } from './identity.js';
import { attachPhotos, createListing, listingInput, ownerView, recordVersion, requireOwnListing, storePhoto, submitLike } from './listings.js';

/**
 * Design Studio: certified architects publish the designs they draw in BuildWise as `house-plans` listings, and
 * buyers open them on their own plot (/build?plan=<listingId>).
 *
 *  - GET  /v1/studio/me                     whether the user may publish, per organisation;
 *  - POST /v1/studio/designs                checks the design, creates the listing (same paths as /v1/listings) and submits it for review;
 *  - PUT  /v1/studio/designs/:listingId     replaces the design; a live listing goes back to review;
 *  - GET  /v1/studio/designs/:listingId     the design file, once the listing is live (owners and staff see it before).
 *
 * Certified = the organisation has a passed, unexpired `professional_credential` verification check.
 */
const CATEGORY = 'house-plans';
const PNG_PREFIX = 'data:image/png;base64,';
/** The snapshot as a data URL (~3 MiB of PNG), as for photoreal renders. */
const MAX_PHOTO_DATA_URL = 4 * 1024 * 1024;
const MAX_LAYOUT_JSON = 512 * 1024;
const MAX_STOREYS = 3; // the house-plans `storeys` attribute goes up to three

const coord = z.number().min(-1000).max(1000);
const layoutSchema = z.object({
  name: z.string().max(200),
  idea: z.string().max(2000),
  roof: z.string().max(30).optional(),
  concept: z.object({
    title: z.string().max(120), story: z.string().max(2000), moves: z.array(z.string().max(300)).max(12),
    palette: z.object({ walls: z.string().max(120), accents: z.string().max(120), roof: z.string().max(120) }),
  }).optional(),
  blocks: z.array(z.object({ id: z.string().max(40), name: z.string().max(80), x: coord, y: coord, w: coord, d: coord, storeys: z.number().int().min(1).max(10), outbuilding: z.boolean().optional() })).min(1).max(30),
  rooms: z.array(z.object({ block: z.string().max(40), storey: z.number().int().min(0).max(10), kind: z.string().max(30), name: z.string().max(80), x: coord, y: coord, w: coord, d: coord, glazing: z.string().max(20).optional() })).min(1).max(1500),
  elements: z.array(z.object({ kind: z.string().max(30), storey: z.number().int().min(0).max(10).default(0), x: coord, y: coord, w: coord, d: coord, heightM: z.number().optional(), material: z.string().max(40).optional(), label: z.string().max(80).optional() })).max(500).optional(),
  finishes: z.array(z.object({ block: z.string().max(40), walls: z.string().max(40), base: z.string().max(40).optional(), accent: z.string().max(40).optional() })).max(30).optional(),
});
const plotSchema = z.object({ widthM: z.number(), depthM: z.number() });
const briefSchema = z.record(z.string(), z.unknown());
const photoSchema = z.string().max(MAX_PHOTO_DATA_URL).startsWith(PNG_PREFIX, 'Send the 3D snapshot as a PNG data URL.');

const publishBody = z.object({
  orgId: z.uuid(),
  layout: layoutSchema,
  brief: briefSchema,
  plot: plotSchema,
  title: z.string().trim().min(5).max(90),
  description: z.string().trim().max(4000).default(''),
  priceNaira: z.number().int().positive().max(1_000_000_000),
  drawingsIncluded: z.string().trim().min(3).max(160),
  architectRegistration: z.string().trim().min(2).max(40),
  rightsConfirmed: z.literal(true, 'Confirm you designed this or hold the right to sell it.'),
  photo: photoSchema,
  /** Where the listing shows; defaults to the organisation's area. */
  areaCode: z.string().max(40).optional(),
});

const updateBody = z.object({
  layout: layoutSchema,
  brief: briefSchema.optional(),
  plot: plotSchema.optional(),
  photo: photoSchema.optional(),
  expectedVersion: z.number().int().positive().optional(),
});

export async function isCertified(sql: Sql, orgId: string) {
  return !!(await one(sql, `select 1 from verification_checks where org_id = $1 and check_type = 'professional_credential' and state = 'passed' and (expires_at is null or expires_at > now())`, [orgId]));
}

const notCertified = () => new ApiError(403, 'NOT_CERTIFIED',
  'Only certified architects can publish designs. Ask BuildWise to verify your professional registration (from your business account, under verification); once the check has passed you can publish.');

/** The design rebuilt and checked by BuildWise; a publishable design has no problems. */
function checkDesign(s: Services, plot: Plot, briefIn: Record<string, unknown>, layoutIn: z.infer<typeof layoutSchema>) {
  if (JSON.stringify(layoutIn).length > MAX_LAYOUT_JSON) throw badRequest('LAYOUT_TOO_LARGE', 'The design file is too large.');
  if (!validPlot(plot)) throw badRequest('INVALID_PLOT', 'Enter a plot between 6 m and 200 m on each side.');
  const brief = normaliseBrief(briefIn as Partial<DesignBrief>);
  const r = designFromLayout(plot, brief, layoutIn as unknown as AiLayout, 'studio', s.pack.design);
  if (!r.design || r.problems.length) throw new ApiError(400, 'DESIGN_PROBLEMS', 'Fix these in the design before publishing it.', { problems: r.problems.length ? r.problems : ['The design could not be built.'] });
  if (r.design.storeys > MAX_STOREYS) throw new ApiError(400, 'DESIGN_PROBLEMS', `House plans can be listed for buildings of up to ${MAX_STOREYS} storeys.`, { problems: [`The design has ${r.design.storeys} storeys.`] });
  return { design: r.design, layout: r.layout, brief };
}

/** The house-plans attributes the design itself determines. */
function designAttributes(design: Design, plot: Plot) {
  return {
    bedrooms: design.rooms.filter((r) => r.kind === 'master' || r.kind === 'bedroom').length,
    storeys: String(design.storeys),
    floor_area_m2: Math.round(design.metrics.grossFloorM2),
    min_plot_width_m: plot.widthM,
    min_plot_depth_m: plot.depthM,
  };
}

function pngOf(dataUrl: string) {
  const png = Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64');
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.length < 64 || !magic.every((b, i) => png[i] === b)) throw badRequest('NOT_PNG', 'The snapshot must be a PNG image.');
  return png;
}

async function requireDesignFile(sql: Sql, listingId: string) {
  const f = await one<{ org_id: string; brief: unknown; plot: unknown }>(sql, `select org_id, brief, plot from design_files where listing_id = $1`, [listingId]);
  if (!f) throw notFound('Design');
  const parse = <T>(v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as T;
  return { orgId: f.org_id, brief: parse<Record<string, unknown>>(f.brief), plot: parse<Plot>(f.plot) };
}

export function registerStudio(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/studio/me', auth: 'user',
    handler: async ({ sql, user }) => {
      const orgs = await many<{ id: string; name: string; kind: string; role: string; certified: boolean }>(sql,
        `select o.id, o.name, o.kind, m.role,
                exists (select 1 from verification_checks v where v.org_id = o.id and v.check_type = 'professional_credential' and v.state = 'passed' and (v.expires_at is null or v.expires_at > now())) as certified
           from organizations o join org_members m on m.org_id = o.id where m.user_id = $1 order by o.kind desc, o.name`, [user.id]);
      // Billing members cannot manage listings, so they cannot publish for that organisation.
      const items = orgs.map((o) => ({ id: o.id, name: o.name, kind: o.kind, certified: o.certified && o.role !== 'billing' }));
      return { certified: items.some((o) => o.certified), orgs: items };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/studio/designs', auth: 'user', bodyLimit: MAX_PHOTO_DATA_URL + MAX_LAYOUT_JSON + 64 * 1024,
    body: publishBody,
    handler: async ({ sql, body, user }) => {
      const org = await actingOrg(sql, user.id, body.orgId);
      if (!(await isCertified(sql, org.id))) throw notCertified();
      const { design, layout, brief } = checkDesign(s, body.plot, body.brief, body.layout);
      const orgRow = await one<{ area_code: string | null }>(sql, `select area_code from organizations where id = $1`, [org.id]);
      const areaCode = body.areaCode ?? orgRow?.area_code ?? null;
      if (!areaCode || !findArea(s.pack, areaCode)) throw badRequest('INVALID_AREA', 'Choose the area where buyers will find this design.', [{ path: 'areaCode', message: 'Choose an area in this market.' }]);

      const photo = await storePhoto(sql, s, org.id, user.id, pngOf(body.photo), `3D view of ${body.title}`.slice(0, 150));
      const input = listingInput.parse({
        orgId: org.id, categorySlug: CATEGORY, title: body.title, description: body.description, unit: 'set', price: String(body.priceNaira), areaCode,
        attributes: { ...designAttributes(design, body.plot), drawings_included: body.drawingsIncluded, architect_registration: body.architectRegistration, rights_confirmed: true },
        photoIds: [photo.id],
      });
      const { id } = await createListing(sql, s, user, input, { source: 'studio' });
      await sql.query(`insert into design_files (listing_id, org_id, layout, brief, plot) values ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb)`,
        [id, org.id, JSON.stringify(layout), JSON.stringify(brief), JSON.stringify({ widthM: body.plot.widthM, depthM: body.plot.depthM })]);
      const draft = (await one<Record<string, any>>(sql, `select * from listings where id = $1`, [id]))!;
      await submitLike(sql, s, draft, user, 'submit');
      const after = (await one<{ status: string; version: number }>(sql, `select status, version from listings where id = $1`, [id]))!;
      return { listingId: id, status: after.status, version: after.version };
    },
  });

  route(app, s, {
    method: 'PUT', url: '/v1/studio/designs/:listingId', auth: 'user', bodyLimit: MAX_PHOTO_DATA_URL + MAX_LAYOUT_JSON + 64 * 1024,
    params: z.object({ listingId: z.uuid() }),
    body: updateBody,
    handler: async ({ sql, params, body, user }) => {
      const before = await requireOwnListing(sql, user.id, params.listingId);
      const file = await requireDesignFile(sql, before.id);
      if (before.status === 'blocked') throw conflict('BLOCKED', 'Blocked listings cannot be edited. You can appeal the decision.');
      if (body.expectedVersion && before.version !== body.expectedVersion) throw conflict('STALE_VERSION', 'This listing changed since you opened it. Reload and try again.', { currentVersion: before.version });
      if (!(await isCertified(sql, before.seller_org_id))) throw notCertified();
      const plot = body.plot ?? file.plot;
      const { design, layout, brief } = checkDesign(s, plot, body.brief ?? file.brief, body.layout);

      await sql.query(`update design_files set layout = $2::jsonb, brief = $3::jsonb, plot = $4::jsonb, updated_at = now() where listing_id = $1`,
        [before.id, JSON.stringify(layout), JSON.stringify(brief), JSON.stringify({ widthM: plot.widthM, depthM: plot.depthM })]);
      const attributes = { ...(before.attributes ?? {}), ...designAttributes(design, plot) };
      await sql.query(`update listings set attributes = $2::jsonb, version = version + 1, updated_at = now() where id = $1`, [before.id, JSON.stringify(attributes)]);
      if (body.photo) {
        // The new snapshot replaces the first photo; any others the seller added stay.
        const photo = await storePhoto(sql, s, before.seller_org_id, user.id, pngOf(body.photo), `3D view of ${before.title}`.slice(0, 150));
        const current = await many<{ id: string }>(sql, `select id from listing_photos where listing_id = $1 and status = 'ready' order by position`, [before.id]);
        await attachPhotos(sql, before.id, before.seller_org_id, [photo.id, ...current.slice(1).map((p) => p.id)], {});
      }
      // A new design is a material change: a live listing goes back through checks and review (§3.8).
      const live = before.status === 'live';
      if (live) {
        const after = (await one<Record<string, any>>(sql, `select * from listings where id = $1`, [before.id]))!;
        await submitLike(sql, s, after, user, 'material_edit');
      }
      await recordVersion(sql, before.id, user.id, live);
      await audit(sql, { actorUserId: user.id, action: 'design_file.updated', targetType: 'Listing', targetId: before.id, metadata: { backToReview: live } });
      const now = (await one<Record<string, any>>(sql, `select * from listings where id = $1`, [before.id]))!;
      return { listingId: before.id, status: now.status, version: now.version, listing: await ownerView(sql, s, now) };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/studio/designs/:listingId', auth: 'public', systemContext: true,
    params: z.object({ listingId: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const row = await one<Record<string, any>>(sql,
        `select l.id, l.title, l.status, l.seller_org_id, o.name as seller_name, f.layout, f.brief, f.plot, f.updated_at,
                exists (select 1 from verification_checks v where v.org_id = l.seller_org_id and v.state = 'passed' and (v.expires_at is null or v.expires_at > now())) as verified,
                exists (select 1 from verification_checks v where v.org_id = l.seller_org_id and v.check_type = 'professional_credential' and v.state = 'passed' and (v.expires_at is null or v.expires_at > now())) as certified
           from design_files f join listings l on l.id = f.listing_id join organizations o on o.id = l.seller_org_id where f.listing_id = $1`, [params.listingId]);
      if (!row) throw notFound('Design');
      if (row.status !== 'live') {
        // Before it is live (or after it closes) only the seller's members and staff can open it.
        const allowed = !!user && (user.isStaff || !!(await one(sql, `select 1 from org_members where org_id = $1 and user_id = $2`, [row.seller_org_id, user.id])));
        if (!allowed) throw notFound('Design');
      }
      const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);
      return {
        listingId: row.id, title: row.title, status: row.status, path: listingPath(row.title, row.id),
        layout: parse(row.layout), brief: parse(row.brief), plot: parse(row.plot),
        sellerName: row.seller_name, verified: !!row.verified, certified: !!row.certified, updatedAt: iso(row.updated_at),
      };
    },
  });
}

