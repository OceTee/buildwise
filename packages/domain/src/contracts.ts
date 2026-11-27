import { defineMachine } from './core';
import type { OrderCommand, OrderState } from './procurement';

/**
 * Milestones and variations against an award, last slice of Release 3 (spec §9.5 milestone, §9.6 variation, §10.5
 * step 6–7, §14.1). Every award (a supply order or a tender contract) can carry payment milestones; a priced
 * variation changes scope, cost and time, is proposed by either side and decided by the client, and an approved one
 * creates a new award revision. Payments stay record-only. Values come from `ContractsConfig`.
 */

export interface ContractsConfig {
  maxMilestones: number;
  /** Most days a single variation may add to (or take off) the programme. */
  maxTimeImpactDays: number;
  /** An omission may not take the contract value below this share of the original (guards against typos). */
  minValueSharePct: number;
}
export const DEFAULT_CONTRACTS_CONFIG: ContractsConfig = { maxMilestones: 20, maxTimeImpactDays: 365, minValueSharePct: 10 };

// ---------------------------------------------------------------- milestones (§9.5)
export const MILESTONE_STATES = ['not_started', 'ready', 'in_progress', 'awaiting_client', 'complete', 'blocked', 'disputed', 'cancelled'] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];
export type MilestoneCommand = 'ready' | 'start' | 'claim' | 'accept' | 'reject' | 'block' | 'unblock' | 'dispute' | 'resolve' | 'cancel';
const ACTIVE: MilestoneState[] = ['not_started', 'ready', 'in_progress', 'awaiting_client'];

export const milestoneMachine = defineMachine<MilestoneState, MilestoneCommand>('Milestone', MILESTONE_STATES, [
  { from: ['not_started'], command: 'ready', to: 'ready' },
  { from: ['not_started', 'ready'], command: 'start', to: 'in_progress' },
  // The provider says the milestone is done; only the client confirms it complete.
  { from: ['in_progress'], command: 'claim', to: 'awaiting_client' },
  { from: ['awaiting_client'], command: 'accept', to: 'complete' },
  { from: ['awaiting_client'], command: 'reject', to: 'in_progress' },
  { from: ACTIVE, command: 'block', to: 'blocked' },
  { from: ['blocked'], command: 'unblock', to: 'ready' },
  { from: [...ACTIVE, 'blocked'], command: 'dispute', to: 'disputed' },
  { from: ['disputed'], command: 'resolve', to: 'in_progress' },
  { from: [...ACTIVE, 'blocked', 'disputed'], command: 'cancel', to: 'cancelled' },
]);
export const MILESTONE_ACTOR: Record<MilestoneCommand, 'client' | 'provider' | 'either'> = {
  ready: 'client', start: 'provider', claim: 'provider', accept: 'client', reject: 'client', block: 'either', unblock: 'either', dispute: 'either', resolve: 'client', cancel: 'client',
};
/** Commands that need a reason (kept in the milestone's history). */
export const MILESTONE_NEEDS_REASON: MilestoneCommand[] = ['reject', 'block', 'dispute', 'cancel', 'resolve'];

export interface MilestoneInput { title: string; amountMinor: bigint; dueDate: string | null }
export interface MilestoneRow extends MilestoneInput { id: string; state: MilestoneState; paidMinor: bigint }

export function milestoneProblems(m: MilestoneInput): string[] {
  const p: string[] = [];
  if (m.title.trim().length < 3) p.push('Name the milestone.');
  if (m.amountMinor <= 0n) p.push('Give the milestone an amount.');
  return p;
}

/** Milestones never add up to more than the contract value (original award plus approved variations). */
export function milestoneScheduleProblems(milestones: Pick<MilestoneRow, 'amountMinor' | 'state'>[], contractValueMinor: bigint, cfg: ContractsConfig): string[] {
  const live = milestones.filter((m) => m.state !== 'cancelled');
  const p: string[] = [];
  if (live.length > cfg.maxMilestones) p.push(`At most ${cfg.maxMilestones} milestones.`);
  const total = live.reduce((a, m) => a + m.amountMinor, 0n);
  if (total > contractValueMinor) p.push('The milestones add up to more than the contract value.');
  return p;
}

/** Retention held on a completed milestone: the award's retention share, rounded down to the minor unit. */
export const retentionOf = (amountMinor: bigint, retentionPct: number) => (amountMinor * BigInt(Math.round(retentionPct * 100))) / 10_000n;

