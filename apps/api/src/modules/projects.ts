import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  can, findArea, grantableRoles, indicativeRange, intakeMissing, normalizePhone, PROJECT_ROLES, readiness, roleActions, uuidv7,
  type Brief, type ProjectAction, type ProjectRole, STAFF_ACCESS } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Actor, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish } from '../platform/platform.js';
import { actingOrg } from './identity.js';

/** Projects, membership, invitations and staff access (spec §7, §10.1). */

export interface ProjectAccess { projectId: string; role: ProjectRole; viaStaffSession: boolean }

/**
 * The policy decision point for project resources (§7.5). Members get their project role; staff with a live,
 * reason-coded access session get read-only `viewer` access. Anything else is reported as not found.
 */
export async function projectAccess(sql: Sql, user: Actor, projectId: string, action: ProjectAction): Promise<ProjectAccess> {
  const m = await one<{ role: ProjectRole }>(sql, `select role from project_members where project_id = $1 and user_id = $2`, [projectId, user.id]);
  let role = m?.role ?? null;
  let viaStaffSession = false;
  if (!role && user.isStaff) {
    const sess = await one(sql, `select 1 from staff_access_sessions where user_id = $1 and project_id = $2 and expires_at > now()`, [user.id, projectId]);
    if (sess) { role = 'viewer'; viaStaffSession = true; }
  }
  if (!can(role, action)) throw notFound('Project');
  return { projectId, role: role!, viaStaffSession };
}

export async function projectRow(sql: Sql, id: string) {
  const p = await one<Record<string, any>>(sql, `select * from projects where id = $1`, [id]);
  if (!p) throw notFound('Project');
  return p;
}

const briefSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  buildingUse: z.string().max(40).nullable().optional(),
  areaCode: z.string().max(40).nullable().optional(),
  floors: z.number().int().min(1).max(60).nullable().optional(),
  grossFloorAreaM2: z.string().regex(/^\d+(\.\d{1,2})?$/).nullable().optional(),
  finishBand: z.string().max(20).nullable().optional(),
  siteStatus: z.string().max(40).nullable().optional(),
  designStage: z.string().max(40).nullable().optional(),
  hasSurvey: z.boolean().nullable().optional(),
  hasGeotechnical: z.boolean().nullable().optional(),
  targetStart: z.iso.date().nullable().optional(),
  budgetMinor: z.string().regex(/^\d+$/).nullable().optional(),
  constraints: z.string().trim().max(2000).nullable().optional(),
});

function validateBrief(s: Services, b: z.infer<typeof briefSchema>) {
  const cfg = s.pack.projects;
  const errs: { path: string; message: string }[] = [];
  if (b.buildingUse && !cfg.buildingUses.some((u) => u.code === b.buildingUse)) errs.push({ path: 'buildingUse', message: 'Choose a building use from the list.' });
  if (b.areaCode && !findArea(s.pack, b.areaCode)) errs.push({ path: 'areaCode', message: 'Choose an area in this market.' });
  if (b.finishBand && !cfg.finishBands.some((x) => x.code === b.finishBand)) errs.push({ path: 'finishBand', message: 'Choose a finish level.' });
  if (b.siteStatus && !cfg.siteStatuses.some((x) => x.code === b.siteStatus)) errs.push({ path: 'siteStatus', message: 'Choose a site status.' });
  if (b.designStage && !cfg.designStages.some((x) => x.code === b.designStage)) errs.push({ path: 'designStage', message: 'Choose a design stage.' });
  if (errs.length) throw badRequest('VALIDATION_FAILED', 'Check the form.', errs);
}

function briefOf(p: Record<string, any>): Brief {
  const b = (typeof p.brief === 'string' ? JSON.parse(p.brief) : p.brief) ?? {};
  return { ...b, name: p.name, buildingUse: p.building_use, areaCode: p.area_code, regionCode: p.region_code };
}

