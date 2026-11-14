export interface Money { amountMinor: string; currency: string; display: string }

export interface Line {
  id: string; key: string; position: number; section: string; description: string; specification: string | null; unit: string; originalUnit: string | null;
  gross: string; deductions: string; wastePct: number; net: string;
  rates: Record<'labour' | 'material' | 'plant' | 'logistics' | 'other', string | null>;
  unitRate: string; amount: Money; tax: Money; taxRatePct: number;
  status: 'measured' | 'provisional' | 'excluded' | 'clarification_required';
  quantitySource: 'measurement' | 'client_entered' | 'imported' | 'provisional_sum' | null; measurementIds: string[];
  rateSource: { sourceClass: string; label: string; reference: string; observedAt: string; validUntil: string | null; reconfirmedAt?: string | null } | null;
  rateCategory: 'volatile' | 'general' | 'labour'; catalogItemId: string | null; notes: string | null; rowVersion: number;
}

export interface QaFinding { key: string; code: string; severity: 'warning' | 'blocker'; lineId: string | null; message: string; acknowledged: { reason: string; at: string } | null }

export interface Indicative {
  low: Money; high: Money; perM2: { low: Money; high: Money }; areaM2: string; classLabel: string; contingencyPct: number;
  benchmark: { source: string; observedAt: string; includes: string[]; excludes: string[] }; inputs?: Record<string, unknown>;
}

export interface Totals { net: Money; contingency: Money & { pct: number }; tax: Money & { label: string }; gross: Money; bySection: { code: string; label: string; amount: Money }[]; calculationVersion: string; includesTax: boolean }

export interface Version {
  id: string; estimateId: string; number: number; state: string; maturity: 'indicative' | 'client_specified' | 'reviewed_cost_plan'; label: string; notice: string;
  title: string; currency: string; contingencyPct: number; assumptions: string[]; exclusions: string[]; changeReason: string | null;
  validUntil: string | null; reviewedAt: string | null; issuedAt: string | null; acceptedAt: string | null; reviewer: { name: string } | null; secondReviewDone: boolean;
  snapshotHash: string | null; version: number; indicative: Indicative | null; isCurrent: boolean; lines: Line[]; totals: Totals | null; qa: QaFinding[] | null;
  editable: boolean; yourReviewRole: 'primary' | 'second' | null; commands: string[]; canShare: boolean;
}

export interface Estimate {
  id: string; projectId: string; title: string; maturity: Version['maturity']; role: string; current: Version;
  versions: { id: string; number: number; state: string; gross: Money | null; issuedAt: string | null; createdAt: string }[]; canNewVersion: boolean;
}

export const STATE_LABELS: Record<string, string> = {
  draft: 'Draft', submitted: 'Waiting for a reviewer', under_review: 'Under review', information_required: 'Information needed', changes_requested: 'Changes requested',
  reviewed: 'Reviewed, not yet issued', issued: 'Issued', accepted: 'Accepted (budget baseline)', expired: 'Expired', superseded: 'Superseded', withdrawn: 'Withdrawn',
  generated: 'Current', shared: 'Shared',
};

export const STATUS_LABELS: Record<Line['status'], string> = { measured: 'Measured', provisional: 'Provisional', excluded: 'Excluded', clarification_required: 'Needs clarification' };
export const QSOURCE_LABELS: Record<string, string> = { measurement: 'From drawing measurements', client_entered: 'Entered by client', imported: 'Imported list', provisional_sum: 'Provisional sum' };
export const COMPONENTS = ['material', 'labour', 'plant', 'logistics', 'other'] as const;
export const COMMAND_LABELS: Record<string, string> = {
  submit: 'Request professional review', request_information: 'Ask the client for information', request_changes: 'Ask for changes', resume: 'Resume review',
  complete_review: 'Complete review', issue: 'Issue to client', accept: 'Accept as budget baseline', withdraw: 'Withdraw',
};

export function statePill(state: string) {
  const cls = ['issued', 'accepted', 'shared', 'generated'].includes(state) ? 'pill-good' : ['information_required', 'changes_requested', 'submitted', 'under_review', 'reviewed'].includes(state) ? 'pill-warn' : ['expired', 'withdrawn'].includes(state) ? 'pill-bad' : '';
  return { cls, label: STATE_LABELS[state] ?? state };
}
