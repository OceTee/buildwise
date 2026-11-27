import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  approvalBlockers, can, canonicalJson, contractCloseBlockers, contractFulfilmentCommand, formatMoney, MILESTONE_ACTOR, MILESTONE_NEEDS_REASON,
  milestoneMachine, milestonePayable, milestoneProblems, nextRevision, OPEN_VARIATION_STATES, orderMachine, parseMajor, RECORD_ONLY_PAYMENT_NOTICE, retentionOf,
  milestoneScheduleProblems, scheduleSummary, uuidv7, VARIATION_ACTOR, variationLinesTotal, variationMachine, variationProblems,
  type AwardRevision, type MilestoneCommand, type MilestoneRow, type MilestoneState, type VariationCommand, type VariationLine, type VariationState,
} from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, sha256, unprocessable } from '../platform/platform.js';
import { orderSide, orgUsers, type OrderSide } from './parties.js';

/**
 * Milestones, variations and award revisions (spec §9.5, §9.6, §10.5 steps 6–7, §14.1). Every award (supply order
 * or tender contract) can carry a payment schedule; a priced variation is proposed by either side, decided by the
 * project owner, and an approved one writes a new award revision (value and programme). Payments stay record-only.
 */

type Row = Record<string, any>;
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const day = (v: unknown) => (v ? String(iso(v)).slice(0, 10) : null);
const ref = (o: Row) => `${o.kind === 'contract' ? 'CT' : 'PO'}-${String(o.number).padStart(3, '0')}`;

export async function createFirstRevision(sql: Sql, a: { orderId: string; projectId: string; providerOrgId: string; valueMinor: bigint; termsHash: string; completionDate: string | null; userId: string }) {
  const snapshot = { kind: 'AwardRevision', orderId: a.orderId, number: 1, valueMinor: String(a.valueMinor), timeDays: 0, completionDate: a.completionDate, termsHash: a.termsHash, reason: 'Award' };
  await sql.query(`insert into award_revisions (id, order_id, project_id, provider_org_id, number, value_minor, time_days, completion_date, reason, snapshot, snapshot_hash, created_by) values ($1, $2, $3, $4, 1, $5, 0, $6, 'Award', $7::jsonb, $8, $9)`,
    [uuidv7(), a.orderId, a.projectId, a.providerOrgId, String(a.valueMinor), a.completionDate, JSON.stringify(snapshot), sha256(canonicalJson(snapshot)), a.userId]);
}

async function milestonesOf(sql: Sql, orderId: string): Promise<(MilestoneRow & Row)[]> {
  const rows = await many<Row>(sql, `select m.*, coalesce((select sum(p.amount_minor) from payment_records p where p.milestone_id = m.id and p.voided_at is null), 0) as paid from order_milestones m where m.order_id = $1 order by m.position`, [orderId]);
  return rows.map((m) => ({ ...m, id: m.id, title: m.title, amountMinor: BigInt(m.amount_minor), dueDate: day(m.due_date), state: m.state as MilestoneState, paidMinor: BigInt(m.paid) }));
}

async function currentRevision(sql: Sql, orderId: string): Promise<AwardRevision & { id: string }> {
  const r = (await one<Row>(sql, `select * from award_revisions where order_id = $1 order by number desc limit 1`, [orderId]))!;
  return { id: r.id, number: r.number, valueMinor: BigInt(r.value_minor), timeDays: r.time_days, completionDate: day(r.completion_date), variationId: r.variation_id, reason: r.reason };
}

export async function contractCloseCheck(sql: Sql, o: Row) {
  const ms = await milestonesOf(sql, o.id);
  const open = (await one<{ n: number }>(sql, `select count(*)::int as n from variations where order_id = $1 and state = any($2::text[])`, [o.id, OPEN_VARIATION_STATES]))!.n;
  return { blockers: contractCloseBlockers(o.state, ms, open) };
}

