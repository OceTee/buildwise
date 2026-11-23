import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Database } from '../db/database.js';
import { one } from '../db/database.js';
import { z } from 'zod';
import type { AiArchitectReview, designDigest } from '@bw/domain';
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

// ---------------------------------------------------------------- AI architect

/** What the AI architect is given: the plot, the brief and a numbers-only digest of each generated design. */
export interface ArchitectInput {
  market: string;
  climate: string;
  plot: { widthM: number; depthM: number };
  brief: Record<string, unknown>;
  designs: ReturnType<typeof designDigest>[];
  /** Town or state, when the person gave one (no other personal details). */
  location?: string;
}

/** Reviews and ranks generated designs. It never changes geometry or the rule checks. */
export interface ArchitectProvider { live: boolean; model: string; review(input: ArchitectInput): Promise<AiArchitectReview | null> }

export const noArchitect: ArchitectProvider = { live: false, model: 'engine', review: async () => null };

// Structured output does not enforce lengths, so the schema only describes them; the reply is trimmed after parsing.
const NOTE = z.string().describe('One sentence, under 40 words.');
export const ArchitectOutput = z.object({
  overview: z.string().describe('One or two sentences: which design you would build on this plot and why.'),
  order: z.array(z.string()).describe('Every design id, best first.'),
  reviews: z.array(z.object({
    id: z.string(),
    score: z.number().int().describe('0 to 100.'),
    highlights: z.array(NOTE).describe('Two to four strengths.'),
    considerations: z.array(NOTE).describe('One to three things to consider.'),
  })),
  concept: z.object({
    designId: z.string().describe('The id of the design you rank first.'),
    title: z.string().describe('An evocative name for that design, the way an architect titles a scheme, e.g. "The Courtyard House" or "Harbour View Offices". Under 6 words. No personal names.'),
    story: z.string().describe('Two or three sentences, in the second person, on what it is like to live in or use the building and why it suits this plot and climate.'),
    moves: z.array(NOTE).describe('Two to four key design moves.'),
    palette: z.object({
      walls: z.string().describe('Wall finish and colour, under 12 words.'),
      accents: z.string().describe('Windows, doors, screens and accent materials, under 12 words.'),
      roof: z.string().describe('Roof covering and colour matching the brief, under 12 words.'),
    }),
  }),
});
const clip = (t: string, n: number) => { const x = t.trim().replace(/\s+/g, ' '); return x.length <= n ? x : `${x.slice(0, n - 1).replace(/\s+\S*$/, '')}…`; };
const clips = (xs: string[], n: number, max: number) => xs.map((x) => clip(x, n)).filter(Boolean).slice(0, max);

export const ARCHITECT_SYSTEM = `You are a master architect with decades of practice in homes, apartment blocks, commercial, hospitality and institutional buildings, reviewing concept designs for a client who is planning to build on their own plot. A rules engine generated each design and already checked it for setbacks, site coverage, minimum room sizes, window area, ventilation of wet rooms, corridor and door widths, stairs, lifts and escape stairs. You cannot change the designs; you judge them and present the best one.

Judge them the way an experienced architect practising in this market would, for the building type at hand: comfort in the climate (cross-ventilation, sun, rain), daylight, zoning of public and private areas, privacy and security, circulation that wastes little floor, how the core (stairs and lifts) serves the floors, frontage and visibility for shops, efficiency of lettable or usable area for commercial buildings, how easily it builds with local methods (sandcrete blockwork, reinforced concrete frame, timber or steel roof), running and maintenance costs, and room to grow later.

Then present the design you rank first as a concept: give it a name, tell its story in two or three sentences, list its key design moves, and propose a tasteful material palette that fits the brief's style and roof. Make the client feel the building has been thoughtfully designed for them, without overstating it.

Write for the client, not for another architect: plain words, concrete, specific to the design's numbers. Each note is one sentence. Never claim the design complies with a building code or is structurally sound; these are concept designs that a registered architect and engineers must develop before building. Rank every design you are given, best first, using its id exactly as given.`;

/** The user message every AI architect gets: market, climate, location, then the plot, brief and design digests. */
export function architectMessage(input: ArchitectInput): string {
  return `Market: ${input.market}. Climate: ${input.climate}${input.location ? `\nLocation: ${input.location}` : ''}\n\nPlot, brief and designs (metres; y is the distance from the street boundary):\n${JSON.stringify({ plot: input.plot, brief: input.brief, designs: input.designs })}`;
}

