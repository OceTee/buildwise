import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  listEntryProblems, relatedGroups, SOURCING_MODE_LABELS, SUPPLIER_LIST_KINDS, SUPPLIER_LIST_LABELS, uuidv7,
  type ConflictFacts, type ProviderCandidate, type SourcingPolicy, type SupplierListEntry, type SupplierListKind,
} from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, unprocessable } from '../platform/platform.js';
import { projectAccess } from './projects.js';

/**
 * Client supplier lists (spec §13.1.5): preferred, blocked, approved (framework) and declared conflicts of interest,
 * kept by the project's owner organization and applied to every RFQ and tender it runs. Entries are never edited;
 * they are removed with a reason and a new one added, so every sourcing decision stays traceable.
 */

type Row = Record<string, any>;
const day = (v: unknown) => (v ? String(iso(v)).slice(0, 10) : null);

export async function listEntries(sql: Sql, ownerOrgId: string): Promise<SupplierListEntry[]> {
  return (await many<Row>(sql, `select * from supplier_lists where owner_org_id = $1 and removed_at is null`, [ownerOrgId])).map((r) => ({
    id: r.id, providerOrgId: r.provider_org_id, kind: r.kind, categorySlugs: r.category_slugs ?? [], validFrom: day(r.valid_from), validUntil: day(r.valid_until), reason: r.reason,
  }));
}

/**
 * Everything the sourcing screen needs for one RFQ: the owner organization's lists, the suppliers it named, and the
 * conflict-of-interest facts for each candidate (project team members who belong to the provider, a provider member
 * who reviewed the source estimate, candidates that share a member).
 */
export async function clientPolicy(sql: Sql, rfq: Row, candidates: Pick<ProviderCandidate, 'orgId' | 'name'>[], deadline: string): Promise<SourcingPolicy> {
  const p = (await one<{ owner_org_id: string }>(sql, `select owner_org_id from projects where id = $1`, [rfq.project_id]))!;
  const orgIds = candidates.map((c) => c.orgId);
  const members = orgIds.length ? await many<{ org_id: string; user_id: string }>(sql, `select org_id, user_id from org_members where org_id = any($1::uuid[]) and role in ('owner', 'admin', 'member')`, [orgIds]) : [];
  const team = await many<{ user_id: string; display_name: string }>(sql, `select m.user_id, u.display_name from project_members m join users u on u.id = m.user_id where m.project_id = $1`, [rfq.project_id]);
  const reviewers = rfq.source_estimate_version_id
    ? (await many<{ reviewer_user_id: string }>(sql, `select reviewer_user_id from review_assignments where version_id = $1`, [rfq.source_estimate_version_id])).map((r) => r.reviewer_user_id)
    : [];
  const related = relatedGroups(members.map((m) => ({ orgId: m.org_id, userId: m.user_id })));
  const name = new Map(candidates.map((c) => [c.orgId, c.name]));
  const conflicts: Record<string, ConflictFacts> = {};
  for (const id of orgIds) {
    const mine = new Set(members.filter((m) => m.org_id === id).map((m) => m.user_id));
    conflicts[id] = {
      // The project owner's own organizations are already excluded by the own-organization rule.
      sharedMembers: team.filter((t) => mine.has(t.user_id)).map((t) => t.display_name),
      reviewedSourceEstimate: reviewers.some((r) => mine.has(r)),
      relatedTo: (related.get(id) ?? []).map((o) => name.get(o) ?? 'another candidate'),
    };
  }
  return { mode: rfq.sourcing_mode, categorySlug: rfq.category_slug, deadline, lists: await listEntries(sql, p.owner_org_id), nominated: rfq.nominated_org_ids ?? [], conflicts };
}

