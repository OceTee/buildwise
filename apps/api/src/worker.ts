import { uuidv7 } from '@bw/domain';
import { many, one, type Sql } from './db/database.js';
import type { Services } from './http/route.js';
import { applyListingStatus } from './modules/effects.js';
import { searchListings, type SearchQuery } from './modules/listings.js';
import { processRevision } from './modules/documents.js';
import { PENDING_TTL_HOURS } from './modules/promotions.js';
import { trainAssistant } from './modules/assistant.js';
import { runProcurementTimers } from './modules/procurement.js';
import { runCaseTimers } from './modules/cases.js';
import { notify, publish } from './platform/platform.js';

/**
 * Background work (spec §3.14): dispatch outbox events to SMS/email mirrors, run time-based transitions and
 * send saved-search alerts. Every job is idempotent, so running it twice or on two instances is safe.
 */

/** Events that are also sent off-platform to the seller, with the short text used. */
const MIRRORED: Record<string, (p: Record<string, any>) => string | null> = {
  ListingPublished: () => 'Your listing is live.',
  ListingRejected: () => 'Your listing needs changes. See My ads for the reason.',
  ListingBlocked: () => 'One of your listings was blocked. See My ads; you can appeal once.',
  ListingExpired: () => 'Your listing expired. Renew it from My ads.',
  QuoteRequested: () => 'You have a new quote request. Reply from Messages.',
  SellerRestricted: () => 'Your seller account is restricted. See My ads for details.',
};

export async function dispatchOutbox(s: Services, batch = 50): Promise<number> {
  const events = await s.db.tx({ kind: 'system' }, (sql) => many<{ event_id: string; event_type: string; payload: any }>(sql,
    `select event_id, event_type, payload from outbox where dispatched_at is null and attempts < 10 order by occurred_at limit $1`, [batch]));
  for (const e of events) {
    try {
      const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
      const text = MIRRORED[e.event_type]?.(payload);
      const orgId = payload.sellerOrgId ?? payload.orgId;
      if (text && orgId) {
        const people = await s.db.tx({ kind: 'system' }, (sql) => many<{ phone_e164: string | null; email: string | null }>(sql,
          `select u.phone_e164, u.email from users u join org_members m on m.user_id = u.id where m.org_id = $1 and m.role in ('owner', 'admin') and u.status = 'active'`, [orgId]));
        for (const p of people) {
          // Email when a real email provider is connected, or when neither channel is real (development outbox).
          if (p.email && (s.email.live || !s.sms.live)) await s.email.send(p.email, text, 'notification');
          else if (p.phone_e164) await s.sms.send(p.phone_e164, text, 'notification');
        }
      }
      await s.db.tx({ kind: 'system' }, (sql) => sql.query(`update outbox set dispatched_at = now(), attempts = attempts + 1 where event_id = $1`, [e.event_id]));
    } catch (err) {
      await s.db.tx({ kind: 'system' }, (sql) => sql.query(`update outbox set attempts = attempts + 1, last_error = $2 where event_id = $1`, [e.event_id, String(err).slice(0, 500)]));
    }
  }
  return events.length;
}

