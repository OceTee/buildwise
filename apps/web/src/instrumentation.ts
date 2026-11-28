import type { Instrumentation } from 'next';

// Server-side error tracking for the website (server components, route handlers, the API proxy). Loads
// @sentry/nextjs only when NEXT_PUBLIC_SENTRY_DSN is set; events are scrubbed before they leave.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

/** Runs once when the web server starts: a deployed server refuses to start on development fallbacks. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { assertServerEnv } = await import('./lib/env');
  assertServerEnv();
  if (!dsn) return;
  const [Sentry, { ERROR_TRACKING_DATA_COLLECTION, scrubBreadcrumb, scrubEvent }] = await Promise.all([import('@sentry/nextjs'), import('@bw/domain/privacy')]);
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.APP_ENV || process.env.NODE_ENV,
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
    tracesSampleRate: 0,
    dataCollection: ERROR_TRACKING_DATA_COLLECTION,
    beforeSend: (event) => scrubEvent(event),
    beforeBreadcrumb: (b) => scrubBreadcrumb(b),
  });
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (!dsn || process.env.NEXT_RUNTIME !== 'nodejs') return;
  const Sentry = await import('@sentry/nextjs');
  Sentry.captureRequestError(error, request, context);
};