export async function projectSummary(sql: Sql, s: Services, p: Record<string, any>, access: ProjectAccess) {
  const brief = briefOf(p);
  const docs = await many<{ discipline: string; doc_type: string }>(sql,
    `select d.discipline, d.doc_type from documents d join document_revisions r on r.id = d.current_revision_id where d.project_id = $1 and r.state = 'available'`, [p.id]);
  const drawings = docs.filter((d) => d.doc_type === 'drawing');
  const ready = readiness(brief, { drawingCount: drawings.length, disciplines: [...new Set(drawings.map((d) => d.discipline))] }, s.pack.projects);
  const counts = await one<Record<string, number>>(sql, `select
      (select count(*)::int from documents where project_id = $1) as documents,
      (select count(*)::int from rfis where project_id = $1 and status = 'open') as open_rfis,
      (select count(*)::int from estimates where project_id = $1) as estimates,
      (select count(*)::int from project_members where project_id = $1) as members`, [p.id]);
  const area = p.area_code ? findArea(s.pack, p.area_code) : null;
  return {
    id: p.id, name: p.name, status: p.status, currency: p.currency, version: p.version, createdAt: iso(p.created_at), updatedAt: iso(p.updated_at),
    brief, area: area ? { code: area.code, label: area.label, region: area.region.label } : null,
    role: access.role, viaStaffSession: access.viaStaffSession, allowed: roleActions(access.role).filter((a) => !access.viaStaffSession || a.endsWith('.read')),
    missing: intakeMissing(brief), readiness: ready,
    indicative: indicativeRange(brief, s.pack, new Date()),
    counts,
  };
}

