import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CLOSE_REASONS, PHASH_MATCH_DISTANCE, REASON_CODES, comparablePrice, distanceKm, findArea, groupForPriceSort, hammingHex, isMaterialEdit, listingMachine,
  listingPath, packSizeOf, parseMajor, placeSlots, priceOutlier, replyMetrics, runChecks, scanText, unitLabel, uuidv7, validateAttributes, validatePriceUnit,
  type CategoryDef, type ListingCommand, type ReasonCode,
} from '@bw/domain';
import { iso, many, one, str, type Sql } from '../db/database.js';
import { route, type Actor, type Services } from '../http/route.js';
import {
  ApiError, PHOTO_SIZES, PhotoError, audit, badRequest, conflict, forbidden, notFound, processPhoto, publish, tooMany, unprocessable, type PhotoSize,
} from '../platform/platform.js';
import { actingOrg } from './identity.js';
import { applyListingStatus } from './effects.js';

// ---------------------------------------------------------------- categories
export async function categoryDef(sql: Sql, slug: string, version?: number): Promise<CategoryDef & { version: number }> {
  const row = await one<{ definition: CategoryDef; version: number }>(sql,
    version ? `select definition, version from category_versions where slug = $1 and version = $2` : `select v.definition, v.version from categories c join category_versions v on v.slug = c.slug and v.version = c.current_version where c.slug = $1 and c.status = 'active'`,
    version ? [slug, version] : [slug]);
  if (!row) throw badRequest('INVALID_CATEGORY', 'Choose a category.');
  return { ...(typeof row.definition === 'string' ? JSON.parse(row.definition) : row.definition), version: row.version };
}

async function childSlugs(sql: Sql, slug: string): Promise<string[]> {
  const rows = await many<{ slug: string }>(sql, `select slug from categories where slug = $1 or parent_slug = $1`, [slug]);
  return rows.map((r) => r.slug);
}

// ---------------------------------------------------------------- reputation and seller card (§3.12)
export async function sellerCard(sql: Sql, s: Services, orgId: string) {
  const o = await one<Record<string, any>>(sql, `select * from organizations where id = $1`, [orgId]);
  if (!o) return null;
  // All of the seller's threads, not only the viewer's own (threads are private by row-level security).
  const threads = await many<{ created_at: unknown; first_seller_reply_at: unknown }>(sql,
    `select created_at, first_seller_reply_at from seller_thread_times($1, $2)`, [orgId, s.pack.policy.reputationWindowDays]);
  const m = replyMetrics(threads.map((t) => ({ startedAt: new Date(String(t.created_at)), firstSellerReplyAt: t.first_seller_reply_at ? new Date(String(t.first_seller_reply_at)) : null })),
    new Date(), s.pack.policy.reputationWindowDays, s.pack.policy.replyWindowHours, s.pack.policy.reputationMinThreads);
  const rv = await one<{ n: number; avg: number | null }>(sql, `select count(*)::int as n, avg(rating)::float as avg from reviews where seller_org_id = $1 and status = 'published'`, [orgId]);
  const checks = await many<Record<string, any>>(sql, `select check_type, checked_at, expires_at from verification_checks where org_id = $1 and state = 'passed' and (expires_at is null or expires_at > now()) order by checked_at`, [orgId]);
  return {
    id: o.id, name: o.name, handle: o.handle, kind: o.kind, memberSince: iso(o.created_at), areaCode: o.area_code, chatOnly: o.chat_only,
    businessHours: o.business_hours, businessAddress: o.publish_address ? o.business_address : null,
    reputation: { threads: m.threads, replyRatePct: m.replyRatePct, medianReplyMinutes: m.medianReplyMinutes, enoughData: m.enoughData, reviewCount: rv?.n ?? 0, averageRating: rv?.avg ? Math.round(rv.avg * 10) / 10 : null },
    checks: checks.map((c) => ({ type: c.check_type, checkedAt: iso(c.checked_at), expiresAt: iso(c.expires_at) })),
  };
}

// ---------------------------------------------------------------- views
export function photoUrls(id: string) {
  return Object.fromEntries((Object.keys(PHOTO_SIZES) as PhotoSize[]).map((k) => [k, `/media/photos/${id}/${k}.webp`])) as Record<PhotoSize, string>;
}

async function photosOf(sql: Sql, listingId: string) {
  return (await many<Record<string, any>>(sql, `select id, alt_text, width, height, dhash from listing_photos where listing_id = $1 and status = 'ready' order by position`, [listingId]))
    .map((p) => ({ id: p.id, alt: p.alt_text, width: p.width, height: p.height, dhash: p.dhash, urls: photoUrls(p.id) }));
}

function priceView(l: Record<string, any>) {
  const price = l.price_minor == null ? null : { amountMinor: str(l.price_minor)!, currency: l.currency };
  const perBase = l.per_base_minor != null && l.compare_key?.startsWith('dim:') && l.pack_unit ? { amountMinor: String(Math.round(Number(l.per_base_minor))), currency: l.currency, unit: l.compare_key === 'dim:mass' ? 'kg' : l.pack_unit } : null;
  return {
    price, unit: l.unit, unitLabel: unitLabel(l.unit), negotiable: l.negotiable, quoteOnRequest: l.quote_on_request,
    packSize: l.pack_value ? { value: Number(l.pack_value), unit: l.pack_unit } : null, perBaseUnit: perBase,
    priceConfirmedAt: iso(l.price_confirmed_at),
  };
}

function cardView(l: Record<string, any>, photo: { urls: Record<PhotoSize, string>; alt: string | null } | null, s: Services) {
  const area = findArea(s.pack, l.area_code);
  return {
    id: l.id, shortId: l.short_id, path: listingPath(l.title, l.id), title: l.title, categorySlug: l.category_slug, listingType: l.listing_type,
    ...priceView(l), area: area ? { code: area.code, label: area.label, region: area.region.label } : null, deliveryOffered: l.delivery_offered,
    photo, sellerName: l.seller_name ?? null, sellerKind: l.seller_kind ?? null, publishedAt: iso(l.published_at),
  };
}

