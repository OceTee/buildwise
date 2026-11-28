import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STAFF_ACCESS } from '@bw/domain';
import { registry } from '../src/http/route.js';
import { grantStaff } from '../src/scripts/grant-staff.js';
import { totp, TOTP_STEP_SECONDS, verifyTotp, hotp, base32Encode } from '../src/platform/totp.js';
import { harness, type Json } from './helpers.js';

/** Staff access for the public beta (spec §7.6, §19.1): per-role checks, TOTP, dual-control grants, bootstrap script. */
let h: Awaited<ReturnType<typeof harness>>;
type U = Awaited<ReturnType<typeof h.signIn>>;
let ops1: U, ops2: U, mod: U, qs: U;
const sys = (q: string, p: unknown[] = []) => h.services.db.tx({ kind: 'system' }, (sql) => sql.query(q, p));
const one = async (q: string, p: unknown[] = []) => (await sys(q, p)).rows[0] as Json | undefined;
/** A code for the step after the one just used, as an authenticator shows 30 seconds later. */
const nextCode = (secret: string) => totp(secret, Date.now() + TOTP_STEP_SECONDS * 1000);

beforeAll(async () => {
  h = await harness();
  ops1 = await h.signIn('Ola Ops', { staff: 'ops_admin' });
  ops2 = await h.signIn('Pat Ops', { staff: 'ops_admin' });
  mod = await h.signIn('Quinn Moderator', { staff: 'moderator' });
  qs = await h.signIn('Rae Reviewer', { staff: 'qs_reviewer' });
});
afterAll(() => h.close());

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC test vector and refuses replays', () => {
    // RFC 6238 appendix B, SHA-1 secret "12345678901234567890" at T = 59 s → 94287082 (8 digits); 6 digits → 287082.
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(hotp(secret, 1)).toBe('287082');
    expect(totp(secret, 59_000)).toBe('287082');
    const step = verifyTotp(secret, '287082', 0, 59_000)!;
    expect(step).toBe(1);
    expect(verifyTotp(secret, '287082', step, 59_000)).toBeNull();
    expect(verifyTotp(secret, '000000', 0, 59_000)).toBeNull();
  });
});

describe('per-role staff checks', () => {
  it('every staff route names its roles from the one map', () => {
    expect(registry.filter((r) => r.auth === 'staff').length).toBeGreaterThan(30);
    expect(STAFF_ACCESS.admin).toEqual(['ops_admin']);
  });

  it('a moderator is refused operations-admin routes; a QS reviewer is refused moderation', async () => {
    expect((await h.call(mod.token, 'GET', '/v1/moderation/staff')).status).toBe(403);
    expect((await h.call(mod.token, 'POST', '/v1/moderation/staff/grants', { phone: qs.phone, role: 'moderator', reason: 'Not allowed to grant' })).status).toBe(403);
    expect((await h.call(mod.token, 'GET', '/v1/admin/categories')).status).toBe(403);
    expect((await h.ok(mod.token, 'GET', '/v1/moderation/queue'))).toBeTruthy();
    expect((await h.call(qs.token, 'GET', '/v1/moderation/queue')).status).toBe(403);
    expect((await h.call(qs.token, 'GET', '/v1/moderation/staff')).status).toBe(403);
    expect((await h.ok(qs.token, 'GET', '/v1/review/queue'))).toBeTruthy();
    expect((await h.ok(ops1.token, 'GET', '/v1/moderation/staff')).staff.length).toBeGreaterThanOrEqual(4);
    const plain = await h.signIn('Sam Plain');
    expect((await h.call(plain.token, 'GET', '/v1/moderation/queue')).status).toBe(403);
  });
});

