import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  appealProblems, CASE_ACTOR, CASE_OUTCOME_KEYS, CASE_OUTCOMES, CASE_STATE_LABEL, CASE_TYPE_KEYS, caseClock, caseMachine, caseQueueOrder, caseTypeLabel,
  defaultSeverity, DISCREPANCY_LABEL, isSafetyCase, OPEN_CASE_STATES, responseDueAt, SEVERITIES, SEVERITY_LABEL, staffConflict, STAFF_CASE_COMMANDS,
  standingOutcome, uuidv7,
  type CaseCommand, type CaseOutcome, type CaseSide, type CaseSource, type CaseState, type CaseType, type DiscrepancyKind, type Severity,
} from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Actor, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, unprocessable } from '../platform/platform.js';
import { orderSide, orgUsers, type OrderSide } from './parties.js';

/**
 * Trust and safety cases, R3 third slice (spec §9.10, §13.3). A contested discrepancy or a disputed order becomes a
 * case; staff triage it (severity and response target), ask the parties for information, propose and decide a
 * resolution, and a party may appeal once, decided by a different staff member. Safety cases (S1) skip triage, page
 * the on-call safety owner and show the local emergency message. Every step is in the hash-chained audit log and in
 * the case's own communication log. Parties use `route()` with RLS; staff work cases from the moderation area in
 * system context.
 */

type Row = Record<string, any>;
const ref = (n: number) => `CASE-${String(n).padStart(3, '0')}`;
const poRef = (n: number) => `PO-${String(n).padStart(3, '0')}`;
const caseType = z.enum(CASE_TYPE_KEYS as [CaseType, ...CaseType[]]);
const caseOutcome = z.enum(CASE_OUTCOME_KEYS as [CaseOutcome, ...CaseOutcome[]]);
const OPEN = OPEN_CASE_STATES as readonly string[];

const times = (c: Row) => ({
  state: c.state as CaseState, severity: c.severity as Severity, openedAt: iso(c.created_at)!, responseDueAt: iso(c.response_due_at), firstResponseAt: iso(c.first_response_at),
  decidedAt: iso(c.decided_at), appealedAt: iso(c.appealed_at),
});

// ---------------------------------------------------------------- people on each side
async function clientUsers(sql: Sql, orderId: string) {
  const o = await one<Row>(sql, `select o.awarded_by, r.created_by from orders o join rfqs r on r.id = o.rfq_id where o.id = $1`, [orderId]);
  return [o?.awarded_by, o?.created_by].filter(Boolean) as string[];
}
async function sideUsers(sql: Sql, c: Row, side: 'client' | 'provider' | 'both') {
  return [...(side !== 'provider' ? await clientUsers(sql, c.order_id) : []), ...(side !== 'client' ? await orgUsers(sql, c.provider_org_id) : [])];
}
async function staffUsers(sql: Sql, roles: string[]) {
  return (await many<{ id: string }>(sql, `select id from users where is_staff and staff_role = any($1::text[]) and status = 'active'`, [roles])).map((u) => u.id);
}
const partyLink = (c: Row, side: CaseSide) => (side === 'client' ? `/projects/${c.project_id}/orders/${c.order_id}#cases` : `/provider/orders/${c.order_id}#cases`);
async function tellSide(sql: Sql, c: Row, side: 'client' | 'provider' | 'both', title: string, body: string) {
  if (side !== 'provider') await notify(sql, await clientUsers(sql, c.order_id), { kind: 'case', title, body, link: partyLink(c, 'client') });
  if (side !== 'client') await notify(sql, await orgUsers(sql, c.provider_org_id), { kind: 'case', title, body, link: partyLink(c, 'provider') });
}

