import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  canonicalJson, evaluateBids, lateAnswerWarning, openingBlocker, openingRecord, packageProblems, questionBlocker, responseNotes, scoreProblems,
  TENDER_FIELD_KEYS, TENDER_FIELDS, uuidv7, visibleClarifications,
  type BidAtOpening, type CheckType, type Clarification, type ComparisonColumn, type OpeningRecord, type QuoteState, type TenderDocument, type TenderField,
  type TenderPackage, type TenderResponse,
} from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Actor, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, sha256, signFileToken, unprocessable } from '../platform/platform.js';
import { projectAccess, type ProjectAccess } from './projects.js';
import { myOrgIds, orgUsers } from './parties.js';
import { invite, notifyInvited, rfqRef, rfqRow, sealOf, sideOf } from './procurement.js';

/**
 * Sealed tenders for trade packages (spec §10.5, §19.2): the package, clarifications shared with every bidder, the
 * bid opening at the deadline with its register, and the evaluation (normalised price plus scored quality, with
 * evaluators' declarations of interest). Bids themselves are RFQ quote versions; sealing is enforced by row-level
 * security (`app_rfq_prices_open`), so nothing here can read a bid before the opening exists.
 */

type Row = Record<string, any>;
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const day = (v: unknown) => (v ? String(iso(v)).slice(0, 10) : null);
const today = () => new Date().toISOString().slice(0, 10);

export const packageInput = z.object({
  scope: z.string().trim().min(1).max(8000),
  siteVisitRequired: z.boolean().default(false),
  siteVisitNote: z.string().trim().max(1000).nullable().optional(),
  startDate: z.iso.date().nullable().optional(),
  finishDate: z.iso.date().nullable().optional(),
  conditions: z.string().trim().max(5000).nullable().optional(),
  requiredChecks: z.array(z.enum(['identity_contact', 'business_registration', 'professional_credential', 'trade_reference', 'stock_evidence'])).max(5).default([]),
  retentionPct: z.number().min(0).max(100).optional(),
  responseFields: z.array(z.enum(TENDER_FIELD_KEYS as [TenderField, ...TenderField[]])).max(10).optional(),
  documentRevisionIds: z.array(z.uuid()).max(30).default([]),
});
export type PackageBody = z.infer<typeof packageInput>;

async function documentsFor(sql: Sql, projectId: string, ids: string[]): Promise<TenderDocument[]> {
  if (!ids.length) return [];
  const rows = await many<Row>(sql, `select r.id, r.document_id, r.revision_label, r.sha256, r.state, r.detected_type, r.original_name, d.title, d.restricted from document_revisions r join documents d on d.id = r.document_id where r.id = any($1::uuid[]) and r.project_id = $2`, [ids, projectId]);
  if (rows.length !== new Set(ids).size) throw badRequest('INVALID_REFERENCE', 'A scope document is not in this project.');
  const bad = rows.find((r) => r.state !== 'available');
  if (bad) throw unprocessable('DOCUMENT_NOT_READY', `${bad.title} is still being processed. Attach it when it is available.`);
  if (rows.some((r) => r.restricted)) throw unprocessable('DOCUMENT_RESTRICTED', 'A restricted document cannot be issued to bidders.');
  return ids.map((id) => rows.find((r) => r.id === id)!).map((r) => ({ revisionId: r.id, documentId: r.document_id, title: r.title, revision: r.revision_label, sha256: r.sha256, type: r.detected_type, fileName: r.original_name }));
}

function packageFrom(s: Services, b: PackageBody, documents: TenderDocument[]): TenderPackage {
  return {
    scope: b.scope, siteVisitRequired: b.siteVisitRequired, siteVisitNote: b.siteVisitNote ?? null, startDate: b.startDate ?? null, finishDate: b.finishDate ?? null,
    conditions: b.conditions ?? null, requiredChecks: b.requiredChecks as CheckType[], retentionPct: b.retentionPct ?? s.pack.tenders.defaultRetentionPct,
    responseFields: b.responseFields ?? s.pack.tenders.defaultResponseFields, documents,
  };
}

