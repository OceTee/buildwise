import type { CheckType, ComparisonColumn, QuoteState } from './procurement';

/**
 * Sealed tenders for trade packages, last slice of Release 3 (spec §10.5, §19.2, D-14). A tender is an RFQ of
 * kind `tender` (§6: "UI MAY say tender for trade RFQs"): the package (scope, documents, site visit, schedule,
 * conditions, required checks, retention, response template) sits beside the RFQ lines, bids are quote versions
 * with a structured tender response, and nothing about a bid's price is readable until the bids are opened together
 * at the deadline with an opening record. Clarification answers go to every bidder. Values come from `TenderConfig`.
 */

export type TenderField = 'programme' | 'staffing' | 'method' | 'inclusions' | 'qualifications' | 'defects' | 'exceptions';
export const TENDER_FIELDS: Record<TenderField, { label: string; help: string }> = {
  programme: { label: 'Programme', help: 'Start date and duration in weeks.' },
  staffing: { label: 'Staffing', help: 'Who will run and do the work, with numbers on site.' },
  method: { label: 'Method statement', help: 'How the work will be carried out, in order, with safety measures.' },
  inclusions: { label: 'Inclusions', help: 'What the price includes beyond the bill of quantities.' },
  qualifications: { label: 'Qualifications', help: 'Relevant experience, references and credentials.' },
  defects: { label: 'Warranty and defects terms', help: 'How long defects are put right for, and how quickly.' },
  exceptions: { label: 'Commercial exceptions', help: 'Any terms of the package you do not accept.' },
};
export const TENDER_FIELD_KEYS = Object.keys(TENDER_FIELDS) as TenderField[];

export interface EvaluationCriterion { key: string; label: string; weight: number }

export interface TenderConfig {
  minResponseDays: number;
  maxResponseDays: number;
  /** Bidders may ask questions until this many hours before the deadline. */
  questionCutoffHours: number;
  /** An answer published closer to the deadline than this suggests extending it (shown to the client). */
  lateAnswerHours: number;
  defaultRetentionPct: number;
  maxRetentionPct: number;
  /** Fields every response template asks for. */
  defaultResponseFields: TenderField[];
  /** Price weight plus the qualitative criteria; the weights sum to 1. */
  priceWeight: number;
  criteria: EvaluationCriterion[];
  /** Scores run 0..scoreScale. */
  scoreScale: number;
  /** Fewer opened bids than this and the opening record says competition was limited. */
  minBidsForCompetition: number;
}

export const DEFAULT_TENDER_CONFIG: TenderConfig = {
  minResponseDays: 3,
  maxResponseDays: 90,
  questionCutoffHours: 48,
  lateAnswerHours: 72,
  defaultRetentionPct: 5,
  maxRetentionPct: 10,
  defaultResponseFields: ['programme', 'method', 'inclusions', 'qualifications', 'defects'],
  priceWeight: 0.6,
  criteria: [
    { key: 'programme', label: 'Programme and resources', weight: 0.15 },
    { key: 'method', label: 'Method and safety', weight: 0.15 },
    { key: 'experience', label: 'Experience and references', weight: 0.1 },
  ],
  scoreScale: 5,
  minBidsForCompetition: 2,
};

// ---------------------------------------------------------------- package (§10.5 step 1)
export interface TenderDocument { revisionId: string; documentId: string; title: string; revision: string; sha256: string | null; type: string | null; fileName: string }
export interface TenderPackage {
  scope: string;
  siteVisitRequired: boolean;
  siteVisitNote: string | null;
  startDate: string | null;
  finishDate: string | null;
  conditions: string | null;
  requiredChecks: CheckType[];
  retentionPct: number;
  responseFields: TenderField[];
  documents: TenderDocument[];
}

export function packageProblems(p: TenderPackage, cfg: TenderConfig, today: string): string[] {
  const out: string[] = [];
  if (p.scope.trim().length < 20) out.push('Describe the scope of the package in a few sentences.');
  if (p.startDate && p.startDate < today) out.push('The start date has passed.');
  if (p.startDate && p.finishDate && p.finishDate <= p.startDate) out.push('The finish date must be after the start date.');
  if (p.retentionPct < 0 || p.retentionPct > cfg.maxRetentionPct) out.push(`Retention runs from 0 to ${cfg.maxRetentionPct}%.`);
  if (p.siteVisitRequired && !p.siteVisitNote) out.push('Say how bidders arrange the site visit.');
  if (!p.responseFields.length) out.push('Ask for at least one part of the response besides the price.');
  if (p.responseFields.some((f) => !TENDER_FIELDS[f])) out.push('Unknown response field.');
  return out;
}

