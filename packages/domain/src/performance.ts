/**
 * Provider performance, Release 3 third slice (spec §13.1.2, §26.4): on-time delivery, discrepancy rate, invoice-match
 * rate, quote response time and quote reliability, computed from the procurement (slice 1) and fulfilment (slice 2)
 * records. Pure functions. A figure with fewer records than `minSample` is shown as a count, never as a score, and
 * is not used by ranking.
 */

// ---------------------------------------------------------------- configuration (market pack, [Proposed])
export interface PerformanceConfig {
  /** Records older than this are not counted. */
  windowDays: number;
  /** Fewer records than this and a figure is "too few to score". */
  minSample: number;
  /** Local time for "arrived on the booked day" (a fixed UTC offset keeps the rule pure). */
  utcOffsetMinutes: number;
  /** A response within this many hours of the invitation counts as prompt (shown beside the median). */
  promptResponseHours: number;
}

export const DEFAULT_PERFORMANCE_CONFIG: PerformanceConfig = { windowDays: 365, minSample: 5, utcOffsetMinutes: 60, promptResponseHours: 48 };

// ---------------------------------------------------------------- inputs
export interface PerfDelivery {
  /** The booked date (YYYY-MM-DD, after any reschedule). */
  scheduledDate: string;
  state: string;
  arrivedAt: string | null;
  /** True once the client has inspected it. */
  inspected: boolean;
  /** Discrepancies raised at inspection. */
  discrepancies: number;
}
export interface PerfInvoice { state: string; matchStatus: 'matched' | 'variance' }
export interface PerfInvitation { invitedAt: string; respondedAt: string | null; state: string }
export interface PerfQuote {
  /** State of the newest submitted version. */
  state: string;
  /** The provider withdrew a submitted quote and did not replace it. */
  withdrawn: boolean;
  validUntil: string | null;
  rfqDeadline: string;
}
export interface PerformanceInputs { deliveries: PerfDelivery[]; invoices: PerfInvoice[]; invitations: PerfInvitation[]; quotes: PerfQuote[] }

// ---------------------------------------------------------------- outputs
export type MetricKey = 'onTimeDelivery' | 'discrepancyRate' | 'invoiceMatch' | 'quoteResponseTime' | 'quoteReliability';
export interface Metric {
  key: MetricKey;
  label: string;
  /** How many records the figure is based on. */
  sample: number;
  /** Records meeting the rule (for rates). */
  count: number;
  /** 0–1 for rates, hours for response time; null when there are too few records to score. */
  value: number | null;
  enough: boolean;
  /** Plain text: the score, or the raw count when the sample is small. */
  display: string;
  /** Higher is better (false for the discrepancy rate and response time). */
  higherIsBetter: boolean;
}
export interface ProviderPerformance {
  windowDays: number;
  minSample: number;
  metrics: Metric[];
  /** The rates ranking reads; null where the sample is small. */
  summary: PerformanceSummary;
}
export interface PerformanceSummary {
  onTimeRate: number | null;
  discrepancyRate: number | null;
  invoiceMatchRate: number | null;
  quoteReliability: number | null;
  medianResponseHours: number | null;
  /** Deliveries that arrived (the delivery-record sample). */
  deliveries: number;
}

