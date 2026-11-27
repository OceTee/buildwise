import { defineMachine } from './core';
import type { DiscrepancyKind } from './fulfilment';

/**
 * Trust and safety cases, Release 3 third slice (spec §9.10, §13.3). A contested delivery discrepancy or a disputed
 * order becomes a case with a type, a severity (S1–S4) and an initial response target, evidence, a communication
 * log, a decision, and one appeal decided by a different staff member. Safety cases (S1) skip the triage queue and
 * page the on-call safety owner; the person who raised it sees the local emergency message at once. Staff never give
 * engineering diagnoses: they route to emergency services or building-control professionals.
 * Values come from `CasesConfig` in the market pack.
 */

// ---------------------------------------------------------------- configuration (market pack, [Proposed])
export const SEVERITIES = ['S1', 'S2', 'S3', 'S4'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface CasesConfig {
  /** Initial response targets (§13.3 [Proposed]): S1 1 h 24/7, S2 4 business hours, S3 1 business day, S4 3 business days. */
  responseTargets: Record<Severity, { minutes: number; businessHours: boolean }>;
  /** Business hours for response targets, in local time (a fixed UTC offset keeps the rule pure and deterministic). */
  businessHours: { utcOffsetMinutes: number; days: number[]; start: string; end: string };
  /** A party may appeal a decision once, within this many days. Then the decision becomes final. */
  appealWindowDays: number;
  /** A party asked for information is reminded once after this long. */
  partyReminderHours: number;
  /** Shown at once to whoever raises a safety case (jurisdiction pack). */
  emergencyMessage: string;
  /** Staff role paged for safety (S1) cases: the on-call safety owner. */
  safetyOwnerRole: string;
}

export const DEFAULT_CASES_CONFIG: CasesConfig = {
  responseTargets: {
    S1: { minutes: 60, businessHours: false },
    S2: { minutes: 4 * 60, businessHours: true },
    // A business day is the business-hours span below (08:00 to 17:00, 9 hours).
    S3: { minutes: 9 * 60, businessHours: true },
    S4: { minutes: 3 * 9 * 60, businessHours: true },
  },
  businessHours: { utcOffsetMinutes: 60, days: [1, 2, 3, 4, 5], start: '08:00', end: '17:00' },
  appealWindowDays: 14,
  partyReminderHours: 48,
  emergencyMessage: 'If anyone is hurt or in danger, or a structure may collapse, leave the area and call 112 (emergency services) now. Then tell your local building control office. BuildWise cannot assess structural safety.',
  safetyOwnerRole: 'ops_admin',
};

// ---------------------------------------------------------------- types (§13.3)
export const CASE_TYPES = {
  identity_fraud: { label: 'Identity fraud', severity: 'S2' },
  substandard_product: { label: 'Counterfeit, substandard or wrong product', severity: 'S3' },
  non_delivery: { label: 'Non-delivery or short delivery', severity: 'S3' },
  damage: { label: 'Damaged goods or property', severity: 'S3' },
  unsafe_work: { label: 'Unsafe work or product (safety)', severity: 'S1' },
  workmanship_defect: { label: 'Workmanship or defect', severity: 'S3' },
  non_payment: { label: 'Non-payment', severity: 'S3' },
  harassment: { label: 'Harassment', severity: 'S2' },
  platform_abuse: { label: 'Platform abuse', severity: 'S4' },
  review_manipulation: { label: 'Review manipulation', severity: 'S4' },
  data_privacy: { label: 'Data or privacy incident', severity: 'S2' },
} as const satisfies Record<string, { label: string; severity: Severity }>;
export type CaseType = keyof typeof CASE_TYPES;
export const CASE_TYPE_KEYS = Object.keys(CASE_TYPES) as CaseType[];
export const caseTypeLabel = (t: CaseType) => CASE_TYPES[t]?.label ?? t;
export const defaultSeverity = (t: CaseType): Severity => CASE_TYPES[t]?.severity ?? 'S3';
export const isSafetyCase = (t: CaseType, severity?: Severity) => t === 'unsafe_work' || severity === 'S1';

export const SEVERITY_LABEL: Record<Severity, string> = { S1: 'S1 · Safety', S2: 'S2 · High', S3: 'S3 · Standard', S4: 'S4 · Low' };

/** The case a contested discrepancy opens as. Staff can reclassify it at triage. */
export function caseTypeForDiscrepancy(kind: DiscrepancyKind): CaseType {
  if (kind === 'shortage') return 'non_delivery';
  if (kind === 'damaged') return 'damage';
  return 'substandard_product';
}

export const CASE_SOURCES = ['discrepancy', 'order'] as const;
export type CaseSource = (typeof CASE_SOURCES)[number];

// ---------------------------------------------------------------- state machine (§9.10)
export const CASE_STATES = ['open', 'triaged', 'awaiting_party', 'under_investigation', 'proposed_resolution', 'resolved', 'appealed', 'under_appeal_review', 'final'] as const;
export type CaseState = (typeof CASE_STATES)[number];
export type CaseCommand = 'triage' | 'request_info' | 'party_reply' | 'investigate' | 'propose' | 'revise' | 'decide' | 'appeal' | 'take_appeal' | 'decide_appeal' | 'close';

export const caseMachine = defineMachine<CaseState, CaseCommand>('Case', CASE_STATES, [
  { from: ['open'], command: 'triage', to: 'triaged' },
  { from: ['triaged', 'under_investigation', 'proposed_resolution'], command: 'request_info', to: 'awaiting_party' },
  // The awaited party answers: the case goes back to the investigator.
  { from: ['awaiting_party'], command: 'party_reply', to: 'under_investigation' },
  { from: ['triaged', 'awaiting_party'], command: 'investigate', to: 'under_investigation' },
  { from: ['triaged', 'under_investigation'], command: 'propose', to: 'proposed_resolution' },
  // A party objects to the proposal with something new: back to investigation.
  { from: ['proposed_resolution'], command: 'revise', to: 'under_investigation' },
  { from: ['proposed_resolution'], command: 'decide', to: 'resolved' },
  { from: ['resolved'], command: 'appeal', to: 'appealed' },
  { from: ['appealed'], command: 'take_appeal', to: 'under_appeal_review' },
  { from: ['under_appeal_review'], command: 'decide_appeal', to: 'final' },
  // No appeal within the window: the decision is final.
  { from: ['resolved'], command: 'close', to: 'final' },
]);

export type CaseActor = 'staff' | 'party' | 'system' | 'staff_or_system';
export const CASE_ACTOR: Record<CaseCommand, CaseActor> = {
  triage: 'staff_or_system', request_info: 'staff', party_reply: 'system', investigate: 'staff', propose: 'staff', revise: 'staff',
  decide: 'staff', appeal: 'party', take_appeal: 'staff', decide_appeal: 'staff', close: 'system',
};
/** Commands a staff member runs from the case page (the others happen through party messages, appeals or the worker). */
export const STAFF_CASE_COMMANDS: readonly CaseCommand[] = ['triage', 'request_info', 'investigate', 'propose', 'revise', 'decide', 'take_appeal', 'decide_appeal'];
export const OPEN_CASE_STATES: readonly CaseState[] = ['open', 'triaged', 'awaiting_party', 'under_investigation', 'proposed_resolution'];
export const CASE_STATE_LABEL: Record<CaseState, string> = {
  open: 'Waiting for triage', triaged: 'Triaged', awaiting_party: 'Waiting for a reply', under_investigation: 'Under investigation',
  proposed_resolution: 'Resolution proposed', resolved: 'Decided', appealed: 'Appealed', under_appeal_review: 'Appeal under review', final: 'Final',
};

export const CASE_OUTCOMES = {
  client_upheld: "Upheld in the client's favour",
  provider_upheld: "Upheld in the supplier's favour",
  shared: 'Shared responsibility',
  no_finding: 'No finding: not enough evidence either way',
  referred: 'Referred to emergency services or building control',
} as const;
export type CaseOutcome = keyof typeof CASE_OUTCOMES;
export const CASE_OUTCOME_KEYS = Object.keys(CASE_OUTCOMES) as CaseOutcome[];
export type AppealOutcome = 'upheld' | 'overturned';

export type CaseSide = 'client' | 'provider';

// ---------------------------------------------------------------- response targets (§13.3)
const toMin = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h! * 60 + (m ?? 0); };

