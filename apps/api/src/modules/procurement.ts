import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CASE_TYPE_KEYS, type CaseType,
  awardBlockers, canonicalJson, checkLabel, compareQuotes, distanceKm, estimateCanFeedRfq, findArea, formatDec, formatMoney, invitationMachine,
  LIVE_QUOTE_STATES, matchProviders, MATURITY, orderMachine, ORDER_ACTOR, parseDec, parseMajor, quoteMachine, quoteProblems, quoteTotals,
  quoteLineAmount, RECORD_ONLY_PAYMENT_NOTICE, rfqChanges, rfqLineFromQuoteRequest, rfqLinesFromEstimate, rfqMachine, rfqScopeLabel, rfqTypeFor,
  REVIEW_DIMENSIONS, TRANSACTION_REVIEW_NOTICE, unitLabel, UNITS, uuidv7, VERIFICATION_STATEMENT,
  EMPTY_TENDER_RESPONSE, pricesSealed, responseNotes, responseProblems, SOURCING_MODE_LABELS, SOURCING_MODES, sourcingScreen, withdrawalBlocker,
  type SealState, type SourcingMode, type TenderResponse,
  type CheckRecord, type CheckType, type ComparisonQuote, type Maturity, type MatchRequest, type MatchResult, type OrderCommand, type ProviderCandidate,
  type QuoteLineInput, type QuoteState, type QuoteTerms, type RfqCommand, type RfqLine, type RfqState,
} from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Actor, type Services } from '../http/route.js';
import { audit, badRequest, conflict, forbidden, notFound, notify, publish, sha256, unprocessable } from '../platform/platform.js';
import { categoryDef } from './listings.js';
import { toLine } from './estimates.js';
import { projectAccess, projectRow, type ProjectAccess } from './projects.js';
import { myOrgIds, orderSide, orgUsers, providerOrg } from './parties.js';
import { orderCloseCheck, syncOrder } from './fulfilment.js';
import { openCase } from './cases.js';
import { performanceFor, summaryOf, transactionReviewStats } from './reputation.js';
import { clientPolicy } from './supplier-lists.js';
import { contractCloseCheck, createFirstRevision } from './contracts.js';
import { createPackage, packageOf, packageInput, openTender, tenderClientExtras, tenderComparisonExtras, tenderProviderExtras, type PackageBody } from './tenders.js';

/**
 * Structured procurement, R3 first slice (spec §3.17, §9.2–§9.4, §10.4 steps 1–7, §13.1, §13.5, §14.1): provider
 * profiles derived from storefronts, RFQs from reviewed or client-specified estimate lines, matching, sealed
 * quotes with immutable versions, normalised comparison, award and a record-only order.
 */

type Row = Record<string, any>;
const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
const dec = (v: unknown) => parseDec(String(v ?? '0')) ?? 0n;
const today = () => new Date().toISOString().slice(0, 10);
const DAY = 86_400_000;

/** Shortest response window: the pack's days, or a development-only override in minutes (e2e runs a real deadline). */
export function minResponseMs(s: Services, days: number) { return s.config.minResponseMinutes != null ? s.config.minResponseMinutes * 60_000 : days * DAY - 3_600_000; }

export const sealOf = (r: Row): SealState => ({ kind: r.kind, sealed: r.sealed, state: r.state, deadline: iso(r.deadline)!, openedAt: iso(r.opened_at) });
export const rfqRef = (r: Row) => `${r.kind === 'tender' ? 'TND' : 'RFQ'}-${String(r.number).padStart(3, '0')}`;

function moneyOf(s: Services) {
  return (minor: bigint | string | number, currency = s.pack.currency) => ({ amountMinor: String(minor), currency, display: formatMoney({ amountMinor: String(minor), currency }, s.pack.locale) });
}
const majorOf = (minor: bigint | string, currency: string) => {
  const d = currency === 'XOF' || currency === 'JPY' ? 0 : 2;
  const v = BigInt(minor);
  return d ? `${v / 100n}.${String(v % 100n).padStart(2, '0')}`.replace(/\.00$/, '') : String(v);
};

// ---------------------------------------------------------------- loading
export async function rfqRow(sql: Sql, id: string): Promise<Row> {
  const r = await one<Row>(sql, `select * from rfqs where id = $1`, [id]);
  if (!r) throw notFound('Request for quotes');
  return r;
}

function lineFromRow(r: Row): RfqLine {
  return {
    lineKey: r.line_key, position: r.position, section: r.section, description: r.description, specification: r.specification, unit: r.unit,
    quantity: dec(r.quantity), pack: r.pack_value != null && r.pack_unit ? { value: Number(r.pack_value), unit: r.pack_unit } : null, provenance: json(r.provenance),
  };
}

export async function rfqLines(sql: Sql, versionId: string) {
  return (await many<Row>(sql, `select * from rfq_lines where rfq_version_id = $1 order by position`, [versionId])).map(lineFromRow);
}

async function insertLines(sql: Sql, rfq: { id: string; projectId: string }, versionId: string, lines: RfqLine[]) {
  for (const l of lines) {
    await sql.query(`insert into rfq_lines (id, rfq_version_id, rfq_id, project_id, line_key, position, section, description, specification, unit, quantity, pack_value, pack_unit, provenance)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)`,
    [uuidv7(), versionId, rfq.id, rfq.projectId, l.lineKey, l.position, l.section, l.description, l.specification, l.unit, formatDec(l.quantity), l.pack?.value ?? null, l.pack?.unit ?? null, JSON.stringify(l.provenance)]);
  }
}

const linesHash = (lines: RfqLine[], deadline: string, notes: string | null) => sha256(canonicalJson({ lines: lines.map((l) => ({ ...l, quantity: formatDec(l.quantity) })), deadline, notes }));


export type Side = { side: 'client'; access: ProjectAccess } | { side: 'provider'; orgId: string; invitation: Row };

/** Who is looking at an RFQ: a member of the client's project, or an invited provider. Anyone else gets a 404. */
export async function sideOf(sql: Sql, user: Actor, rfq: Row): Promise<Side> {
  const m = await one(sql, `select 1 from project_members where project_id = $1 and user_id = $2`, [rfq.project_id, user.id]);
  if (m || user.isStaff) {
    try { return { side: 'client', access: await projectAccess(sql, user, rfq.project_id, 'rfq.read') }; } catch { /* fall through to provider */ }
  }
  const orgs = await myOrgIds(sql, user);
  const inv = orgs.length ? await one<Row>(sql, `select * from rfq_invitations where rfq_id = $1 and provider_org_id = any($2::uuid[]) and state <> 'revoked' order by created_at limit 1`, [rfq.id, orgs]) : null;
  if (!inv) throw notFound('Request for quotes');
  return { side: 'provider', orgId: inv.provider_org_id, invitation: inv };
}


async function categoryInfo(sql: Sql, s: Services, slug: string) {
  const def = await categoryDef(sql, slug).catch(() => null);
  if (!def) throw badRequest('VALIDATION_FAILED', 'Choose a marketplace category.', [{ path: 'categorySlug', message: 'Unknown category.' }]);
  const children = (await many<{ slug: string }>(sql, `select slug from categories where parent_slug = $1 and status = 'active'`, [slug])).map((r) => r.slug);
  return { slug, name: def.name, listingType: def.listingType, slugs: [slug, ...children], rfqType: rfqTypeFor(slug, def.listingType) };
}

// ---------------------------------------------------------------- matching inputs (§13.1)
/**
 * Candidates are sellers with a live listing in the RFQ's category. Everything a provider profile shows is derived
 * from the storefront: listings (categories, areas, service areas), verification checks, restrictions and history.
 * Fee, commission and promotion data are never passed to ranking; promotion is read only for its label.
 */
async function candidatesFor(sql: Sql, s: Services, rfq: { categorySlug: string; areaCode: string; projectId: string; lineText: string; extraOrgIds?: string[] }, clientOrgIds: string[]): Promise<{ candidates: ProviderCandidate[]; req: Omit<MatchRequest, 'deadline'> }> {
  const cat = await categoryInfo(sql, s, rfq.categorySlug);
  const area = findArea(s.pack, rfq.areaCode);
  if (!area) throw badRequest('VALIDATION_FAILED', 'The project needs an area in this market before you can find suppliers.');
  const listings = await many<Row>(sql, `select l.id, l.seller_org_id, l.area_code, l.service_areas, l.lat, l.lng, l.per_base_minor, l.compare_key, l.attributes, l.title,
      exists (select 1 from promotion_purchases p where p.listing_id = l.id and p.status = 'active') as promoted
    from listings l where l.status = 'live' and l.category_slug = any($1::text[])`, [cat.slugs]);
  // Suppliers the client named are candidates even without a live listing in the category (nominated mode).
  const orgIds = [...new Set([...listings.map((l) => l.seller_org_id as string), ...(rfq.extraOrgIds ?? [])])];
  const req = { categorySlug: cat.slug, categoryName: cat.name, areaCode: area.code, areaLabel: area.label, rfqType: cat.rfqType };
  if (!orgIds.length) return { candidates: [], req };
  const orgs = await many<Row>(sql, `select o.id, o.name, o.handle, o.kind, pp.accepts_rfqs,
      (select bool_and(u.status = 'active') from org_members m join users u on u.id = m.user_id where m.org_id = o.id and m.role = 'owner') as owners_active,
      (select string_agg(r.kind, ',') from seller_restrictions r where r.org_id = o.id and r.status = 'active' and r.kind in ('listing_suspension', 'account_suspension') and (r.ends_at is null or r.ends_at > now())) as suspensions
    from organizations o left join provider_profiles pp on pp.org_id = o.id where o.id = any($1::uuid[])`, [orgIds]);
  const checks = await many<Row>(sql, `select org_id, check_type, state, checked_at, expires_at from verification_checks where org_id = any($1::uuid[])`, [orgIds]);
  const stats = await many<Row>(sql, `select * from provider_match_stats($1::uuid[], $2, $3)`, [orgIds, s.pack.policy.reputationWindowDays, s.pack.policy.replyWindowHours]);
  const perf = await performanceFor(sql, s, orgIds);
  const txReviews = await transactionReviewStats(sql, s, orgIds);
  // Local price context: the median advertised per-base-unit price for the most common comparison key.
  const keys = new Map<string, number[]>();
  for (const l of listings) if (l.per_base_minor != null && l.compare_key) keys.set(l.compare_key, [...(keys.get(l.compare_key) ?? []), Number(l.per_base_minor)]);
  const [mainKey, prices] = [...keys.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [null, []];
  const sorted = [...prices].sort((a, b) => a - b);
  const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null;
  const text = rfq.lineText.toLowerCase();
  const specMatch = (attrs: Row) => {
    const vals = Object.values(attrs ?? {}).flatMap((v) => (typeof v === 'string' || typeof v === 'number' ? [String(v).toLowerCase()] : [])).filter((v) => v.length >= 2 && !['true', 'false'].includes(v));
    return !/\d/.test(text) || vals.some((v) => text.includes(v));
  };
  const candidates = orgs.map((o): ProviderCandidate => {
    const st = stats.find((x) => x.org_id === o.id) ?? {};
    const threads = Number(st.threads ?? 0);
    const own = clientOrgIds.includes(o.id);
    const inactiveReason = own ? 'Your own organization (conflict of interest).' : o.accepts_rfqs === false ? 'Not accepting requests for quotes.' : o.suspensions ? 'Restricted by moderation.' : o.owners_active === false ? 'Account not active.' : null;
    return {
      orgId: o.id, name: o.name, handle: o.handle, active: !inactiveReason, inactiveReason,
      listings: listings.filter((l) => l.seller_org_id === o.id).map((l) => ({
        areaCode: l.area_code, serviceAreas: l.service_areas ?? [], distanceKm: Math.round(distanceKm({ lat: Number(l.lat), lng: Number(l.lng) }, area) * 10) / 10,
        perBaseMinor: l.compare_key === mainKey && l.per_base_minor != null ? Number(l.per_base_minor) : null, matchesSpec: specMatch(json(l.attributes)),
      })),
      checks: checks.filter((c) => c.org_id === o.id).map((c): CheckRecord => ({ type: c.check_type, state: c.state, checkedAt: iso(c.checked_at)!, expiresAt: iso(c.expires_at) })),
      stats: {
        invitations: Number(st.invitations ?? 0), responses: Number(st.responses ?? 0), awards: Number(st.awards ?? 0),
        replyRatePct: threads >= s.pack.policy.reputationMinThreads ? Math.round((Number(st.replied ?? 0) / threads) * 100) : null,
        reviewAverage: st.review_avg != null ? Number(st.review_avg) : null, reviewCount: Number(st.review_count ?? 0),
        performance: summaryOf(perf.get(o.id)),
        transactionReviewAverage: txReviews.get(o.id)?.average ?? null, transactionReviewCount: txReviews.get(o.id)?.count ?? 0,
      },
      marketMedianPerBase: median,
      promoted: listings.some((l) => l.seller_org_id === o.id && l.promoted),
    };
  });
  return { candidates, req };
}

async function clientOrgIdsOf(sql: Sql, projectId: string, user: Actor) {
  const p = await one<{ owner_org_id: string }>(sql, `select owner_org_id from projects where id = $1`, [projectId]);
  return [...new Set([p?.owner_org_id, ...(await myOrgIds(sql, user))].filter(Boolean) as string[])];
}

export async function runMatch(sql: Sql, s: Services, rfq: Row, user: Actor, deadline?: string): Promise<{ id: string; result: MatchResult }> {
  const lines = rfq.current_version_id ? await rfqLines(sql, rfq.current_version_id) : [];
  const lineText = lines.map((l) => `${l.description} ${l.specification ?? ''}`).join(' ');
  const { candidates, req } = await candidatesFor(sql, s, { categorySlug: rfq.category_slug, areaCode: rfq.area_code, projectId: rfq.project_id, lineText, extraOrgIds: rfq.nominated_org_ids ?? [] }, await clientOrgIdsOf(sql, rfq.project_id, user));
  const at = deadline ?? iso(rfq.deadline)!;
  // The client's own lists and conflict checks (§13.1.5), and a tender's extra required checks (§10.5 step 1).
  const policy = await clientPolicy(sql, rfq, candidates, at);
  const pkg = rfq.kind === 'tender' ? await one<{ required_checks: CheckType[] }>(sql, `select required_checks from tender_packages where rfq_id = $1`, [rfq.id]) : null;
  const result = matchProviders(candidates, { ...req, deadline: at }, s.pack.procurement, { screen: sourcingScreen(policy, s.pack.sourcing), extraChecks: pkg?.required_checks ?? [], sourcingMode: rfq.sourcing_mode as SourcingMode });
  const id = uuidv7();
  await sql.query(`insert into rfq_match_runs (id, rfq_id, project_id, ranking_version, deadline, result, created_by) values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [id, rfq.id, rfq.project_id, result.rankingVersion, at, JSON.stringify(result), user.id]);
  return { id, result };
}

/** Invites providers that pass hard eligibility in a fresh match run; others are refused with their reasons. */
export async function invite(sql: Sql, s: Services, rfq: Row, user: Actor, orgIds: string[], source: 'matched' | 'quote_request', quoteRequestId: string | null = null, prior?: { id: string; result: MatchResult }) {
  const run = prior ?? await runMatch(sql, s, rfq, user);
  const invited: string[] = []; const refused: { orgId: string; name: string; reasons: string[] }[] = [];
  const existing = await many<Row>(sql, `select provider_org_id from rfq_invitations where rfq_id = $1`, [rfq.id]);
  if (existing.length + orgIds.length > s.pack.procurement.maxInvitations) throw conflict('TOO_MANY_INVITATIONS', `One request can invite at most ${s.pack.procurement.maxInvitations} providers.`);
  for (const orgId of orgIds) {
    if (existing.some((e) => e.provider_org_id === orgId)) continue;
    const m = run.result.eligible.find((e) => e.orgId === orgId);
    if (!m) {
      const x = run.result.ineligible.find((e) => e.orgId === orgId);
      refused.push({ orgId, name: x?.name ?? 'Unknown provider', reasons: x?.reasons ?? [`Has no live listing in this category.`] });
      continue;
    }
    await sql.query(`insert into rfq_invitations (id, rfq_id, project_id, provider_org_id, source, quote_request_id, match_run_id, match, invited_by) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [uuidv7(), rfq.id, rfq.project_id, orgId, source, quoteRequestId, run.id, JSON.stringify({ rank: m.rank, score: m.score, factors: m.factors, why: m.why, promoted: m.promoted, labels: m.labels, warnings: m.warnings, rankingVersion: run.result.rankingVersion, sourcingMode: run.result.sourcingMode }), user.id]);
    invited.push(orgId);
  }
  return { invited, refused, run };
}

