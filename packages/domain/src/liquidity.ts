import { median } from './performance';

/**
 * Marketplace liquidity, the Release 3 exit gate (spec §25): the share of requests for quotes that got at least
 * `minComparableResponses` comparable (like-for-like) responses within `windowHours` of publishing, in at least
 * `targetPct` of RFQs. Broken down by category, area and week. Pure: the API decides which quotes are like-for-like
 * with the same `compareQuotes` rule the comparison page uses, and passes them in.
 */

export interface LiquidityConfig {
  minComparableResponses: number;
  windowHours: number;
  /** Exit-gate target, per cent of RFQs [Proposed, validate in R0]. */
  targetPct: number;
  /** A breakdown cell with fewer decided RFQs than this is shown as a count, not a share. */
  minRfqsPerCell: number;
  /** How many weeks back the dashboard looks. */
  weeks: number;
}
export const DEFAULT_LIQUIDITY_CONFIG: LiquidityConfig = { minComparableResponses: 3, windowHours: 72, targetPct: 80, minRfqsPerCell: 5, weeks: 12 };

export interface LiquidityResponse { providerOrgId: string; submittedAt: string; likeForLike: boolean }
export interface LiquidityRfq {
  id: string;
  categorySlug: string; categoryName: string;
  areaCode: string; areaLabel: string;
  publishedAt: string;
  responses: LiquidityResponse[];
}

export interface RfqLiquidity {
  id: string;
  /** Distinct providers with a like-for-like response inside the window. */
  comparable: number;
  /** All responses inside the window, comparable or not. */
  responses: number;
  /** true / false once decided; null while the window is still open and the target is not reached yet. */
  met: boolean | null;
  windowEndsAt: string;
  /** Hours from publishing to the response that reached the target. */
  hoursToTarget: number | null;
}

export function rfqLiquidity(r: LiquidityRfq, cfg: Pick<LiquidityConfig, 'minComparableResponses' | 'windowHours'>, now: Date): RfqLiquidity {
  const start = new Date(r.publishedAt).getTime();
  const end = start + cfg.windowHours * 3_600_000;
  const inWindow = r.responses.filter((x) => { const t = new Date(x.submittedAt).getTime(); return t >= start && t <= end; });
  // First like-for-like response per provider, in time order.
  const firstByProvider = new Map<string, number>();
  for (const x of inWindow) {
    if (!x.likeForLike) continue;
    const t = new Date(x.submittedAt).getTime();
    if (!firstByProvider.has(x.providerOrgId) || t < firstByProvider.get(x.providerOrgId)!) firstByProvider.set(x.providerOrgId, t);
  }
  const times = [...firstByProvider.values()].sort((a, b) => a - b);
  const reached = times.length >= cfg.minComparableResponses ? times[cfg.minComparableResponses - 1]! : null;
  const met = reached != null ? true : now.getTime() > end ? false : null;
  return {
    id: r.id, comparable: times.length, responses: new Set(inWindow.map((x) => x.providerOrgId)).size, met,
    windowEndsAt: new Date(end).toISOString(), hoursToTarget: reached != null ? Math.round(((reached - start) / 3_600_000) * 10) / 10 : null,
  };
}

export interface LiquidityCell {
  key: string;
  label: string;
  /** RFQs whose outcome is known (met, or window closed). */
  decided: number;
  met: number;
  pending: number;
  /** Per cent of decided RFQs that met the target; null when fewer than `minRfqsPerCell` are decided. */
  sharePct: number | null;
  enough: boolean;
  medianComparable: number | null;
  meetsTarget: boolean | null;
}

export interface LiquidityReport {
  config: LiquidityConfig;
  overall: LiquidityCell;
  byCategory: LiquidityCell[];
  byArea: LiquidityCell[];
  byWeek: LiquidityCell[];
  /** The exit gate: overall share at or above the target, on enough RFQs. */
  gate: { met: boolean; text: string };
}

/** Monday (UTC) of the week an instant falls in, as YYYY-MM-DD. */
export function weekOf(at: string): string {
  const d = new Date(at);
  const day = (d.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day)).toISOString().slice(0, 10);
}

function cell(key: string, label: string, items: { r: LiquidityRfq; l: RfqLiquidity }[], cfg: LiquidityConfig): LiquidityCell {
  const decided = items.filter((x) => x.l.met !== null);
  const met = decided.filter((x) => x.l.met).length;
  const enough = decided.length >= cfg.minRfqsPerCell;
  const sharePct = enough ? Math.round((met / decided.length) * 1000) / 10 : null;
  return {
    key, label, decided: decided.length, met, pending: items.length - decided.length, sharePct, enough,
    medianComparable: median(decided.map((x) => x.l.comparable)), meetsTarget: sharePct == null ? null : sharePct >= cfg.targetPct,
  };
}

function groupBy(items: { r: LiquidityRfq; l: RfqLiquidity }[], key: (r: LiquidityRfq) => [string, string], cfg: LiquidityConfig) {
  const groups = new Map<string, { label: string; items: typeof items }>();
  for (const x of items) {
    const [k, label] = key(x.r);
    if (!groups.has(k)) groups.set(k, { label, items: [] });
    groups.get(k)!.items.push(x);
  }
  return [...groups.entries()].map(([k, g]) => cell(k, g.label, g.items, cfg));
}

export function liquidityReport(rfqs: LiquidityRfq[], cfg: LiquidityConfig, now: Date): LiquidityReport {
  const items = rfqs.map((r) => ({ r, l: rfqLiquidity(r, cfg, now) }));
  const overall = cell('all', 'All requests for quotes', items, cfg);
  const byDecided = (a: LiquidityCell, b: LiquidityCell) => b.decided - a.decided || a.label.localeCompare(b.label);
  const met = overall.meetsTarget === true;
  const text = overall.sharePct == null
    ? `Not enough decided requests yet (${overall.decided} of ${cfg.minRfqsPerCell} needed) to judge the exit gate.`
    : `${overall.sharePct}% of requests got ${cfg.minComparableResponses} or more comparable responses within ${cfg.windowHours} hours (target ${cfg.targetPct}%).`;
  return {
    config: cfg, overall,
    byCategory: groupBy(items, (r) => [r.categorySlug, r.categoryName], cfg).sort(byDecided),
    byArea: groupBy(items, (r) => [r.areaCode, r.areaLabel], cfg).sort(byDecided),
    byWeek: groupBy(items, (r) => { const w = weekOf(r.publishedAt); return [w, `Week of ${w}`]; }, cfg).sort((a, b) => a.key.localeCompare(b.key)),
    gate: { met, text },
  };
}
