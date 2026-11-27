import type { MarketPack } from './market';

/**
 * Projects, intake, readiness, roles and indicative ranges (spec §7, §10.1; MVP spec §4.1, §4.3).
 * Everything market- or class-specific lives in `ProjectConfig` inside the market pack; values there are
 * [Proposed] and illustrative until validated in R0.
 */

export interface ProjectClassDef { code: string; label: string; maxFloors: number; enabled: boolean; requiresStructuralBeyondFloors?: number }
export interface Benchmark {
  classCode: string; regionCode: string; finishBand: string;
  lowPerM2Minor: number; highPerM2Minor: number; observedAt: string; source: string;
  includes: string[]; excludes: string[];
}
export interface WorkSection { code: string; label: string }

export interface ProjectConfig {
  classes: ProjectClassDef[];
  buildingUses: { code: string; label: string; classCodes: string[] }[];
  finishBands: { code: string; label: string }[];
  designStages: { code: string; label: string; measurable: boolean }[];
  siteStatuses: { code: string; label: string }[];
  disciplines: { code: string; label: string }[];
  documentTypes: { code: string; label: string }[];
  /** Status labels are attributed to whoever set them (§10.2). */
  documentStatuses: { code: string; label: string }[];
  benchmarks: Benchmark[];
  benchmarkMaxAgeDays: number;
  /** Contingency added to the indicative range, and shown as such. */
  indicativeContingencyPct: number;
  workSections: WorkSection[];
  /** Rate freshness by rate category (§11.3). */
  rateFreshnessDays: { volatile: number; general: number; labour: number };
  estimateValidityDays: number;
  review: { secondReviewAboveMinor: number; largeDeltaPct: number; minContingencyPct: number };
  /** Calibration: tolerance between the main and the check dimension (§11.2). */
  calibrationTolerancePct: number;
  maxUploadBytes: number;
  maxPdfPages: number;
  staffAccessHours: number;
}

