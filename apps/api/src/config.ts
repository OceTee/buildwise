import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getMarket } from '@bw/domain';

const ROOT = resolve(import.meta.dirname, '../../..');
/**
 * Local development data (embedded database, uploaded files, message outbox) lives outside the repository:
 * the Next.js dev server watches the whole monorepo, and database writes inside it trigger endless recompiles.
 */
const DATA_DIR = process.env.DATA_DIR ? resolve(ROOT, process.env.DATA_DIR) : join(homedir(), '.buildwise', 'dev');

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
  rateLimit: { perMinute: number };
  runWorkerInProcess: boolean;
  /** Development/test only: raises the per-number and per-IP code limits so automated tests can sign in repeatedly. */
  otpLimitPerHour?: number;
  /** Build-assistant messages per IP per minute (the assistant runs locally; this only stops floods). */
  assistantPerMinute: number;
  /** Fresh AI architect reviews per IP per minute, and in total per day (cached reviews do not count). */
  architectLimits: { perMinute: number; perDay: number };
  /** Builder AI messages per IP per minute, and in total per day (beyond them the local assistant answers). */
  builderLimits: { perMinute: number; perDay: number };
  /** Photoreal renders per IP per minute, and in total per day (beyond them the browser is told the service is busy). */
  renderLimits: { perMinute: number; perDay: number };
  /** Where per-IP request counts live: `memory` (one process) or `postgres` (shared by every serverless instance). */
  rateLimitStore: 'memory' | 'postgres';
  /** Real providers. `none` keeps the development stand-in (outbox file, log line or test checkout page). */
  providers: {
    sms: { kind: 'none' } | { kind: 'twilio'; accountSid: string; authToken: string; from: string } | { kind: 'termii'; apiKey: string; senderId: string; baseUrl: string };
    email: { kind: 'none' } | { kind: 'resend'; apiKey: string; from: string };
    payments: { kind: 'dev' } | { kind: 'paystack'; secretKey: string };
    /** The AI architect that reviews and ranks generated designs. `none`: the design engine's own notes only. */
    architect: { kind: 'none' } | { kind: 'anthropic'; apiKey: string; model: string };
    /** The Builder AI conversation. `none`: BuildWise's local assistant answers. */
    builder: { kind: 'none' } | { kind: 'anthropic'; apiKey: string; model: string };
    /** Photoreal renders of the 3D model (an image model; Claude does not make images). `none`: no render button. */
    render: { kind: 'none' } | { kind: 'openai'; apiKey: string; model: string };
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

function loadProviders(): Config['providers'] {
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
  else if (archKind === 'none') architect = { kind: 'none' };
  else throw new Error(`Unknown ARCHITECT_PROVIDER "${archKind}" (use anthropic or none)`);

  const builderKind = process.env.BUILDER_AI_PROVIDER || 'none';
  let builder: Config['providers']['builder'];
  if (builderKind === 'anthropic') builder = { kind: 'anthropic', apiKey: need('BUILDER_AI_PROVIDER=anthropic', ['ANTHROPIC_API_KEY']).ANTHROPIC_API_KEY!, model: process.env.BUILDER_AI_MODEL || 'claude-opus-5-5' };
  else if (builderKind === 'none') builder = { kind: 'none' };
  else throw new Error(`Unknown BUILDER_AI_PROVIDER "${builderKind}" (use anthropic or none)`);

  const renderKind = process.env.RENDER_PROVIDER || 'none';
  let render: Config['providers']['render'];
  if (renderKind === 'openai') render = { kind: 'openai', apiKey: need('RENDER_PROVIDER=openai', ['OPENAI_API_KEY']).OPENAI_API_KEY!, model: process.env.RENDER_MODEL || 'gpt-image-1.5' };
  else if (renderKind === 'none') render = { kind: 'none' };
  else throw new Error(`Unknown RENDER_PROVIDER "${renderKind}" (use openai or none)`);

  return { sms, email, payments, architect, builder, render, receiptEmailDomain: process.env.RECEIPT_EMAIL_DOMAIN || 'receipts.buildwise.invalid' };
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
    rateLimit: { perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) },
    runWorkerInProcess: (process.env.RUN_WORKER_IN_PROCESS ?? 'true') === 'true',
    otpLimitPerHour: process.env.OTP_LIMIT_PER_HOUR ? Number(process.env.OTP_LIMIT_PER_HOUR) : undefined,
    assistantPerMinute: Number(process.env.ASSISTANT_PER_MINUTE ?? 30),
    architectLimits: { perMinute: Number(process.env.ARCHITECT_PER_MINUTE ?? 3), perDay: Number(process.env.ARCHITECT_DAILY_LIMIT ?? 300) },
    builderLimits: { perMinute: Number(process.env.BUILDER_AI_PER_MINUTE ?? 8), perDay: Number(process.env.BUILDER_AI_DAILY_LIMIT ?? 2000) },
    renderLimits: { perMinute: Number(process.env.RENDER_PER_MINUTE ?? 2), perDay: Number(process.env.RENDER_DAILY_LIMIT ?? 100) },
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
    if (cfg.rateLimitStore !== 'postgres') throw new Error('RATE_LIMIT_STORE must be postgres when deployed: serverless instances do not share memory');
  }
  if (cfg.env === 'production') {
    if (cfg.providers.sms.kind === 'none') throw new Error('Production needs an SMS provider for sign-in codes (SMS_PROVIDER)');
    if (cfg.providers.payments.kind !== 'paystack') throw new Error('Production needs a payment provider (PAYMENT_PROVIDER)');
    if (cfg.providers.payments.secretKey.startsWith('sk_test_')) throw new Error('PAYSTACK_SECRET_KEY is a test key; production needs the live key');
  }
  return cfg;
}
