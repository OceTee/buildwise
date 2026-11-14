import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import { one } from '../db/database.js';
import type { MessageChannel } from './platform.js';

/**
 * Real provider adapters. Each one is selected by configuration and implements the same seam as the
 * development stand-in, so nothing above this file knows which provider is connected. Secrets come from the
 * environment and are never logged; message content is never logged either.
 */

export type Fetch = typeof fetch;

export class ProviderError extends Error {
  constructor(public provider: string, public status: number, message: string) { super(`${provider}: ${message}`); }
}

async function expectOk(provider: string, res: Response): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok) throw new ProviderError(provider, res.status, `request failed with HTTP ${res.status}`);
  return body;
}

// ---------------------------------------------------------------- SMS

export interface TwilioSettings { accountSid: string; authToken: string; from: string }

/** Twilio Programmable Messaging. `from` is a sender number (E.164) or a Messaging Service SID (MG…). */
export function createTwilioSms(cfg: TwilioSettings, fetchImpl: Fetch = fetch): MessageChannel {
  return {
    live: true,
    async send(to, text) {
      const form = new URLSearchParams({ To: to, Body: text });
      form.set(cfg.from.startsWith('MG') ? 'MessagingServiceSid' : 'From', cfg.from);
      const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}/Messages.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
      await expectOk('twilio', res);
    },
  };
}

export interface TermiiSettings { apiKey: string; senderId: string; baseUrl: string }

/**
 * Termii (Nigeria and other African markets). Sign-in codes go on the DND-cleared route so they reach numbers
 * on the do-not-disturb register; other messages use the generic route.
 */
export function createTermiiSms(cfg: TermiiSettings, fetchImpl: Fetch = fetch): MessageChannel {
  return {
    live: true,
    async send(to, text, kind) {
      const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, '')}/api/sms/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: cfg.apiKey, to: to.replace(/^\+/, ''), from: cfg.senderId, sms: text, type: 'plain', channel: kind === 'otp' ? 'dnd' : 'generic' }),
      });
      await expectOk('termii', res);
    },
  };
}

// ---------------------------------------------------------------- email

export interface ResendSettings { apiKey: string; from: string }

export function createResendEmail(cfg: ResendSettings, fetchImpl: Fetch = fetch): MessageChannel {
  return {
    live: true,
    async send(to, text, kind) {
      const res = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: cfg.from, to: [to], subject: kind === 'otp' ? 'Your BuildWise code' : 'BuildWise update', text }),
      });
      await expectOk('resend', res);
    },
  };
}

// ---------------------------------------------------------------- payments

/** A verified provider event, in the shape the promotions module applies. */
export interface CheckoutEvent { id: string; type: 'checkout.completed' | 'checkout.failed'; data: { ref: string; amountMinor: string; currency: string } }

export interface StartCheckout { ref: string; amountMinor: bigint; currency: string; email: string; returnUrl: string; description: string }

export interface PaymentProvider {
  /** `dev` is the built-in stand-in (a test checkout page on our own site); anything else moves real money. */
  kind: 'dev' | 'paystack';
  /** Creates the hosted checkout and returns the URL to send the buyer to. */
  start(input: StartCheckout): Promise<{ url: string }>;
  /** Checks the signature over the exact bytes; returns the event, `null` for events we ignore, or throws on a bad signature. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: string): CheckoutEvent | null;
  /** Asks the provider for the outcome directly (used when the buyer returns before the webhook arrives). */
  lookup(ref: string): Promise<CheckoutEvent | null>;
}

export class InvalidSignature extends Error {}

export function createDevPayments(publicWebUrl: string): PaymentProvider {
  return {
    kind: 'dev',
    async start({ ref }) { return { url: `${publicWebUrl}/checkout/${ref}` }; },
    parseWebhook() { return null; }, // the dev checkout uses /v1/webhooks/checkout with our own signature
    async lookup() { return null; },
  };
}

export interface PaystackSettings { secretKey: string; baseUrl?: string }