export async function notifyInvited(sql: Sql, rfq: Row, orgIds: string[], title: string, body: string) {
  for (const orgId of orgIds) {
    await notify(sql, await orgUsers(sql, orgId), { kind: 'rfq', title, body, link: `/provider/rfqs/${rfq.id}` });
    await publish(sql, 'ProviderInvited', { rfqId: rfq.id, orgId });
  }
}

// ---------------------------------------------------------------- views
function lineView(l: RfqLine) {
  return { lineKey: l.lineKey, position: l.position, section: l.section, description: l.description, specification: l.specification, unit: l.unit, unitLabel: unitLabel(l.unit), quantity: formatDec(l.quantity, 3), pack: l.pack, provenance: l.provenance };
}

function rfqBase(s: Services, r: Row, categoryName: string) {
  const area = findArea(s.pack, r.area_code);
  const scope = MATURITY[r.scope_maturity as Maturity];
  const open = r.state === 'published' && new Date(String(r.deadline)).getTime() > Date.now();
  return {
    id: r.id, projectId: r.project_id, number: r.number, reference: rfqRef(r), title: r.title, state: r.state as RfqState, kind: r.kind as 'rfq' | 'tender',
    sourcingLabel: SOURCING_MODE_LABELS[r.sourcing_mode as SourcingMode]?.label ?? r.sourcing_mode, openedAt: iso(r.opened_at),
    rfqType: r.rfq_type, category: { slug: r.category_slug, name: categoryName }, area: area ? { code: area.code, label: area.label, region: area.region.label } : { code: r.area_code, label: r.area_code, region: '' },
    sourcingMode: r.sourcing_mode, sealed: r.sealed, deadline: iso(r.deadline), neededBy: r.needed_by ? String(iso(r.needed_by)).slice(0, 10) : null, notes: r.notes, currency: r.currency,
    scope: { maturity: r.scope_maturity, label: scope.label, notice: scope.notice }, versionNumber: r.current_version_number, version: r.version,
    acceptingQuotes: open, publishedAt: iso(r.published_at), closedAt: iso(r.closed_at), createdAt: iso(r.created_at),
    paymentNotice: RECORD_ONLY_PAYMENT_NOTICE,
  };
}

async function versionsOf(sql: Sql, rfqId: string) {
  return (await many<Row>(sql, `select number, change_reason, changes, deadline, created_at from rfq_versions where rfq_id = $1 order by number`, [rfqId]))
    .map((v) => ({ number: v.number, changeReason: v.change_reason, changes: json<string[]>(v.changes), deadline: iso(v.deadline), createdAt: iso(v.created_at) }));
}

async function clientView(sql: Sql, s: Services, r: Row, access: ProjectAccess) {
  const cat = await categoryInfo(sql, s, r.category_slug);
  const lines = r.current_version_id ? await rfqLines(sql, r.current_version_id) : [];
  const inv = await many<Row>(sql, `select i.*, o.name, o.handle, q.id as quote_id, q.status as quote_status,
      (select number from quote_versions v where v.id = q.current_version_id) as quote_version_number
    from rfq_invitations i join organizations o on o.id = i.provider_org_id left join quotes q on q.invitation_id = i.id where i.rfq_id = $1 order by (i.match->>'rank')::int nulls last, o.name`, [r.id]);
  const lastRun = await one<Row>(sql, `select result, created_at from rfq_match_runs where rfq_id = $1 order by created_at desc limit 1`, [r.id]);
  const order = r.order_id ? await one<Row>(sql, `select id, number, state from orders where id = $1`, [r.order_id]) : null;
  const pricesOpen = !pricesSealed(sealOf(r));
  const manage = !access.viaStaffSession && ['owner', 'manager'].includes(access.role);
  // A tender closes only through its bid opening at the deadline (§10.5), never with "close".
  const commands = rfqMachine.commandsFrom(r.state).filter((c) => (c === 'award' ? access.role === 'owner' : manage) && !(c === 'close' && (r.kind === 'tender' || (r.sealed && !pricesOpen))));
  const statuses: Record<string, number> = {};
  for (const i of inv) if (i.quote_status && i.quote_status !== 'draft') statuses[i.quote_status] = (statuses[i.quote_status] ?? 0) + 1;
  return {
    ...rfqBase(s, r, cat.name), side: 'client' as const, role: access.role, canManage: manage, canAward: access.role === 'owner' && !access.viaStaffSession, commands,
    lines: lines.map(lineView), versions: await versionsOf(sql, r.id),
    invitations: inv.map((i) => ({
      id: i.id, providerOrgId: i.provider_org_id, providerName: i.name, handle: i.handle, state: i.state, source: i.source, declineReason: i.decline_reason,
      match: i.match ? json(i.match) : null, quote: i.quote_status && i.quote_status !== 'draft' ? { id: i.quote_id, status: i.quote_status, versionNumber: i.quote_version_number } : null,
    })),
    quotes: { count: Object.values(statuses).reduce((a, b) => a + b, 0), statuses, pricesOpen, sealedUntil: r.sealed ? iso(r.deadline) : null },
    sourcing: { mode: r.sourcing_mode, label: SOURCING_MODE_LABELS[r.sourcing_mode as SourcingMode]?.label ?? r.sourcing_mode, nominated: await nominatedOf(sql, r) },
    tender: r.kind === 'tender' ? await tenderClientExtras(sql, s, r, access) : null,
    lastMatch: lastRun ? { ...json<MatchResult>(lastRun.result), ranAt: iso(lastRun.created_at) } : null,
    assistedSourcing: r.assisted_sourcing_requested_at ? { requestedAt: iso(r.assisted_sourcing_requested_at), note: r.assisted_sourcing_note } : null,
    order: order ? { id: order.id, number: order.number, state: order.state } : null,
    source: { estimateId: r.source_estimate_id, estimateVersionId: r.source_estimate_version_id, quoteRequestId: r.source_quote_request_id },
    closeReason: r.close_reason,
  };
}

async function nominatedOf(sql: Sql, r: Row) {
  const ids: string[] = r.nominated_org_ids ?? [];
  if (!ids.length) return [];
  return (await many<Row>(sql, `select id, name, handle from organizations where id = any($1::uuid[]) order by name`, [ids])).map((o) => ({ orgId: o.id, name: o.name, handle: o.handle }));
}

function quoteVersionView(s: Services, v: Row, lines: Row[]) {
  const money = moneyOf(s);
  const t = v.totals ? json<Record<string, string>>(v.totals) : null;
  const dom = qvDomain(v, lines);
  const live = quoteTotals(dom.lines, dom.terms);
  return {
    id: v.id, quoteId: v.quote_id, number: v.number, state: v.state as QuoteState, rfqVersionNumber: v.rfq_version_number, version: v.version,
    currency: v.currency, deliveryCharge: majorOf(v.delivery_minor, v.currency), deliveryTaxRatePct: Number(v.delivery_tax_rate_pct),
    validUntil: v.valid_until ? String(iso(v.valid_until)).slice(0, 10) : null, paymentTerms: v.payment_terms, warranty: v.warranty, leadTimeDays: v.lead_time_days,
    exclusions: json<string[]>(v.exclusions), notes: v.notes, submittedAt: iso(v.submitted_at), snapshotHash: v.snapshot_hash,
    tenderResponse: v.tender_response ? json<TenderResponse>(v.tender_response) : null,
    totals: {
      lines: money(t?.linesMinor ?? live.linesMinor, v.currency), delivery: money(t?.deliveryMinor ?? live.deliveryMinor, v.currency),
      tax: money(t?.taxMinor ?? live.taxMinor, v.currency), gross: money(t?.grossMinor ?? live.grossMinor, v.currency),
    },
    lines: lines.map((l) => ({
      rfqLineKey: l.rfq_line_key, status: l.status, offered: l.offered, isSubstitution: l.is_substitution, substitutionNote: l.substitution_note,
      unit: l.unit, quantity: formatDec(dec(l.quantity), 3), pack: l.pack_value != null ? { value: Number(l.pack_value), unit: l.pack_unit } : null,
      unitPrice: majorOf(l.unit_price_minor, v.currency), unitPriceDisplay: money(l.unit_price_minor, v.currency).display, taxRatePct: Number(l.tax_rate_pct),
      availability: l.availability, leadTimeDays: l.lead_time_days,
    })),
    commands: quoteMachine.commandsFrom(v.state).filter((c) => ['submit', 'withdraw'].includes(c)),
  };
}

