import { type NextRequest, NextResponse } from 'next/server';
import { API_URL, DEVICE_COOKIE, INTERNAL_SECRET, SESSION_COOKIE } from '@/lib/env';

/**
 * Backend-for-frontend proxy. The session token lives in an httpOnly cookie that page scripts cannot read;
 * this handler adds it as a bearer token, forwards the client IP and device id with the shared secret, and
 * refuses cross-site writes. Provider webhooks go straight to the API, never through here.
 */
const BLOCKED = [/^webhooks\//];

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const sub = path.join('/');
  if (BLOCKED.some((r) => r.test(sub))) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, { status: 404 });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Cross-site request refused.' } }, { status: 403 });
  }
  const headers: Record<string, string> = {
    'x-internal-secret': INTERNAL_SECRET,
    'x-client-ip': (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || '127.0.0.1',
  };
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) headers.authorization = `Bearer ${token}`;
  const device = req.cookies.get(DEVICE_COOKIE)?.value;
  if (device) headers['x-device-id'] = device;
  for (const h of ['content-type', 'idempotency-key']) { const v = req.headers.get(h); if (v) headers[h] = v; }

  const res = await fetch(`${API_URL}/v1/${sub}${req.nextUrl.search}`, {
    method: req.method, headers, cache: 'no-store',
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer(),
  });
  const out = new NextResponse(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status });
  for (const h of ['content-type', 'retry-after', 'idempotent-replayed', 'x-correlation-id']) { const v = res.headers.get(h); if (v) out.headers.set(h, v); }
  out.headers.set('cache-control', 'private, no-store');
  // A revoked or expired session: drop the cookie so the site shows the signed-out state.
  if (res.status === 401 && token) out.cookies.delete(SESSION_COOKIE);
  return out;
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