/** Public cards for listing rows (selected with the seller's name and verification), with each first photo. */
export async function cardsFor(sql: Sql, s: Services, rows: Record<string, any>[]) {
  if (!rows.length) return [];
  const firstPhotos = await many<{ listing_id: string; id: string; alt_text: string | null }>(sql,
    `select distinct on (listing_id) listing_id, id, alt_text from listing_photos where listing_id = any($1::uuid[]) and status = 'ready' order by listing_id, position`, [rows.map((r) => r.id)]);
  const photoOf = new Map(firstPhotos.map((ph) => [ph.listing_id, { urls: photoUrls(ph.id), alt: ph.alt_text }]));
  return rows.map((l) => ({ ...cardView(l, photoOf.get(l.id) ?? null, s), verified: !!l.verified }));
}

export async function ownerView(sql: Sql, s: Services, l: Record<string, any>) {
  const decisions = await many<Record<string, any>>(sql, `select id, decision, reason_code, note, created_at from moderation_decisions where listing_id = $1 order by created_at desc limit 5`, [l.id]);
  const appealable = decisions[0] && ['reject', 'block'].includes(decisions[0].decision) ? decisions[0] : null;
  const appeal = appealable ? await one<Record<string, any>>(sql, `select status, note from appeals where target_id = $1`, [appealable.id]) : null;
  return {
    ...cardView(l, null, s), status: l.status, description: l.description, attributes: l.attributes, areaCode: l.area_code, serviceAreas: l.service_areas,
    sellerOrgId: l.seller_org_id, version: l.version, categoryVersion: l.category_version,
    rejection: l.rejection_code ? { code: l.rejection_code, message: REASON_CODES[l.rejection_code as ReasonCode] ?? '', note: l.rejection_note } : null,
    appeal: appealable ? { decisionId: appealable.id, canAppeal: !appeal, status: appeal?.status ?? null, outcomeNote: appeal?.note ?? null } : null,
    expiresAt: iso(l.expires_at), closedAt: iso(l.closed_at), closeReason: l.close_reason, views: l.views, contacts: l.contacts,
    photos: await photosOf(sql, l.id),
    allowedCommands: listingMachine.commandsFrom(l.status).filter((c) => ['submit', 'resubmit', 'renew', 'close', 'reopen'].includes(c)),
    createdAt: iso(l.created_at), updatedAt: iso(l.updated_at),
  };
}

// ---------------------------------------------------------------- input
const attributesSchema = z.record(z.string(), z.unknown());
export const listingInput = z.object({
  orgId: z.uuid().optional(),
  categorySlug: z.string().max(60),
  title: z.string().trim().min(5).max(90),
  description: z.string().trim().max(4000).default(''),
  attributes: attributesSchema.default({}),
  price: z.string().trim().max(20).nullable().optional(),
  unit: z.string().max(20),
  negotiable: z.boolean().default(false),
  quoteOnRequest: z.boolean().default(false),
  areaCode: z.string().max(40),
  serviceAreas: z.array(z.string().max(40)).max(30).default([]),
  photoIds: z.array(z.uuid()).max(10).default([]),
  photoAlts: z.record(z.string(), z.string().trim().max(150)).default({}),
});
export type ListingInput = z.infer<typeof listingInput>;

async function normalizeInput(sql: Sql, s: Services, input: ListingInput) {
  const cat = await categoryDef(sql, input.categorySlug);
  if (await one(sql, `select 1 from categories where parent_slug = $1 and status = 'active'`, [cat.slug])) throw badRequest('INVALID_CATEGORY', 'Choose a specific subcategory.');
  const area = findArea(s.pack, input.areaCode);
  if (!area) throw badRequest('INVALID_AREA', 'Choose an area in this market.');
  if (input.serviceAreas.some((a) => !findArea(s.pack, a))) throw badRequest('INVALID_AREA', 'One of the service areas is not in this market.');
  const unitErr = validatePriceUnit(cat, input.unit);
  if (unitErr) throw new ApiError(400, 'VALIDATION_FAILED', 'Check the form.', undefined, [{ path: 'unit', message: unitErr }]);
  let priceMinor: bigint | null = null;
  if (input.quoteOnRequest) priceMinor = null;
  else {
    if (!input.price) throw new ApiError(400, 'VALIDATION_FAILED', 'Check the form.', undefined, [{ path: 'price', message: 'Enter a price, or choose "quote on request".' }]);
    priceMinor = parseMajor(input.price, s.pack.currency);
    if (priceMinor == null || priceMinor <= 0n) throw new ApiError(400, 'VALIDATION_FAILED', 'Check the form.', undefined, [{ path: 'price', message: 'Enter a valid price.' }]);
  }
  const pack = packSizeOf(cat, input.attributes as Record<string, unknown>);
  const cmp = priceMinor != null ? comparablePrice(priceMinor, input.unit, pack) : null;
  const filled = cat.attributes.filter((a) => input.attributes[a.key] != null && input.attributes[a.key] !== '').length;
  const completeness = Math.round(((filled / Math.max(1, cat.attributes.length)) * 50) + Math.min(input.photoIds.length, 5) * 6 + Math.min(input.description.length, 400) / 20);
  return { cat, area, priceMinor, pack, cmp, completeness };
}

export async function attachPhotos(sql: Sql, listingId: string, orgId: string, ids: string[], alts: Record<string, string>) {
  if (ids.length) {
    const owned = await many<{ id: string }>(sql, `select id from listing_photos where id = any($1::uuid[]) and owner_org_id = $2 and status = 'ready' and (listing_id is null or listing_id = $3)`, [ids, orgId, listingId]);
    if (owned.length !== ids.length) throw badRequest('INVALID_PHOTOS', 'One of the photos is not yours or is no longer available.');
  }
  await sql.query(`update listing_photos set status = 'removed' where listing_id = $1 and status = 'ready' and not (id = any($2::uuid[]))`, [listingId, ids]);
  for (const [i, id] of ids.entries()) await sql.query(`update listing_photos set listing_id = $2, position = $3, alt_text = coalesce($4, alt_text) where id = $1`, [id, listingId, i, alts[id] ?? null]);
}