export function qvDomain(v: Row, lines: Row[]): { terms: QuoteTerms; lines: QuoteLineInput[] } {
  return {
    terms: {
      currency: v.currency, deliveryMinor: BigInt(v.delivery_minor ?? 0), deliveryTaxRatePct: Number(v.delivery_tax_rate_pct ?? 0), validUntil: v.valid_until ? String(iso(v.valid_until)).slice(0, 10) : '',
      paymentTerms: v.payment_terms, warranty: v.warranty, leadTimeDays: v.lead_time_days, exclusions: json<string[]>(v.exclusions) ?? [], notes: v.notes,
    },
    lines: lines.map((l) => ({
      rfqLineKey: l.rfq_line_key, status: l.status, offered: l.offered, isSubstitution: l.is_substitution, substitutionNote: l.substitution_note, unit: l.unit,
      quantity: dec(l.quantity), pack: l.pack_value != null && l.pack_unit ? { value: Number(l.pack_value), unit: l.pack_unit } : null,
      unitPriceMinor: BigInt(l.unit_price_minor), taxRatePct: Number(l.tax_rate_pct), availability: l.availability, leadTimeDays: l.lead_time_days,
    })),
  };
}

export async function qLines(sql: Sql, versionId: string) {
  return many<Row>(sql, `select * from quote_lines where quote_version_id = $1 order by position`, [versionId]);
}

async function clarificationsOf(sql: Sql, quoteId: string) {
  return (await many<Row>(sql, `select c.*, u.display_name from quote_clarifications c join users u on u.id = c.author_user_id where c.quote_id = $1 order by c.created_at`, [quoteId]))
    .map((c) => ({ id: c.id, side: c.side, body: c.body, author: c.display_name, at: iso(c.created_at) }));
}

async function providerView(sql: Sql, s: Services, r: Row, side: Extract<Side, { side: 'provider' }>) {
  const cat = await categoryInfo(sql, s, r.category_slug);
  const lines = r.current_version_id ? await rfqLines(sql, r.current_version_id) : [];
  const org = await one<Row>(sql, `select id, name from organizations where id = $1`, [side.orgId]);
  const q = await one<Row>(sql, `select * from quotes where rfq_id = $1 and provider_org_id = $2`, [r.id, side.orgId]);
  const versions = q ? await many<Row>(sql, `select id, number, state, rfq_version_number, totals, submitted_at, currency from quote_versions where quote_id = $1 order by number desc`, [q.id]) : [];
  const order = await one<Row>(sql, `select id, number, state from orders where rfq_id = $1 and provider_org_id = $2`, [r.id, side.orgId]);
  const money = moneyOf(s);
  const base = rfqBase(s, r, cat.name);
  const draft = versions.find((v) => v.state === 'draft');
  return {
    ...base, projectId: null, side: 'provider' as const, provider: { orgId: side.orgId, name: org?.name ?? '' },
    invitation: { id: side.invitation.id, state: side.invitation.state, declineReason: side.invitation.decline_reason },
    lines: lines.map(lineView), versions: await versionsOf(sql, r.id),
    canQuote: base.acceptingQuotes && side.invitation.state !== 'declined',
    canWithdraw: withdrawalBlocker(sealOf(r)) == null,
    tender: r.kind === 'tender' ? await tenderProviderExtras(sql, s, r, side.orgId) : null,
    canDecline: base.acceptingQuotes && invitationMachine.can(side.invitation.state, 'decline'),
    quote: q ? {
      id: q.id, status: q.status, draftVersionId: draft?.id ?? null,
      versions: versions.map((v) => ({ id: v.id, number: v.number, state: v.state, rfqVersionNumber: v.rfq_version_number, gross: v.totals ? money(json<Record<string, string>>(v.totals).grossMinor ?? 0, v.currency) : null, submittedAt: iso(v.submitted_at) })),
      clarifications: await clarificationsOf(sql, q.id),
    } : null,
    order: order ? { id: order.id, number: order.number, state: order.state } : null,
  };
}

// ---------------------------------------------------------------- schemas
const lineEdit = z.object({ lineKey: z.uuid(), quantity: z.string().regex(/^\d+(\.\d{1,6})?$/).optional(), specification: z.string().trim().max(500).nullable().optional(), description: z.string().trim().min(2).max(300).optional(), remove: z.boolean().optional() });
const tenderResponseSchema = z.object({
  startDate: z.iso.date().nullable().optional(), programmeWeeks: z.number().int().min(1).max(520).nullable().optional(),
  staffing: z.string().trim().max(2000).nullable().optional(), method: z.string().trim().max(5000).nullable().optional(),
  inclusions: z.array(z.string().trim().min(1).max(300)).max(30).optional(), qualifications: z.string().trim().max(3000).nullable().optional(),
  defectsTerms: z.string().trim().max(1000).nullable().optional(), exceptions: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
  siteVisitConfirmed: z.boolean().optional(), conflict: z.object({ declared: z.boolean(), details: z.string().trim().max(1000).nullable().optional() }).nullable().optional(),
});
const quoteLineSchema = z.object({
  rfqLineKey: z.uuid(), status: z.enum(['priced', 'excluded']), offered: z.string().trim().max(200).nullable().optional(),
  isSubstitution: z.boolean().default(false), substitutionNote: z.string().trim().max(500).nullable().optional(),
  unit: z.string().refine((u) => Object.hasOwn(UNITS, u), 'Unknown unit.'), quantity: z.string().regex(/^\d+(\.\d{1,6})?$/),
  packValue: z.number().positive().max(100_000).nullable().optional(), packUnit: z.string().max(20).nullable().optional(),
  unitPrice: z.string().max(20).default('0'), taxRatePct: z.number().min(0).max(50).default(0),
  availability: z.string().trim().max(200).nullable().optional(), leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
});