/** The package as bidders see it: fixed with the tender version it belongs to. */
export function packageWeeks(p: Pick<TenderPackage, 'startDate' | 'finishDate'>): number | null {
  if (!p.startDate || !p.finishDate) return null;
  return Math.round((Date.parse(p.finishDate) - Date.parse(p.startDate)) / (7 * 86_400_000));
}

// ---------------------------------------------------------------- bid response (§10.5 step 3)
export interface TenderResponse {
  startDate: string | null;
  programmeWeeks: number | null;
  staffing: string | null;
  method: string | null;
  inclusions: string[];
  qualifications: string | null;
  defectsTerms: string | null;
  exceptions: string[];
  siteVisitConfirmed: boolean;
  /** The bidder's own conflict-of-interest declaration (§10.5 step 4). Required. */
  conflict: { declared: boolean; details: string | null } | null;
}
export const EMPTY_TENDER_RESPONSE: TenderResponse = { startDate: null, programmeWeeks: null, staffing: null, method: null, inclusions: [], qualifications: null, defectsTerms: null, exceptions: [], siteVisitConfirmed: false, conflict: null };

const filled = (s: string | null | undefined, min = 10) => !!s && s.trim().length >= min;

/** What stops a bid being submitted, beyond the priced lines (`quoteProblems`). */
export function responseProblems(pkg: Pick<TenderPackage, 'responseFields' | 'siteVisitRequired' | 'finishDate' | 'startDate'>, r: TenderResponse): string[] {
  const p: string[] = [];
  const need = new Set(pkg.responseFields);
  if (need.has('programme') && (!r.programmeWeeks || r.programmeWeeks <= 0 || !r.startDate)) p.push('Give a start date and the programme in weeks.');
  if (need.has('staffing') && !filled(r.staffing)) p.push('Describe the staffing.');
  if (need.has('method') && !filled(r.method, 20)) p.push('Write a method statement.');
  if (need.has('inclusions') && !r.inclusions.length) p.push('List what the price includes.');
  if (need.has('qualifications') && !filled(r.qualifications)) p.push('Give your qualifications and references.');
  if (need.has('defects') && !filled(r.defectsTerms, 5)) p.push('State your warranty and defects terms.');
  if (pkg.siteVisitRequired && !r.siteVisitConfirmed) p.push('Confirm you visited the site.');
  if (!r.conflict) p.push('Declare whether you have a conflict of interest.');
  else if (r.conflict.declared && !filled(r.conflict.details, 5)) p.push('Describe the conflict of interest.');
  return p;
}

/** Notes the client sees about a response against the package (not blockers). */
export function responseNotes(pkg: Pick<TenderPackage, 'startDate' | 'finishDate'>, r: TenderResponse): string[] {
  const out: string[] = [];
  const weeks = packageWeeks(pkg);
  if (weeks != null && r.programmeWeeks != null && r.programmeWeeks > weeks) out.push(`Programme of ${r.programmeWeeks} weeks is longer than the ${weeks} weeks allowed.`);
  if (pkg.startDate && r.startDate && r.startDate > pkg.startDate) out.push(`Starts ${r.startDate}, after the package start of ${pkg.startDate}.`);
  if (r.exceptions.length) out.push(`${r.exceptions.length} commercial exception${r.exceptions.length === 1 ? '' : 's'}.`);
  if (r.conflict?.declared) out.push('Declared a conflict of interest.');
  return out;
}

// ---------------------------------------------------------------- sealing (§19.2, D-14)
export interface SealState { kind: 'rfq' | 'tender'; sealed: boolean; state: string; deadline: string; openedAt: string | null }

/**
 * Whether bid prices are still hidden from the client side. A tender opens only through the opening record at
 * or after the deadline; closing it early is not possible. A sealed RFQ opens at its deadline or when closed.
 * The database applies the same rule in `app_rfq_prices_open` (row-level security).
 */
export function pricesSealed(r: SealState, now: number = Date.now()): boolean {
  if (r.kind === 'tender') return !r.openedAt;
  return r.sealed && r.state === 'published' && Date.parse(r.deadline) > now;
}

/** A bidder withdraws or replaces a bid only before the deadline (§10.5); RFQ quotes follow the RFQ rules. */
export function withdrawalBlocker(r: Pick<SealState, 'kind' | 'deadline' | 'state'>, now: number = Date.now()): string | null {
  if (r.kind === 'tender') return r.state === 'published' && Date.parse(r.deadline) > now ? null : 'Bids can only be withdrawn before the deadline.';
  return ['published', 'closed'].includes(r.state) ? null : 'This request has been decided.';
}