/** What can still be recorded as paid against one milestone: complete milestones only, less retention and payments. */
export function milestonePayable(m: Pick<MilestoneRow, 'amountMinor' | 'state' | 'paidMinor'>, retentionPct: number): bigint {
  if (m.state !== 'complete') return 0n;
  const due = m.amountMinor - retentionOf(m.amountMinor, retentionPct) - m.paidMinor;
  return due > 0n ? due : 0n;
}

export interface ScheduleSummary { contractValueMinor: string; scheduledMinor: string; unscheduledMinor: string; completeMinor: string; retentionHeldMinor: string; paidMinor: string; payableMinor: string; complete: number; total: number }

export function scheduleSummary(milestones: MilestoneRow[], contractValueMinor: bigint, retentionPct: number): ScheduleSummary {
  const live = milestones.filter((m) => m.state !== 'cancelled');
  const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);
  const done = live.filter((m) => m.state === 'complete');
  const scheduled = sum(live.map((m) => m.amountMinor));
  return {
    contractValueMinor: String(contractValueMinor), scheduledMinor: String(scheduled), unscheduledMinor: String(contractValueMinor - scheduled > 0n ? contractValueMinor - scheduled : 0n),
    completeMinor: String(sum(done.map((m) => m.amountMinor))), retentionHeldMinor: String(sum(done.map((m) => retentionOf(m.amountMinor, retentionPct)))),
    paidMinor: String(sum(milestones.map((m) => m.paidMinor))), payableMinor: String(sum(done.map((m) => milestonePayable(m, retentionPct)))),
    complete: done.length, total: live.length,
  };
}

/**
 * A tender contract is fulfilled by its milestones, not deliveries: the first completed milestone makes the order
 * partly fulfilled; it is fulfilled when every live milestone is complete and they cover the contract value.
 */
export function contractFulfilmentCommand(order: OrderState, milestones: Pick<MilestoneRow, 'amountMinor' | 'state'>[], contractValueMinor: bigint): OrderCommand | null {
  if (!['confirmed', 'partially_fulfilled'].includes(order)) return null;
  const live = milestones.filter((m) => m.state !== 'cancelled');
  const done = live.filter((m) => m.state === 'complete');
  if (!done.length) return null;
  const covered = live.reduce((a, m) => a + m.amountMinor, 0n) >= contractValueMinor;
  if (covered && done.length === live.length) return 'fulfil';
  return order === 'confirmed' ? 'fulfil_part' : null;
}

/** Why a contract cannot be closed yet. */
export function contractCloseBlockers(order: OrderState, milestones: Pick<MilestoneRow, 'state'>[], openVariations: number): string[] {
  const out: string[] = [];
  if (order !== 'fulfilled') out.push('Every milestone must be complete first.');
  if (milestones.some((m) => ['awaiting_client', 'disputed', 'blocked', 'in_progress'].includes(m.state))) out.push('A milestone is still open.');
  if (openVariations) out.push('Decide the open variations first.');
  return out;
}

// ---------------------------------------------------------------- variations (§9.6)
export const VARIATION_STATES = ['proposed', 'impact_assessed', 'under_review', 'approved', 'rejected', 'withdrawn', 'instructed', 'executed', 'valued'] as const;
export type VariationState = (typeof VARIATION_STATES)[number];
export type VariationCommand = 'assess' | 'submit' | 'return' | 'approve' | 'reject' | 'withdraw' | 'instruct' | 'execute' | 'value';

