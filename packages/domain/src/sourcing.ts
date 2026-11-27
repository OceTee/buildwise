import type { CandidateScreen, ProviderCandidate, Screen, SourcingMode } from './procurement';

/**
 * Sourcing modes and the client's own supplier lists, last slice of Release 3 (spec §10.4 step 2, §13.1.5, §10.5
 * step 4). Pure rules: which list entries are in force, conflict-of-interest findings beyond "your own
 * organization", and the screen `matchProviders` applies for each mode. Values come from `SourcingConfig`.
 */

export type SupplierListKind = 'preferred' | 'blocked' | 'approved' | 'conflict';
export const SUPPLIER_LIST_KINDS: readonly SupplierListKind[] = ['preferred', 'blocked', 'approved', 'conflict'];

export const SUPPLIER_LIST_LABELS: Record<SupplierListKind, { label: string; help: string }> = {
  preferred: { label: 'Preferred', help: 'Listed first when they are eligible. Never gets a supplier past a required check.' },
  blocked: { label: 'Blocked', help: 'Never invited to your requests or tenders.' },
  approved: { label: 'Approved (framework)', help: 'Your approved suppliers: the only ones invited when a request uses the approved-supplier mode.' },
  conflict: { label: 'Conflict of interest', help: 'A declared relationship (family, ownership, employment). Kept out of your requests and tenders, and recorded.' },
};

export const SOURCING_MODE_LABELS: Record<SourcingMode, { label: string; help: string }> = {
  open: { label: 'Open to every eligible provider', help: 'Every provider that passes the checks for the category and area is invited.' },
  invited: { label: 'Invited providers only', help: 'You choose who to invite from the eligible providers.' },
  framework: { label: 'Approved suppliers only', help: 'Only suppliers on your approved (framework) list for this category are invited.' },
  nominated: { label: 'Suppliers you name', help: 'You name the suppliers. They still need the required checks, and are never on your blocked or conflict lists.' },
};

export type ConflictRule = 'block' | 'warn';
export interface SourcingConfig {
  /** Most entries one client organization may keep across its lists. */
  maxListEntries: number;
  /** Months an approval lasts when the client does not set an end date. */
  approvedDefaultMonths: number;
  /** A project team member who is also a member of the provider. */
  sharedMember: ConflictRule;
  /** The provider employs someone who reviewed the estimate the request is priced from. */
  estimateReviewer: ConflictRule;
  /** Two invited providers share a member (possible related bids). */
  relatedBidders: ConflictRule;
  /** Most suppliers a client can name on one request. */
  maxNominated: number;
}

export const DEFAULT_SOURCING_CONFIG: SourcingConfig = {
  maxListEntries: 200,
  approvedDefaultMonths: 12,
  sharedMember: 'block',
  estimateReviewer: 'block',
  relatedBidders: 'warn',
  maxNominated: 8,
};

export interface SupplierListEntry {
  id: string;
  providerOrgId: string;
  kind: SupplierListKind;
  /** Empty means every category. */
  categorySlugs: string[];
  validFrom: string | null;
  validUntil: string | null;
  reason: string | null;
}

/** Problems that stop a list entry being saved. Blocks and conflicts always carry a reason (they are audited). */
export function listEntryProblems(e: Pick<SupplierListEntry, 'kind' | 'reason' | 'validFrom' | 'validUntil' | 'categorySlugs'>, today: string): string[] {
  const p: string[] = [];
  if ((e.kind === 'blocked' || e.kind === 'conflict') && (!e.reason || e.reason.trim().length < 5)) p.push(e.kind === 'blocked' ? 'Say why this supplier is blocked.' : 'Describe the conflict of interest.');
  if (e.validUntil && e.validUntil < today) p.push('The end date has already passed.');
  if (e.validFrom && e.validUntil && e.validUntil < e.validFrom) p.push('The end date is before the start date.');
  if (e.kind !== 'approved' && e.categorySlugs.length && e.kind !== 'preferred') p.push('Blocks and conflicts apply to every category.');
  return p;
}

/** The entries for a provider that are in force at `at` (a date or ISO time) for a category. */
export function entriesInForce(entries: SupplierListEntry[], orgId: string, categorySlug: string, at: string): SupplierListEntry[] {
  const day = at.slice(0, 10);
  return entries.filter((e) => e.providerOrgId === orgId
    && (!e.categorySlugs.length || e.categorySlugs.includes(categorySlug))
    && (!e.validFrom || e.validFrom <= day) && (!e.validUntil || e.validUntil >= day));
}

/** Facts gathered by the API for each candidate (no names of people leave the client side). */
export interface ConflictFacts {
  /** Project team members (display names) who are also members of the provider. */
  sharedMembers: string[];
  /** A member of the provider reviewed the estimate this request is priced from. */
  reviewedSourceEstimate: boolean;
  /** Other candidates (names) that share a member with this one. */
  relatedTo: string[];
}