export async function createPackage(sql: Sql, s: Services, rfq: { id: string; project_id: string }, b: PackageBody, userId: string) {
  const pkg = packageFrom(s, b, await documentsFor(sql, rfq.project_id, b.documentRevisionIds));
  const problems = packageProblems(pkg, s.pack.tenders, today());
  if (problems.length) throw unprocessable('PACKAGE_INCOMPLETE', problems[0]!, { problems });
  await sql.query(`insert into tender_packages (rfq_id, project_id, scope, site_visit_required, site_visit_note, start_date, finish_date, conditions, required_checks, retention_pct, response_fields, documents, updated_by)
    values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13)
    on conflict (rfq_id) do update set scope = excluded.scope, site_visit_required = excluded.site_visit_required, site_visit_note = excluded.site_visit_note, start_date = excluded.start_date,
      finish_date = excluded.finish_date, conditions = excluded.conditions, required_checks = excluded.required_checks, retention_pct = excluded.retention_pct,
      response_fields = excluded.response_fields, documents = excluded.documents, updated_by = excluded.updated_by, updated_at = now()`,
  [rfq.id, rfq.project_id, pkg.scope, pkg.siteVisitRequired, pkg.siteVisitNote, pkg.startDate, pkg.finishDate, pkg.conditions, pkg.requiredChecks, pkg.retentionPct, pkg.responseFields, JSON.stringify(pkg.documents), userId]);
  return pkg;
}

export async function packageOf(sql: Sql, rfqId: string): Promise<TenderPackage | null> {
  const p = await one<Row>(sql, `select * from tender_packages where rfq_id = $1`, [rfqId]);
  if (!p) return null;
  return {
    scope: p.scope, siteVisitRequired: p.site_visit_required, siteVisitNote: p.site_visit_note, startDate: day(p.start_date), finishDate: day(p.finish_date), conditions: p.conditions,
    requiredChecks: p.required_checks ?? [], retentionPct: Number(p.retention_pct), responseFields: p.response_fields ?? [], documents: json<TenderDocument[]>(p.documents) ?? [],
  };
}

function packageView(p: TenderPackage | null) {
  if (!p) return null;
  return { ...p, responseFieldLabels: p.responseFields.map((f) => ({ key: f, ...TENDER_FIELDS[f] })) };
}

async function clarifications(sql: Sql, rfqId: string, viewer: { side: 'client' } | { side: 'provider'; orgId: string }) {
  const rows = await many<Row>(sql, `select c.*, a.org_id from tender_clarifications c left join tender_clarification_askers a on a.clarification_id = c.id where c.rfq_id = $1 order by c.created_at`, [rfqId]);
  const list: Clarification[] = rows.map((r) => ({ id: r.id, askedByOrgId: r.asked_side === 'client' ? null : r.org_id ?? 'unknown', question: r.question, answer: r.answer, answeredAt: iso(r.answered_at), createdAt: iso(r.created_at)! }));
  const out = visibleClarifications(list, viewer);
  if (viewer.side !== 'client') return out;
  const names = new Map((await many<Row>(sql, `select id, name from organizations where id = any($1::uuid[])`, [[...new Set(list.map((c) => c.askedByOrgId).filter((x): x is string => !!x && x !== 'unknown'))]])).map((o) => [o.id, o.name]));
  return out.map((c) => ({ ...c, askedBy: c.askedByOrgId ? names.get(c.askedByOrgId) ?? null : null }));
}

async function openingOf(sql: Sql, rfqId: string) {
  const o = await one<Row>(sql, `select * from tender_openings where rfq_id = $1`, [rfqId]);
  return o ? { openedAt: iso(o.opened_at), openedBy: o.opened_by, record: json<OpeningRecord>(o.record), recordHash: o.record_hash } : null;
}