async function snapshot(sql: Sql, listingId: string) {
  const l = await one<Record<string, any>>(sql, `select * from listings where id = $1`, [listingId]);
  const hashes = (await many<{ dhash: string }>(sql, `select dhash from listing_photos where listing_id = $1 and status = 'ready'`, [listingId])).map((p) => p.dhash);
  return { l: l!, snap: { title: l!.title, description: l!.description, categorySlug: l!.category_slug, priceMinor: l!.price_minor == null ? null : BigInt(l!.price_minor), unit: l!.unit, photoHashes: hashes } };
}

export async function recordVersion(sql: Sql, listingId: string, userId: string, material: boolean) {
  const l = await one<Record<string, any>>(sql, `select * from listings where id = $1`, [listingId]);
  await sql.query(`insert into listing_versions (listing_id, version, snapshot, material, created_by) values ($1, $2, $3::jsonb, $4, $5)`,
    [listingId, l!.version, JSON.stringify({ ...l, search: undefined, price_minor: str(l!.price_minor) }), material, userId]);
}

async function requireOwnListing(sql: Sql, userId: string, id: string) {
  const l = await one<Record<string, any>>(sql, `select * from listings where id = $1`, [id]);
  if (!l) throw notFound('Listing');
  const m = await one<{ role: string }>(sql, `select role from org_members where org_id = $1 and user_id = $2`, [l.seller_org_id, userId]);
  if (!m || m.role === 'billing') throw notFound('Listing');
  return l;
}

// ---------------------------------------------------------------- submission checks (§3.8)
async function activeRestriction(sql: Sql, orgId: string, kinds: string[]) {
  return one<{ kind: string; reason: string; ends_at: unknown }>(sql,
    `select kind, reason, ends_at from seller_restrictions where org_id = $1 and status = 'active' and kind = any($2::text[]) and (ends_at is null or ends_at > now()) limit 1`, [orgId, kinds]);
}

async function evaluate(sql: Sql, s: Services, l: Record<string, any>, user: Actor) {
  const cat = await categoryDef(sql, l.category_slug, l.category_version);
  const r = await activeRestriction(sql, l.seller_org_id, ['posting_limit', 'listing_suspension', 'account_suspension']);
  if (r) throw forbidden(`Your account can't publish listings right now (${r.kind.replace('_', ' ')}): ${r.reason}. You can appeal from My ads.`);

  // Free listing allowance per category (§3.13): live + in-review listings count; packages raise it.
  const pkgCodes = await many<{ product_code: string }>(sql,
    `select product_code from promotion_purchases where org_id = $1 and kind = 'package' and status = 'active'`, [l.seller_org_id]);
  const pkgExtra = { extra: pkgCodes.reduce((n, x) => n + (s.pack.promotionProducts.find((p) => p.code === x.product_code)?.extraAllowance ?? 0), 0) };
  const orgKind = (await one<{ kind: string }>(sql, `select kind from organizations where id = $1`, [l.seller_org_id]))!.kind;
  const allowance = (orgKind === 'business' ? cat.freeAllowance.business : cat.freeAllowance.individual) + (pkgExtra?.extra ?? 0);
  const used = await one<{ n: number }>(sql, `select count(*)::int as n from listings where seller_org_id = $1 and category_slug = $2 and status in ('live', 'in_review') and id <> $3`, [l.seller_org_id, l.category_slug, l.id]);
  if ((used?.n ?? 0) >= allowance) throw unprocessable('ALLOWANCE_REACHED', `You have ${allowance} live listing(s) in ${cat.name}, the free allowance. Close one, or buy a visibility package to list more.`, { allowance });

  const u = await one<{ created_at: unknown }>(sql, `select created_at from users where id = $1`, [user.id]);
  const ageDays = Math.floor((Date.now() - new Date(String(u!.created_at)).getTime()) / 86_400_000);
  if (ageDays < 7) {
    const today = await one<{ n: number }>(sql, `select count(*)::int as n from listing_status_events where actor_user_id = $1 and command in ('submit', 'resubmit') and created_at > now() - interval '1 day'`, [user.id]);
    if ((today?.n ?? 0) >= s.pack.limits.listingsPerNewAccountPerDay) throw tooMany('New accounts can submit a few listings a day. Try again tomorrow.', 86_400);
  }

  const photos = await many<{ dhash: string }>(sql, `select dhash from listing_photos where listing_id = $1 and status = 'ready'`, [l.id]);
  const others = photos.length ? await many<{ dhash: string; listing_id: string }>(sql,
    `select dhash, listing_id from listing_photo_hashes_except($1)`, [l.seller_org_id]) : [];
  const matches = new Set<string>();
  for (const p of photos) for (const o of others) if (hammingHex(p.dhash, o.dhash) <= PHASH_MATCH_DISTANCE) matches.add(o.listing_id);

  const textAttrs = cat.attributes.filter((a) => a.type === 'text').map((a) => String(l.attributes?.[a.key] ?? '')).join(' ');
  const findings = scanText(`${l.title}\n${l.description}\n${textAttrs}`, s.pack);

  const observed = l.compare_key && l.price_minor != null
    ? (await many<{ v: unknown }>(sql, `select per_base_minor as v from listings where status = 'live' and compare_key = $1 and region_code = $2 and seller_org_id <> $3 and category_slug = $4 and price_confirmed_at > now() - interval '90 days'`,
      [l.compare_key, l.region_code, l.seller_org_id, l.category_slug])).map((x) => Number(x.v))
    : [];
  const outlier = l.price_minor == null ? { checked: true, outlier: false } :
    priceOutlier({ priceMinor: BigInt(l.price_minor), unit: l.unit, pack: l.pack_value ? { value: Number(l.pack_value), unit: l.pack_unit } : null }, observed, s.pack.moderation.outlierMinObservations, s.pack.moderation.outlierFactor);

  const rejections = await one<{ n: number }>(sql, `select count(*)::int as n from moderation_decisions d join listings x on x.id = d.listing_id where x.seller_org_id = $1 and d.decision in ('reject', 'block') and d.created_at > now() - interval '90 days'`, [l.seller_org_id]);
  const reports = await one<{ n: number }>(sql, `select org_open_report_count($1) as n`, [l.seller_org_id]);
  // Established = the seller has had listings live for the configured number of days, with no recent rejections.
  const firstLive = await one<{ days: number | null }>(sql, `select floor(extract(epoch from now() - min(published_at)) / 86400)::int as days from listings where seller_org_id = $1 and published_at is not null`, [l.seller_org_id]);
  const established = (firstLive?.days ?? 0) >= s.pack.moderation.establishedSellerMinLiveDays && (rejections?.n ?? 0) === 0 && (reports?.n ?? 0) === 0;
  const result = runChecks({
    category: cat, title: l.title, description: l.description, attributes: l.attributes ?? {}, photoCount: photos.length, textFindings: findings,
    reusedPhotoMatches: matches.size, outlier, account: { ageDays, priorRejections: rejections?.n ?? 0, openReports: reports?.n ?? 0, restricted: false, established },
  });
  return { cat, result, matchedListingIds: [...matches] };
}

