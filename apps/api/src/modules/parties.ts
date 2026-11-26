import { can } from '@bw/domain';
import { many, one, type Sql } from '../db/database.js';
import type { Actor } from '../http/route.js';
import { forbidden, notFound } from '../platform/platform.js';
import { projectAccess, type ProjectAccess } from './projects.js';

/** Who acts on a procurement object: the client's project members or the provider organization (R3). */

type Row = Record<string, any>;

/** The orgs the user acts for as a provider (owner, admin or member). */
export async function myOrgIds(sql: Sql, user: Actor): Promise<string[]> {
  return (await many<{ org_id: string }>(sql, `select org_id from org_members where user_id = $1 and role in ('owner', 'admin', 'member')`, [user.id])).map((r) => r.org_id);
}

export async function providerOrg(sql: Sql, user: Actor, orgId: string) {
  if (!(await myOrgIds(sql, user)).includes(orgId)) throw forbidden('You do not act for this business.');
}

export async function orgUsers(sql: Sql, orgId: string) {
  return (await many<{ user_id: string }>(sql, `select user_id from org_members where org_id = $1 and role in ('owner', 'admin', 'member')`, [orgId])).map((r) => r.user_id);
}

export type OrderSide =
  | { o: Row; side: 'client'; access: ProjectAccess; canManage: boolean; canApprove: boolean }
  | { o: Row; side: 'provider'; access: null; canManage: false; canApprove: false };

/** A member of the order's project (client side), or a member of the awarded organization. Anyone else gets a 404. */
export async function orderSide(sql: Sql, user: Actor, id: string): Promise<OrderSide> {
  const o = await one<Row>(sql, `select * from orders where id = $1`, [id]);
  if (!o) throw notFound('Order');
  const isMember = await one(sql, `select 1 from project_members where project_id = $1 and user_id = $2`, [o.project_id, user.id]);
  if (isMember || user.isStaff) {
    try {
      const access = await projectAccess(sql, user, o.project_id, 'rfq.read');
      const live = !access.viaStaffSession;
      return { o, side: 'client', access, canManage: live && can(access.role, 'order.manage'), canApprove: live && can(access.role, 'invoice.approve') };
    } catch { /* provider? */ }
  }
  if ((await myOrgIds(sql, user)).includes(o.provider_org_id)) return { o, side: 'provider', access: null, canManage: false, canApprove: false };
  throw notFound('Order');
}