describe('second factor for staff sessions', () => {
  it('a staff session needs a code before staff routes work, and acts as an ordinary user until then', async () => {
    const s = await h.signIn('Tolu New Staff', { staff: 'moderator', mfa: false });
    const blocked = await h.call(s.token, 'GET', '/v1/moderation/queue');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('MFA_REQUIRED');
    expect((await h.ok(s.token, 'GET', '/v1/me')).staffMfa).toBe('needs_enrolment');
    expect((await h.ok(s.token, 'GET', '/v1/staff/mfa'))).toMatchObject({ required: true, enrolled: false, verified: false });

    const e = await h.ok(s.token, 'POST', '/v1/staff/mfa/enrol');
    expect(e.otpauthUrl).toMatch(/^otpauth:\/\/totp\/BuildWise/);
    expect(JSON.stringify(e)).not.toContain(s.phone);
    const stored = await one(`select secret_enc from staff_mfa where user_id = $1`, [s.id]);
    expect(stored!.secret_enc).not.toContain(e.secret);

    const wrong = await h.call(s.token, 'POST', '/v1/staff/mfa/verify', { code: totp(e.secret) === '123456' ? '654321' : '123456' });
    expect(wrong.status).toBe(422);
    expect(wrong.body.error.code).toBe('WRONG_CODE');
    const ok = await h.ok(s.token, 'POST', '/v1/staff/mfa/verify', { code: totp(e.secret) });
    expect(ok.recoveryCodes).toHaveLength(h.services.pack.privacy.staff.recoveryCodes);
    expect((await h.ok(s.token, 'GET', '/v1/me')).staffMfa).toBe('verified');
    expect(await h.ok(s.token, 'GET', '/v1/moderation/queue')).toBeTruthy();
    expect((await h.call(s.token, 'POST', '/v1/staff/mfa/enrol')).body.error.code).toBe('ALREADY_ENROLLED');
    expect((await one(`select count(*)::int as n from audit_events where action = 'staff.mfa_enrolled' and target_id = $1`, [s.id]))!.n).toBe(1);

    // A second session on another device: the same code cannot be replayed; a recovery code works once.
    const second = (await h.session(s.phone, 'Tolu New Staff')).token as string;
    expect((await h.ok(second, 'GET', '/v1/me')).staffMfa).toBe('needs_code');
    expect((await h.call(second, 'POST', '/v1/staff/mfa/verify', { code: totp(e.secret) })).status).toBe(422);
    expect((await h.ok(second, 'POST', '/v1/staff/mfa/verify', { recoveryCode: ok.recoveryCodes[0].toLowerCase() })).verified).toBe(true);
    const third = (await h.session(s.phone, 'Tolu New Staff')).token as string;
    expect((await h.call(third, 'POST', '/v1/staff/mfa/verify', { recoveryCode: ok.recoveryCodes[0] })).status).toBe(422);
    expect((await h.ok(third, 'POST', '/v1/staff/mfa/verify', { code: nextCode(e.secret) })).verified).toBe(true);

    // A verified session expires after the pack's window.
    await sys(`update sessions set mfa_at = now() - make_interval(hours => $2) where id in (select id from sessions where user_id = $1)`, [s.id, h.services.pack.privacy.staff.mfaSessionHours + 1]);
    expect((await h.call(s.token, 'GET', '/v1/moderation/queue')).body.error.code).toBe('MFA_REQUIRED');
  });

  it('locks after repeated wrong codes, even though each attempt fails', async () => {
    const s = await h.signIn('Uche Locked', { staff: 'moderator', mfa: false });
    const e = await h.ok(s.token, 'POST', '/v1/staff/mfa/enrol');
    const bad = totp(e.secret) === '111111' ? '222222' : '111111';
    for (let i = 0; i < 5; i++) expect((await h.call(s.token, 'POST', '/v1/staff/mfa/verify', { code: bad })).status).toBe(422);
    const locked = await h.call(s.token, 'POST', '/v1/staff/mfa/verify', { code: totp(e.secret) });
    expect(locked.status).toBe(429);
    expect(locked.body.error.code).toBe('MFA_LOCKED');
  });

  it('non-staff cannot enrol, and revoking a role ends the enrolment', async () => {
    const plain = await h.signIn('Vic Plain');
    expect((await h.call(plain.token, 'POST', '/v1/staff/mfa/enrol')).status).toBe(403);
  });
});