export async function tenderClientExtras(sql: Sql, s: Services, r: Row, access: ProjectAccess) {
  const manage = !access.viaStaffSession && ['owner', 'manager'].includes(access.role);
  const blocker = openingBlocker(sealOf(r));
  return {
    package: packageView(await packageOf(sql, r.id)),
    clarifications: await clarifications(sql, r.id, { side: 'client' }),
    canAnswer: manage && r.state === 'published',
    canOpen: manage && !blocker, openingBlocker: blocker,
    opening: await openingOf(sql, r.id),
    questionCutoffHours: s.pack.tenders.questionCutoffHours,
  };
}

export async function tenderProviderExtras(sql: Sql, s: Services, r: Row, orgId: string) {
  const qb = r.state === 'published' ? questionBlocker(iso(r.deadline)!, s.pack.tenders) : 'This tender is closed.';
  return {
    package: packageView(await packageOf(sql, r.id)),
    clarifications: await clarifications(sql, r.id, { side: 'provider', orgId }),
    canAsk: !qb, questionBlocker: qb, openedAt: iso(r.opened_at),
    questionCutoffHours: s.pack.tenders.questionCutoffHours,
  };
}

/** Bid responses next to the priced comparison, the evaluation and the opening register (client side only). */
export async function tenderComparisonExtras(sql: Sql, s: Services, r: Row, columns: ComparisonColumn[], user: Actor, access: ProjectAccess) {
  const cfg = s.pack.tenders;
  const pkg = (await packageOf(sql, r.id))!;
  const versions = columns.length ? await many<Row>(sql, `select id, quote_id, tender_response from quote_versions where id = any($1::uuid[])`, [columns.map((c) => c.versionId)]) : [];
  const scores = await many<Row>(sql, `select evaluator_id, quote_id, criterion, score from tender_scores where rfq_id = $1`, [r.id]);
  const decl = await many<Row>(sql, `select d.user_id, d.conflict, d.details, d.created_at, u.display_name from tender_declarations d join users u on u.id = d.user_id where d.rfq_id = $1 order by d.created_at`, [r.id]);
  const ev = evaluateBids(columns, scores.map((x) => ({ evaluatorId: x.evaluator_id, quoteId: x.quote_id, criterion: x.criterion, score: Number(x.score) })), decl.map((d) => ({ evaluatorId: d.user_id, conflict: d.conflict })), cfg);
  const mine = decl.find((d) => d.user_id === user.id);
  return {
    package: packageView(pkg),
    responses: columns.map((c) => {
      const tr = json<TenderResponse | null>(versions.find((v) => v.id === c.versionId)?.tender_response);
      return { quoteId: c.quoteId, versionId: c.versionId, providerName: c.providerName, response: tr, notes: tr ? responseNotes(pkg, tr) : [] };
    }),
    evaluation: { ...ev, priceWeight: cfg.priceWeight, criteria: cfg.criteria, scoreScale: cfg.scoreScale },
    declarations: decl.map((d) => ({ name: d.display_name, conflict: d.conflict, details: d.details, at: iso(d.created_at), mine: d.user_id === user.id })),
    myDeclaration: mine ? { conflict: mine.conflict } : null,
    myScores: scores.filter((x) => x.evaluator_id === user.id).map((x) => ({ quoteId: x.quote_id, criterion: x.criterion, score: Number(x.score) })),
    canEvaluate: !access.viaStaffSession && ['owner', 'manager'].includes(access.role) && r.state === 'closed',
    opening: await openingOf(sql, r.id),
  };
}

/**
 * Opens every bid together at the deadline (§10.5, §19.2). The RFQ's `opened_at` is set first (the database refuses
 * it before the deadline), which is what makes the bids readable inside this transaction; then the register is built
 * from exactly what was submitted, hashed and written once. Run by the client or by the worker at the deadline.
 */
