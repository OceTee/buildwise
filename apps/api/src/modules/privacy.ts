import type { FastifyInstance } from 'fastify';
import { RETAINED_AFTER_DELETION, uuidv7 } from '@bw/domain';
import { iso, many, one, str, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, conflict, sha256, signFileToken, tooMany } from '../platform/platform.js';
import { applyListingStatus } from './effects.js';

/**
 * Data rights (spec §20.2, §20.3, §28): a person can export everything BuildWise holds about them, and deleting
 * an account closes, archives and leaves what it should while keeping what law and audit require.
 */

type Row = Record<string, any>;
const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v);

// ---------------------------------------------------------------- export
/**
 * The archive: the person's own records, and in shared records (chats, quote requests, reviews of their
 * businesses) only what they can already see, without other people's identifiers or contact details.
 */
export async function buildExport(sql: Sql, s: Services, userId: string) {
  const u = await one<Row>(sql, `select * from users where id = $1`, [userId]);
  const orgs = await many<Row>(sql, `select o.*, m.role from organizations o join org_members m on m.org_id = o.id where m.user_id = $1 order by o.created_at`, [userId]);
  const owned = orgs.filter((o) => o.role === 'owner').map((o) => o.id as string);

  const listings = await many<Row>(sql,
    `select * from listings where seller_org_id = any($1::uuid[]) or created_by = $2 order by created_at`, [owned, userId]);

  const threads = await many<Row>(sql,
    `select t.id, t.created_at, t.last_message_at, t.buyer_user_id, t.seller_org_id, l.title as listing_title, o.name as seller_name
       from threads t join listings l on l.id = t.listing_id join organizations o on o.id = t.seller_org_id
      where t.buyer_user_id = $1 or t.seller_org_id = any($2::uuid[]) order by t.created_at`, [userId, owned]);
  const messages = threads.length ? await many<Row>(sql,
    `select thread_id, sender_user_id, body, held, redacted_at, created_at from messages where thread_id = any($1::uuid[]) order by created_at`, [threads.map((t) => t.id)]) : [];

  const quoteRequests = await many<Row>(sql,
    `select q.*, l.title as listing_title from quote_requests q join listings l on l.id = q.listing_id
      where q.buyer_user_id = $1 or q.seller_org_id = any($2::uuid[]) order by q.created_at`, [userId, owned]);

  const reviewsWritten = await many<Row>(sql,
    `select r.*, o.name as seller_name from reviews r join organizations o on o.id = r.seller_org_id where r.author_user_id = $1 order by r.created_at`, [userId]);
  const reviewsReceived = await many<Row>(sql,
    `select r.*, o.name as seller_name from reviews r join organizations o on o.id = r.seller_org_id where r.seller_org_id = any($1::uuid[]) and r.author_user_id <> $2 order by r.created_at`, [owned, userId]);

  const savedSearches = await many<Row>(sql, `select * from saved_searches where user_id = $1 order by created_at`, [userId]);
  const favourites = await many<Row>(sql, `select f.created_at, l.id as listing_id, l.title from favourites f join listings l on l.id = f.listing_id where f.user_id = $1 order by f.created_at`, [userId]);
  const reveals = await many<Row>(sql, `select r.created_at, r.confirmed, l.title from contact_reveals r join listings l on l.id = r.listing_id where r.viewer_user_id = $1 order by r.created_at`, [userId]);
  const notifications = await many<Row>(sql, `select * from notifications where user_id = $1 order by created_at`, [userId]);
  const sessions = await many<Row>(sql, `select * from sessions where user_id = $1 order by created_at`, [userId]);

  const memberships = await many<Row>(sql,
    `select p.*, pm.role as member_role from projects p join project_members pm on pm.project_id = p.id where pm.user_id = $1 order by p.created_at`, [userId]);
  const ownProjects = memberships.filter((p) => p.member_role === 'owner');
  const docs = ownProjects.length ? await many<Row>(sql,
    `select d.project_id, d.id, d.title, d.doc_type, d.discipline, d.number, d.created_at,
            coalesce(json_agg(json_build_object('revision', r.revision_label, 'fileName', r.original_name, 'bytes', r.bytes, 'state', r.state, 'uploadedAt', r.created_at))
                     filter (where r.id is not null), '[]') as revisions
       from documents d left join document_revisions r on r.document_id = d.id and r.uploaded_by = $2
      where d.project_id = any($1::uuid[]) group by d.id order by d.created_at`, [ownProjects.map((p) => p.id), userId]) : [];

  return {
    format: 'buildwise-export/v1',
    generatedAt: new Date().toISOString(),
    market: s.pack.id,
    note: 'Everything BuildWise holds about your account. In shared records (chats, quote requests, reviews of your businesses) the other people are not identified; your notifications are copied as they were shown to you. Project files are not included: download them from each project.',
    profile: {
      id: u!.id, displayName: u!.display_name, phone: u!.phone_e164, phoneVerifiedAt: iso(u!.phone_verified_at), email: u!.email,
      status: u!.status, staffRole: u!.is_staff ? u!.staff_role : null, createdAt: iso(u!.created_at), lastSeenAt: iso(u!.last_seen_at),
    },
    sessions: sessions.map((x) => ({ device: x.device_label ?? 'Browser', signedInAt: iso(x.created_at), lastSeenAt: iso(x.last_seen_at), signedOutAt: iso(x.revoked_at) })),
    organizations: orgs.map((o) => ({
      id: o.id, kind: o.kind, name: o.name, handle: o.handle, yourRole: o.role, createdAt: iso(o.created_at), closedAt: iso(o.closed_at),
      ...(o.role === 'owner' || o.role === 'admin' ? { businessEmail: o.business_email, areaCode: o.area_code, businessAddress: o.business_address, publishAddress: o.publish_address, businessHours: o.business_hours, chatOnly: o.chat_only } : {}),
    })),
    listings: listings.map((l) => ({
      id: l.id, shortId: l.short_id, sellerOrganizationId: l.seller_org_id, category: l.category_slug, title: l.title, description: l.description, attributes: json(l.attributes),
      price: str(l.price_minor), currency: l.currency, unit: l.unit, negotiable: l.negotiable, areaCode: l.area_code, status: l.status, closeReason: l.close_reason,
      createdAt: iso(l.created_at), publishedAt: iso(l.published_at), expiresAt: iso(l.expires_at), closedAt: iso(l.closed_at), views: l.views, contacts: l.contacts,
    })),
    chats: threads.map((t) => {
      const asBuyer = t.buyer_user_id === userId;
      return {
        id: t.id, listing: t.listing_title, youAre: asBuyer ? 'buyer' : 'seller', seller: asBuyer ? t.seller_name : undefined, startedAt: iso(t.created_at), lastMessageAt: iso(t.last_message_at),
        messages: messages.filter((m) => m.thread_id === t.id)
          // A message held for review was never delivered to the other side, so only its sender sees it.
          .filter((m) => !m.held || m.sender_user_id === userId)
          .map((m) => ({ at: iso(m.created_at), from: m.sender_user_id === userId ? 'you' : asBuyer ? 'seller' : 'buyer', text: m.redacted_at ? null : m.body, redacted: !!m.redacted_at })),
      };
    }),
    quoteRequests: quoteRequests.map((q) => ({
      id: q.id, listing: q.listing_title, youAre: q.buyer_user_id === userId ? 'buyer' : 'seller', quantity: String(q.quantity), unit: q.unit, deliveryArea: q.delivery_area,
      neededBy: q.needed_by ? String(q.needed_by instanceof Date ? q.needed_by.toISOString().slice(0, 10) : q.needed_by) : null,
      notes: q.redacted_at ? null : q.notes, status: q.status, answerPrice: str(q.answer_price_minor), answerNote: q.answer_note, createdAt: iso(q.created_at), answeredAt: iso(q.answered_at),
    })),
    reviewsWritten: reviewsWritten.map((r) => ({ seller: r.seller_name, rating: r.rating, text: r.body, status: r.status, sellerReply: r.reply_body, createdAt: iso(r.created_at) })),
    reviewsOfYourBusinesses: reviewsReceived.map((r) => ({ business: r.seller_name, rating: r.rating, text: r.body, status: r.status, yourReply: r.reply_body, createdAt: iso(r.created_at) })),
    savedSearches: savedSearches.map((x) => ({ label: x.label, query: json(x.query), frequency: x.frequency, createdAt: iso(x.created_at) })),
    favourites: favourites.map((f) => ({ listingId: f.listing_id, title: f.title, savedAt: iso(f.created_at) })),
    phoneNumbersRevealed: reveals.map((r) => ({ listing: r.title, at: iso(r.created_at), dealtWithSeller: r.confirmed })),
    projects: ownProjects.map((p) => ({
      id: p.id, name: p.name, buildingUse: p.building_use, areaCode: p.area_code, status: p.status, brief: json(p.brief), createdAt: iso(p.created_at), updatedAt: iso(p.updated_at),
      documents: docs.filter((d) => d.project_id === p.id).map((d) => ({ title: d.title, type: d.doc_type, discipline: d.discipline, number: d.number, createdAt: iso(d.created_at), revisionsYouUploaded: json(d.revisions) })),
    })),
    projectMemberships: memberships.filter((p) => p.member_role !== 'owner').map((p) => ({ name: p.name, role: p.member_role })),
    notifications: notifications.map((n) => ({ title: n.title, body: n.body, link: n.link, read: !!n.read_at, at: iso(n.created_at) })),
  };
}