async function submitLike(sql: Sql, s: Services, l: Record<string, any>, user: Actor, command: ListingCommand) {
  if (!listingMachine.can(l.status, command)) throw conflict('INVALID_TRANSITION', `This listing is ${l.status.replace('_', ' ')}; you can't ${command.replace('_', ' ')} it now.`, { status: l.status });
  const { cat, result, matchedListingIds } = await evaluate(sql, s, l, user);
  if (!result.pass) {
    const attrs = validateAttributes(cat, l.attributes ?? {});
    throw new ApiError(422, 'SUBMISSION_BLOCKED', 'Fix these before submitting.', {
      blocking: result.blocking.map((c) => ({ code: c, message: REASON_CODES[c] })),
    }, attrs.ok ? undefined : attrs.errors.map((e) => ({ path: `attributes.${e.key}`, message: e.message })));
  }
  const signals = [...result.signals, ...(matchedListingIds.length ? [{ code: 'reused_photos_match', detail: matchedListingIds.join(','), weight: 0 }] : [])];
  await sql.query(`update listings set risk_score = $2, signals = $3::jsonb, rejection_code = null, rejection_note = null where id = $1`, [l.id, result.riskScore, JSON.stringify(signals)]);
  const renewing = command === 'renew' || command === 'reopen' || command === 'submit' || command === 'resubmit';
  if (result.autoPublish) {
    await sql.query(`update listings set published_at = coalesce(published_at, now()), expires_at = now() + make_interval(days => $2)${renewing ? ', price_confirmed_at = now()' : ''} where id = $1`, [l.id, cat.listingPeriodDays]);
    await applyListingStatus(sql, l.id, 'live', user.id, command);
  } else {
    if (renewing) await sql.query(`update listings set price_confirmed_at = now() where id = $1`, [l.id]);
    await applyListingStatus(sql, l.id, 'in_review', user.id, command);
  }
  await publish(sql, 'ListingSubmitted', { listingId: l.id, autoPublished: result.autoPublish, riskScore: result.riskScore });
  await audit(sql, { actorUserId: user.id, action: `listing.${command}`, targetType: 'Listing', targetId: l.id, metadata: { autoPublished: result.autoPublish, riskScore: result.riskScore } });
  return { autoPublished: result.autoPublish, riskScore: result.riskScore };
}