export async function openTender(sql: Sql, s: Services, r: Row, userId: string | null) {
  const blocker = openingBlocker(sealOf(r));
  if (blocker) throw conflict('NOT_OPENABLE', blocker);
  const openedAt = new Date().toISOString();
  await sql.query(`update rfqs set opened_at = $2, opened_by = $3, state = 'closed', closed_at = $2, close_reason = 'Bids opened at the deadline', version = version + 1, updated_at = now() where id = $1`, [r.id, openedAt, userId]);
  const inv = await many<Row>(sql, `select i.provider_org_id, i.state as inv_state, o.name, q.id as quote_id, q.status, q.current_version_id from rfq_invitations i join organizations o on o.id = i.provider_org_id
    left join quotes q on q.invitation_id = i.id where i.rfq_id = $1 and i.state <> 'revoked' order by o.name`, [r.id]);
  const vids = inv.map((i) => i.current_version_id).filter(Boolean);
  const vs = vids.length ? await many<Row>(sql, `select id, number, state, submitted_at, snapshot_hash, totals from quote_versions where id = any($1::uuid[])`, [vids]) : [];
  const bids: BidAtOpening[] = inv.map((i) => {
    const v = vs.find((x) => x.id === i.current_version_id);
    const state: BidAtOpening['state'] = i.inv_state === 'declined' ? 'declined' : !i.quote_id || i.status === 'draft' ? 'none' : (v?.state as QuoteState) ?? (i.status as QuoteState);
    return { quoteId: i.quote_id ?? '', versionId: v?.id ?? null, versionNumber: v?.number ?? null, providerOrgId: i.provider_org_id, providerName: i.name, state, submittedAt: iso(v?.submitted_at), snapshotHash: v?.snapshot_hash ?? null, grossMinor: v?.totals ? json<Record<string, string>>(v.totals).grossMinor ?? null : null };
  });
  const record = openingRecord({ rfqId: r.id, reference: rfqRef(r), deadline: iso(r.deadline)!, openedAt, openedBy: userId ?? 'system', bids }, s.pack.tenders);
  const hash = sha256(canonicalJson(record));
  await sql.query(`insert into tender_openings (id, rfq_id, project_id, opened_at, opened_by, record, record_hash) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`, [uuidv7(), r.id, r.project_id, openedAt, userId, JSON.stringify(record), hash]);
  await publish(sql, 'TenderOpened', { rfqId: r.id, projectId: r.project_id, bids: record.bids.length, recordHash: hash });
  await audit(sql, { actorUserId: userId, action: 'tender.opened', targetType: 'Rfq', targetId: r.id, metadata: { bids: record.bids.map((b) => ({ quoteVersionId: b.quoteVersionId, snapshotHash: b.snapshotHash })), recordHash: hash, competition: record.competition } });
  await notify(sql, [r.created_by], { kind: 'rfq', title: 'Tender bids opened', body: `${r.title}: ${record.note}`, link: `/projects/${r.project_id}/rfqs/${r.id}` });
  for (const b of record.bids) await notify(sql, await orgUsers(sql, b.providerOrgId), { kind: 'rfq', title: 'Tender bids opened', body: `${r.title}: the bids were opened together at the deadline.`, link: `/provider/rfqs/${r.id}` });
  return { record, recordHash: hash };
}