export interface Conflict { code: 'own_organization' | 'shared_member' | 'estimate_reviewer' | 'declared' | 'related_bidders'; rule: ConflictRule; message: string }

/** Conflicts of interest beyond "your own organization" (§13.1.5, §10.5 step 4), each with the rule that applies. */
export function conflictsOf(facts: ConflictFacts | undefined, declared: SupplierListEntry[], cfg: SourcingConfig): Conflict[] {
  const out: Conflict[] = [];
  for (const d of declared.filter((e) => e.kind === 'conflict')) out.push({ code: 'declared', rule: 'block', message: `Declared conflict of interest: ${d.reason ?? 'recorded on your list'}.` });
  if (facts?.sharedMembers.length) out.push({ code: 'shared_member', rule: cfg.sharedMember, message: `${facts.sharedMembers.join(', ')} ${facts.sharedMembers.length === 1 ? 'is' : 'are'} on your project team and a member of this provider (conflict of interest).` });
  if (facts?.reviewedSourceEstimate) out.push({ code: 'estimate_reviewer', rule: cfg.estimateReviewer, message: 'A member of this provider reviewed the estimate this request is priced from (conflict of interest).' });
  if (facts?.relatedTo.length) out.push({ code: 'related_bidders', rule: cfg.relatedBidders, message: `Shares a member with ${facts.relatedTo.join(', ')}: their bids may not be independent.` });
  return out;
}

export interface SourcingPolicy {
  mode: SourcingMode;
  categorySlug: string;
  deadline: string;
  lists: SupplierListEntry[];
  /** Suppliers the client named (nominated mode). */
  nominated: string[];
  conflicts: Record<string, ConflictFacts>;
}

/**
 * The screen for one sourcing mode. Hard reasons: blocked, a conflict whose rule is `block`, and, in the
 * approved-supplier mode, no approval in force for the category at the deadline. In the nominated mode only the
 * named suppliers are considered and category/area coverage becomes a warning (the client knows them); required
 * checks and the client's blocks and conflicts still apply. Preferred suppliers are labelled and lead the list.
 */
export function sourcingScreen(policy: SourcingPolicy, cfg: SourcingConfig): Screen {
  return (c: ProviderCandidate): CandidateScreen => {
    const at = policy.deadline;
    const inForce = entriesInForce(policy.lists, c.orgId, policy.categorySlug, at);
    const reasons: string[] = []; const labels: string[] = []; const warnings: string[] = [];
    const blocked = inForce.find((e) => e.kind === 'blocked');
    if (blocked) reasons.push(`On your blocked list: ${blocked.reason ?? 'no reason given'}.`);
    for (const k of conflictsOf(policy.conflicts[c.orgId], inForce, cfg)) (k.rule === 'block' ? reasons : warnings).push(k.message);
    const approved = inForce.find((e) => e.kind === 'approved');
    if (policy.mode === 'framework') {
      if (!approved) {
        const lapsing = policy.lists.find((e) => e.providerOrgId === c.orgId && e.kind === 'approved' && (!e.categorySlugs.length || e.categorySlugs.includes(policy.categorySlug)) && e.validUntil && e.validUntil < at.slice(0, 10));
        reasons.push(lapsing ? 'Your approval of this supplier ends before the deadline.' : 'Not on your approved supplier list for this category.');
      }
    }
    if (policy.mode === 'nominated') {
      if (!policy.nominated.includes(c.orgId)) reasons.push('Not one of the suppliers you named.');
      else labels.push('Named by you');
    }
    if (approved) labels.push(approved.validUntil ? `Approved supplier until ${approved.validUntil}` : 'Approved supplier');
    const preferred = inForce.some((e) => e.kind === 'preferred');
    if (preferred) labels.push('Preferred supplier');
    return { reasons, waiveCoverage: policy.mode === 'nominated' && policy.nominated.includes(c.orgId), labels, warnings, preferred };
  };
}

/** Groups of candidate organizations that share at least one member (for the related-bidders check). */
export function relatedGroups(members: { orgId: string; userId: string }[]): Map<string, string[]> {
  const byUser = new Map<string, Set<string>>();
  for (const m of members) byUser.set(m.userId, (byUser.get(m.userId) ?? new Set()).add(m.orgId));
  const out = new Map<string, string[]>();
  for (const orgs of byUser.values()) {
    if (orgs.size < 2) continue;
    for (const o of orgs) out.set(o, [...new Set([...(out.get(o) ?? []), ...[...orgs].filter((x) => x !== o)])]);
  }
  return out;
}
