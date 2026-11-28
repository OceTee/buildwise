import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { GRANTABLE_STAFF_ROLES, maskPhone, needsSecondApprover, normalizePhone, STAFF_ACCESS, STAFF_ROLE_LABELS, STAFF_ROLES, uuidv7, type StaffRole } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { errorEnvelope, route, type Actor, type Services } from '../http/route.js';
import { ApiError, audit, conflict, forbidden, notFound, notify, unprocessable } from '../platform/platform.js';
import { newRecoveryCodes, newTotpSecret, openSecret, otpauthUrl, recoveryCodeHash, sealSecret, totp, verifyTotp } from '../platform/totp.js';

/**
 * Staff access (spec §7.6, §19.1): TOTP as the second factor on every staff session, and staff roles granted and
 * revoked by operations admins with a reason, audited, with a second operations admin approving any ops_admin grant.
 */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

type Row = Record<string, any>;

/** Grants and revokes need a code entered within the last few minutes (step-up, §19.1 "access elevation"). */
function requireStepUp(s: Services, user: Actor) {
  if (s.config.staffMfa === 'off') return;
  const fresh = user.mfaAt && Date.now() - user.mfaAt.getTime() < s.pack.privacy.staff.stepUpMinutes * 60_000;
  if (!fresh) throw new ApiError(403, 'STEP_UP_REQUIRED', 'Confirm it is you: enter a fresh code from your authenticator app, then try again.');
}

async function activeOpsAdmins(sql: Sql, except?: string) {
  return (await one<{ n: number }>(sql, `select count(*)::int as n from users where is_staff and staff_role = 'ops_admin' and status = 'active' and ($1::uuid is null or id <> $1)`, [except ?? null]))?.n ?? 0;
}

/**
 * Applies a grant or revoke to the user row and records it. Revoking (or changing away from a staff role) ends the
 * second-factor enrolment, so a later grant enrols afresh.
 */
export async function applyRoleChange(sql: Sql, c: { id: string; targetUserId: string; action: 'grant' | 'revoke'; role: StaffRole | null; reason: string; requestedBy: string | null; approvedBy: string | null; via: 'staff_screen' | 'cli' }) {
  const t = await one<{ is_staff: boolean; staff_role: string | null }>(sql, `select is_staff, staff_role from users where id = $1 for update`, [c.targetUserId]);
  if (c.action === 'grant') {
    await sql.query(`update users set is_staff = true, staff_role = $2 where id = $1`, [c.targetUserId, c.role]);
  } else {
    await sql.query(`update users set is_staff = false, staff_role = null where id = $1`, [c.targetUserId]);
    await sql.query(`delete from staff_recovery_codes where user_id = $1`, [c.targetUserId]);
    await sql.query(`delete from staff_mfa where user_id = $1`, [c.targetUserId]);
    await sql.query(`update sessions set mfa_at = null where user_id = $1`, [c.targetUserId]);
  }
  await audit(sql, {
    actorUserId: c.approvedBy ?? c.requestedBy, action: c.action === 'grant' ? 'staff.role_granted' : 'staff.role_revoked', targetType: 'User', targetId: c.targetUserId,
    reason: c.reason, metadata: { changeId: c.id, role: c.role, previousRole: t?.is_staff ? t.staff_role : null, requestedBy: c.requestedBy, approvedBy: c.approvedBy, via: c.via },
  });
  await notify(sql, [c.targetUserId], c.action === 'grant'
    ? { kind: 'staff_role', title: `You are now ${STAFF_ROLE_LABELS[c.role!]} on BuildWise`, body: 'Set up two-step verification the first time you open the staff tools.', link: '/moderation' }
    : { kind: 'staff_role', title: 'Your BuildWise staff access has ended', body: c.reason, link: null });
}

function staffView(u: Row) {
  return { id: u.id as string, name: u.display_name as string, phoneMasked: u.phone_e164 ? maskPhone(u.phone_e164) : null, role: u.staff_role as string, mfaEnrolled: !!u.confirmed_at, lastSeenAt: iso(u.last_seen_at) };
}