export function openingBlocker(r: SealState, now: number = Date.now()): string | null {
  if (r.kind !== 'tender') return 'Only tenders have a bid opening.';
  if (r.openedAt) return 'The bids were already opened.';
  if (r.state !== 'published') return 'This tender is not open.';
  if (Date.parse(r.deadline) > now) return 'Bids stay sealed until the deadline.';
  return null;
}

// ---------------------------------------------------------------- opening record
export interface BidAtOpening {
  quoteId: string; versionId: string | null; versionNumber: number | null; providerOrgId: string; providerName: string;
  state: QuoteState | 'none' | 'declined'; submittedAt: string | null; snapshotHash: string | null; grossMinor: string | null;
}
export interface OpeningRecord {
  kind: 'TenderOpening';
  rfqId: string; reference: string; deadline: string; openedAt: string; openedBy: 'system' | string;
  bids: { providerName: string; providerOrgId: string; quoteVersionId: string; versionNumber: number; submittedAt: string; snapshotHash: string; grossMinor: string }[];
  withdrawn: { providerName: string; providerOrgId: string }[];
  declined: { providerName: string; providerOrgId: string }[];
  noResponse: { providerName: string; providerOrgId: string }[];
  competition: 'competitive' | 'limited' | 'none';
  note: string;
}

/**
 * The bid opening register: every bid live at the deadline, in submission order, with the hash of what was
 * submitted. Withdrawn, declined and silent invitees are listed by name only. The API hashes the record and
 * writes it once; prices become readable after it exists.
 */
export function openingRecord(input: { rfqId: string; reference: string; deadline: string; openedAt: string; openedBy: 'system' | string; bids: BidAtOpening[] }, cfg: TenderConfig): OpeningRecord {
  const live = input.bids.filter((b) => (b.state === 'submitted' || b.state === 'needs_revision') && b.versionId && b.submittedAt && b.submittedAt <= input.deadline)
    .sort((a, b) => a.submittedAt!.localeCompare(b.submittedAt!) || a.providerName.localeCompare(b.providerName));
  const pick = (s: (b: BidAtOpening) => boolean) => input.bids.filter(s).map((b) => ({ providerName: b.providerName, providerOrgId: b.providerOrgId })).sort((a, b) => a.providerName.localeCompare(b.providerName));
  const competition = live.length === 0 ? 'none' : live.length < cfg.minBidsForCompetition ? 'limited' : 'competitive';
  return {
    kind: 'TenderOpening', rfqId: input.rfqId, reference: input.reference, deadline: input.deadline, openedAt: input.openedAt, openedBy: input.openedBy,
    bids: live.map((b) => ({ providerName: b.providerName, providerOrgId: b.providerOrgId, quoteVersionId: b.versionId!, versionNumber: b.versionNumber!, submittedAt: b.submittedAt!, snapshotHash: b.snapshotHash!, grossMinor: b.grossMinor! })),
    withdrawn: pick((b) => b.state === 'withdrawn'),
    declined: pick((b) => b.state === 'declined'),
    noResponse: pick((b) => b.state === 'none' || b.state === 'draft'),
    competition,
    note: competition === 'none' ? 'No bids were received by the deadline.' : competition === 'limited' ? `Only ${live.length} bid received: competition was limited.` : `${live.length} bids opened together at the deadline.`,
  };
}

// ---------------------------------------------------------------- clarifications shared with every bidder (§10.5 step 5)
export interface Clarification { id: string; askedByOrgId: string | null; question: string; answer: string | null; answeredAt: string | null; createdAt: string }
export type Viewer = { side: 'client' } | { side: 'provider'; orgId: string };

/** A bidder sees every answered question (without who asked) and its own unanswered ones; the client sees all. */
export function visibleClarifications(list: Clarification[], v: Viewer) {
  return list
    .filter((c) => v.side === 'client' || c.answeredAt || c.askedByOrgId === v.orgId)
    .map((c) => ({ id: c.id, question: c.question, answer: c.answer, answeredAt: c.answeredAt, createdAt: c.createdAt, mine: v.side === 'provider' && c.askedByOrgId === v.orgId, fromClient: c.askedByOrgId == null, askedByOrgId: v.side === 'client' ? c.askedByOrgId : null }));
}

export function questionBlocker(deadline: string, cfg: TenderConfig, now: number = Date.now()): string | null {
  return Date.parse(deadline) - now < cfg.questionCutoffHours * 3_600_000 ? `Questions closed ${cfg.questionCutoffHours} hours before the deadline.` : null;
}

