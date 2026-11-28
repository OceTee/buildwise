import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { findArea, formatMoney, listingPath, maskPhone, parseMajor, quoteRequestMachine, reviewEligibility, scanText, unitLabel, uuidv7, isKnownUnit } from '@bw/domain';
import { iso, many, one, str, type Sql } from '../db/database.js';
import { route, type Actor, type Client, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, sha256, tooMany, unprocessable } from '../platform/platform.js';
import { photoUrls } from './listings.js';

/** Buyer–seller contact, reviews and saved items (spec §3.10, §3.12). */

async function liveListing(sql: Sql, id: string) {
  const l = await one<Record<string, any>>(sql, `select l.*, o.chat_only, o.name as seller_name from listings l join organizations o on o.id = l.seller_org_id where l.id = $1`, [id]);
  if (!l || l.status !== 'live') throw notFound('Listing');
  return l;
}

async function isSellerMember(sql: Sql, orgId: string, userId: string) {
  return !!(await one(sql, `select 1 from org_members where org_id = $1 and user_id = $2`, [orgId, userId]));
}

async function requirePhoneVerified(sql: Sql, user: Actor) {
  const u = await one<{ phone_verified_at: unknown }>(sql, `select phone_verified_at from users where id = $1`, [user.id]);
  if (!u?.phone_verified_at) throw forbidden('Verify your phone number first.');
}

async function chatRestricted(sql: Sql, userId: string) {
  return one(sql, `select 1 from seller_restrictions r join org_members m on m.org_id = r.org_id where m.user_id = $1 and r.status = 'active' and r.kind in ('chat_limit', 'account_suspension') and (r.ends_at is null or r.ends_at > now())`, [userId]);
}

/** Safety flags on a chat message: banner for links/payment/off-platform; hold for known scam phrases (§3.10). */
function screenMessage(s: Services, body: string) {
  const findings = scanText(body, s.pack);
  const offPlatform = /\b(whatsapp|telegram|call me on|text me on|outside (the )?(app|site))\b/i.test(body);
  const flags = [...new Set([
    ...findings.filter((f) => f.code === 'contact_details_in_text' && f.detail === 'link').map(() => 'link'),
    ...findings.filter((f) => f.code === 'payment_instructions').map(() => 'payment_instructions'),
    ...(offPlatform ? ['off_platform'] : []),
  ])];
  const held = findings.some((f) => f.code === 'scam_signals');
  return { flags, held };
}

async function ensureThread(sql: Sql, l: Record<string, any>, buyerId: string) {
  const existing = await one<{ id: string; buyer_blocked: boolean; seller_blocked: boolean }>(sql, `select id, buyer_blocked, seller_blocked from threads where listing_id = $1 and buyer_user_id = $2`, [l.id, buyerId]);
  if (existing) {
    if (existing.seller_blocked || existing.buyer_blocked) throw forbidden('This conversation is blocked.');
    return existing.id;
  }
  const id = uuidv7();
  await sql.query(`insert into threads (id, listing_id, listing_version, buyer_user_id, seller_org_id) values ($1, $2, $3, $4, $5)`, [id, l.id, l.version, buyerId, l.seller_org_id]);
  await sql.query(`select listing_count_contact($1)`, [l.id]);
  return id;
}

async function postMessage(sql: Sql, s: Services, threadId: string, senderId: string, body: string) {
  const { flags, held } = screenMessage(s, body);
  const id = uuidv7();
  await sql.query(`insert into messages (id, thread_id, sender_user_id, body, safety_flags, held) values ($1, $2, $3, $4, $5::jsonb, $6)`, [id, threadId, senderId, body, JSON.stringify(flags), held]);
  const t = await one<{ buyer_user_id: string; seller_org_id: string; first_seller_reply_at: unknown; listing_id: string }>(sql, `select buyer_user_id, seller_org_id, first_seller_reply_at, listing_id from threads where id = $1`, [threadId]);
  const fromSeller = senderId !== t!.buyer_user_id;
  await sql.query(`update threads set last_message_at = now()${fromSeller ? ', first_seller_reply_at = coalesce(first_seller_reply_at, now())' : ''} where id = $1`, [threadId]);
  if (!held) await publish(sql, 'MessageSent', { threadId, messageId: id, fromSeller, listingId: t!.listing_id });
  else await audit(sql, { actorUserId: senderId, action: 'message.held', targetType: 'Message', targetId: id, reason: 'scam_signals' });
  return { id, flags, held };
}