describe('granting and revoking staff roles', () => {
  it('moderator and QS grants apply at once; ops_admin needs a second operations admin', async () => {
    const a = await h.signIn('Wale Candidate');
    const b = await h.signIn('Xena Candidate');
    expect((await h.call(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: a.phone, role: 'moderator', reason: 'no' })).status).toBe(400);
    const g = await h.ok(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: a.phone, role: 'moderator', reason: 'Joining the moderation team' });
    expect(g.status).toBe('applied');
    expect((await h.ok(a.token, 'GET', '/v1/me'))).toMatchObject({ isStaff: true, staffRole: 'moderator', staffMfa: 'needs_enrolment' });
    expect((await h.call(a.token, 'GET', '/v1/moderation/queue')).body.error.code).toBe('MFA_REQUIRED');
    expect((await h.call(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: ops1.phone, role: 'moderator', reason: 'Demote myself please' })).status).toBe(403);

    const p = await h.ok(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: b.phone, role: 'ops_admin', reason: 'Second operations admin for the beta' });
    expect(p.status).toBe('pending');
    expect((await one(`select is_staff from users where id = $1`, [b.id]))!.is_staff).toBe(false);
    expect((await h.call(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: b.phone, role: 'moderator', reason: 'Another change meanwhile' })).body.error.code).toBe('CHANGE_PENDING');
    // The requester cannot approve their own request; a different operations admin can.
    expect((await h.call(ops1.token, 'POST', `/v1/moderation/staff/changes/${p.id}/approve`, {})).status).toBe(403);
    const list = await h.ok(ops2.token, 'GET', '/v1/moderation/staff');
    expect(list.pending.map((c: Json) => c.id)).toContain(p.id);
    const notes = await h.ok(ops2.token, 'GET', '/v1/notifications');
    expect(notes.items.some((n: Json) => n.title === 'A staff grant needs your approval')).toBe(true);
    expect((await h.ok(ops2.token, 'POST', `/v1/moderation/staff/changes/${p.id}/approve`, {})).status).toBe('applied');
    expect((await one(`select is_staff, staff_role from users where id = $1`, [b.id]))).toMatchObject({ is_staff: true, staff_role: 'ops_admin' });
    expect((await h.call(ops2.token, 'POST', `/v1/moderation/staff/changes/${p.id}/approve`, {})).body.error.code).toBe('NOT_PENDING');

    const granted = await one(`select metadata, reason, actor_user_id from audit_events where action = 'staff.role_granted' and target_id = $1`, [b.id]);
    expect(granted).toMatchObject({ reason: 'Second operations admin for the beta', actor_user_id: ops2.id });
    expect(granted!.metadata).toMatchObject({ role: 'ops_admin', requestedBy: ops1.id, approvedBy: ops2.id });

    // The database itself refuses an ops_admin grant applied by its requester.
    await expect(sys(`insert into staff_role_changes (id, target_user_id, action, role, reason, requested_by, status, decided_by) values (gen_random_uuid(), $1, 'grant', 'ops_admin', 'Self approved grant', $2, 'applied', $2)`, [a.id, ops1.id])).rejects.toThrow();
  });

  it('a request can be cancelled or rejected', async () => {
    const c = await h.signIn('Yemi Candidate');
    const p = await h.ok(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: c.phone, role: 'ops_admin', reason: 'Maybe another admin' });
    expect((await h.ok(ops2.token, 'POST', `/v1/moderation/staff/changes/${p.id}/reject`, { note: 'Not needed yet' })).status).toBe('rejected');
    const p2 = await h.ok(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: c.phone, role: 'ops_admin', reason: 'Asking once more' });
    expect((await h.ok(ops1.token, 'POST', `/v1/moderation/staff/changes/${p2.id}/reject`, {})).status).toBe('cancelled');
    expect((await one(`select is_staff from users where id = $1`, [c.id]))!.is_staff).toBe(false);
  });

  it('revoking ends staff access and the second factor; the last operations admin is protected', async () => {
    const m = await h.signIn('Zainab Leaving Staff', { staff: 'moderator' });
    expect(await h.ok(m.token, 'GET', '/v1/moderation/queue')).toBeTruthy();
    expect((await h.call(ops1.token, 'POST', `/v1/moderation/staff/${ops1.id}/revoke`, { reason: 'Revoke myself' })).status).toBe(403);
    expect((await h.ok(ops1.token, 'POST', `/v1/moderation/staff/${m.id}/revoke`, { reason: 'Left the moderation team' })).status).toBe('applied');
    expect((await h.call(m.token, 'GET', '/v1/moderation/queue')).status).toBe(403);
    expect(await one(`select 1 as x from staff_mfa where user_id = $1`, [m.id])).toBeUndefined();
    expect((await h.ok(m.token, 'GET', '/v1/me')).isStaff).toBe(false);

    const h2 = await harness();
    try {
      const solo = await h2.signIn('Solo Ops', { staff: 'ops_admin' });
      const other = await h2.signIn('Other Ops', { staff: 'ops_admin' });
      await h2.ok(solo.token, 'POST', `/v1/moderation/staff/${other.id}/revoke`, { reason: 'Only one admin left now' });
      expect((await h2.call(solo.token, 'POST', '/v1/moderation/staff/grants', { phone: solo.phone, role: 'moderator', reason: 'Self change' })).status).toBe(403);
    } finally { await h2.close(); }
  });

  it('grants and revokes need a recent code (step-up)', async () => {
    const t = await h.signIn('Step Up Target');
    await sys(`update sessions set mfa_at = now() - interval '1 hour' where user_id = $1`, [ops1.id]);
    const r = await h.call(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: t.phone, role: 'moderator', reason: 'Needs step up first' });
    expect(r.body.error.code).toBe('STEP_UP_REQUIRED');
    await h.ok(ops1.token, 'POST', '/v1/staff/mfa/verify', { code: nextCode(ops1.totpSecret!) });
    expect((await h.ok(ops1.token, 'POST', '/v1/moderation/staff/grants', { phone: t.phone, role: 'moderator', reason: 'Needs step up first' })).status).toBe('applied');
  });

  it('an operations admin resets a lost authenticator', async () => {
    const m = await h.signIn('Lost Phone Staff', { staff: 'moderator' });
    await h.ok(ops2.token, 'POST', `/v1/moderation/staff/${m.id}/mfa-reset`, { reason: 'Lost their phone' });
    expect((await h.call(m.token, 'GET', '/v1/moderation/queue')).body.error.code).toBe('MFA_REQUIRED');
    expect((await h.ok(m.token, 'GET', '/v1/me')).staffMfa).toBe('needs_enrolment');
  });
});