/**
 * Paystack hosted checkout. Amounts are already in the currency's minor unit (kobo, pesewas, cents), as
 * Paystack expects. Webhooks are signed with HMAC-SHA512 of the raw body using the secret key. The event id is
 * derived from Paystack's transaction id, so a webhook and a direct lookup of the same payment are applied once.
 */
export function createPaystack(cfg: PaystackSettings, fetchImpl: Fetch = fetch): PaymentProvider {
  const base = (cfg.baseUrl ?? 'https://api.paystack.co').replace(/\/$/, '');
  const auth = { authorization: `Bearer ${cfg.secretKey}` };
  const toEvent = (d: any): CheckoutEvent | null => {
    if (!d?.reference || d.amount === undefined || !d.currency) return null;
    if (d.status === 'success') return { id: `paystack:${d.id}`, type: 'checkout.completed', data: { ref: String(d.reference), amountMinor: String(d.amount), currency: String(d.currency) } };
    if (d.status === 'failed' || d.status === 'abandoned' || d.status === 'reversed') return { id: `paystack:${d.id}:${d.status}`, type: 'checkout.failed', data: { ref: String(d.reference), amountMinor: String(d.amount), currency: String(d.currency) } };
    return null;
  };
  return {
    kind: 'paystack',
    async start(input) {
      const res = await fetchImpl(`${base}/transaction/initialize`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ email: input.email, amount: input.amountMinor.toString(), currency: input.currency, reference: input.ref, callback_url: input.returnUrl, metadata: { description: input.description } }),
      });
      const body = await expectOk('paystack', res);
      const url = body?.data?.authorization_url;
      if (typeof url !== 'string' || !url.startsWith('https://')) throw new ProviderError('paystack', 502, 'no checkout URL in the response');
      return { url };
    },
    parseWebhook(headers, rawBody) {
      const sig = headers['x-paystack-signature'];
      if (typeof sig !== 'string') throw new InvalidSignature();
      const expected = Buffer.from(createHmac('sha512', cfg.secretKey).update(rawBody).digest('hex'));
      const got = Buffer.from(sig);
      if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new InvalidSignature();
      const evt = JSON.parse(rawBody);
      return evt?.event === 'charge.success' ? toEvent(evt.data) : null;
    },
    async lookup(ref) {
      const res = await fetchImpl(`${base}/transaction/verify/${encodeURIComponent(ref)}`, { headers: auth });
      if (res.status === 404 || res.status === 400) return null; // never started on the provider side
      return toEvent((await expectOk('paystack', res))?.data);
    },
  };
}

// ---------------------------------------------------------------- rate limiting

/** Fixed one-minute windows. Returns 0 when allowed, otherwise the seconds until the window resets. */
export interface RateLimiter { hit(key: string, limit: number): Promise<number> }

/** Per process. Fine for one long-running server; on serverless every instance has its own count. */
export function createMemoryLimiter(): RateLimiter {
  const windows = new Map<string, { start: number; n: number }>();
  return {
    async hit(key, limit) {
      const now = Date.now();
      if (windows.size > 50_000) for (const [k, w] of windows) if (now - w.start > 60_000) windows.delete(k);
      const w = windows.get(key);
      if (!w || now - w.start > 60_000) { windows.set(key, { start: now, n: 1 }); return 0; }
      w.n += 1;
      return w.n > limit ? Math.ceil((w.start + 60_000 - now) / 1000) : 0;
    },
  };
}

/** Shared across every instance: one upserted counter row per key and minute. Old rows are swept by the worker. */
export function createPostgresLimiter(db: Database): RateLimiter {
  return {
    async hit(key, limit) {
      const r = await db.tx({ kind: 'system' }, (sql) => one<{ n: number; retry: number }>(sql,
        `insert into rate_limit_windows (key, window_start, n) values ($1, date_trunc('minute', now()), 1)
         on conflict (key, window_start) do update set n = rate_limit_windows.n + 1
         returning n, greatest(1, ceil(extract(epoch from (window_start + interval '1 minute' - now()))))::int as retry`, [key]));
      return r && r.n > limit ? r.retry : 0;
    },
  };
}
