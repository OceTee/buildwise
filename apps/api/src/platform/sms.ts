import { crossesWarning, smsCapsFor, smsDay, type MarketPack } from '@bw/domain';
import { many, one, type Sql } from '../db/database.js';
import { audit, notify, publish, type MessageChannel } from './platform.js';

/**
 * SMS spend control (spec §16, §21.1): every text message goes through `sendSms`, which counts it against the
 * market pack's daily caps (in total and per destination calling code) in the sending transaction. The count is a
 * conditional upsert, so concurrent sends can never both take the last unit; past a cap the message is not sent.
 */
export type SmsOutcome = { sent: true } | { sent: false; scope: string; cap: number };

type Pack = Pick<MarketPack, 'messaging' | 'timeZone'>;

/** Counts one message against every cap that applies, or refuses it (nothing is counted when one cap is full). */
export async function reserveSms(sql: Sql, pack: Pack, phone: string, now = new Date()): Promise<SmsOutcome> {
  const day = smsDay(now, pack.timeZone);
  const caps = smsCapsFor(pack, phone);
  const taken: string[] = [];
  for (const c of caps) {
    const r = c.cap > 0 ? await one<{ sent: number }>(sql,
      `insert into sms_usage (day, scope, sent) values ($1, $2, 1)
       on conflict (day, scope) do update set sent = sms_usage.sent + 1 where sms_usage.sent < $3
       returning sent`, [day, c.scope, c.cap]) : null;
    if (!r) {
      for (const t of taken) await sql.query(`update sms_usage set sent = sent - 1 where day = $1 and scope = $2`, [day, t]);
      return { sent: false, scope: c.scope, cap: c.cap };
    }
    taken.push(c.scope);
    if (crossesWarning(r.sent, c.cap, pack.messaging.smsWarnAtPct)) {
      const first = await one(sql, `update sms_usage set warned_at = now() where day = $1 and scope = $2 and warned_at is null returning 1`, [day, c.scope]);
      if (first) await opsAlert(sql, 'warning', { day, scope: c.scope, cap: c.cap, sent: r.sent });
    }
  }
  return { sent: true };
}

/**
 * Records a refused message; the first refusal of the day for a scope tells ops (notification, audit and an event).
 * Runs in a transaction that commits, which for sign-in is a separate one: the request itself is refused.
 */
export async function recordRefusal(sql: Sql, pack: Pack, scope: string, cap: number, now = new Date()) {
  const day = smsDay(now, pack.timeZone);
  const r = await one<{ first: boolean }>(sql,
    `insert into sms_usage (day, scope, refused, capped_at) values ($1, $2, 1, now())
     on conflict (day, scope) do update set refused = sms_usage.refused + 1, capped_at = coalesce(sms_usage.capped_at, now())
     returning (refused = 1) as first`, [day, scope]);
  if (r?.first) await opsAlert(sql, 'cap', { day, scope, cap, sent: cap });
}

/** Sends one SMS if the caps allow it; a refusal is recorded in the same transaction. */
export async function sendSms(sql: Sql, pack: Pack, channel: MessageChannel, phone: string, text: string, kind: 'otp' | 'notification'): Promise<SmsOutcome> {
  const r = await reserveSms(sql, pack, phone);
  if (!r.sent) { await recordRefusal(sql, pack, r.scope, r.cap); return r; }
  await channel.send(phone, text, kind);
  return r;
}

const scopeLabel = (scope: string) => (scope === 'all' ? 'all numbers' : `${scope} numbers`);

async function opsAlert(sql: Sql, level: 'warning' | 'cap', a: { day: string; scope: string; cap: number; sent: number }) {
  const title = level === 'cap' ? `SMS daily cap reached for ${scopeLabel(a.scope)}` : `SMS use is at ${a.sent} of ${a.cap} today for ${scopeLabel(a.scope)}`;
  const body = level === 'cap'
    ? `${a.cap} messages were sent on ${a.day}. Sign-in codes and SMS notifications to ${scopeLabel(a.scope)} are paused until tomorrow. Raise the cap in the market pack (messaging) if this is real demand.`
    : `Check for SMS pumping before the cap of ${a.cap} pauses sign-in by SMS.`;
  // Ops admins first; any staff when there is none, so the alert always reaches someone.
  let staff = (await many<{ id: string }>(sql, `select id from users where is_staff and staff_role = 'ops_admin' and status = 'active'`)).map((u) => u.id);
  if (!staff.length) staff = (await many<{ id: string }>(sql, `select id from users where is_staff and status = 'active'`)).map((u) => u.id);
  await notify(sql, staff, { kind: 'ops', title, body, link: null });
  await audit(sql, { actorUserId: null, action: level === 'cap' ? 'ops.sms_cap_reached' : 'ops.sms_cap_warning', targetType: 'SmsUsage', targetId: `${a.day}:${a.scope}`, metadata: a });
  await publish(sql, 'SmsCapReached', { level, ...a });
  console.warn(`[ops] ${title} (${a.day})`);
}