export function registerProjects(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/project-config', auth: 'user',
    handler: async () => {
      const c = s.pack.projects;
      return { classes: c.classes.filter((x) => x.enabled).map((x) => ({ code: x.code, label: x.label })), buildingUses: c.buildingUses, finishBands: c.finishBands, designStages: c.designStages, siteStatuses: c.siteStatuses, disciplines: c.disciplines, documentTypes: c.documentTypes, documentStatuses: c.documentStatuses, workSections: c.workSections, maxUploadBytes: c.maxUploadBytes, maxPdfPages: c.maxPdfPages, currency: s.pack.currency, illustrative: s.pack.illustrative };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects', auth: 'user',
    body: briefSchema.extend({ name: z.string().trim().min(2).max(120), orgId: z.uuid().optional() }),
    handler: async ({ sql, body, user }) => {
      validateBrief(s, body);
      const org = await actingOrg(sql, user.id, body.orgId);
      const id = uuidv7();
      const { name, orgId: _o, buildingUse, areaCode, ...rest } = body;
      const area = areaCode ? findArea(s.pack, areaCode) : null;
      await sql.query(`insert into projects (id, owner_org_id, name, building_use, area_code, region_code, brief, currency, created_by) values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)`,
        [id, org.id, name, buildingUse ?? null, areaCode ?? null, area?.region.code ?? null, JSON.stringify(rest), s.pack.currency, user.id]);
      await sql.query(`insert into project_members (project_id, user_id, role, added_by) values ($1, $2, 'owner', $2)`, [id, user.id]);
      await publish(sql, 'ProjectCreated', { projectId: id, orgId: org.id });
      await audit(sql, { actorUserId: user.id, action: 'project.created', targetType: 'Project', targetId: id });
      return { id };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/projects', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql,
        `select p.*, m.role, (select count(*)::int from rfis r where r.project_id = p.id and r.status = 'open') as open_rfis
           from projects p join project_members m on m.project_id = p.id and m.user_id = $1 where p.status = 'active' order by p.updated_at desc`, [user.id]);
      return { items: rows.map((p) => ({ id: p.id, name: p.name, role: p.role, areaCode: p.area_code, buildingUse: p.building_use, openRfis: p.open_rfis, updatedAt: iso(p.updated_at) })) };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/projects/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const access = await projectAccess(sql, user, params.id, 'project.read');
      return projectSummary(sql, s, await projectRow(sql, params.id), access);
    },
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/projects/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: briefSchema.extend({ expectedVersion: z.number().int().positive() }),
    handler: async ({ sql, params, body, user }) => {
      const access = await projectAccess(sql, user, params.id, 'project.edit');
      validateBrief(s, body);
      const p = await projectRow(sql, params.id);
      if (p.version !== body.expectedVersion) throw conflict('STALE_VERSION', 'Someone else changed this project. Reload to see their changes.', { currentVersion: p.version });
      const { expectedVersion: _v, name, buildingUse, areaCode, ...rest } = body;
      const brief = { ...((typeof p.brief === 'string' ? JSON.parse(p.brief) : p.brief) ?? {}), ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) };
      const area = areaCode !== undefined ? (areaCode ? findArea(s.pack, areaCode) : null) : undefined;
      await sql.query(`update projects set name = coalesce($2, name), building_use = case when $3::boolean then $4 else building_use end,
          area_code = case when $5::boolean then $6 else area_code end, region_code = case when $5::boolean then $7 else region_code end,
          brief = $8::jsonb, version = version + 1, updated_at = now() where id = $1`,
        [params.id, name ?? null, buildingUse !== undefined, buildingUse ?? null, area !== undefined, areaCode ?? null, area ? area.region.code : null, JSON.stringify(brief)]);
      return projectSummary(sql, s, await projectRow(sql, params.id), access);
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/archive', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const a = await projectAccess(sql, user, params.id, 'members.manage');
      if (a.role !== 'owner') throw forbidden('Only the project owner can archive it.');
      await sql.query(`update projects set status = 'archived', updated_at = now() where id = $1`, [params.id]);
      await audit(sql, { actorUserId: user.id, action: 'project.archived', targetType: 'Project', targetId: params.id });
      return { status: 'archived' };
    },
  });

  // ---------------------------------------------------------------- members and invitations
  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/members', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const a = await projectAccess(sql, user, params.id, 'members.read');
      const members = await many<Record<string, any>>(sql, `select m.*, u.display_name from project_members m join users u on u.id = m.user_id where m.project_id = $1 order by m.created_at`, [params.id]);
      const invites = can(a.role, 'members.manage') ? await many<Record<string, any>>(sql, `select * from project_invitations where project_id = $1 and status = 'pending' and expires_at > now() order by created_at`, [params.id]) : [];
      return {
        members: members.map((m) => ({ userId: m.user_id, name: m.display_name, role: m.role, you: m.user_id === user.id, since: iso(m.created_at) })),
        invitations: invites.map((i) => ({ id: i.id, phoneMasked: `${i.phone_e164.slice(0, 4)}••••${i.phone_e164.slice(-3)}`, role: i.role, expiresAt: iso(i.expires_at) })),
        grantable: grantableRoles(a.role),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/invitations', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ phone: z.string().min(6).max(24), role: z.enum(['manager', 'collaborator', 'viewer']) }),
    handler: async ({ sql, params, body, user }) => {
      const a = await projectAccess(sql, user, params.id, 'members.manage');
      if (!grantableRoles(a.role).includes(body.role)) throw forbidden(`You can't invite someone as ${body.role}.`);
      const phone = normalizePhone(body.phone, s.pack);
      if (!phone) throw badRequest('INVALID_PHONE', 'Enter a valid mobile number.');
      const existing = await one<{ id: string }>(sql, `select u.id from users u join project_members m on m.user_id = u.id where u.phone_e164 = $1 and m.project_id = $2`, [phone, params.id]);
      if (existing) throw conflict('ALREADY_MEMBER', 'That person is already on this project.');
      const id = uuidv7();
      await sql.query(`insert into project_invitations (id, project_id, phone_e164, role, invited_by, expires_at) values ($1, $2, $3, $4, $5, now() + interval '14 days')`, [id, params.id, phone, body.role, user.id]);
      const p = await projectRow(sql, params.id);
      // The SMS goes out right after commit from the outbox (system context, counted against the daily SMS caps);
      // past a cap the invitation still waits for them when they sign in.
      await publish(sql, 'ProjectInvitationSent', { invitationId: id, projectId: params.id, phone, projectName: p.name });
      await audit(sql, { actorUserId: user.id, action: 'project.invited', targetType: 'Project', targetId: params.id, metadata: { role: body.role } });
      return { id };
    },
  });

  route(app, s, {
    method: 'DELETE', url: '/v1/projects/:id/invitations/:inviteId', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), inviteId: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      await projectAccess(sql, user, params.id, 'members.manage');
      await sql.query(`update project_invitations set status = 'revoked' where id = $1 and project_id = $2 and status = 'pending'`, [params.inviteId, params.id]);
      return { status: 'revoked' };
    },
  });

  // Invitations are addressed to a phone number, so they are looked up in system context and matched to the caller.
  route(app, s, {
    method: 'GET', url: '/v1/me/project-invitations', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql, `select * from my_project_invitations()`);
      void user;
      return { items: rows.map((i) => ({ id: i.id, projectName: i.project_name, role: i.role, invitedBy: i.invited_by_name, expiresAt: iso(i.expires_at) })) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/project-invitations/:id/respond', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ accept: z.boolean() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<{ project_id: string | null }>(sql, `select respond_project_invitation($1, $2) as project_id`, [params.id, body.accept]);
      if (!r?.project_id) throw notFound('Invitation');
      await audit(sql, { actorUserId: user.id, action: body.accept ? 'project.invitation_accepted' : 'project.invitation_declined', targetType: 'Project', targetId: r.project_id });
      return { projectId: body.accept ? r.project_id : null };
    },
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/projects/:id/members/:userId', auth: 'user',
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    body: z.object({ role: z.enum(PROJECT_ROLES) }),
    handler: async ({ sql, params, body, user }) => {
      const a = await projectAccess(sql, user, params.id, 'members.manage');
      const m = await one<{ role: ProjectRole }>(sql, `select role from project_members where project_id = $1 and user_id = $2`, [params.id, params.userId]);
      if (!m) throw notFound('Member');
      if (m.role === 'owner' || m.role === 'reviewer' || !grantableRoles(a.role).includes(body.role) || !grantableRoles(a.role).includes(m.role)) throw forbidden("You can't change this person's role.");
      await sql.query(`update project_members set role = $3 where project_id = $1 and user_id = $2`, [params.id, params.userId, body.role]);
      await publish(sql, 'MembershipChanged', { projectId: params.id, userId: params.userId, role: body.role });
      await audit(sql, { actorUserId: user.id, action: 'project.member_role_changed', targetType: 'Project', targetId: params.id, metadata: { userId: params.userId, from: m.role, to: body.role } });
      return { role: body.role };
    },
  });

  route(app, s, {
    method: 'DELETE', url: '/v1/projects/:id/members/:userId', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const self = params.userId === user.id;
      const a = await projectAccess(sql, user, params.id, self ? 'project.read' : 'members.manage');
      const m = await one<{ role: ProjectRole }>(sql, `select role from project_members where project_id = $1 and user_id = $2`, [params.id, params.userId]);
      if (!m) throw notFound('Member');
      if (m.role === 'owner') throw forbidden('The owner cannot be removed.');
      if (!self && (m.role === 'reviewer' || !grantableRoles(a.role).includes(m.role))) throw forbidden("You can't remove this person.");
      await sql.query(`delete from project_members where project_id = $1 and user_id = $2`, [params.id, params.userId]);
      await publish(sql, 'MembershipChanged', { projectId: params.id, userId: params.userId, role: null });
      await audit(sql, { actorUserId: user.id, action: 'project.member_removed', targetType: 'Project', targetId: params.id, metadata: { userId: params.userId } });
      return { removed: true };
    },
  });

  // ---------------------------------------------------------------- staff access sessions (§7.6)
  route(app, s, {
    method: 'POST', url: '/v1/staff/access-sessions', auth: 'staff', staffRoles: STAFF_ACCESS.projectAccess, systemContext: true,
    body: z.object({ projectId: z.uuid(), reasonCode: z.enum(['support_request', 'verification', 'case_investigation', 'review_assignment', 'security']), ticket: z.string().trim().min(3).max(80) }),
    handler: async ({ sql, body, user }) => {
      const p = await projectRow(sql, body.projectId);
      const id = uuidv7();
      await sql.query(`insert into staff_access_sessions (id, user_id, project_id, reason_code, ticket, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(hours => $6))`,
        [id, user.id, body.projectId, body.reasonCode, body.ticket, s.pack.projects.staffAccessHours]);
      await audit(sql, { actorUserId: user.id, action: 'staff.project_access', targetType: 'Project', targetId: body.projectId, reason: body.reasonCode, metadata: { ticket: body.ticket } });
      const owners = await many<{ user_id: string }>(sql, `select user_id from project_members where project_id = $1 and role = 'owner'`, [p.id]);
      await notify(sql, owners.map((o) => o.user_id), { kind: 'staff_access', title: 'BuildWise staff opened your project', body: `Reason: ${body.reasonCode.replace(/_/g, ' ')} (${body.ticket}). Access ends automatically.`, link: `/projects/${p.id}` });
      return { id, expiresInHours: s.pack.projects.staffAccessHours };
    },
  });
}
