import { promotionOnListingChange, remainingAfterPause, uuidv7 } from '@bw/domain';
import { many, one, type Sql } from '../db/database.js';
import { audit, notify, publish } from '../platform/platform.js';

/**
 * Side effects of a listing status change (spec §3.8 "effects of leaving live", §3.13 promotions).
 * Shared by listings, moderation and the scheduler so the rules are applied identically everywhere.
 */
export async function applyListingStatus(sql: Sql, listingId: string, to: string, actorUserId: string | null, command: string, reasonCode?: string | null, note?: string | null) {
  const l = await one<{ status: string; seller_org_id: string; title: string }>(sql, `select status, seller_org_id, title from listings where id = $1`, [listingId]);
  if (!l) return;
  await sql.query(`insert into listing_status_events (id, listing_id, from_status, to_status, command, actor_user_id, reason_code, note) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuidv7(), listingId, l.status, to, command, actorUserId, reasonCode ?? null, note ?? null]);

  const now = new Date();
  const promos = await many<{ id: string; status: string; active_since: unknown; remaining_seconds: number; kind: string; org_id: string }>(sql,
    `select id, status, active_since, remaining_seconds, kind, org_id from promotion_purchases where listing_id = $1 and status in ('active', 'paused', 'paid')`, [listingId]);

  if (to === 'live') {
    // Paused (or paid-while-not-live) promotions resume with their remaining time.
    for (const p of promos.filter((x) => x.status === 'paused' || x.status === 'paid')) {
      await sql.query(`update promotion_purchases set status = 'active', active_since = now(), ends_at = now() + make_interval(secs => remaining_seconds) where id = $1`, [p.id]);
      await publish(sql, 'PromotionActivated', { purchaseId: p.id, listingId, resumed: p.status === 'paused' });
    }
  } else {
    const action = promotionOnListingChange(to, reasonCode);
    for (const p of promos) {
      const remaining = p.status === 'active' && p.active_since ? remainingAfterPause(new Date(String(p.active_since)), p.remaining_seconds, now) : p.remaining_seconds;
      if (action === 'pause') {
        if (p.status === 'active') {
          await sql.query(`update promotion_purchases set status = 'paused', remaining_seconds = $2, active_since = null, ends_at = null where id = $1`, [p.id, remaining]);
          await publish(sql, 'PromotionPaused', { purchaseId: p.id, listingId, to });
        }
      } else if (action === 'credit') {
        await sql.query(`update promotion_purchases set status = 'credited', remaining_seconds = $2, active_since = null, ends_at = null where id = $1`, [p.id, remaining]);
        await sql.query(`insert into promotion_credits (id, org_id, source_purchase_id, seconds, kind) values ($1, $2, $3, $4, $5)`, [uuidv7(), p.org_id, p.id, remaining, p.kind]);
        await audit(sql, { actorUserId, action: 'promotion.credited', targetType: 'PromotionPurchase', targetId: p.id, metadata: { seconds: remaining, listingStatus: to } });
      } else if (action === 'forfeit') {
        await sql.query(`update promotion_purchases set status = 'forfeited', remaining_seconds = $2, active_since = null, ends_at = null where id = $1`, [p.id, remaining]);
        await audit(sql, { actorUserId, action: 'promotion.forfeited', targetType: 'PromotionPurchase', targetId: p.id, reason: reasonCode ?? null });
      }
    }
    // Pending quote requests on a listing that is no longer available (§3.10).
    await sql.query(`update quote_requests set status = 'listing_unavailable' where listing_id = $1 and status in ('sent', 'viewed')`, [listingId]);
  }

  await sql.query(`update listings set status = $2, updated_at = now() where id = $1`, [listingId, to]);
  const members = await many<{ user_id: string }>(sql, `select user_id from org_members where org_id = $1`, [l.seller_org_id]);
  const evt = to === 'live' ? 'ListingPublished' : to === 'rejected' ? 'ListingRejected' : to === 'expired' ? 'ListingExpired' : to === 'closed' ? 'ListingClosed' : to === 'blocked' ? 'ListingBlocked' : null;
  if (evt) await publish(sql, evt, { listingId, sellerOrgId: l.seller_org_id, reasonCode: reasonCode ?? null });
  if (to === 'live' && command !== 'renew') await notify(sql, members.map((m) => m.user_id), { kind: 'listing_live', title: 'Your listing is live', body: l.title, link: `/my-ads` });
  if (to === 'in_review' && actorUserId === null) await notify(sql, members.map((m) => m.user_id), { kind: 'listing_review', title: 'Your listing is being reviewed', body: `${l.title} will be checked by a moderator.`, link: '/my-ads' });
}
