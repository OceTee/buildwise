import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  counterpartVisible, findArea, overallRating, ratingProblems, REVIEW_DIMENSIONS, REVIEW_REMOVAL_KEYS, REVIEW_REMOVAL_REASONS, reviewEligibilityFor, scanText,
  TRANSACTION_REVIEW_NOTICE, uuidv7,
  type OrderState, type ReviewRemovalReason, type ReviewSide, STAFF_ACCESS } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, conflict, forbidden, notFound, notify, publish, unprocessable } from '../platform/platform.js';
import { orderSide, orgUsers, type OrderSide } from './parties.js';

/**
 * Transaction reviews, R3 third slice (spec §13.4). After a completed or terminated order each side reviews the other
 * once, within the market pack's window: structured ratings plus text, checked with the same content rules as
 * listings (contact details, payment instructions, scam phrases). A flagged review waits for a moderator. The other
 * side's review stays hidden until both have reviewed or the window closes. The reviewed side may reply once.
 * Removal needs a policy reason and is audited.
 */

type Row = Record<string, any>;
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const removalReason = z.enum(REVIEW_REMOVAL_KEYS as [ReviewRemovalReason, ...ReviewRemovalReason[]]);

const orderFacts = (o: Row) => ({ state: o.state as OrderState, confirmedAt: iso(o.confirmed_at), fulfilledAt: iso(o.fulfilled_at), closedAt: iso(o.closed_at), updatedAt: iso(o.updated_at)! });

function reviewView(r: Row) {
  const ratings = json<Record<string, number>>(r.ratings);
  return {
    id: r.id, side: r.author_side, status: r.status, overall: Number(r.overall), body: r.body, at: iso(r.created_at),
    ratings: REVIEW_DIMENSIONS[r.author_side as ReviewSide].map((d) => ({ key: d.key, label: d.label, value: ratings[d.key] ?? null })),
    held: r.status === 'pending', removed: r.status === 'removed' ? { reason: REVIEW_REMOVAL_REASONS[r.removed_reason as ReviewRemovalReason] } : null,
    reply: r.reply_body ? { body: r.reply_body, at: iso(r.reply_at) } : null,
  };
}

const canWrite = (side: OrderSide) => side.side === 'provider' || side.canManage;

async function reviewsOf(sql: Sql, orderId: string) {
  return many<Row>(sql, `select * from transaction_reviews where order_id = $1`, [orderId]);
}

