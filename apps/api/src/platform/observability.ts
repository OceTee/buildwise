import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac } from 'node:crypto';
import { ERROR_TRACKING_DATA_COLLECTION, scrubBreadcrumb, scrubEvent, scrubText } from '@bw/domain';

export { scrubEvent, scrubText };

/**
 * Observability (spec §21.4): the request context that carries the correlation id into logs, outbox events and
 * error reports, and error tracking behind one adapter like the other providers. Nothing here knows a vendor
 * except `createSentryTracker`, which loads `@sentry/node` only when a DSN is configured.
 */

// ---------------------------------------------------------------- request context
export interface RequestContext {
  /** The request id (uuidv7) for HTTP requests, `worker-<uuid>` for a worker cycle. */
  correlationId: string;
  /** The route template (`/v1/listings/:id`), never the raw URL, so tokens and ids in paths stay out. */
  route?: string;
  /** A keyed hash of the signed-in user's id, set once the session is checked. Never the phone or email. */
  userHash?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T { return store.run(ctx, fn); }
export const currentContext = (): RequestContext | undefined => store.getStore();
export const currentCorrelationId = (): string | null => store.getStore()?.correlationId ?? null;

/** A stable, non-reversible id for a user in logs and error reports (HMAC with the server secret, 16 hex chars). */
export function userHashOf(secret: string, userId: string): string {
  return createHmac('sha256', secret).update(`user:${userId}`).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------- error tracking
export interface ErrorContext { correlationId?: string | null; route?: string | null; userHash?: string | null; status?: number; tags?: Record<string, string> }

export interface ErrorTracker {
  kind: 'none' | 'sentry';
  capture(err: unknown, ctx?: ErrorContext): void;
  /** Waits for queued events (serverless instances freeze after the response). */
  flush(timeoutMs?: number): Promise<void>;
}

export const noTracker: ErrorTracker = { kind: 'none', capture: () => undefined, flush: async () => undefined };

export interface SentrySettings { dsn: string; environment: string; release?: string; sampleRate?: number }

/** The parts of `@sentry/node` used here, so tests can pass a fake SDK. */
export interface SentryLike {
  init(opts: Record<string, unknown>): unknown;
  withScope(fn: (scope: { setTag(k: string, v: string): void; setUser(u: { id: string } | null): void; setLevel?(l: string): void }) => void): void;
  captureException(err: unknown): unknown;
  flush(timeoutMs?: number): Promise<boolean>;
}

export async function createSentryTracker(cfg: SentrySettings, load: () => Promise<SentryLike> = async () => (await import('@sentry/node')) as unknown as SentryLike): Promise<ErrorTracker> {
  const sdk = await load();
  sdk.init({
    dsn: cfg.dsn,
    environment: cfg.environment,
    release: cfg.release,
    sampleRate: cfg.sampleRate ?? 1,
    tracesSampleRate: 0,          // errors only; no performance traces leave the API
    dataCollection: ERROR_TRACKING_DATA_COLLECTION,
    maxBreadcrumbs: 30,
    beforeSend: (event: object) => scrubEvent(event),
    beforeBreadcrumb: (b: object) => scrubBreadcrumb(b),
  });
  const flush = async (timeoutMs = 2000) => { await sdk.flush(timeoutMs).catch(() => false); };
  return {
    kind: 'sentry',
    capture(err, ctx = {}) {
      const c = { ...currentContext(), ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v != null)) } as ErrorContext & RequestContext;
      sdk.withScope((scope) => {
        if (c.correlationId) scope.setTag('correlation_id', c.correlationId);
        if (c.route) scope.setTag('route', c.route);
        if (c.status) scope.setTag('status', String(c.status));
        for (const [k, v] of Object.entries(c.tags ?? {})) scope.setTag(k, v);
        scope.setUser(c.userHash ? { id: c.userHash } : null);
        sdk.captureException(err);
      });
      // On Vercel the instance may freeze as soon as the response is sent: keep it alive until the event is out.
      if (process.env.VERCEL) void import('@vercel/functions').then((m) => m.waitUntil(flush())).catch(() => undefined);
    },
    flush,
  };
}
