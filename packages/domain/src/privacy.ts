/**
 * Privacy scrubbing for anything that leaves BuildWise for an outside operations service (error tracking, spec
 * §21.4): phone numbers, emails, bearer and signed file tokens, authenticating headers and cookies, and the bodies
 * of routes that carry sign-in codes or what people typed. Pure, so the API and the website share one copy.
 */

const REDACTED = '[redacted]';
/** Request bodies of these routes are never sent: they hold phone numbers, codes, or what people typed to the AI. */
export const SENSITIVE_BODY_ROUTES = [
  /^\/v1\/auth\//, /^\/v1\/build\/(chat|interpret|feedback)/, /^\/v1\/threads/, /^\/v1\/messages/, /^\/v1\/account/, /^\/v1\/me/,
  // Staff MFA codes and recovery codes, staff grants, what people write as feedback (incl. staff triage notes).
  /^\/v1\/staff\//, /^\/v1\/moderation\/staff/, /^\/v1\/feedback/, /^\/v1\/moderation\/feedback/,
];
const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-internal-secret|x-client-ip|x-forwarded-for|x-real-ip|x-device-id|idempotency-key|proxy-authorization)$/i;
const SENSITIVE_KEYS = /^(phone|phone_e164|phoneE164|email|code|otp|devCode|token|password|secret|authorization|cookie|displayName|display_name|message|text|body|ip|deviceId)$/i;

/** Strips the things that identify a person or open a door: phone numbers, emails, bearer/JWT and signed file tokens. */
export function scrubText(s: string): string {
  return s
    .replace(/\/v1\/(files|uploads)\/[^/?#\s"']+/g, '/v1/$1/[token]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[jwt]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{43}\b/g, '[token]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    // International (+234…) and local Nigerian (080…, 070…) numbers, with or without spaces/dashes.
    .replace(/\+\d[\d\s-]{7,16}\d/g, '[phone]')
    .replace(/\b0[789][01]\d[\s-]?\d{3}[\s-]?\d{4}\b/g, '[phone]');
}

export function scrubValue(v: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (typeof v === 'string') return scrubText(v);
  if (Array.isArray(v)) return v.map((x) => scrubValue(x, depth + 1));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SENSITIVE_KEYS.test(k) ? REDACTED : scrubValue(x, depth + 1);
    return out;
  }
  return v;
}

/** The subset of a Sentry event this code touches; the SDK's own type is wider. */
export interface TrackedEvent {
  message?: string;
  request?: { url?: string; method?: string; headers?: Record<string, unknown>; cookies?: unknown; data?: unknown; query_string?: unknown; env?: unknown };
  user?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  contexts?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  breadcrumbs?: { message?: string; data?: Record<string, unknown>; [k: string]: unknown }[];
  exception?: { values?: { value?: string; [k: string]: unknown }[] };
  [k: string]: unknown;
}

/**
 * Runs before anything leaves for the error tracker. Headers and cookies that authenticate go, bodies of auth,
 * chat and message routes go, the user becomes the hashed id only, and every string is scrubbed of phone numbers,
 * emails and tokens.
 */
export function scrubEvent<E extends object>(event: E): E {
  const e = event as unknown as TrackedEvent;
  if (e.request) {
    const r = e.request;
    if (r.url) r.url = scrubText(r.url.replace(/\?.*$/, ''));
    delete r.cookies;
    delete r.query_string;
    delete r.env;
    if (r.headers) for (const k of Object.keys(r.headers)) if (SENSITIVE_HEADERS.test(k)) r.headers[k] = REDACTED;
    const path = (() => { try { return new URL(r.url ?? '', 'http://x').pathname; } catch { return r.url ?? ''; } })();
    if (SENSITIVE_BODY_ROUTES.some((re) => re.test(path))) delete r.data;
    else if (r.data !== undefined) r.data = scrubValue(r.data);
  }
  if (e.user) e.user = typeof e.user.id === 'string' && /^[0-9a-f]{16}$/.test(e.user.id) ? { id: e.user.id } : {};
  if (e.message) e.message = scrubText(e.message);
  if (e.extra) e.extra = scrubValue(e.extra) as Record<string, unknown>;
  if (e.contexts) e.contexts = scrubValue(e.contexts) as Record<string, unknown>;
  if (e.tags) e.tags = scrubValue(e.tags) as Record<string, unknown>;
  for (const v of e.exception?.values ?? []) if (v.value) v.value = scrubText(v.value);
  if (e.breadcrumbs) e.breadcrumbs = e.breadcrumbs.map((b) => ({ ...b, ...(b.message ? { message: scrubText(b.message) } : {}), ...(b.data ? { data: scrubValue(b.data) as Record<string, unknown> } : {}) }));
  return event;
}


/** For `beforeBreadcrumb`: the message and data scrubbed like an event's. */
export function scrubBreadcrumb<B extends object>(b: B): B {
  const x = b as { message?: string; data?: Record<string, unknown> };
  return { ...b, ...(x.message ? { message: scrubText(x.message) } : {}), ...(x.data ? { data: scrubValue(x.data) } : {}) };
}

/**
 * What the error tracker's SDK may collect by itself (Sentry 11 `dataCollection`; its defaults collect cookies, all
 * headers, bodies, query strings and local variables). Off except a few harmless request headers; `scrubEvent`
 * still runs over everything that is sent.
 */
export const ERROR_TRACKING_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: { request: { allow: ['content-type', 'accept', 'user-agent'] }, response: false },
  httpBodies: [] as never[],
  urlQueryParams: false,
  databaseQueryData: false,
  queues: false,
  stackFrameVariables: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  mcp: { inputs: false, outputs: false },
};
