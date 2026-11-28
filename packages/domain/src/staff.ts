/**
 * Staff roles and what each may do (spec §7.6, §19.1). This is the one place the API's `route()` and the web's
 * staff navigation read staff permissions from: a staff route names an area and only the roles listed for that
 * area may call it.
 */
export const STAFF_ROLES = ['moderator', 'ops_admin', 'qs_reviewer', 'support'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles an operations admin can grant from the staff screen. */
export const GRANTABLE_STAFF_ROLES = ['moderator', 'ops_admin', 'qs_reviewer'] as const satisfies readonly StaffRole[];
export type GrantableStaffRole = (typeof GRANTABLE_STAFF_ROLES)[number];

export const STAFF_ROLE_LABELS: Record<StaffRole, string> = {
  moderator: 'Moderator',
  ops_admin: 'Operations admin',
  qs_reviewer: 'QS reviewer',
  support: 'Support',
};

export const STAFF_ACCESS = {
  /** Listing queue, reports, restrictions, appeals, held messages and reviews, seller checks, order reviews. */
  moderation: ['moderator', 'ops_admin'],
  /** Trust and safety cases. */
  cases: ['moderator', 'ops_admin', 'support'],
  /** What the build assistant is learning. */
  assistant: ['moderator', 'ops_admin'],
  /** Public-beta feedback and bug reports: triage, close, reopen. */
  feedback: ['moderator', 'ops_admin', 'support'],
  /** Marketplace liquidity and assisted sourcing requests. */
  marketplace: ['moderator', 'ops_admin'],
  /** Estimate review queue, reviewers and rate observations. */
  estimateReview: ['qs_reviewer', 'ops_admin'],
  /** Reason-coded, time-boxed project access (§7.6). */
  projectAccess: ['moderator', 'ops_admin', 'qs_reviewer', 'support'],
  /** The audit log. */
  audit: ['moderator', 'ops_admin', 'qs_reviewer', 'support'],
  /** Categories, catalog, reviewer qualifications and staff roles. */
  admin: ['ops_admin'],
} as const satisfies Record<string, readonly StaffRole[]>;
export type StaffArea = keyof typeof STAFF_ACCESS;

export const isStaffRole = (r: unknown): r is StaffRole => typeof r === 'string' && (STAFF_ROLES as readonly string[]).includes(r);

export function staffCan(role: string | null | undefined, area: StaffArea): boolean {
  return isStaffRole(role) && (STAFF_ACCESS[area] as readonly string[]).includes(role);
}

/** Granting this role needs a second operations admin to approve (dual control, §7.6 "role elevation to admin"). */
export const needsSecondApprover = (role: StaffRole) => role === 'ops_admin';