async function threadView(sql: Sql, s: Services, t: Record<string, any>, userId: string) {
  const asBuyer = t.buyer_user_id === userId;
  const msgs = await many<Record<string, any>>(sql, `select m.*, u.display_name from messages m join users u on u.id = m.sender_user_id where m.thread_id = $1 order by m.created_at`, [t.id]);
  const qrs = await many<Record<string, any>>(sql, `select * from quote_requests where thread_id = $1 order by created_at`, [t.id]);
  const l = await one<Record<string, any>>(sql, `select l.id, l.title, l.status, l.short_id, o.name as seller_name from listings l join organizations o on o.id = l.seller_org_id where l.id = $1`, [t.listing_id]);
  const buyer = await one<{ display_name: string }>(sql, `select display_name from users where id = $1`, [t.buyer_user_id]);
  const ph = await one<{ id: string }>(sql, `select id from listing_photos where listing_id = $1 and status = 'ready' order by position limit 1`, [t.listing_id]);
  return {
    id: t.id, role: asBuyer ? 'buyer' : 'seller',
    listing: { id: l!.id, title: l!.title, path: listingPath(l!.title, l!.id), available: l!.status === 'live', photo: ph ? photoUrls(ph.id).thumb : null, sellerOrgId: t.seller_org_id },
    counterpart: asBuyer ? l!.seller_name : buyer?.display_name ?? 'Buyer',
    blocked: { byMe: asBuyer ? t.buyer_blocked : t.seller_blocked, byThem: asBuyer ? t.seller_blocked : t.buyer_blocked },
    // Held messages are visible only to their sender until moderation (§3.10).
    messages: msgs.filter((m) => !m.held || m.sender_user_id === userId).map((m) => ({
      id: m.id, mine: m.sender_user_id === userId, author: m.sender_user_id === userId ? 'You' : m.display_name, body: m.body,
      safetyFlags: m.safety_flags, held: m.held, at: iso(m.created_at),
    })),
    quoteRequests: qrs.map((q) => ({
      id: q.id, status: q.status, quantity: str(q.quantity), unit: q.unit, unitLabel: unitLabel(q.unit), deliveryArea: findArea(s.pack, q.delivery_area)?.label ?? q.delivery_area,
      neededBy: q.needed_by ? iso(q.needed_by)!.slice(0, 10) : null, notes: q.notes,
      answer: q.answered_at ? { price: q.answer_price_minor ? { amountMinor: str(q.answer_price_minor), currency: s.pack.currency } : null, note: q.answer_note, at: iso(q.answered_at) } : null,
      expiresAt: iso(q.expires_at), canAnswer: !asBuyer && quoteRequestMachine.can(q.status, 'answer'),
    })),
    safetyTips: s.pack.safetyTips,
  };
}

/** The bucket a phone reveal counts against: the device id, or for requests without one, `noip:` + a hash of the IP. */
export function revealDevice(client: Client): string {
  return client.deviceId ?? `noip:${sha256(client.ip).slice(0, 24)}`;
}