/** An answer published close to the deadline gives bidders little time; the client is told to consider an extension. */
export function lateAnswerWarning(deadline: string, cfg: TenderConfig, now: number = Date.now()): string | null {
  return Date.parse(deadline) - now < cfg.lateAnswerHours * 3_600_000 ? `This answer goes out less than ${cfg.lateAnswerHours} hours before the deadline. Consider extending the deadline so every bidder can take it into account.` : null;
}

// ---------------------------------------------------------------- evaluation (§10.5 step 4)
export interface EvaluationScore { evaluatorId: string; quoteId: string; criterion: string; score: number }
export interface EvaluatorDeclaration { evaluatorId: string; conflict: boolean }
export interface BidEvaluation {
  quoteId: string; providerName: string; likeForLike: boolean; grossMinor: string;
  priceScore: number | null; criteria: { key: string; label: string; weight: number; average: number | null; scores: number }[];
  total: number | null; rank: number | null; notes: string[];
}

export function scoreProblems(scores: { criterion: string; score: number }[], cfg: TenderConfig): string[] {
  const keys = new Set(cfg.criteria.map((c) => c.key));
  const p: string[] = [];
  for (const s of scores) {
    if (!keys.has(s.criterion)) p.push(`Unknown criterion ${s.criterion}.`);
    if (!Number.isInteger(s.score) || s.score < 0 || s.score > cfg.scoreScale) p.push(`Scores run from 0 to ${cfg.scoreScale}.`);
  }
  return [...new Set(p)];
}

/**
 * Normalised price plus qualitative scores. Price is scored only among like-for-like bids (lowest gross / gross);
 * a bid that does not price the same scope gets no price score and no total, so it is never ranked against the
 * others on a misleading figure. Evaluators who declared a conflict are left out; nobody scores without declaring.
 */
export function evaluateBids(columns: Pick<ComparisonColumn, 'quoteId' | 'providerName' | 'likeForLike' | 'totals'>[], scores: EvaluationScore[], declarations: EvaluatorDeclaration[], cfg: TenderConfig): { bids: BidEvaluation[]; evaluators: number; excluded: number; note: string } {
  const counted = new Set(declarations.filter((d) => !d.conflict).map((d) => d.evaluatorId));
  const excluded = declarations.filter((d) => d.conflict).length;
  const usable = scores.filter((s) => counted.has(s.evaluatorId));
  const lf = columns.filter((c) => c.likeForLike);
  const lowest = lf.length ? lf.reduce((m, c) => (BigInt(c.totals.grossMinor) < m ? BigInt(c.totals.grossMinor) : m), BigInt(lf[0]!.totals.grossMinor)) : null;
  const bids: BidEvaluation[] = columns.map((c) => {
    const priceScore = c.likeForLike && lowest != null && BigInt(c.totals.grossMinor) > 0n ? Math.round((Number(lowest) / Number(BigInt(c.totals.grossMinor))) * 1000) / 1000 : null;
    const criteria = cfg.criteria.map((k) => {
      const mine = usable.filter((s) => s.quoteId === c.quoteId && s.criterion === k.key);
      return { key: k.key, label: k.label, weight: k.weight, average: mine.length ? Math.round((mine.reduce((a, s) => a + s.score, 0) / mine.length) * 100) / 100 : null, scores: mine.length };
    });
    const notes: string[] = [];
    if (!c.likeForLike) notes.push('Does not price the same scope, so it is not scored on price or ranked.');
    if (criteria.some((k) => k.average == null)) notes.push('Not every criterion is scored yet.');
    const total = priceScore != null && criteria.every((k) => k.average != null)
      ? Math.round((cfg.priceWeight * priceScore + criteria.reduce((a, k) => a + k.weight * (k.average! / cfg.scoreScale), 0)) * 1000) / 1000
      : null;
    return { quoteId: c.quoteId, providerName: c.providerName, likeForLike: c.likeForLike, grossMinor: c.totals.grossMinor, priceScore, criteria, total, rank: null, notes };
  });
  const ranked = bids.filter((b) => b.total != null).sort((a, b) => b.total! - a.total! || a.providerName.localeCompare(b.providerName));
  ranked.forEach((b, i) => { b.rank = i + 1; });
  const note = !counted.size ? 'No evaluator has declared their interests yet, so no scores count.' : ranked.length < bids.length ? `${ranked.length} of ${bids.length} bids have a total; the rest are missing scores or do not price the same scope.` : 'Every bid is scored on price and quality.';
  return { bids, evaluators: counted.size, excluded, note };
}

export function criteriaWeightsValid(cfg: TenderConfig): boolean {
  return Math.abs(cfg.priceWeight + cfg.criteria.reduce((a, c) => a + c.weight, 0) - 1) < 1e-9;
}
