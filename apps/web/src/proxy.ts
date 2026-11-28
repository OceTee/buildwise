import { type NextRequest, NextResponse } from 'next/server';

import { API_ACCESS_HEADERS, API_URL, DEVICE_COOKIE, INTERNAL_SECRET } from './lib/env';
import { clientIp, contentSecurityPolicy, secureCookies } from './lib/security';

/**
 * Runs before pages: gives each browser a random device id (used for abuse limits, never for tracking across
 * sites), answers 410 Gone for listings removed long ago, so search engines drop them (spec §3.6), and sets a
 * per-response Content-Security-Policy nonce that Next puts on its own scripts (§19).
 */
export async function proxy(req: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = contentSecurityPolicy(nonce, secureCookies(req));

  const m = req.nextUrl.pathname.match(/^\/listing\/[a-z0-9-]*?([0-9a-f]{12})$/);
  if (m) {
    const r = await fetch(`${API_URL}/v1/public/listings/${m[1]}`, { method: 'GET', cache: 'no-store', redirect: 'manual',
      // The visitor's own IP, so the API's per-IP limits count them and not this server.
      headers: { ...API_ACCESS_HEADERS, 'x-internal-secret': INTERNAL_SECRET, 'x-client-ip': clientIp(req.headers) } }).catch(() => null);
    if (r?.status === 410) {
      return new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Listing removed</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>This listing has been removed</h1><p>It is no longer available. <a href="/search">Search for similar items</a>.</p></body></html>`,
        { status: 410, headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp } });
    }
  }

  // Next reads the nonce from the request's CSP header and adds it to every script it renders.
  const headers = new Headers(req.headers);
  headers.set('x-nonce', nonce);
  headers.set('content-security-policy', csp);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set('content-security-policy', csp);
  if (!req.cookies.get(DEVICE_COOKIE)) {
    res.cookies.set(DEVICE_COOKIE, crypto.randomUUID().replace(/-/g, ''), { httpOnly: true, sameSite: 'lax', secure: secureCookies(req), path: '/', maxAge: 2 * 365 * 86_400 });
  }
  return res;
}

export const config = {
  matcher: [{
    source: '/((?!_next/|api/|media/|favicon|robots.txt|sitemap.xml).*)',
    // Prefetches render no new scripts; giving them a nonce would only defeat caching.
    missing: [{ type: 'header', key: 'next-router-prefetch' }, { type: 'header', key: 'purpose', value: 'prefetch' }],
  }],
};
