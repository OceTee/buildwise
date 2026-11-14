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
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const raw = process.env.NODE_ENV;
  // Unknown values ("staging", "prod") get the production checks; unset means local development.
  const appEnv = process.env.APP_ENV;
  const env: Config['env'] = appEnv === 'staging' ? 'staging' : raw === 'development' || raw === 'test' || raw === 'production' ? raw : raw ? 'production' : 'development';
  const deployed = env === 'staging' || env === 'production';
  const cfg: Config = {
    env,
    storage: (process.env.STORAGE as Config['storage']) ?? (process.env.BLOB_STORE_ID || process.env.BLOB_READ_WRITE_TOKEN ? 'blob' : 'local'),
    messages: process.env.VERCEL ? 'log' : 'file',
    port: Number(process.env.PORT ?? 4000),
    databaseUrl: process.env.DATABASE_URL || undefined,
    pgliteDir: process.env.PGLITE_DIR ?? join(DATA_DIR, 'pglite'),
    authSecret: process.env.AUTH_SECRET ?? 'dev-only-auth-secret-change-me-0123456789abcdef',
    internalSecret: process.env.INTERNAL_API_SECRET ?? 'dev-only-internal-secret',
    exposeOtp: (process.env.EXPOSE_OTP ?? (env === 'production' ? 'false' : 'true')) === 'true',
    publicWebUrl: process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000',
    publicApiUrl: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`,
    storageDir: process.env.STORAGE_DIR ? resolve(ROOT, process.env.STORAGE_DIR) : join(DATA_DIR, 'objects'),
    outboxDir: process.env.OUTBOX_DIR ? resolve(ROOT, process.env.OUTBOX_DIR) : join(DATA_DIR, 'outbox'),
    marketId: process.env.MARKET_PACK ?? 'demo-2026.1',
    checkoutWebhookSecret: process.env.CHECKOUT_WEBHOOK_SECRET ?? 'dev-only-checkout-webhook-secret',
    rateLimit: { perMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 600) },
    runWorkerInProcess: (process.env.RUN_WORKER_IN_PROCESS ?? 'true') === 'true',
    otpLimitPerHour: process.env.OTP_LIMIT_PER_HOUR ? Number(process.env.OTP_LIMIT_PER_HOUR) : undefined,
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
  }
  return cfg;
}