export function registerProcurement(app: FastifyInstance, s: Services) {
  const cfg = s.pack.procurement;
  const money = moneyOf(s);

  route(app, s, {
    method: 'GET', url: '/v1/procurement-config', auth: 'user',
    handler: async ({ sql }) => {
      const cats = await many<Row>(sql, `select slug, name, parent_slug from categories where status = 'active' order by sort, name`);
      return {
        categories: cats.map((c) => ({ slug: c.slug, name: c.name, parent: c.parent_slug })),
        sourcingModes: SOURCING_MODES.map((code) => ({ code, label: `${SOURCING_MODE_LABELS[code].label}${cfg.sealedByDefault[code] ? ' (sealed until the deadline)' : ''}`, help: SOURCING_MODE_LABELS[code].help, sealed: cfg.sealedByDefault[code] })),
        tenders: { minResponseDays: s.pack.tenders.minResponseDays, maxResponseDays: s.pack.tenders.maxResponseDays, defaultRetentionPct: s.pack.tenders.defaultRetentionPct, maxRetentionPct: s.pack.tenders.maxRetentionPct, defaultResponseFields: s.pack.tenders.defaultResponseFields, questionCutoffHours: s.pack.tenders.questionCutoffHours },
        minResponseMinutes: s.config.minResponseMinutes ?? null,
        minResponseDays: cfg.minResponseDays, maxResponseDays: cfg.maxResponseDays, defaultQuoteValidityDays: cfg.defaultQuoteValidityDays,
        targetEligibleProviders: cfg.targetEligibleProviders, requiredChecks: Object.fromEntries(Object.entries(cfg.requiredChecks).map(([k, v]) => [k, v.map((t) => ({ type: t, label: checkLabel(t) }))])),
        units: Object.values(UNITS).map((u) => ({ code: u.code, label: u.label })), taxRatePct: s.pack.tax.ratePercent, currency: s.pack.currency,
        paymentNotice: RECORD_ONLY_PAYMENT_NOTICE, verificationStatement: VERIFICATION_STATEMENT,
      };
    },
  });

  // ---------------------------------------------------------------- what can feed an RFQ (§10.4 step 1, §3.17)
  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/rfq-sources', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      await projectAccess(sql, user, params.id, 'rfq.read');
      const vs = await many<Row>(sql, `select e.id as estimate_id, e.title, e.maturity, v.id, v.number, v.state, v.totals, v.issued_at, v.created_at,
          (select count(*)::int from estimate_lines l where l.version_id = v.id and l.status <> 'excluded') as lines
        from estimates e join estimate_versions v on v.estimate_id = e.id where e.project_id = $1 and e.maturity <> 'indicative' order by e.created_at desc, v.number desc`, [params.id]);
      const qrs = await many<Row>(sql, `select q.id, q.quantity, q.unit, q.status, q.created_at, l.title, l.category_slug, o.name as seller from quote_requests q join listings l on l.id = q.listing_id join organizations o on o.id = q.seller_org_id
        where q.buyer_user_id = $1 order by q.created_at desc limit 30`, [user.id]);
      return {
        estimates: vs.map((v) => {
          const gate = estimateCanFeedRfq(v.maturity, v.state);
          return { estimateId: v.estimate_id, versionId: v.id, title: v.title, number: v.number, state: v.state, maturity: v.maturity, label: MATURITY[v.maturity as Maturity]?.label ?? v.maturity, lines: v.lines, usable: gate.ok, reason: gate.ok ? null : gate.reason };
        }),
        quoteRequests: qrs.map((q) => ({ id: q.id, listingTitle: q.title, categorySlug: q.category_slug, seller: q.seller, quantity: formatDec(dec(q.quantity), 3), unit: q.unit, status: q.status, createdAt: iso(q.created_at) })),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/estimate-versions/:id/rfq-lines', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const v = await one<Row>(sql, `select v.*, e.maturity from estimate_versions v join estimates e on e.id = v.estimate_id where v.id = $1`, [params.id]);
      if (!v) throw notFound('Estimate');
      await projectAccess(sql, user, v.project_id, 'rfq.read');
      const rows = await many<Row>(sql, `select * from estimate_lines where version_id = $1 order by position`, [v.id]);
      const r = rfqLinesFromEstimate({ estimateId: v.estimate_id, versionId: v.id, versionNumber: v.number, maturity: v.maturity, state: v.state, snapshotHash: v.snapshot_hash, lines: rows.map((x) => ({ ...toLine(x), position: x.position })) });
      if (!r.ok) return { usable: false, reason: r.reason, lines: [] };
      return { usable: true, reason: null, lines: r.lines.map((l) => ({ ...lineView(l), estimateLineId: l.provenance.estimateLineId })) };
    },
  });

  // ---------------------------------------------------------------- create (draft)
  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/rfqs', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({
      title: z.string().trim().min(3).max(160), categorySlug: z.string().max(60),
      estimateVersionId: z.uuid().optional(), lineIds: z.array(z.uuid()).min(1).max(500).optional(), quoteRequestId: z.uuid().optional(),
      deadline: z.iso.datetime({ offset: true }), neededBy: z.iso.date().optional(), sourcingMode: z.enum(SOURCING_MODES as [SourcingMode, ...SourcingMode[]]).default('open'), notes: z.string().trim().max(2000).optional(),
      // A sealed tender for a trade package (§10.5): the package travels with it.
      kind: z.enum(['rfq', 'tender']).default('rfq'), package: packageInput.optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const access = await projectAccess(sql, user, params.id, 'rfq.manage');
      if (access.viaStaffSession) throw forbidden();
      const p = await projectRow(sql, params.id);
      if (!p.area_code) throw unprocessable('AREA_REQUIRED', 'Add the project area to the brief first: suppliers are matched by area.');
      const cat = await categoryInfo(sql, s, body.categorySlug);
      const deadline = new Date(body.deadline);
      const win = body.kind === 'tender' ? s.pack.tenders : cfg;
      if (deadline.getTime() < Date.now() + minResponseMs(s, win.minResponseDays) || deadline.getTime() > Date.now() + win.maxResponseDays * DAY) {
        throw badRequest('VALIDATION_FAILED', 'Check the deadline.', [{ path: 'deadline', message: `Give ${body.kind === 'tender' ? 'bidders' : 'providers'} between ${win.minResponseDays} and ${win.maxResponseDays} days to respond.` }]);
      }
      if (body.kind === 'tender' && !body.package) throw badRequest('VALIDATION_FAILED', 'Describe the package.', [{ path: 'package', message: 'Required for a tender.' }]);
      if (body.kind === 'tender' && body.sourcingMode === 'open') throw badRequest('VALIDATION_FAILED', 'A tender goes to invited bidders.', [{ path: 'sourcingMode', message: 'Choose invited, approved or named suppliers.' }]);
      let lines: RfqLine[] = []; let source: Row = {};
      let qr: Row | null = null;
      if (body.quoteRequestId) {
        qr = await one<Row>(sql, `select q.*, l.title from quote_requests q join listings l on l.id = q.listing_id where q.id = $1 and q.buyer_user_id = $2`, [body.quoteRequestId, user.id]);
        if (!qr) throw notFound('Quote request');
      }
      if (body.estimateVersionId) {
        const v = await one<Row>(sql, `select v.*, e.maturity from estimate_versions v join estimates e on e.id = v.estimate_id where v.id = $1 and v.project_id = $2`, [body.estimateVersionId, params.id]);
        if (!v) throw notFound('Estimate');
        const rows = await many<Row>(sql, `select * from estimate_lines where version_id = $1 order by position`, [v.id]);
        const r = rfqLinesFromEstimate({ estimateId: v.estimate_id, versionId: v.id, versionNumber: v.number, maturity: v.maturity, state: v.state, snapshotHash: v.snapshot_hash, lines: rows.map((x) => ({ ...toLine(x), position: x.position })) }, body.lineIds);
        if (!r.ok) throw unprocessable('SCOPE_NOT_ELIGIBLE', r.reason);
        lines = r.lines; source = { estimateId: v.estimate_id, versionId: v.id };
      } else if (qr) {
        lines = [rfqLineFromQuoteRequest({ id: qr.id, listingTitle: qr.title, quantity: dec(qr.quantity), unit: qr.unit, notes: qr.notes }, uuidv7())];
      } else {
        throw badRequest('VALIDATION_FAILED', 'Choose the estimate lines to request quotes for.', [{ path: 'estimateVersionId', message: 'Required.' }]);
      }
      const id = uuidv7(); const vid = uuidv7();
      const n = (await one<{ n: number }>(sql, `select coalesce(max(number), 0)::int + 1 as n from rfqs where project_id = $1`, [params.id]))!.n;
      const scope = rfqScopeLabel(lines);
      await sql.query(`insert into rfqs (id, project_id, number, title, rfq_type, category_slug, area_code, region_code, sourcing_mode, sealed, deadline, needed_by, notes, scope_maturity, source_estimate_id, source_estimate_version_id, source_quote_request_id, currency, current_version_id, created_by, kind)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
      [id, params.id, n, body.title, body.kind === 'tender' ? 'trade' : cat.rfqType, cat.slug, p.area_code, p.region_code ?? findArea(s.pack, p.area_code)?.region.code, body.sourcingMode, body.kind === 'tender' || cfg.sealedByDefault[body.sourcingMode],
        deadline.toISOString(), body.neededBy ?? null, body.notes ?? null, scope.maturity, source.estimateId ?? null, source.versionId ?? null, qr?.id ?? null, p.currency, vid, user.id, body.kind]);
      await sql.query(`insert into rfq_versions (id, rfq_id, project_id, number, change_reason, deadline, notes, snapshot_hash, created_by) values ($1, $2, $3, 1, null, $4, $5, $6, $7)`,
        [vid, id, params.id, deadline.toISOString(), body.notes ?? null, linesHash(lines, deadline.toISOString(), body.notes ?? null), user.id]);
      await insertLines(sql, { id, projectId: params.id }, vid, lines);
      if (body.kind === 'tender') await createPackage(sql, s, { id, project_id: params.id }, body.package as PackageBody, user.id);
      await publish(sql, body.kind === 'tender' ? 'TenderCreated' : 'RfqCreated', { rfqId: id, projectId: params.id });
      await audit(sql, { actorUserId: user.id, action: 'rfq.created', targetType: 'Rfq', targetId: id, metadata: { scope: scope.maturity, lines: lines.length, quoteRequestId: qr?.id ?? null } });
      return { id, number: n };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/rfqs', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      await projectAccess(sql, user, params.id, 'rfq.read');
      const rows = await many<Row>(sql, `select r.*, c.name as category_name,
          (select count(*)::int from rfq_invitations i where i.rfq_id = r.id and i.state <> 'revoked') as invited,
          (select count(*)::int from quotes q where q.rfq_id = r.id and q.status <> 'draft') as quoted
        from rfqs r join categories c on c.slug = r.category_slug where r.project_id = $1 order by r.number desc`, [params.id]);
      const orders = await many<Row>(sql, `select o.id, o.number, o.state, o.kind, o.total_minor, o.currency, o.created_at, g.name as provider from orders o join organizations g on g.id = o.provider_org_id where o.project_id = $1 order by o.number desc`, [params.id]);
      return {
        items: rows.map((r) => ({ ...rfqBase(s, r, r.category_name), invited: r.invited, quoted: r.quoted })),
        orders: orders.map((o) => ({ id: o.id, number: o.number, kind: o.kind, reference: `${o.kind === 'contract' ? 'CT' : 'PO'}-${String(o.number).padStart(3, '0')}`, state: o.state, total: money(o.total_minor, o.currency), provider: o.provider, createdAt: iso(o.created_at) })),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/rfqs/:id', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await rfqRow(sql, params.id);
      const side = await sideOf(sql, user, r);
      if (side.side === 'client') return clientView(sql, s, r, side.access);
      if (side.invitation.state === 'invited') {
        await sql.query(`update rfq_invitations set state = $2, viewed_at = now() where id = $1`, [side.invitation.id, invitationMachine.next('invited', 'view')]);
        side.invitation.state = 'viewed';
      }
      return providerView(sql, s, r, side);
    },
  });

  route(app, s, {
    method: 'PATCH', url: '/v1/rfqs/:id', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ expectedVersion: z.number().int(), title: z.string().trim().min(3).max(160).optional(), deadline: z.iso.datetime({ offset: true }).optional(), neededBy: z.iso.date().nullable().optional(), notes: z.string().trim().max(2000).nullable().optional(), sourcingMode: z.enum(SOURCING_MODES as [SourcingMode, ...SourcingMode[]]).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'rfq.manage');
      if (r.state !== 'draft') throw conflict('NOT_DRAFT', 'A published request is changed by revising it, which notifies the providers.');
      if (r.version !== body.expectedVersion) throw conflict('STALE', 'Someone else changed this request. Reload and try again.');
      const deadline = body.deadline ? new Date(body.deadline) : null;
      const win = r.kind === 'tender' ? s.pack.tenders : cfg;
      if (deadline && (deadline.getTime() < Date.now() + minResponseMs(s, win.minResponseDays) || deadline.getTime() > Date.now() + win.maxResponseDays * DAY)) throw badRequest('VALIDATION_FAILED', 'Check the deadline.', [{ path: 'deadline', message: `Between ${win.minResponseDays} and ${win.maxResponseDays} days from now.` }]);
      if (r.kind === 'tender' && body.sourcingMode === 'open') throw badRequest('VALIDATION_FAILED', 'A tender goes to invited bidders.', [{ path: 'sourcingMode', message: 'Choose invited, approved or named suppliers.' }]);
      await sql.query(`update rfqs set title = coalesce($2, title), deadline = coalesce($3, deadline), needed_by = case when $4::boolean then $5::date else needed_by end, notes = case when $6::boolean then $7 else notes end,
          sourcing_mode = coalesce($8, sourcing_mode), sealed = case when $8::text is null or kind = 'tender' then sealed else $9 end, version = version + 1, updated_at = now() where id = $1`,
      [r.id, body.title ?? null, deadline?.toISOString() ?? null, body.neededBy !== undefined, body.neededBy ?? null, body.notes !== undefined, body.notes ?? null, body.sourcingMode ?? null, body.sourcingMode ? cfg.sealedByDefault[body.sourcingMode] : null]);
      return { ok: true };
    },
  });

  // ---------------------------------------------------------------- matching and invitations (§13.1)
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/match', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    handler: async ({ sql, params, user }) => {
      const r = await rfqRow(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'rfq.manage');
      if (!['draft', 'published'].includes(r.state)) throw conflict('INVALID_TRANSITION', 'Matching is only for a draft or published request.');
      const run = await runMatch(sql, s, r, user);
      return { runId: run.id, ...run.result };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/invitations', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ providerOrgIds: z.array(z.uuid()).min(1).max(50) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'rfq.manage');
      if (!['draft', 'published'].includes(r.state)) throw conflict('INVALID_TRANSITION', 'Invitations can only be added before the request closes.');
      const res = await invite(sql, s, r, user, body.providerOrgIds, 'matched');
      if (r.state === 'published') await notifyInvited(sql, r, res.invited, 'New request for quotes', r.title);
      await audit(sql, { actorUserId: user.id, action: 'rfq.invited', targetType: 'Rfq', targetId: r.id, metadata: { invited: res.invited, refused: res.refused.map((x) => x.orgId) } });
      return { invited: res.invited, refused: res.refused };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/assisted-sourcing', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ note: z.string().trim().max(1000).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'rfq.manage');
      if (!['draft', 'published'].includes(r.state)) throw conflict('INVALID_TRANSITION', 'This request is no longer open.');
      await sql.query(`update rfqs set assisted_sourcing_requested_at = coalesce(assisted_sourcing_requested_at, now()), assisted_sourcing_note = $2, updated_at = now() where id = $1`, [r.id, body.note ?? null]);
      await publish(sql, 'AssistedSourcingRequested', { rfqId: r.id, projectId: r.project_id });
      await audit(sql, { actorUserId: user.id, action: 'rfq.assisted_sourcing_requested', targetType: 'Rfq', targetId: r.id });
      return { requested: true, message: 'Our operations team will look for more suppliers and add any that pass the same checks. You stay in control of who is invited and who is awarded.' };
    },
  });

  // Operations work queue for assisted sourcing (§13.1.6). Staff see the request, not the project's documents.
  route(app, s, {
    method: 'GET', url: '/v1/admin/assisted-sourcing', auth: 'staff', systemContext: true,
    handler: async ({ sql }) => ({
      items: (await many<Row>(sql, `select r.id, r.title, r.category_slug, r.area_code, r.deadline, r.state, r.assisted_sourcing_requested_at, r.assisted_sourcing_note,
          (select count(*)::int from rfq_invitations i where i.rfq_id = r.id and i.state <> 'revoked') as invited
        from rfqs r where r.assisted_sourcing_requested_at is not null and r.state in ('draft', 'published') order by r.assisted_sourcing_requested_at`))
        .map((r) => ({ id: r.id, title: r.title, categorySlug: r.category_slug, areaCode: r.area_code, deadline: iso(r.deadline), state: r.state, requestedAt: iso(r.assisted_sourcing_requested_at), note: r.assisted_sourcing_note, invited: r.invited })),
    }),
  });

  // ---------------------------------------------------------------- lifecycle commands (§9.2)
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/commands/:command', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), command: z.enum(['publish', 'close', 'cancel', 'no_award']) }),
    body: z.object({ expectedVersion: z.number().int(), reason: z.string().trim().min(3).max(500).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      const access = await projectAccess(sql, user, r.project_id, 'rfq.manage');
      if (access.viaStaffSession) throw forbidden();
      const cmd = params.command as RfqCommand;
      if (r.version !== body.expectedVersion) throw conflict('STALE', 'Someone else changed this request. Reload and try again.');
      const verb: Record<string, string> = { publish: 'published', close: 'closed', cancel: 'cancelled', no_award: 'closed without an award' };
      if (!rfqMachine.can(r.state, cmd)) throw conflict('INVALID_TRANSITION', `A ${r.state.replace(/_/g, ' ')} request can't be ${verb[cmd]}.`);
      const to = rfqMachine.next(r.state, cmd);
      const invitedOrgs = async () => (await many<{ provider_org_id: string }>(sql, `select provider_org_id from rfq_invitations where rfq_id = $1 and state <> 'revoked'`, [r.id])).map((x) => x.provider_org_id);
      if (cmd === 'publish') {
        if (new Date(String(r.deadline)).getTime() <= Date.now()) throw conflict('DEADLINE_PASSED', 'The deadline has passed. Set a new one before publishing.');
        const run = await runMatch(sql, s, r, user);
        // Open: every eligible provider. Approved suppliers and named suppliers: every eligible one on the list (the
        // screen already left out everyone else). Invited: only those the client chose while drafting.
        const want = new Set<string>(r.sourcing_mode === 'invited' ? [] : run.result.eligible.map((e) => e.orgId));
        let seed: { orgId: string; quoteRequestId: string } | null = null;
        if (r.source_quote_request_id) {
          const q = await one<Row>(sql, `select seller_org_id from quote_requests where id = $1`, [r.source_quote_request_id]);
          if (q) seed = { orgId: q.seller_org_id, quoteRequestId: r.source_quote_request_id };
        }
        // Invitations made while drafting are re-checked: a provider whose checks lapse before the deadline is dropped.
        const lapsed = await many<Row>(sql, `select i.id, i.provider_org_id from rfq_invitations i where i.rfq_id = $1 and i.state <> 'revoked'`, [r.id]);
        const dropped: { orgId: string; name: string; reasons: string[] }[] = [];
        for (const i of lapsed) {
          if (run.result.eligible.some((e) => e.orgId === i.provider_org_id)) continue;
          await sql.query(`update rfq_invitations set state = 'revoked' where id = $1`, [i.id]);
          const x = run.result.ineligible.find((e) => e.orgId === i.provider_org_id);
          dropped.push({ orgId: i.provider_org_id, name: x?.name ?? '', reasons: x?.reasons ?? ['No longer eligible.'] });
        }
        const res = await invite(sql, s, r, user, [...want].filter((o) => o !== seed?.orgId), 'matched', null, run);
        const seeded = seed ? await invite(sql, s, r, user, [seed.orgId], 'quote_request', seed.quoteRequestId, run) : null;
        res.refused.push(...dropped);
        const all = await invitedOrgs();
        if (!all.length) throw conflict('NO_ELIGIBLE_PROVIDERS', 'No eligible provider is invited. Ask our operations team for assisted sourcing, or change the category.', { assistedSourcing: run.result.assistedSourcing });
        await sql.query(`update rfqs set state = $2, published_at = now(), version = version + 1, updated_at = now() where id = $1`, [r.id, to]);
        await notifyInvited(sql, r, all, r.kind === 'tender' ? 'Invitation to tender' : 'New request for quotes', `${r.title}: respond by ${new Date(String(r.deadline)).toLocaleDateString('en-GB')}`);
        await publish(sql, 'RfqPublished', { rfqId: r.id, projectId: r.project_id, invited: all.length });
        await audit(sql, { actorUserId: user.id, action: 'rfq.published', targetType: 'Rfq', targetId: r.id, metadata: { invited: all, refused: [...res.refused, ...(seeded?.refused ?? [])].map((x) => x.orgId) } });
        return { state: to, invited: all.length, refused: [...res.refused, ...(seeded?.refused ?? [])], assistedSourcing: run.result.assistedSourcing };
      }
      if (cmd === 'close') {
        if (r.kind === 'tender') throw conflict('TENDER_OPENS_AT_DEADLINE', 'A tender closes when its bids are opened together at the deadline.');
        if (r.sealed && new Date(String(r.deadline)).getTime() > Date.now()) throw conflict('SEALED_UNTIL_DEADLINE', 'Quotes are sealed until the deadline, so this request closes then.');
        await sql.query(`update rfqs set state = $2, closed_at = now(), close_reason = $3, version = version + 1, updated_at = now() where id = $1`, [r.id, to, body.reason ?? 'Closed by the client']);
        await publish(sql, 'RfqClosed', { rfqId: r.id });
        await audit(sql, { actorUserId: user.id, action: 'rfq.closed', targetType: 'Rfq', targetId: r.id });
        return { state: to };
      }
      if (!body.reason) throw badRequest('VALIDATION_FAILED', 'Give a reason.', [{ path: 'reason', message: 'Required.' }]);
      await sql.query(`update rfqs set state = $2, close_reason = $3, closed_at = coalesce(closed_at, now()), version = version + 1, updated_at = now() where id = $1`, [r.id, to, body.reason]);
      if (cmd === 'no_award') {
        // Closed RFQs show prices to the client, so their live quotes can be rejected in this transaction.
        await sql.query(`update quote_versions set state = 'rejected', version = version + 1, updated_at = now() where rfq_id = $1 and state = any($2::text[])`, [r.id, LIVE_QUOTE_STATES]);
        await sql.query(`update quotes set status = 'rejected', updated_at = now() where rfq_id = $1 and status = any($2::text[])`, [r.id, LIVE_QUOTE_STATES]);
      }
      const orgs = await invitedOrgs();
      for (const o of orgs) await notify(sql, await orgUsers(sql, o), { kind: 'rfq', title: cmd === 'cancel' ? 'Request for quotes cancelled' : 'Request closed without an award', body: `${r.title}: ${body.reason}`, link: `/provider/rfqs/${r.id}` });
      await publish(sql, cmd === 'cancel' ? 'RfqCancelled' : 'RfqNoAward', { rfqId: r.id, reason: body.reason });
      await audit(sql, { actorUserId: user.id, action: `rfq.${cmd}`, targetType: 'Rfq', targetId: r.id, reason: body.reason });
      return { state: to };
    },
  });

  // Changing a published RFQ creates a new RfqVersion and marks live quotes as needing revision (§9.2).
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/revise', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ expectedVersion: z.number().int(), changeReason: z.string().trim().min(3).max(500), deadline: z.iso.datetime({ offset: true }).optional(), notes: z.string().trim().max(2000).nullable().optional(), lines: z.array(lineEdit).max(500).default([]) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'rfq.manage');
      if (r.version !== body.expectedVersion) throw conflict('STALE', 'Someone else changed this request. Reload and try again.');
      if (!rfqMachine.can(r.state, 'revise')) throw conflict('INVALID_TRANSITION', 'Only a published request can be revised.');
      const prev = await rfqLines(sql, r.current_version_id);
      const next: RfqLine[] = [];
      for (const l of prev) {
        const e = body.lines.find((x) => x.lineKey === l.lineKey);
        if (e?.remove) continue;
        next.push({ ...l, quantity: e?.quantity ? dec(e.quantity) : l.quantity, specification: e?.specification !== undefined ? e.specification : l.specification, description: e?.description ?? l.description, position: next.length + 1 });
      }
      if (!next.length) throw unprocessable('NO_LINES', 'A request needs at least one line. Cancel it instead.');
      if (next.some((l) => l.quantity <= 0n)) throw badRequest('VALIDATION_FAILED', 'Quantities must be above zero.');
      const deadline = body.deadline ? new Date(body.deadline) : new Date(String(r.deadline));
      if (deadline.getTime() <= Date.now()) throw badRequest('VALIDATION_FAILED', 'Check the deadline.', [{ path: 'deadline', message: 'The deadline must be in the future.' }]);
      const notes = body.notes !== undefined ? body.notes : r.notes;
      const changes = rfqChanges(prev, next);
      if (deadline.getTime() !== new Date(String(r.deadline)).getTime()) changes.push(`Deadline moved to ${deadline.toLocaleString('en-GB', { timeZone: s.pack.timeZone })}`);
      if ((notes ?? '') !== (r.notes ?? '')) changes.push('Notes changed');
      if (!changes.length) throw unprocessable('NO_CHANGES', 'Nothing changed.');
      const vid = uuidv7(); const number = r.current_version_number + 1;
      await sql.query(`insert into rfq_versions (id, rfq_id, project_id, number, change_reason, changes, deadline, notes, snapshot_hash, created_by) values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)`,
        [vid, r.id, r.project_id, number, body.changeReason, JSON.stringify(changes), deadline.toISOString(), notes, linesHash(next, deadline.toISOString(), notes), user.id]);
      await insertLines(sql, { id: r.id, projectId: r.project_id }, vid, next);
      await sql.query(`update rfqs set current_version_id = $2, current_version_number = $3, deadline = $4, notes = $5, version = version + 1, updated_at = now() where id = $1`, [r.id, vid, number, deadline.toISOString(), notes]);
      const marked = (await one<{ n: number }>(sql, `select rfq_mark_needs_revision($1) as n`, [r.id]))!.n;
      const orgs = (await many<{ provider_org_id: string }>(sql, `select provider_org_id from rfq_invitations where rfq_id = $1 and state not in ('revoked', 'declined')`, [r.id])).map((x) => x.provider_org_id);
      for (const o of orgs) await notify(sql, await orgUsers(sql, o), { kind: 'rfq', title: 'A request for quotes changed', body: `${r.title}: ${body.changeReason}. Review the changes and re-quote.`, link: `/provider/rfqs/${r.id}` });
      await publish(sql, 'RfqRevised', { rfqId: r.id, version: number, quotesNeedingRevision: marked });
      await audit(sql, { actorUserId: user.id, action: 'rfq.revised', targetType: 'Rfq', targetId: r.id, reason: body.changeReason, metadata: { version: number, changes } });
      return { versionNumber: number, changes, quotesNeedingRevision: marked };
    },
  });

  // ---------------------------------------------------------------- comparison (§10.4 step 4, §19.2 sealed quotes)
  route(app, s, {
    method: 'GET', url: '/v1/rfqs/:id/comparison', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await rfqRow(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'rfq.read');
      const quotes = await many<Row>(sql, `select q.*, o.name from quotes q join organizations o on o.id = q.provider_org_id where q.rfq_id = $1 and q.status <> 'draft' order by o.name`, [r.id]);
      if (pricesSealed(sealOf(r))) {
        return { sealed: true, kind: r.kind, sealedUntil: iso(r.deadline), count: quotes.length, statuses: quotes.map((q) => ({ providerName: q.name, status: q.status })),
          message: r.kind === 'tender' ? 'Bids are sealed until they are opened together at the deadline: you see how many arrived, not their prices or responses.' : 'Quotes are sealed until the deadline: you see how many arrived, not their prices. This prevents bid shopping.' };
      }
      const lines = await rfqLines(sql, r.current_version_id);
      const cq: ComparisonQuote[] = [];
      for (const q of quotes) {
        const v = await one<Row>(sql, `select * from quote_versions where id = $1 and state = any($2::text[])`, [q.current_version_id, [...LIVE_QUOTE_STATES, 'accepted', 'rejected']]);
        if (!v) continue;
        const d = qvDomain(v, await qLines(sql, v.id));
        cq.push({ quoteId: q.id, versionId: v.id, versionNumber: v.number, providerOrgId: q.provider_org_id, providerName: q.name, state: v.state === 'needs_revision' || v.rfq_version_number !== r.current_version_number ? 'needs_revision' : v.state, terms: d.terms, lines: d.lines });
      }
      const declined = await many<Row>(sql, `select i.provider_org_id, i.decline_reason, o.name from rfq_invitations i join organizations o on o.id = i.provider_org_id where i.rfq_id = $1 and i.state = 'declined'`, [r.id]);
      const waiting = await many<Row>(sql, `select o.name from rfq_invitations i join organizations o on o.id = i.provider_org_id left join quotes q on q.invitation_id = i.id where i.rfq_id = $1 and i.state in ('invited', 'viewed') and (q.id is null or q.status = 'draft')`, [r.id]);
      const c = compareQuotes(lines, cq, declined.map((d) => ({ providerOrgId: d.provider_org_id, providerName: d.name, reason: d.decline_reason })));
      const access = await projectAccess(sql, user, r.project_id, 'rfq.read');
      const t = today();
      return {
        sealed: false, rfqState: r.state, rfqVersion: r.version, versionNumber: r.current_version_number, currency: r.currency,
        ...c,
        rows: c.rows.map((row) => ({ ...row, line: { ...row.line, unitLabel: unitLabel(row.line.unit) }, cells: row.cells.map((cell) => ({ ...cell, display: cell.source ? { unitPrice: money(cell.source.unitPriceMinor, r.currency).display, amount: money(cell.source.amountMinor, r.currency).display, perBase: cell.normalized ? `${money(Math.round(cell.normalized.perBaseMinor), r.currency).display} per ${unitLabel(cell.normalized.baseUnit)}` : null } : null })) })),
        columns: c.columns.map((col) => {
          const v = cq.find((x) => x.versionId === col.versionId)!;
          const blockers = awardBlockers({ state: v.state, validUntil: v.terms.validUntil, rfqVersionNumber: v.state === 'needs_revision' ? -1 : r.current_version_number }, { state: r.state, currentVersionNumber: r.current_version_number }, t);
          return { ...col, display: { lines: money(col.totals.linesMinor, r.currency).display, delivery: money(col.totals.deliveryMinor, r.currency).display, tax: money(col.totals.taxMinor, r.currency).display, gross: money(col.totals.grossMinor, r.currency).display }, awardBlockers: access.role === 'owner' ? blockers : ['Only the project owner can award.'] };
        }),
        lowestTotal: c.lowestTotal ? { ...c.lowestTotal, display: money(c.lowestTotal.grossMinor, r.currency).display } : null,
        waiting: waiting.map((w) => w.name),
        canAward: access.role === 'owner' && !access.viaStaffSession && r.state === 'closed',
        kind: r.kind,
        tender: r.kind === 'tender' ? await tenderComparisonExtras(sql, s, r, c.columns, user, access) : null,
      };
    },
  });

  // ---------------------------------------------------------------- award → record-only order (§10.4 steps 6–7, §14.1)
  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/award', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ quoteVersionId: z.uuid(), expectedVersion: z.number().int(), reason: z.string().trim().max(500).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      const access = await projectAccess(sql, user, r.project_id, 'rfq.award');
      if (access.viaStaffSession) throw forbidden();
      if (r.version !== body.expectedVersion) throw conflict('STALE', 'Someone else changed this request. Reload and try again.');
      const v = await one<Row>(sql, `select * from quote_versions where id = $1 and rfq_id = $2`, [body.quoteVersionId, r.id]);
      if (!v) throw notFound('Quote');
      const q = (await one<Row>(sql, `select * from quotes where id = $1`, [v.quote_id]))!;
      if (q.current_version_id !== v.id) throw conflict('NOT_CURRENT', 'This is not the supplier’s current quote version.');
      const blockers = awardBlockers({ state: v.state, validUntil: v.valid_until ? String(iso(v.valid_until)).slice(0, 10) : '', rfqVersionNumber: v.rfq_version_number }, { state: r.state, currentVersionNumber: r.current_version_number }, today());
      if (blockers.length) throw conflict('AWARD_BLOCKED', blockers[0]!, { blockers });
      if (cfg.blockAwardIfIneligible) {
        const run = await runMatch(sql, s, r, user, new Date().toISOString());
        const out = run.result.ineligible.find((x) => x.orgId === v.provider_org_id);
        if (out || !run.result.eligible.some((x) => x.orgId === v.provider_org_id)) throw conflict('PROVIDER_INELIGIBLE', `This provider no longer passes the required checks: ${(out?.reasons ?? ['not eligible']).join(' ')}`);
      }
      await sql.query(`update quote_versions set state = $2, version = version + 1, updated_at = now() where id = $1`, [v.id, quoteMachine.next(v.state, 'accept')]);
      await sql.query(`update quotes set status = 'accepted', updated_at = now() where id = $1`, [q.id]);
      const others = await many<Row>(sql, `select q.id, q.provider_org_id, q.current_version_id from quotes q where q.rfq_id = $1 and q.id <> $2 and q.status = any($3::text[])`, [r.id, q.id, LIVE_QUOTE_STATES]);
      for (const o of others) {
        await sql.query(`update quote_versions set state = 'rejected', version = version + 1, updated_at = now() where id = $1 and state = any($2::text[])`, [o.current_version_id, LIVE_QUOTE_STATES]);
        await sql.query(`update quotes set status = 'rejected', updated_at = now() where id = $1`, [o.id]);
        await notify(sql, await orgUsers(sql, o.provider_org_id), { kind: 'rfq', title: 'Your quote was not selected', body: r.title, link: `/provider/rfqs/${r.id}` });
      }
      const orderId = uuidv7();
      const n = (await one<{ n: number }>(sql, `select coalesce(max(number), 0)::int + 1 as n from orders where project_id = $1`, [r.project_id]))!.n;
      const snapshot = json<Row>(v.snapshot);
      const totals = json<Record<string, string>>(v.totals);
      // A tender award is a contract: it keeps the package's retention and is fulfilled by its milestones (§10.5 step 6).
      const pkg = r.kind === 'tender' ? await packageOf(sql, r.id) : null;
      await sql.query(`insert into orders (id, project_id, number, rfq_id, quote_id, quote_version_id, provider_org_id, currency, total_minor, terms, terms_hash, award_reason, awarded_by, kind, retention_pct, contract_value_minor)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14, $15, $9)`,
      [orderId, r.project_id, n, r.id, q.id, v.id, v.provider_org_id, v.currency, totals.grossMinor, JSON.stringify(snapshot), v.snapshot_hash, body.reason ?? null, user.id, r.kind === 'tender' ? 'contract' : 'supply', pkg?.retentionPct ?? 0]);
      await createFirstRevision(sql, { orderId, projectId: r.project_id, providerOrgId: v.provider_org_id, valueMinor: BigInt(totals.grossMinor!), termsHash: v.snapshot_hash, completionDate: pkg?.finishDate ?? null, userId: user.id });
      await sql.query(`update rfqs set state = $2, awarded_quote_version_id = $3, order_id = $4, version = version + 1, updated_at = now() where id = $1`, [r.id, rfqMachine.next(r.state, 'award'), v.id, orderId]);
      await notify(sql, await orgUsers(sql, v.provider_org_id), { kind: 'order', title: r.kind === 'tender' ? 'You have been awarded the contract' : 'You have been awarded an order', body: `${r.title}: confirm the ${r.kind === 'tender' ? 'award' : 'order'} to proceed.`, link: `/provider/orders/${orderId}` });
      await publish(sql, 'AwardMade', { rfqId: r.id, quoteVersionId: v.id, orderId, orgId: v.provider_org_id });
      await audit(sql, { actorUserId: user.id, action: 'rfq.awarded', targetType: 'Rfq', targetId: r.id, reason: body.reason ?? null, metadata: { quoteVersionId: v.id, orderId, termsHash: v.snapshot_hash } });
      return { orderId, number: n, paymentNotice: RECORD_ONLY_PAYMENT_NOTICE };
    },
  });

  // ---------------------------------------------------------------- provider side: inbox, decline, quote drafts
  route(app, s, {
    method: 'GET', url: '/v1/provider/rfqs', auth: 'user',
    handler: async ({ sql, user }) => {
      const orgs = await myOrgIds(sql, user);
      if (!orgs.length) return { items: [], orders: [] };
      const rows = await many<Row>(sql, `select i.id as invitation_id, i.state as invitation_state, i.provider_org_id, o.name as org_name, r.*, c.name as category_name, q.status as quote_status
        from rfq_invitations i join rfqs r on r.id = i.rfq_id join organizations o on o.id = i.provider_org_id join categories c on c.slug = r.category_slug
        left join quotes q on q.invitation_id = i.id where i.provider_org_id = any($1::uuid[]) and i.state <> 'revoked' and r.state <> 'draft' order by r.deadline desc`, [orgs]);
      const orders = await many<Row>(sql, `select d.id, d.number, d.state, d.kind, d.total_minor, d.currency, d.created_at, r.title from orders d join rfqs r on r.id = d.rfq_id where d.provider_org_id = any($1::uuid[]) order by d.created_at desc`, [orgs]);
      return {
        items: rows.map((r) => ({ ...rfqBase(s, r, r.category_name), provider: { orgId: r.provider_org_id, name: r.org_name }, invitationState: r.invitation_state, quoteStatus: r.quote_status })),
        orders: orders.map((o) => ({ id: o.id, number: o.number, kind: o.kind, state: o.state, title: o.title, total: money(o.total_minor, o.currency), createdAt: iso(o.created_at) })),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/decline', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ reason: z.string().trim().min(2).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await rfqRow(sql, params.id);
      const side = await sideOf(sql, user, r);
      if (side.side !== 'provider') throw notFound('Invitation');
      if (!invitationMachine.can(side.invitation.state, 'decline')) throw conflict('INVALID_TRANSITION', 'You have already answered this request. Withdraw your quote instead.');
      await sql.query(`update rfq_invitations set state = 'declined', decline_reason = $2, responded_at = now() where id = $1`, [side.invitation.id, body.reason]);
      await notify(sql, [r.created_by], { kind: 'rfq', title: 'A provider declined to quote', body: `${r.title}: ${body.reason}`, link: `/projects/${r.project_id}/rfqs/${r.id}` });
      await publish(sql, 'QuoteDeclined', { rfqId: r.id, orgId: side.orgId });
      return { state: 'declined' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/rfqs/:id/quotes', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await rfqRow(sql, params.id);
      const side = await sideOf(sql, user, r);
      if (side.side !== 'provider') throw notFound('Invitation');
      if (r.state !== 'published' || new Date(String(r.deadline)).getTime() <= Date.now()) throw conflict('NOT_ACCEPTING', 'This request is no longer accepting quotes.');
      if (side.invitation.state === 'declined') throw conflict('DECLINED', 'You declined this request.');
      let q = await one<Row>(sql, `select * from quotes where rfq_id = $1 and provider_org_id = $2`, [r.id, side.orgId]);
      if (!q) {
        const id = uuidv7();
        await sql.query(`insert into quotes (id, rfq_id, project_id, provider_org_id, invitation_id, created_by) values ($1, $2, $3, $4, $5, $6)`, [id, r.id, r.project_id, side.orgId, side.invitation.id, user.id]);
        q = (await one<Row>(sql, `select * from quotes where id = $1`, [id]))!;
      }
      const draft = await one<Row>(sql, `select id from quote_versions where quote_id = $1 and state = 'draft'`, [q.id]);
      if (draft) return { quoteId: q.id, versionId: draft.id };
      // A new version starts from the previous one (negotiation, or a changed RFQ), never by editing it.
      const prev = await one<Row>(sql, `select * from quote_versions where quote_id = $1 order by number desc limit 1`, [q.id]);
      const prevLines = prev ? await qLines(sql, prev.id) : [];
      const lines = await rfqLines(sql, r.current_version_id);
      const vid = uuidv7();
      const validUntil = new Date(Date.now() + cfg.defaultQuoteValidityDays * DAY).toISOString().slice(0, 10);
      const response = r.kind === 'tender' ? JSON.stringify(prev?.tender_response ? json(prev.tender_response) : EMPTY_TENDER_RESPONSE) : null;
      await sql.query(`insert into quote_versions (id, quote_id, rfq_id, project_id, provider_org_id, number, rfq_version_number, currency, delivery_minor, delivery_tax_rate_pct, valid_until, payment_terms, warranty, lead_time_days, exclusions, notes, created_by, tender_response)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16, $17, $18::jsonb)`,
      [vid, q.id, r.id, r.project_id, side.orgId, (prev?.number ?? 0) + 1, r.current_version_number, r.currency, prev?.delivery_minor ?? 0, prev?.delivery_tax_rate_pct ?? s.pack.tax.ratePercent, validUntil,
        prev?.payment_terms ?? null, prev?.warranty ?? null, prev?.lead_time_days ?? null, JSON.stringify(prev ? json(prev.exclusions) : []), prev?.notes ?? null, user.id, response]);
      let pos = 0;
      for (const l of lines) {
        const p = prevLines.find((x) => x.rfq_line_key === l.lineKey);
        await sql.query(`insert into quote_lines (id, quote_version_id, quote_id, project_id, provider_org_id, rfq_line_key, position, status, offered, is_substitution, substitution_note, unit, quantity, pack_value, pack_unit, unit_price_minor, tax_rate_pct, availability, lead_time_days)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [uuidv7(), vid, q.id, r.project_id, side.orgId, l.lineKey, ++pos, p?.status ?? 'priced', p?.offered ?? null, p?.is_substitution ?? false, p?.substitution_note ?? null,
          p?.unit ?? l.unit, p && p.unit === l.unit ? formatDec(l.quantity) : p ? String(p.quantity) : formatDec(l.quantity), p?.pack_value ?? l.pack?.value ?? null, p?.pack_unit ?? l.pack?.unit ?? null,
          p?.unit_price_minor ?? 0, p?.tax_rate_pct ?? s.pack.tax.ratePercent, p?.availability ?? null, p?.lead_time_days ?? null]);
      }
      return { quoteId: q.id, versionId: vid };
    },
  });

  async function loadQv(sql: Sql, user: Actor, id: string) {
    const v = await one<Row>(sql, `select * from quote_versions where id = $1`, [id]);
    if (!v) throw notFound('Quote');
    const r = await rfqRow(sql, v.rfq_id);
    const side = await sideOf(sql, user, r);
    if (side.side === 'provider' && side.orgId !== v.provider_org_id) throw notFound('Quote');
    return { v, r, side };
  }

  route(app, s, {
    method: 'GET', url: '/v1/quote-versions/:id', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const { v, r, side } = await loadQv(sql, user, params.id);
      const lines = await rfqLines(sql, r.current_version_id);
      const view = quoteVersionView(s, v, await qLines(sql, v.id));
      const cat = await categoryInfo(sql, s, r.category_slug);
      return {
        ...view, side: side.side, editable: side.side === 'provider' && v.state === 'draft', commands: side.side === 'provider' ? view.commands : [],
        rfq: { ...rfqBase(s, r, cat.name), lines: lines.map(lineView) }, clarifications: await clarificationsOf(sql, v.quote_id),
        problems: v.state === 'draft' ? [...quoteProblems(lines, qvDomain(v, await qLines(sql, v.id)).lines, qvDomain(v, []).terms, today()), ...(r.kind === 'tender' ? responseProblems((await packageOf(sql, r.id))!, json<TenderResponse>(v.tender_response) ?? EMPTY_TENDER_RESPONSE) : [])] : [],
        package: r.kind === 'tender' ? await packageOf(sql, r.id) : null,
      };
    },
  });

  route(app, s, {
    method: 'PUT', url: '/v1/quote-versions/:id', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({
      expectedVersion: z.number().int(), lines: z.array(quoteLineSchema).min(1).max(500),
      deliveryCharge: z.string().max(20).default('0'), deliveryTaxRatePct: z.number().min(0).max(50).default(0), validUntil: z.iso.date(),
      paymentTerms: z.string().trim().max(300).nullable().optional(), warranty: z.string().trim().max(300).nullable().optional(), leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
      exclusions: z.array(z.string().trim().min(1).max(300)).max(30).default([]), notes: z.string().trim().max(2000).nullable().optional(),
      tenderResponse: tenderResponseSchema.optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const { v, r, side } = await loadQv(sql, user, params.id);
      if (side.side !== 'provider') throw notFound('Quote');
      if (v.state !== 'draft') throw conflict('IMMUTABLE', 'A submitted quote cannot be changed. Start a new version.');
      if (v.version !== body.expectedVersion) throw conflict('STALE', 'This draft changed in another window. Reload and try again.');
      const keys = new Set((await rfqLines(sql, r.current_version_id)).map((l) => l.lineKey));
      const errs: { path: string; message: string }[] = [];
      const parsed = body.lines.map((l, i) => {
        const price = parseMajor(l.unitPrice || '0', v.currency);
        if (price == null) errs.push({ path: `lines.${i}.unitPrice`, message: 'Enter a price like 9500 or 9500.50.' });
        if (!keys.has(l.rfqLineKey)) errs.push({ path: `lines.${i}.rfqLineKey`, message: 'Not a line of this request.' });
        if (l.packUnit && !Object.hasOwn(UNITS, l.packUnit)) errs.push({ path: `lines.${i}.packUnit`, message: 'Unknown unit.' });
        return { ...l, price: price ?? 0n };
      });
      const delivery = parseMajor(body.deliveryCharge || '0', v.currency);
      if (delivery == null) errs.push({ path: 'deliveryCharge', message: 'Enter an amount.' });
      if (errs.length) throw badRequest('VALIDATION_FAILED', 'Check the quote.', errs);
      await sql.query(`delete from quote_lines where quote_version_id = $1`, [v.id]);
      let pos = 0;
      for (const l of parsed) {
        await sql.query(`insert into quote_lines (id, quote_version_id, quote_id, project_id, provider_org_id, rfq_line_key, position, status, offered, is_substitution, substitution_note, unit, quantity, pack_value, pack_unit, unit_price_minor, tax_rate_pct, availability, lead_time_days)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [uuidv7(), v.id, v.quote_id, v.project_id, v.provider_org_id, l.rfqLineKey, ++pos, l.status, l.offered ?? null, l.isSubstitution, l.substitutionNote ?? null, l.unit, l.quantity, l.packValue ?? null, l.packUnit ?? null, String(l.price), l.taxRatePct, l.availability ?? null, l.leadTimeDays ?? null]);
      }
      const response = r.kind === 'tender' ? JSON.stringify({ ...EMPTY_TENDER_RESPONSE, ...(json<TenderResponse>(v.tender_response) ?? {}), ...(body.tenderResponse ?? {}) }) : null;
      await sql.query(`update quote_versions set delivery_minor = $2, delivery_tax_rate_pct = $3, valid_until = $4, payment_terms = $5, warranty = $6, lead_time_days = $7, exclusions = $8::jsonb, notes = $9, tender_response = $10::jsonb, version = version + 1, updated_at = now() where id = $1`,
        [v.id, String(delivery), body.deliveryTaxRatePct, body.validUntil, body.paymentTerms ?? null, body.warranty ?? null, body.leadTimeDays ?? null, JSON.stringify(body.exclusions), body.notes ?? null, response]);
      return { version: v.version + 1 };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/quote-versions/:id/submit', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ expectedVersion: z.number().int() }),
    handler: async ({ sql, params, body, user }) => {
      const { v, r, side } = await loadQv(sql, user, params.id);
      if (side.side !== 'provider') throw notFound('Quote');
      if (v.version !== body.expectedVersion) throw conflict('STALE', 'This draft changed in another window. Reload and try again.');
      if (!quoteMachine.can(v.state, 'submit')) throw conflict('INVALID_TRANSITION', 'This version was already submitted.');
      // Server time decides lateness (§19.2); late quotes are rejected.
      if (r.state !== 'published' || new Date(String(r.deadline)).getTime() <= Date.now()) throw conflict('LATE', 'The deadline has passed; this request no longer accepts quotes.');
      if (v.rfq_version_number !== r.current_version_number) throw conflict('RFQ_CHANGED', 'The request changed since you started this draft. Start a new version against the latest request.');
      const rfqL = await rfqLines(sql, r.current_version_id);
      const rows = await qLines(sql, v.id);
      const d = qvDomain(v, rows);
      const tenderResponse = r.kind === 'tender' ? json<TenderResponse>(v.tender_response) ?? EMPTY_TENDER_RESPONSE : null;
      const pkg = r.kind === 'tender' ? await packageOf(sql, r.id) : null;
      const problems = [...quoteProblems(rfqL, d.lines, d.terms, today()), ...(pkg && tenderResponse ? responseProblems(pkg, tenderResponse) : [])];
      if (problems.length) throw unprocessable('QUOTE_INCOMPLETE', problems[0]!, { problems });
      const t = quoteTotals(d.lines, d.terms);
      const org = await one<Row>(sql, `select name from organizations where id = $1`, [v.provider_org_id]);
      const submittedAt = new Date().toISOString();
      const totals = { linesMinor: String(t.linesMinor), deliveryMinor: String(t.deliveryMinor), taxMinor: String(t.taxMinor), grossMinor: String(t.grossMinor) };
      const snapshot = {
        kind: r.kind === 'tender' ? 'TenderBid' : 'QuoteVersion', quoteId: v.quote_id, quoteVersionId: v.id, number: v.number, rfqId: r.id, rfqReference: rfqRef(r), rfqVersionNumber: r.current_version_number,
        ...(tenderResponse ? { tenderResponse, responseNotes: responseNotes(pkg!, tenderResponse) } : {}),
        provider: { orgId: v.provider_org_id, name: org?.name ?? '' }, currency: v.currency, submittedAt, scope: MATURITY[r.scope_maturity as Maturity].label,
        terms: { ...d.terms, deliveryMinor: String(d.terms.deliveryMinor) },
        lines: d.lines.map((l) => {
          const rl = rfqL.find((x) => x.lineKey === l.rfqLineKey);
          return { ...l, description: rl?.description ?? '', quantity: formatDec(l.quantity), unitPriceMinor: String(l.unitPriceMinor), amountMinor: String(quoteLineAmount(l)) };
        }),
        totals,
      };
      const hash = sha256(canonicalJson(snapshot));
      const prior = await many<Row>(sql, `select id, state from quote_versions where quote_id = $1 and id <> $2 and state = any($3::text[])`, [v.quote_id, v.id, LIVE_QUOTE_STATES]);
      for (const p of prior) await sql.query(`update quote_versions set state = $2, version = version + 1, updated_at = now() where id = $1`, [p.id, quoteMachine.next(p.state, 'replace')]);
      await sql.query(`update quote_versions set state = 'submitted', totals = $2::jsonb, snapshot = $3::jsonb, snapshot_hash = $4, submitted_at = $5, submitted_by = $6, version = version + 1, updated_at = now() where id = $1`,
        [v.id, JSON.stringify(totals), JSON.stringify(snapshot), hash, submittedAt, user.id]);
      await sql.query(`update quotes set status = 'submitted', current_version_id = $2, updated_at = now() where id = $1`, [v.quote_id, v.id]);
      const inv = side.invitation;
      if (invitationMachine.can(inv.state, 'quote')) await sql.query(`update rfq_invitations set state = 'quoted', responded_at = coalesce(responded_at, now()) where id = $1`, [inv.id]);
      await notify(sql, [r.created_by], { kind: 'rfq', title: v.number > 1 ? 'A supplier revised their quote' : 'New quote received', body: `${org?.name ?? 'A supplier'} for ${r.title}`, link: `/projects/${r.project_id}/rfqs/${r.id}` });
      await publish(sql, 'QuoteSubmitted', { rfqId: r.id, quoteId: v.quote_id, versionId: v.id, orgId: v.provider_org_id, number: v.number });
      await audit(sql, { actorUserId: user.id, action: 'quote.submitted', targetType: 'QuoteVersion', targetId: v.id, metadata: { snapshotHash: hash } });
      return { state: 'submitted', snapshotHash: hash, total: money(t.grossMinor, v.currency) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/quote-versions/:id/withdraw', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    body: z.object({ reason: z.string().trim().min(2).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const { v, r, side } = await loadQv(sql, user, params.id);
      if (side.side !== 'provider') throw notFound('Quote');
      if (!quoteMachine.can(v.state, 'withdraw')) throw conflict('INVALID_TRANSITION', 'This quote can no longer be withdrawn.');
      const blocker = withdrawalBlocker(sealOf(r));
      if (blocker) throw conflict(r.kind === 'tender' ? 'DEADLINE_PASSED' : 'INVALID_TRANSITION', blocker);
      await sql.query(`update quote_versions set state = 'withdrawn', version = version + 1, updated_at = now() where id = $1`, [v.id]);
      const q = (await one<Row>(sql, `select current_version_id from quotes where id = $1`, [v.quote_id]))!;
      if (q.current_version_id === v.id || v.state === 'draft') await sql.query(`update quotes set status = case when current_version_id = $2 then 'withdrawn' else status end, updated_at = now() where id = $1`, [v.quote_id, v.id]);
      if (v.state !== 'draft') {
        await notify(sql, [r.created_by], { kind: 'rfq', title: 'A supplier withdrew their quote', body: `${r.title}: ${body.reason}`, link: `/projects/${r.project_id}/rfqs/${r.id}` });
        await publish(sql, 'QuoteWithdrawn', { rfqId: r.id, versionId: v.id, reason: body.reason });
      }
      return { state: 'withdrawn' };
    },
  });

  // Clarifications attach to the quote (§10.4 step 5); a material change needs a new quote version.
  route(app, s, {
    method: 'POST', url: '/v1/quotes/:id/clarifications', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({ body: z.string().trim().min(2).max(2000) }),
    handler: async ({ sql, params, body, user }) => {
      const q = await one<Row>(sql, `select * from quotes where id = $1`, [params.id]);
      if (!q) throw notFound('Quote');
      const r = await rfqRow(sql, q.rfq_id);
      const side = await sideOf(sql, user, r);
      if (side.side === 'provider' && side.orgId !== q.provider_org_id) throw notFound('Quote');
      if (side.side === 'client' && (side.access.viaStaffSession || !['owner', 'manager'].includes(side.access.role))) throw forbidden();
      if (side.side === 'client' && q.status === 'draft') throw notFound('Quote');
      const id = uuidv7();
      await sql.query(`insert into quote_clarifications (id, quote_id, rfq_id, project_id, provider_org_id, side, body, author_user_id) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, q.id, r.id, r.project_id, q.provider_org_id, side.side, body.body, user.id]);
      if (side.side === 'client') await notify(sql, await orgUsers(sql, q.provider_org_id), { kind: 'rfq', title: 'Question about your quote', body: r.title, link: `/provider/rfqs/${r.id}` });
      else await notify(sql, [r.created_by], { kind: 'rfq', title: 'A supplier replied about their quote', body: r.title, link: `/projects/${r.project_id}/rfqs/${r.id}` });
      await publish(sql, 'ClarificationRaised', { rfqId: r.id, quoteId: q.id, side: side.side });
      return { id };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/quotes/:id/clarifications', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const q = await one<Row>(sql, `select * from quotes where id = $1`, [params.id]);
      if (!q) throw notFound('Quote');
      const side = await sideOf(sql, user, await rfqRow(sql, q.rfq_id));
      if (side.side === 'provider' && side.orgId !== q.provider_org_id) throw notFound('Quote');
      return { items: await clarificationsOf(sql, q.id) };
    },
  });

  // ---------------------------------------------------------------- orders (§9.4), record-only payment (§14.1)
  route(app, s, {
    method: 'GET', url: '/v1/orders/:id', auth: 'user', params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const { o, side, canManage: canClient } = await orderSide(sql, user, params.id);
      const terms = json<Row>(o.terms);
      const r = await rfqRow(sql, o.rfq_id);
      const org = await one<Row>(sql, `select name, handle from organizations where id = $1`, [o.provider_org_id]);
      const commands = orderMachine.commandsFrom(o.state).filter((c) => {
        const who = ORDER_ACTOR[c];
        return who === 'either' ? side === 'provider' || canClient : who === 'provider' ? side === 'provider' : who === 'client' ? canClient : false;
      });
      return {
        id: o.id, number: o.number, reference: `${o.kind === 'contract' ? 'CT' : 'PO'}-${String(o.number).padStart(3, '0')}`, state: o.state, side, version: o.version, kind: o.kind,
        contractValue: money(o.contract_value_minor, o.currency), revisionNumber: o.revision_number, retentionPct: Number(o.retention_pct),
        projectId: side === 'client' ? o.project_id : null, rfq: { id: r.id, reference: `RFQ-${String(r.number).padStart(3, '0')}`, title: r.title, area: findArea(s.pack, r.area_code)?.label ?? r.area_code },
        provider: { orgId: o.provider_org_id, name: org?.name, handle: org?.handle }, total: money(o.total_minor, o.currency),
        terms: { ...terms, lines: (terms.lines ?? []).map((l: Row) => ({ ...l, unitPriceDisplay: money(l.unitPriceMinor, o.currency).display, amountDisplay: money(l.amountMinor, o.currency).display, unitLabel: unitLabel(l.unit) })) },
        termsHash: o.terms_hash, quoteVersionId: o.quote_version_id, awardReason: o.award_reason, createdAt: iso(o.created_at), confirmedAt: iso(o.confirmed_at), cancelReason: o.cancel_reason,
        fulfilledAt: iso(o.fulfilled_at), closedAt: iso(o.closed_at),
        paymentMode: o.payment_mode, paymentNotice: RECORD_ONLY_PAYMENT_NOTICE, commands,
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/commands/:command', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid(), command: z.enum(['confirm', 'cancel', 'dispute', 'close', 'resume']) }),
    body: z.object({ expectedVersion: z.number().int(), reason: z.string().trim().min(3).max(500).optional(), caseType: z.enum(CASE_TYPE_KEYS as [CaseType, ...CaseType[]]).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const { o, side, canManage: canClient } = await orderSide(sql, user, params.id);
      const cmd = params.command as OrderCommand;
      const who = ORDER_ACTOR[cmd];
      if (!(who === 'either' ? side === 'provider' || canClient : who === 'provider' ? side === 'provider' : who === 'client' ? canClient : false)) throw forbidden();
      if (o.version !== body.expectedVersion) throw conflict('STALE', 'This order changed. Reload and try again.');
      const verb: Record<string, string> = { confirm: 'confirmed', cancel: 'cancelled', dispute: 'disputed', close: 'closed', resume: 'resumed' };
      if (!orderMachine.can(o.state, cmd)) throw conflict('INVALID_TRANSITION', `A ${o.state.replace(/_/g, ' ')} order can't be ${verb[cmd]}.`);
      if ((cmd === 'cancel' || cmd === 'dispute' || cmd === 'resume') && !body.reason) throw badRequest('VALIDATION_FAILED', 'Give a reason.', [{ path: 'reason', message: 'Required.' }]);
      if (cmd === 'cancel' && (await one(sql, `select 1 from deliveries where order_id = $1 and state <> 'cancelled'`, [o.id]))) throw conflict('HAS_DELIVERIES', 'Cancel the booked deliveries first. Goods already received cannot be cancelled; raise a dispute instead.');
      if (cmd === 'close') {
        const c = o.kind === 'contract' ? await contractCloseCheck(sql, o) : await orderCloseCheck(sql, s, o);
        if (c.blockers.length) throw conflict('CLOSE_BLOCKED', c.blockers[0]!, { blockers: c.blockers });
      }
      const to = orderMachine.next(o.state, cmd);
      await sql.query(`update orders set state = $2, confirmed_at = case when $3 then now() else confirmed_at end, confirmed_by = case when $3 then $4::uuid else confirmed_by end,
          cancel_reason = coalesce($5, cancel_reason), closed_at = case when $6 then now() else closed_at end, closed_by = case when $6 then $4::uuid else closed_by end, version = version + 1, updated_at = now() where id = $1`,
        [o.id, to, cmd === 'confirm', user.id, cmd === 'cancel' || cmd === 'dispute' ? body.reason : null, cmd === 'close']);
      const r = await rfqRow(sql, o.rfq_id);
      if (side === 'provider') await notify(sql, [o.awarded_by, r.created_by], { kind: 'order', title: `Order ${verb[cmd]} by the supplier`, body: r.title, link: `/projects/${o.project_id}/orders/${o.id}` });
      else await notify(sql, await orgUsers(sql, o.provider_org_id), { kind: 'order', title: `Order ${verb[cmd]} by the client`, body: body.reason ? `${r.title}: ${body.reason}` : r.title, link: `/provider/orders/${o.id}` });
      const event = ({ confirm: 'OrderConfirmed', cancel: 'OrderCancelled', dispute: 'OrderDisputed', close: 'OrderClosed', resume: 'OrderResumed' } as const)[cmd as 'confirm'];
      await publish(sql, event, { orderId: o.id, orgId: o.provider_org_id });
      await audit(sql, { actorUserId: user.id, action: `order.${cmd}`, targetType: 'Order', targetId: o.id, reason: body.reason ?? null });
      // A resumed order catches up with what was delivered while it was disputed.
      const after = cmd === 'resume' ? await syncOrder(sql, s, o.id) : null;
      // A disputed order becomes a supplier case (§13.3); staff triage it in the moderation area.
      const opened = cmd === 'dispute'
        ? await openCase(sql, s, { order: o, source: 'order', type: body.caseType ?? (side === 'provider' ? 'non_payment' : 'non_delivery'), summary: body.reason!, raisedBy: user.id, raisedSide: side })
        : null;
      return { state: after?.state ?? to, caseId: opened?.id ?? null, caseReference: opened?.reference ?? null, emergencyMessage: opened?.emergencyMessage ?? null };
    },
  });

  // ---------------------------------------------------------------- provider profile (§3.17: storefront → provider profile)
  route(app, s, {
    method: 'GET', url: '/v1/providers/:handle', auth: 'public', params: z.object({ handle: z.string().min(2).max(80) }),
    handler: async ({ sql, params }) => {
      const o = await one<Row>(sql, `select o.*, pp.accepts_rfqs, pp.capacity_note from organizations o left join provider_profiles pp on pp.org_id = o.id where o.handle = $1`, [params.handle]);
      if (!o) throw notFound('Provider');
      const listings = await many<Row>(sql, `select l.category_slug, c.name as category_name, l.area_code, l.service_areas from listings l join categories c on c.slug = l.category_slug where l.seller_org_id = $1 and l.status = 'live'`, [o.id]);
      const checks = await many<Row>(sql, `select check_type, state, checked_at, expires_at from verification_checks where org_id = $1 order by checked_at desc`, [o.id]);
      const stats = (await many<Row>(sql, `select * from provider_match_stats($1::uuid[], $2, $3)`, [[o.id], s.pack.policy.reputationWindowDays, s.pack.policy.replyWindowHours]))[0] ?? {};
      const threads = Number(stats.threads ?? 0);
      const perf = (await performanceFor(sql, s, [o.id])).get(o.id);
      const tx = (await transactionReviewStats(sql, s, [o.id])).get(o.id)!;
      const recent = await many<Row>(sql, `select t.*, c.name as category_name from transaction_reviews t left join categories c on c.slug = t.category_slug
          where t.provider_org_id = $1 and t.author_side = 'client' and t.status = 'published' and (t.window_closes_at < now() or exists (select 1 from transaction_reviews x where x.order_id = t.order_id and x.author_side = 'provider'))
          order by t.created_at desc limit 20`, [o.id]);
      const areaCodes = [...new Set(listings.flatMap((l) => [l.area_code, ...(l.service_areas ?? [])]))];
      const now = Date.now();
      return {
        orgId: o.id, name: o.name, handle: o.handle, kind: o.kind, memberSince: iso(o.created_at), acceptsRfqs: o.accepts_rfqs !== false, capacityNote: o.capacity_note,
        categories: [...new Map(listings.map((l) => [l.category_slug, { slug: l.category_slug, name: l.category_name }])).values()],
        serviceAreas: areaCodes.map((c) => findArea(s.pack, c)).filter(Boolean).map((a) => ({ code: a!.code, label: a!.label, region: a!.region.label })),
        // Verification history: every check, with its state and dates (§13.2). Evidence stays restricted.
        verification: checks.map((c) => {
          const expired = c.state === 'passed' && c.expires_at && new Date(String(c.expires_at)).getTime() < now;
          return { type: c.check_type, label: checkLabel(c.check_type as CheckType), state: expired ? 'expired' : c.state, checkedAt: iso(c.checked_at), expiresAt: iso(c.expires_at) };
        }),
        verificationStatement: VERIFICATION_STATEMENT,
        performance: {
          rfqInvitations: Number(stats.invitations ?? 0), rfqResponses: Number(stats.responses ?? 0), orders: Number(stats.awards ?? 0),
          replyRatePct: threads >= s.pack.policy.reputationMinThreads ? Math.round((Number(stats.replied ?? 0) / threads) * 100) : null,
          websiteReviews: { count: Number(stats.review_count ?? 0), average: stats.review_avg != null ? Math.round(Number(stats.review_avg) * 10) / 10 : null, label: 'Website reviews (from enquiries, not completed orders)' },
          // Delivery and quote record from completed orders (R3 slice 3). Small samples are counts, not scores.
          windowDays: s.pack.performance.windowDays, minSample: s.pack.performance.minSample,
          metrics: (perf?.metrics ?? []).map((m) => ({ key: m.key, label: m.label, display: m.display, enough: m.enough, sample: m.sample, value: m.value, higherIsBetter: m.higherIsBetter })),
        },
        // Transaction reviews take precedence over website reviews on a provider profile (§13.4).
        transactionReviews: {
          label: 'Reviews from completed BuildWise orders', notice: TRANSACTION_REVIEW_NOTICE, count: tx.count, enough: tx.summary.enough, minSample: s.pack.performance.minSample,
          overall: tx.summary.overall, dimensions: tx.summary.dimensions,
          items: recent.map((t) => ({
            id: t.id, overall: Number(t.overall), body: t.body, at: iso(t.created_at), category: t.category_name ?? t.category_slug, area: findArea(s.pack, t.area_code)?.label ?? t.area_code,
            ratings: REVIEW_DIMENSIONS.client.map((d) => ({ key: d.key, label: d.label, value: (json<Record<string, number>>(t.ratings) ?? {})[d.key] ?? null })),
            reply: t.reply_body ? { body: t.reply_body, at: iso(t.reply_at) } : null,
          })),
        },
      };
    },
  });

  route(app, s, {
    method: 'PUT', url: '/v1/provider/profile', auth: 'user',
    body: z.object({ orgId: z.uuid(), acceptsRfqs: z.boolean(), capacityNote: z.string().trim().max(500).nullable().optional() }),
    handler: async ({ sql, body, user }) => {
      await providerOrg(sql, user, body.orgId);
      await sql.query(`insert into provider_profiles (org_id, accepts_rfqs, capacity_note, updated_by) values ($1, $2, $3, $4)
        on conflict (org_id) do update set accepts_rfqs = excluded.accepts_rfqs, capacity_note = excluded.capacity_note, updated_by = excluded.updated_by, updated_at = now()`, [body.orgId, body.acceptsRfqs, body.capacityNote ?? null, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'provider.profile_updated', targetType: 'Organization', targetId: body.orgId, metadata: { acceptsRfqs: body.acceptsRfqs } });
      return { ok: true };
    },
  });
}

/**
 * Worker step: close published RFQs at their deadline, open due tenders together with their opening record, and
 * expire quote versions past their validity.
 */
export async function runProcurementTimers(sql: Sql, s: Services): Promise<{ closed: number; expired: number; opened: number }> {
  const closed = await many<{ id: string }>(sql, `update rfqs set state = 'closed', closed_at = now(), close_reason = 'Deadline reached', version = version + 1, updated_at = now() where state = 'published' and kind = 'rfq' and deadline <= now() returning id`);
  for (const r of closed) await publish(sql, 'RfqClosed', { rfqId: r.id, reason: 'deadline' });
  const due = await many<Row>(sql, `select * from rfqs where state = 'published' and kind = 'tender' and opened_at is null and deadline <= now() order by deadline limit 50`);
  for (const r of due) await openTender(sql, s, r, null);
  const expired = await many<{ id: string; quote_id: string }>(sql, `update quote_versions set state = 'expired', version = version + 1, updated_at = now() where state = any($1::text[]) and valid_until < current_date returning id, quote_id`, [LIVE_QUOTE_STATES]);
  for (const v of expired) await sql.query(`update quotes set status = 'expired', updated_at = now() where id = $1 and current_version_id = $2`, [v.quote_id, v.id]);
  return { closed: closed.length, expired: expired.length, opened: due.length };
}