export function registerPrivacy(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'POST', url: '/v1/me/export', auth: 'user',
    handler: async ({ sql, user }) => {
      const cfg = s.pack.privacy.export;
      const recent = await one<{ n: number }>(sql, `select count(*)::int as n from data_exports where user_id = $1 and created_at > now() - interval '1 day'`, [user.id]);
      if ((recent?.n ?? 0) >= cfg.perDay) throw tooMany(`You can download your data ${cfg.perDay} times a day. Try again tomorrow.`, 86_400);
      const archive = await buildExport(sql, s, user.id);
      const body = Buffer.from(JSON.stringify(archive, null, 2));
      const id = uuidv7();
      const key = `exports/${user.id}/${id}.json`;
      await s.storage.put(key, body, 'application/json');
      const hash = sha256(body);
      await sql.query(`insert into data_exports (id, user_id, storage_key, bytes, sha256) values ($1, $2, $3, $4, $5)`, [id, user.id, key, body.length, hash]);
      await audit(sql, { actorUserId: user.id, action: 'account.exported', targetType: 'User', targetId: user.id, metadata: { exportId: id, bytes: body.length } });
      const ttl = cfg.linkMinutes * 60;
      const token = signFileToken(s.config.authSecret, { op: 'download', key, mime: 'application/json', name: `buildwise-data-${archive.generatedAt.slice(0, 10)}.json` }, ttl);
      return { id, url: `/v1/files/${token}`, expiresInSeconds: ttl, bytes: body.length, sha256: hash };
    },
  });
}

