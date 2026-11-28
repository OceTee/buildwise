import type { MarketPack } from './market';
import { LIVE_QUOTE_STATES, type QuoteState, type RfqState } from './procurement';

/**
 * Notifications and timely state (spec §16, §21.1): which topics a person can hear about off the platform, the
 * defaults, how unread notifications are coalesced, the SMS caps, and what time-based state reads as when the
 * scheduler has not yet run.
 */

// ---------------------------------------------------------------- preferences
export type NotificationTopic = 'messages' | 'quotes' | 'listings';
export type NotificationChannel = 'email' | 'sms';
export type NotificationPrefs = Record<NotificationTopic, Record<NotificationChannel, boolean>>;

export const NOTIFICATION_TOPICS: { topic: NotificationTopic; label: string; help: string }[] = [
  { topic: 'messages', label: 'Chat messages', help: 'Once per conversation until you read it.' },
  { topic: 'quotes', label: 'Quote requests, quotes and requests for quotes', help: 'New requests, answers and invitations to quote.' },
  { topic: 'listings', label: 'Your listings', help: 'Approved, needs changes, blocked or expired.' },
];

/** Email on for everything; SMS off for chat (it is the noisiest and costs the most), on for the rest. */
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  messages: { email: true, sms: false },
  quotes: { email: true, sms: true },
  listings: { email: true, sms: true },
};

/** Stored preferences over the defaults; unknown keys and non-boolean values are ignored. */
export function notificationPrefs(stored: unknown): NotificationPrefs {
  const raw = (stored && typeof stored === 'object' ? stored : {}) as Record<string, Record<string, unknown> | undefined>;
  const out = {} as NotificationPrefs;
  for (const { topic } of NOTIFICATION_TOPICS) {
    const d = DEFAULT_NOTIFICATION_PREFS[topic];
    const r = raw[topic] ?? {};
    out[topic] = { email: typeof r.email === 'boolean' ? r.email : d.email, sms: typeof r.sms === 'boolean' ? r.sms : d.sms };
  }
  return out;
}

/**
 * The one channel a copy goes out on. Email when the person wants it and has an address, and a real email provider is
 * connected (or neither channel is real, so the development outbox shows it); otherwise SMS when they want it.
 */
export function mirrorChannel(prefs: NotificationPrefs, topic: NotificationTopic, person: { email: string | null; phone: string | null }, live: { email: boolean; sms: boolean }): NotificationChannel | null {
  const p = prefs[topic];
  if (p.email && person.email && (live.email || !live.sms)) return 'email';
  if (p.sms && person.phone) return 'sms';
  if (p.email && person.email) return 'email';
  return null;
}

/** Title of a coalesced chat notification: one unread notification per conversation, counting its messages. */
export const messageNotificationTitle = (count: number, from: string) => (count <= 1 ? `New message from ${from}` : `${count} new messages from ${from}`);

// ---------------------------------------------------------------- SMS caps
/** The caps that apply to a number: the daily total and its calling code's (the longest configured prefix). */
export function smsCapsFor(pack: Pick<MarketPack, 'messaging'>, phoneE164: string): { scope: string; cap: number }[] {
  const m = pack.messaging;
  const code = Object.keys(m.smsDailyCapByCallingCode).filter((c) => phoneE164.startsWith(c)).sort((a, b) => b.length - a.length)[0];
  return [{ scope: 'all', cap: m.smsDailyCap }, ...(code ? [{ scope: code, cap: m.smsDailyCapByCallingCode[code]! }] : [])];
}

/** The calendar day a cap counts against, in the market's time zone (YYYY-MM-DD). */
export function smsDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Whether this send crosses the warning threshold (exactly once per scope and day). */
export const crossesWarning = (sentAfter: number, cap: number, pct: number) => cap > 0 && sentAfter === Math.ceil((cap * pct) / 100);

// ---------------------------------------------------------------- timely state
const past = (at: unknown, now: Date) => at != null && new Date(String(at)).getTime() <= now.getTime();

/** A live listing past its end date reads as expired, whether or not the scheduler has run. */
export const listingStatusAt = (status: string, expiresAt: unknown, now = new Date()) => (status === 'live' && past(expiresAt, now) ? 'expired' : status);

/** A published RFQ past its deadline reads as closed (a tender stays published until its bids are opened). */
export const rfqStateAt = (r: { state: string; kind?: string; deadline: unknown }, now = new Date()): RfqState =>
  (r.state === 'published' && (r.kind ?? 'rfq') === 'rfq' && past(r.deadline, now) ? 'closed' : r.state) as RfqState;

/** A live quote version past its validity date (the end of that day) reads as expired. */
export function quoteStateAt(state: string, validUntil: string | null | undefined, now = new Date()): QuoteState {
  if (!validUntil || !(LIVE_QUOTE_STATES as readonly string[]).includes(state)) return state as QuoteState;
  return (validUntil < now.toISOString().slice(0, 10) ? 'expired' : state) as QuoteState;
}
