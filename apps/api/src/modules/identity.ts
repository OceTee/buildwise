import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DELETION_EFFECTS, maskPhone, normalizePhone, RETAINED_AFTER_DELETION, slugify, uuidv7 } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { issueSession, route, staffSessionVerified, type Client, type Services } from '../http/route.js';
import { ApiError, audit, badRequest, conflict, forbidden, newOtp, notFound, publish, sha256, tooMany, unauthorized, unprocessable } from '../platform/platform.js';
import { inBackground } from '../platform/background.js';
import { recordRefusal, reserveSms, sendSms } from '../platform/sms.js';
import { deleteAccount, deletionPlan } from './privacy.js';

/** Accounts, phone verification, sessions and business sellers (spec §3.11). */
const OTP_TTL_MIN = 10;
const OTP_MAX_ATTEMPTS = 5;

const codeHash = (s: Services, phone: string, code: string) => sha256(`${s.config.authSecret}:${phone}:${code}`);

export async function uniqueHandle(sql: Sql, name: string): Promise<string> {
  const base = slugify(name, 40) || 'seller';
  for (let i = 0; i < 50; i++) {
    const h = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await one(sql, `select 1 from organizations where handle = $1`, [h]))) return h;
  }
  return `${base}-${uuidv7().slice(-6)}`;
}

async function createAccount(sql: Sql, phone: string, displayName: string) {
  const id = uuidv7();
  await sql.query(`insert into users (id, phone_e164, phone_verified_at, display_name) values ($1, $2, now(), $3)`, [id, phone, displayName]);
  const org = uuidv7();
  await sql.query(`insert into organizations (id, kind, name, handle, created_by) values ($1, 'personal', $2, $3, $4)`, [org, displayName, await uniqueHandle(sql, displayName), id]);
  await sql.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')`, [org, id]);
  return id;
}

/**
 * Where a staff member's second factor stands for this session: `verified` (or `not_required` with MFA off in
 * development), `needs_code` (enrolled, code not entered on this session), or `needs_enrolment`.
 */
export async function staffMfaState(sql: Sql, s: Services, userId: string, sessionId: string | null): Promise<'not_required' | 'verified' | 'needs_code' | 'needs_enrolment'> {
  if (s.config.staffMfa === 'off') return 'not_required';
  const se = sessionId ? await one<{ mfa_at: unknown }>(sql, `select mfa_at from sessions where id = $1 and user_id = $2`, [sessionId, userId]) : null;
  if (staffSessionVerified(s, se?.mfa_at ? new Date(String(se.mfa_at)) : null)) return 'verified';
  const m = await one<{ confirmed_at: unknown }>(sql, `select confirmed_at from staff_mfa where user_id = $1`, [userId]);
  return m?.confirmed_at ? 'needs_code' : 'needs_enrolment';
}

export async function meView(sql: Sql, userId: string, ctx?: { s: Services; sessionId: string }) {
  const u = await one<Record<string, any>>(sql, `select * from users where id = $1`, [userId]);
  if (!u) throw notFound('Account');
  const orgs = await many<Record<string, any>>(sql,
    `select o.*, m.role from organizations o join org_members m on m.org_id = o.id where m.user_id = $1 order by o.kind desc, o.created_at`, [userId]);
  return {
    id: u.id, displayName: u.display_name, phone: u.phone_e164, phoneMasked: u.phone_e164 ? maskPhone(u.phone_e164) : null, email: u.email,
    // The account's staff role; staff tools also need `staffMfa` to be verified (or not required) on this session.
    isStaff: u.is_staff, staffRole: u.staff_role, createdAt: iso(u.created_at),
    staffMfa: u.is_staff && ctx ? await staffMfaState(sql, ctx.s, userId, ctx.sessionId) : null,
    organizations: orgs.map((o) => ({ id: o.id, kind: o.kind, name: o.name, handle: o.handle, role: o.role, chatOnly: o.chat_only, areaCode: o.area_code, businessHours: o.business_hours, businessEmail: o.business_email, publishAddress: o.publish_address, businessAddress: o.business_address, closed: !!o.closed_at, reservedName: o.reserved_name })),
  };
}

/**
 * Sends a one-time code to a number, with the sign-in limits per number, IP and device (§3.14). `phone_change`
 * codes are tied to the signed-in account and are never accepted for signing in.
 */