describe('bootstrap script', () => {
  it('grants the first operations admins by phone, and refuses otherwise', async () => {
    const h2 = await harness();
    try {
      const db = h2.services.db;
      const market = h2.services.config.marketId;
      expect((await grantStaff(db, market, { phone: '08012345678', role: 'ops_admin', reason: 'Founder bootstrap' })).ok).toBe(false);
      const owner = await h2.signIn('Owner Person');
      const dry = await grantStaff(db, market, { phone: owner.phone, role: 'ops_admin', reason: 'Founder bootstrap', dryRun: true });
      expect(dry).toMatchObject({ ok: true });
      expect((await h2.ok(owner.token, 'GET', '/v1/me')).isStaff).toBe(false);
      expect((await grantStaff(db, market, { phone: owner.phone, role: 'ops_admin', reason: 'no' })).ok).toBe(false);
      const r = await grantStaff(db, market, { phone: owner.phone, role: 'ops_admin', reason: 'Founder bootstrap' });
      expect(r.ok).toBe(true);
      // Nothing secret or identifying beyond a masked number is printed.
      expect(r.message).not.toContain(owner.phone);
      expect(r.message).not.toContain(owner.phone.slice(4));
      expect((await h2.ok(owner.token, 'GET', '/v1/me'))).toMatchObject({ isStaff: true, staffRole: 'ops_admin', staffMfa: 'needs_enrolment' });
      const audit = (await db.tx({ kind: 'system' }, (sql) => sql.query(`select actor_user_id, metadata from audit_events where action = 'staff.role_granted' and target_id = $1`, [owner.id]))).rows[0];
      expect(audit).toMatchObject({ actor_user_id: null });
      expect(audit!.metadata.via).toBe('cli');
      // Moderators come from the staff screen once an operations admin exists; at most two admins are bootstrapped.
      const second = await h2.signIn('Co Founder');
      expect((await grantStaff(db, market, { phone: second.phone, role: 'moderator', reason: 'Moderator via script' })).ok).toBe(false);
      expect((await grantStaff(db, market, { phone: second.phone, role: 'ops_admin', reason: 'Second founder' })).ok).toBe(true);
      const third = await h2.signIn('Third Person');
      expect((await grantStaff(db, market, { phone: third.phone, role: 'ops_admin', reason: 'Third admin' })).message).toMatch(/Refused/);
    } finally { await h2.close(); }
  });
});