/**
 * When the first staff response is due. S1 runs on the clock (24/7); the others count only business minutes in the
 * market's local time.
 */
export function responseDueAt(openedAt: Date, severity: Severity, cfg: Pick<CasesConfig, 'responseTargets' | 'businessHours'>): Date {
  const t = cfg.responseTargets[severity];
  if (!t.businessHours) return new Date(openedAt.getTime() + t.minutes * 60_000);
  const bh = cfg.businessHours;
  const off = bh.utcOffsetMinutes * 60_000;
  const start = toMin(bh.start); const end = toMin(bh.end);
  if (end <= start || !bh.days.length) return new Date(openedAt.getTime() + t.minutes * 60_000);
  // Work in "local" milliseconds (UTC shifted by the offset) so getUTC* gives local fields.
  let local = openedAt.getTime() + off;
  let left = t.minutes;
  for (let guard = 0; guard < 3700 && left > 0; guard++) {
    const d = new Date(local);
    const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const minute = Math.floor((local - dayStart) / 60_000);
    if (!bh.days.includes(d.getUTCDay()) || minute >= end) { local = dayStart + 86_400_000 + start * 60_000; continue; }
    if (minute < start) { local = dayStart + start * 60_000; continue; }
    const avail = end - minute;
    if (left <= avail) { local += left * 60_000; left = 0; break; }
    left -= avail;
    local = dayStart + 86_400_000 + start * 60_000;
  }
  return new Date(local - off);
}