async function logMessage(sql: Sql, c: Row, m: { author: string | null; role: 'client' | 'provider' | 'staff' | 'system'; body: string; internal?: boolean }) {
  await sql.query(`insert into case_messages (id, case_id, project_id, provider_org_id, author_user_id, author_role, body, internal) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [uuidv7(), c.id, c.project_id, c.provider_org_id, m.author, m.role, m.body, !!m.internal]);
}

// ---------------------------------------------------------------- opening a case
export interface OpenCaseInput {
  order: Row;
  source: CaseSource;
  discrepancyId?: string | null;
  type: CaseType;
  summary: string;
  raisedBy: string;
  raisedSide: CaseSide;
}

/**
 * Opens a case, or returns the one already open for the same discrepancy or order dispute. A safety case is
 * triaged by the system at once (S1, 24/7 target) and pages the on-call safety owner.
 */
export async function openCase(sql: Sql, s: Services, i: OpenCaseInput): Promise<{ id: string; number: number; reference: string; created: boolean; safety: boolean; emergencyMessage: string | null }> {
  const cfg = s.pack.cases;
  const existing = i.discrepancyId
    ? await one<Row>(sql, `select * from cases where discrepancy_id = $1`, [i.discrepancyId])
    : await one<Row>(sql, `select * from cases where order_id = $1 and source = 'order' and state = any($2::text[])`, [i.order.id, OPEN]);
  if (existing) return { id: existing.id, number: existing.number, reference: ref(existing.number), created: false, safety: existing.safety, emergencyMessage: existing.safety ? cfg.emergencyMessage : null };
  const severity = defaultSeverity(i.type);
  const safety = isSafetyCase(i.type, severity);
  const now = new Date();
  const id = uuidv7();
  const row = (await one<Row>(sql, `insert into cases (id, type, severity, state, source, order_id, discrepancy_id, project_id, provider_org_id, raised_by, raised_side, summary, safety, paged_at, response_due_at, triaged_at, created_at, updated_at)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17) returning *`,
    [id, i.type, severity, safety ? 'triaged' : 'open', i.source, i.order.id, i.discrepancyId ?? null, i.order.project_id, i.order.provider_org_id, i.raisedBy, i.raisedSide, i.summary,
      safety, safety ? now.toISOString() : null, responseDueAt(now, severity, cfg).toISOString(), safety ? now.toISOString() : null, now.toISOString()]))!;
  await logMessage(sql, row, { author: null, role: 'system', body: `${ref(row.number)} opened by the ${i.raisedSide === 'client' ? 'client' : 'supplier'}: ${caseTypeLabel(i.type)}. ${i.summary}` });
  if (safety) {
    await logMessage(sql, row, { author: null, role: 'system', body: `Safety case: routed straight to the on-call safety owner. ${cfg.emergencyMessage}` });
    await notify(sql, await staffUsers(sql, [cfg.safetyOwnerRole]), { kind: 'case', title: `Safety case ${ref(row.number)}: respond within the hour`, body: `${caseTypeLabel(i.type)} on ${poRef(i.order.number)}: ${i.summary}`, link: `/moderation/cases/${id}` });
    await publish(sql, 'CaseSafetyPaged', { caseId: id, orderId: i.order.id });
  }
  const other: CaseSide = i.raisedSide === 'client' ? 'provider' : 'client';
  await tellSide(sql, row, other, `A case was opened on ${poRef(i.order.number)}`, `${ref(row.number)}: ${caseTypeLabel(i.type)}. BuildWise staff will review it; you can add your side on the order page.`);
  await publish(sql, 'CaseOpened', { caseId: id, orderId: i.order.id, orgId: i.order.provider_org_id, severity, type: i.type, source: i.source });
  await audit(sql, { actorUserId: i.raisedBy, action: 'case.opened', targetType: 'Case', targetId: id, reason: i.summary, metadata: { orderId: i.order.id, discrepancyId: i.discrepancyId ?? null, type: i.type, severity, safety, source: i.source } });
  return { id, number: row.number, reference: ref(row.number), created: true, safety, emergencyMessage: safety ? cfg.emergencyMessage : null };
}

// ---------------------------------------------------------------- views
async function discrepancyOf(sql: Sql, c: Row) {
  if (!c.discrepancy_id) return null;
  const x = await one<Row>(sql, `select x.*, d.number as delivery_number from delivery_discrepancies x join deliveries d on d.id = x.delivery_id where x.id = $1`, [c.discrepancy_id]);
  if (!x) return null;
  const line = await one<Row>(sql, `select description, unit from delivery_lines where delivery_id = $1 and line_key = $2`, [x.delivery_id, x.line_key]);
  return {
    id: x.id, delivery: `DEL-${String(x.delivery_number).padStart(3, '0')}`, kind: x.kind, kindLabel: DISCREPANCY_LABEL[x.kind as DiscrepancyKind], quantity: String(x.quantity).replace(/\.?0+$/, ''),
    description: line?.description ?? '', unit: line?.unit ?? '', note: x.note, supplierResponse: x.supplier_response, state: x.state,
  };
}

function base(s: Services, c: Row, o: Row) {
  const clock = caseClock(times(c), new Date(), s.pack.cases);
  const standing = standingOutcome({ outcome: c.outcome, appealOutcome: c.appeal_outcome, appealNewOutcome: c.appeal_new_outcome });
  return {
    id: c.id, number: c.number, reference: ref(c.number), type: c.type, typeLabel: caseTypeLabel(c.type), severity: c.severity, severityLabel: SEVERITY_LABEL[c.severity as Severity],
    state: c.state, stateLabel: CASE_STATE_LABEL[c.state as CaseState], source: c.source, summary: c.summary, raisedSide: c.raised_side, safety: c.safety,
    emergencyMessage: c.safety ? s.pack.cases.emergencyMessage : null, version: c.version,
    order: { id: o.id, reference: poRef(o.number), state: o.state },
    openedAt: iso(c.created_at), responseDueAt: iso(c.response_due_at), firstResponseAt: iso(c.first_response_at), responseOverdue: clock.responseOverdue,
    awaitingSide: c.state === 'awaiting_party' ? c.awaiting_side : null,
    proposal: c.proposed_resolution ? { text: c.proposed_resolution, at: iso(c.proposed_at) } : null,
    decision: c.decided_at ? { outcome: c.outcome, label: CASE_OUTCOMES[c.outcome as CaseOutcome], note: c.decision_note, at: iso(c.decided_at) } : null,
    appeal: c.appealed_at ? {
      side: c.appealed_side, statement: c.appeal_statement, at: iso(c.appealed_at), takenAt: iso(c.appeal_taken_at),
      outcome: c.appeal_outcome, newOutcome: c.appeal_new_outcome, newOutcomeLabel: c.appeal_new_outcome ? CASE_OUTCOMES[c.appeal_new_outcome as CaseOutcome] : null, note: c.appeal_note, decidedAt: iso(c.appeal_decided_at),
    } : null,
    standingOutcome: standing, standingOutcomeLabel: standing ? CASE_OUTCOMES[standing] : null,
    appealOpenUntil: clock.appealOpenUntil, finalAt: iso(c.final_at),
    notice: 'BuildWise staff review the evidence both sides give. They do not assess structural safety or give engineering advice. A rating never replaces a case.',
  };
}

async function evidenceOf(sql: Sql, caseId: string) {
  return (await many<Row>(sql, `select * from case_evidence where case_id = $1 order by created_at`, [caseId]))
    .map((e) => ({ id: e.id, revisionId: e.document_revision_id, documentTitle: e.document_title, revision: e.revision_label, fileName: e.file_name, sha256: e.sha256, side: e.added_side, note: e.note, at: iso(e.created_at) }));
}
async function messagesOf(sql: Sql, caseId: string, withInternal: boolean) {
  return (await many<Row>(sql, `select m.*, u.display_name from case_messages m left join users u on u.id = m.author_user_id where m.case_id = $1 and ($2 or not m.internal) order by m.created_at, m.id`, [caseId, withInternal]))
    .map((m) => ({ id: m.id, role: m.author_role, author: m.author_role === 'staff' ? 'BuildWise staff' : m.author_role === 'system' ? 'BuildWise' : m.display_name, staffName: withInternal && m.author_role === 'staff' ? m.display_name : undefined, body: m.body, internal: m.internal, at: iso(m.created_at) }));
}

async function partyCase(sql: Sql, user: Actor, id: string): Promise<{ c: Row; side: OrderSide }> {
  const c = await one<Row>(sql, `select * from cases where id = $1`, [id]);
  if (!c) throw notFound('Case');
  const side = await orderSide(sql, user, c.order_id).catch(() => { throw notFound('Case'); });
  return { c, side };
}
const canAct = (side: OrderSide) => side.side === 'provider' || side.canManage;

async function partyView(sql: Sql, s: Services, c: Row, side: OrderSide, user: Actor) {
  const problems = appealProblems({ ...times(c), appealedBy: c.appealed_by }, canAct(side), new Date(), s.pack.cases);
  const evidenceOptions = side.side === 'client' && side.canManage && c.state !== 'final'
    ? (await many<Row>(sql, `select r.id, r.original_name, r.revision_label, d.title from documents d join document_revisions r on r.id = d.current_revision_id
          where d.project_id = $1 and r.state = 'available' order by d.created_at desc limit 50`, [c.project_id])).map((r) => ({ revisionId: r.id, label: `${r.title} (rev ${r.revision_label}, ${r.original_name})` }))
    : [];
  return {
    ...base(s, c, side.o), side: side.side, discrepancy: await discrepancyOf(sql, c),
    messages: await messagesOf(sql, c.id, false), evidence: await evidenceOf(sql, c.id),
    canMessage: canAct(side) && c.state !== 'final', awaitingYou: c.state === 'awaiting_party' && (c.awaiting_side === 'both' || c.awaiting_side === side.side),
    canAppeal: !problems.length, appealProblems: problems,
    canAddEvidence: evidenceOptions.length > 0, evidenceOptions,
    raisedByYou: c.raised_by === user.id,
  };
}

// ---------------------------------------------------------------- party routes
export function registerCases(app: FastifyInstance, s: Services) {
  const cfg = s.pack.cases;

  route(app, s, {
    method: 'GET', url: '/v1/orders/:id/cases', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const side = await orderSide(sql, user, params.id);
      const rows = await many<Row>(sql, `select * from cases where order_id = $1 order by created_at desc`, [side.o.id]);
      const items = [];
      for (const c of rows) items.push(await partyView(sql, s, c, side, user));
      const discrepancies = await many<Row>(sql, `select x.id, x.kind, d.number from delivery_discrepancies x join deliveries d on d.id = x.delivery_id
          where x.order_id = $1 and x.state <> 'resolved' and not exists (select 1 from cases c where c.discrepancy_id = x.id) order by x.created_at`, [side.o.id]);
      return {
        items, side: side.side,
        // Any confirmed order can take a case, closed ones included (a defect can show after closing).
        canRaise: canAct(side) && side.o.state !== 'placed' && !(side.o.state === 'cancelled' && !side.o.confirmed_at),
        types: CASE_TYPE_KEYS.map((t) => ({ value: t, label: caseTypeLabel(t), safety: isSafetyCase(t) })),
        openDiscrepancies: discrepancies.map((x) => ({ id: x.id, label: `DEL-${String(x.number).padStart(3, '0')}: ${DISCREPANCY_LABEL[x.kind as DiscrepancyKind]}` })),
        emergencyMessage: cfg.emergencyMessage,
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/cases', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ type: caseType, summary: z.string().trim().min(10).max(2000), discrepancyId: z.uuid().optional() }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (!canAct(side)) throw forbidden('Only the project owner or a manager can raise a case for the client.');
      if (side.o.state === 'placed' || (side.o.state === 'cancelled' && !side.o.confirmed_at)) throw conflict('NO_TRANSACTION', 'The supplier has not confirmed this order. Cancel it instead.');
      if (body.discrepancyId && !(await one(sql, `select 1 from delivery_discrepancies where id = $1 and order_id = $2`, [body.discrepancyId, side.o.id]))) throw notFound('Discrepancy');
      const out = await openCase(sql, s, { order: side.o, source: body.discrepancyId ? 'discrepancy' : 'order', discrepancyId: body.discrepancyId ?? null, type: body.type, summary: body.summary, raisedBy: user.id, raisedSide: side.side });
      if (!out.created) throw conflict('CASE_EXISTS', `${out.reference} is already open for this. Add to it instead.`, { caseId: out.id });
      return out;
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/cases/:id', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const { c, side } = await partyCase(sql, user, params.id);
      return partyView(sql, s, c, side, user);
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/cases/:id/messages', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ body: z.string().trim().min(2).max(4000) }),
    handler: async ({ sql, params, body, user }) => {
      const { c, side } = await partyCase(sql, user, params.id);
      if (!canAct(side)) throw forbidden();
      if (c.state === 'final') throw conflict('CASE_FINAL', 'This case is closed.');
      await logMessage(sql, c, { author: user.id, role: side.side, body: body.body });
      let state = c.state as CaseState;
      // The party staff were waiting for has answered: back to the investigator.
      if (c.state === 'awaiting_party' && (c.awaiting_side === 'both' || c.awaiting_side === side.side)) {
        state = caseMachine.next(state, 'party_reply');
        await sql.query(`update cases set state = $2, awaiting_side = null, awaiting_since = null, version = version + 1, updated_at = now() where id = $1`, [c.id, state]);
        await logMessage(sql, c, { author: null, role: 'system', body: `The ${side.side === 'client' ? 'client' : 'supplier'} replied. The case is back under investigation.` });
      } else {
        await sql.query(`update cases set updated_at = now() where id = $1`, [c.id]);
      }
      const assignee = c.assigned_to ?? c.triaged_by;
      if (assignee) await notify(sql, [assignee], { kind: 'case', title: `New message on ${ref(c.number)}`, body: body.body.slice(0, 200), link: `/moderation/cases/${c.id}` });
      await publish(sql, 'CaseUpdated', { caseId: c.id, by: side.side, kind: 'message' });
      await audit(sql, { actorUserId: user.id, action: 'case.message', targetType: 'Case', targetId: c.id, metadata: { side: side.side, stateFrom: c.state, stateTo: state } });
      return { state };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/cases/:id/evidence', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ revisionId: z.uuid(), note: z.string().trim().max(500).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const { c, side } = await partyCase(sql, user, params.id);
      if (side.side !== 'client' || !side.canManage) throw forbidden('The client attaches project documents as evidence. The supplier can describe its evidence in a message.');
      if (c.state === 'final') throw conflict('CASE_FINAL', 'This case is closed.');
      const r = await one<Row>(sql, `select r.id, r.state, r.original_name, r.sha256, r.revision_label, d.title from document_revisions r join documents d on d.id = r.document_id where r.id = $1 and r.project_id = $2`, [body.revisionId, c.project_id]);
      if (!r) throw badRequest('INVALID_REFERENCE', 'That document is not in this project.');
      if (r.state !== 'available') throw unprocessable('NOT_AVAILABLE', 'Only documents that passed the upload checks can be evidence.');
      if (await one(sql, `select 1 from case_evidence where case_id = $1 and document_revision_id = $2`, [c.id, r.id])) throw conflict('ALREADY_ATTACHED', 'That document is already attached.');
      const id = uuidv7();
      await sql.query(`insert into case_evidence (id, case_id, project_id, provider_org_id, document_revision_id, document_title, revision_label, file_name, sha256, added_by, added_side, note)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'client', $11)`,
        [id, c.id, c.project_id, c.provider_org_id, r.id, r.title, r.revision_label, r.original_name, r.sha256, user.id, body.note ?? null]);
      await logMessage(sql, c, { author: null, role: 'system', body: `The client attached evidence: ${r.original_name}.` });
      await sql.query(`update cases set updated_at = now() where id = $1`, [c.id]);
      await audit(sql, { actorUserId: user.id, action: 'case.evidence_added', targetType: 'Case', targetId: c.id, metadata: { revisionId: r.id, sha256: r.sha256 } });
      return { id };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/cases/:id/appeal', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ statement: z.string().trim().min(10).max(2000), expectedVersion: z.number().int() }),
    handler: async ({ sql, params, body, user }) => {
      const { c, side } = await partyCase(sql, user, params.id);
      if (c.version !== body.expectedVersion) throw conflict('STALE', 'This case changed. Reload and try again.');
      const problems = appealProblems({ ...times(c), appealedBy: c.appealed_by }, canAct(side), new Date(), cfg);
      if (problems.length) throw conflict('NOT_APPEALABLE', problems[0]!);
      const to = caseMachine.next(c.state, 'appeal');
      await sql.query(`update cases set state = $2, appeal_statement = $3, appealed_by = $4, appealed_side = $5, appealed_at = now(), version = version + 1, updated_at = now() where id = $1`,
        [c.id, to, body.statement, user.id, side.side]);
      await logMessage(sql, c, { author: user.id, role: side.side, body: `Appeal: ${body.statement}` });
      await logMessage(sql, c, { author: null, role: 'system', body: 'Appeal received. A staff member who did not make the decision will review it.' });
      await tellSide(sql, c, side.side === 'client' ? 'provider' : 'client', `${ref(c.number)} was appealed`, `The ${side.side === 'client' ? 'client' : 'supplier'} appealed the decision. A different staff member will review it.`);
      const reviewers = (await staffUsers(sql, ['moderator', 'ops_admin'])).filter((u) => u !== c.decided_by);
      await notify(sql, reviewers, { kind: 'case', title: `Appeal on ${ref(c.number)}`, body: body.statement.slice(0, 200), link: `/moderation/cases/${c.id}` });
      await publish(sql, 'CaseAppealed', { caseId: c.id, by: side.side });
      await audit(sql, { actorUserId: user.id, action: 'case.appealed', targetType: 'Case', targetId: c.id, reason: body.statement, metadata: { side: side.side } });
      return { state: to };
    },
  });

  // ---------------------------------------------------------------- staff (moderation area, system context)
  route(app, s, {
    method: 'GET', url: '/v1/moderation/cases', auth: 'staff', systemContext: true,
    query: z.object({ view: z.enum(['open', 'appeals', 'closed']).default('open') }),
    handler: async ({ sql, query, user }) => {
      const states = query.view === 'open' ? OPEN : query.view === 'appeals' ? ['appealed', 'under_appeal_review'] : ['resolved', 'final'];
      const rows = await many<Row>(sql, `select c.*, o.number as order_number, o.state as order_state, org.name as provider_name, p.name as project_name
          from cases c join orders o on o.id = c.order_id join organizations org on org.id = c.provider_org_id join projects p on p.id = c.project_id
          where c.state = any($1::text[]) order by c.created_at desc limit 300`, [states]);
      const now = new Date();
      const sorted = caseQueueOrder(rows.map((c) => ({ ...times(c), id: c.id as string, row: c })), now);
      const counts = await many<Row>(sql, `select state, count(*)::int as n from cases group by state`);
      return {
        view: query.view,
        counts: Object.fromEntries(counts.map((x) => [x.state, x.n])),
        items: sorted.map(({ row: c }) => ({
          ...base(s, c, { id: c.order_id, number: c.order_number, state: c.order_state }),
          provider: c.provider_name, project: c.project_name,
          assignedToYou: c.assigned_to === user.id, decidedByYou: c.decided_by === user.id,
        })),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/moderation/cases/:id', auth: 'staff', systemContext: true, params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const c = await one<Row>(sql, `select * from cases where id = $1`, [params.id]);
      if (!c) throw notFound('Case');
      const o = (await one<Row>(sql, `select o.*, r.title as rfq_title, r.area_code from orders o join rfqs r on r.id = o.rfq_id where o.id = $1`, [c.order_id]))!;
      const org = await one<Row>(sql, `select name, handle from organizations where id = $1`, [c.provider_org_id]);
      const project = await one<Row>(sql, `select name from projects where id = $1`, [c.project_id]);
      const names = await many<Row>(sql, `select id, display_name from users where id = any($1::uuid[])`, [[c.raised_by, c.triaged_by, c.decided_by, c.appeal_reviewer, c.assigned_to].filter(Boolean)]);
      const name = (id: string | null) => names.find((n) => n.id === id)?.display_name ?? null;
      const trail = await many<Row>(sql, `select a.seq, a.action, a.reason, a.created_at, a.hash, u.display_name from audit_events a left join users u on u.id = a.actor_user_id where a.target_type = 'Case' and a.target_id = $1 order by a.seq`, [c.id]);
      const commands = c.state === 'final' ? [] : caseMachine.commandsFrom(c.state).filter((x) => STAFF_CASE_COMMANDS.includes(x) && CASE_ACTOR[x] !== 'party');
      return {
        ...base(s, c, o), discrepancy: await discrepancyOf(sql, c),
        provider: { name: org?.name, handle: org?.handle }, project: project?.name, rfqTitle: o.rfq_title, orderTotalMinor: String(o.total_minor), currency: o.currency,
        people: { raisedBy: name(c.raised_by), triagedBy: name(c.triaged_by), decidedBy: name(c.decided_by), appealReviewer: name(c.appeal_reviewer), assignedTo: name(c.assigned_to) },
        messages: await messagesOf(sql, c.id, true), evidence: await evidenceOf(sql, c.id),
        audit: trail.map((a) => ({ seq: Number(a.seq), action: a.action, actor: a.display_name, reason: a.reason, at: iso(a.created_at), hash: a.hash })),
        commands: commands.map((cmd) => ({ command: cmd, blockedReason: staffConflict(cmd, user.id, { decidedBy: c.decided_by, appealReviewer: c.appeal_reviewer }) })),
        severities: SEVERITIES.map((x) => ({ value: x, label: SEVERITY_LABEL[x] })),
        types: CASE_TYPE_KEYS.map((t) => ({ value: t, label: caseTypeLabel(t) })),
        outcomes: CASE_OUTCOME_KEYS.map((k) => ({ value: k, label: CASE_OUTCOMES[k] })),
        youDecided: c.decided_by === user.id,
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/cases/:id/messages', auth: 'staff', systemContext: true, params: z.object({ id: z.uuid() }),
    body: z.object({ body: z.string().trim().min(2).max(4000), internal: z.boolean().default(false) }),
    handler: async ({ sql, params, body, user }) => {
      const c = await one<Row>(sql, `select * from cases where id = $1`, [params.id]);
      if (!c) throw notFound('Case');
      await logMessage(sql, c, { author: user.id, role: 'staff', body: body.body, internal: body.internal });
      if (!body.internal) {
        await sql.query(`update cases set first_response_at = coalesce(first_response_at, now()), updated_at = now() where id = $1`, [c.id]);
        await tellSide(sql, c, 'both', `BuildWise replied on ${ref(c.number)}`, body.body.slice(0, 200));
      }
      await audit(sql, { actorUserId: user.id, action: body.internal ? 'case.note' : 'case.staff_message', targetType: 'Case', targetId: c.id });
      return { ok: true };
    },
  });

  const commandBody = z.object({
    expectedVersion: z.number().int(),
    note: z.string().trim().max(4000).optional(),
    severity: z.enum(SEVERITIES).optional(),
    type: caseType.optional(),
    side: z.enum(['client', 'provider', 'both']).optional(),
    resolution: z.string().trim().max(4000).optional(),
    outcome: caseOutcome.optional(),
    appealOutcome: z.enum(['upheld', 'overturned']).optional(),
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/cases/:id/commands/:command', auth: 'staff', systemContext: true, successStatus: 200,
    params: z.object({ id: z.uuid(), command: z.enum(STAFF_CASE_COMMANDS as [CaseCommand, ...CaseCommand[]]) }),
    body: commandBody,
    handler: async ({ sql, params, body, user }) => {
      const c = await one<Row>(sql, `select * from cases where id = $1 for update`, [params.id]);
      if (!c) throw notFound('Case');
      const cmd = params.command;
      if (c.version !== body.expectedVersion) throw conflict('STALE', 'Someone else changed this case. Reload and try again.');
      if (!caseMachine.can(c.state, cmd)) throw conflict('INVALID_TRANSITION', `A case that is ${CASE_STATE_LABEL[c.state as CaseState].toLowerCase()} can't take "${cmd.replace(/_/g, ' ')}".`);
      const clash = staffConflict(cmd, user.id, { decidedBy: c.decided_by, appealReviewer: c.appeal_reviewer });
      if (clash) throw forbidden(clash);
      const need = (v: unknown, field: string, message: string) => { if (v == null || v === '') throw badRequest('VALIDATION_FAILED', message, [{ path: field, message: 'Required.' }]); };
      const to = caseMachine.next(c.state, cmd);
      const set: string[] = ['state = $2', 'version = version + 1', 'updated_at = now()'];
      const args: unknown[] = [c.id, to];
      const p = (v: unknown) => { args.push(v); return `$${args.length}`; };
      let partyText: string | null = null; let tell: 'client' | 'provider' | 'both' | null = 'both';
      let event: 'CaseUpdated' | 'CaseDecided' | 'CaseFinal' = 'CaseUpdated';
      switch (cmd) {
        case 'triage': {
          need(body.severity, 'severity', 'Choose a severity.');
          const severity = body.severity!;
          const type = body.type ?? c.type;
          set.push(`severity = ${p(severity)}`, `type = ${p(type)}`, `triaged_by = ${p(user.id)}`, 'triaged_at = now()', `assigned_to = ${p(user.id)}`,
            `response_due_at = ${p(responseDueAt(new Date(String(c.created_at)), severity, cfg).toISOString())}`, 'first_response_at = coalesce(first_response_at, now())');
          if (isSafetyCase(type, severity) && !c.safety) set.push('safety = true', 'paged_at = now()');
          partyText = `A case officer has picked up ${ref(c.number)} (${SEVERITY_LABEL[severity]}, ${caseTypeLabel(type)}).${body.note ? ` ${body.note}` : ''}`;
          break;
        }
        case 'request_info': {
          need(body.side, 'side', 'Choose who to ask.'); need(body.note, 'note', 'Say what you need.');
          set.push(`awaiting_side = ${p(body.side)}`, 'awaiting_since = now()', 'party_reminded_at = null', 'first_response_at = coalesce(first_response_at, now())');
          partyText = `BuildWise asks the ${body.side === 'both' ? 'client and the supplier' : body.side === 'client' ? 'client' : 'supplier'}: ${body.note}`;
          tell = body.side!;
          break;
        }
        case 'investigate':
          set.push('awaiting_side = null', 'awaiting_since = null');
          partyText = body.note ? `Investigation: ${body.note}` : null; tell = body.note ? 'both' : null;
          break;
        case 'propose':
          need(body.resolution, 'resolution', 'Write the proposed resolution.');
          set.push(`proposed_resolution = ${p(body.resolution)}`, `proposed_by = ${p(user.id)}`, 'proposed_at = now()', 'awaiting_side = null', 'first_response_at = coalesce(first_response_at, now())');
          partyText = `Proposed resolution: ${body.resolution} Reply with anything we should consider before it is decided.`;
          break;
        case 'revise':
          need(body.note, 'note', 'Say why the proposal is being reconsidered.');
          partyText = `The proposal is being reconsidered: ${body.note}`;
          break;
        case 'decide':
          need(body.outcome, 'outcome', 'Choose an outcome.'); need(body.note, 'note', 'Explain the decision; both sides see it.');
          set.push(`outcome = ${p(body.outcome)}`, `decision_note = ${p(body.note)}`, `decided_by = ${p(user.id)}`, 'decided_at = now()');
          partyText = `Decision: ${CASE_OUTCOMES[body.outcome!]}. ${body.note} Either side may appeal once within ${cfg.appealWindowDays} days.`;
          event = 'CaseDecided';
          break;
        case 'take_appeal':
          set.push(`appeal_reviewer = ${p(user.id)}`, 'appeal_taken_at = now()');
          partyText = 'A staff member who did not make the original decision is reviewing the appeal.';
          break;
        case 'decide_appeal': {
          need(body.appealOutcome, 'appealOutcome', 'Uphold or overturn the decision.'); need(body.note, 'note', 'Explain the appeal decision; both sides see it.');
          if (body.appealOutcome === 'overturned') need(body.outcome, 'outcome', 'Choose the outcome that replaces the original.');
          if (body.appealOutcome === 'overturned' && body.outcome === c.outcome) throw unprocessable('SAME_OUTCOME', 'An overturned decision needs a different outcome.');
          set.push(`appeal_outcome = ${p(body.appealOutcome)}`, `appeal_new_outcome = ${p(body.appealOutcome === 'overturned' ? body.outcome : null)}`, `appeal_note = ${p(body.note)}`, 'appeal_decided_at = now()', 'final_at = now()');
          partyText = body.appealOutcome === 'upheld'
            ? `Appeal decided: the original decision stands. ${body.note} This decision is final.`
            : `Appeal decided: the decision is overturned. New outcome: ${CASE_OUTCOMES[body.outcome!]}. ${body.note} This decision is final.`;
          event = 'CaseFinal';
          break;
        }
      }
      await sql.query(`update cases set ${set.join(', ')} where id = $1`, args);
      if (partyText) await logMessage(sql, c, { author: user.id, role: 'staff', body: partyText });
      if (partyText && tell) await tellSide(sql, c, tell, `${ref(c.number)}: ${CASE_STATE_LABEL[to]}`, partyText.slice(0, 240));
      await publish(sql, event, { caseId: c.id, orderId: c.order_id, orgId: c.provider_org_id, command: cmd, state: to });
      await audit(sql, {
        actorUserId: user.id, action: `case.${cmd}`, targetType: 'Case', targetId: c.id, reason: body.note ?? body.resolution ?? null,
        metadata: { from: c.state, to, severity: body.severity ?? null, type: body.type ?? null, outcome: body.outcome ?? null, appealOutcome: body.appealOutcome ?? null, side: body.side ?? null },
      });
      return { state: to };
    },
  });
}