export function registerTransactionReviews(app: FastifyInstance, s: Services) {
  const cfg = s.pack.reviews;

  route(app, s, {
    method: 'GET', url: '/v1/orders/:id/reviews', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const side = await orderSide(sql, user, params.id);
      const rows = await reviewsOf(sql, side.o.id);
      const mine = rows.find((r) => r.author_side === side.side) ?? null;
      const theirs = rows.find((r) => r.author_side !== side.side) ?? null;
      const now = new Date();
      const elig = reviewEligibilityFor(orderFacts(side.o), !!mine, now, cfg);
      const both = !!mine && !!theirs;
      const visible = !!theirs && theirs.status !== 'pending' && counterpartVisible(both, elig.closesAt, now);
      return {
        side: side.side, notice: TRANSACTION_REVIEW_NOTICE,
        canReview: canWrite(side) && elig.ok, reason: elig.ok ? null : elig.reason, closesAt: elig.closesAt,
        reviewsSubject: side.side === 'client' ? 'the supplier' : 'the client',
        dimensions: REVIEW_DIMENSIONS[side.side], minBodyChars: cfg.minBodyChars, maxBodyChars: cfg.maxBodyChars, maxReplyChars: cfg.maxReplyChars,
        mine: mine ? reviewView(mine) : null,
        theirs: visible ? { ...reviewView(theirs!), canReply: canWrite(side) && !theirs!.reply_body && theirs!.status === 'published' } : null,
        theirsWaiting: !!theirs && !visible,
        theirsWaitingText: theirs && !visible ? `The ${side.side === 'client' ? 'supplier' : 'client'} has reviewed you. You see it once you have reviewed too, or when reviews close.` : null,
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/reviews', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ ratings: z.record(z.string(), z.number().int()), body: z.string().trim().min(cfg.minBodyChars).max(cfg.maxBodyChars) }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (!canWrite(side)) throw forbidden('Only the project owner or a manager reviews for the client.');
      const o = side.o;
      const rows = await reviewsOf(sql, o.id);
      const elig = reviewEligibilityFor(orderFacts(o), rows.some((r) => r.author_side === side.side), new Date(), cfg);
      if (!elig.ok) throw conflict('NOT_REVIEWABLE', elig.reason);
      const problems = ratingProblems(side.side, body.ratings);
      if (problems.length) throw unprocessable('RATINGS_INVALID', problems[0]!, { problems });
      // Same content checks as listings and chat: contact details, payment instructions, scam phrases (§13.4 personal data).
      const findings = scanText(body.body, s.pack);
      const status = findings.length ? 'pending' : 'published';
      const r = (await one<Row>(sql, `select category_slug, area_code from rfqs where id = $1`, [o.rfq_id]))!;
      const id = uuidv7();
      await sql.query(`insert into transaction_reviews (id, order_id, project_id, provider_org_id, author_user_id, author_side, category_slug, area_code, ratings, overall, body, status, hold_reasons, window_closes_at)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13::jsonb, $14)`,
        [id, o.id, o.project_id, o.provider_org_id, user.id, side.side, r.category_slug, r.area_code, JSON.stringify(body.ratings), overallRating(body.ratings), body.body, status, JSON.stringify(findings), elig.closesAt]);
      const other = side.side === 'client'
        ? { users: await orgUsers(sql, o.provider_org_id), link: `/provider/orders/${o.id}#reviews` }
        : { users: [o.awarded_by], link: `/projects/${o.project_id}/orders/${o.id}#reviews` };
      await notify(sql, other.users, { kind: 'review', title: `The ${side.side === 'client' ? 'client' : 'supplier'} reviewed your order`, body: 'Leave your own review to see theirs. Reviews close on the date shown on the order.', link: other.link });
      await publish(sql, 'TransactionReviewSubmitted', { reviewId: id, orderId: o.id, orgId: o.provider_org_id, side: side.side, held: status === 'pending' });
      await audit(sql, { actorUserId: user.id, action: 'transaction_review.created', targetType: 'TransactionReview', targetId: id, metadata: { orderId: o.id, side: side.side, held: status === 'pending', findings: findings.map((f) => f.code) } });
      return {
        id, status,
        message: status === 'pending' ? 'Thanks. Your review mentions contact or payment details, so a moderator checks it before it is shown.' : 'Thanks. Your review is saved.',
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/transaction-reviews/:id/reply', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ body: z.string().trim().min(2).max(cfg.maxReplyChars) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Row>(sql, `select * from transaction_reviews where id = $1`, [params.id]);
      if (!r) throw notFound('Review');
      const side = await orderSide(sql, user, r.order_id).catch(() => { throw notFound('Review'); });
      if (side.side === r.author_side) throw forbidden('You cannot reply to your own review.');
      if (!canWrite(side)) throw forbidden();
      if (r.status !== 'published') throw conflict('NOT_PUBLISHED', 'You can reply once the review is published.');
      if (r.reply_body) throw conflict('ALREADY_REPLIED', 'You can reply to a review once.');
      await sql.query(`update transaction_reviews set reply_body = $2, reply_by = $3, reply_at = now() where id = $1`, [r.id, body.body, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'transaction_review.replied', targetType: 'TransactionReview', targetId: r.id });
      return { ok: true };
    },
  });

  // ---------------------------------------------------------------- moderation (held and reported reviews)
  route(app, s, {
    method: 'GET', url: '/v1/moderation/transaction-reviews', auth: 'staff', staffRoles: STAFF_ACCESS.moderation, systemContext: true,
    handler: async ({ sql }) => {
      const rows = await many<Row>(sql, `select t.*, o.name as provider, u.display_name as author,
          (select count(*)::int from reports r where r.target_type = 'transaction_review' and r.target_id = t.id and r.status = 'open') as open_reports
        from transaction_reviews t join organizations o on o.id = t.provider_org_id join users u on u.id = t.author_user_id
        where t.status = 'pending' or exists (select 1 from reports r where r.target_type = 'transaction_review' and r.target_id = t.id and r.status = 'open')
        order by t.created_at limit 200`);
      return {
        reasons: REVIEW_REMOVAL_KEYS.map((k) => ({ value: k, label: REVIEW_REMOVAL_REASONS[k] })),
        items: rows.map((t) => ({
          ...reviewView(t), provider: t.provider, author: t.author, area: findArea(s.pack, t.area_code)?.label ?? t.area_code,
          holdReasons: json<{ code: string; detail: string }[]>(t.hold_reasons).map((f) => f.detail), openReports: t.open_reports,
        })),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/transaction-reviews/:id/decide', auth: 'staff', staffRoles: STAFF_ACCESS.moderation, systemContext: true, successStatus: 200, params: z.object({ id: z.uuid() }),
    body: z.object({ publish: z.boolean(), reasonCode: removalReason.optional(), note: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Row>(sql, `select * from transaction_reviews where id = $1`, [params.id]);
      if (!r) throw notFound('Review');
      const out = await decideTransactionReview(sql, r, user.id, body.publish ? null : body.reasonCode ?? null, body.note);
      await sql.query(`update reports set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where target_type = 'transaction_review' and target_id = $1 and status = 'open'`,
        [r.id, body.publish ? 'dismissed' : 'actioned', user.id, body.note]);
      return out;
    },
  });
}

/**
 * Publish a held review, or remove one for a stated policy reason. Never because a provider asked (§13.4): a removal
 * without a reason code is refused, and every decision is audited.
 */
export async function decideTransactionReview(sql: Sql, r: Row, staffId: string, removeFor: ReviewRemovalReason | null, note: string) {
  if (removeFor === null) {
    if (r.status === 'removed') throw conflict('REMOVED', 'This review was removed.');
    await sql.query(`update transaction_reviews set status = 'published', decided_by = $2, decided_at = now() where id = $1`, [r.id, staffId]);
    if (r.status === 'pending') await publish(sql, 'TransactionReviewPublished', { reviewId: r.id, orgId: r.provider_org_id });
    await audit(sql, { actorUserId: staffId, action: 'transaction_review.published', targetType: 'TransactionReview', targetId: r.id, reason: note });
    return { status: 'published' };
  }
  await sql.query(`update transaction_reviews set status = 'removed', removed_reason = $2, removed_note = $3, decided_by = $4, decided_at = now() where id = $1`, [r.id, removeFor, note, staffId]);
  await notify(sql, [r.author_user_id], { kind: 'review', title: 'Your review was removed', body: `${REVIEW_REMOVAL_REASONS[removeFor]}. ${note}`, link: null });
  await publish(sql, 'TransactionReviewRemoved', { reviewId: r.id, orgId: r.provider_org_id, reason: removeFor });
  await audit(sql, { actorUserId: staffId, action: 'transaction_review.removed', targetType: 'TransactionReview', targetId: r.id, reason: note, metadata: { policyReason: removeFor } });
  return { status: 'removed' };
}