// ---------------------------------------------------------------- deletion (§3.11, §20.3)
/** What a deletion would touch: businesses and projects the person owns alone, and the ones they share. */
export async function deletionPlan(sql: Sql, userId: string) {
  const orgs = await many<Row>(sql,
    `select o.id, o.kind, o.name, m.role,
            (select count(*)::int from org_members x join users xu on xu.id = x.user_id where x.org_id = o.id and x.role = 'owner' and x.user_id <> $1 and xu.status = 'active') as other_owners
       from organizations o join org_members m on m.org_id = o.id where m.user_id = $1 and o.kind = 'business'`, [userId]);
  const projects = await many<Row>(sql,
    `select p.id, p.name, p.status, pm.role,
            (select count(*)::int from project_members x join users xu on xu.id = x.user_id where x.project_id = p.id and x.role = 'owner' and x.user_id <> $1 and xu.status = 'active') as other_owners
       from projects p join project_members pm on pm.project_id = p.id where pm.user_id = $1`, [userId]);
  const soleOrg = (o: Row) => o.role === 'owner' && o.other_owners === 0;
  const soleProject = (p: Row) => p.role === 'owner' && p.other_owners === 0;
  return {
    closesBusinesses: orgs.filter(soleOrg).map((o) => ({ id: o.id as string, name: o.name as string })),
    leavesBusinesses: orgs.filter((o) => !soleOrg(o)).map((o) => ({ id: o.id as string, name: o.name as string })),
    archivesProjects: projects.filter(soleProject).map((p) => ({ id: p.id as string, name: p.name as string })),
    leavesProjects: projects.filter((p) => !soleProject(p)).map((p) => ({ id: p.id as string, name: p.name as string })),
  };
}