export const variationMachine = defineMachine<VariationState, VariationCommand>('Variation', VARIATION_STATES, [
  // The provider prices the change (cost and time); a priced proposal can be re-priced before review.
  { from: ['proposed', 'impact_assessed'], command: 'assess', to: 'impact_assessed' },
  { from: ['impact_assessed'], command: 'submit', to: 'under_review' },
  // The client sends it back for a new price (negotiation; every round is kept in the history).
  { from: ['under_review'], command: 'return', to: 'proposed' },
  { from: ['under_review'], command: 'approve', to: 'approved' },
  { from: ['under_review'], command: 'reject', to: 'rejected' },
  { from: ['proposed', 'impact_assessed', 'under_review'], command: 'withdraw', to: 'withdrawn' },
  { from: ['approved'], command: 'instruct', to: 'instructed' },
  { from: ['instructed'], command: 'execute', to: 'executed' },
  { from: ['executed'], command: 'value', to: 'valued' },
]);
/** `proposer` means the side that proposed the variation. */
export const VARIATION_ACTOR: Record<VariationCommand, 'client' | 'provider' | 'either' | 'proposer'> = {
  assess: 'provider', submit: 'either', return: 'client', approve: 'client', reject: 'client', withdraw: 'proposer', instruct: 'client', execute: 'provider', value: 'client',
};
export const OPEN_VARIATION_STATES: readonly VariationState[] = ['proposed', 'impact_assessed', 'under_review'];
export const APPROVED_VARIATION_STATES: readonly VariationState[] = ['approved', 'instructed', 'executed', 'valued'];

export interface VariationLine { description: string; quantity: string; unit: string; rateMinor: bigint }
export interface VariationInput { title: string; description: string; reason: string; costImpactMinor: bigint | null; timeImpactDays: number | null; lines: VariationLine[] }

/** Lines (when given) price the variation: quantity × rate, summed. Omissions carry a negative quantity. */
export function variationLinesTotal(lines: VariationLine[]): bigint {
  let t = 0n;
  for (const l of lines) {
    const [w, f = ''] = l.quantity.replace(/^-/, '').split('.');
    const q = BigInt(w || '0') * 1_000_000n + BigInt((f + '000000').slice(0, 6));
    const v = (q * l.rateMinor) / 1_000_000n;
    t += l.quantity.startsWith('-') ? -v : v;
  }
  return t;
}

export function variationProblems(v: VariationInput, priced: boolean, cfg: ContractsConfig): string[] {
  const p: string[] = [];
  if (v.title.trim().length < 3) p.push('Name the variation.');
  if (v.description.trim().length < 10) p.push('Describe the change in scope.');
  if (v.reason.trim().length < 5) p.push('Say why the change is needed.');
  if (priced) {
    if (v.costImpactMinor == null) p.push('Give the cost impact (use 0 when there is none).');
    if (v.timeImpactDays == null) p.push('Give the time impact in days (use 0 when there is none).');
  }
  if (v.timeImpactDays != null && Math.abs(v.timeImpactDays) > cfg.maxTimeImpactDays) p.push(`The time impact is at most ${cfg.maxTimeImpactDays} days either way.`);
  if (v.lines.length && v.costImpactMinor != null && variationLinesTotal(v.lines) !== v.costImpactMinor) p.push('The cost impact must equal the total of the lines.');
  for (const l of v.lines) if (!/^-?\d+(\.\d{1,6})?$/.test(l.quantity) || l.rateMinor < 0n || l.description.trim().length < 2) { p.push('Check the variation lines.'); break; }
  return p;
}

export interface AwardRevision { number: number; valueMinor: bigint; timeDays: number; completionDate: string | null; variationId: string | null; reason: string }

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

/** The revision an approved variation creates: value and programme move by its impacts (§9.6). */
export function nextRevision(prev: AwardRevision, v: { id: string; title: string; costImpactMinor: bigint; timeImpactDays: number }): AwardRevision {
  return {
    number: prev.number + 1, valueMinor: prev.valueMinor + v.costImpactMinor, timeDays: prev.timeDays + v.timeImpactDays,
    completionDate: prev.completionDate ? addDays(prev.completionDate, v.timeImpactDays) : null, variationId: v.id, reason: `Variation approved: ${v.title}`,
  };
}

/** Why the client cannot approve a variation now. */
export function approvalBlockers(order: OrderState, current: AwardRevision, original: bigint, v: { costImpactMinor: bigint | null; timeImpactDays: number | null }, cfg: ContractsConfig): string[] {
  const out: string[] = [];
  if (['cancelled', 'closed'].includes(order)) out.push('This award is no longer active.');
  if (order === 'placed') out.push('The provider has not confirmed the award yet.');
  if (v.costImpactMinor == null || v.timeImpactDays == null) out.push('The variation is not priced yet.');
  else if (current.valueMinor + v.costImpactMinor < (original * BigInt(cfg.minValueSharePct)) / 100n) out.push(`An omission cannot take the contract below ${cfg.minValueSharePct}% of its original value.`);
  return out;
}
