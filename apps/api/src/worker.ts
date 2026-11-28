import { mirrorChannel, notificationPrefs, uuidv7, type NotificationTopic } from '@bw/domain';
import { many, one, type Sql } from './db/database.js';
import type { Services } from './http/route.js';
import { applyListingStatus } from './modules/effects.js';
import { searchListings, type SearchQuery } from './modules/listings.js';
import { processRevision } from './modules/documents.js';
import { PENDING_TTL_HOURS } from './modules/promotions.js';
import { trainAssistant } from './modules/assistant.js';
import { runProcurementTimers } from './modules/procurement.js';
import { runCaseTimers } from './modules/cases.js';
import { audit, notify, publish } from './platform/platform.js';
import { sendSms } from './platform/sms.js';
import { inBackground } from './platform/background.js';

/**
 * Background work (spec §3.14): dispatch outbox events to SMS/email mirrors, run time-based transitions and
 * send saved-search alerts. Every job is idempotent, so running it twice or on two instances is safe.
 */

/**
 * Events that are also copied off the platform (email or SMS, by each person's preferences), with the topic the
 * preference is kept under and the short text. Texts never carry message bodies, prices or codes.
 */
const MIRRORED: Record<string, { topic: NotificationTopic; text: (p: Record<string, any>) => string | null }> = {
  ListingPublished: { topic: 'listings', text: () => 'Your listing is live.' },
  ListingRejected: { topic: 'listings', text: () => 'Your listing needs changes. See My ads for the reason.' },
  ListingBlocked: { topic: 'listings', text: () => 'One of your listings was blocked. See My ads; you can appeal once.' },
  ListingExpired: { topic: 'listings', text: () => 'Your listing expired. Renew it from My ads.' },
  SellerRestricted: { topic: 'listings', text: () => 'Your seller account is restricted. See My ads for details.' },
  QuoteRequested: { topic: 'quotes', text: () => 'You have a new quote request. Reply from Messages.' },
  QuoteRequestAnswered: { topic: 'quotes', text: (p) => (p.outcome === 'answer' ? 'A seller answered your quote request. See Messages.' : 'A seller could not quote for your request. See Messages.') },
  ProviderInvited: { topic: 'quotes', text: () => 'You are invited to quote on BuildWise. See Quotes.' },
  MessageSent: { topic: 'messages', text: (p) => `New message${p.fromName ? ` from ${String(p.fromName).slice(0, 40)}` : ''} on BuildWise. Reply in Messages.` },
};

/** Who an event is copied to: the people it names, else the owners and admins of the seller or provider. */
async function recipientsOf(sql: Sql, payload: Record<string, any>) {
  const cols = `u.id, u.phone_e164, u.email, u.notification_prefs`;
  if (Array.isArray(payload.mirrorTo)) {
    return many<{ id: string; phone_e164: string | null; email: string | null; notification_prefs: unknown }>(sql,
      `select ${cols} from users u where u.id = any($1::uuid[]) and u.status = 'active'`, [payload.mirrorTo]);
  }
  if (payload.buyerUserId) return many<{ id: string; phone_e164: string | null; email: string | null; notification_prefs: unknown }>(sql, `select ${cols} from users u where u.id = $1 and u.status = 'active'`, [payload.buyerUserId]);
  const orgId = payload.sellerOrgId ?? payload.orgId;
  if (!orgId) return [];
  return many<{ id: string; phone_e164: string | null; email: string | null; notification_prefs: unknown }>(sql,
    `select ${cols} from users u join org_members m on m.user_id = u.id where m.org_id = $1 and m.role in ('owner', 'admin') and u.status = 'active'`, [orgId]);
}

type OutboxRow = { event_id: string; event_type: string; payload: any };
const LEASE = `interval '5 minutes'`;

/**
 * Claims pending events (all, or only the given ids) so no other dispatcher sends them: `for update skip locked`
 * passes over rows another dispatcher is claiming, and a claim is a 5-minute lease in case its holder dies.
 */
async function claim(s: Services, batch: number, ids?: string[]): Promise<OutboxRow[]> {
  return s.db.tx({ kind: 'system' }, (sql) => many<OutboxRow>(sql,
    `update outbox set claimed_at = now(), attempts = attempts + 1
      where event_id in (select event_id from outbox
                          where dispatched_at is null and attempts < 10 and (claimed_at is null or claimed_at < now() - ${LEASE})
                            ${ids ? 'and event_id = any($2::uuid[])' : ''}
                          order by occurred_at limit $1 for update skip locked)
      returning event_id, event_type, payload`, ids ? [batch, ids] : [batch]));
}