/** A parsed architect answer, trimmed to the lengths the app shows. */
export function toArchitectReview(out: z.infer<typeof ArchitectOutput>): AiArchitectReview {
  const c = out.concept;
  return {
    overview: clip(out.overview, 400), order: out.order,
    reviews: Object.fromEntries(out.reviews.map((r) => [r.id, { score: Math.max(0, Math.min(100, Math.round(r.score))), highlights: clips(r.highlights, 260, 4), considerations: clips(r.considerations, 260, 3) }])),
    concept: {
      designId: c.designId, title: clip(c.title, 60), story: clip(c.story, 600), moves: clips(c.moves, 260, 4),
      palette: { walls: clip(c.palette.walls, 110), accents: clip(c.palette.accents, 110), roof: clip(c.palette.roof, 110) },
    },
  };
}

/** Anthropic's Claude as the AI architect. Structured output, so the reply is always a valid review or nothing. */
export async function createClaudeArchitect(cfg: { apiKey: string; model: string }): Promise<ArchitectProvider> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const client = new Anthropic({ apiKey: cfg.apiKey, timeout: 90_000, maxRetries: 1 });
  return {
    live: true,
    model: cfg.model,
    async review(input) {
      const res = await client.beta.messages.parse({
        model: cfg.model,
        max_tokens: 16000,
        // On a policy decline the API retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium', format: betaZodOutputFormat(ArchitectOutput) },
        system: ARCHITECT_SYSTEM,
        messages: [{ role: 'user', content: architectMessage(input) }],
      });
      if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
      return toArchitectReview(res.parsed_output);
    },
  };
}

// ---------------------------------------------------------------- Builder AI (the conversation)

export interface BuilderTool { name: string; description: string; input_schema: { type: 'object'; [k: string]: unknown } }
export interface BuilderTurn { role: 'user' | 'assistant'; text: string }
export interface BuilderChatInput {
  system: string;
  history: BuilderTurn[];
  message: string;
  tools: BuilderTool[];
  /** Runs one of our deterministic tools; whatever it returns is sent back to the model as JSON. */
  runTool: (name: string, input: unknown) => Promise<unknown>;
  maxSteps?: number;
}
export interface BuilderChatOutput { text: string; stopReason: string; toolCalls: number; model: string }
/** The conversational model behind the Builder AI. Null output means it declined or failed: use the local reply. */
export interface BuilderProvider { live: boolean; model: string; chat(input: BuilderChatInput): Promise<BuilderChatOutput | null> }

export const noBuilder: BuilderProvider = { live: false, model: 'local', chat: async () => null };

/**
 * Claude as the Builder AI. A manual tool loop over our own calculators: the model asks, our code computes, the
 * model explains. The long system prompt is cached; each request carries the conversation and the project context.
 */
export async function createClaudeBuilder(cfg: { apiKey: string; model: string }): Promise<BuilderProvider> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: cfg.apiKey, timeout: 120_000, maxRetries: 1 });
  return {
    live: true,
    model: cfg.model,
    async chat(input) {
      type Msg = Parameters<typeof client.beta.messages.create>[0]['messages'][number];
      const messages: Msg[] = [
        ...input.history.map((t) => ({ role: t.role, content: t.text }) as Msg),
        { role: 'user', content: input.message },
      ];
      let calls = 0;
      for (let step = 0; step < (input.maxSteps ?? 5); step++) {
        const res = await client.beta.messages.create({
          model: cfg.model,
          max_tokens: 16000,
          // On a policy decline the API retries on a fallback model inside the same call.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          output_config: { effort: 'medium' },
          system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
          tools: input.tools as never,
          messages,
        });
        if (res.stop_reason === 'refusal') return null;
        const text = res.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
        const uses = res.content.filter((b) => b.type === 'tool_use') as { type: 'tool_use'; id: string; name: string; input: unknown }[];
        if (res.stop_reason !== 'tool_use' || !uses.length) {
          return text ? { text, stopReason: String(res.stop_reason), toolCalls: calls, model: res.model } : null;
        }
        messages.push({ role: 'assistant', content: res.content } as Msg);
        const results = [];
        for (const u of uses) {
          calls++;
          try {
            results.push({ type: 'tool_result' as const, tool_use_id: u.id, content: JSON.stringify(await input.runTool(u.name, u.input)) });
          } catch (err) {
            results.push({ type: 'tool_result' as const, tool_use_id: u.id, content: `Error: ${String(err).slice(0, 300)}`, is_error: true });
          }
        }
        messages.push({ role: 'user', content: results } as Msg);
      }
      return null; // too many tool rounds: fall back rather than loop
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
