/**
 * Bootstraps the first operations admins (spec §7.6): grants a staff role to an existing account by phone number.
 *
 *   pnpm --filter @bw/api staff:grant --phone 0803xxxxxxx --reason "Founder, first operations admin" [--role ops_admin] [--dry-run]
 *
 * Point DATABASE_URL at the database to change (without it, the local development database is used). The script
 * never runs migrations: deploy the API first so migration 017 exists. It refuses unless the account exists and is
 * active, and it only bootstraps: once two operations admins exist, roles are granted on /moderation/staff, where a
 * second operations admin approves every ops_admin grant. It prints no codes, tokens or full phone numbers. The
 * person sets up two-step verification (an authenticator app) the first time they open the staff tools.
 */
import { parseArgs } from 'node:util';
import { GRANTABLE_STAFF_ROLES, getMarket, maskPhone, normalizePhone, uuidv7, type GrantableStaffRole } from '@bw/domain';
import { loadConfig } from '../config.js';
import { createPgDatabase, createPgliteDatabase, one, type Database } from '../db/database.js';
import { applyRoleChange } from '../modules/staff.js';

const BOOTSTRAP_OPS_ADMINS = 2;

export async function grantStaff(db: Database, marketId: string, args: { phone: string; role: GrantableStaffRole; reason: string; dryRun?: boolean }): Promise<{ ok: boolean; message: string }> {
  const pack = getMarket(marketId);
  const phone = normalizePhone(args.phone, pack);
  if (!phone) return { ok: false, message: `That is not a mobile number for this market (${pack.phone.defaultCallingCode}).` };
  if (!(GRANTABLE_STAFF_ROLES as readonly string[]).includes(args.role)) return { ok: false, message: `Role must be one of ${GRANTABLE_STAFF_ROLES.join(', ')}.` };
  if (args.reason.trim().length < 5) return { ok: false, message: 'Give a reason of at least five characters (it goes into the audit log).' };
  return db.tx({ kind: 'system' }, async (sql) => {
    const ready = await one<{ t: string | null }>(sql, `select to_regclass('public.staff_role_changes')::text as t`);
    if (!ready?.t) return { ok: false, message: 'This database does not have the staff tables yet. Deploy the API first (it runs the migrations on start).' };
    const user = await one<{ id: string; status: string; is_staff: boolean; staff_role: string | null }>(sql, `select id, status, is_staff, staff_role from users where phone_e164 = $1`, [phone]);
    const who = `the account on ${maskPhone(phone)}`;
    if (!user || user.status !== 'active') return { ok: false, message: `No active account uses ${maskPhone(phone)}. Sign in once on the site with that number first.` };
    if (user.is_staff && user.staff_role === args.role) return { ok: true, message: `${who} is already ${args.role}. Nothing changed.` };
    const ops = (await one<{ n: number }>(sql, `select count(*)::int as n from users where is_staff and staff_role = 'ops_admin' and status = 'active'`))!.n;
    if (args.role === 'ops_admin' ? ops >= BOOTSTRAP_OPS_ADMINS : ops > 0) {
      return { ok: false, message: `Refused: ${ops} operations admin${ops === 1 ? '' : 's'} already exist. Grant roles on /moderation/staff instead, where a second operations admin approves ops_admin grants.` };
    }
    if (args.dryRun) return { ok: true, message: `Dry run: would grant ${args.role} to ${who}.` };
    const id = uuidv7();
    await sql.query(
      `insert into staff_role_changes (id, target_user_id, action, role, previous_role, reason, requested_by, via, status, decided_at) values ($1, $2, 'grant', $3, $4, $5, null, 'cli', 'applied', now())`,
      [id, user.id, args.role, user.is_staff ? user.staff_role : null, args.reason.trim()]);
    await applyRoleChange(sql, { id, targetUserId: user.id, action: 'grant', role: args.role, reason: args.reason.trim(), requestedBy: null, approvedBy: null, via: 'cli' });
    return { ok: true, message: `Granted ${args.role} to ${who}. They set up two-step verification the first time they open /moderation.` };
  });
}

async function main() {
  const { values } = parseArgs({ options: { phone: { type: 'string' }, role: { type: 'string', default: 'ops_admin' }, reason: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } }, allowPositionals: true });
  if (!values.phone || !values.reason) {
    console.error('Usage: pnpm --filter @bw/api staff:grant --phone <number> --reason "<why>" [--role ops_admin|moderator|qs_reviewer] [--dry-run]');
    process.exit(2);
  }
  const config = loadConfig();
  const db = config.databaseUrl ? await createPgDatabase(config.databaseUrl) : await createPgliteDatabase(config.pgliteDir);
  console.log(`Database: ${config.databaseUrl ? 'Postgres (DATABASE_URL)' : 'local development database'}`);
  try {
    const r = await grantStaff(db, config.marketId, { phone: values.phone, role: values.role as GrantableStaffRole, reason: values.reason, dryRun: values['dry-run'] });
    (r.ok ? console.log : console.error)(r.message);
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('grant-staff.ts')) await main();