export function registerStaff(app: FastifyInstance, s: Services) {
  const cfg = () => s.pack.privacy.staff;

  // ---------------------------------------------------------------- second factor
  async function rawStaff(sql: Sql, userId: string) {
    const u = await one<{ is_staff: boolean; display_name: string; phone_e164: string | null }>(sql, `select is_staff, display_name, phone_e164 from users where id = $1`, [userId]);
    if (!u?.is_staff) throw forbidden('Two-step verification here is for staff accounts.');
    return u;
  }

  route(app, s, {
    method: 'GET', url: '/v1/staff/mfa', auth: 'user',
    handler: async ({ sql, user }) => {
      await rawStaff(sql, user.id);
      const m = await one<Row>(sql, `select * from staff_mfa where user_id = $1`, [user.id]);
      const verified = s.config.staffMfa === 'off' || user.isStaff;
      return {
        required: s.config.staffMfa === 'required', enrolled: !!m?.confirmed_at, verified, sessionHours: cfg().mfaSessionHours, stepUpMinutes: cfg().stepUpMinutes,
        lockedUntil: m?.locked_until && new Date(String(m.locked_until)) > new Date() ? iso(m.locked_until) : null,
        recoveryCodesLeft: m?.confirmed_at ? (await one<{ n: number }>(sql, `select count(*)::int as n from staff_recovery_codes where user_id = $1 and used_at is null`, [user.id]))!.n : 0,
        // Development and tests only, like sign-in codes: the current code, so the flow can be used without an app.
        ...(s.config.exposeStaffCode && m ? { devCode: totp(openSecret(s.config.authSecret, m.secret_enc)) } : {}),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/staff/mfa/enrol', auth: 'user',
    handler: async ({ sql, user }) => {
      const u = await rawStaff(sql, user.id);
      const m = await one<Row>(sql, `select confirmed_at from staff_mfa where user_id = $1`, [user.id]);
      if (m?.confirmed_at) throw conflict('ALREADY_ENROLLED', 'Two-step verification is already set up. Ask an operations admin to reset it if you lost your device.');
      const secret = newTotpSecret();
      await sql.query(
        `insert into staff_mfa (user_id, secret_enc) values ($1, $2) on conflict (user_id) do update set secret_enc = excluded.secret_enc, last_step = 0, failed_attempts = 0, locked_until = null, created_at = now()`,
        [user.id, sealSecret(s.config.authSecret, secret)]);
      const account = u.phone_e164 ? maskPhone(u.phone_e164) : u.display_name;
      return { secret, otpauthUrl: otpauthUrl(secret, account), ...(s.config.exposeStaffCode ? { devCode: totp(secret) } : {}) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/staff/mfa/verify', auth: 'user', successStatus: 200,
    body: z.object({ code: z.string().trim().regex(/^\d{6}$/).optional(), recoveryCode: z.string().trim().min(8).max(20).optional() }).refine((b) => !!b.code !== !!b.recoveryCode, 'Enter a code from your app or a recovery code.'),
    handler: async ({ sql, body, user, req, status }) => {
      await rawStaff(sql, user.id);
      const m = await one<Row>(sql, `select * from staff_mfa where user_id = $1 for update`, [user.id]);
      if (!m) throw conflict('NOT_ENROLLED', 'Set up two-step verification first.');
      if (m.locked_until && new Date(String(m.locked_until)) > new Date()) throw new ApiError(429, 'MFA_LOCKED', `Too many wrong codes. Try again after ${LOCK_MINUTES} minutes.`, { retryAfter: LOCK_MINUTES * 60 });
      let ok = false;
      let step: number | null = null;
      if (body.code) {
        step = verifyTotp(openSecret(s.config.authSecret, m.secret_enc), body.code, Number(m.last_step));
        ok = step !== null;
      } else if (m.confirmed_at) {
        const hit = await one<{ id: string }>(sql, `select id from staff_recovery_codes where user_id = $1 and code_hash = $2 and used_at is null`, [user.id, recoveryCodeHash(s.config.authSecret, body.recoveryCode!)]);
        if (hit) { await sql.query(`update staff_recovery_codes set used_at = now() where id = $1`, [hit.id]); ok = true; }
      }
      if (!ok) {
        // Recorded in this transaction (the request answers 422 without throwing), so the count survives.
        const failed = Number(m.failed_attempts) + 1;
        await sql.query(`update staff_mfa set failed_attempts = $2::int, locked_until = case when $2::int >= $3::int then now() + make_interval(mins => $4) else locked_until end where user_id = $1`, [user.id, failed, MAX_FAILED, LOCK_MINUTES]);
        if (failed >= MAX_FAILED) await audit(sql, { actorUserId: user.id, action: 'staff.mfa_locked', targetType: 'User', targetId: user.id });
        status(422);
        return errorEnvelope(new ApiError(422, 'WRONG_CODE', body.code ? 'That code is not right, or it was already used. Wait for the next code and try again.' : 'That recovery code is not right or was already used.'), req.id);
      }
      await sql.query(`update staff_mfa set failed_attempts = 0, locked_until = null, last_step = greatest(last_step, $2::bigint) where user_id = $1`, [user.id, step ?? 0]);
      let recoveryCodes: string[] | undefined;
      if (!m.confirmed_at) {
        await sql.query(`update staff_mfa set confirmed_at = now() where user_id = $1`, [user.id]);
        recoveryCodes = await issueRecoveryCodes(sql, user.id);
        await audit(sql, { actorUserId: user.id, action: 'staff.mfa_enrolled', targetType: 'User', targetId: user.id });
      } else if (body.recoveryCode) {
        await audit(sql, { actorUserId: user.id, action: 'staff.mfa_recovery_code_used', targetType: 'User', targetId: user.id });
      }
      await sql.query(`update sessions set mfa_at = now() where id = $1 and user_id = $2`, [user.sessionId, user.id]);
      return { verified: true, ...(recoveryCodes ? { recoveryCodes } : {}) };
    },
  });

  async function issueRecoveryCodes(sql: Sql, userId: string) {
    const codes = newRecoveryCodes(cfg().recoveryCodes);
    await sql.query(`delete from staff_recovery_codes where user_id = $1`, [userId]);
    for (const c of codes) await sql.query(`insert into staff_recovery_codes (id, user_id, code_hash) values ($1, $2, $3)`, [uuidv7(), userId, recoveryCodeHash(s.config.authSecret, c)]);
    return codes;
  }

  route(app, s, {
    method: 'POST', url: '/v1/staff/mfa/recovery-codes', auth: 'staff', staffRoles: STAFF_ROLES,
    handler: async ({ sql, user }) => {
      requireStepUp(s, user);
      if (s.config.staffMfa === 'off' && !(await one(sql, `select 1 from staff_mfa where user_id = $1 and confirmed_at is not null`, [user.id]))) throw conflict('NOT_ENROLLED', 'Set up two-step verification first.');
      const recoveryCodes = await issueRecoveryCodes(sql, user.id);
      await audit(sql, { actorUserId: user.id, action: 'staff.mfa_recovery_codes_replaced', targetType: 'User', targetId: user.id });
      return { recoveryCodes };
    },
  });

  // ---------------------------------------------------------------- roles (ops_admin only)
  route(app, s, {
    method: 'GET', url: '/v1/moderation/staff', auth: 'staff', staffRoles: STAFF_ACCESS.admin, systemContext: true,
    handler: async ({ sql, user }) => {
      const staff = await many<Row>(sql, `select u.*, m.confirmed_at from users u left join staff_mfa m on m.user_id = u.id where u.is_staff and u.status = 'active' order by u.staff_role, u.display_name`);
      const changes = await many<Row>(sql,
        `select c.*, t.display_name as target_name, t.phone_e164 as target_phone, r.display_name as requester_name, d.display_name as decider_name
           from staff_role_changes c join users t on t.id = c.target_user_id left join users r on r.id = c.requested_by left join users d on d.id = c.decided_by
          order by c.created_at desc limit 60`);
      const view = (c: Row) => ({
        id: c.id, action: c.action, role: c.role, previousRole: c.previous_role, reason: c.reason, status: c.status, via: c.via,
        target: { id: c.target_user_id, name: c.target_name, phoneMasked: c.target_phone ? maskPhone(c.target_phone) : null },
        requestedBy: c.requested_by ? { id: c.requested_by, name: c.requester_name } : null, decidedBy: c.decided_by ? { id: c.decided_by, name: c.decider_name } : null,
        decisionNote: c.decision_note, createdAt: iso(c.created_at), decidedAt: iso(c.decided_at), mine: c.requested_by === user.id,
      });
      return {
        roles: GRANTABLE_STAFF_ROLES.map((r) => ({ role: r, label: STAFF_ROLE_LABELS[r], needsSecondApprover: needsSecondApprover(r) })),
        staff: staff.map(staffView), pending: changes.filter((c) => c.status === 'pending').map(view), history: changes.filter((c) => c.status !== 'pending').map(view),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/staff/grants', auth: 'staff', staffRoles: STAFF_ACCESS.admin, systemContext: true,
    body: z.object({ phone: z.string().min(6).max(24), role: z.enum(GRANTABLE_STAFF_ROLES), reason: z.string().trim().min(5).max(500) }),
    handler: async ({ sql, body, user }) => {
      requireStepUp(s, user);
      const phone = normalizePhone(body.phone, s.pack);
      const target = phone ? await one<Row>(sql, `select id, is_staff, staff_role, display_name from users where phone_e164 = $1 and status = 'active'`, [phone]) : null;
      if (!target) throw unprocessable('NO_ACCOUNT', 'No active account uses that number. Ask them to sign in to BuildWise first.');
      if (target.id === user.id) throw forbidden('You cannot change your own staff role.');
      if (target.is_staff && target.staff_role === body.role) throw conflict('SAME_ROLE', `They are already ${STAFF_ROLE_LABELS[body.role]}.`);
      if (target.is_staff && target.staff_role === 'ops_admin' && (await activeOpsAdmins(sql, target.id)) === 0) throw conflict('LAST_OPS_ADMIN', 'They are the only operations admin.');
      if (await one(sql, `select 1 from staff_role_changes where target_user_id = $1 and status = 'pending'`, [target.id])) throw conflict('CHANGE_PENDING', 'A change for this person is waiting for approval.');
      const id = uuidv7();
      const dual = needsSecondApprover(body.role);
      await sql.query(
        `insert into staff_role_changes (id, target_user_id, action, role, previous_role, reason, requested_by, status, decided_by, decided_at) values ($1, $2, 'grant', $3, $4, $5, $6, $7, $8, $9)`,
        [id, target.id, body.role, target.is_staff ? target.staff_role : null, body.reason, user.id, dual ? 'pending' : 'applied', dual ? null : user.id, dual ? null : new Date()]);
      if (dual) {
        await audit(sql, { actorUserId: user.id, action: 'staff.grant_requested', targetType: 'User', targetId: target.id, reason: body.reason, metadata: { changeId: id, role: body.role } });
        const others = (await many<{ id: string }>(sql, `select id from users where is_staff and staff_role = 'ops_admin' and status = 'active' and id <> $1`, [user.id])).map((u) => u.id);
        await notify(sql, others, { kind: 'staff_role', title: 'A staff grant needs your approval', body: `${STAFF_ROLE_LABELS[body.role]} for ${target.display_name}`, link: '/moderation/staff' });
        return { id, status: 'pending', note: 'A second operations admin must approve this grant.' };
      }
      await applyRoleChange(sql, { id, targetUserId: target.id, action: 'grant', role: body.role, reason: body.reason, requestedBy: user.id, approvedBy: null, via: 'staff_screen' });
      return { id, status: 'applied' };
    },
  });

  async function pendingChange(sql: Sql, id: string) {
    const c = await one<Row>(sql, `select * from staff_role_changes where id = $1 for update`, [id]);
    if (!c) throw notFound('Staff change');
    if (c.status !== 'pending') throw conflict('NOT_PENDING', 'This change was already decided.');
    return c;
  }

  route(app, s, {
    method: 'POST', url: '/v1/moderation/staff/changes/:id/approve', auth: 'staff', staffRoles: STAFF_ACCESS.admin, systemContext: true, successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ note: z.string().trim().max(500).optional() }),
    handler: async ({ sql, params, body, user }) => {
      requireStepUp(s, user);
      const c = await pendingChange(sql, params.id);
      if (c.requested_by === user.id) throw forbidden('A different operations admin must approve a grant you asked for.');
      if (c.target_user_id === user.id) throw forbidden('You cannot approve a change to your own role.');
      const t = await one(sql, `select 1 from users where id = $1 and status = 'active'`, [c.target_user_id]);
      if (!t) throw conflict('NO_ACCOUNT', 'That account is no longer active.');
      await sql.query(`update staff_role_changes set status = 'applied', decided_by = $2, decided_at = now(), decision_note = $3 where id = $1`, [c.id, user.id, body.note ?? null]);
      await applyRoleChange(sql, { id: c.id, targetUserId: c.target_user_id, action: c.action, role: c.role, reason: c.reason, requestedBy: c.requested_by, approvedBy: user.id, via: c.via });
      return { id: c.id, status: 'applied' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/staff/changes/:id/reject', auth: 'staff', staffRoles: STAFF_ACCESS.admin, systemContext: true, successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ note: z.string().trim().max(500).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const c = await pendingChange(sql, params.id);
      const next = c.requested_by === user.id ? 'cancelled' : 'rejected';
      await sql.query(`update staff_role_changes set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1`, [c.id, next, user.id, body.note ?? null]);
      await audit(sql, { actorUserId: user.id, action: next === 'cancelled' ? 'staff.grant_cancelled' : 'staff.grant_rejected', targetType: 'User', targetId: c.target_user_id, reason: body.note ?? null, metadata: { changeId: c.id, role: c.role } });
      return { id: c.id, status: next };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/staff/:userId/revoke', auth: 'staff', staffRoles: STAFF_ACCESS.admin, systemContext: true, successStatus: 200,
    params: z.object({ userId: z.uuid() }),
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      requireStepUp(s, user);
      if (params.userId === user.id) throw forbidden('You cannot change your own staff role.');
      const t = await one<Row>(sql, `select is_staff, staff_role from users where id = $1`, [params.userId]);
      if (!t?.is_staff) throw notFound('Staff member');
      if (t.staff_role === 'ops_admin' && (await activeOpsAdmins(sql, params.userId)) === 0) throw conflict('LAST_OPS_ADMIN', 'They are the only operations admin.');
      const id = uuidv7();
      await sql.query(`update staff_role_changes set status = 'cancelled', decided_by = $2, decided_at = now(), decision_note = 'role revoked' where target_user_id = $1 and status = 'pending'`, [params.userId, user.id]);
      await sql.query(
        `insert into staff_role_changes (id, target_user_id, action, role, previous_role, reason, requested_by, status, decided_by, decided_at) values ($1, $2, 'revoke', null, $3, $4, $5, 'applied', $5, now())`,
        [id, params.userId, t.staff_role, body.reason, user.id]);
      await applyRoleChange(sql, { id, targetUserId: params.userId, action: 'revoke', role: null, reason: body.reason, requestedBy: user.id, approvedBy: null, via: 'staff_screen' });
      return { id, status: 'applied' };
    },
  });

  // A staff member who lost their device: the next staff sign-in enrols a new authenticator.
  route(app, s, {
    method: 'POST', url: '/v1/moderation/staff/:userId/mfa-reset', auth: 'staff', staffRoles: STAFF_ACCESS.admin, systemContext: true, successStatus: 200,
    params: z.object({ userId: z.uuid() }),
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      requireStepUp(s, user);
      if (params.userId === user.id) throw forbidden('Ask another operations admin to reset your own two-step verification.');
      const t = await one<Row>(sql, `select is_staff from users where id = $1`, [params.userId]);
      if (!t?.is_staff) throw notFound('Staff member');
      await sql.query(`delete from staff_recovery_codes where user_id = $1`, [params.userId]);
      await sql.query(`delete from staff_mfa where user_id = $1`, [params.userId]);
      await sql.query(`update sessions set mfa_at = null where user_id = $1`, [params.userId]);
      await audit(sql, { actorUserId: user.id, action: 'staff.mfa_reset', targetType: 'User', targetId: params.userId, reason: body.reason });
      return { reset: true };
    },
  });
}
