import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PRIORITY_REPORTS, REASON_CODES, REPORT_REASONS, RESTRICTION_KINDS, REVIEW_REMOVAL_KEYS, REVIEW_REMOVAL_REASONS, listingMachine, listingPath, uuidv7, type CategoryDef, type ReasonCode, type ReportReason, type ReviewRemovalReason } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, unprocessable } from '../platform/platform.js';
import { applyListingStatus } from './effects.js';
import { photoUrls, sellerCard } from './listings.js';
import { decideTransactionReview } from './transaction-reviews.js';

/** Moderation, reports, restrictions, appeals and verification (spec §3.8–3.9, §3.11, §13.2). */
const reasonCode = z.enum(Object.keys(REASON_CODES) as [ReasonCode, ...ReasonCode[]]);

async function orgMembers(sql: Sql, orgId: string) {
  return (await many<{ user_id: string }>(sql, `select user_id from org_members where org_id = $1`, [orgId])).map((m) => m.user_id);
}

async function hasPassedCheck(sql: Sql, orgId: string, type?: string) {
  return !!(await one(sql, `select 1 from verification_checks where org_id = $1 and state = 'passed' and ($2::text is null or check_type = $2) and (expires_at is null or expires_at > now())`, [orgId, type ?? null]));
}

export function registerModeration(app: FastifyInstance, s: Services) {
  // ---------------------------------------------------------------- queue
  route(app, s, {
    method: 'GET', url: '/v1/moderation/queue', auth: 'staff',
    handler: async ({ sql }) => {
      const rows = await many<Record<string, any>>(sql,
        `select l.*, o.name as seller_name, o.kind as seller_kind, o.handle,
                (select count(*)::int from moderation_decisions d join listings x on x.id = d.listing_id where x.seller_org_id = l.seller_org_id and d.decision in ('reject','block')) as seller_rejections,
                (select count(*)::int from listings x where x.seller_org_id = l.seller_org_id and x.status = 'live') as seller_live,
                (select count(*)::int from reports r where r.target_type = 'listing' and r.target_id = l.id and r.status = 'open') as open_reports
           from listings l join organizations o on o.id = l.seller_org_id
          where l.status = 'in_review' order by l.risk_score desc, l.updated_at asc limit 100`);
      return {
        items: await Promise.all(rows.map(async (l) => {
          const signals = (typeof l.signals === 'string' ? JSON.parse(l.signals) : l.signals) as { code: string; detail: string; weight: number }[];
          const matchIds = signals.find((x) => x.code === 'reused_photos_match')?.detail.split(',').filter(Boolean) ?? [];
          const matches = matchIds.length ? await many<Record<string, any>>(sql, `select l.id, l.title, o.name from listings l join organizations o on o.id = l.seller_org_id where l.id = any($1::uuid[])`, [matchIds]) : [];
          const photos = await many<{ id: string; alt_text: string | null }>(sql, `select id, alt_text from listing_photos where listing_id = $1 and status = 'ready' order by position`, [l.id]);
          return {
            id: l.id, title: l.title, description: l.description, categorySlug: l.category_slug, version: l.version, riskScore: l.risk_score,
            price: l.price_minor == null ? null : { amountMinor: String(l.price_minor), currency: l.currency }, unit: l.unit, attributes: l.attributes,
            signals: signals.filter((x) => x.code !== 'reused_photos_match'), matchingListings: matches.map((m) => ({ id: m.id, title: m.title, seller: m.name, path: listingPath(m.title, m.id) })),
            photos: photos.map((p) => ({ id: p.id, alt: p.alt_text, urls: photoUrls(p.id) })),
            seller: { orgId: l.seller_org_id, name: l.seller_name, kind: l.seller_kind, handle: l.handle, liveListings: l.seller_live, priorRejections: l.seller_rejections },
            openReports: l.open_reports, waitingSince: iso(l.updated_at),
          };
        })),
        reasonCodes: Object.entries(REASON_CODES).map(([code, message]) => ({ code, message })),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/listings/:id/decide', auth: 'staff', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ decision: z.enum(['approve', 'reject', 'block']), reasonCode: reasonCode.optional(), note: z.string().trim().max(1000).optional(), expectedVersion: z.number().int().positive() }),
    handler: async ({ sql, params, body, user }) => {
      const l = await one<Record<string, any>>(sql, `select * from listings where id = $1 for update`, [params.id]);
      if (!l) throw notFound('Listing');
      if (l.version !== body.expectedVersion) throw conflict('STALE_VERSION', 'The seller changed this listing; review the new version.', { currentVersion: l.version });
      if (body.decision !== 'approve' && !body.reasonCode) throw badRequest('REASON_REQUIRED', 'Choose a reason code; the seller sees its plain message.');
      if (!listingMachine.can(l.status, body.decision)) throw conflict('INVALID_TRANSITION', `A ${l.status} listing can't be ${body.decision}d.`);
      const to = listingMachine.next(l.status, body.decision);
      const decisionId = uuidv7();
      // QA sampling: a share of decisions is re-reviewed (§3.9).
      const qa = Math.random() * 100 < s.pack.moderation.qaSamplePct;
      await sql.query(`insert into moderation_decisions (id, listing_id, listing_version, decision, reason_code, note, moderator_user_id, qa_sample) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [decisionId, l.id, l.version, body.decision, body.reasonCode ?? null, body.note ?? null, user.id, qa]);
      if (to === 'live') {
        const cat = await one<{ definition: CategoryDef }>(sql, `select definition from category_versions where slug = $1 and version = $2`, [l.category_slug, l.category_version]);
        const def = typeof cat!.definition === 'string' ? JSON.parse(cat!.definition) : cat!.definition;
        await sql.query(`update listings set published_at = coalesce(published_at, now()), expires_at = coalesce(case when expires_at > now() then expires_at end, now() + make_interval(days => $2)) where id = $1`, [l.id, def.listingPeriodDays]);
      } else {
        await sql.query(`update listings set rejection_code = $2, rejection_note = $3 where id = $1`, [l.id, body.reasonCode, body.note ?? null]);
      }
      await applyListingStatus(sql, l.id, to, user.id, body.decision, body.reasonCode ?? null, body.note ?? null);
      await sql.query(`update reports set status = 'actioned', decided_by = $2, decided_at = now(), decision_note = $3 where target_type = 'listing' and target_id = $1 and status = 'open'`, [l.id, user.id, `Listing ${body.decision}d`]);
      if (to !== 'live') {
        await notify(sql, await orgMembers(sql, l.seller_org_id), {
          kind: 'listing_decision', title: to === 'blocked' ? 'Your listing was blocked' : 'Your listing needs changes',
          body: `${l.title}: ${REASON_CODES[body.reasonCode!]}${body.note ? ` (${body.note})` : ''}`, link: '/my-ads',
        });
      }
      await audit(sql, { actorUserId: user.id, action: `moderation.${body.decision}`, targetType: 'Listing', targetId: l.id, reason: body.reasonCode ?? null, metadata: { decisionId, version: l.version, qaSample: qa } });
      return { status: to, decisionId };
    },
  });

  // ---------------------------------------------------------------- reports
  route(app, s, {
    method: 'POST', url: '/v1/reports', auth: 'user',
    body: z.object({ targetType: z.enum(['listing', 'seller', 'message', 'review', 'transaction_review']), targetId: z.uuid(), reason: z.enum(Object.keys(REPORT_REASONS) as [ReportReason, ...ReportReason[]]), details: z.string().trim().max(2000).optional() }),
    handler: async ({ sql, body, user }) => {
      const dup = await one(sql, `select 1 from reports where reporter_user_id = $1 and target_type = $2 and target_id = $3 and status = 'open'`, [user.id, body.targetType, body.targetId]);
      if (dup) throw conflict('ALREADY_REPORTED', 'You have already reported this. We will review it.');
      const id = uuidv7();
      await sql.query(`insert into reports (id, target_type, target_id, reason, details, priority, reporter_user_id) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, body.targetType, body.targetId, body.reason, body.details ?? null, PRIORITY_REPORTS.includes(body.reason), user.id]);
      if (body.targetType === 'listing') {
        const l = await one<{ status: string }>(sql, `select status from listings where id = $1`, [body.targetId]);
        const n = await one<{ n: number }>(sql, `select count(distinct reporter_user_id)::int as n from reports where target_type = 'listing' and target_id = $1 and status = 'open'`, [body.targetId]);
        // Enough reports send a live listing back to review (§3.8 "flag").
        if (l?.status === 'live' && (n?.n ?? 0) >= s.pack.moderation.reportThreshold) await applyListingStatus(sql, body.targetId, 'in_review', null, 'flag', 'scam_signals', 'Report threshold reached');
        await publish(sql, 'ListingReported', { listingId: body.targetId, reason: body.reason });
      }
      return { id, received: true, message: 'Thanks. A moderator will review this.' };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/moderation/reports', auth: 'staff',
    handler: async ({ sql }) => {
      const rows = await many<Record<string, any>>(sql, `select r.*, u.display_name as reporter from reports r join users u on u.id = r.reporter_user_id where r.status = 'open' order by r.priority desc, r.created_at asc limit 200`);
      return { items: await Promise.all(rows.map(async (r) => ({ id: r.id, targetType: r.target_type, targetId: r.target_id, reason: r.reason, reasonLabel: REPORT_REASONS[r.reason as ReportReason], details: r.details, priority: r.priority, reporter: r.reporter, createdAt: iso(r.created_at), target: await reportTarget(sql, r.target_type, r.target_id) }))),
        reviewRemovalReasons: REVIEW_REMOVAL_KEYS.map((k) => ({ value: k, label: REVIEW_REMOVAL_REASONS[k] })) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/reports/:id/decide', auth: 'staff', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({
      outcome: z.enum(['dismissed', 'actioned']), note: z.string().trim().min(3).max(1000), removeReview: z.boolean().optional(), releaseMessage: z.boolean().optional(),
      reviewRemovalReason: z.enum(REVIEW_REMOVAL_KEYS as [ReviewRemovalReason, ...ReviewRemovalReason[]]).optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Record<string, any>>(sql, `select * from reports where id = $1`, [params.id]);
      if (!r || r.status !== 'open') throw notFound('Report');
      if (r.target_type === 'review' && body.removeReview) await sql.query(`update reviews set status = 'removed', removed_reason = $2 where id = $1`, [r.target_id, body.note]);
      if (r.target_type === 'transaction_review' && body.removeReview) {
        // Removing a transaction review needs a policy reason (§13.4); a provider asking is not one.
        if (!body.reviewRemovalReason) throw badRequest('REASON_REQUIRED', 'Choose the policy reason for removing this review.');
        const t = await one<Record<string, any>>(sql, `select * from transaction_reviews where id = $1`, [r.target_id]);
        if (t) await decideTransactionReview(sql, t, user.id, body.reviewRemovalReason, body.note);
      }
      await sql.query(`update reports set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [r.id, body.outcome, user.id, body.note]);
      await audit(sql, { actorUserId: user.id, action: `report.${body.outcome}`, targetType: 'Report', targetId: r.id, reason: body.note });
      return { status: body.outcome };
    },
  });

  // ---------------------------------------------------------------- restrictions (two-person for verified businesses / impersonation)
  route(app, s, {
    method: 'POST', url: '/v1/moderation/restrictions', auth: 'staff',
    body: z.object({ orgId: z.uuid(), kind: z.enum(RESTRICTION_KINDS), reason: z.string().trim().min(5).max(500), days: z.number().int().min(1).max(3650).nullable().optional(), impersonation: z.boolean().default(false) }),
    handler: async ({ sql, body, user }) => {
      if (!(await one(sql, `select 1 from organizations where id = $1`, [body.orgId]))) throw notFound('Seller');
      const needsSecond = body.impersonation || (await hasPassedCheck(sql, body.orgId, 'business_registration'));
      const id = uuidv7();
      await sql.query(`insert into seller_restrictions (id, org_id, kind, reason, status, ends_at, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, body.orgId, body.kind, body.reason, needsSecond ? 'pending_second_approval' : 'active', body.days ? new Date(Date.now() + body.days * 86_400_000).toISOString() : null, user.id]);
      if (!needsSecond) await enforceRestriction(sql, id, user.id);
      await audit(sql, { actorUserId: user.id, action: 'restriction.created', targetType: 'Organization', targetId: body.orgId, reason: body.reason, metadata: { restrictionId: id, kind: body.kind, needsSecond } });
      return { id, status: needsSecond ? 'pending_second_approval' : 'active' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/restrictions/:id/approve', auth: 'staff', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await one<Record<string, any>>(sql, `select * from seller_restrictions where id = $1`, [params.id]);
      if (!r || r.status !== 'pending_second_approval') throw notFound('Pending restriction');
      if (r.created_by === user.id) throw forbidden('A second moderator must approve this restriction.');
      await sql.query(`update seller_restrictions set status = 'active', approved_by = $2, starts_at = now() where id = $1`, [r.id, user.id]);
      await enforceRestriction(sql, r.id, user.id);
      await audit(sql, { actorUserId: user.id, action: 'restriction.approved', targetType: 'Organization', targetId: r.org_id, metadata: { restrictionId: r.id } });
      return { status: 'active' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/restrictions/:id/lift', auth: 'staff', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ note: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Record<string, any>>(sql, `select * from seller_restrictions where id = $1`, [params.id]);
      if (!r || !['active', 'pending_second_approval'].includes(r.status)) throw notFound('Restriction');
      await sql.query(`update seller_restrictions set status = 'lifted' where id = $1`, [r.id]);
      await publish(sql, 'SellerRestrictionLifted', { orgId: r.org_id, restrictionId: r.id });
      await audit(sql, { actorUserId: user.id, action: 'restriction.lifted', targetType: 'Organization', targetId: r.org_id, reason: body.note });
      return { status: 'lifted' };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/moderation/sellers/:orgId', auth: 'staff',
    params: z.object({ orgId: z.uuid() }),
    handler: async ({ sql, params }) => {
      const card = await sellerCard(sql, s, params.orgId);
      if (!card) throw notFound('Seller');
      const restrictions = await many<Record<string, any>>(sql, `select * from seller_restrictions where org_id = $1 order by created_at desc`, [params.orgId]);
      const listings = await many<Record<string, any>>(sql, `select id, title, status, risk_score, updated_at from listings where seller_org_id = $1 order by updated_at desc limit 50`, [params.orgId]);
      return {
        seller: card,
        restrictions: restrictions.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, status: r.status, endsAt: iso(r.ends_at), createdAt: iso(r.created_at) })),
        listings: listings.map((l) => ({ id: l.id, title: l.title, status: l.status, riskScore: l.risk_score, updatedAt: iso(l.updated_at) })),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/my/restrictions', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql,
        `select r.*, a.status as appeal_status from seller_restrictions r join org_members m on m.org_id = r.org_id left join appeals a on a.target_id = r.id
          where m.user_id = $1 and r.status in ('active') order by r.created_at desc`, [user.id]);
      return { items: rows.map((r) => ({ id: r.id, kind: r.kind, reason: r.reason, endsAt: iso(r.ends_at), appealStatus: r.appeal_status ?? null })) };
    },
  });

  // ---------------------------------------------------------------- appeals (one per decision; a different moderator decides)
  route(app, s, {
    method: 'POST', url: '/v1/appeals', auth: 'user',
    body: z.object({ targetType: z.enum(['moderation_decision', 'restriction']), targetId: z.uuid(), statement: z.string().trim().min(10).max(2000) }),
    handler: async ({ sql, body, user }) => {
      const t = body.targetType === 'moderation_decision'
        ? await one<{ org_id: string; decider: string; decision: string }>(sql, `select l.seller_org_id as org_id, d.moderator_user_id as decider, d.decision from moderation_decisions d join listings l on l.id = d.listing_id where d.id = $1`, [body.targetId])
        : await one<{ org_id: string; decider: string; decision: string }>(sql, `select org_id, coalesce(approved_by, created_by) as decider, 'restrict' as decision from seller_restrictions where id = $1 and status = 'active'`, [body.targetId]);
      if (!t) throw notFound('Decision');
      if (body.targetType === 'moderation_decision' && !['reject', 'block'].includes(t.decision)) throw unprocessable('NOT_APPEALABLE', 'Only rejections and blocks can be appealed.');
      const m = await one<{ role: string }>(sql, `select role from org_members where org_id = $1 and user_id = $2`, [t.org_id, user.id]);
      if (!m || !['owner', 'admin'].includes(m.role)) throw notFound('Decision');
      if (await one(sql, `select 1 from appeals where target_id = $1`, [body.targetId])) throw conflict('ALREADY_APPEALED', 'Each decision can be appealed once.');
      const id = uuidv7();
      await sql.query(`insert into appeals (id, target_type, target_id, seller_org_id, submitted_by, statement, original_decider) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, body.targetType, body.targetId, t.org_id, user.id, body.statement, t.decider]);
      await audit(sql, { actorUserId: user.id, action: 'appeal.submitted', targetType: body.targetType, targetId: body.targetId });
      return { id, status: 'open' };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/moderation/appeals', auth: 'staff',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql, `select a.*, o.name as seller from appeals a join organizations o on o.id = a.seller_org_id where a.status = 'open' order by a.created_at`);
      return {
        items: await Promise.all(rows.map(async (a) => ({
          id: a.id, targetType: a.target_type, targetId: a.target_id, seller: a.seller, statement: a.statement, createdAt: iso(a.created_at),
          canDecide: a.original_decider !== user.id,
          original: a.target_type === 'moderation_decision'
            ? await one<Record<string, any>>(sql, `select d.decision, d.reason_code, d.note, l.title, l.id as listing_id from moderation_decisions d join listings l on l.id = d.listing_id where d.id = $1`, [a.target_id])
            : await one<Record<string, any>>(sql, `select kind, reason from seller_restrictions where id = $1`, [a.target_id]),
        }))),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/appeals/:id/decide', auth: 'staff', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ outcome: z.enum(['upheld', 'overturned']), note: z.string().trim().min(5).max(1000) }),
    handler: async ({ sql, params, body, user }) => {
      const a = await one<Record<string, any>>(sql, `select * from appeals where id = $1`, [params.id]);
      if (!a || a.status !== 'open') throw notFound('Appeal');
      if (a.original_decider === user.id) throw forbidden('A different moderator must decide this appeal.');
      await sql.query(`update appeals set status = $2, decided_by = $3, decided_at = now(), note = $4 where id = $1`, [a.id, body.outcome, user.id, body.note]);
      if (body.outcome === 'overturned') {
        if (a.target_type === 'moderation_decision') {
          const d = await one<{ listing_id: string }>(sql, `select listing_id from moderation_decisions where id = $1`, [a.target_id]);
          const l = await one<{ status: string; version: number }>(sql, `select status, version from listings where id = $1`, [d!.listing_id]);
          if (l && listingMachine.can(l.status as any, 'overturn')) {
            await sql.query(`insert into moderation_decisions (id, listing_id, listing_version, decision, note, moderator_user_id) values ($1, $2, $3, 'overturn', $4, $5)`, [uuidv7(), d!.listing_id, l.version, body.note, user.id]);
            await sql.query(`update listings set rejection_code = null, rejection_note = null where id = $1`, [d!.listing_id]);
            await applyListingStatus(sql, d!.listing_id, 'in_review', user.id, 'overturn', null, body.note);
          }
        } else {
          await sql.query(`update seller_restrictions set status = 'overturned' where id = $1`, [a.target_id]);
        }
      }
      await notify(sql, await orgMembers(sql, a.seller_org_id), { kind: 'appeal_decided', title: body.outcome === 'overturned' ? 'Your appeal was successful' : 'Your appeal was not upheld', body: body.note, link: '/my-ads' });
      await publish(sql, 'AppealDecided', { appealId: a.id, outcome: body.outcome });
      await audit(sql, { actorUserId: user.id, action: `appeal.${body.outcome}`, targetType: a.target_type, targetId: a.target_id, reason: body.note });
      return { status: body.outcome };
    },
  });

  // ---------------------------------------------------------------- held messages and pending reviews
  route(app, s, {
    method: 'GET', url: '/v1/moderation/held', auth: 'staff',
    handler: async ({ sql }) => {
      const messages = await many<Record<string, any>>(sql, `select m.id, m.body, m.created_at, u.display_name from messages m join users u on u.id = m.sender_user_id where m.held order by m.created_at limit 100`);
      const reviews = await many<Record<string, any>>(sql, `select r.id, r.body, r.rating, r.created_at, o.name as seller from reviews r join organizations o on o.id = r.seller_org_id where r.status = 'pending' order by r.created_at limit 100`);
      return {
        messages: messages.map((m) => ({ id: m.id, body: m.body, sender: m.display_name, at: iso(m.created_at) })),
        reviews: reviews.map((r) => ({ id: r.id, body: r.body, rating: r.rating, seller: r.seller, at: iso(r.created_at) })),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/messages/:id/release', auth: 'staff', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ release: z.boolean(), note: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      if (body.release) await sql.query(`update messages set held = false where id = $1`, [params.id]);
      await audit(sql, { actorUserId: user.id, action: body.release ? 'message.released' : 'message.kept_held', targetType: 'Message', targetId: params.id, reason: body.note });
      return { released: body.release };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/reviews/:id/decide', auth: 'staff', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ publish: z.boolean(), note: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<{ seller_org_id: string }>(sql, `select seller_org_id from reviews where id = $1`, [params.id]);
      if (!r) throw notFound('Review');
      await sql.query(`update reviews set status = $2, removed_reason = $3 where id = $1`, [params.id, body.publish ? 'published' : 'removed', body.publish ? null : body.note]);
      if (body.publish) await publish(sql, 'SellerReviewPublished', { reviewId: params.id, sellerOrgId: r.seller_org_id });
      await audit(sql, { actorUserId: user.id, action: body.publish ? 'review.published' : 'review.removed', targetType: 'Review', targetId: params.id, reason: body.note });
      return { status: body.publish ? 'published' : 'removed' };
    },
  });

  // ---------------------------------------------------------------- verification checks and reserved names (§13.2, §3.11)
  route(app, s, {
    method: 'POST', url: '/v1/moderation/sellers/:orgId/checks', auth: 'staff',
    params: z.object({ orgId: z.uuid() }),
    body: z.object({ checkType: z.enum(['identity_contact', 'business_registration', 'professional_credential', 'trade_reference', 'stock_evidence']), state: z.enum(['passed', 'failed', 'revoked']), source: z.string().trim().min(3).max(200), expiresAt: z.iso.date().optional(), note: z.string().max(500).optional(), reserveName: z.boolean().default(false) }),
    handler: async ({ sql, params, body, user }) => {
      const id = uuidv7();
      await sql.query(`insert into verification_checks (id, org_id, check_type, state, source, checked_by, expires_at, note) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, params.orgId, body.checkType, body.state, body.source, user.id, body.expiresAt ?? null, body.note ?? null]);
      if (body.reserveName && body.state === 'passed' && body.checkType === 'business_registration') await sql.query(`update organizations set reserved_name = true where id = $1`, [params.orgId]);
      await audit(sql, { actorUserId: user.id, action: `verification.${body.state}`, targetType: 'Organization', targetId: params.orgId, metadata: { checkType: body.checkType, source: body.source } });
      return { id };
    },
  });

  // ---------------------------------------------------------------- category configuration (versioned, change never rewrites live listings, §3.3)
  route(app, s, {
    method: 'GET', url: '/v1/admin/categories', auth: 'staff',
    handler: async ({ sql }) => ({
      items: (await many<Record<string, any>>(sql, `select c.slug, c.name, c.parent_slug, c.current_version, c.status, v.definition, v.created_at from categories c join category_versions v on v.slug = c.slug and v.version = c.current_version order by c.sort, c.name`))
        .map((c) => ({ slug: c.slug, name: c.name, parent: c.parent_slug, version: c.current_version, status: c.status, definition: typeof c.definition === 'string' ? JSON.parse(c.definition) : c.definition, publishedAt: iso(c.created_at) })),
    }),
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/categories/:slug/versions', auth: 'staff',
    params: z.object({ slug: z.string().max(60) }),
    body: z.object({ definition: z.record(z.string(), z.unknown()), note: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      if (user.staffRole !== 'ops_admin') throw forbidden('Only operations admins can change category configuration.');
      const c = await one<{ current_version: number; name: string }>(sql, `select current_version, name from categories where slug = $1`, [params.slug]);
      if (!c) throw notFound('Category');
      const d = body.definition as Partial<CategoryDef>;
      if (!Array.isArray(d.attributes) || !Array.isArray(d.priceUnits) || typeof d.minPhotos !== 'number' || typeof d.listingPeriodDays !== 'number') throw badRequest('INVALID_DEFINITION', 'A category version needs attributes, price units, minimum photos and a listing period.');
      const version = c.current_version + 1;
      await sql.query(`insert into category_versions (slug, version, definition, created_by) values ($1, $2, $3::jsonb, $4)`, [params.slug, version, JSON.stringify({ ...d, slug: params.slug }), user.id]);
      await sql.query(`update categories set current_version = $2, name = coalesce($3, name) where slug = $1`, [params.slug, version, d.name ?? null]);
      await audit(sql, { actorUserId: user.id, action: 'category.version_published', targetType: 'Category', targetId: params.slug, reason: body.note, metadata: { version } });
      return { slug: params.slug, version };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/moderation/audit', auth: 'staff',
    query: z.object({ targetId: z.string().max(80).optional() }),
    handler: async ({ sql, query }) => ({
      items: (await many<Record<string, any>>(sql, `select a.*, u.display_name from audit_events a left join users u on u.id = a.actor_user_id where ($1::text is null or a.target_id = $1) order by a.seq desc limit 200`, [query.targetId ?? null]))
        .map((a) => ({ seq: Number(a.seq), action: a.action, actor: a.display_name, targetType: a.target_type, targetId: a.target_id, reason: a.reason, metadata: a.metadata, at: iso(a.created_at) })),
    }),
  });
}

async function enforceRestriction(sql: Sql, restrictionId: string, actorId: string) {
  const r = await one<{ org_id: string; kind: string; reason: string }>(sql, `select org_id, kind, reason from seller_restrictions where id = $1`, [restrictionId]);
  if (!r) return;
  if (r.kind === 'listing_suspension' || r.kind === 'account_suspension') {
    const live = await many<{ id: string }>(sql, `select id from listings where seller_org_id = $1 and status in ('live', 'in_review')`, [r.org_id]);
    for (const l of live) await applyListingStatus(sql, l.id, 'blocked', actorId, 'block', 'other', `Seller restricted: ${r.reason}`);
  }
  await notify(sql, await orgMembers(sql, r.org_id), { kind: 'restriction', title: 'Your seller account is restricted', body: `${r.kind.replace('_', ' ')}: ${r.reason}. You can appeal once.`, link: '/my-ads' });
  await publish(sql, 'SellerRestricted', { orgId: r.org_id, kind: r.kind });
}

async function reportTarget(sql: Sql, type: string, id: string) {
  if (type === 'listing') { const l = await one<Record<string, any>>(sql, `select id, title, status, seller_org_id from listings where id = $1`, [id]); return l ? { title: l.title, status: l.status, path: listingPath(l.title, l.id), sellerOrgId: l.seller_org_id } : null; }
  if (type === 'seller') { const o = await one<Record<string, any>>(sql, `select name, handle from organizations where id = $1`, [id]); return o ? { title: o.name, path: `/seller/${o.handle}`, sellerOrgId: id } : null; }
  if (type === 'review') { const r = await one<Record<string, any>>(sql, `select body, seller_org_id from reviews where id = $1`, [id]); return r ? { title: r.body.slice(0, 120), sellerOrgId: r.seller_org_id } : null; }
  if (type === 'transaction_review') { const r = await one<Record<string, any>>(sql, `select body, provider_org_id, status from transaction_reviews where id = $1`, [id]); return r ? { title: r.body.slice(0, 120), sellerOrgId: r.provider_org_id, status: r.status } : null; }
  const m = await one<Record<string, any>>(sql, `select body from messages where id = $1`, [id]);
  return m ? { title: m.body.slice(0, 120) } : null;
}
