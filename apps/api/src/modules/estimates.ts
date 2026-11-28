import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  calcLine, canonicalJson, minorDigits, comparablePrice, estimateMachine, ESTIMATE_ACTOR, formatDec, formatMoney, indicativeRange, MATURITY, parseDec, parseMajor,
  parseQuantityCsv, pickRate, RATE_COMPONENTS, runQa, SOURCE_CLASSES, SOURCE_LABELS, totals, uuidv7, versionDelta,
  type EstimateCommand, type LineInput, type Maturity, type RateObservation, type SourceClass,
} from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Actor, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, unprocessable } from '../platform/platform.js';
import { projectAccess, projectRow } from './projects.js';

/** Estimates, review workflow, catalog and rates, and record-only payments (spec §9.1, §10.3, §11, §14.1). */

const money = (minor: bigint | string | number, currency: string, locale: string) => ({ amountMinor: String(minor), currency, display: formatMoney({ amountMinor: String(minor), currency }, locale) });
const dec = (v: unknown) => parseDec(String(v ?? '0')) ?? 0n;
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

type Row = Record<string, any>;

async function loadVersion(sql: Sql, id: string) {
  const v = await one<Row>(sql, `select v.*, e.maturity, e.title, e.current_version_id from estimate_versions v join estimates e on e.id = v.estimate_id where v.id = $1`, [id]);
  if (!v) throw notFound('Estimate');
  return v;
}

export function toLine(r: Row): LineInput & { key: string; rateCategory: 'volatile' | 'general' | 'labour' } {
  const rates = json<Record<string, string>>(r.rates) ?? {};
  return {
    id: r.id, key: r.line_key, section: r.section, description: r.description, specification: r.specification, unit: r.unit,
    gross: dec(r.gross), deductions: dec(r.deductions), wastePct: Number(r.waste_pct),
    rates: Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, dec(v)])), taxRatePct: Number(r.tax_rate_pct), status: r.status,
    quantitySource: r.quantity_source, measurementIds: r.measurement_ids ?? [], rate: r.rate_source ? json(r.rate_source) : null, rateCategory: r.rate_category,
  };
}

async function linesOf(sql: Sql, versionId: string) {
  return many<Row>(sql, `select * from estimate_lines where version_id = $1 order by position, updated_at`, [versionId]);
}

async function supersededMeasurements(sql: Sql, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await many<{ id: string }>(sql, `select m.id from measurements m join document_revisions r on r.id = m.revision_id where m.id = any($1::uuid[]) and (r.superseded_by_revision_id is not null or m.potentially_affected)`, [ids]);
  return new Set(rows.map((r) => r.id));
}

async function qaFor(sql: Sql, s: Services, v: Row, rows: Row[]) {
  const lines = rows.map(toLine);
  const prev = v.created_from_version_id ? await one<Row>(sql, `select totals from estimate_versions where id = $1`, [v.created_from_version_id]) : null;
  const prevGross = prev?.totals ? BigInt(json<Row>(prev.totals).grossMinor) : null;
  const findings = runQa({
    lines, contingencyPct: Number(v.contingency_pct), assumptions: json(v.assumptions), exclusions: json(v.exclusions),
    supersededMeasurementIds: await supersededMeasurements(sql, lines.flatMap((l) => l.measurementIds)),
    previousGrossMinor: prevGross, changeReason: v.change_reason, requiredSections: ['substructure', 'walls', 'roof', 'finishes'],
    secondReviewDone: v.second_review_done, now: new Date(), cfg: s.pack.projects,
  });
  const acks = await many<Row>(sql, `select * from qa_acknowledgements where version_id = $1`, [v.id]);
  return findings.map((f) => {
    const ack = acks.find((a) => a.code === f.key);
    return { ...f, acknowledged: ack ? { reason: ack.reason, at: iso(ack.created_at) } : null };
  });
}

function lineView(r: Row, s: Services) {
  const l = toLine(r);
  const c = calcLine(l);
  return {
    id: r.id, key: r.line_key, position: r.position, section: r.section, description: r.description, specification: r.specification, unit: r.unit, originalUnit: r.original_unit,
    gross: formatDec(l.gross), deductions: formatDec(l.deductions), wastePct: Number(r.waste_pct), net: formatDec(c.net, 3),
    rates: Object.fromEntries(RATE_COMPONENTS.map((k) => [k, l.rates[k] != null ? majorStr(l.rates[k]!, s.pack.currency) : null])),
    unitRate: majorStr(c.unitRate, s.pack.currency), amount: money(c.amountMinor, s.pack.currency, s.pack.locale), tax: money(c.taxMinor, s.pack.currency, s.pack.locale), taxRatePct: Number(r.tax_rate_pct),
    status: r.status, quantitySource: r.quantity_source, measurementIds: r.measurement_ids ?? [], rateSource: r.rate_source ? { ...json<Row>(r.rate_source), label: SOURCE_LABELS[json<Row>(r.rate_source).sourceClass as SourceClass] } : null,
    rateCategory: r.rate_category, catalogItemId: r.catalog_item_id, notes: r.notes, rowVersion: r.row_version,
  };
}

function totalsView(rows: Row[], v: Row, s: Services) {
  const t = totals(rows.map(toLine), Number(v.contingency_pct));
  const m = (x: bigint) => money(x, v.currency, s.pack.locale);
  return {
    net: m(t.netMinor), contingency: { ...m(t.contingencyMinor), pct: Number(v.contingency_pct) }, tax: { ...m(t.taxMinor), label: s.pack.tax.label }, gross: m(t.grossMinor),
    bySection: Object.entries(t.bySection).map(([code, amt]) => ({ code, label: s.pack.projects.workSections.find((w) => w.code === code)?.label ?? code, amount: m(amt) })),
    calculationVersion: t.calculationVersion, includesTax: true,
  };
}

async function versionView(sql: Sql, s: Services, v: Row, viewer: { role: string; userId: string }) {
  const rows = await linesOf(sql, v.id);
  const maturity = v.maturity as Maturity;
  const issuedSnapshot = v.snapshot ? json<Row>(v.snapshot) : null;
  const reviewer = v.reviewer_user_id ? await one<Row>(sql, `select display_name from users where id = $1`, [v.reviewer_user_id]) : null;
  const reviewerRole = viewer.role === 'reviewer';
  const assignment = reviewerRole ? await one<Row>(sql, `select kind from review_assignments where version_id = $1 and reviewer_user_id = $2 and status = 'active'`, [v.id, viewer.userId]) : null;
  const editable = v.state === 'draft' && maturity === 'client_specified' && ['owner', 'manager', 'collaborator'].includes(viewer.role)
    || ['under_review'].includes(v.state) && maturity === 'reviewed_cost_plan' && assignment?.kind === 'primary';
  return {
    id: v.id, estimateId: v.estimate_id, number: v.number, state: v.state, maturity, label: MATURITY[maturity].label, notice: MATURITY[maturity].notice,
    title: v.title, currency: v.currency, contingencyPct: Number(v.contingency_pct), assumptions: json(v.assumptions), exclusions: json(v.exclusions), changeReason: v.change_reason,
    validUntil: iso(v.valid_until), reviewedAt: iso(v.reviewed_at), issuedAt: iso(v.issued_at), acceptedAt: iso(v.accepted_at),
    reviewer: reviewer ? { name: reviewer.display_name } : null, secondReviewDone: v.second_review_done, snapshotHash: v.snapshot_hash, version: v.version,
    indicative: v.indicative ? json(v.indicative) : null, isCurrent: v.current_version_id === v.id,
    lines: (issuedSnapshot?.lines as Row[] | undefined) ?? rows.map((r) => lineView(r, s)),
    totals: issuedSnapshot?.totals ?? (rows.length ? totalsView(rows, v, s) : null),
    qa: (reviewerRole || v.state === 'reviewed') && maturity === 'reviewed_cost_plan' ? await qaFor(sql, s, v, rows) : null,
    editable, yourReviewRole: assignment?.kind ?? null,
    commands: estimateMachine.commandsFrom(v.state).filter((c) => {
      const actor = ESTIMATE_ACTOR[c];
      if (maturity !== 'reviewed_cost_plan') return false;
      if (actor === 'client') return c === 'accept' ? viewer.role === 'owner' : ['owner', 'manager'].includes(viewer.role);
      if (actor === 'reviewer') return assignment?.kind === 'primary';
      return false;
    }),
    canShare: maturity === 'client_specified' && v.state === 'draft' && ['owner', 'manager'].includes(viewer.role),
  };
}