export async function deleteAccount(sql: Sql, s: Services, userId: string) {
  const u = await one<Row>(sql, `select * from users where id = $1 for update`, [userId]);
  if (!u || u.status === 'deleted') return { deleted: true, retained: RETAINED_AFTER_DELETION };
  if (u.is_staff && u.staff_role === 'ops_admin') {
    const others = await one<{ n: number }>(sql, `select count(*)::int as n from users where is_staff and staff_role = 'ops_admin' and status = 'active' and id <> $1`, [userId]);
    if ((others?.n ?? 0) === 0) throw conflict('LAST_OPS_ADMIN', 'You are the only operations admin. Grant the role to someone else before deleting your account.');
  }
  const plan = await deletionPlan(sql, userId);

  // Listings close: the personal seller account's and those of businesses the person owns alone.
  const personal = await many<{ id: string; name: string; handle: string }>(sql,
    `select o.id, o.name, o.handle from organizations o join org_members m on m.org_id = o.id where m.user_id = $1 and o.kind = 'personal' and m.role = 'owner'`, [userId]);
  const closing = [...personal.map((o) => o.id), ...plan.closesBusinesses.map((o) => o.id)];
  const open = await many<{ id: string }>(sql, `select id from listings where seller_org_id = any($1::uuid[]) and status not in ('closed', 'blocked')`, [closing]);
  for (const l of open) await applyListingStatus(sql, l.id, 'closed', userId, 'close', 'account_deleted');
  await sql.query(`update listings set close_reason = 'account_deleted', closed_at = coalesce(closed_at, now()) where id = any($1::uuid[])`, [open.map((l) => l.id)]);
  await sql.query(`update organizations set closed_at = now() where id = any($1::uuid[]) and closed_at is null`, [closing]);
  await sql.query(`update provider_profiles set accepts_rfqs = false, updated_at = now() where org_id = any($1::uuid[])`, [closing]);

  // Invitations they sent lapse (before they leave, while row-level security still shows them).
  await sql.query(`update project_invitations set status = 'revoked' where invited_by = $1 and status = 'pending'`, [userId]);
  // Shared businesses and projects: the person leaves. Projects they own alone are archived, not erased (§20.3).
  await sql.query(`delete from org_members where user_id = $1 and org_id = any($2::uuid[])`, [userId, plan.leavesBusinesses.map((o) => o.id)]);
  await sql.query(`update projects set status = 'archived', updated_at = now(), version = version + 1 where id = any($1::uuid[]) and status <> 'archived'`, [plan.archivesProjects.map((p) => p.id)]);
  await sql.query(`delete from project_members where user_id = $1 and project_id = any($2::uuid[])`, [userId, plan.leavesProjects.map((p) => p.id)]);

  // Own reviews are removed; reviews about a business stay with the business (§3.11).
  await sql.query(`update reviews set status = 'removed', removed_reason = 'author_deleted' where author_user_id = $1 and status <> 'removed'`, [userId]);
  await sql.query(`delete from saved_searches where user_id = $1`, [userId]);
  await sql.query(`delete from favourites where user_id = $1`, [userId]);
  await sql.query(`delete from notifications where user_id = $1`, [userId]);
  const exports = await many<{ id: string; storage_key: string }>(sql, `select id, storage_key from data_exports where user_id = $1 and purged_at is null`, [userId]);
  for (const x of exports) await s.storage.remove(x.storage_key);
  await sql.query(`update data_exports set purged_at = now() where user_id = $1 and purged_at is null`, [userId]);

  // Staff roles end with the account.
  if (u.is_staff) {
    await audit(sql, { actorUserId: userId, action: 'staff.role_revoked', targetType: 'User', targetId: userId, reason: 'account deleted', metadata: { role: u.staff_role } });
  }
  await sql.query(`update staff_role_changes set status = 'cancelled', decided_at = now(), decision_note = 'account deleted' where target_user_id = $1 and status = 'pending'`, [userId]);
  await sql.query(`delete from staff_recovery_codes where user_id = $1`, [userId]);
  await sql.query(`delete from staff_mfa where user_id = $1`, [userId]);
  await sql.query(`update sessions set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId]);

  // The account shows as "Deleted user" at once; its details are held for the retention window, then erased by the worker.
  for (const o of personal) {
    await sql.query(`update organizations set name = 'Deleted user', handle = $2, business_email = null, business_address = null, business_hours = null where id = $1`, [o.id, `deleted-${o.id.slice(-12)}`]);
  }
  const snapshot = { displayName: u.display_name, phone: u.phone_e164, email: u.email, personalOrgs: personal.map((o) => ({ id: o.id, name: o.name, handle: o.handle })) };
  await sql.query(
    `update users set status = 'deleted', deleted_at = now(), erasure_snapshot = $2::jsonb, phone_e164 = null, email = null, display_name = 'Deleted user', is_staff = false, staff_role = null where id = $1`,
    [userId, JSON.stringify(snapshot)]);
  await audit(sql, { actorUserId: userId, action: 'account.deleted', targetType: 'User', targetId: userId, metadata: { closedListings: open.length, closedBusinesses: plan.closesBusinesses.length, archivedProjects: plan.archivesProjects.length, leftBusinesses: plan.leavesBusinesses.length, leftProjects: plan.leavesProjects.length } });
  return {
    deleted: true, closedListings: open.length, closedBusinesses: plan.closesBusinesses.length, archivedProjects: plan.archivesProjects.length,
    leftBusinesses: plan.leavesBusinesses.length, leftProjects: plan.leavesProjects.length, retained: RETAINED_AFTER_DELETION,
  };
}