async function issueOtp(sql: Sql, s: Services, phone: string, client: Client, purpose: 'sign_in' | 'phone_change', userId: string | null) {
  const lim = s.pack.limits;
  // Count-then-insert is made atomic with transaction-scoped locks on the number, the IP and the device, always
  // taken in that order (so two requests never wait on each other in a cycle). A concurrent request for the same
  // key waits for this one to commit and then sees its code in the count.
  for (const k of [`otp:phone:${phone}`, `otp:ip:${client.ip}`, ...(client.deviceId ? [`otp:device:${client.deviceId}`] : [])]) {
    await sql.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [k]);
  }
  const perNumber = await one<{ n: number }>(sql, `select count(*)::int as n from otp_codes where phone_e164 = $1 and created_at > now() - interval '1 hour'`, [phone]);
  const perIp = await one<{ n: number }>(sql, `select count(*)::int as n from otp_codes where ip = $1 and created_at > now() - interval '1 hour'`, [client.ip]);
  // SMS-pumping and enumeration protection (§3.14): limits per number, IP and device.
  if ((perNumber?.n ?? 0) >= (s.config.otpLimitPerHour ?? lim.otpPerNumberPerHour) || (perIp?.n ?? 0) >= (s.config.otpLimitPerHour ?? lim.otpPerIpPerHour)) throw tooMany('Too many codes requested. Wait a while before trying again.', 3600);
  if (client.deviceId) {
    const perDevice = await one<{ n: number }>(sql, `select count(*)::int as n from otp_codes where device_id = $1 and created_at > now() - interval '1 hour'`, [client.deviceId]);
    if ((perDevice?.n ?? 0) >= lim.otpPerIpPerHour) throw tooMany('Too many codes requested from this device.', 3600);
  }
  // The daily SMS caps (market pack `messaging`): past one, codes by SMS pause and ops are told.
  const reserved = await reserveSms(sql, s.pack, phone);
  if (!reserved.sent) {
    // This transaction is refused, so the refusal (and the first one's ops alert) is recorded in its own.
    inBackground(() => s.db.tx({ kind: 'system' }, (x) => recordRefusal(x, s.pack, reserved.scope, reserved.cap)));
    throw new ApiError(503, 'SMS_UNAVAILABLE', 'We can’t send codes right now because of high demand. Please try again later.', { retryAfter: 3600 });
  }
  const code = newOtp();
  await sql.query(`insert into otp_codes (id, phone_e164, code_hash, ip, device_id, expires_at, purpose, user_id) values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6), $7, $8)`,
    [uuidv7(), phone, codeHash(s, phone, code), client.ip, client.deviceId, OTP_TTL_MIN, purpose, userId]);
  const text = purpose === 'sign_in'
    ? `Your sign-in code is ${code}. It expires in ${OTP_TTL_MIN} minutes. Never share it with anyone.`
    : `Your code to move your BuildWise account to this number is ${code}. It expires in ${OTP_TTL_MIN} minutes. Never share it with anyone.`;
  await s.sms.send(phone, text, 'otp');
  return { sent: true, phoneMasked: maskPhone(phone), expiresInMinutes: OTP_TTL_MIN, ...(s.config.exposeOtp ? { devCode: code } : {}) };
}

/** Checks the newest unexpired code of a purpose for a number, counting wrong attempts; marks it used when right. */
async function checkOtp(sql: Sql, s: Services, phone: string, code: string, purpose: 'sign_in' | 'phone_change', userId: string | null, consume: boolean) {
  const otp = await one<{ id: string; code_hash: string; attempts: number }>(sql,
    `select id, code_hash, attempts from otp_codes where phone_e164 = $1 and purpose = $2 and ($3::uuid is null or user_id = $3) and consumed_at is null and expires_at > now() order by created_at desc limit 1 for update`,
    [phone, purpose, userId]);
  if (!otp) throw unprocessable('CODE_EXPIRED', 'That code has expired. Request a new one.');
  if (otp.attempts >= OTP_MAX_ATTEMPTS) throw unprocessable('TOO_MANY_ATTEMPTS', 'Too many wrong codes. Request a new one.');
  if (otp.code_hash !== codeHash(s, phone, code)) {
    await sql.query(`update otp_codes set attempts = attempts + 1 where id = $1`, [otp.id]);
    throw unprocessable('WRONG_CODE', 'That code is not right. Check the SMS and try again.');
  }
  if (consume) await sql.query(`update otp_codes set consumed_at = now() where id = $1`, [otp.id]);
  return otp.id;
}