export function registerSupplierLists(app: FastifyInstance, s: Services) {
  const cfg = s.pack.sourcing;

  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/supplier-lists', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const a = await projectAccess(sql, user, params.id, 'rfq.read');
      const p = (await one<Row>(sql, `select p.owner_org_id, o.name from projects p join organizations o on o.id = p.owner_org_id where p.id = $1`, [params.id]))!;
      const rows = await many<Row>(sql, `select l.*, o.name as provider_name, o.handle, u.display_name as created_by_name from supplier_lists l join organizations o on o.id = l.provider_org_id join users u on u.id = l.created_by
        where l.owner_org_id = $1 and l.removed_at is null order by l.kind, o.name`, [p.owner_org_id]);
      return {
        owner: { orgId: p.owner_org_id, name: p.name },
        canManage: !a.viaStaffSession && ['owner', 'manager'].includes(a.role),
        kinds: SUPPLIER_LIST_KINDS.map((k) => ({ code: k, ...SUPPLIER_LIST_LABELS[k] })),
        sourcingModes: Object.entries(SOURCING_MODE_LABELS).map(([code, v]) => ({ code, ...v })),
        items: rows.map((r) => ({
          id: r.id, kind: r.kind as SupplierListKind, kindLabel: SUPPLIER_LIST_LABELS[r.kind as SupplierListKind].label, provider: { orgId: r.provider_org_id, name: r.provider_name, handle: r.handle },
          categorySlugs: r.category_slugs ?? [], validFrom: day(r.valid_from), validUntil: day(r.valid_until), reason: r.reason, addedBy: r.created_by_name, addedAt: iso(r.created_at),
        })),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/supplier-lists', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({
      handle: z.string().trim().min(2).max(80), kind: z.enum(SUPPLIER_LIST_KINDS as [SupplierListKind, ...SupplierListKind[]]),
      categorySlugs: z.array(z.string().max(60)).max(20).default([]), validFrom: z.iso.date().optional(), validUntil: z.iso.date().optional(), reason: z.string().trim().max(500).optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const a = await projectAccess(sql, user, params.id, 'suppliers.manage');
      if (a.viaStaffSession) throw forbidden();
      const p = (await one<{ owner_org_id: string }>(sql, `select owner_org_id from projects where id = $1`, [params.id]))!;
      const org = await one<Row>(sql, `select id, name from organizations where handle = $1`, [body.handle.replace(/^@/, '')]);
      if (!org) throw badRequest('VALIDATION_FAILED', 'No supplier has that handle.', [{ path: 'handle', message: 'Use the handle from the supplier’s profile page.' }]);
      if (org.id === p.owner_org_id) throw unprocessable('OWN_ORGANIZATION', 'Your own organization cannot go on your supplier lists.');
      for (const c of body.categorySlugs) if (!(await one(sql, `select 1 from categories where slug = $1`, [c]))) throw badRequest('VALIDATION_FAILED', 'Unknown category.', [{ path: 'categorySlugs', message: `Unknown category ${c}.` }]);
      const t = new Date().toISOString().slice(0, 10);
      const validUntil = body.validUntil ?? (body.kind === 'approved' ? new Date(Date.now() + cfg.approvedDefaultMonths * 30.44 * 86_400_000).toISOString().slice(0, 10) : null);
      const entry = { kind: body.kind, reason: body.reason ?? null, validFrom: body.validFrom ?? null, validUntil, categorySlugs: body.categorySlugs };
      const problems = listEntryProblems(entry, t);
      if (problems.length) throw unprocessable('LIST_ENTRY_INVALID', problems[0]!, { problems });
      const count = (await one<{ n: number }>(sql, `select count(*)::int as n from supplier_lists where owner_org_id = $1 and removed_at is null`, [p.owner_org_id]))!.n;
      if (count >= cfg.maxListEntries) throw conflict('TOO_MANY_ENTRIES', `Your lists can hold ${cfg.maxListEntries} entries.`);
      const clash = await many<Row>(sql, `select kind from supplier_lists where owner_org_id = $1 and provider_org_id = $2 and removed_at is null`, [p.owner_org_id, org.id]);
      if (clash.some((c) => c.kind === body.kind)) throw conflict('ALREADY_LISTED', `${org.name} is already on that list. Remove the entry first to change it.`);
      const positive = ['preferred', 'approved'];
      if (clash.some((c) => (positive.includes(body.kind) ? !positive.includes(c.kind) : positive.includes(c.kind)))) {
        throw conflict('LIST_CLASH', `${org.name} is on a list that contradicts this one. Remove that entry first.`);
      }
      const id = uuidv7();
      await sql.query(`insert into supplier_lists (id, owner_org_id, provider_org_id, kind, category_slugs, valid_from, valid_until, reason, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, p.owner_org_id, org.id, body.kind, body.categorySlugs, body.validFrom ?? null, validUntil, body.reason ?? null, user.id]);
      await audit(sql, { actorUserId: user.id, action: `supplier_list.${body.kind}_added`, targetType: 'Organization', targetId: org.id, reason: body.reason ?? null, metadata: { ownerOrgId: p.owner_org_id, entryId: id, categorySlugs: body.categorySlugs, validUntil } });
      return { id };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/supplier-lists/:id/remove', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ projectId: z.uuid(), reason: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const a = await projectAccess(sql, user, body.projectId, 'suppliers.manage');
      if (a.viaStaffSession) throw forbidden();
      const e = await one<Row>(sql, `select l.* from supplier_lists l join projects p on p.owner_org_id = l.owner_org_id where l.id = $1 and p.id = $2 and l.removed_at is null`, [params.id, body.projectId]);
      if (!e) throw notFound('List entry');
      await sql.query(`update supplier_lists set removed_at = now(), removed_by = $2, removed_reason = $3 where id = $1`, [e.id, user.id, body.reason]);
      await audit(sql, { actorUserId: user.id, action: `supplier_list.${e.kind}_removed`, targetType: 'Organization', targetId: e.provider_org_id, reason: body.reason, metadata: { entryId: e.id } });
      return { removed: true };
    },
  });
}
