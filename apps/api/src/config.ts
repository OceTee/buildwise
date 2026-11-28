import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getMarket } from '@bw/domain';

/** Gemini's free-tier text models, fastest capable first (the Builder AI chat and the live brain). */
// The free tier's flash models are often busy (503 "high demand"); the lighter models behind them usually answer.
export const DEFAULT_GEMINI_TEXT_MODELS = 'gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-3.1-flash-lite';
/** For judging designs (the AI architect), a stronger model first. */
export const DEFAULT_GEMINI_REVIEW_MODELS = 'gemini-4-hydrogen,gemini-3.8-flash,gemini-3.6-flash,gemini-3-flash-preview,gemini-3.5-flash-lite';

const ROOT = resolve(import.meta.dirname, '../../..');
/**
 * Local development data (embedded database, uploaded files, message outbox) lives outside the repository:
 * the Next.js dev server watches the whole monorepo, and database writes inside it trigger endless recompiles.
 */
const DATA_DIR = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : join(homedir(), '.buildwise', 'dev');

export type DesignerSpec = { kind: 'gemini'; apiKey: string; model: string } | { kind: 'anthropic'; apiKey: string; model: string };

export interface Config {
  /** `staging` is a deployed environment without real SMS or payment providers: production rules, except sign-in codes are shown and payments are simulated. */
  env: 'development' | 'test' | 'staging' | 'production';
  storage: 'local' | 'blob';
  messages: 'file' | 'log';
  port: number;
  databaseUrl?: string;
  pgliteDir: string | null;           // null = in-memory (tests)
  authSecret: string;
  /** Shared secret the web server sends so the API can trust its forwarded client IP and device headers. */
  internalSecret: string;
  /** Dev/test only: OTP codes are returned in the API response so the flow can be exercised without SMS. */
  exposeOtp: boolean;
  publicWebUrl: string;
  publicApiUrl: string;
  storageDir: string;
  outboxDir: string;
  marketId: string;
  checkoutWebhookSecret: string;
  /** Requests per IP per minute: everything (`perMinute`), search and listing pages (`browsePerMinute`, against scraping), signed file links and uploads (`filesPerMinute`), the health check (`healthPerMinute`). */
  rateLimit: { perMinute: number; browsePerMinute: number; filesPerMinute: number; healthPerMinute: number };
  /** Bearer secret for `/v1/internal/cron` and the detailed `/health` view. Required when deployed. */
  cronSecret: string | null;
  /** Malware scanning of uploaded documents. `dev` knows only the EICAR test file: production refuses it, staging warns. */
  malwareScanner: 'dev';
  runWorkerInProcess: boolean;
  /** Dispatch a request's outbox events in the background as soon as its transaction commits (the worker is the safety net). */
  dispatchAfterCommit: boolean;
  /**
   * Seconds between opportunistic runs of the timed work after ordinary requests, per instance. Default: 60 when no
   * worker runs in-process (serverless, where the cron may be daily), otherwise off; 0 turns it off.
   */
  catchUpSeconds?: number;
  /** Development/test only: raises the per-number and per-IP code limits so automated tests can sign in repeatedly. */
  otpLimitPerHour?: number;
  /** Development/test only: the shortest RFQ and tender response window in minutes, so e2e can reach a real deadline. */
  minResponseMinutes?: number;
  /** Build-assistant messages per IP per minute (the local model always answers; this only stops floods). */
  assistantPerMinute: number;
  /** Live-brain readings (Gemini) in total per day; beyond it the local model answers alone. */
  assistantDailyLimit: number;
  /** Fresh AI architect reviews per IP per minute, and in total per day (cached reviews do not count). */
  architectLimits: { perMinute: number; perDay: number };
  /** Builder AI messages per IP per minute, and in total per day (beyond them the local assistant answers). */
  builderLimits: { perMinute: number; perDay: number };
  /** Photoreal renders per IP per minute, and in total per day (beyond them the browser is told the service is busy). */
  renderLimits: { perMinute: number; perDay: number };
  /** AI-composed designs per IP per minute, and in total per day. */
  designerLimits: { perMinute: number; perDay: number };
  /** Dream renders (AI-painted impressions) per IP per minute, and in total per day. */
  dreamLimits: { perMinute: number; perDay: number };
  /** Where per-IP request counts live: `memory` (one process) or `postgres` (shared by every serverless instance). */
  rateLimitStore: 'memory' | 'postgres';
  /** Real providers. `none` keeps the development stand-in (outbox file, log line or test checkout page). */
  providers: {
    sms: { kind: 'none' } | { kind: 'twilio'; accountSid: string; authToken: string; from: string } | { kind: 'termii'; apiKey: string; senderId: string; baseUrl: string };
    email: { kind: 'none' } | { kind: 'resend'; apiKey: string; from: string };
    payments: { kind: 'dev' } | { kind: 'paystack'; secretKey: string };
    /** The AI architect that reviews and ranks generated designs. `none`: the design engine's own notes only. */
    architect: { kind: 'none' } | { kind: 'anthropic' | 'gemini'; apiKey: string; model: string };
    /** The Builder AI conversation. `none`: BuildWise's local assistant answers. */
    builder: { kind: 'none' } | { kind: 'anthropic' | 'gemini'; apiKey: string; model: string };
    /** The live brain behind the build assistant (reads each message, replies, and teaches the local model). `none`: the local model alone. */
    brain?: { kind: 'none' } | { kind: 'gemini'; apiKey: string; model: string };
    /** Photoreal renders of the 3D model (an image model; Claude does not make images). `none`: no render button. */
    render: { kind: 'none' } | { kind: 'openai'; apiKey: string; model: string };
    /** The AI designer(s) that compose massing, rooms and architecture, tried in order. `none`: the engine designs. */
    designer: { kind: 'none' } | DesignerSpec | { kind: 'chain'; list: DesignerSpec[] };
    /** Who looks at the 3D snapshot and improves the layout: the designer chain's first model that can see, or Gemini. */
    critique?: { kind: 'designer' } | { kind: 'gemini'; apiKey: string; model: string };
    /** Dream renders: AI-painted photoreal impressions of the design (Gemini or OpenAI image models). `none`: no gallery. Checked by Claude when ARCHITECT_PROVIDER=anthropic. */
    dream?: { kind: 'none' } | { kind: 'gemini'; apiKey: string; model: string } | { kind: 'openai'; apiKey: string; model: string };
    /** Paystack needs an email for every payment; buyers who signed up by phone get an address at this domain. */
    receiptEmailDomain: string;
  };
}