/** Which org a seller acts for: the requested one if they are a member with a posting role, else their personal org. */
export async function actingOrg(sql: Sql, userId: string, orgId?: string | null): Promise<{ id: string; kind: string; role: string; name: string }> {
  const rows = await many<{ id: string; kind: string; role: string; name: string; closed_at: unknown }>(sql,
    `select o.id, o.kind, m.role, o.name, o.closed_at from organizations o join org_members m on m.org_id = o.id where m.user_id = $1`, [userId]);
  const org = orgId ? rows.find((r) => r.id === orgId) : rows.find((r) => r.kind === 'personal');
  if (!org) throw forbidden('You are not a member of that seller account.');
  if (org.closed_at) throw forbidden('This business has closed on BuildWise.');
  if (org.role === 'billing') throw forbidden('Billing members cannot manage listings.');
  return org;
}

export function registerIdentity(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/market', auth: 'public',
    handler: async () => {
      const p = s.pack;
      return {
        id: p.id, name: p.name, illustrative: p.illustrative, locale: p.locale, currency: p.currency, timeZone: p.timeZone,
        defaultCallingCode: p.phone.defaultCallingCode, regions: p.regions, safetyTips: p.safetyTips, tax: p.tax,
        policy: { quoteRequestExpiryDays: p.policy.quoteRequestExpiryDays, reviewCooldownDays: p.policy.reviewCooldownDays },
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/auth/otp/request', auth: 'public',
    // System context: a browser that is still signed in may ask for a code for another number (sign-in is not their data).
    systemContext: true,
    body: z.object({ phone: z.string().min(6).max(24) }),
    handler: async ({ sql, body, client }) => {
      const phone = normalizePhone(body.phone, s.pack);
      if (!phone) throw badRequest('INVALID_PHONE', `Enter a mobile number for this market (${s.pack.phone.defaultCallingCode}).`);
      // Same response whether or not an account exists.
      return issueOtp(sql, s, phone, client, 'sign_in', null);
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/auth/otp/verify', auth: 'public', systemContext: true,
    body: z.object({
      phone: z.string().min(6).max(24), code: z.string().regex(/^\d{6}$/),
      displayName: z.string().trim().min(2).max(60).optional(),
      /** The number was recycled: start a new account instead of signing in to the previous holder's (§3.11). */
      freshAccount: z.boolean().default(false),
      /** The holder confirms a dormant account is theirs. */
      confirmExisting: z.boolean().default(false),
      deviceLabel: z.string().trim().max(80).optional(),
    }),
    handler: async ({ sql, body, client }) => {
      const phone = normalizePhone(body.phone, s.pack);
      if (!phone) throw badRequest('INVALID_PHONE', 'Enter a valid mobile number.');
      const otpId = await checkOtp(sql, s, phone, body.code, 'sign_in', null, false);
      let user = await one<{ id: string; status: string; display_name: string; last_seen_at: unknown }>(sql, `select id, status, display_name, last_seen_at from users where phone_e164 = $1`, [phone]);
      // Recycled numbers (§3.11): a dormant account, reached from a device it has never used, asks first.
      if (user && !body.freshAccount && !body.confirmExisting) {
        const lastSeen = user.last_seen_at ? new Date(String(user.last_seen_at)).getTime() : 0;
        const dormant = Date.now() - lastSeen > s.pack.policy.dormantAccountDays * 86_400_000;
        const knownDevice = client.deviceId ? !!(await one(sql, `select 1 from sessions where user_id = $1 and device_id = $2`, [user.id, client.deviceId])) : false;
        if (dormant && !knownDevice) return { needsName: true, phoneMasked: maskPhone(phone), existingAccount: true, accountHint: `${user.display_name.slice(0, 1)}…` };
      }
      // A new account needs a name first: confirm the code is right but keep it valid for the follow-up call.
      if ((!user || body.freshAccount) && !body.displayName) return { needsName: true, phoneMasked: maskPhone(phone), existingAccount: !!user };
      await sql.query(`update otp_codes set consumed_at = now() where id = $1`, [otpId]);
      let isNew = false;
      if (user && body.freshAccount) {
        // Detach the number from the previous holder; they recover through support or another factor.
        await sql.query(`update users set phone_e164 = null where id = $1`, [user.id]);
        await sql.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [user.id]);
        await audit(sql, { actorUserId: null, action: 'account.phone_recycled', targetType: 'User', targetId: user.id, metadata: { reason: 'new holder verified the number' } });
        user = null;
      }
      if (user && user.status === 'suspended') throw forbidden('This account is suspended. Contact support to appeal.');
      if (!user) {
        const id = await createAccount(sql, phone, body.displayName!);
        user = { id, status: 'active', display_name: body.displayName!, last_seen_at: null };
        isNew = true;
        await publish(sql, 'PhoneVerified', { userId: id });
        await audit(sql, { actorUserId: id, action: 'account.created', targetType: 'User', targetId: id });
      }
      // Signing in again from the same browser replaces that browser's earlier session (a stolen copy of its cookie stops working).
      if (client.deviceId) {
        await sql.query(`update sessions set revoked_at = now() where user_id = $1 and device_id = $2 and revoked_at is null`, [user.id, client.deviceId]);
      }
      const sid = uuidv7();
      await sql.query(`insert into sessions (id, user_id, device_label, device_id) values ($1, $2, $3, $4)`, [sid, user.id, body.deviceLabel ?? null, client.deviceId]);
      await sql.query(`update users set last_seen_at = now() where id = $1`, [user.id]);
      return { token: await issueSession(s, user.id, sid), isNew, me: await meView(sql, user.id, { s, sessionId: sid }) };
    },
  });

  route(app, s, { method: 'GET', url: '/v1/me', auth: 'user', handler: async ({ sql, user }) => meView(sql, user.id, { s, sessionId: user.sessionId }) });

  // Correction (§20.2): name, email and, below, the phone number.
  route(app, s, {
    method: 'PATCH', url: '/v1/me', auth: 'user',
    body: z.object({ displayName: z.string().trim().min(2).max(60).optional(), email: z.email().max(200).nullable().optional() }),
    handler: async ({ sql, body, user }) => {
      await sql.query(`update users set display_name = coalesce($2, display_name), email = case when $3::boolean then $4 else email end where id = $1`,
        [user.id, body.displayName ?? null, body.email !== undefined, body.email ?? null]);
      // The personal seller account carries the person's name on their listings and chats.
      if (body.displayName) await sql.query(`update organizations set name = $2 where kind = 'personal' and id in (select org_id from org_members where user_id = $1 and role = 'owner')`, [user.id, body.displayName]);
      await audit(sql, { actorUserId: user.id, action: 'account.updated', targetType: 'User', targetId: user.id, metadata: { fields: Object.keys(body) } });
      return meView(sql, user.id, { s, sessionId: user.sessionId });
    },
  });

  // Changing the phone number: a code goes to the new number, with the same limits as signing in.
  // One-time codes are server-only (016_rls_marketplace), so these run in system context like sign-in; every
  // statement is scoped to the signed-in account, which is required explicitly.
  route(app, s, {
    method: 'POST', url: '/v1/me/phone/request', auth: 'public', systemContext: true,
    body: z.object({ phone: z.string().min(6).max(24) }),
    handler: async ({ sql, body, user, client }) => {
      if (!user) throw unauthorized();
      const phone = normalizePhone(body.phone, s.pack);
      if (!phone) throw badRequest('INVALID_PHONE', `Enter a mobile number for this market (${s.pack.phone.defaultCallingCode}).`);
      const me = await one<{ phone_e164: string | null }>(sql, `select phone_e164 from users where id = $1`, [user.id]);
      if (me?.phone_e164 === phone) throw unprocessable('SAME_PHONE', 'That is already your number.');
      if (await one(sql, `select 1 from users where phone_e164 = $1`, [phone])) throw conflict('PHONE_IN_USE', 'Another account uses that number. Sign in with it, or delete that account first.');
      return issueOtp(sql, s, phone, client, 'phone_change', user.id);
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/me/phone/verify', auth: 'public', systemContext: true, successStatus: 200,
    body: z.object({ phone: z.string().min(6).max(24), code: z.string().regex(/^\d{6}$/) }),
    handler: async ({ sql, body, user }) => {
      if (!user) throw unauthorized();
      const phone = normalizePhone(body.phone, s.pack);
      if (!phone) throw badRequest('INVALID_PHONE', 'Enter a valid mobile number.');
      await checkOtp(sql, s, phone, body.code, 'phone_change', user.id, true);
      if (await one(sql, `select 1 from users where phone_e164 = $1 and id <> $2`, [phone, user.id])) throw conflict('PHONE_IN_USE', 'Another account uses that number.');
      const old = await one<{ phone_e164: string | null }>(sql, `select phone_e164 from users where id = $1`, [user.id]);
      await sql.query(`update users set phone_e164 = $2, phone_verified_at = now() where id = $1`, [user.id, phone]);
      await audit(sql, { actorUserId: user.id, action: 'account.phone_changed', targetType: 'User', targetId: user.id, metadata: { from: old?.phone_e164 ? maskPhone(old.phone_e164) : null, to: maskPhone(phone) } });
      // Tell the old number, so a takeover does not go unnoticed.
      if (old?.phone_e164) await sendSms(sql, s.pack, s.sms, old.phone_e164, `The phone number on your BuildWise account was changed to ${maskPhone(phone)}. If this was not you, contact support now.`, 'notification');
      return meView(sql, user.id, { s, sessionId: user.sessionId });
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/me/sessions', auth: 'user',
    handler: async ({ sql, user }) => ({
      items: (await many<Record<string, any>>(sql, `select * from sessions where user_id = $1 and revoked_at is null order by last_seen_at desc`, [user.id]))
        .map((x) => ({ id: x.id, deviceLabel: x.device_label ?? 'Browser', createdAt: iso(x.created_at), lastSeenAt: iso(x.last_seen_at), current: x.id === user.sessionId })),
    }),
  });

  route(app, s, {
    method: 'POST', url: '/v1/me/sessions/revoke', auth: 'user', successStatus: 200,
    body: z.object({ sessionId: z.uuid().optional(), everywhere: z.boolean().default(false) }),
    handler: async ({ sql, body, user }) => {
      if (body.everywhere) await sql.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [user.id]);
      else await sql.query(`update sessions set revoked_at = now() where user_id = $1 and id = $2`, [user.id, body.sessionId ?? user.sessionId]);
      await audit(sql, { actorUserId: user.id, action: body.everywhere ? 'session.revoked_all' : 'session.revoked', targetType: 'User', targetId: user.id });
      return { revoked: true };
    },
  });

  // What deleting the account does and keeps, shown before the person confirms.
  route(app, s, {
    method: 'GET', url: '/v1/me/deletion', auth: 'user',
    handler: async ({ sql, user }) => ({ effects: DELETION_EFFECTS, retained: RETAINED_AFTER_DELETION, holdDays: s.pack.privacy.retention.deletedAccountDays, ...(await deletionPlan(sql, user.id)) }),
  });

  route(app, s, {
    // System context: deletion ends staff roles, renames the personal seller account's handle and archives projects for
    // their other members, which row-level security reserves for staff. Every statement names this account.
    method: 'DELETE', url: '/v1/me', auth: 'public', systemContext: true, successStatus: 200,
    body: z.object({ confirm: z.literal('DELETE') }),
    handler: async ({ sql, user }) => {
      if (!user) throw unauthorized();
      return deleteAccount(sql, s, user.id);
    },
  });

  // ---------------------------------------------------------------- business sellers
  route(app, s, {
    method: 'POST', url: '/v1/businesses', auth: 'user',
    body: z.object({ name: z.string().trim().min(2).max(80), email: z.email(), areaCode: z.string().max(40) }),
    handler: async ({ sql, body, user }) => {
      if (!s.pack.regions.some((r) => r.areas.some((a) => a.code === body.areaCode))) throw badRequest('INVALID_AREA', 'Choose an area in this market.');
      // Verified businesses can reserve their trading name; close matches are refused (§3.11, impersonation control).
      const reserved = await one<{ name: string }>(sql, `select name from organizations where reserved_name and similarity(lower(name), lower($1)) > 0.6 limit 1`, [body.name]);
      if (reserved) throw conflict('NAME_RESERVED', `“${reserved.name}” is a verified business name. Choose a name that clearly identifies your own business.`);
      const id = uuidv7();
      await sql.query(`insert into organizations (id, kind, name, handle, business_email, area_code, created_by) values ($1, 'business', $2, $3, $4, $5, $6)`,
        [id, body.name, await uniqueHandle(sql, body.name), body.email, body.areaCode, user.id]);
      await sql.query(`insert into org_members (org_id, user_id, role) values ($1, $2, 'owner')`, [id, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'business.created', targetType: 'Organization', targetId: id, metadata: { name: body.name } });
      return { id, me: await meView(sql, user.id, { s, sessionId: user.sessionId }) };
    },
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/organizations/:orgId', auth: 'user',
    params: z.object({ orgId: z.uuid() }),
    body: z.object({
      chatOnly: z.boolean().optional(), businessHours: z.string().trim().max(120).nullable().optional(), areaCode: z.string().max(40).optional(),
      businessAddress: z.string().trim().max(200).nullable().optional(), publishAddress: z.boolean().optional(),
      name: z.string().trim().min(2).max(80).optional(), businessEmail: z.email().max(200).optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const m = await one<{ role: string; kind: string; reserved_name: boolean; closed_at: unknown; name: string }>(sql,
        `select m.role, o.kind, o.reserved_name, o.closed_at, o.name from org_members m join organizations o on o.id = m.org_id where m.org_id = $1 and m.user_id = $2`, [params.orgId, user.id]);
      if (!m || !['owner', 'admin'].includes(m.role)) throw forbidden('Only owners and admins can change seller settings.');
      if (m.closed_at) throw forbidden('This business has closed on BuildWise.');
      if (body.areaCode && !s.pack.regions.some((r) => r.areas.some((a) => a.code === body.areaCode))) throw badRequest('INVALID_AREA', 'Choose an area in this market.');
      if ((body.name || body.businessEmail) && m.kind !== 'business') throw badRequest('NOT_A_BUSINESS', 'Change your own name in your profile.');
      if (body.name && body.name !== m.name) {
        // A verified trading name is reserved; changing it goes through verification again (§3.11).
        if (m.reserved_name) throw conflict('NAME_VERIFIED', 'This business name is verified. Contact support to change it.');
        const reserved = await one<{ name: string }>(sql, `select name from organizations where reserved_name and id <> $2 and similarity(lower(name), lower($1)) > 0.6 limit 1`, [body.name, params.orgId]);
        if (reserved) throw conflict('NAME_RESERVED', `“${reserved.name}” is a verified business name. Choose a name that clearly identifies your own business.`);
        await sql.query(`update organizations set name = $2 where id = $1`, [params.orgId, body.name]);
      }
      if (body.businessEmail) await sql.query(`update organizations set business_email = $2 where id = $1`, [params.orgId, body.businessEmail]);
      await sql.query(
        `update organizations set chat_only = coalesce($2, chat_only), business_hours = case when $3::boolean then $4 else business_hours end,
           area_code = coalesce($5, area_code), business_address = case when $6::boolean then $7 else business_address end, publish_address = coalesce($8, publish_address) where id = $1`,
        [params.orgId, body.chatOnly ?? null, body.businessHours !== undefined, body.businessHours ?? null, body.areaCode ?? null, body.businessAddress !== undefined, body.businessAddress ?? null, body.publishAddress ?? null]);
      await audit(sql, { actorUserId: user.id, action: 'seller.settings_changed', targetType: 'Organization', targetId: params.orgId, metadata: { fields: Object.keys(body) } });
      return meView(sql, user.id, { s, sessionId: user.sessionId });
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/organizations/:orgId/members', auth: 'user',
    params: z.object({ orgId: z.uuid() }),
    body: z.object({ phone: z.string().min(6).max(24), role: z.enum(['admin', 'member', 'billing']) }),
    handler: async ({ sql, params, body, user }) => {
      const m = await one<{ role: string; kind: string }>(sql, `select m.role, o.kind from org_members m join organizations o on o.id = m.org_id where m.org_id = $1 and m.user_id = $2`, [params.orgId, user.id]);
      if (!m || !['owner', 'admin'].includes(m.role) || m.kind !== 'business') throw forbidden('Only business owners and admins can add team members.');
      const phone = normalizePhone(body.phone, s.pack);
      const target = phone ? await one<{ id: string }>(sql, `select id from users where phone_e164 = $1 and status = 'active'`, [phone]) : null;
      if (!target) throw unprocessable('NO_ACCOUNT', 'Ask them to create an account with that phone number first.');
      await sql.query(`insert into org_members (org_id, user_id, role) values ($1, $2, $3) on conflict (org_id, user_id) do update set role = excluded.role`, [params.orgId, target.id, body.role]);
      await audit(sql, { actorUserId: user.id, action: 'business.member_added', targetType: 'Organization', targetId: params.orgId, metadata: { role: body.role } });
      return { added: true };
    },
  });

  // ---------------------------------------------------------------- notifications
  route(app, s, {
    method: 'GET', url: '/v1/notifications', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql, `select * from notifications where user_id = $1 order by created_at desc limit 100`, [user.id]);
      return { unread: rows.filter((r) => !r.read_at).length, items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, count: n.count ?? 1, read: !!n.read_at, createdAt: iso(n.created_at) })) };
    },
  });
  route(app, s, {
    method: 'POST', url: '/v1/notifications/read', auth: 'user', successStatus: 200,
    handler: async ({ sql, user }) => { await sql.query(`update notifications set read_at = now() where user_id = $1 and read_at is null`, [user.id]); return { ok: true }; },
  });
}