// ---------------------------------------------------------------- shared create paths (also used by the Design Studio)
/** Runs an upload through the photo pipeline (decode, strip metadata, sizes, dHash), stores it and records it for the org. */
export async function storePhoto(sql: Sql, s: Services, orgId: string, userId: string, body: Buffer, alt: string | null = null) {
  let out;
  try { out = await processPhoto(body); } catch (e) { if (e instanceof PhotoError) throw unprocessable('INVALID_PHOTO', e.message); throw e; }
  const id = uuidv7();
  for (const [size, buf] of Object.entries(out.sizes)) await s.storage.put(`photos/${id}/${size}.webp`, buf, 'image/webp');
  await sql.query(`insert into listing_photos (id, owner_org_id, uploaded_by, width, height, dhash, alt_text, bytes) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, orgId, userId, out.width, out.height, out.dhash, alt, body.length]);
  return { id, width: out.width, height: out.height, urls: photoUrls(id) };
}

/** Creates a draft listing for an org the user may act for, with its photos, first version and audit entry. */
export async function createListing(sql: Sql, s: Services, user: Actor, body: ListingInput, auditMetadata?: Record<string, unknown>) {
  const org = await actingOrg(sql, user.id, body.orgId);
  const n = await normalizeInput(sql, s, body);
  const id = uuidv7();
  const att = validateAttributes(n.cat, body.attributes as Record<string, unknown>);
  const attrs = att.ok ? att.clean : body.attributes;
  await sql.query(
    `insert into listings (id, short_id, seller_org_id, created_by, category_slug, category_version, listing_type, status, title, description, attributes, price_minor, currency, unit, negotiable, quote_on_request,
       pack_value, pack_unit, compare_key, per_base_minor, region_code, area_code, service_areas, lat, lng, delivery_offered, completeness)
     values ($1, $2, $3, $4, $5, $6, $7, 'draft', $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    [id, id.replace(/-/g, '').slice(-12), org.id, user.id, body.categorySlug, n.cat.version, n.cat.listingType, body.title, body.description, JSON.stringify(attrs),
      n.priceMinor == null ? null : String(n.priceMinor), s.pack.currency, body.unit, body.negotiable, body.quoteOnRequest, n.pack?.value ?? null, n.pack?.unit ?? null,
      n.cmp?.key ?? null, n.cmp?.perBaseMinor ?? null, n.area.region.code, n.area.code, body.serviceAreas, n.area.lat, n.area.lng, attrs.delivery_offered === true, n.completeness]);
  await attachPhotos(sql, id, org.id, body.photoIds, body.photoAlts);
  await recordVersion(sql, id, user.id, false);
  await audit(sql, { actorUserId: user.id, action: 'listing.created', targetType: 'Listing', targetId: id, ...(auditMetadata ? { metadata: auditMetadata } : {}) });
  return { id, orgId: org.id };
}

// ---------------------------------------------------------------- search (§3.7)
const searchQuery = z.object({
  q: z.string().trim().max(100).optional(),
  category: z.string().max(60).optional(),
  area: z.string().max(40).optional(),
  sort: z.enum(['relevance', 'newest', 'price_asc', 'price_desc']).default('relevance'),
  min: z.string().max(20).optional(), max: z.string().max(20).optional(),
  unit: z.string().max(20).optional(),
  condition: z.string().max(20).optional(),
  brand: z.string().max(60).optional(),
  delivery: z.enum(['1']).optional(),
  sellerType: z.enum(['personal', 'business']).optional(),
  verified: z.enum(['1']).optional(),
  maxAgeDays: z.coerce.number().int().min(1).max(365).optional(),
  page: z.coerce.number().int().min(1).max(50).default(1),
});
export type SearchQuery = z.infer<typeof searchQuery>;

export async function searchListings(sql: Sql, s: Services, q: SearchQuery, opts: { limit?: number; since?: Date } = {}) {
  const where: string[] = [`l.status = 'live'`];
  const params: unknown[] = [];
  const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
  if (q.category) where.push(`l.category_slug = any(${p(await childSlugs(sql, q.category))}::text[])`);
  const area = q.area ? findArea(s.pack, q.area) : null;
  if (q.area && !area) throw badRequest('INVALID_AREA', 'Unknown area.');
  // Products match the seller's area; services, hire and logistics match the buyer's area against service areas (§3.5).
  if (area) where.push(`(l.area_code = ${p(area.code)} or ${p(area.code)} = any(l.service_areas))`);
  let rankExpr = '0::float';
  if (q.q) {
    const tq = p(q.q);
    where.push(`(l.search @@ websearch_to_tsquery('simple', ${tq}) or similarity(l.title, ${tq}) > 0.2)`);
    rankExpr = `ts_rank(l.search, websearch_to_tsquery('simple', ${tq})) + similarity(l.title, ${tq})`;
  }
  if (q.unit) where.push(`l.unit = ${p(q.unit)}`);
  const min = q.min ? parseMajor(q.min, s.pack.currency) : null;
  const max = q.max ? parseMajor(q.max, s.pack.currency) : null;
  if (min != null) where.push(`l.price_minor >= ${p(String(min))}::bigint`);
  if (max != null) where.push(`l.price_minor <= ${p(String(max))}::bigint`);
  if (q.condition) where.push(`l.attributes->>'condition' = ${p(q.condition)}`);
  if (q.brand) where.push(`lower(l.attributes->>'brand') = lower(${p(q.brand)})`);
  if (q.delivery) where.push(`l.delivery_offered`);
  if (q.sellerType) where.push(`o.kind = ${p(q.sellerType)}`);
  if (q.verified) where.push(`exists (select 1 from verification_checks v where v.org_id = l.seller_org_id and v.state = 'passed' and (v.expires_at is null or v.expires_at > now()))`);
  if (q.maxAgeDays) where.push(`l.published_at > now() - make_interval(days => ${p(q.maxAgeDays)})`);
  if (opts.since) where.push(`l.published_at > ${p(opts.since.toISOString())}`);

  const rows = await many<Record<string, any>>(sql,
    `select l.*, o.name as seller_name, o.kind as seller_kind, ${rankExpr} as text_rank,
            exists (select 1 from verification_checks v where v.org_id = l.seller_org_id and v.state = 'passed') as verified
       from listings l join organizations o on o.id = l.seller_org_id
      where ${where.join(' and ')}
      order by l.published_at desc limit 500`, params);

  const now = Date.now();
  const scored = rows.map((l) => {
    const freshDays = (now - new Date(String(l.price_confirmed_at)).getTime()) / 86_400_000;
    const dist = area ? distanceKm(area, { lat: l.lat, lng: l.lng }) : 0;
    const score = Number(l.text_rank) * 4 + Math.max(0, 1 - freshDays / s.pack.policy.priceFreshDays) + l.completeness / 100 + (l.verified ? 0.3 : 0) - Math.min(dist, 50) / 50;
    return { l, score, dist };
  });
  const sortKey = q.sort;
  if (sortKey === 'newest') scored.sort((a, b) => new Date(String(b.l.published_at)).getTime() - new Date(String(a.l.published_at)).getTime());
  else if (sortKey === 'relevance') scored.sort((a, b) => b.score - a.score);

  const firstPhotos = rows.length ? await many<{ listing_id: string; id: string; alt_text: string | null }>(sql,
    `select distinct on (listing_id) listing_id, id, alt_text from listing_photos where listing_id = any($1::uuid[]) and status = 'ready' order by listing_id, position`, [rows.map((r) => r.id)]) : [];
  const photoOf = new Map(firstPhotos.map((ph) => [ph.listing_id, { urls: photoUrls(ph.id), alt: ph.alt_text }]));
  const card = (l: Record<string, any>) => ({ ...cardView(l, photoOf.get(l.id) ?? null, s), verified: l.verified });

  const limit = opts.limit ?? 20;
  if (sortKey === 'price_asc' || sortKey === 'price_desc') {
    // Never rank across incomparable units: one group per comparable unit (§3.7).
    const groups = groupForPriceSort(scored.map((x) => ({ ...x.l, priceMinor: x.l.price_minor == null ? null : BigInt(x.l.price_minor), unit: x.l.unit, pack: x.l.pack_value ? { value: Number(x.l.pack_value), unit: x.l.pack_unit } : null })), sortKey === 'price_asc' ? 'asc' : 'desc');
    const noPrice = scored.filter((x) => x.l.price_minor == null).map((x) => card(x.l));
    return {
      total: rows.length, page: 1, pages: 1, sort: sortKey,
      groups: [
        ...groups.map((g) => ({ key: g.key, label: g.key.startsWith('dim:') ? `Compared per ${unitLabel(g.baseUnit)}` : `Priced per ${unitLabel(g.baseUnit)}`, items: g.items.slice(0, 100).map((i) => ({ slot: 'organic' as const, listing: card(i) })) })),
        ...(noPrice.length ? [{ key: 'quote', label: 'Quote on request', items: noPrice.map((c) => ({ slot: 'organic' as const, listing: c })) }] : []),
      ],
    };
  }

  // Labelled promoted slots, drawn only from the eligible results above (§3.7).
  const eligibleIds = rows.map((r) => r.id);
  const promos = eligibleIds.length ? await many<{ listing_id: string; kind: string; slot_weight: number }>(sql,
    `select listing_id, kind, slot_weight from promotion_purchases where status = 'active' and ends_at > now() and listing_id = any($1::uuid[])`, [eligibleIds]) : [];
  const pkgOrgs = await many<{ org_id: string; w: number }>(sql, `select org_id, max(slot_weight)::int as w from promotion_purchases where status = 'active' and kind = 'package' and ends_at > now() group by org_id`);
  const byId = new Map(scored.map((x) => [x.l.id, x.l]));
  const top = promos.filter((x) => x.kind === 'top').map((x) => ({ id: x.listing_id, weight: 1 }));
  const pkgW = new Map(pkgOrgs.map((x) => [x.org_id, x.w]));
  const promoted = rows.filter((r) => pkgW.has(r.seller_org_id)).map((r) => ({ id: r.id as string, weight: pkgW.get(r.seller_org_id)! }));
  const pages = Math.max(1, Math.ceil(scored.length / limit));
  const page = Math.min(q.page, pages);
  const organic = scored.slice((page - 1) * limit, page * limit).map((x) => ({ id: x.l.id as string }));
  const placed = placeSlots(organic, page === 1 ? top : [], promoted, { topPerPage: s.pack.slots.topPerPage, everyN: s.pack.slots.promotedEveryN, seed: Math.floor(now / 3_600_000) + page });
  return {
    total: rows.length, page, pages, sort: sortKey,
    groups: [{ key: 'all', label: null, items: placed.map((x) => ({ slot: x.slot, listing: card(byId.get(x.item.id)!) })) }],
  };
}

// ---------------------------------------------------------------- routes
export function registerListings(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/categories', auth: 'public',
    query: z.object({ area: z.string().max(40).optional() }),
    handler: async ({ sql, query }) => {
      const rows = await many<Record<string, any>>(sql, `select c.slug, c.parent_slug, c.name, c.sort, c.current_version, v.definition from categories c join category_versions v on v.slug = c.slug and v.version = c.current_version where c.status = 'active' order by c.sort, c.name`);
      const counts = await many<{ category_slug: string; n: number }>(sql,
        `select category_slug, count(*)::int as n from listings where status = 'live' and ($1::text is null or area_code = $1 or $1 = any(service_areas)) group by category_slug`, [query.area ?? null]);
      const count = new Map(counts.map((c) => [c.category_slug, c.n]));
      const defs = rows.map((r) => {
        const d = typeof r.definition === 'string' ? JSON.parse(r.definition) : r.definition;
        return { slug: r.slug, parent: r.parent_slug, name: r.name, version: r.current_version, listingType: d.listingType, priceUnits: d.priceUnits, minPhotos: d.minPhotos, attributes: d.attributes, seoText: d.seoText ?? null, liveCount: count.get(r.slug) ?? 0 };
      });
      return { items: defs.map((d) => ({ ...d, liveCount: d.parent ? d.liveCount : defs.filter((c) => c.parent === d.slug || c.slug === d.slug).reduce((a, c) => a + c.liveCount, 0) })) };
    },
  });

  // Photos: uploaded as raw image bytes, processed before they can be shown anywhere (§3.16).
  route(app, s, {
    method: 'POST', url: '/v1/photos', auth: 'user',
    query: z.object({ orgId: z.uuid().optional(), alt: z.string().trim().max(150).optional() }),
    handler: async ({ sql, query, user, req }) => {
      const org = await actingOrg(sql, user.id, query.orgId);
      const body = req.body;
      if (!Buffer.isBuffer(body)) throw badRequest('VALIDATION_FAILED', 'Send the image file.');
      return storePhoto(sql, s, org.id, user.id, body, query.alt ?? null);
    },
  });

  route(app, s, {
    method: 'GET', url: '/media/photos/:photoId/:file', auth: 'public',
    params: z.object({ photoId: z.uuid(), file: z.string().regex(/^(thumb|card|full)\.webp$/) }),
    handler: async ({ sql, params, user }) => {
      const ph = await one<{ listing_id: string | null; owner_org_id: string; status: string; live: boolean | null }>(sql,
        `select p.listing_id, p.owner_org_id, p.status, (l.status = 'live') as live from listing_photos p left join listings l on l.id = p.listing_id where p.id = $1`, [params.photoId]);
      if (!ph || ph.status !== 'ready') throw notFound('Photo');
      // Only photos on live listings are public; owners and staff can see their own drafts.
      let allowed = !!ph.live;
      if (!allowed && user) allowed = user.isStaff || !!(await one(sql, `select 1 from org_members where org_id = $1 and user_id = $2`, [ph.owner_org_id, user.id]));
      if (!allowed) throw notFound('Photo');
      const file = await s.storage.stream(`photos/${params.photoId}/${params.file}`);
      if (!file) throw notFound('Photo');
      return { __raw: { contentType: 'image/webp', body: file.body, cache: ph.live ? 'public, max-age=86400' : 'private, no-store' } };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/listings', auth: 'user',
    body: listingInput,
    handler: async ({ sql, body, user }) => {
      const { id } = await createListing(sql, s, user, body);
      return ownerView(sql, s, (await one(sql, `select * from listings where id = $1`, [id]))!);
    },
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/listings/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: listingInput.omit({ orgId: true }).extend({ expectedVersion: z.number().int().positive() }),
    handler: async ({ sql, params, body, user }) => {
      const before = await requireOwnListing(sql, user.id, params.id);
      if (before.status === 'blocked') throw conflict('BLOCKED', 'Blocked listings cannot be edited. You can appeal the decision.');
      if (before.version !== body.expectedVersion) throw conflict('STALE_VERSION', 'This listing changed since you opened it. Reload and try again.', { currentVersion: before.version });
      const { snap: snapBefore } = await snapshot(sql, params.id);
      const n = await normalizeInput(sql, s, { ...body, orgId: undefined });
      // Editing migrates the listing to the current category version (§3.3).
      const att = validateAttributes(n.cat, body.attributes as Record<string, unknown>);
      const attrs = att.ok ? att.clean : body.attributes;
      await sql.query(
        `update listings set category_slug = $2, category_version = $3, listing_type = $4, title = $5, description = $6, attributes = $7::jsonb, price_minor = $8, unit = $9, negotiable = $10, quote_on_request = $11,
           pack_value = $12, pack_unit = $13, compare_key = $14, per_base_minor = $15, region_code = $16, area_code = $17, service_areas = $18, lat = $19, lng = $20, delivery_offered = $21,
           completeness = $22, version = version + 1, updated_at = now() where id = $1`,
        [params.id, body.categorySlug, n.cat.version, n.cat.listingType, body.title, body.description, JSON.stringify(attrs), n.priceMinor == null ? null : String(n.priceMinor), body.unit,
          body.negotiable, body.quoteOnRequest, n.pack?.value ?? null, n.pack?.unit ?? null, n.cmp?.key ?? null, n.cmp?.perBaseMinor ?? null, n.area.region.code, n.area.code, body.serviceAreas,
          n.area.lat, n.area.lng, attrs.delivery_offered === true, n.completeness]);
      await attachPhotos(sql, params.id, before.seller_org_id, body.photoIds, body.photoAlts);
      const { l: after, snap: snapAfter } = await snapshot(sql, params.id);
      let outcome: 'saved' | 'published' | 'resubmitted' = 'saved';
      let material = false;
      if (before.status === 'live') {
        const m = isMaterialEdit(snapBefore, snapAfter, s.pack.moderation.materialPriceChangePct);
        material = m.material;
        if (material) {
          // Material edits go back through checks (§3.8); minor ones publish straight away as a new version.
          const r = await submitLike(sql, s, { ...after, status: 'live' }, user, 'material_edit');
          outcome = r.autoPublished ? 'published' : 'resubmitted';
        } else outcome = 'published';
      }
      await recordVersion(sql, params.id, user.id, material);
      return { outcome, listing: await ownerView(sql, s, (await one(sql, `select * from listings where id = $1`, [params.id]))!) };
    },
  });

  for (const command of ['submit', 'resubmit', 'renew', 'reopen'] as const) {
    route(app, s, {
      method: 'POST', url: `/v1/listings/:id/${command}`, auth: 'user', successStatus: 200,
      params: z.object({ id: z.uuid() }),
      body: z.object({ expectedVersion: z.number().int().positive(), confirmPrice: z.boolean().optional() }),
      handler: async ({ sql, params, body, user }) => {
        const l = await requireOwnListing(sql, user.id, params.id);
        if (l.version !== body.expectedVersion) throw conflict('STALE_VERSION', 'This listing changed since you opened it.', { currentVersion: l.version });
        if (command === 'renew' && !body.confirmPrice) throw badRequest('CONFIRM_PRICE', 'Confirm the price and availability are still correct to renew.');
        const r = await submitLike(sql, s, l, user, command);
        return { ...r, listing: await ownerView(sql, s, (await one(sql, `select * from listings where id = $1`, [params.id]))!) };
      },
    });
  }

  route(app, s, {
    method: 'POST', url: '/v1/listings/:id/close', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ reason: z.enum(CLOSE_REASONS) }),
    handler: async ({ sql, params, body, user }) => {
      const l = await requireOwnListing(sql, user.id, params.id);
      if (!listingMachine.can(l.status, 'close')) throw conflict('INVALID_TRANSITION', `A ${l.status} listing can't be closed.`);
      await sql.query(`update listings set closed_at = now(), close_reason = $2 where id = $1`, [params.id, body.reason]);
      await applyListingStatus(sql, params.id, 'closed', user.id, 'close', null, body.reason);
      await audit(sql, { actorUserId: user.id, action: 'listing.closed', targetType: 'Listing', targetId: params.id, metadata: { reason: body.reason } });
      return ownerView(sql, s, (await one(sql, `select * from listings where id = $1`, [params.id]))!);
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/my/listings', auth: 'user',
    query: z.object({ orgId: z.uuid().optional(), status: z.string().max(20).optional() }),
    handler: async ({ sql, query, user }) => {
      const org = await actingOrg(sql, user.id, query.orgId);
      const rows = await many<Record<string, any>>(sql, `select * from listings where seller_org_id = $1 and ($2::text is null or status = $2) order by updated_at desc limit 200`, [org.id, query.status ?? null]);
      return { org, items: await Promise.all(rows.map((l) => ownerView(sql, s, l))) };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/listings/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => ownerView(sql, s, await requireOwnListing(sql, user.id, params.id)),
  });

  // ---------------------------------------------------------------- public pages
  route(app, s, {
    method: 'GET', url: '/v1/public/listings/:shortId', auth: 'public',
    rateLimit: { bucket: 'browse', perMinute: (c) => c.rateLimit.browsePerMinute },
    params: z.object({ shortId: z.string().regex(/^[0-9a-f]{12}$/) }),
    handler: async ({ sql, params, user }) => {
      const l = await one<Record<string, any>>(sql, `select l.*, o.name as seller_name, o.kind as seller_kind from listings l join organizations o on o.id = l.seller_org_id where l.short_id = $1`, [params.shortId]);
      if (!l || ['draft', 'in_review', 'rejected', 'blocked'].includes(l.status)) throw notFound('Listing');
      const similar = async () => (await searchListings(sql, s, { category: l.category_slug, area: l.area_code, sort: 'relevance', page: 1 }, { limit: 7 })).groups[0]!.items
        .map((i) => i.listing).filter((x: any) => x.id !== l.id).slice(0, 6);
      if (l.status !== 'live') {
        const since = new Date(String(l.closed_at ?? l.expires_at ?? l.updated_at)).getTime();
        // Keep the URL alive with similar listings, then 410 after the configured period (§3.16).
        if (Date.now() - since > s.pack.policy.goneAfterDays * 86_400_000) throw new ApiError(410, 'GONE', 'This listing is no longer available.');
        return { available: false, title: l.title, path: listingPath(l.title, l.id), categorySlug: l.category_slug, similar: await similar() };
      }
      if (!user || !(await one(sql, `select 1 from org_members where org_id = $1 and user_id = $2`, [l.seller_org_id, user.id]))) {
        await sql.query(`select listing_count_view($1)`, [l.id]);
      }
      const cat = await categoryDef(sql, l.category_slug, l.category_version);
      const fav = user ? !!(await one(sql, `select 1 from favourites where user_id = $1 and listing_id = $2`, [user.id, l.id])) : false;
      return {
        available: true, ...cardView(l, null, s), description: l.description,
        attributes: cat.attributes.filter((a) => l.attributes?.[a.key] != null && l.attributes[a.key] !== '').map((a) => {
          const v = l.attributes[a.key];
          const display = a.type === 'enum' ? a.options?.find((o) => o.value === v)?.label ?? String(v) : a.type === 'boolean' ? (v ? 'Yes' : 'No') : a.type === 'pack_size' ? `${v.value} ${unitLabel(v.unit)}` : String(v);
          return { key: a.key, label: a.label, value: display, declared: /declared/i.test(a.label) || ['registration_number', 'registration_body', 'grade', 'standard'].includes(a.key) };
        }),
        category: { slug: cat.slug, name: cat.name, parent: cat.parent },
        serviceAreas: (l.service_areas as string[]).map((c) => findArea(s.pack, c)?.label).filter(Boolean),
        photos: (await photosOf(sql, l.id)).map(({ dhash: _d, ...p }) => p),
        seller: await sellerCard(sql, s, l.seller_org_id),
        favourite: fav, similar: await similar(), safetyTips: s.pack.safetyTips,
        // A Design Studio design behind the listing: buyers can open it on their own plot (/build?plan=<id>).
        hasDesignFile: !!(await one<{ has: boolean }>(sql, `select listing_has_design_file($1) as has`, [l.id]))?.has,
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/search', auth: 'public',
    rateLimit: { bucket: 'browse', perMinute: (c) => c.rateLimit.browsePerMinute },
    query: searchQuery,
    handler: async ({ sql, query }) => searchListings(sql, s, query),
  });

  route(app, s, {
    method: 'GET', url: '/v1/public/sellers/:handle', auth: 'public',
    rateLimit: { bucket: 'browse', perMinute: (c) => c.rateLimit.browsePerMinute },
    params: z.object({ handle: z.string().max(80) }),
    handler: async ({ sql, params }) => {
      const o = await one<{ id: string }>(sql, `select id from organizations where handle = $1`, [params.handle]);
      if (!o) throw notFound('Seller');
      const card = await sellerCard(sql, s, o.id);
      const reviews = await many<Record<string, any>>(sql, `select r.*, u.display_name from reviews r join users u on u.id = r.author_user_id where r.seller_org_id = $1 and r.status = 'published' order by r.created_at desc limit 50`, [o.id]);
      const listings = await many<Record<string, any>>(sql, `select l.*, o.name as seller_name, o.kind as seller_kind from listings l join organizations o on o.id = l.seller_org_id where l.seller_org_id = $1 and l.status = 'live' order by l.published_at desc limit 100`, [o.id]);
      const photos = listings.length ? await many<{ listing_id: string; id: string; alt_text: string | null }>(sql, `select distinct on (listing_id) listing_id, id, alt_text from listing_photos where listing_id = any($1::uuid[]) and status = 'ready' order by listing_id, position`, [listings.map((l) => l.id)]) : [];
      const ph = new Map(photos.map((x) => [x.listing_id, { urls: photoUrls(x.id), alt: x.alt_text }]));
      const serviceAreas = [...new Set(listings.flatMap((l) => [l.area_code, ...(l.service_areas as string[])]))].map((c) => findArea(s.pack, c)?.label).filter(Boolean);
      return {
        seller: card, serviceAreas,
        reviews: reviews.map((r) => ({ id: r.id, rating: r.rating, body: r.body, author: r.display_name, createdAt: iso(r.created_at), reply: r.reply_body ? { body: r.reply_body, at: iso(r.reply_at) } : null })),
        listings: listings.map((l) => cardView(l, ph.get(l.id) ?? null, s)),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/public/sitemap', auth: 'public',
    handler: async ({ sql }) => {
      // Only curated area–category pairs with real inventory go into sitemaps (§3.6).
      const pairs = await many<{ area_code: string; category_slug: string; n: number }>(sql,
        `select area_code, category_slug, count(*)::int as n from listings where status = 'live' group by area_code, category_slug having count(*) >= $1`, [s.pack.policy.sitemapMinListings]);
      const listings = await many<{ id: string; title: string; updated_at: unknown }>(sql, `select id, title, updated_at from listings where status = 'live' order by updated_at desc limit 45000`);
      const sellers = await many<{ handle: string }>(sql, `select distinct o.handle from organizations o join listings l on l.seller_org_id = o.id where l.status = 'live'`);
      return {
        pairs: pairs.map((x) => ({ area: x.area_code, category: x.category_slug, count: x.n })),
        listings: listings.map((l) => ({ path: listingPath(l.title, l.id), updatedAt: iso(l.updated_at) })),
        sellers: sellers.map((x) => `/seller/${x.handle}`),
      };
    },
  });
}

export { submitLike, requireOwnListing };