export async function runExpiries(s: Services): Promise<Record<string, number>> {
  return s.db.tx({ kind: 'system' }, async (sql) => {
    const out: Record<string, number> = {};
    const listings = await many<{ id: string }>(sql, `select id from listings where status = 'live' and expires_at <= now() limit 500`);
    for (const l of listings) await applyListingStatus(sql, l.id, 'expired', null, 'expire');
    out.listings = listings.length;

    const promos = await many<{ id: string; listing_id: string }>(sql, `update promotion_purchases set status = 'expired', remaining_seconds = 0 where status = 'active' and ends_at <= now() returning id, listing_id`);
    for (const p of promos) await publish(sql, 'PromotionExpired', { purchaseId: p.id, listingId: p.listing_id });
    out.promotions = promos.length;

    const proc = await runProcurementTimers(sql, s);
    out.rfqsClosed = proc.closed;
    out.tendersOpened = proc.opened;
    out.quotesExpired = proc.expired;

    const cases = await runCaseTimers(sql, s);
    out.casesFinal = cases.finalized;
    out.caseReminders = cases.staffReminders + cases.partyReminders;
    out.inspectionReminders = cases.inspectionReminders;

    out.rateWindows = (await sql.query(`delete from rate_limit_windows where window_start < now() - interval '5 minutes' returning 1`)).rows.length;
    out.unpaid = (await sql.query(`update promotion_purchases set status = 'cancelled' where status = 'pending_payment' and created_at < now() - make_interval(hours => $1) returning id`, [PENDING_TTL_HOURS])).rows.length;
    out.quotes = (await sql.query(`update quote_requests set status = 'expired' where status in ('sent', 'viewed') and expires_at <= now() returning id`)).rows.length;
    out.restrictions = (await sql.query(`update seller_restrictions set status = 'expired' where status = 'active' and ends_at <= now() returning id`)).rows.length;
    out.estimates = (await sql.query(`update estimate_versions set state = 'expired', updated_at = now() where state = 'issued' and valid_until <= now() returning id`)).rows.length;
    await sql.query(`delete from otp_codes where created_at < now() - interval '2 days'`);
    await sql.query(`delete from idempotency_keys where created_at < now() - interval '2 days'`);
    return out;
  });
}

/** Instant searches run every cycle; daily ones once a day. Alerts carry only new matches since the last run. */
export async function runSavedSearches(s: Services): Promise<number> {
  const due = await s.db.tx({ kind: 'system' }, (sql) => many<{ id: string; user_id: string; label: string; query: any; last_checked_at: unknown }>(sql,
    `select id, user_id, label, query, last_checked_at from saved_searches
      where (frequency = 'instant') or (frequency = 'daily' and last_checked_at < now() - interval '1 day') order by last_checked_at limit 200`));
  let sent = 0;
  for (const ss of due) {
    await s.db.tx({ kind: 'system' }, async (sql: Sql) => {
      const now = (await one<{ now: unknown }>(sql, `select now() as now`))!.now;
      const q = { sort: 'newest', page: 1, ...(typeof ss.query === 'string' ? JSON.parse(ss.query) : ss.query) } as SearchQuery;
      let total = 0;
      try { total = (await searchListings(sql, s, q, { since: new Date(String(ss.last_checked_at)), limit: 50 })).total; } catch { total = 0; }
      await sql.query(`update saved_searches set last_checked_at = $2 where id = $1`, [ss.id, now]);
      if (total > 0) {
        const params = new URLSearchParams(Object.entries(q).filter(([k, v]) => v != null && k !== 'page').map(([k, v]) => [k, String(v)] as [string, string]));
        await notify(sql, [ss.user_id], { kind: 'saved_search', title: `${total} new for "${ss.label}"`, body: 'New listings match your saved search.', link: `/search?${params}` });
        await publish(sql, 'SavedSearchMatched', { savedSearchId: ss.id, count: total, alertId: uuidv7() });
        sent += 1;
      }
    });
  }
  return sent;
}

/** Picks up document revisions whose processing was interrupted, with a bounded number of attempts. */
export async function runDocumentJobs(s: Services): Promise<number> {
  const due = await s.db.tx({ kind: 'system' }, (sql) => many<{ id: string }>(sql,
    `select id from document_revisions where (state in ('quarantined', 'scanning', 'processing') and created_at < now() - interval '2 minutes') or (state = 'failed' and attempts < 3) order by created_at limit 20`));
  for (const r of due) await processRevision(s, r.id);
  return due.length;
}

export async function runWorkerCycle(s: Services) {
  await runDocumentJobs(s);
  // The assistant retrains from platform activity every few hours (it skips itself in between).
  const assistant = await trainAssistant(s).catch(() => null);
  const expiries = await runExpiries(s);
  const alerts = await runSavedSearches(s);
  const dispatched = await dispatchOutbox(s);
  return { expiries, alerts, dispatched, assistant };
}

export function startWorker(s: Services, intervalMs = 30_000, log: (m: string, e?: unknown) => void = () => undefined) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runWorkerCycle(s); } catch (e) { log('worker cycle failed', e); } finally { running = false; }
  };
  const t = setInterval(tick, intervalMs);
  t.unref();
  void tick();
  return () => clearInterval(t);
}
