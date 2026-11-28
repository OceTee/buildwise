import { type NextRequest, NextResponse } from 'next/server';
import { DEPLOYED, SITE_URL } from './env';

/**
 * Request checks shared by the web server's own endpoints (spec §19): which writes are same-site, which client
 * address to trust, when cookies must be Secure, and the Content-Security-Policy for pages.
 */

const refuse = (message: string, status = 403) => NextResponse.json({ error: { code: status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'FORBIDDEN', message } }, { status });

/**
 * A write must come from this site's own pages. Browsers send `Origin` on every cross-site and same-site POST,
 * PUT, PATCH and DELETE; when it is missing we accept only `Sec-Fetch-Site: same-origin`. A request with neither
 * (old clients, scripts, forms on other sites with the header stripped) is refused rather than trusted.
 */
export function crossSiteWrite(req: NextRequest): NextResponse | null {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return null;
  const origin = req.headers.get('origin');
  if (origin) return ownOrigins(req).has(origin) ? null : refuse('Cross-site request refused.');
  return req.headers.get('sec-fetch-site') === 'same-origin' ? null : refuse('Cross-site request refused.');
}

/** This site's own origins: the one the request reached and the configured public address. */
function ownOrigins(req: NextRequest): Set<string> {
  return new Set([req.nextUrl.origin, new URL(SITE_URL).origin]);
}

/**
 * JSON is the only body type a form on another site cannot send without a CORS preflight, so every write carries
 * it, except the upload paths, which take the file's own type.
 */
export function wrongBodyType(req: NextRequest, sub: string, hasBody: boolean): NextResponse | null {
  if (req.method === 'GET' || req.method === 'HEAD' || !hasBody) return null;
  const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (/^uploads\/[^/]+$/.test(sub)) return null; // a signed upload link: any document type, sniffed by the API
  if (sub === 'photos') return type.startsWith('image/') ? null : refuse('Send the photo as an image.', 415);
  return type === 'application/json' ? null : refuse('Send the request as JSON.', 415);
}

/**
 * The client's IP as the platform saw it. On Vercel `x-real-ip` / `x-vercel-forwarded-for` are set by Vercel's
 * edge and cannot be supplied by the client. Elsewhere only the last `x-forwarded-for` hop (added by the proxy
 * in front of us) is trusted; the leftmost entries are whatever the client wrote.
 */
export function clientIp(h: Headers): string {
  if (process.env.VERCEL) {
    const v = (h.get('x-vercel-forwarded-for') ?? h.get('x-real-ip') ?? '').split(',')[0]!.trim();
    if (v) return v;
  }
  const hops = (h.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  return hops.at(-1) || h.get('x-real-ip') || '127.0.0.1';
}

/** Cookies are Secure on every deployed site and on any HTTPS request; only plain-HTTP local development goes without. */
export function secureCookies(req: NextRequest): boolean {
  return DEPLOYED || req.nextUrl.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
}

/**
 * Content-Security-Policy for pages. Scripts run only with this response's nonce (`strict-dynamic` lets Next's
 * chunks load their own children); three.js needs WebGL (no CSP) and blob: textures, pdf.js a same-origin
 * worker and WebAssembly; photos and renders are same-origin or data:/blob: URLs; direct uploads go to Vercel
 * Blob. Styles allow inline attributes, which React's style props need.
 */
export function contentSecurityPolicy(nonce: string, https: boolean): string {
  const dev = process.env.NODE_ENV === 'development';
  const blob = 'https://*.blob.vercel-storage.com';
  const d: Record<string, string> = {
    'default-src': "'self'",
    'script-src': `'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${dev ? " 'unsafe-eval'" : ''}`,
    'style-src': "'self' 'unsafe-inline'",
    'img-src': `'self' data: blob: ${blob}`,
    'font-src': "'self' data:",
    'connect-src': `'self' ${blob} https://vercel.com/api/blob${dev ? ' ws: wss:' : ''}`,
    'worker-src': "'self' blob:",
    'media-src': "'self' data: blob:",
    'manifest-src': "'self'",
    'object-src': "'none'",
    'frame-src': "'none'",
    'base-uri': "'self'",
    'form-action': "'self'",
    'frame-ancestors': "'none'",
  };
  return Object.entries(d).map(([k, v]) => `${k} ${v}`).join('; ') + (https ? '; upgrade-insecure-requests' : '');
}