/** Sends one claimed event's copies, then marks it dispatched. Throws only when nothing could be delivered. */
async function deliver(s: Services, e: OutboxRow) {
  await s.db.tx({ kind: 'system' }, async (sql) => {
    const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
    const m = MIRRORED[e.event_type];
    const text = m?.text(payload);
    const errors: string[] = [];
    let delivered = 0;
    // An invitation goes to a phone number that may not have an account yet.
    if (e.event_type === 'ProjectInvitationSent' && payload.phone) {
      try {
        const r = await sendSms(sql, s.pack, s.sms, payload.phone, `You have been invited to the project "${String(payload.projectName).slice(0, 80)}" on BuildWise. Sign in with this number to accept.`, 'notification');
        if (r.sent) delivered += 1; else errors.push(`sms cap (${r.scope})`);
      } catch (err) { errors.push(String(err).slice(0, 200)); }
    }
    if (m && text) {
      for (const p of await recipientsOf(sql, payload)) {
        const channel = mirrorChannel(notificationPrefs(p.notification_prefs), m.topic, { email: p.email, phone: p.phone_e164 }, { email: !!s.email.live, sms: !!s.sms.live });
        try {
          if (channel === 'email') { await s.email.send(p.email!, text, 'notification'); delivered += 1; }
          else if (channel === 'sms') {
            const r = await sendSms(sql, s.pack, s.sms, p.phone_e164!, text, 'notification');
            if (r.sent) delivered += 1; else errors.push(`sms cap (${r.scope})`);
          }
        } catch (err) { errors.push(String(err).slice(0, 200)); }
      }
    }
    // Every copy failed: leave the event for a retry (the claim is released, the attempt counted).
    if (errors.length && !delivered && !errors.every((x) => x.startsWith('sms cap'))) throw new Error(errors.join('; '));
    await sql.query(`update outbox set dispatched_at = now(), last_error = $2 where event_id = $1`, [e.event_id, errors.length ? errors.join('; ').slice(0, 500) : null]);
  });
}

async function dispatch(s: Services, events: OutboxRow[]) {
  for (const e of events) {
    try { await deliver(s, e); } catch (err) {
      await s.db.tx({ kind: 'system' }, (sql) => sql.query(`update outbox set claimed_at = null, last_error = $2 where event_id = $1`, [e.event_id, String(err).slice(0, 500)]));
    }
  }
  return events.length;
}

/** The scheduled dispatcher: everything pending, oldest first. */
export async function dispatchOutbox(s: Services, batch = 50): Promise<number> {
  return dispatch(s, await claim(s, batch));
}

/** Dispatches the events a request just committed (called in the background right after the response). */
export async function dispatchEvents(s: Services, ids: string[]): Promise<number> {
  return ids.length ? dispatch(s, await claim(s, ids.length, ids)) : 0;
}