const lineFields = z.object({
  section: z.string().max(30), description: z.string().trim().min(2).max(300), specification: z.string().trim().max(300).nullable().optional(),
  unit: z.string().max(20), gross: z.string().max(24).optional(), deductions: z.string().max(24).optional(), wastePct: z.number().min(0).max(100).optional(),
  status: z.enum(['measured', 'provisional', 'excluded', 'clarification_required']).optional(),
  quantitySource: z.enum(['measurement', 'client_entered', 'imported', 'provisional_sum']).nullable().optional(),
  measurementIds: z.array(z.uuid()).max(200).optional(), rateCategory: z.enum(['volatile', 'general', 'labour']).optional(),
  rates: z.partialRecord(z.enum(RATE_COMPONENTS), z.string().max(24).nullable()).optional(), notes: z.string().max(1000).nullable().optional(),
});

export function registerEstimates(app: FastifyInstance, s: Services) {
  const cfg = s.pack.projects;

  async function editableVersion(sql: Sql, user: Actor, versionId: string) {
    const v = await loadVersion(sql, versionId);
    const a = await projectAccess(sql, user, v.project_id, 'estimate.read');
    if (a.viaStaffSession) throw forbidden('Staff access is read-only.');
    const view = await versionView(sql, s, v, { role: a.role, userId: user.id });
    if (!view.editable) throw conflict('NOT_EDITABLE', v.state === 'draft' || v.state === 'under_review' ? 'You cannot edit this estimate.' : 'This version is locked. Start a new version to make changes.');
    return v;
  }

  async function applyLineFields(sql: Sql, v: Row, body: z.infer<typeof lineFields>, existing: Row | null) {
    const errs: { path: string; message: string }[] = [];
    if (!cfg.workSections.some((w) => w.code === body.section)) errs.push({ path: 'section', message: 'Choose a work section.' });
    const unit = body.unit;
    let gross = body.gross !== undefined ? parseDec(body.gross) : existing ? dec(existing.gross) : 0n;
    const deductions = body.deductions !== undefined ? parseDec(body.deductions) : existing ? dec(existing.deductions) : 0n;
    if (gross == null || gross < 0n) errs.push({ path: 'gross', message: 'Enter a quantity of zero or more.' });
    if (deductions == null || deductions < 0n) errs.push({ path: 'deductions', message: 'Enter deductions of zero or more.' });
    const measurementIds = body.measurementIds ?? (existing?.measurement_ids ?? []);
    let quantitySource = body.quantitySource !== undefined ? body.quantitySource : existing?.quantity_source ?? (v.maturity === 'client_specified' ? 'client_entered' : null);
    if (body.measurementIds && body.measurementIds.length) {
      const ms = await many<Row>(sql, `select id, value, unit from measurements where id = any($1::uuid[]) and project_id = $2 and deleted_at is null`, [body.measurementIds, v.project_id]);
      if (ms.length !== body.measurementIds.length) errs.push({ path: 'measurementIds', message: 'A measurement is missing or not in this project.' });
      else if (ms.some((m) => m.unit !== unit)) errs.push({ path: 'measurementIds', message: `All measurements must be in ${unit}.` });
      else { gross = ms.reduce((a, m) => a + dec(m.value), 0n); quantitySource = 'measurement'; }
    }
    const rates: Record<string, string> = { ...(existing ? json<Record<string, string>>(existing.rates) : {}) };
    for (const [k, val] of Object.entries(body.rates ?? {})) {
      if (val === null || val === '') { delete rates[k]; continue; }
      const minor = parseMajor(val, v.currency);
      if (minor == null) { errs.push({ path: `rates.${k}`, message: 'Enter a price.' }); continue; }
      rates[k] = String(minor);
    }
    if (errs.length) throw badRequest('VALIDATION_FAILED', 'Check the line.', errs);
    return { unit, gross: gross!, deductions: deductions!, measurementIds, quantitySource, rates, manualRateChanged: !!body.rates && Object.keys(body.rates).length > 0 };
  }

  // ---------------------------------------------------------------- estimates and versions
  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/estimates', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      await projectAccess(sql, user, params.id, 'estimate.read');
      const rows = await many<Row>(sql,
        `select e.*, v.id as version_id, v.number, v.state, v.totals, v.indicative, v.valid_until, v.issued_at from estimates e left join estimate_versions v on v.id = e.current_version_id where e.project_id = $1 order by e.created_at desc`, [params.id]);
      return {
        items: rows.map((e) => ({
          id: e.id, title: e.title, maturity: e.maturity, label: MATURITY[e.maturity as Maturity].label, versionId: e.version_id, number: e.number, state: e.state,
          gross: e.totals ? json<Row>(e.totals).gross : null, indicative: e.indicative ? json(e.indicative) : null, validUntil: iso(e.valid_until), issuedAt: iso(e.issued_at),
        })),
      };
    },
  });

  // An indicative range is saved as its own estimate so it can be referred back to; a new one supersedes the old.
  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/estimates/indicative', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      await projectAccess(sql, user, params.id, 'estimate.edit_client');
      const p = await projectRow(sql, params.id);
      const brief: Row = { ...json<Row>(p.brief), name: p.name, buildingUse: p.building_use, areaCode: p.area_code, regionCode: p.region_code };
      const r = indicativeRange(brief, s.pack, new Date());
      if (!r.ok) throw unprocessable(r.reason.toUpperCase(), r.message, { missing: r.missing ?? [] });
      const old = await many<Row>(sql, `select v.id from estimates e join estimate_versions v on v.id = e.current_version_id where e.project_id = $1 and e.maturity = 'indicative' and v.state = 'generated'`, [params.id]);
      for (const o of old) await sql.query(`update estimate_versions set state = 'superseded', updated_at = now() where id = $1`, [o.id]);
      const eid = uuidv7(); const vid = uuidv7();
      const indicative = {
        low: money(r.lowMinor, p.currency, s.pack.locale), high: money(r.highMinor, p.currency, s.pack.locale),
        perM2: { low: money(r.perM2.lowMinor, p.currency, s.pack.locale), high: money(r.perM2.highMinor, p.currency, s.pack.locale) },
        areaM2: r.areaM2, classLabel: r.classLabel, contingencyPct: r.contingencyPct, benchmark: { source: r.benchmark.source, observedAt: r.benchmark.observedAt, includes: r.benchmark.includes, excludes: r.benchmark.excludes },
        inputs: { floors: brief.floors, finishBand: brief.finishBand, areaCode: brief.areaCode },
      };
      await sql.query(`insert into estimates (id, project_id, maturity, title, current_version_id, created_by) values ($1, $2, 'indicative', 'Indicative range', $3, $4)`, [eid, params.id, vid, user.id]);
      await sql.query(`insert into estimate_versions (id, estimate_id, project_id, number, state, currency, jurisdiction_pack_version, indicative, created_by) values ($1, $2, $3, 1, 'generated', $4, $5, $6::jsonb, $7)`,
        [vid, eid, params.id, p.currency, s.pack.id, JSON.stringify(indicative), user.id]);
      return { estimateId: eid, versionId: vid, indicative };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/estimates', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ maturity: z.enum(['client_specified', 'reviewed_cost_plan']), title: z.string().trim().min(2).max(120) }),
    handler: async ({ sql, params, body, user }) => {
      await projectAccess(sql, user, params.id, body.maturity === 'reviewed_cost_plan' ? 'estimate.request_review' : 'estimate.edit_client');
      const p = await projectRow(sql, params.id);
      const eid = uuidv7(); const vid = uuidv7();
      await sql.query(`insert into estimates (id, project_id, maturity, title, current_version_id, created_by) values ($1, $2, $3, $4, $5, $6)`, [eid, params.id, body.maturity, body.title, vid, user.id]);
      await sql.query(`insert into estimate_versions (id, estimate_id, project_id, number, state, currency, contingency_pct, jurisdiction_pack_version, created_by) values ($1, $2, $3, 1, 'draft', $4, $5, $6, $7)`,
        [vid, eid, params.id, p.currency, body.maturity === 'reviewed_cost_plan' ? cfg.review.minContingencyPct : 0, s.pack.id, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'estimate.created', targetType: 'Estimate', targetId: eid, metadata: { maturity: body.maturity } });
      return { estimateId: eid, versionId: vid };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/estimates/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const e = await one<Row>(sql, `select * from estimates where id = $1`, [params.id]);
      if (!e) throw notFound('Estimate');
      const a = await projectAccess(sql, user, e.project_id, 'estimate.read');
      const versions = await many<Row>(sql, `select id, number, state, totals, issued_at, created_at from estimate_versions where estimate_id = $1 order by number desc`, [e.id]);
      const current = await versionView(sql, s, await loadVersion(sql, e.current_version_id), { role: a.role, userId: user.id });
      return {
        id: e.id, projectId: e.project_id, title: e.title, maturity: e.maturity, role: a.role, current,
        versions: versions.map((v) => ({ id: v.id, number: v.number, state: v.state, gross: v.totals ? json<Row>(v.totals).gross : null, issuedAt: iso(v.issued_at), createdAt: iso(v.created_at) })),
        canNewVersion: ['issued', 'accepted', 'expired', 'shared', 'withdrawn', 'changes_requested'].includes(current.state) && ['owner', 'manager'].includes(a.role) && !a.viaStaffSession,
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/estimate-versions/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const v = await loadVersion(sql, params.id);
      const a = await projectAccess(sql, user, v.project_id, 'estimate.read');
      return versionView(sql, s, v, { role: a.role, userId: user.id });
    },
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/estimate-versions/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({
      expectedVersion: z.number().int().positive(), contingencyPct: z.number().min(0).max(50).optional(),
      assumptions: z.array(z.string().trim().min(2).max(300)).max(50).optional(), exclusions: z.array(z.string().trim().min(2).max(300)).max(50).optional(),
      changeReason: z.string().trim().max(500).nullable().optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const v = await editableVersion(sql, user, params.id);
      if (v.version !== body.expectedVersion) throw conflict('STALE_VERSION', 'Someone else changed this estimate. Reload to see their changes.', { currentVersion: v.version });
      await sql.query(`update estimate_versions set contingency_pct = coalesce($2, contingency_pct), assumptions = coalesce($3::jsonb, assumptions), exclusions = coalesce($4::jsonb, exclusions),
          change_reason = case when $5::boolean then $6 else change_reason end, version = version + 1, updated_at = now() where id = $1`,
        [v.id, body.contingencyPct ?? null, body.assumptions ? JSON.stringify(body.assumptions) : null, body.exclusions ? JSON.stringify(body.exclusions) : null, body.changeReason !== undefined, body.changeReason ?? null]);
      return { version: v.version + 1 };
    },
  });

  // ---------------------------------------------------------------- lines (each line has its own optimistic concurrency, §11.2)
  route(app, s, {
    method: 'POST', url: '/v1/estimate-versions/:id/lines', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: lineFields,
    handler: async ({ sql, params, body, user }) => {
      const v = await editableVersion(sql, user, params.id);
      const f = await applyLineFields(sql, v, body, null);
      const id = uuidv7();
      const pos = (await one<{ n: number }>(sql, `select coalesce(max(position), 0)::int + 1 as n from estimate_lines where version_id = $1`, [v.id]))!.n;
      await sql.query(`insert into estimate_lines (id, version_id, project_id, line_key, position, section, description, specification, unit, gross, deductions, waste_pct, rates, tax_rate_pct, status, quantity_source, rate_source, rate_category, measurement_ids, notes, updated_by)
                       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17::jsonb, $18, $19::uuid[], $20, $21)`,
        [id, v.id, v.project_id, uuidv7(), pos, body.section, body.description, body.specification ?? null, f.unit, formatDec(f.gross), formatDec(f.deductions), body.wastePct ?? 0, JSON.stringify(f.rates), s.pack.tax.ratePercent,
          body.status ?? (v.maturity === 'client_specified' ? 'provisional' : 'measured'), f.quantitySource,
          f.manualRateChanged ? JSON.stringify({ sourceClass: v.maturity === 'client_specified' ? 'manual_estimate' : 'manual_estimate', reference: 'Entered manually', observedAt: new Date().toISOString(), validUntil: null }) : null,
          body.rateCategory ?? 'general', f.measurementIds, body.notes ?? null, user.id]);
      return lineView((await one<Row>(sql, `select * from estimate_lines where id = $1`, [id]))!, s);
    },
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/estimate-lines/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: lineFields.partial().extend({ rowVersion: z.number().int().positive(), rateSourceReference: z.string().max(200).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const l = await one<Row>(sql, `select * from estimate_lines where id = $1`, [params.id]);
      if (!l) throw notFound('Line');
      const v = await editableVersion(sql, user, l.version_id);
      if (l.row_version !== body.rowVersion) {
        throw conflict('LINE_CHANGED', 'Someone else changed this line. Review their version before saving yours.', { current: lineView(l, s) });
      }
      const f = await applyLineFields(sql, v, { section: body.section ?? l.section, description: body.description ?? l.description, unit: body.unit ?? l.unit, ...body }, l);
      const rateSource = f.manualRateChanged ? JSON.stringify({ sourceClass: 'manual_estimate', reference: body.rateSourceReference ?? 'Entered manually', observedAt: new Date().toISOString(), validUntil: null }) : null;
      await sql.query(`update estimate_lines set section = $2, description = $3, specification = $4, unit = $5, gross = $6, deductions = $7, waste_pct = coalesce($8, waste_pct), rates = $9::jsonb,
          status = coalesce($10, status), quantity_source = $11, measurement_ids = $12::uuid[], rate_category = coalesce($13, rate_category), notes = case when $14::boolean then $15 else notes end,
          rate_source = coalesce($16::jsonb, rate_source), row_version = row_version + 1, updated_by = $17, updated_at = now() where id = $1`,
        [l.id, body.section ?? l.section, body.description ?? l.description, body.specification !== undefined ? body.specification : l.specification, f.unit, formatDec(f.gross), formatDec(f.deductions), body.wastePct ?? null,
          JSON.stringify(f.rates), body.status ?? null, f.quantitySource, f.measurementIds, body.rateCategory ?? null, body.notes !== undefined, body.notes ?? null, rateSource, user.id]);
      return lineView((await one<Row>(sql, `select * from estimate_lines where id = $1`, [l.id]))!, s);
    },
  });

  route(app, s, {
    method: 'DELETE', url: '/v1/estimate-lines/:id', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const l = await one<Row>(sql, `select * from estimate_lines where id = $1`, [params.id]);
      if (!l) throw notFound('Line');
      await editableVersion(sql, user, l.version_id);
      await sql.query(`delete from estimate_lines where id = $1`, [l.id]);
      return { deleted: true };
    },
  });

  // Rates come from the catalog with source class and date, by the precedence rules (§11.3).
  route(app, s, {
    method: 'POST', url: '/v1/estimate-lines/:id/apply-rate', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ catalogItemId: z.uuid(), component: z.enum(RATE_COMPONENTS), rowVersion: z.number().int().positive(), observationId: z.uuid().optional(), reconfirm: z.boolean().default(false) }),
    handler: async ({ sql, params, body, user }) => {
      const l = await one<Row>(sql, `select * from estimate_lines where id = $1`, [params.id]);
      if (!l) throw notFound('Line');
      const v = await editableVersion(sql, user, l.version_id);
      if (l.row_version !== body.rowVersion) throw conflict('LINE_CHANGED', 'Someone else changed this line. Reload it first.');
      const p = await projectRow(sql, v.project_id);
      const item = await one<Row>(sql, `select * from catalog_items where id = $1 and status = 'active'`, [body.catalogItemId]);
      if (!item) throw notFound('Catalog item');
      if (item.unit !== l.unit) throw unprocessable('UNIT_MISMATCH', `This item is priced per ${item.unit}; the line is in ${l.unit}.`);
      const obs = (await many<Row>(sql, `select * from rate_observations where catalog_item_id = $1 and region_code = $2 and unit = $3`, [item.id, p.region_code, l.unit])).map(toObservation(item.rate_category));
      const picked = body.observationId ? obs.find((o) => o.id === body.observationId) : pickRate(obs, { catalogItemId: item.id, regionCode: p.region_code, unit: l.unit }, new Date(), cfg).best;
      if (!picked) throw unprocessable('NO_RATE', 'No current rate for this item in this region. Record a rate or enter one manually with its source.');
      if (body.observationId && !body.reconfirm) {
        const best = pickRate(obs, { catalogItemId: item.id, regionCode: p.region_code, unit: l.unit }, new Date(), cfg).best;
        if (best && best.id !== picked.id && SOURCE_CLASSES.indexOf(best.sourceClass) < SOURCE_CLASSES.indexOf(picked.sourceClass)) {
          throw unprocessable('LOWER_SOURCE', `A higher-ranked source (${SOURCE_LABELS[best.sourceClass]}) is available. Confirm the override with a reason.`);
        }
      }
      const rates = { ...json<Record<string, string>>(l.rates), [body.component]: formatDec(picked.rateMinor) };
      const source = { sourceClass: picked.sourceClass, reference: picked.reference, observedAt: picked.observedAt, validUntil: picked.validUntil, observationId: picked.id, catalogItemId: item.id, component: body.component, reconfirmedAt: body.reconfirm ? new Date().toISOString() : null };
      await sql.query(`update estimate_lines set rates = $2::jsonb, rate_source = $3::jsonb, rate_category = $4, catalog_item_id = $5, row_version = row_version + 1, updated_by = $6, updated_at = now() where id = $1`,
        [l.id, JSON.stringify(rates), JSON.stringify(source), item.rate_category, item.id, user.id]);
      return lineView((await one<Row>(sql, `select * from estimate_lines where id = $1`, [l.id]))!, s);
    },
  });

  // Quantity lists come in as client-specified (or reviewer draft) lines, keeping the original unit (§12.1).
  route(app, s, {
    method: 'POST', url: '/v1/estimate-versions/:id/import', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ csv: z.string().min(1).max(2_000_000), defaultSection: z.string().max(30).default('other') }),
    handler: async ({ sql, params, body, user }) => {
      const v = await editableVersion(sql, user, params.id);
      const { rows, errors } = parseQuantityCsv(body.csv, body.defaultSection);
      const known = new Set(cfg.workSections.map((w) => w.code));
      let pos = (await one<{ n: number }>(sql, `select coalesce(max(position), 0)::int as n from estimate_lines where version_id = $1`, [v.id]))!.n;
      for (const r of rows) {
        pos += 1;
        await sql.query(`insert into estimate_lines (id, version_id, project_id, line_key, position, section, description, specification, unit, original_unit, gross, tax_rate_pct, status, quantity_source, notes, updated_by)
                         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'provisional', 'imported', $13, $14)`,
          [uuidv7(), v.id, v.project_id, uuidv7(), pos, known.has(r.section) ? r.section : 'other', r.description, r.specification, r.unit, r.originalUnit, formatDec(r.quantity), s.pack.tax.ratePercent, r.notes, user.id]);
      }
      return { imported: rows.length, errors };
    },
  });

  // ---------------------------------------------------------------- client-specified: share; new versions
  route(app, s, {
    method: 'POST', url: '/v1/estimate-versions/:id/share', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const v = await loadVersion(sql, params.id);
      const a = await projectAccess(sql, user, v.project_id, 'estimate.edit_client');
      if (v.maturity !== 'client_specified' || v.state !== 'draft' || !['owner', 'manager'].includes(a.role)) throw conflict('NOT_SHAREABLE', 'Only a draft client-specified estimate can be shared.');
      const rows = await linesOf(sql, v.id);
      if (!rows.length) throw unprocessable('NO_LINES', 'Add at least one line first.');
      await freeze(sql, s, v, rows, 'shared', user.id);
      return { state: 'shared' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/estimates/:id/versions', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ changeReason: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const e = await one<Row>(sql, `select * from estimates where id = $1`, [params.id]);
      if (!e || e.maturity === 'indicative') throw notFound('Estimate');
      const a = await projectAccess(sql, user, e.project_id, 'estimate.edit_client');
      if (!['owner', 'manager'].includes(a.role)) throw forbidden('Only owners and managers can start a new version.');
      const cur = await loadVersion(sql, e.current_version_id);
      if (!['issued', 'accepted', 'expired', 'shared', 'withdrawn', 'changes_requested'].includes(cur.state)) throw conflict('VERSION_OPEN', 'The current version is still open.');
      const vid = uuidv7();
      await sql.query(`insert into estimate_versions (id, estimate_id, project_id, number, state, currency, contingency_pct, assumptions, exclusions, change_reason, jurisdiction_pack_version, created_from_version_id, created_by)
                       values ($1, $2, $3, $4, 'draft', $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12)`,
        [vid, e.id, e.project_id, cur.number + 1, cur.currency, cur.contingency_pct, JSON.stringify(json(cur.assumptions)), JSON.stringify(json(cur.exclusions)), body.changeReason, s.pack.id, cur.id, user.id]);
      await sql.query(`insert into estimate_lines (id, version_id, project_id, line_key, position, section, description, specification, unit, original_unit, gross, deductions, waste_pct, rates, tax_rate_pct, status, quantity_source, rate_source, rate_category, catalog_item_id, measurement_ids, notes, updated_by)
                       select gen_random_uuid(), $2, project_id, line_key, position, section, description, specification, unit, original_unit, gross, deductions, waste_pct, rates, tax_rate_pct, status, quantity_source, rate_source, rate_category, catalog_item_id, measurement_ids, notes, $3
                         from estimate_lines where version_id = $1`, [cur.id, vid, user.id]);
      if (cur.state === 'changes_requested') await sql.query(`update estimate_versions set state = 'withdrawn', updated_at = now() where id = $1`, [cur.id]);
      await sql.query(`update estimates set current_version_id = $2 where id = $1`, [e.id, vid]);
      return { versionId: vid, number: cur.number + 1 };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/estimate-versions/:id/delta', auth: 'user',
    params: z.object({ id: z.uuid() }),
    query: z.object({ against: z.uuid().optional() }),
    handler: async ({ sql, params, query, user }) => {
      const v = await loadVersion(sql, params.id);
      await projectAccess(sql, user, v.project_id, 'estimate.read');
      const otherId = query.against ?? v.created_from_version_id;
      if (!otherId) return { rows: [], before: null, after: null, against: null };
      const o = await loadVersion(sql, otherId);
      if (o.estimate_id !== v.estimate_id) throw badRequest('INVALID_REFERENCE', 'Compare versions of the same estimate.');
      const d = versionDelta((await linesOf(sql, o.id)).map(toLine), (await linesOf(sql, v.id)).map(toLine));
      const m = (x: bigint) => money(x, v.currency, s.pack.locale);
      return { against: { id: o.id, number: o.number }, before: m(d.beforeMinor), after: m(d.afterMinor), change: m(d.afterMinor - d.beforeMinor), rows: d.rows.map((r) => ({ ...r, before: r.before && { ...r.before, amount: m(BigInt(r.before.amountMinor)) }, after: r.after && { ...r.after, amount: m(BigInt(r.after.amountMinor)) } })), changeReason: v.change_reason };
    },
  });

  // ---------------------------------------------------------------- reviewed estimate workflow (§9.1)
  route(app, s, {
    method: 'POST', url: '/v1/estimate-versions/:id/commands/:command', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), command: z.enum(['submit', 'request_information', 'request_changes', 'resume', 'complete_review', 'issue', 'accept', 'withdraw']) }),
    body: z.object({ expectedVersion: z.number().int().positive(), message: z.string().trim().max(4000).optional(), lineId: z.uuid().optional() }),
    handler: async ({ sql, params, body, user }) => {
      const v = await loadVersion(sql, params.id);
      if (v.maturity !== 'reviewed_cost_plan') throw conflict('INVALID_TRANSITION', 'This estimate does not go through review.');
      const cmd = params.command as EstimateCommand;
      const a = await projectAccess(sql, user, v.project_id, 'estimate.read');
      if (a.viaStaffSession) throw forbidden('Staff access is read-only.');
      if (v.version !== body.expectedVersion) throw conflict('STALE_VERSION', 'This estimate changed. Reload it first.', { currentVersion: v.version });
      if (!estimateMachine.can(v.state, cmd)) throw conflict('INVALID_TRANSITION', `A ${v.state.replace(/_/g, ' ')} estimate can't be ${cmd.replace(/_/g, ' ')}.`);
      const actor = ESTIMATE_ACTOR[cmd];
      const assignment = await one<Row>(sql, `select * from review_assignments where version_id = $1 and reviewer_user_id = $2 and status = 'active'`, [v.id, user.id]);
      if (actor === 'reviewer' && assignment?.kind !== 'primary') throw notFound('Estimate');
      if (actor === 'client') {
        const need = cmd === 'accept' ? 'estimate.accept' : 'estimate.request_review';
        await projectAccess(sql, user, v.project_id, need);
      }
      const owners = async () => (await many<{ user_id: string }>(sql, `select user_id from project_members where project_id = $1 and role in ('owner', 'manager')`, [v.project_id])).map((x) => x.user_id);
      const to = estimateMachine.next(v.state, cmd);
      const extra: string[] = []; const xp: unknown[] = [];

      if (cmd === 'submit') {
        const drawings = await one<{ n: number }>(sql, `select count(*)::int as n from documents d join document_revisions r on r.id = d.current_revision_id where d.project_id = $1 and d.doc_type = 'drawing' and r.state = 'available'`, [v.project_id]);
        if (!drawings?.n) throw unprocessable('NO_DRAWINGS', 'Upload at least one drawing before requesting a reviewed estimate.');
        await publish(sql, 'EstimateSubmitted', { projectId: v.project_id, versionId: v.id });
      }
      if (cmd === 'request_information' || cmd === 'request_changes') {
        if (!body.message) throw badRequest('MESSAGE_REQUIRED', 'Say what is needed.');
        const n = (await one<{ n: number }>(sql, `select coalesce(max(number), 0)::int + 1 as n from rfis where project_id = $1`, [v.project_id]))!.n;
        const rfiId = uuidv7();
        await sql.query(`insert into rfis (id, project_id, number, subject, estimate_line_id, created_by) values ($1, $2, $3, $4, $5, $6)`,
          [rfiId, v.project_id, n, cmd === 'request_information' ? 'Information needed for your estimate' : 'Changes needed for your estimate', body.lineId ?? null, user.id]);
        await sql.query(`insert into rfi_entries (id, rfi_id, project_id, kind, body, author) values ($1, $2, $3, 'question', $4, $5)`, [uuidv7(), rfiId, v.project_id, body.message, user.id]);
        await notify(sql, await owners(), { kind: 'estimate', title: cmd === 'request_information' ? 'Your reviewer needs information' : 'Your reviewer asked for changes', body: body.message.slice(0, 160), link: `/projects/${v.project_id}/rfis/${rfiId}` });
        await publish(sql, 'EstimateInformationRequired', { projectId: v.project_id, versionId: v.id, rfiId });
      }
      if (cmd === 'complete_review' || cmd === 'issue') {
        const rows = await linesOf(sql, v.id);
        const qa = await qaFor(sql, s, v, rows);
        // The second review sits between `reviewed` and `issue` (§9.1), so it only blocks issuing.
        const blockers = qa.filter((f) => f.severity === 'blocker' && (cmd === 'issue' || f.code !== 'second_review_required'));
        if (blockers.length) throw unprocessable('QA_BLOCKERS', 'Fix the blocking checks first.', { findings: blockers });
        const unack = qa.filter((f) => f.severity === 'warning' && !f.acknowledged);
        if (unack.length) throw unprocessable('QA_WARNINGS', 'Acknowledge each warning with a reason.', { findings: unack });
        // The reviewer must hold a current qualification for this project class (§9.1 issue guard).
        const p = await projectRow(sql, v.project_id);
        const cls = s.pack.projects.buildingUses.find((u) => u.code === p.building_use)?.classCodes ?? [];
        const q = await one(sql, `select 1 from reviewer_qualifications where user_id = $1 and class_code = any($2::text[]) and (valid_until is null or valid_until >= current_date)`, [user.id, cls]);
        if (!q) throw forbidden('You need a current reviewer qualification for this type of project.');
        if (cmd === 'complete_review') { extra.push('reviewed_at = now()', `reviewer_user_id = $${xp.push(user.id) + 2}`); }
        if (cmd === 'issue') {
          await freeze(sql, s, v, rows, 'issued', user.id);
          await sql.query(`update projects set currency_locked = true where id = $1`, [v.project_id]);
          const others = await many<{ id: string }>(sql, `select id from estimate_versions where estimate_id = $1 and id <> $2 and state in ('issued', 'accepted', 'expired')`, [v.estimate_id, v.id]);
          for (const o of others) await sql.query(`update estimate_versions set state = 'superseded', updated_at = now() where id = $1`, [o.id]);
          await sql.query(`update review_assignments set status = 'completed', completed_at = now() where version_id = $1 and status = 'active'`, [v.id]);
          await notify(sql, await owners(), { kind: 'estimate', title: 'Your reviewed estimate is ready', body: `${v.title}, version ${v.number}`, link: `/projects/${v.project_id}/estimates/${v.estimate_id}` });
          await publish(sql, 'EstimateIssued', { projectId: v.project_id, versionId: v.id });
          await audit(sql, { actorUserId: user.id, action: 'estimate.issued', targetType: 'EstimateVersion', targetId: v.id });
          return { state: 'issued' };
        }
      }
      if (cmd === 'accept') {
        if (v.valid_until && new Date(v.valid_until) < new Date()) throw conflict('EXPIRED', 'This estimate has expired. Ask for it to be repriced.');
        extra.push('accepted_at = now()', `accepted_by = $${xp.push(user.id) + 2}`);
        await publish(sql, 'EstimateAccepted', { projectId: v.project_id, versionId: v.id });
      }
      await sql.query(`update estimate_versions set state = $2${extra.map((x) => `, ${x}`).join('')}, version = version + 1, updated_at = now() where id = $1`, [v.id, to, ...xp]);
      if (cmd === 'withdraw') await sql.query(`update review_assignments set status = 'released' where version_id = $1 and status = 'active'`, [v.id]);
      await audit(sql, { actorUserId: user.id, action: `estimate.${cmd}`, targetType: 'EstimateVersion', targetId: v.id, reason: body.message ?? null });
      return { state: to };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/estimate-versions/:id/qa-acknowledgements', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ key: z.string().max(120), reason: z.string().trim().min(5).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const v = await loadVersion(sql, params.id);
      const as = await one<Row>(sql, `select kind from review_assignments where version_id = $1 and reviewer_user_id = $2 and status = 'active'`, [v.id, user.id]);
      if (as?.kind !== 'primary') throw notFound('Estimate');
      const f = (await qaFor(sql, s, v, await linesOf(sql, v.id))).find((x) => x.key === body.key);
      if (!f) throw notFound('Finding');
      if (f.severity === 'blocker') throw unprocessable('BLOCKER', 'Blocking checks cannot be acknowledged; fix them.');
      await sql.query(`insert into qa_acknowledgements (version_id, code, line_id, reason, acknowledged_by) values ($1, $2, $3, $4, $5)`, [v.id, f.key, f.lineId, body.reason, user.id]);
      return { acknowledged: true };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/estimate-versions/:id/second-review', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ approve: z.boolean(), note: z.string().trim().min(5).max(2000) }),
    handler: async ({ sql, params, body, user }) => {
      const v = await loadVersion(sql, params.id);
      const as = await one<Row>(sql, `select kind from review_assignments where version_id = $1 and reviewer_user_id = $2 and status = 'active'`, [v.id, user.id]);
      if (as?.kind !== 'second') throw notFound('Estimate');
      if (!['under_review', 'reviewed'].includes(v.state)) throw conflict('INVALID_TRANSITION', 'The estimate is not in review.');
      await sql.query(`update estimate_versions set second_review_done = $2, second_reviewer_user_id = $3, updated_at = now() where id = $1`, [v.id, body.approve, user.id]);
      await sql.query(`update review_assignments set status = 'completed', completed_at = now() where version_id = $1 and reviewer_user_id = $2 and kind = 'second'`, [v.id, user.id]);
      await audit(sql, { actorUserId: user.id, action: body.approve ? 'estimate.second_review_approved' : 'estimate.second_review_rejected', targetType: 'EstimateVersion', targetId: v.id, reason: body.note });
      return { secondReviewDone: body.approve };
    },
  });

  // Customer report: what the client sees and can download (MVP §5 labels).
  route(app, s, {
    method: 'GET', url: '/v1/estimate-versions/:id/report', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const v = await loadVersion(sql, params.id);
      const a = await projectAccess(sql, user, v.project_id, 'estimate.read');
      const p = await projectRow(sql, v.project_id);
      const view = await versionView(sql, s, v, { role: a.role, userId: user.id });
      const snap = v.snapshot ? json<Row>(v.snapshot) : null;
      return {
        project: { name: p.name, area: p.area_code }, ...view,
        documents: snap?.documents ?? [], packVersion: v.jurisdiction_pack_version, illustrative: s.pack.illustrative,
        statement: v.maturity === 'reviewed_cost_plan'
          ? 'Reviewed for the scope, drawings and basis stated. Not a guarantee of final cost, and not a design, structural or permit approval.'
          : v.maturity === 'client_specified' ? 'Quantities and specifications were entered by the client and have not been reviewed by BuildWise.' : 'Indicative only.',
      };
    },
  });

  // ---------------------------------------------------------------- reviewer queue and assignment (staff)
  route(app, s, {
    method: 'GET', url: '/v1/review/queue', auth: 'staff', systemContext: true,
    handler: async ({ sql, user }) => {
      if (!['qs_reviewer', 'ops_admin'].includes(user.staffRole ?? '')) throw forbidden();
      const waiting = await many<Row>(sql,
        `select v.id, v.estimate_id, v.number, v.state, v.created_at, v.updated_at, e.title, p.id as project_id, p.name as project_name, p.building_use, p.area_code,
                (select count(*)::int from documents d where d.project_id = p.id) as documents
           from estimate_versions v join estimates e on e.id = v.estimate_id join projects p on p.id = v.project_id
          where e.maturity = 'reviewed_cost_plan' and v.state = 'submitted' order by v.updated_at`);
      // Estimates over the value threshold that still need a second reviewer (§9.1).
      const needSecond = await many<Row>(sql,
        `select v.id, v.estimate_id, v.number, v.state, v.updated_at, v.reviewer_user_id, e.title, p.id as project_id, p.name as project_name, u.display_name as reviewer_name
           from estimate_versions v join estimates e on e.id = v.estimate_id join projects p on p.id = v.project_id left join users u on u.id = v.reviewer_user_id
          where e.maturity = 'reviewed_cost_plan' and v.state in ('under_review', 'reviewed') and not v.second_review_done
            and not exists (select 1 from review_assignments a where a.version_id = v.id and a.kind = 'second' and a.status = 'active') order by v.updated_at`);
      const secondCandidates: Row[] = [];
      for (const v of needSecond) {
        const rows = await linesOf(sql, v.id);
        const vv = await loadVersion(sql, v.id);
        if (totals(rows.map(toLine), Number(vv.contingency_pct)).grossMinor > BigInt(cfg.review.secondReviewAboveMinor)) secondCandidates.push(v);
      }
      const mine = await many<Row>(sql,
        `select v.id, v.estimate_id, v.number, v.state, v.updated_at, e.title, p.id as project_id, p.name as project_name, a.kind
           from review_assignments a join estimate_versions v on v.id = a.version_id join estimates e on e.id = v.estimate_id join projects p on p.id = v.project_id
          where a.reviewer_user_id = $1 and a.status = 'active' order by v.updated_at`, [user.id]);
      const quals = await many<Row>(sql, `select class_code, credential, valid_until from reviewer_qualifications where user_id = $1`, [user.id]);
      return {
        needSecondReviewer: secondCandidates.map((w) => ({ versionId: w.id, estimateId: w.estimate_id, title: w.title, number: w.number, state: w.state, projectId: w.project_id, projectName: w.project_name, primaryReviewer: w.reviewer_name, updatedAt: iso(w.updated_at) })),
        waiting: waiting.map((w) => ({ versionId: w.id, estimateId: w.estimate_id, title: w.title, number: w.number, projectId: w.project_id, projectName: w.project_name, buildingUse: w.building_use, areaCode: w.area_code, documents: w.documents, waitingSince: iso(w.updated_at) })),
        mine: mine.map((m) => ({ versionId: m.id, estimateId: m.estimate_id, title: m.title, number: m.number, state: m.state, projectId: m.project_id, projectName: m.project_name, kind: m.kind, updatedAt: iso(m.updated_at) })),
        qualifications: quals.map((q) => ({ classCode: q.class_code, credential: q.credential, validUntil: q.valid_until ? iso(q.valid_until)!.slice(0, 10) : null })),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/review/assignments', auth: 'staff', systemContext: true,
    body: z.object({ versionId: z.uuid(), reviewerUserId: z.uuid(), kind: z.enum(['primary', 'second']) }),
    handler: async ({ sql, body, user }) => {
      if (!['qs_reviewer', 'ops_admin'].includes(user.staffRole ?? '')) throw forbidden();
      const v = await loadVersion(sql, body.versionId);
      const reviewer = await one<Row>(sql, `select id, is_staff, staff_role from users where id = $1 and status = 'active'`, [body.reviewerUserId]);
      if (!reviewer?.is_staff || reviewer.staff_role !== 'qs_reviewer') throw unprocessable('NOT_A_REVIEWER', 'Assign a staff reviewer.');
      const existing = await one<Row>(sql, `select role from project_members where project_id = $1 and user_id = $2`, [v.project_id, reviewer.id]);
      if (existing && existing.role !== 'reviewer') throw conflict('CONFLICT_OF_INTEREST', 'This reviewer is already on the project in another role.');
      if (body.kind === 'primary') {
        if (v.state !== 'submitted') throw conflict('INVALID_TRANSITION', 'Only submitted estimates can be assigned.');
        await sql.query(`update estimate_versions set state = 'under_review', reviewer_user_id = $2, version = version + 1, updated_at = now() where id = $1`, [v.id, reviewer.id]);
      } else {
        if (!['under_review', 'reviewed'].includes(v.state)) throw conflict('INVALID_TRANSITION', 'A second reviewer joins while the estimate is in review.');
        const primary = await one<Row>(sql, `select reviewer_user_id from review_assignments where version_id = $1 and kind = 'primary' and status = 'active'`, [v.id]);
        if (primary?.reviewer_user_id === reviewer.id) throw conflict('SAME_REVIEWER', 'The second reviewer must be a different person.');
      }
      await sql.query(`update review_assignments set status = 'released' where version_id = $1 and kind = $2 and status = 'active'`, [v.id, body.kind]);
      await sql.query(`insert into review_assignments (id, version_id, project_id, reviewer_user_id, kind, assigned_by) values ($1, $2, $3, $4, $5, $6)`, [uuidv7(), v.id, v.project_id, reviewer.id, body.kind, user.id]);
      await sql.query(`insert into project_members (project_id, user_id, role, added_by) values ($1, $2, 'reviewer', $3) on conflict (project_id, user_id) do nothing`, [v.project_id, reviewer.id, user.id]);
      await notify(sql, [reviewer.id], { kind: 'review', title: body.kind === 'primary' ? 'Estimate assigned to you' : 'Second review assigned to you', body: v.title, link: `/projects/${v.project_id}/estimates/${v.estimate_id}` });
      await publish(sql, 'EstimateReviewAssigned', { projectId: v.project_id, versionId: v.id, reviewerUserId: reviewer.id, kind: body.kind });
      await audit(sql, { actorUserId: user.id, action: 'estimate.assigned', targetType: 'EstimateVersion', targetId: v.id, metadata: { reviewer: reviewer.id, kind: body.kind } });
      return { assigned: true };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/review/reviewers', auth: 'staff', systemContext: true,
    handler: async ({ sql }) => ({
      items: (await many<Row>(sql, `select u.id, u.display_name, (select count(*)::int from review_assignments a where a.reviewer_user_id = u.id and a.status = 'active') as active from users u where u.is_staff and u.staff_role = 'qs_reviewer' and u.status = 'active' order by u.display_name`))
        .map((u) => ({ id: u.id, name: u.display_name, activeAssignments: u.active })),
    }),
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/reviewer-qualifications', auth: 'staff', systemContext: true,
    body: z.object({ userId: z.uuid(), classCode: z.string().max(40), credential: z.string().trim().min(3).max(200), validUntil: z.iso.date().optional() }),
    handler: async ({ sql, body, user }) => {
      if (user.staffRole !== 'ops_admin') throw forbidden('Only operations admins record reviewer qualifications.');
      if (!s.pack.projects.classes.some((c) => c.code === body.classCode)) throw badRequest('VALIDATION_FAILED', 'Unknown project class.');
      const id = uuidv7();
      await sql.query(`insert into reviewer_qualifications (id, user_id, class_code, credential, valid_until, recorded_by) values ($1, $2, $3, $4, $5, $6)`, [id, body.userId, body.classCode, body.credential, body.validUntil ?? null, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'reviewer.qualification_recorded', targetType: 'User', targetId: body.userId, metadata: { classCode: body.classCode } });
      return { id };
    },
  });

  // ---------------------------------------------------------------- catalog and rates (§11.3)
  route(app, s, {
    method: 'GET', url: '/v1/catalog', auth: 'user',
    query: z.object({ q: z.string().max(80).optional(), region: z.string().max(20).optional(), unit: z.string().max(20).optional() }),
    handler: async ({ sql, query }) => {
      const items = await many<Row>(sql, `select * from catalog_items where status = 'active' and ($1::text is null or name ilike '%' || $1 || '%' or code ilike '%' || $1 || '%') and ($2::text is null or unit = $2) order by section, name limit 100`, [query.q ?? null, query.unit ?? null]);
      const obs = items.length ? await many<Row>(sql, `select o.* from rate_observations o where o.catalog_item_id = any($1::uuid[]) and ($2::text is null or region_code = $2)`, [items.map((i) => i.id), query.region ?? null]) : [];
      const now = new Date();
      return {
        items: items.map((i) => {
          const mine = obs.filter((o) => o.catalog_item_id === i.id).map(toObservation(i.rate_category));
          const best = query.region ? pickRate(mine, { catalogItemId: i.id, regionCode: query.region, unit: i.unit }, now, cfg).best : null;
          return { id: i.id, code: i.code, name: i.name, section: i.section, unit: i.unit, rateCategory: i.rate_category, specification: i.specification,
            bestRate: best ? { observationId: best.id, rate: money(divMinor(best.rateMinor), s.pack.currency, s.pack.locale), sourceClass: best.sourceClass, sourceLabel: SOURCE_LABELS[best.sourceClass], observedAt: best.observedAt } : null,
            observations: mine.length };
        }),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/catalog/:id/rates', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params }) => {
      const item = await one<Row>(sql, `select * from catalog_items where id = $1`, [params.id]);
      if (!item) throw notFound('Catalog item');
      const obs = await many<Row>(sql, `select * from rate_observations where catalog_item_id = $1 order by observed_at desc limit 200`, [item.id]);
      const now = new Date();
      return {
        item: { id: item.id, code: item.code, name: item.name, unit: item.unit, rateCategory: item.rate_category },
        observations: obs.map(toObservation(item.rate_category)).map((o) => {
          const exp = new Date(new Date(o.observedAt).getTime() + cfg.rateFreshnessDays[o.rateCategory] * 86_400_000);
          return { id: o.id, region: o.regionCode, unit: o.unit, sourceClass: o.sourceClass, sourceLabel: SOURCE_LABELS[o.sourceClass], rate: money(divMinor(o.rateMinor), s.pack.currency, s.pack.locale), observedAt: o.observedAt, validUntil: o.validUntil, fresh: exp > now && (!o.validUntil || new Date(o.validUntil) > now), includesDelivery: o.includesDelivery, includesTax: o.includesTax, reference: o.reference };
        }),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/catalog-items', auth: 'staff', systemContext: true,
    body: z.object({ code: z.string().trim().regex(/^[a-z0-9-]{2,40}$/), name: z.string().trim().min(2).max(160), section: z.string().max(30), unit: z.string().max(20), rateCategory: z.enum(['volatile', 'general', 'labour']), specification: z.string().max(300).optional() }),
    handler: async ({ sql, body, user }) => {
      if (user.staffRole !== 'ops_admin') throw forbidden('Only operations admins manage the catalog.');
      if (await one(sql, `select 1 from catalog_items where code = $1`, [body.code])) throw conflict('CODE_EXISTS', 'That code is already used.');
      const id = uuidv7();
      await sql.query(`insert into catalog_items (id, code, name, section, unit, rate_category, specification, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`, [id, body.code, body.name, body.section, body.unit, body.rateCategory, body.specification ?? null, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'catalog.item_created', targetType: 'CatalogItem', targetId: id });
      return { id };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/rate-observations', auth: 'staff', systemContext: true,
    body: z.object({
      catalogItemId: z.uuid(), regionCode: z.string().max(20), sourceClass: z.enum(SOURCE_CLASSES), rate: z.string().max(24),
      observedAt: z.iso.date(), validUntil: z.iso.date().optional(), includesDelivery: z.boolean().default(false), includesTax: z.boolean().default(false), reference: z.string().trim().min(3).max(300),
    }),
    handler: async ({ sql, body, user }) => {
      if (!['ops_admin', 'qs_reviewer'].includes(user.staffRole ?? '')) throw forbidden();
      const item = await one<Row>(sql, `select * from catalog_items where id = $1`, [body.catalogItemId]);
      if (!item) throw notFound('Catalog item');
      if (!s.pack.regions.some((r) => r.code === body.regionCode)) throw badRequest('VALIDATION_FAILED', 'Unknown region.');
      const minor = parseMajor(body.rate, s.pack.currency);
      if (minor == null || minor <= 0n) throw badRequest('VALIDATION_FAILED', 'Enter the rate.', [{ path: 'rate', message: 'Enter the rate.' }]);
      if (new Date(body.observedAt) > new Date()) throw badRequest('VALIDATION_FAILED', 'The observation date cannot be in the future.');
      const id = uuidv7();
      await sql.query(`insert into rate_observations (id, catalog_item_id, region_code, unit, source_class, rate_minor, currency, observed_at, valid_until, includes_delivery, includes_tax, reference, recorded_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [id, item.id, body.regionCode, item.unit, body.sourceClass, String(minor), s.pack.currency, body.observedAt, body.validUntil ?? null, body.includesDelivery, body.includesTax, body.reference, user.id]);
      await publish(sql, 'RateObserved', { catalogItemId: item.id, observationId: id, sourceClass: body.sourceClass });
      return { id };
    },
  });

  // Website prices become rate evidence: only live listings with a fresh price and a comparable unit (§3.17, §11.3).
  route(app, s, {
    method: 'POST', url: '/v1/admin/rate-observations/from-listings', auth: 'staff', systemContext: true,
    body: z.object({ catalogItemId: z.uuid(), categorySlug: z.string().max(60) }),
    handler: async ({ sql, body, user }) => {
      if (!['ops_admin', 'qs_reviewer'].includes(user.staffRole ?? '')) throw forbidden();
      const item = await one<Row>(sql, `select * from catalog_items where id = $1`, [body.catalogItemId]);
      if (!item) throw notFound('Catalog item');
      const ls = await many<Row>(sql, `select id, title, price_minor, unit, pack_value, pack_unit, region_code, price_confirmed_at from listings
          where status = 'live' and expires_at > now() and category_slug = $1 and price_minor is not null and price_confirmed_at > now() - make_interval(days => $2)`, [body.categorySlug, s.pack.policy.priceFreshDays]);
      let added = 0;
      for (const l of ls) {
        let rateMinor: bigint | null = null;
        if (l.unit === item.unit) rateMinor = BigInt(l.price_minor) * 1_000_000n;
        else {
          const c = comparablePrice(BigInt(l.price_minor), l.unit, l.pack_value ? { value: Number(l.pack_value), unit: l.pack_unit } : null);
          if (c.perBaseMinor != null && c.baseUnit === item.unit) rateMinor = BigInt(Math.round(c.perBaseMinor * 1_000_000));
        }
        if (rateMinor == null) continue;
        const ref = `Listing ${l.id}`;
        if (await one(sql, `select 1 from rate_observations where catalog_item_id = $1 and reference = $2 and observed_at = $3`, [item.id, ref, l.price_confirmed_at])) continue;
        await sql.query(`insert into rate_observations (id, catalog_item_id, region_code, unit, source_class, rate_minor, currency, observed_at, includes_delivery, includes_tax, reference, recorded_by) values ($1, $2, $3, $4, 'advertised_listing_price', $5, $6, $7, false, true, $8, $9)`,
          [uuidv7(), item.id, l.region_code, item.unit, formatDec(rateMinor), s.pack.currency, l.price_confirmed_at, ref, user.id]);
        added += 1;
      }
      return { considered: ls.length, added };
    },
  });

  // ---------------------------------------------------------------- record-only payments (§14.1)
  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/payments', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const a = await projectAccess(sql, user, params.id, 'payments.read');
      const rows = await many<Row>(sql, `select r.*, u.display_name as recorder, k.display_name as acknowledger from payment_records r join users u on u.id = r.recorded_by left join users k on k.id = r.acknowledged_by where r.project_id = $1 order by r.paid_on desc, r.created_at desc`, [params.id]);
      const active = rows.filter((r) => !r.voided_at);
      const total = active.reduce((sum, r) => sum + BigInt(r.amount_minor), 0n);
      return {
        notice: 'These are records of payments made outside BuildWise. BuildWise did not process or protect these payments.',
        total: money(total, s.pack.currency, s.pack.locale),
        items: rows.map((r) => ({
          id: r.id, payee: r.payee, description: r.description, amount: money(r.amount_minor, r.currency, s.pack.locale), paidOn: iso(r.paid_on)!.slice(0, 10), method: r.method, reference: r.reference,
          proofRevisionId: r.proof_revision_id, recordedBy: r.recorder, acknowledgedBy: r.acknowledger, acknowledgedAt: iso(r.acknowledged_at), voided: r.voided_at ? { at: iso(r.voided_at), reason: r.void_reason } : null,
          canAcknowledge: !r.voided_at && !r.acknowledged_at && r.recorded_by !== user.id && ['owner', 'manager'].includes(a.role),
        })),
        canRecord: !a.viaStaffSession && ['owner', 'manager'].includes(a.role),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/payments', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ payee: z.string().trim().min(2).max(160), description: z.string().trim().min(2).max(300), amount: z.string().max(24), paidOn: z.iso.date(), method: z.enum(['bank_transfer', 'cash', 'card', 'mobile_money', 'cheque', 'other']), reference: z.string().trim().max(120).optional(), proofRevisionId: z.uuid().optional() }),
    handler: async ({ sql, params, body, user }) => {
      await projectAccess(sql, user, params.id, 'payments.record');
      const minor = parseMajor(body.amount, s.pack.currency);
      if (minor == null || minor <= 0n) throw badRequest('VALIDATION_FAILED', 'Enter the amount paid.', [{ path: 'amount', message: 'Enter the amount paid.' }]);
      if (new Date(body.paidOn) > new Date()) throw badRequest('VALIDATION_FAILED', 'The payment date cannot be in the future.', [{ path: 'paidOn', message: 'The payment date cannot be in the future.' }]);
      if (body.proofRevisionId && !(await one(sql, `select 1 from document_revisions where id = $1 and project_id = $2`, [body.proofRevisionId, params.id]))) throw badRequest('INVALID_REFERENCE', 'That proof is not in this project.');
      const id = uuidv7();
      await sql.query(`insert into payment_records (id, project_id, payee, description, amount_minor, currency, paid_on, method, reference, proof_revision_id, recorded_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, params.id, body.payee, body.description, String(minor), s.pack.currency, body.paidOn, body.method, body.reference ?? null, body.proofRevisionId ?? null, user.id]);
      await publish(sql, 'PaymentRecorded', { projectId: params.id, paymentRecordId: id });
      await audit(sql, { actorUserId: user.id, action: 'payment.recorded', targetType: 'PaymentRecord', targetId: id });
      return { id };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/payment-records/:id/:action', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), action: z.enum(['acknowledge', 'void']) }),
    body: z.object({ reason: z.string().trim().min(3).max(300).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Row>(sql, `select * from payment_records where id = $1`, [params.id]);
      if (!r) throw notFound('Payment record');
      const a = await projectAccess(sql, user, r.project_id, 'payments.read');
      if (a.viaStaffSession || !['owner', 'manager'].includes(a.role)) throw forbidden();
      if (r.voided_at) throw conflict('VOIDED', 'This record was voided.');
      if (params.action === 'acknowledge') {
        if (r.recorded_by === user.id) throw forbidden('Someone other than the recorder must acknowledge a payment.');
        await sql.query(`update payment_records set acknowledged_by = $2, acknowledged_at = now() where id = $1 and acknowledged_at is null`, [r.id, user.id]);
      } else {
        if (!body.reason) throw badRequest('REASON_REQUIRED', 'Say why this record is void.');
        await sql.query(`update payment_records set voided_at = now(), void_reason = $2 where id = $1`, [r.id, body.reason]);
      }
      await audit(sql, { actorUserId: user.id, action: `payment.${params.action}`, targetType: 'PaymentRecord', targetId: r.id, reason: body.reason ?? null });
      return { ok: true };
    },
  });
}

const divMinor = (scaled: bigint) => (scaled + 500_000n) / 1_000_000n;
/** Scaled minor units → a major-unit decimal string for display and editing ("11000", "12.5"). */
const majorStr = (scaledMinor: bigint, currency: string) => formatDec(scaledMinor / 10n ** BigInt(minorDigits(currency)), 2);

function toObservation(rateCategory: 'volatile' | 'general' | 'labour') {
  return (o: Row): RateObservation => ({
    id: o.id, catalogItemId: o.catalog_item_id, regionCode: o.region_code, unit: o.unit, sourceClass: o.source_class, rateMinor: dec(o.rate_minor),
    observedAt: iso(o.observed_at)!, validUntil: iso(o.valid_until), rateCategory, includesDelivery: o.includes_delivery, includesTax: o.includes_tax, reference: o.reference,
  });
}

/**
 * Freezes a version into an immutable snapshot (§8.6): lines with their calculations, totals, rate sources, and the
 * document revisions every measurement came from. The SHA-256 of its canonical JSON is stored beside it.
 */
async function freeze(sql: Sql, s: Services, v: Row, rows: Row[], state: 'issued' | 'shared', userId: string) {
  const lines = rows.map((r) => lineView(r, s));
  const t = totalsView(rows, v, s);
  const mIds = rows.flatMap((r) => r.measurement_ids ?? []);
  const docs = mIds.length ? await many<Row>(sql, `select distinct d.id, d.title, d.number, r.id as revision_id, r.revision_label, r.sha256 from measurements m join document_revisions r on r.id = m.revision_id join documents d on d.id = r.document_id where m.id = any($1::uuid[])`, [mIds]) : [];
  const reviewer = v.reviewer_user_id ? await one<Row>(sql, `select display_name from users where id = $1`, [v.reviewer_user_id]) : null;
  const validUntil = new Date(Date.now() + s.pack.projects.estimateValidityDays * 86_400_000).toISOString();
  const snapshot = {
    versionId: v.id, number: v.number, maturity: v.maturity, currency: v.currency, contingencyPct: Number(v.contingency_pct), assumptions: json(v.assumptions), exclusions: json(v.exclusions),
    lines, totals: t, documents: docs.map((d) => ({ documentId: d.id, title: d.title, number: d.number, revisionId: d.revision_id, revision: d.revision_label, sha256: d.sha256 })),
    reviewer: reviewer?.display_name ?? null, jurisdictionPackVersion: v.jurisdiction_pack_version, calculationVersion: t.calculationVersion,
    validUntil: state === 'issued' ? validUntil : null, frozenAt: new Date().toISOString(), frozenBy: userId,
  };
  const hash = createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
  await sql.query(`update estimate_versions set state = $2, snapshot = $3::jsonb, snapshot_hash = $4, totals = $5::jsonb, calculation_version = $6, valid_until = $7,
      issued_at = case when $2 = 'issued' then now() else issued_at end, version = version + 1, updated_at = now() where id = $1`,
    [v.id, state, JSON.stringify(snapshot), hash, JSON.stringify(t), t.calculationVersion, state === 'issued' ? validUntil : null]);
}
