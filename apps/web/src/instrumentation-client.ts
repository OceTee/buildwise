// Browser error tracking. Only with NEXT_PUBLIC_SENTRY_DSN set at build time does the Sentry SDK load; without it
// nothing is fetched and nothing is sent. Every event is scrubbed of phone numbers, emails and tokens first.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  void Promise.all([import('@sentry/nextjs'), import('@bw/domain/privacy')]).then(([Sentry, { ERROR_TRACKING_DATA_COLLECTION, scrubBreadcrumb, scrubEvent }]) => {
    Sentry.init({
      dsn,
      environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || process.env.NODE_ENV,
      release: process.env.NEXT_PUBLIC_SENTRY_RELEASE || undefined,
      tracesSampleRate: 0,
      dataCollection: ERROR_TRACKING_DATA_COLLECTION,
      beforeSend: (event) => scrubEvent(event),
      beforeBreadcrumb: (b) => scrubBreadcrumb(b),
    });
  }).catch(() => undefined);
}
