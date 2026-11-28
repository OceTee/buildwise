import { type NextRequest, NextResponse } from 'next/server';
import { API_ACCESS_HEADERS, API_URL, DEVICE_COOKIE, INTERNAL_SECRET, SESSION_COOKIE, SESSION_MAX_AGE_S } from '@/lib/env';
import { clientIp, crossSiteWrite, secureCookies, wrongBodyType } from '@/lib/security';

/** Completes phone sign-in: the API's token is stored in an httpOnly cookie and never returned to the page. */
export async function POST(req: NextRequest) {
  const refused = crossSiteWrite(req) ?? wrongBodyType(req, 'session', true);
  if (refused) return refused;
  const body = await req.text();
  const res = await fetch(`${API_URL}/v1/auth/otp/verify`, {
    method: 'POST', cache: 'no-store', redirect: 'manual', body,
    headers: {
      ...API_ACCESS_HEADERS,
      'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET,
      'x-client-ip': clientIp(req.headers),
      ...(req.cookies.get(DEVICE_COOKIE) ? { 'x-device-id': req.cookies.get(DEVICE_COOKIE)!.value } : {}),
    },
  });
  const data = await res.json();
  if (!res.ok || !data.token) return NextResponse.json(data, { status: res.status });
  const { token, ...rest } = data;
  const out = NextResponse.json(rest, { status: 200 });
  out.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: secureCookies(req), sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_S });
  return out;
}

/** Signs out this browser: revokes the session at the API, then clears the cookie. */
export async function DELETE(req: NextRequest) {
  const refused = crossSiteWrite(req);
  if (refused) return refused;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    await fetch(`${API_URL}/v1/me/sessions/revoke`, { method: 'POST', cache: 'no-store', redirect: 'manual', headers: { ...API_ACCESS_HEADERS, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ everywhere: false }) }).catch(() => undefined);
  }
  const out = NextResponse.json({ signedOut: true });
  out.cookies.delete(SESSION_COOKIE);
  return out;
}