// ---------------------------------------------------------------- worker: appeal windows and reminders
/**
 * Decisions nobody appealed in time become final; overdue first responses remind staff once; a party asked for
 * information and silent past `partyReminderHours` is reminded once; received deliveries left uninspected past the
 * inspection window remind the client once. Idempotent.
 */
export async function runCaseTimers(sql: Sql, s: Services): Promise<{ finalized: number; staffReminders: number; partyReminders: number; inspectionReminders: number }> {
  const cfg = s.pack.cases;
  const finals = await many<Row>(sql, `update cases set state = 'final', final_at = now(), version = version + 1, updated_at = now()
      where state = 'resolved' and appealed_at is null and decided_at < now() - make_interval(days => $1) returning *`, [cfg.appealWindowDays]);
  for (const c of finals) {
    await logMessage(sql, c, { author: null, role: 'system', body: `No appeal within ${cfg.appealWindowDays} days: the decision is final.` });
    await publish(sql, 'CaseFinal', { caseId: c.id, orderId: c.order_id, orgId: c.provider_org_id, command: 'close', state: 'final' });
    await audit(sql, { actorUserId: null, action: 'case.close', targetType: 'Case', targetId: c.id, metadata: { from: 'resolved', to: 'final' } });
  }
  const late = await many<Row>(sql, `update cases set response_reminded_at = now() where first_response_at is null and response_reminded_at is null and response_due_at < now()
      and state = any($1::text[]) returning *`, [OPEN]);
  if (late.length) {
    const staff = await staffUsers(sql, ['moderator', 'ops_admin']);
    for (const c of late) await notify(sql, c.assigned_to ? [c.assigned_to] : staff, { kind: 'case', title: `${ref(c.number)} is past its response target`, body: `${SEVERITY_LABEL[c.severity as Severity]}: ${caseTypeLabel(c.type)}. ${c.summary.slice(0, 160)}`, link: `/moderation/cases/${c.id}` });
  }
  const silent = await many<Row>(sql, `update cases set party_reminded_at = now() where state = 'awaiting_party' and party_reminded_at is null and awaiting_since < now() - make_interval(hours => $1) returning *`, [cfg.partyReminderHours]);
  for (const c of silent) await tellSide(sql, c, c.awaiting_side, `Reminder: ${ref(c.number)} is waiting for your reply`, 'BuildWise staff asked for information on this case. Reply on the order page so it can be decided.');
  const uninspected = await many<Row>(sql, `update deliveries set inspection_reminded_at = now() where state = 'received' and inspection_reminded_at is null
      and received_at < now() - make_interval(hours => $1) returning id, order_id, project_id, number`, [s.pack.fulfilment.inspectionWindowHours]);
  for (const d of uninspected) {
    await notify(sql, await clientUsers(sql, d.order_id), { kind: 'order', title: 'A delivery is waiting for inspection', body: `DEL-${String(d.number).padStart(3, '0')} was received over ${s.pack.fulfilment.inspectionWindowHours} hours ago. Receipt is not acceptance: inspect it to accept the goods or raise a discrepancy.`, link: `/projects/${d.project_id}/orders/${d.order_id}` });
  }
  return { finalized: finals.length, staffReminders: late.length, partyReminders: silent.length, inspectionReminders: uninspected.length };
}
