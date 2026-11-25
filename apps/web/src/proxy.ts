import { type NextRequest, NextResponse } from 'next/server';

import { API_ACCESS_HEADERS, API_URL } from './lib/env';

/**
 * Runs before pages: gives each browser a random device id (used for abuse limits, never for tracking across
 * sites) and answers 410 Gone for listings removed long ago, so search engines drop them (spec §3.6).
 */
export async function proxy(req: NextRequest) {
  const m = req.nextUrl.pathname.match(/^\/listing\/[a-z0-9-]*?([0-9a-f]{12})$/);
  if (m) {
    const r = await fetch(`${API_URL}/v1/public/listings/${m[1]}`, { method: 'GET', cache: 'no-store', headers: API_ACCESS_HEADERS, redirect: 'manual' }).catch(() => null);
    if (r?.status === 410) {
      return new NextResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Listing removed</title></head><body style="font-family:system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem"><h1>This listing has been removed</h1><p>It is no longer available. <a href="/search">Search for similar items</a>.</p></body></html>`,
        { status: 410, headers: { 'content-type': 'text/html; charset=utf-8' } });
    }
  }
  const res = NextResponse.next();
  if (!req.cookies.get('bw_device')) {
    res.cookies.set('bw_device', crypto.randomUUID().replace(/-/g, ''), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 2 * 365 * 86_400 });
  }
  return res;
}

export const config = { matcher: ['/((?!_next/|api/|media/|favicon|robots.txt|sitemap.xml).*)'] };