export async function runExpiries(s: Services): Promise<Record<string, number>> {
  return s.db.tx({ kind: 'system' }, async (sql) => {
    const out: Record<string, number> = {};
    // One runner at a time across instances (the daily cron and the catch-up after requests); the other skips.
    if (!(await one<{ got: boolean }>(sql, `select pg_try_advisory_xact_lock(727275) as got`))?.got) return { skipped: 1 };
    const listings = await many<{ id: string }>(sql, `select id from listings where status = 'live' and expires_at <= now() order by expires_at limit 500 for update skip locked`);
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
      // Claim the search and read when it was last checked under the lock, so two runners never alert twice.
      const row = await one<{ last_checked_at: unknown }>(sql, `select last_checked_at from saved_searches where id = $1 and frequency <> 'off' for update skip locked`, [ss.id]);
      if (!row) return;
      ss.last_checked_at = row.last_checked_at;
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

/**
 * Retention (spec §20.3, windows in the market pack's `privacy.retention`): deletes expired export archives, old
 * sign-in sessions and contact-reveal logs (device ids go first), redacts the website chats of deleted users once
 * their retention has passed (unless a report holds them), and pseudonymises deleted accounts after the holding
 * window. Every step selects only rows it has not done yet, so running it again changes nothing. It runs in the full
 * worker cycle (in-process worker and the daily cron), not in the per-request catch-up: its windows are days long.
 */
export async function runRetention(s: Services): Promise<Record<string, number>> {
  const r = s.pack.privacy.retention;
  const out: Record<string, number> = {};
  const archives = await s.db.tx({ kind: 'system' }, (sql) => many<{ id: string; storage_key: string }>(sql,
    `select id, storage_key from data_exports where purged_at is null and created_at < now() - make_interval(days => $1) order by created_at limit 200`, [s.pack.privacy.export.keepDays]));
  for (const a of archives) {
    await s.storage.remove(a.storage_key);
    await s.db.tx({ kind: 'system' }, (sql) => sql.query(`update data_exports set purged_at = now() where id = $1`, [a.id]));
  }
  out.exportsPurged = archives.length;

  return s.db.tx({ kind: 'system' }, async (sql) => {
    // Like the expiries, one instance at a time: two would each audit the same pseudonymisation.
    if (!(await one<{ got: boolean }>(sql, `select pg_try_advisory_xact_lock(727276) as got`))?.got) return { ...out, skipped: 1 };
    // A session ends when revoked or when its 30-day token lapses; its record is kept for the sign-in window.
    out.sessionsDeleted = (await sql.query(`delete from sessions where coalesce(revoked_at, created_at + interval '30 days') < now() - make_interval(days => $1) returning 1`, [r.sessionDays])).rows.length;
    out.revealsDeleted = (await sql.query(`delete from contact_reveals where created_at < now() - make_interval(days => $1) returning 1`, [r.contactRevealDays])).rows.length;
    out.revealsPseudonymised = (await sql.query(`update contact_reveals set device_id = null where device_id is not null and created_at < now() - make_interval(days => $1) returning 1`, [r.contactRevealPseudonymiseDays])).rows.length;

    // Website chats where one side deleted their account, quiet for the retention window and not held by an open report.
    const threads = (await many<{ id: string }>(sql,
      `select t.id from threads t
        where t.last_message_at < now() - make_interval(days => $1)
          and (exists (select 1 from users u where u.id = t.buyer_user_id and u.status = 'deleted')
               or exists (select 1 from organizations o join org_members m on m.org_id = o.id and m.role = 'owner' join users u on u.id = m.user_id
                           where o.id = t.seller_org_id and o.kind = 'personal' and u.status = 'deleted'))
          and not exists (select 1 from reports rp where rp.status = 'open' and (rp.target_id = t.listing_id or rp.target_id in (select id from messages where thread_id = t.id)))
          and exists (select 1 from messages mm where mm.thread_id = t.id and mm.redacted_at is null)
        limit 500`, [r.deletedUserChatDays])).map((t) => t.id);
    out.chatMessagesRedacted = threads.length ? (await sql.query(`update messages set body = '', redacted_at = now() where thread_id = any($1::uuid[]) and redacted_at is null returning 1`, [threads])).rows.length : 0;
    if (threads.length) await sql.query(`update quote_requests set notes = null, answer_note = null, redacted_at = now() where thread_id = any($1::uuid[]) and redacted_at is null`, [threads]);
    out.chatThreadsRedacted = threads.length;

    // Deleted accounts: the held name, phone and email are erased after the holding window.
    const due = await many<{ id: string }>(sql,
      `select id from users where status = 'deleted' and pseudonymised_at is null and coalesce(deleted_at, created_at) < now() - make_interval(days => $1) limit 200`, [r.deletedAccountDays]);
    for (const u of due) {
      await sql.query(`update users set erasure_snapshot = null, pseudonymised_at = now(), display_name = 'Deleted user', phone_e164 = null, email = null where id = $1`, [u.id]);
      await sql.query(`delete from sessions where user_id = $1`, [u.id]);
      await sql.query(`delete from otp_codes where user_id = $1`, [u.id]);
      await sql.query(`delete from thread_reads where user_id = $1`, [u.id]);
      await sql.query(`update contact_reveals set device_id = null where viewer_user_id = $1 and device_id is not null`, [u.id]);
      await audit(sql, { actorUserId: null, action: 'account.pseudonymised', targetType: 'User', targetId: u.id, reason: 'retention window passed' });
    }
    out.accountsPseudonymised = due.length;
    return out;
  });
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
  const retention = await runRetention(s);
  const alerts = await runSavedSearches(s);
  const dispatched = await dispatchOutbox(s);
  return { expiries, retention, alerts, dispatched, assistant };
}

/**
 * The time-based part of the worker cycle: expiries and deadlines, saved-search alerts, document retries and the
 * outbox. Run by the cron, and opportunistically after ordinary requests (see `catchUpAfterRequests`).
 */
export async function runTimedWork(s: Services) {
  await runDocumentJobs(s);
  const expiries = await runExpiries(s);
  const alerts = await runSavedSearches(s);
  const dispatched = await dispatchOutbox(s);
  return { expiries, alerts, dispatched };
}

/**
 * Serverless hosts may only allow a daily cron. Instead of a per-minute one, ordinary requests run the timed work
 * in the background at most once per `intervalMs` per instance (the expiries take a cross-instance try-lock, so
 * two instances never run them together). Returns the hook to call after each response.
 */
export function catchUpAfterRequests(s: Services, intervalMs: number, log: (m: string, e?: unknown) => void = () => undefined) {
  let last = 0;
  let running = false;
  return () => {
    const now = Date.now();
    if (intervalMs <= 0 || running || now - last < intervalMs) return;
    last = now;
    running = true;
    inBackground(() => runTimedWork(s).finally(() => { running = false; }), (e) => log('catch-up failed', e));
  };
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