export function registerContact(app: FastifyInstance, s: Services) {
  // ---------------------------------------------------------------- chat
  route(app, s, {
    method: 'POST', url: '/v1/listings/:id/threads', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ body: z.string().trim().min(1).max(2000) }),
    handler: async ({ sql, params, body, user }) => {
      await requirePhoneVerified(sql, user);
      if (await chatRestricted(sql, user.id)) throw forbidden('Your account cannot start conversations right now.');
      const l = await liveListing(sql, params.id);
      if (await isSellerMember(sql, l.seller_org_id, user.id)) throw badRequest('OWN_LISTING', 'This is your own listing.');
      const fresh = !(await one(sql, `select 1 from threads where listing_id = $1 and buyer_user_id = $2`, [l.id, user.id]));
      if (fresh) {
        const u = await one<{ created_at: unknown }>(sql, `select created_at from users where id = $1`, [user.id]);
        const young = Date.now() - new Date(String(u!.created_at)).getTime() < 7 * 86_400_000;
        const today = await one<{ n: number }>(sql, `select count(*)::int as n from threads where buyer_user_id = $1 and created_at > now() - interval '1 day'`, [user.id]);
        if (young && (today?.n ?? 0) >= s.pack.limits.chatsPerNewAccountPerDay) throw tooMany('New accounts can start a limited number of conversations a day.', 86_400);
      }
      const threadId = await ensureThread(sql, l, user.id);
      const msg = await postMessage(sql, s, threadId, user.id, body.body);
      return { threadId, message: msg };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/threads', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql,
        `select t.*, l.title, l.status as listing_status, o.name as seller_name, u.display_name as buyer_name,
                (select count(*)::int from messages m where m.thread_id = t.id and m.sender_user_id <> $1 and not m.held
                   and m.created_at > coalesce((select read_at from thread_reads r where r.thread_id = t.id and r.user_id = $1), 'epoch')) as unread,
                (select body from messages m where m.thread_id = t.id and (not m.held or m.sender_user_id = $1) order by created_at desc limit 1) as last_body
           from threads t join listings l on l.id = t.listing_id join organizations o on o.id = t.seller_org_id join users u on u.id = t.buyer_user_id
          where t.buyer_user_id = $1 or t.seller_org_id in (select org_id from org_members where user_id = $1)
          order by t.last_message_at desc limit 200`, [user.id]);
      return {
        unread: rows.reduce((a, r) => a + r.unread, 0),
        items: rows.map((t) => ({
          id: t.id, role: t.buyer_user_id === user.id ? 'buyer' : 'seller', listingTitle: t.title, listingAvailable: t.listing_status === 'live',
          counterpart: t.buyer_user_id === user.id ? t.seller_name : t.buyer_name, lastMessage: t.last_body ? String(t.last_body).slice(0, 120) : null,
          lastMessageAt: iso(t.last_message_at), unread: t.unread,
        })),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/threads/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const t = await one<Record<string, any>>(sql, `select * from threads where id = $1`, [params.id]);
      if (!t || (t.buyer_user_id !== user.id && !(await isSellerMember(sql, t.seller_org_id, user.id)))) throw notFound('Conversation');
      await sql.query(`insert into thread_reads (thread_id, user_id) values ($1, $2) on conflict (thread_id, user_id) do update set read_at = now()`, [t.id, user.id]);
      if (t.buyer_user_id !== user.id) await sql.query(`update quote_requests set status = 'viewed' where thread_id = $1 and status = 'sent'`, [t.id]);
      return threadView(sql, s, t, user.id);
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/threads/:id/messages', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ body: z.string().trim().min(1).max(2000) }),
    handler: async ({ sql, params, body, user }) => {
      const t = await one<Record<string, any>>(sql, `select * from threads where id = $1`, [params.id]);
      if (!t || (t.buyer_user_id !== user.id && !(await isSellerMember(sql, t.seller_org_id, user.id)))) throw notFound('Conversation');
      if (t.buyer_blocked || t.seller_blocked) throw forbidden('This conversation is blocked.');
      if (await chatRestricted(sql, user.id)) throw forbidden('Your account cannot send messages right now.');
      return postMessage(sql, s, t.id, user.id, body.body);
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/threads/:id/block', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ blocked: z.boolean() }),
    handler: async ({ sql, params, body, user }) => {
      const t = await one<Record<string, any>>(sql, `select * from threads where id = $1`, [params.id]);
      if (!t) throw notFound('Conversation');
      const asBuyer = t.buyer_user_id === user.id;
      if (!asBuyer && !(await isSellerMember(sql, t.seller_org_id, user.id))) throw notFound('Conversation');
      await sql.query(`update threads set ${asBuyer ? 'buyer_blocked' : 'seller_blocked'} = $2 where id = $1`, [t.id, body.blocked]);
      await audit(sql, { actorUserId: user.id, action: body.blocked ? 'thread.blocked' : 'thread.unblocked', targetType: 'Thread', targetId: t.id });
      return { blocked: body.blocked };
    },
  });

  // ---------------------------------------------------------------- phone reveal (§3.10)
  route(app, s, {
    method: 'POST', url: '/v1/listings/:id/reveal', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user, client }) => {
      await requirePhoneVerified(sql, user);
      const l = await liveListing(sql, params.id);
      if (l.chat_only) throw forbidden('This seller prefers chat. Send them a message instead.');
      const lim = s.pack.limits;
      const day = await one<{ n: number }>(sql, `select count(*)::int as n from contact_reveals where viewer_user_id = $1 and created_at > now() - interval '1 day'`, [user.id]);
      if ((day?.n ?? 0) >= lim.revealsPerUserPerDay) throw tooMany('You have revealed the maximum number of phone numbers for today. Use chat instead.', 86_400);
      // Device limits count across accounts. A request without a device id (no cookie, or not from the website)
      // shares one strict bucket with every other such request from its IP, so dropping the cookie never helps.
      const device = revealDevice(client);
      const hour = await one<{ n: number }>(sql, `select reveals_from_device($1, now() - interval '1 hour') as n`, [device]);
      if ((hour?.n ?? 0) >= lim.revealsPerDevicePerHour) throw tooMany('Too many phone numbers revealed from this device. Try again later.', 3600);
      const owner = await one<{ phone_e164: string | null }>(sql, `select u.phone_e164 from users u where u.id = $1`, [l.created_by]);
      if (!owner?.phone_e164) throw unprocessable('NO_PHONE', 'This seller has no phone number available. Use chat.');
      const already = await one(sql, `select 1 from contact_reveals where viewer_user_id = $1 and listing_id = $2`, [user.id, l.id]);
      const id = uuidv7();
      await sql.query(`insert into contact_reveals (id, listing_id, seller_org_id, viewer_user_id, device_id, prompt_after) values ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
        [id, l.id, l.seller_org_id, user.id, device, s.pack.policy.reviewPromptDays]);
      if (!already) await sql.query(`select listing_count_contact($1)`, [l.id]);
      await publish(sql, 'ContactRevealed', { listingId: l.id, sellerOrgId: l.seller_org_id });
      return { phone: owner.phone_e164, phoneMasked: maskPhone(owner.phone_e164), safetyTips: s.pack.safetyTips };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/me/review-prompts', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql,
        `select distinct on (r.seller_org_id) r.id, r.seller_org_id, o.name, l.title from contact_reveals r join organizations o on o.id = r.seller_org_id join listings l on l.id = r.listing_id
          where r.viewer_user_id = $1 and r.confirmed is null and r.prompt_after <= now() order by r.seller_org_id, r.created_at desc`, [user.id]);
      return { items: rows.map((r) => ({ revealId: r.id, sellerOrgId: r.seller_org_id, sellerName: r.name, listingTitle: r.title })) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/reveals/:id/confirm', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ dealt: z.boolean() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<{ viewer_user_id: string }>(sql, `select viewer_user_id from contact_reveals where id = $1`, [params.id]);
      if (!r || r.viewer_user_id !== user.id) throw notFound('Contact');
      await sql.query(`update contact_reveals set confirmed = $2, confirmed_at = now() where id = $1`, [params.id, body.dealt]);
      return { confirmed: body.dealt };
    },
  });

  // ---------------------------------------------------------------- quote requests (§3.10)
  route(app, s, {
    method: 'POST', url: '/v1/listings/:id/quote-requests', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({
      quantity: z.string().regex(/^\d+(\.\d+)?$/), unit: z.string().max(20), deliveryArea: z.string().max(40),
      neededBy: z.iso.date().optional(), notes: z.string().trim().max(1000).optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      await requirePhoneVerified(sql, user);
      if (await chatRestricted(sql, user.id)) throw forbidden('Your account cannot send quote requests right now.');
      const l = await liveListing(sql, params.id);
      if (await isSellerMember(sql, l.seller_org_id, user.id)) throw badRequest('OWN_LISTING', 'This is your own listing.');
      if (!isKnownUnit(body.unit)) throw badRequest('VALIDATION_FAILED', 'Choose a unit.');
      if (!findArea(s.pack, body.deliveryArea)) throw badRequest('INVALID_AREA', 'Choose a delivery area.');
      const threadId = await ensureThread(sql, l, user.id);
      const id = uuidv7();
      await sql.query(`insert into quote_requests (id, listing_id, listing_version, buyer_user_id, seller_org_id, thread_id, quantity, unit, delivery_area, needed_by, notes, expires_at)
                       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12))`,
        [id, l.id, l.version, user.id, l.seller_org_id, threadId, body.quantity, body.unit, body.deliveryArea, body.neededBy ?? null, body.notes ?? null, s.pack.policy.quoteRequestExpiryDays]);
      const area = findArea(s.pack, body.deliveryArea)!;
      await postMessage(sql, s, threadId, user.id, `Quote request: ${body.quantity} ${unitLabel(body.unit)}, delivery to ${area.label}${body.neededBy ? ` by ${body.neededBy}` : ''}.${body.notes ? ` ${body.notes}` : ''}`);
      await publish(sql, 'QuoteRequested', { quoteRequestId: id, listingId: l.id, sellerOrgId: l.seller_org_id });
      return { id, threadId };
    },
  });

  for (const action of ['answer', 'decline'] as const) {
    route(app, s, {
      method: 'POST', url: `/v1/quote-requests/:id/${action}`, auth: 'user', successStatus: 200,
      params: z.object({ id: z.uuid() }),
      body: z.object({ price: z.string().max(20).optional(), note: z.string().trim().max(1000).optional() }),
      handler: async ({ sql, params, body, user }) => {
        const q = await one<Record<string, any>>(sql, `select * from quote_requests where id = $1`, [params.id]);
        if (!q || !(await isSellerMember(sql, q.seller_org_id, user.id))) throw notFound('Quote request');
        if (!quoteRequestMachine.can(q.status, action)) throw conflict('INVALID_TRANSITION', `This quote request is ${q.status.replace('_', ' ')}.`);
        let price: bigint | null = null;
        if (action === 'answer') {
          price = body.price ? parseMajor(body.price, s.pack.currency) : null;
          if (price == null || price <= 0n) throw badRequest('VALIDATION_FAILED', 'Enter your price.', [{ path: 'price', message: 'Enter your price.' }]);
        }
        await sql.query(`update quote_requests set status = $2, answer_price_minor = $3, answer_note = $4, answered_at = now() where id = $1`,
          [q.id, quoteRequestMachine.next(q.status, action), price == null ? null : String(price), body.note ?? null]);
        const fmt = price != null ? formatMoney({ amountMinor: String(price), currency: s.pack.currency }, s.pack.locale) : null;
        await postMessage(sql, s, q.thread_id, user.id, action === 'answer' ? `Quote: ${fmt} for ${str(q.quantity)} ${unitLabel(q.unit)}.${body.note ? ` ${body.note}` : ''}` : `I can't quote for this request.${body.note ? ` ${body.note}` : ''}`);
        await publish(sql, 'QuoteRequestAnswered', { quoteRequestId: q.id, outcome: action, buyerUserId: q.buyer_user_id });
        return { status: quoteRequestMachine.next(q.status, action) };
      },
    });
  }

  // ---------------------------------------------------------------- reviews (§3.12)
  route(app, s, {
    method: 'GET', url: '/v1/sellers/:orgId/review-eligibility', auth: 'user',
    params: z.object({ orgId: z.uuid() }),
    handler: async ({ sql, params, user }) => eligibility(sql, s, params.orgId, user.id),
  });

  route(app, s, {
    method: 'POST', url: '/v1/sellers/:orgId/reviews', auth: 'user',
    params: z.object({ orgId: z.uuid() }),
    body: z.object({ rating: z.number().int().min(1).max(5), body: z.string().trim().min(10).max(2000) }),
    handler: async ({ sql, params, body, user }) => {
      const e = await eligibility(sql, s, params.orgId, user.id);
      if (!e.eligible) throw unprocessable('REVIEW_NOT_ALLOWED', e.reason!);
      // Reviews with contact details, links or abuse wait for moderation.
      const flagged = scanText(body.body, s.pack).length > 0;
      const id = uuidv7();
      await sql.query(`insert into reviews (id, seller_org_id, author_user_id, rating, body, basis, status) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, params.orgId, user.id, body.rating, body.body, e.basis, flagged ? 'pending' : 'published']);
      if (!flagged) await publish(sql, 'SellerReviewPublished', { reviewId: id, sellerOrgId: params.orgId });
      await audit(sql, { actorUserId: user.id, action: 'review.created', targetType: 'Review', targetId: id, metadata: { held: flagged } });
      return { id, status: flagged ? 'pending' : 'published' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/reviews/:id/reply', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ body: z.string().trim().min(2).max(1000) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Record<string, any>>(sql, `select * from reviews where id = $1`, [params.id]);
      if (!r) throw notFound('Review');
      const m = await one<{ role: string }>(sql, `select role from org_members where org_id = $1 and user_id = $2`, [r.seller_org_id, user.id]);
      if (!m || !['owner', 'admin'].includes(m.role)) throw forbidden('Only the seller can reply.');
      if (r.reply_body) throw conflict('ALREADY_REPLIED', 'You can reply to a review once.');
      await sql.query(`update reviews set reply_body = $2, reply_at = now() where id = $1`, [r.id, body.body]);
      return { replied: true };
    },
  });

  // ---------------------------------------------------------------- favourites and saved searches
  route(app, s, {
    method: 'PUT', url: '/v1/favourites/:listingId', auth: 'user', successStatus: 200,
    params: z.object({ listingId: z.uuid() }),
    body: z.object({ saved: z.boolean() }),
    handler: async ({ sql, params, body, user }) => {
      if (body.saved) {
        await liveListing(sql, params.listingId);
        await sql.query(`insert into favourites (user_id, listing_id) values ($1, $2) on conflict do nothing`, [user.id, params.listingId]);
      } else await sql.query(`delete from favourites where user_id = $1 and listing_id = $2`, [user.id, params.listingId]);
      return { saved: body.saved };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/favourites', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql,
        `select l.id, l.title, l.status, l.price_minor, l.currency, l.unit, f.created_at from favourites f join listings l on l.id = f.listing_id where f.user_id = $1 order by f.created_at desc`, [user.id]);
      return { items: rows.map((l) => ({ id: l.id, title: l.title, path: listingPath(l.title, l.id), available: l.status === 'live', price: l.price_minor == null ? null : { amountMinor: str(l.price_minor), currency: l.currency }, unit: l.unit, unitLabel: unitLabel(l.unit), savedAt: iso(l.created_at) })) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/saved-searches', auth: 'user',
    body: z.object({
      label: z.string().trim().min(2).max(80), frequency: z.enum(['instant', 'daily', 'off']).default('daily'),
      query: z.object({ q: z.string().max(100).optional(), category: z.string().max(60).optional(), area: z.string().max(40).optional(), min: z.string().max(20).optional(), max: z.string().max(20).optional(), unit: z.string().max(20).optional() }),
    }),
    handler: async ({ sql, body, user }) => {
      const n = await one<{ n: number }>(sql, `select count(*)::int as n from saved_searches where user_id = $1`, [user.id]);
      if ((n?.n ?? 0) >= 25) throw unprocessable('LIMIT', 'You can keep up to 25 saved searches.');
      const id = uuidv7();
      await sql.query(`insert into saved_searches (id, user_id, label, query, frequency) values ($1, $2, $3, $4::jsonb, $5)`, [id, user.id, body.label, JSON.stringify(body.query), body.frequency]);
      return { id };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/saved-searches', auth: 'user',
    handler: async ({ sql, user }) => ({ items: (await many<Record<string, any>>(sql, `select * from saved_searches where user_id = $1 order by created_at desc`, [user.id])).map((x) => ({ id: x.id, label: x.label, query: x.query, frequency: x.frequency, createdAt: iso(x.created_at) })) }),
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/saved-searches/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ frequency: z.enum(['instant', 'daily', 'off']) }),
    handler: async ({ sql, params, body, user }) => {
      await sql.query(`update saved_searches set frequency = $3 where id = $1 and user_id = $2`, [params.id, user.id, body.frequency]);
      return { frequency: body.frequency };
    },
  });

  route(app, s, {
    method: 'DELETE', url: '/v1/saved-searches/:id', auth: 'user', successStatus: 204,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => { await sql.query(`delete from saved_searches where id = $1 and user_id = $2`, [params.id, user.id]); return null; },
  });
}

async function eligibility(sql: Sql, s: Services, orgId: string, userId: string) {
  const sameOrg = !!(await one(sql, `select 1 from org_members where org_id = $1 and user_id = $2`, [orgId, userId]));
  const chat = await one(sql, `select 1 from threads t where t.seller_org_id = $1 and t.buyer_user_id = $2 and t.first_seller_reply_at is not null and exists (select 1 from messages m where m.thread_id = t.id and m.sender_user_id = $2)`, [orgId, userId]);
  const quote = await one(sql, `select 1 from quote_requests where seller_org_id = $1 and buyer_user_id = $2 and status = 'answered'`, [orgId, userId]);
  const reveal = await one(sql, `select 1 from contact_reveals where seller_org_id = $1 and viewer_user_id = $2 and confirmed`, [orgId, userId]);
  const last = await one<{ created_at: unknown }>(sql, `select created_at from reviews where seller_org_id = $1 and author_user_id = $2 and status <> 'removed' order by created_at desc limit 1`, [orgId, userId]);
  const r = reviewEligibility({ chatWithBothSides: !!chat, answeredQuoteRequest: !!quote, confirmedAfterReveal: !!reveal, lastReviewOfSellerAt: last ? new Date(String(last.created_at)) : null, sameOrganization: sameOrg }, new Date(), s.pack.policy.reviewCooldownDays);
  return r.ok ? { eligible: true, reason: null, basis: chat ? 'chat' : quote ? 'quote_request' : 'contact_reveal' } : { eligible: false, reason: r.reason, basis: null };
}