export const EMPTY_PERFORMANCE: PerformanceSummary = { onTimeRate: null, discrepancyRate: null, invoiceMatchRate: null, quoteReliability: null, medianResponseHours: null, deliveries: 0 };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The local calendar date of an instant. */
export function localDate(at: string | Date, utcOffsetMinutes: number): string {
  return new Date(new Date(at).getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function rate(key: MetricKey, label: string, count: number, sample: number, cfg: PerformanceConfig, text: (c: number, n: number) => string, higherIsBetter = true): Metric {
  const enough = sample >= cfg.minSample;
  const value = enough ? count / sample : null;
  const display = sample === 0 ? 'No records yet' : enough ? `${pct(count / sample)} (${text(count, sample)})` : `${text(count, sample)}: too few to score`;
  return { key, label, sample, count, value, enough, display, higherIsBetter };
}

const fmtHours = (h: number) => (h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round((h / 24) * 10) / 10} days`);

export function providerPerformance(inp: PerformanceInputs, cfg: PerformanceConfig): ProviderPerformance {
  // On time: arrived on or before the booked day (local time). Only deliveries that arrived count.
  const arrived = inp.deliveries.filter((d) => d.arrivedAt && d.state !== 'cancelled');
  const onTime = arrived.filter((d) => localDate(d.arrivedAt!, cfg.utcOffsetMinutes) <= d.scheduledDate).length;
  // Discrepancy rate: inspected deliveries where at least one discrepancy was raised.
  const inspected = inp.deliveries.filter((d) => d.inspected);
  const withIssues = inspected.filter((d) => d.discrepancies > 0).length;
  // Invoice match: invoices (not withdrawn) whose three-way match found no variance.
  const invoices = inp.invoices.filter((i) => i.state !== 'withdrawn');
  const matched = invoices.filter((i) => i.matchStatus === 'matched').length;
  // Response time: invitation to quote or decline.
  const answered = inp.invitations.filter((i) => i.respondedAt && (i.state === 'quoted' || i.state === 'declined'));
  const hours = answered.map((i) => Math.max(0, (new Date(i.respondedAt!).getTime() - new Date(i.invitedAt).getTime()) / 3_600_000));
  const med = median(hours);
  const prompt = hours.filter((h) => h <= cfg.promptResponseHours).length;
  const enoughTime = answered.length >= cfg.minSample;
  // Quote reliability: submitted quotes kept open to the deadline (not withdrawn, not left to lapse before it).
  const kept = inp.quotes.filter((q) => !q.withdrawn && !(q.validUntil && q.validUntil < q.rfqDeadline.slice(0, 10))).length;

  const metrics: Metric[] = [
    rate('onTimeDelivery', 'On-time delivery', onTime, arrived.length, cfg, (c, n) => `${c} of ${plural(n, 'delivery', 'deliveries')} on the booked day`),
    rate('discrepancyRate', 'Deliveries with a discrepancy', withIssues, inspected.length, cfg, (c, n) => `${c} of ${plural(n, 'inspected delivery', 'inspected deliveries')}`, false),
    rate('invoiceMatch', 'Invoices matching order and receipt', matched, invoices.length, cfg, (c, n) => `${c} of ${plural(n, 'invoice')}`),
    {
      key: 'quoteResponseTime', label: 'Quote response time', sample: answered.length, count: prompt, value: enoughTime ? med : null, enough: enoughTime, higherIsBetter: false,
      display: answered.length === 0 ? 'No records yet' : enoughTime ? `Median ${fmtHours(med!)} (${prompt} of ${answered.length} within ${cfg.promptResponseHours} h)` : `${plural(answered.length, 'response')}: too few to score`,
    },
    rate('quoteReliability', 'Quotes kept to the deadline', kept, inp.quotes.length, cfg, (c, n) => `${c} of ${plural(n, 'quote')}`),
  ];
  const v = (k: MetricKey) => metrics.find((m) => m.key === k)!.value;
  return {
    windowDays: cfg.windowDays, minSample: cfg.minSample, metrics,
    summary: { onTimeRate: v('onTimeDelivery'), discrepancyRate: v('discrepancyRate'), invoiceMatchRate: v('invoiceMatch'), quoteReliability: v('quoteReliability'), medianResponseHours: v('quoteResponseTime'), deliveries: arrived.length },
  };
}

/**
 * The delivery-record ranking factor (0–1) and its explanation. Neutral (0.5) until there are enough deliveries,
 * so a new provider is neither rewarded nor punished for having no history.
 */
export function deliveryRecordScore(p: PerformanceSummary | null | undefined): { value: number; detail: string } {
  if (!p) return { value: 0.5, detail: 'No completed deliveries yet (neutral score)' };
  const parts: { v: number; text: string }[] = [];
  if (p.onTimeRate != null) parts.push({ v: p.onTimeRate, text: `${pct(p.onTimeRate)} on time` });
  if (p.discrepancyRate != null) parts.push({ v: 1 - p.discrepancyRate, text: `${pct(p.discrepancyRate)} with a discrepancy` });
  if (p.invoiceMatchRate != null) parts.push({ v: p.invoiceMatchRate, text: `${pct(p.invoiceMatchRate)} of invoices matched` });
  if (!parts.length) return { value: 0.5, detail: p.deliveries ? `${plural(p.deliveries, 'delivery', 'deliveries')} so far: too few to score (neutral)` : 'No completed deliveries yet (neutral score)' };
  return { value: Math.round((parts.reduce((a, x) => a + x.v, 0) / parts.length) * 1000) / 1000, detail: `Deliveries: ${parts.map((x) => x.text).join(', ')}` };
}