export function registerTenders(app: FastifyInstance, s: Services) {
  const cfg = s.pack.tenders;

  async function manageable(sql: Sql, user: Actor, id: string) {
    const r = await rfqRow(sql, id);
    const access = await projectAccess(sql, user, r.project_id, 'rfq.manage');
    if (access.viaStaffSession) throw forbidden();
    return { r, access };
  }
  const tenderOnly = (r: Row) => { if (r.kind !== 'tender') throw notFound('Tender'); };

  route(app, s, {
    method: 'PUT', url: '/v1/rfqs/:id/package', auth: 'user', params: z.object({ id: z.uuid() }), body: packageInput.extend({ expectedVersion: z.number().int() }),
    handler: async ({ sql, params, body, user }) => {
      const { r } = await manageable(sql, user, params.id);
      tenderOnly(r);
      if (r.state !== 'draft') throw conflict('NOT_DRAFT', 'The package is fixed once the tender is published. Publish a clarification or revise the tender instead.');
      if (r.version !== body.expectedVersion) throw conflict('STALE', 'Someone else changed this tender. Reload and try again.');
      const pkg = await createPackage(sql, s, r as { id: string; project_id: string }, body, user.id);
      await sql.query(`update rfqs set version = version + 1, updated_at = now() where id = $1`, [r.id]);
      return { package: packageView(pkg) };
    },
  });

  // Bidders download the issued scope documents through the tender, never through the project.
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/documents/:revisionId/link', auth: 'user', params: z.object({ id: z.uuid(), revisionId: z.uuid() }), successStatus: 200,
    handler: async ({ sql, params, user }) => {
      const r = await rfqRow(sql, params.id);
      tenderOnly(r);
      const side = await sideOf(sql, user, r);
      if (side.side === 'provider' && r.state === 'draft') throw notFound('Tender');
      const d = (await packageOf(sql, r.id))?.documents.find((x) => x.revisionId === params.revisionId);
      if (!d) throw notFound('Document');
      const mime = d.type?.startsWith('image/') ? 'image/jpeg' : d.type ?? 'application/octet-stream';
      const token = signFileToken(s.config.authSecret, { op: 'download', key: `active/${d.revisionId}`, mime, name: d.fileName }, 300);
      if (side.side === 'provider') await audit(sql, { actorUserId: user.id, action: 'tender.document_downloaded', targetType: 'DocumentRevision', targetId: d.revisionId, metadata: { rfqId: r.id, orgId: side.orgId } });
      return { url: `/v1/files/${token}`, expiresInSeconds: 300 };
    },
  });

  // ---------------------------------------------------------------- clarifications (§10.5 step 5)
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/clarifications', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ question: z.string().trim().min(5).max(2000), answer: z.string().trim().min(2).max(4000).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      tenderOnly(r);
      if (r.state !== 'published') throw conflict('NOT_OPEN', 'This tender is not open for clarifications.');
      const side = await sideOf(sql, user, r);
      const id = uuidv7();
      if (side.side === 'provider') {
        const qb = questionBlocker(iso(r.deadline)!, cfg);
        if (qb) throw conflict('QUESTIONS_CLOSED', qb);
        await sql.query(`insert into tender_clarifications (id, rfq_id, project_id, asked_side, question) values ($1, $2, $3, 'provider', $4)`, [id, r.id, r.project_id, body.question]);
        await sql.query(`insert into tender_clarification_askers (clarification_id, rfq_id, project_id, org_id, user_id) values ($1, $2, $3, $4, $5)`, [id, r.id, r.project_id, side.orgId, user.id]);
        await notify(sql, [r.created_by], { kind: 'rfq', title: 'A bidder asked a question', body: r.title, link: `/projects/${r.project_id}/rfqs/${r.id}` });
        await publish(sql, 'TenderQuestionAsked', { rfqId: r.id, clarificationId: id });
        return { id, warning: null };
      }
      if (side.access.viaStaffSession || !['owner', 'manager'].includes(side.access.role)) throw forbidden();
      // A notice from the client goes to every bidder at once (an addendum to the package).
      if (!body.answer) throw badRequest('VALIDATION_FAILED', 'Write the clarification for bidders.', [{ path: 'answer', message: 'Required.' }]);
      await sql.query(`insert into tender_clarifications (id, rfq_id, project_id, asked_side, question, answer, answered_by, answered_at) values ($1, $2, $3, 'client', $4, $5, $6, now())`, [id, r.id, r.project_id, body.question, body.answer, user.id]);
      await tellBidders(sql, r, 'A tender clarification was published');
      await audit(sql, { actorUserId: user.id, action: 'tender.clarification_published', targetType: 'Rfq', targetId: r.id, metadata: { clarificationId: id } });
      return { id, warning: lateAnswerWarning(iso(r.deadline)!, cfg) };
    },
  });

  async function tellBidders(sql: Sql, r: Row, title: string) {
    const orgs = await many<{ provider_org_id: string }>(sql, `select provider_org_id from rfq_invitations where rfq_id = $1 and state not in ('revoked', 'declined')`, [r.id]);
    for (const o of orgs) await notify(sql, await orgUsers(sql, o.provider_org_id), { kind: 'rfq', title, body: `${r.title}: the answer goes to every bidder.`, link: `/provider/rfqs/${r.id}` });
    await publish(sql, 'TenderClarificationPublished', { rfqId: r.id, bidders: orgs.length });
  }

  route(app, s, {
    method: 'POST', url: '/v1/tender-clarifications/:id/answer', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ answer: z.string().trim().min(2).max(4000) }),
    handler: async ({ sql, params, body, user }) => {
      const c = await one<Row>(sql, `select * from tender_clarifications where id = $1`, [params.id]);
      if (!c) throw notFound('Clarification');
      const { r } = await manageable(sql, user, c.rfq_id);
      if (r.state !== 'published') throw conflict('NOT_OPEN', 'This tender is no longer open.');
      if (c.answered_at) throw conflict('ALREADY_ANSWERED', 'This question is answered. Publish another clarification to add to it.');
      await sql.query(`update tender_clarifications set answer = $2, answered_by = $3, answered_at = now() where id = $1`, [c.id, body.answer, user.id]);
      await tellBidders(sql, r, 'A tender question was answered');
      await audit(sql, { actorUserId: user.id, action: 'tender.clarification_answered', targetType: 'Rfq', targetId: r.id, metadata: { clarificationId: c.id } });
      return { answered: true, warning: lateAnswerWarning(iso(r.deadline)!, cfg) };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/rfqs/:id/clarifications', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await rfqRow(sql, params.id);
      tenderOnly(r);
      const side = await sideOf(sql, user, r);
      return { items: await clarifications(sql, r.id, side.side === 'client' ? { side: 'client' } : { side: 'provider', orgId: side.orgId }) };
    },
  });

  // ---------------------------------------------------------------- opening (§10.5, §19.2)
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/open', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ expectedVersion: z.number().int() }),
    handler: async ({ sql, params, body, user }) => {
      const { r } = await manageable(sql, user, params.id);
      tenderOnly(r);
      if (r.version !== body.expectedVersion) throw conflict('STALE', 'Someone else changed this tender. Reload and try again.');
      const res = await openTender(sql, s, r, user.id);
      return { state: 'closed', opening: res.record, recordHash: res.recordHash };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/rfqs/:id/opening', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await rfqRow(sql, params.id);
      tenderOnly(r);
      await projectAccess(sql, user, r.project_id, 'rfq.read');
      const o = await openingOf(sql, r.id);
      if (!o) throw notFound('Opening record');
      return o;
    },
  });

  // ---------------------------------------------------------------- evaluation (§10.5 step 4)
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/declaration', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ conflict: z.boolean(), details: z.string().trim().max(1000).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const { r } = await manageable(sql, user, params.id);
      tenderOnly(r);
      if (body.conflict && (!body.details || body.details.length < 5)) throw badRequest('VALIDATION_FAILED', 'Describe the conflict of interest.', [{ path: 'details', message: 'Required.' }]);
      if (await one(sql, `select 1 from tender_declarations where rfq_id = $1 and user_id = $2`, [r.id, user.id])) throw conflict('ALREADY_DECLARED', 'You have already declared your interests for this tender.');
      await sql.query(`insert into tender_declarations (id, rfq_id, project_id, user_id, conflict, details) values ($1, $2, $3, $4, $5, $6)`, [uuidv7(), r.id, r.project_id, user.id, body.conflict, body.details ?? null]);
      await audit(sql, { actorUserId: user.id, action: body.conflict ? 'tender.conflict_declared' : 'tender.no_conflict_declared', targetType: 'Rfq', targetId: r.id, reason: body.details ?? null });
      return { declared: true, canScore: !body.conflict };
    },
  });

  route(app, s, {
    method: 'PUT', url: '/v1/rfqs/:id/scores', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ quoteId: z.uuid(), scores: z.array(z.object({ criterion: z.string().max(40), score: z.number().int(), note: z.string().trim().max(1000).optional() })).min(1).max(10) }),
    handler: async ({ sql, params, body, user }) => {
      const { r } = await manageable(sql, user, params.id);
      tenderOnly(r);
      if (!r.opened_at) throw conflict('SEALED', 'Bids are scored after they are opened.');
      if (r.state !== 'closed') throw conflict('DECIDED', 'Scores are fixed once the tender is decided.');
      const d = await one<Row>(sql, `select conflict from tender_declarations where rfq_id = $1 and user_id = $2`, [r.id, user.id]);
      if (!d) throw conflict('DECLARE_FIRST', 'Declare your interests before you score.');
      if (d.conflict) throw forbidden('You declared a conflict of interest, so you do not score this tender.');
      const q = await one(sql, `select 1 from quotes where id = $1 and rfq_id = $2 and status <> 'draft'`, [body.quoteId, r.id]);
      if (!q) throw notFound('Bid');
      const problems = scoreProblems(body.scores, cfg);
      if (problems.length) throw badRequest('VALIDATION_FAILED', problems[0]!);
      for (const x of body.scores) {
        await sql.query(`insert into tender_scores (id, rfq_id, project_id, quote_id, evaluator_id, criterion, score, note) values ($1, $2, $3, $4, $5, $6, $7, $8)
          on conflict (rfq_id, quote_id, evaluator_id, criterion) do update set score = excluded.score, note = excluded.note, updated_at = now()`, [uuidv7(), r.id, r.project_id, body.quoteId, user.id, x.criterion, x.score, x.note ?? null]);
      }
      return { saved: body.scores.length };
    },
  });

  // ---------------------------------------------------------------- named (nominated) suppliers (§10.4 step 2)
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/nominations', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ handles: z.array(z.string().trim().min(2).max(80)).min(1).max(20), remove: z.boolean().default(false) }),
    handler: async ({ sql, params, body, user }) => {
      const { r } = await manageable(sql, user, params.id);
      if (r.sourcing_mode !== 'nominated') throw conflict('NOT_NOMINATED_MODE', 'Switch the request to “Suppliers you name” first.');
      if (!['draft', 'published'].includes(r.state)) throw conflict('INVALID_TRANSITION', 'Suppliers can only be named before the request closes.');
      const orgs = await many<Row>(sql, `select id, handle, name from organizations where handle = any($1::text[])`, [body.handles.map((h) => h.replace(/^@/, ''))]);
      const unknown = body.handles.filter((h) => !orgs.some((o) => o.handle === h.replace(/^@/, '')));
      if (unknown.length) throw badRequest('VALIDATION_FAILED', `No supplier has the handle ${unknown[0]}.`, [{ path: 'handles', message: 'Use the handle from the supplier’s profile page.' }]);
      const current: string[] = r.nominated_org_ids ?? [];
      const next = body.remove ? current.filter((x) => !orgs.some((o) => o.id === x)) : [...new Set([...current, ...orgs.map((o) => o.id)])];
      if (next.length > s.pack.sourcing.maxNominated) throw conflict('TOO_MANY_NOMINATED', `Name at most ${s.pack.sourcing.maxNominated} suppliers.`);
      if (!body.remove && (await myOrgIds(sql, user)).some((o) => orgs.some((x) => x.id === o))) throw unprocessable('OWN_ORGANIZATION', 'You cannot name your own organization (conflict of interest).');
      await sql.query(`update rfqs set nominated_org_ids = $2, version = version + 1, updated_at = now() where id = $1`, [r.id, next]);
      await audit(sql, { actorUserId: user.id, action: body.remove ? 'rfq.nominations_removed' : 'rfq.nominated', targetType: 'Rfq', targetId: r.id, metadata: { orgIds: orgs.map((o) => o.id) } });
      // Once published, a newly named supplier who passes the checks is invited straight away.
      let invited: string[] = []; let refused: { orgId: string; name: string; reasons: string[] }[] = [];
      if (!body.remove && r.state === 'published') {
        const fresh = await rfqRow(sql, r.id);
        const res = await invite(sql, s, fresh, user, orgs.map((o) => o.id), 'matched');
        invited = res.invited; refused = res.refused;
        await notifyInvited(sql, fresh, invited, fresh.kind === 'tender' ? 'Invitation to tender' : 'New request for quotes', fresh.title);
      }
      return { nominated: next.length, invited, refused };
    },
  });
}