/** A tender contract moves with its milestones (supply orders move with deliveries, fulfilment.ts). */
async function syncContract(sql: Sql, orderId: string) {
  const o = (await one<Row>(sql, `select * from orders where id = $1`, [orderId]))!;
  if (o.kind !== 'contract') return o.state;
  const cmd = contractFulfilmentCommand(o.state, await milestonesOf(sql, o.id), BigInt(o.contract_value_minor));
  if (!cmd) return o.state;
  const to = orderMachine.next(o.state, cmd);
  await sql.query(`update orders set state = $2, fulfilled_at = case when $3 then now() else fulfilled_at end, version = version + 1, updated_at = now() where id = $1`, [o.id, to, cmd === 'fulfil']);
  await publish(sql, cmd === 'fulfil' ? 'OrderFulfilled' : 'OrderPartiallyFulfilled', { orderId: o.id, orgId: o.provider_org_id });
  await audit(sql, { actorUserId: null, action: `order.${cmd}`, targetType: 'Order', targetId: o.id, metadata: { from: o.state, to, by: 'milestones' } });
  return to;
}

function allowed(who: 'client' | 'provider' | 'either' | 'proposer', side: OrderSide, proposedSide?: string) {
  if (who === 'proposer') return side.side === proposedSide && (side.side === 'provider' || side.canManage);
  if (who === 'provider') return side.side === 'provider';
  if (who === 'client') return side.side === 'client' && side.canManage;
  return side.side === 'provider' || side.canManage;
}

async function tellOther(sql: Sql, side: OrderSide, title: string, body: string) {
  const o = side.o;
  if (side.side === 'provider') await notify(sql, [o.awarded_by], { kind: 'order', title, body, link: `/projects/${o.project_id}/orders/${o.id}` });
  else await notify(sql, await orgUsers(sql, o.provider_org_id), { kind: 'order', title, body, link: `/provider/orders/${o.id}` });
}

const lineSchema = z.object({ description: z.string().trim().min(2).max(300), quantity: z.string().regex(/^-?\d+(\.\d{1,6})?$/), unit: z.string().max(20), rate: z.string().max(24) });

