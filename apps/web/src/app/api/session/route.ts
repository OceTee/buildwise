import { type NextRequest, NextResponse } from 'next/server';
import { API_URL, DEVICE_COOKIE, INTERNAL_SECRET, SECURE_COOKIES, SESSION_COOKIE } from '@/lib/env';

/** Completes phone sign-in: the API's token is stored in an httpOnly cookie and never returned to the page. */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Cross-site request refused.' } }, { status: 403 });
  const body = await req.text();
  const res = await fetch(`${API_URL}/v1/auth/otp/verify`, {
    method: 'POST', cache: 'no-store', body,
    headers: {
      'content-type': 'application/json', 'x-internal-secret': INTERNAL_SECRET,
      'x-client-ip': (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || '127.0.0.1',
      ...(req.cookies.get(DEVICE_COOKIE) ? { 'x-device-id': req.cookies.get(DEVICE_COOKIE)!.value } : {}),
    },
  });
  const data = await res.json();
  if (!res.ok || !data.token) return NextResponse.json(data, { status: res.status });
  const { token, ...rest } = data;
  const out = NextResponse.json(rest, { status: 200 });
  out.cookies.set(SESSION_COOKIE, token, { httpOnly: true, secure: SECURE_COOKIES, sameSite: 'lax', path: '/', maxAge: 30 * 86_400 });
  return out;
}

/** Signs out this browser: revokes the session at the API, then clears the cookie. */
export async function DELETE(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    await fetch(`${API_URL}/v1/me/sessions/revoke`, { method: 'POST', cache: 'no-store', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ everywhere: false }) }).catch(() => undefined);
  }
  const out = NextResponse.json({ signedOut: true });
  out.cookies.delete(SESSION_COOKIE);
  return out;
}