/** Reads a provider's settings; every listed variable must be present once the provider is chosen. */
function need(provider: string, names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) throw new Error(`${provider} is selected but ${missing.join(', ')} ${missing.length > 1 ? 'are' : 'is'} not set`);
  return Object.fromEntries(names.map((n) => [n, process.env[n]!]));
}

export function loadProviders(): Config['providers'] {
  const smsKind = process.env.SMS_PROVIDER || 'none';
  let sms: Config['providers']['sms'];
  if (smsKind === 'twilio') { const v = need('SMS_PROVIDER=twilio', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM']); sms = { kind: 'twilio', accountSid: v.TWILIO_ACCOUNT_SID!, authToken: v.TWILIO_AUTH_TOKEN!, from: v.TWILIO_FROM! }; }
  else if (smsKind === 'termii') { const v = need('SMS_PROVIDER=termii', ['TERMII_API_KEY', 'TERMII_SENDER_ID']); sms = { kind: 'termii', apiKey: v.TERMII_API_KEY!, senderId: v.TERMII_SENDER_ID!, baseUrl: process.env.TERMII_BASE_URL || 'https://v3.api.termii.com' }; }
  else if (smsKind === 'none') sms = { kind: 'none' };
  else throw new Error(`Unknown SMS_PROVIDER "${smsKind}" (use twilio, termii or none)`);

  const emailKind = process.env.EMAIL_PROVIDER || 'none';
  let email: Config['providers']['email'];
  if (emailKind === 'resend') { const v = need('EMAIL_PROVIDER=resend', ['RESEND_API_KEY', 'EMAIL_FROM']); email = { kind: 'resend', apiKey: v.RESEND_API_KEY!, from: v.EMAIL_FROM! }; }
  else if (emailKind === 'none') email = { kind: 'none' };
  else throw new Error(`Unknown EMAIL_PROVIDER "${emailKind}" (use resend or none)`);

  const payKind = process.env.PAYMENT_PROVIDER || 'dev';
  let payments: Config['providers']['payments'];
  if (payKind === 'paystack') payments = { kind: 'paystack', secretKey: need('PAYMENT_PROVIDER=paystack', ['PAYSTACK_SECRET_KEY']).PAYSTACK_SECRET_KEY! };
  else if (payKind === 'dev') payments = { kind: 'dev' };
  else throw new Error(`Unknown PAYMENT_PROVIDER "${payKind}" (use paystack or dev)`);

  const archKind = process.env.ARCHITECT_PROVIDER || 'none';
  let architect: Config['providers']['architect'];
  if (archKind === 'anthropic') architect = { kind: 'anthropic', apiKey: need('ARCHITECT_PROVIDER=anthropic', ['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY!, model: process.env.ARCHITECT_MODEL || 'claude-opus-5-5' };
  else if (archKind === 'gemini') architect = { kind: 'gemini', apiKey: need('ARCHITECT_PROVIDER=gemini', ['GEMINI_API_KEY']).GEMINI_API_KEY!, model: process.env.ARCHITECT_MODEL || DEFAULT_GEMINI_REVIEW_MODELS };
  else if (archKind === 'none') architect = { kind: 'none' };
  else throw new Error(`Unknown ARCHITECT_PROVIDER "${archKind}" (use anthropic, gemini or none)`);

  const builderKind = process.env.BUILDER_AI_PROVIDER || 'none';
  let builder: Config['providers']['builder'];
  if (builderKind === 'anthropic') builder = { kind: 'anthropic', apiKey: need('BUILDER_AI_PROVIDER=anthropic', ['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY!, model: process.env.BUILDER_AI_MODEL || 'claude-opus-5-5' };
  else if (builderKind === 'gemini') builder = { kind: 'gemini', apiKey: need('BUILDER_AI_PROVIDER=gemini', ['GEMINI_API_KEY']).GEMINI_API_KEY!, model: process.env.BUILDER_AI_MODEL || DEFAULT_GEMINI_TEXT_MODELS };
  else if (builderKind === 'none') builder = { kind: 'none' };
  else throw new Error(`Unknown BUILDER_AI_PROVIDER "${builderKind}" (use anthropic, gemini or none)`);

  // ASSISTANT_PROVIDER: the live brain behind the build assistant (Gemini's free tier), or none (the local model alone).
  const brainKind = process.env.ASSISTANT_PROVIDER || 'none';
  let brain: NonNullable<Config['providers']['brain']>;
  if (brainKind === 'gemini') brain = { kind: 'gemini', apiKey: need('ASSISTANT_PROVIDER=gemini', ['GEMINI_API_KEY']).GEMINI_API_KEY!, model: process.env.ASSISTANT_MODEL || DEFAULT_GEMINI_TEXT_MODELS };
  else if (brainKind === 'none') brain = { kind: 'none' };
  else throw new Error(`Unknown ASSISTANT_PROVIDER "${brainKind}" (use gemini or none)`);

  const renderKind = process.env.RENDER_PROVIDER || 'none';
  let render: Config['providers']['render'];
  if (renderKind === 'openai') render = { kind: 'openai', apiKey: need('RENDER_PROVIDER=openai', ['OPENAI_API_KEY']).OPENAI_API_KEY!, model: process.env.RENDER_MODEL || 'gpt-image-1.5' };
  else if (renderKind === 'none') render = { kind: 'none' };
  else throw new Error(`Unknown RENDER_PROVIDER "${renderKind}" (use openai or none)`);

  // DESIGNER_PROVIDER: one of anthropic | gemini | none, or a chain such as "anthropic,gemini" (first answer wins).
  const designerKinds = (process.env.DESIGNER_PROVIDER || 'none').split(',').map((k) => k.trim()).filter(Boolean);
  const specs: DesignerSpec[] = designerKinds.filter((k) => k !== 'none').map((k) => {
    if (k === 'anthropic') return { kind: 'anthropic', apiKey: need('DESIGNER_PROVIDER=anthropic', ['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY!, model: process.env.DESIGNER_CLAUDE_MODEL || 'claude-opus-5-5' };
    if (k === 'gemini') return { kind: 'gemini', apiKey: need('DESIGNER_PROVIDER=gemini', ['GEMINI_API_KEY']).GEMINI_API_KEY!, model: process.env.DESIGNER_MODEL || DEFAULT_GEMINI_TEXT_MODELS };
    throw new Error(`Unknown DESIGNER_PROVIDER "${k}" (use anthropic, gemini, a comma-separated chain of them, or none)`);
  });
  const designer: Config['providers']['designer'] = specs.length === 0 ? { kind: 'none' } : specs.length === 1 ? specs[0]! : { kind: 'chain', list: specs };
  // CRITIQUE_PROVIDER: designer (the chain's first model that can see) or gemini (always Gemini, whatever composes).
  const critiqueKind = process.env.CRITIQUE_PROVIDER || 'designer';
  let critique: NonNullable<Config['providers']['critique']>;
  if (critiqueKind === 'gemini') critique = { kind: 'gemini', apiKey: need('CRITIQUE_PROVIDER=gemini', ['GEMINI_API_KEY']).GEMINI_API_KEY!, model: process.env.CRITIQUE_MODEL || process.env.DESIGNER_MODEL || DEFAULT_GEMINI_REVIEW_MODELS };
  else if (critiqueKind === 'designer') critique = { kind: 'designer' };
  else throw new Error(`Unknown CRITIQUE_PROVIDER "${critiqueKind}" (use designer or gemini)`);

  const dreamKind = process.env.DREAM_PROVIDER || 'none';
  let dream: NonNullable<Config['providers']['dream']>;
  if (dreamKind === 'gemini') dream = { kind: 'gemini', apiKey: need('DREAM_PROVIDER=gemini', ['GEMINI_API_KEY']).GEMINI_API_KEY!, model: process.env.DREAM_MODEL || 'gemini-nano-banana-2.1,gemini-3.1-flash-image,gemini-3.1-flash-lite-image' };
  else if (dreamKind === 'openai') dream = { kind: 'openai', apiKey: need('DREAM_PROVIDER=openai', ['OPENAI_API_KEY']).OPENAI_API_KEY!, model: process.env.DREAM_MODEL || 'gpt-image-1.5' };
  else if (dreamKind === 'none') dream = { kind: 'none' };
  else throw new Error(`Unknown DREAM_PROVIDER "${dreamKind}" (use gemini, openai or none)`);

  const providers = { sms, email, payments, architect, builder, brain, render, designer, critique, dream, receiptEmailDomain: process.env.RECEIPT_EMAIL_DOMAIN || 'receipts.buildwise.invalid' };
  // PAID_AI=off: refuse to start with any AI job on a paid provider, so a free-tier setup cannot drift back to one.
  const paid = paidAiJobs(providers);
  if ((process.env.PAID_AI ?? '').toLowerCase() === 'off' && paid.length) throw new Error(`PAID_AI=off, but these AI jobs are set to paid providers: ${paid.join('; ')}. Set them to gemini or none.`);
  return providers;
}

/**
 * Which AI jobs would make paid calls with these providers (Claude, OpenAI, or Gemini's image models, which have no
 * free tier). Gemini's text models run on the free tier. Each job has exactly one provider or chain: a job set to
 * gemini never falls back to Claude; on quota, timeout or failure it falls back to BuildWise's own assistant and engine.
 */
export function paidAiJobs(p: Config['providers']): string[] {
  const out: string[] = [];
  if (p.builder.kind === 'anthropic') out.push('builder chat (anthropic)');
  if (p.architect.kind === 'anthropic') out.push('architect review (anthropic)');
  const designers = p.designer.kind === 'chain' ? p.designer.list.map((d) => d.kind) : [p.designer.kind];
  if (designers.includes('anthropic')) out.push('designer (anthropic first in its chain)');
  if ((p.critique?.kind ?? 'designer') === 'designer' && designers.includes('anthropic')) out.push('3D critique (the designer chain, anthropic)');
  if (p.render.kind === 'openai') out.push('photoreal render (openai)');
  if (p.dream && p.dream.kind !== 'none') out.push(`dream renders (${p.dream.kind} image model)`);
  if (p.dream && p.dream.kind !== 'none' && p.architect.kind === 'anthropic') out.push('dream checker (anthropic)');
  return out;
}

/** MALWARE_SCANNER: which malware scanner checks uploaded documents. Only `dev` exists so far. */
function scannerKind(v: string | undefined): Config['malwareScanner'] {
  const k = v || 'dev';
  if (k === 'dev') return k;
  throw new Error(`Unknown MALWARE_SCANNER "${k}" (only dev is available; a real scanner is still to be connected)`);
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const raw = process.env.NODE_ENV;
  // Unknown values ("staging", "prod") get the production checks; unset means local development.
  const appEnv = process.env.APP_ENV;
  const env: Config['env'] = appEnv === 'staging' ? 'staging' : raw === 'development' || raw === 'test' || raw === 'production' ? raw : raw ? 'production' : 'development';
  const deployed = env === 'staging' || env === 'production';
  const providers = overrides.providers ?? loadProviders();
  const cfg: Config = {
    env,
    storage: (process.env.STORAGE as Config['storage']) ?? (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local'),
    messages: process.env.VERCEL ? 'log' : 'file',
    port: Number(process.env.PORT ?? 4000),
    databaseUrl: process.env.DATABASE_URL || undefined,
    pgliteDir: process.env.PGLITE_DIR ?? join(DATA_DIR, 'pglite'),
    authSecret: process.env.AUTH_SECRET ?? 'dev-only-auth-secret-change-me-0123456789abcdef',
    internalSecret: process.env.INTERNAL_API_SECRET ?? 'dev-only-internal-secret',
    // Codes are shown on screen only while no SMS provider is connected (local development and staging).
    exposeOtp: (process.env.EXPOSE_OTP ?? (env === 'production' || providers.sms.kind !== 'none' ? 'false' : 'true')) === 'true',
    publicWebUrl: process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000',
    publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
    storageDir: process.env.STORAGE_DIR ? resolve(ROOT, process.env.STORAGE_DIR) : join(DATA_DIR, 'objects'),
    outboxDir: process.env.OUTBOX_DIR ? resolve(ROOT, process.env.OUTBOX_DIR) : join(DATA_DIR, 'outbox'),
    marketId: process.env.MARKET_PACK ?? 'demo-2026.1',
    checkoutWebhookSecret: process.env.CHECKOUT_WEBHOOK_SECRET ?? 'dev-only-checkout-webhook-secret',
    rateLimit: {
      perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600),
      browsePerMinute: Number(process.env.BROWSE_PER_MINUTE ?? 120),
      filesPerMinute: Number(process.env.FILES_PER_MINUTE ?? 120),
      healthPerMinute: Number(process.env.HEALTH_PER_MINUTE ?? 60),
    },
    cronSecret: process.env.CRON_SECRET || null,
    malwareScanner: scannerKind(process.env.MALWARE_SCANNER),
    runWorkerInProcess: (process.env.RUN_WORKER_IN_PROCESS ?? 'true') === 'true',
    dispatchAfterCommit: (process.env.DISPATCH_AFTER_COMMIT ?? 'true') === 'true',
    catchUpSeconds: process.env.CATCH_UP_SECONDS ? Number(process.env.CATCH_UP_SECONDS) : undefined,
    otpLimitPerHour: process.env.OTP_LIMIT_PER_HOUR ? Number(process.env.OTP_LIMIT_PER_HOUR) : undefined,
    minResponseMinutes: process.env.MIN_RESPONSE_MINUTES ? Number(process.env.MIN_RESPONSE_MINUTES) : undefined,
    assistantPerMinute: Number(process.env.ASSISTANT_PER_MINUTE ?? 30),
    assistantDailyLimit: Number(process.env.ASSISTANT_DAILY_LIMIT ?? 1000),
    architectLimits: { perMinute: Number(process.env.ARCHITECT_PER_MINUTE ?? 3), perDay: Number(process.env.ARCHITECT_DAILY_LIMIT ?? 300) },
    builderLimits: { perMinute: Number(process.env.BUILDER_AI_PER_MINUTE ?? 8), perDay: Number(process.env.BUILDER_AI_DAILY_LIMIT ?? 2000) },
    renderLimits: { perMinute: Number(process.env.RENDER_PER_MINUTE ?? 2), perDay: Number(process.env.RENDER_DAILY_LIMIT ?? 100) },
    designerLimits: { perMinute: Number(process.env.DESIGNER_PER_MINUTE ?? 3), perDay: Number(process.env.DESIGNER_DAILY_LIMIT ?? 200) },
    dreamLimits: { perMinute: Number(process.env.DREAM_PER_MINUTE ?? 4), perDay: Number(process.env.DREAM_DAILY_LIMIT ?? 200) },
    rateLimitStore: (process.env.RATE_LIMIT_STORE as Config['rateLimitStore']) ?? (deployed ? 'postgres' : 'memory'),
    providers,
    ...overrides,
  };
  getMarket(cfg.marketId); // fail fast on an unknown pack
  if (deployed) {
    for (const [k, v] of Object.entries({ AUTH_SECRET: cfg.authSecret, INTERNAL_API_SECRET: cfg.internalSecret, CHECKOUT_WEBHOOK_SECRET: cfg.checkoutWebhookSecret })) {
      if (v.includes('dev-only')) throw new Error(`Set ${k} in production`);
    }
    if (!cfg.databaseUrl) throw new Error('DATABASE_URL is required in production');
    if (cfg.env === 'production' && cfg.exposeOtp) throw new Error('EXPOSE_OTP must be false in production');
    if (cfg.otpLimitPerHour !== undefined) throw new Error('OTP_LIMIT_PER_HOUR is for development and tests only');
    if (cfg.minResponseMinutes !== undefined) throw new Error('MIN_RESPONSE_MINUTES is for development and tests only');
    if (!cfg.cronSecret) throw new Error('Set CRON_SECRET when deployed: scheduled work and the detailed health view need it');
    for (const [k, v] of Object.entries({ CRON_SECRET: cfg.cronSecret, INTERNAL_API_SECRET: cfg.internalSecret })) {
      if (v.length < 32) console.warn(`[buildwise] ${k} is shorter than 32 characters; use a long random value (openssl rand -hex 32).`);
    }
    if (cfg.rateLimitStore !== 'postgres') throw new Error('RATE_LIMIT_STORE must be postgres when deployed: serverless instances do not share memory');
  }
  if (cfg.env === 'production') {
    if (cfg.providers.sms.kind === 'none') throw new Error('Production needs an SMS provider for sign-in codes (SMS_PROVIDER)');
    if (cfg.providers.payments.kind !== 'paystack') throw new Error('Production needs a payment provider (PAYMENT_PROVIDER)');
    if (cfg.providers.payments.secretKey.startsWith('sk_test_')) throw new Error('PAYSTACK_SECRET_KEY is a test key; production needs the live key');
  }
  if (deployed && cfg.malwareScanner === 'dev') {
    // TODO(security): connect a real scanner (a ClamAV daemon or a scanning API) as a new kind in createScanner().
    if (cfg.env === 'production') throw new Error('MALWARE_SCANNER=dev only detects the EICAR test file; production needs a real scanner');
    console.warn('[buildwise] MALWARE_SCANNER=dev: uploaded documents are only checked for the EICAR test file. Connect a real scanner before production.');
  }
  return cfg;
}