// ---------------------------------------------------------------- roles and policy (§7.2, §7.5)
export const PROJECT_ROLES = ['owner', 'manager', 'collaborator', 'viewer', 'reviewer'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export type ProjectAction =
  | 'project.read' | 'project.edit' | 'members.read' | 'members.manage'
  | 'documents.read' | 'documents.upload' | 'documents.set_status'
  | 'rfi.read' | 'rfi.create' | 'rfi.respond'
  | 'estimate.read' | 'estimate.edit_client' | 'estimate.request_review' | 'estimate.accept' | 'estimate.review'
  | 'payments.read' | 'payments.record'
  | 'rfq.read' | 'rfq.manage' | 'rfq.award'
  // R3 fulfilment: book deliveries, record proof of delivery, inspect, return; approve invoice variances (§10.4 steps 8–9).
  | 'order.manage' | 'invoice.approve';

const MATRIX: Record<ProjectRole, ProjectAction[]> = {
  owner: ['project.read', 'project.edit', 'members.read', 'members.manage', 'documents.read', 'documents.upload', 'documents.set_status', 'rfi.read', 'rfi.create', 'rfi.respond', 'estimate.read', 'estimate.edit_client', 'estimate.request_review', 'estimate.accept', 'payments.read', 'payments.record', 'rfq.read', 'rfq.manage', 'rfq.award', 'order.manage', 'invoice.approve'],
  manager: ['project.read', 'project.edit', 'members.read', 'members.manage', 'documents.read', 'documents.upload', 'documents.set_status', 'rfi.read', 'rfi.create', 'rfi.respond', 'estimate.read', 'estimate.edit_client', 'estimate.request_review', 'payments.read', 'payments.record', 'rfq.read', 'rfq.manage', 'order.manage'],
  collaborator: ['project.read', 'members.read', 'documents.read', 'documents.upload', 'rfi.read', 'rfi.create', 'rfi.respond', 'estimate.read', 'estimate.edit_client', 'payments.read', 'rfq.read'],
  viewer: ['project.read', 'members.read', 'documents.read', 'rfi.read', 'estimate.read', 'rfq.read'],
  // Reviewers see the documents and estimate scope they need, not payments or membership management (§7.3).
  reviewer: ['project.read', 'documents.read', 'rfi.read', 'rfi.create', 'rfi.respond', 'estimate.read', 'estimate.review', 'rfq.read'],
};

/** The central policy decision point for project resources. Callers return 404 on false (§7.5). */
export function can(role: ProjectRole | null | undefined, action: ProjectAction): boolean {
  return !!role && MATRIX[role].includes(action);
}
export const roleActions = (role: ProjectRole) => [...MATRIX[role]];
/** Roles a member with `members.manage` may grant. Only the owner can make another manager. */
export function grantableRoles(by: ProjectRole): ProjectRole[] {
  if (by === 'owner') return ['manager', 'collaborator', 'viewer'];
  if (by === 'manager') return ['collaborator', 'viewer'];
  return [];
}

// ---------------------------------------------------------------- intake (§10.1, MVP §10 "Project intake")
export interface Brief {
  name?: string | null;
  buildingUse?: string | null;
  classCode?: string | null;
  regionCode?: string | null;
  areaCode?: string | null;
  floors?: number | null;
  grossFloorAreaM2?: string | null;     // decimal string
  finishBand?: string | null;
  siteStatus?: string | null;
  designStage?: string | null;
  hasSurvey?: boolean | null;
  hasGeotechnical?: boolean | null;
  targetStart?: string | null;
  budgetMinor?: string | null;
  constraints?: string | null;
}

/** Fields still missing, in the order the client should answer them. "Not sure" answers count as missing but are allowed. */
export function intakeMissing(b: Brief): { field: keyof Brief; label: string; requiredFor: 'project' | 'indicative' | 'review' }[] {
  const out: { field: keyof Brief; label: string; requiredFor: 'project' | 'indicative' | 'review' }[] = [];
  const add = (field: keyof Brief, label: string, requiredFor: 'project' | 'indicative' | 'review') => out.push({ field, label, requiredFor });
  if (!b.name) add('name', 'Project name', 'project');
  if (!b.buildingUse) add('buildingUse', 'Building use', 'project');
  if (!b.areaCode) add('areaCode', 'Location', 'project');
  if (!b.floors) add('floors', 'Number of floors', 'indicative');
  if (!b.grossFloorAreaM2) add('grossFloorAreaM2', 'Approximate floor area', 'indicative');
  if (!b.finishBand) add('finishBand', 'Finish level', 'indicative');
  if (!b.siteStatus) add('siteStatus', 'Site status', 'review');
  if (!b.designStage) add('designStage', 'Design stage', 'review');
  return out;
}

export function classFor(b: Brief, cfg: ProjectConfig): ProjectClassDef | null {
  const use = cfg.buildingUses.find((u) => u.code === b.buildingUse);
  if (!use) return null;
  const floors = b.floors ?? 1;
  return cfg.classes.find((c) => use.classCodes.includes(c.code) && c.enabled && floors <= c.maxFloors) ?? null;
}

export type ReadinessOutcome = 'can_proceed' | 'needs_professional' | 'cannot_estimate';
export interface ReadinessItem { code: string; label: string; status: 'ok' | 'missing' | 'attention'; detail: string }

/**
 * The readiness checklist and its outcome (§10.1 steps 4–5). It never verifies title, permits or engineering;
 * it only says whether an estimate can responsibly be prepared and who should be involved.
 */
export function readiness(b: Brief, docs: { drawingCount: number; disciplines: string[] }, cfg: ProjectConfig): { outcome: ReadinessOutcome; items: ReadinessItem[]; explanation: string } {
  const items: ReadinessItem[] = [];
  const cls = classFor(b, cfg);
  items.push(cls
    ? { code: 'class', label: 'Supported project type', status: 'ok', detail: cls.label }
    : { code: 'class', label: 'Supported project type', status: 'missing', detail: 'This building use or number of floors is not supported yet.' });
  const site = cfg.siteStatuses.find((s) => s.code === b.siteStatus);
  items.push(site ? { code: 'site', label: 'Site status', status: site.code === 'unknown' ? 'attention' : 'ok', detail: site.label } : { code: 'site', label: 'Site status', status: 'missing', detail: 'Tell us whether you have a site and access to it.' });
  const stage = cfg.designStages.find((s) => s.code === b.designStage);
  items.push(stage
    ? { code: 'design', label: 'Design stage', status: stage.measurable ? 'ok' : 'attention', detail: stage.measurable ? stage.label : `${stage.label}: drawings are not yet detailed enough to measure.` }
    : { code: 'design', label: 'Design stage', status: 'missing', detail: 'Tell us how far the design has got.' });
  items.push(docs.drawingCount > 0
    ? { code: 'drawings', label: 'Drawings uploaded', status: 'ok', detail: `${docs.drawingCount} drawing(s)` }
    : { code: 'drawings', label: 'Drawings uploaded', status: 'missing', detail: 'A reviewed estimate needs drawings to measure.' });
  const needsStructural = !!cls?.requiresStructuralBeyondFloors && (b.floors ?? 0) > cls.requiresStructuralBeyondFloors;
  if (needsStructural) {
    const has = docs.disciplines.includes('structural');
    items.push({ code: 'structural', label: 'Structural drawings', status: has ? 'ok' : 'missing', detail: has ? 'Provided' : `Buildings over ${cls!.requiresStructuralBeyondFloors} floor(s) need structural design by a qualified engineer.` });
  }
  items.push(b.hasGeotechnical ? { code: 'ground', label: 'Ground investigation', status: 'ok', detail: 'Available' } : { code: 'ground', label: 'Ground investigation', status: 'attention', detail: 'Foundations are priced as a provisional sum until a ground investigation is available.' });

  let outcome: ReadinessOutcome;
  let explanation: string;
  if (!cls) { outcome = 'cannot_estimate'; explanation = 'We cannot estimate this type of project responsibly yet.'; }
  else if (items.some((i) => i.status === 'missing' && ['design', 'drawings', 'structural'].includes(i.code)) || stage?.measurable === false) {
    outcome = 'needs_professional';
    explanation = 'An indicative range is available, but a reviewed estimate needs measurable drawings. A designer or engineer may need to complete them first.';
  } else { outcome = 'can_proceed'; explanation = 'You can request a professionally reviewed estimate.'; }
  return { outcome, items, explanation };
}

// ---------------------------------------------------------------- indicative range (§10.1 step 3, MVP §4.3)
export type IndicativeResult =
  | { ok: true; lowMinor: bigint; highMinor: bigint; perM2: { lowMinor: number; highMinor: number }; contingencyPct: number; benchmark: Benchmark; areaM2: string; classLabel: string }
  | { ok: false; reason: 'missing_inputs' | 'unsupported_class' | 'not_enough_local_data'; message: string; missing?: string[] };

export function indicativeRange(b: Brief, pack: Pick<MarketPack, 'projects'>, now: Date): IndicativeResult {
  const cfg = pack.projects;
  const missing = intakeMissing(b).filter((m) => m.requiredFor !== 'review').map((m) => m.label);
  if (missing.length) return { ok: false, reason: 'missing_inputs', message: 'Answer these to see a range.', missing };
  const cls = classFor(b, cfg);
  if (!cls) return { ok: false, reason: 'unsupported_class', message: 'We do not have benchmarks for this type of building.' };
  const region = b.regionCode;
  const maxAge = cfg.benchmarkMaxAgeDays * 86_400_000;
  const bm = cfg.benchmarks.find((x) => x.classCode === cls.code && x.regionCode === region && x.finishBand === b.finishBand && now.getTime() - new Date(x.observedAt).getTime() <= maxAge);
  if (!bm) return { ok: false, reason: 'not_enough_local_data', message: 'Not enough local data to give a range for this location and finish level. You can still request a reviewed estimate.' };
  const area = Number(b.grossFloorAreaM2);
  if (!(area > 0)) return { ok: false, reason: 'missing_inputs', message: 'Enter the approximate floor area.', missing: ['Approximate floor area'] };
  const c = 1 + cfg.indicativeContingencyPct / 100;
  // Rounded to a coarse step so the range never looks more precise than it is.
  const step = 100_000n * 100n;
  const round = (v: number) => (BigInt(Math.round(v)) / step) * step;
  return {
    ok: true,
    lowMinor: round(bm.lowPerM2Minor * area),
    highMinor: round(bm.highPerM2Minor * area * c) + step,
    perM2: { lowMinor: bm.lowPerM2Minor, highMinor: bm.highPerM2Minor },
    contingencyPct: cfg.indicativeContingencyPct, benchmark: bm, areaM2: String(area), classLabel: cls.label,
  };
}