export interface CaseTimes {
  state: CaseState;
  severity: Severity;
  openedAt: string;
  responseDueAt: string | null;
  firstResponseAt: string | null;
  decidedAt: string | null;
  appealedAt: string | null;
}

/** Where a case stands against its targets, for the staff queue and the parties' view. */
export function caseClock(c: CaseTimes, now: Date, cfg: Pick<CasesConfig, 'appealWindowDays'>) {
  const due = c.responseDueAt ? new Date(c.responseDueAt) : null;
  const responded = c.firstResponseAt ? new Date(c.firstResponseAt) : null;
  const responseOverdue = !!due && !responded && now > due;
  const respondedLate = !!due && !!responded && responded > due;
  const appealOpenUntil = c.decidedAt ? new Date(new Date(c.decidedAt).getTime() + cfg.appealWindowDays * 86_400_000) : null;
  const appealOpen = c.state === 'resolved' && !c.appealedAt && !!appealOpenUntil && now <= appealOpenUntil;
  return { responseOverdue, respondedLate, responded: !!responded, appealOpenUntil: appealOpenUntil?.toISOString() ?? null, appealOpen };
}

/** Why a party cannot appeal now; empty means they can. One appeal per case (§13.3). */
export function appealProblems(c: CaseTimes & { appealedBy: string | null }, isParty: boolean, now: Date, cfg: Pick<CasesConfig, 'appealWindowDays'>): string[] {
  if (!isParty) return ['Only the client or the supplier on this order can appeal.'];
  if (c.appealedAt || c.appealedBy) return ['This decision has already been appealed. Each case can be appealed once.'];
  if (c.state !== 'resolved') return [c.state === 'final' ? 'This decision is final.' : 'There is no decision to appeal yet.'];
  const { appealOpen } = caseClock(c, now, cfg);
  if (!appealOpen) return [`Appeals must be made within ${cfg.appealWindowDays} days of the decision.`];
  return [];
}

/**
 * Independent review: whoever decided the case can never take or decide its appeal. Returns the reason a staff
 * member may not run the command, or null.
 */
export function staffConflict(command: CaseCommand, staffId: string, c: { decidedBy: string | null; appealReviewer: string | null }): string | null {
  if ((command === 'take_appeal' || command === 'decide_appeal') && c.decidedBy === staffId) return 'You decided this case, so a different staff member must review the appeal.';
  if (command === 'decide_appeal' && c.appealReviewer && c.appealReviewer !== staffId) return 'Another staff member has taken this appeal.';
  return null;
}

/** Staff queue order: safety first, then overdue responses, then the soonest due, then the oldest. */
export function caseQueueOrder<T extends CaseTimes & { id: string }>(cases: T[], now: Date): T[] {
  const rank = (c: T) => SEVERITIES.indexOf(c.severity);
  const overdue = (c: T) => (c.responseDueAt && !c.firstResponseAt && new Date(c.responseDueAt) < now ? 0 : 1);
  const due = (c: T) => (c.responseDueAt && !c.firstResponseAt ? new Date(c.responseDueAt).getTime() : Number.MAX_SAFE_INTEGER);
  return [...cases].sort((a, b) => rank(a) - rank(b) || overdue(a) - overdue(b) || due(a) - due(b) || a.openedAt.localeCompare(b.openedAt) || a.id.localeCompare(b.id));
}

/** The decision that stands: the appeal's when it overturned the original. */
export function standingOutcome(c: { outcome: CaseOutcome | null; appealOutcome: AppealOutcome | null; appealNewOutcome: CaseOutcome | null }): CaseOutcome | null {
  return c.appealOutcome === 'overturned' && c.appealNewOutcome ? c.appealNewOutcome : c.outcome;
}