export function registerContracts(app: FastifyInstance, s: Services) {
  const cfg = s.pack.contracts;
  const money = (minor: bigint | string | number, currency: string) => ({ amountMinor: String(minor), currency, display: formatMoney({ amountMinor: String(minor), currency }, s.pack.locale) });

  async function view(sql: Sql, side: OrderSide) {
    const o = side.o;
    const ms = await milestonesOf(sql, o.id);
    const ev = await many<Row>(sql, `select e.*, u.display_name from milestone_events e left join users u on u.id = e.actor_user_id where e.order_id = $1 order by e.at`, [o.id]);
    const vars = await many<Row>(sql, `select v.*, u.display_name as proposer_name from variations v join users u on u.id = v.proposed_by where v.order_id = $1 order by v.number`, [o.id]);
    const vev = await many<Row>(sql, `select e.*, u.display_name from variation_events e join users u on u.id = e.actor_user_id where e.order_id = $1 order by e.at`, [o.id]);
    const revs = await many<Row>(sql, `select * from award_revisions where order_id = $1 order by number`, [o.id]);
    const rev = revs[revs.length - 1]!;
    const value = BigInt(rev.value_minor);
    const retention = Number(o.retention_pct);
    const sum = scheduleSummary(ms, value, retention);
    const canApprove = side.side === 'client' && !side.access.viaStaffSession && can(side.access.role, 'variation.approve');
    const active = !['cancelled', 'closed'].includes(o.state);
    return {
      orderId: o.id, reference: ref(o), kind: o.kind, state: o.state, currency: o.currency, side: side.side, retentionPct: retention,
      contractValue: money(value, o.currency), originalValue: money(o.total_minor, o.currency),
      summary: Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, typeof v === 'string' ? money(v, o.currency) : v])),
      scheduleProblems: milestoneScheduleProblems(ms, value, cfg),
      canAddMilestones: side.side === 'client' && side.canManage && active,
      canPropose: active && o.state !== 'placed' && (side.side === 'provider' || side.canManage),
      milestones: ms.map((m) => ({
        id: m.id, position: m.position, title: m.title, description: m.description, amount: money(m.amountMinor, o.currency), dueDate: m.dueDate, state: m.state, version: m.version,
        evidenceNote: m.evidence_note, completedAt: iso(m.completed_at), paid: money(m.paidMinor, o.currency),
        retention: money(m.state === 'complete' ? retentionOf(m.amountMinor, retention) : 0n, o.currency), payable: money(milestonePayable(m, retention), o.currency),
        commands: active ? milestoneMachine.commandsFrom(m.state).filter((c) => allowed(MILESTONE_ACTOR[c], side)) : [],
        history: ev.filter((e) => e.milestone_id === m.id).map((e) => ({ command: e.command, from: e.from_state, to: e.to_state, reason: e.reason, by: e.display_name ?? 'BuildWise', side: e.actor_side, at: iso(e.at) })),
      })),
      variations: vars.map((v) => {
        const st = v.state as VariationState;
        const cmds = active ? variationMachine.commandsFrom(st).filter((c) => (c === 'approve' || c === 'reject' ? canApprove : allowed(VARIATION_ACTOR[c], side, v.proposed_side))) : [];
        return {
          id: v.id, number: v.number, reference: `VO-${String(v.number).padStart(2, '0')}`, title: v.title, description: v.description, reason: v.reason, state: st, version: v.version,
          proposedSide: v.proposed_side, proposedBy: v.proposer_name, cost: v.cost_impact_minor != null ? money(v.cost_impact_minor, o.currency) : null, timeImpactDays: v.time_impact_days,
          lines: json<Row[]>(v.lines).map((l) => ({ ...l, rate: money(l.rateMinor, o.currency) })), decisionNote: v.decision_note, decidedAt: iso(v.decided_at),
          commands: cmds,
          history: vev.filter((e) => e.variation_id === v.id).map((e) => ({ command: e.command, from: e.from_state, to: e.to_state, cost: e.cost_impact_minor != null ? money(e.cost_impact_minor, o.currency) : null, timeImpactDays: e.time_impact_days, note: e.note, by: e.display_name, side: e.actor_side, at: iso(e.at) })),
        };
      }),
      revisions: revs.map((r) => ({ number: r.number, value: money(r.value_minor, o.currency), timeDays: r.time_days, completionDate: day(r.completion_date), reason: r.reason, variationId: r.variation_id, hash: r.snapshot_hash, at: iso(r.created_at) })),
      paymentNotice: RECORD_ONLY_PAYMENT_NOTICE,
    };
  }

  route(app, s, {
    method: 'GET', url: '/v1/orders/:id/contract', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => view(sql, await orderSide(sql, user, params.id)),
  });

  // ---------------------------------------------------------------- milestones (§9.5)
  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/milestones', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ milestones: z.array(z.object({ title: z.string().trim().max(160), description: z.string().trim().max(1000).optional(), amount: z.string().max(24), dueDate: z.iso.date().optional() })).min(1).max(20) }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (side.side !== 'client' || !side.canManage) throw forbidden('The client sets the payment milestones.');
      const o = side.o;
      if (['cancelled', 'closed'].includes(o.state)) throw conflict('INACTIVE', 'This award is no longer active.');
      const parsed = body.milestones.map((m, i) => {
        const minor = parseMajor(m.amount, o.currency);
        if (minor == null) throw badRequest('VALIDATION_FAILED', 'Enter each amount like 250000.', [{ path: `milestones.${i}.amount`, message: 'Enter an amount.' }]);
        const p = milestoneProblems({ title: m.title, amountMinor: minor, dueDate: m.dueDate ?? null });
        if (p.length) throw badRequest('VALIDATION_FAILED', p[0]!, [{ path: `milestones.${i}`, message: p[0]! }]);
        return { ...m, minor };
      });
      const existing = await milestonesOf(sql, o.id);
      const rev = await currentRevision(sql, o.id);
      const problems = milestoneScheduleProblems([...existing, ...parsed.map((p) => ({ amountMinor: p.minor, state: 'not_started' as const }))], rev.valueMinor, cfg);
      if (problems.length) throw unprocessable('SCHEDULE_INVALID', problems[0]!, { problems });
      let pos = existing.length;
      const ids: string[] = [];
      for (const m of parsed) {
        const id = uuidv7(); ids.push(id);
        await sql.query(`insert into order_milestones (id, order_id, project_id, provider_org_id, position, title, description, amount_minor, due_date, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, o.id, o.project_id, o.provider_org_id, ++pos, m.title, m.description ?? null, String(m.minor), m.dueDate ?? null, user.id]);
        await sql.query(`insert into milestone_events (id, milestone_id, order_id, project_id, provider_org_id, command, from_state, to_state, actor_user_id, actor_side) values ($1, $2, $3, $4, $5, 'create', null, 'not_started', $6, 'client')`,
          [uuidv7(), id, o.id, o.project_id, o.provider_org_id, user.id]);
      }
      await tellOther(sql, side, 'Payment milestones set', `${ref(o)}: ${parsed.length} milestone${parsed.length === 1 ? '' : 's'} added.`);
      await publish(sql, 'MilestonesSet', { orderId: o.id, count: parsed.length });
      await audit(sql, { actorUserId: user.id, action: 'milestones.added', targetType: 'Order', targetId: o.id, metadata: { ids } });
      return { ids };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/milestones/:id/commands/:command', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), command: z.enum(['ready', 'start', 'claim', 'accept', 'reject', 'block', 'unblock', 'dispute', 'resolve', 'cancel']) }),
    body: z.object({ expectedVersion: z.number().int(), reason: z.string().trim().min(3).max(1000).optional(), evidenceNote: z.string().trim().max(2000).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const m = await one<Row>(sql, `select * from order_milestones where id = $1`, [params.id]);
      if (!m) throw notFound('Milestone');
      const side = await orderSide(sql, user, m.order_id);
      const cmd = params.command as MilestoneCommand;
      if (!allowed(MILESTONE_ACTOR[cmd], side)) throw forbidden();
      if (m.version !== body.expectedVersion) throw conflict('STALE', 'This milestone changed. Reload and try again.');
      if (!milestoneMachine.can(m.state, cmd)) throw conflict('INVALID_TRANSITION', `A milestone that is ${m.state.replace(/_/g, ' ')} can't do that.`);
      if (['cancelled', 'closed'].includes(side.o.state)) throw conflict('INACTIVE', 'This award is no longer active.');
      if (side.o.state === 'placed' && ['start', 'claim'].includes(cmd)) throw conflict('NOT_CONFIRMED', 'Confirm the award before starting work.');
      if (MILESTONE_NEEDS_REASON.includes(cmd) && !body.reason) throw badRequest('VALIDATION_FAILED', 'Give a reason.', [{ path: 'reason', message: 'Required.' }]);
      if (cmd === 'claim' && !body.evidenceNote) throw badRequest('VALIDATION_FAILED', 'Say what was done.', [{ path: 'evidenceNote', message: 'Describe the work completed for this milestone.' }]);
      const to = milestoneMachine.next(m.state, cmd);
      await sql.query(`update order_milestones set state = $2, evidence_note = coalesce($3, evidence_note), claimed_at = case when $4 then now() else claimed_at end,
          completed_at = case when $5 then now() else completed_at end, completed_by = case when $5 then $6::uuid else completed_by end, version = version + 1, updated_at = now() where id = $1`,
        [m.id, to, body.evidenceNote ?? null, cmd === 'claim', cmd === 'accept', user.id]);
      await sql.query(`insert into milestone_events (id, milestone_id, order_id, project_id, provider_org_id, command, from_state, to_state, reason, actor_user_id, actor_side) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [uuidv7(), m.id, m.order_id, m.project_id, m.provider_org_id, cmd, m.state, to, body.reason ?? body.evidenceNote ?? null, user.id, side.side]);
      const titles: Partial<Record<MilestoneCommand, string>> = { claim: 'A milestone is ready for sign-off', accept: 'A milestone was signed off', reject: 'A milestone was sent back', dispute: 'A milestone is disputed', block: 'A milestone is blocked', cancel: 'A milestone was cancelled' };
      if (titles[cmd]) await tellOther(sql, side, titles[cmd]!, `${ref(side.o)}: ${m.title}${body.reason ? `: ${body.reason}` : ''}`);
      await publish(sql, 'MilestoneChanged', { orderId: m.order_id, milestoneId: m.id, from: m.state, to });
      await audit(sql, { actorUserId: user.id, action: `milestone.${cmd}`, targetType: 'Milestone', targetId: m.id, reason: body.reason ?? null });
      const orderState = await syncContract(sql, m.order_id);
      return { state: to, orderState };
    },
  });

  // ---------------------------------------------------------------- variations (§9.6)
  function parseLines(lines: z.infer<typeof lineSchema>[], currency: string): VariationLine[] {
    return lines.map((l, i) => {
      const rate = parseMajor(l.rate, currency);
      if (rate == null) throw badRequest('VALIDATION_FAILED', 'Check the line rates.', [{ path: `lines.${i}.rate`, message: 'Enter a rate.' }]);
      return { description: l.description, quantity: l.quantity, unit: l.unit, rateMinor: rate };
    });
  }
  const signed = (v: string | undefined | null, currency: string): bigint | null => {
    if (v == null || v === '') return null;
    const neg = v.trim().startsWith('-');
    const m = parseMajor(v.trim().replace(/^-/, ''), currency);
    if (m == null) throw badRequest('VALIDATION_FAILED', 'Enter the cost impact like 150000 or -20000 for an omission.', [{ path: 'costImpact', message: 'Enter an amount.' }]);
    return neg ? -m : m;
  };

  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/variations', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({
      title: z.string().trim().max(160), description: z.string().trim().max(4000), reason: z.string().trim().max(1000),
      costImpact: z.string().max(24).optional(), timeImpactDays: z.number().int().optional(), lines: z.array(lineSchema).max(50).default([]), submit: z.boolean().default(false),
    }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (!(side.side === 'provider' || side.canManage)) throw forbidden();
      const o = side.o;
      if (['cancelled', 'closed', 'placed'].includes(o.state)) throw conflict('INACTIVE', o.state === 'placed' ? 'Variations start once the award is confirmed.' : 'This award is no longer active.');
      const lines = parseLines(body.lines, o.currency);
      const cost = body.lines.length && body.costImpact == null ? variationLinesTotal(lines) : signed(body.costImpact, o.currency);
      const time = body.timeImpactDays ?? null;
      const priced = cost != null && time != null;
      const input = { title: body.title, description: body.description, reason: body.reason, costImpactMinor: cost, timeImpactDays: time, lines };
      const problems = variationProblems(input, side.side === 'provider', cfg);
      if (problems.length) throw unprocessable('VARIATION_INVALID', problems[0]!, { problems });
      const id = uuidv7();
      const n = (await one<{ n: number }>(sql, `select coalesce(max(number), 0)::int + 1 as n from variations where order_id = $1`, [o.id]))!.n;
      // The provider prices every change: its own proposal is assessed at once (and may go straight for the client's
      // decision); a client's proposal waits for the provider's price, so the client never approves a price it set alone.
      let state: VariationState = 'proposed';
      const events: { command: string; from: string | null; to: VariationState }[] = [{ command: 'propose', from: null, to: 'proposed' }];
      if (priced && side.side === 'provider') { events.push({ command: 'assess', from: 'proposed', to: 'impact_assessed' }); state = 'impact_assessed'; }
      if (state === 'impact_assessed' && body.submit) { events.push({ command: 'submit', from: 'impact_assessed', to: 'under_review' }); state = 'under_review'; }
      await sql.query(`insert into variations (id, order_id, project_id, provider_org_id, number, title, description, reason, proposed_side, proposed_by, cost_impact_minor, time_impact_days, lines, state) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14)`,
        [id, o.id, o.project_id, o.provider_org_id, n, body.title, body.description, body.reason, side.side, user.id, cost == null ? null : String(cost), time, JSON.stringify(lines.map((l) => ({ ...l, rateMinor: String(l.rateMinor) }))), state]);
      for (const e of events) {
        await sql.query(`insert into variation_events (id, variation_id, order_id, project_id, provider_org_id, command, from_state, to_state, cost_impact_minor, time_impact_days, note, actor_user_id, actor_side) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [uuidv7(), id, o.id, o.project_id, o.provider_org_id, e.command, e.from, e.to, cost == null ? null : String(cost), time, e.command === 'propose' ? body.reason : null, user.id, side.side]);
      }
      await tellOther(sql, side, state === 'under_review' ? 'A variation needs your decision' : 'A variation was proposed', `${ref(o)}: ${body.title}`);
      await publish(sql, 'VariationSubmitted', { orderId: o.id, variationId: id, state });
      await audit(sql, { actorUserId: user.id, action: 'variation.proposed', targetType: 'Variation', targetId: id, metadata: { orderId: o.id, costImpactMinor: cost == null ? null : String(cost), timeImpactDays: time, state } });
      return { id, number: n, state };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/variations/:id/commands/:command', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), command: z.enum(['assess', 'submit', 'return', 'approve', 'reject', 'withdraw', 'instruct', 'execute', 'value']) }),
    body: z.object({ expectedVersion: z.number().int(), note: z.string().trim().max(2000).optional(), costImpact: z.string().max(24).optional(), timeImpactDays: z.number().int().optional(), lines: z.array(lineSchema).max(50).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const v = await one<Row>(sql, `select * from variations where id = $1`, [params.id]);
      if (!v) throw notFound('Variation');
      const side = await orderSide(sql, user, v.order_id);
      const o = side.o;
      const cmd = params.command as VariationCommand;
      const canApprove = side.side === 'client' && !side.access.viaStaffSession && can(side.access.role, 'variation.approve');
      if (cmd === 'approve' || cmd === 'reject' ? !canApprove : !allowed(VARIATION_ACTOR[cmd], side, v.proposed_side)) throw forbidden(cmd === 'approve' || cmd === 'reject' ? 'Only the project owner decides a variation.' : undefined);
      if (v.version !== body.expectedVersion) throw conflict('STALE', 'This variation changed. Reload and try again.');
      if (!variationMachine.can(v.state, cmd)) throw conflict('INVALID_TRANSITION', `A variation that is ${v.state.replace(/_/g, ' ')} can't do that.`);
      if (['return', 'reject'].includes(cmd) && !body.note) throw badRequest('VALIDATION_FAILED', 'Give a reason.', [{ path: 'note', message: 'Required.' }]);
      let cost = v.cost_impact_minor != null ? BigInt(v.cost_impact_minor) : null;
      let time: number | null = v.time_impact_days;
      let lines = json<Row[]>(v.lines).map((l) => ({ ...l, rateMinor: BigInt(l.rateMinor) })) as VariationLine[];
      if (cmd === 'assess') {
        if (body.lines) lines = parseLines(body.lines, o.currency);
        cost = body.costImpact != null ? signed(body.costImpact, o.currency) : body.lines ? variationLinesTotal(lines) : cost;
        time = body.timeImpactDays ?? time;
        const problems = variationProblems({ title: v.title, description: v.description, reason: v.reason, costImpactMinor: cost, timeImpactDays: time, lines }, true, cfg);
        if (problems.length) throw unprocessable('VARIATION_INVALID', problems[0]!, { problems });
      }
      if (cmd === 'submit' && (cost == null || time == null)) throw unprocessable('NOT_PRICED', 'Price the variation (cost and time) before sending it for a decision.');
      const to = variationMachine.next(v.state, cmd);
      let revisionId: string | null = null;
      if (cmd === 'approve') {
        const rev = await currentRevision(sql, o.id);
        const blockers = approvalBlockers(o.state, rev, BigInt(o.total_minor), { costImpactMinor: cost, timeImpactDays: time }, cfg);
        if (blockers.length) throw conflict('APPROVAL_BLOCKED', blockers[0]!, { blockers });
        const next = nextRevision(rev, { id: v.id, title: v.title, costImpactMinor: cost!, timeImpactDays: time! });
        const snapshot = { kind: 'AwardRevision', orderId: o.id, number: next.number, valueMinor: String(next.valueMinor), timeDays: next.timeDays, completionDate: next.completionDate, variation: { id: v.id, number: v.number, title: v.title, costImpactMinor: String(cost), timeImpactDays: time }, previousHash: (await one<Row>(sql, `select snapshot_hash from award_revisions where id = $1`, [rev.id]))!.snapshot_hash, reason: next.reason };
        revisionId = uuidv7();
        await sql.query(`insert into award_revisions (id, order_id, project_id, provider_org_id, number, variation_id, value_minor, time_days, completion_date, reason, snapshot, snapshot_hash, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`,
          [revisionId, o.id, o.project_id, o.provider_org_id, next.number, v.id, String(next.valueMinor), next.timeDays, next.completionDate, next.reason, JSON.stringify(snapshot), sha256(canonicalJson(snapshot)), user.id]);
        await sql.query(`update orders set contract_value_minor = $2, revision_number = $3, version = version + 1, updated_at = now() where id = $1`, [o.id, String(next.valueMinor), next.number]);
        await publish(sql, 'VariationApproved', { orderId: o.id, variationId: v.id, revision: next.number, valueMinor: String(next.valueMinor) });
      }
      await sql.query(`update variations set state = $2, cost_impact_minor = $3, time_impact_days = $4, lines = $5::jsonb, revision_id = coalesce($6, revision_id),
          decided_by = case when $7 then $8::uuid else decided_by end, decided_at = case when $7 then now() else decided_at end, decision_note = case when $7 then $9 else decision_note end, version = version + 1, updated_at = now() where id = $1`,
        [v.id, to, cost == null ? null : String(cost), time, JSON.stringify(lines.map((l) => ({ ...l, rateMinor: String(l.rateMinor) }))), revisionId, cmd === 'approve' || cmd === 'reject', user.id, body.note ?? null]);
      await sql.query(`insert into variation_events (id, variation_id, order_id, project_id, provider_org_id, command, from_state, to_state, cost_impact_minor, time_impact_days, note, actor_user_id, actor_side) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [uuidv7(), v.id, o.id, o.project_id, o.provider_org_id, cmd, v.state, to, cost == null ? null : String(cost), time, body.note ?? null, user.id, side.side]);
      const titles: Partial<Record<VariationCommand, string>> = { assess: 'A variation was priced', submit: 'A variation needs your decision', return: 'A variation was sent back for a new price', approve: 'A variation was approved', reject: 'A variation was rejected', withdraw: 'A variation was withdrawn', instruct: 'A variation was instructed', execute: 'A variation was carried out' };
      if (titles[cmd]) await tellOther(sql, side, titles[cmd]!, `${ref(o)}: ${v.title}${body.note ? `: ${body.note}` : ''}`);
      await audit(sql, { actorUserId: user.id, action: `variation.${cmd}`, targetType: 'Variation', targetId: v.id, reason: body.note ?? null, metadata: { costImpactMinor: cost == null ? null : String(cost), timeImpactDays: time, revisionId } });
      return { state: to, revisionId };
    },
  });
}

/** Payment against a milestone: only a completed one, and never more than it has left after retention. */
export async function milestonePaymentCheck(sql: Sql, o: Row, milestoneId: string, minor: bigint) {
  const m = (await milestonesOf(sql, o.id)).find((x) => x.id === milestoneId);
  if (!m) throw badRequest('INVALID_REFERENCE', 'That milestone is not on this award.');
  const left = milestonePayable(m, Number(o.retention_pct));
  if (m.state !== 'complete') throw conflict('MILESTONE_NOT_COMPLETE', 'Record a payment against a milestone once it is signed off as complete.');
  if (minor > left) throw unprocessable('OVER_MILESTONE', `This milestone has ${formatMoney({ amountMinor: String(left), currency: o.currency })} left to record after retention.`);
  return m;
}

