import http from 'node:http';
import https from 'node:https';
import { type NextRequest, NextResponse } from 'next/server';
import { API_ACCESS_HEADERS, API_URL, DEVICE_COOKIE, INTERNAL_SECRET, SESSION_COOKIE } from '@/lib/env';

/**
 * Backend-for-frontend proxy. The session token lives in an httpOnly cookie that page scripts cannot read;
 * this handler adds it as a bearer token, forwards the client IP and device id with the shared secret, and
 * refuses cross-site writes. Provider webhooks go straight to the API, never through here.
 */
const BLOCKED = [/^webhooks\//];
/** AI routes where a frontier model can think for many minutes (a full design takes ~7). */
const SLOW = /^build\/(design|critique|dream|render|architect|chat)$/;
const SLOW_LIMIT_MS = 15 * 60_000;

/**
 * fetch() in Node gives up when response headers take over 5 minutes (undici's headersTimeout), which cuts off a
 * long AI design. The slow routes go through node:http instead, which waits as long as we allow.
 */
function slowRequest(url: string, method: string, headers: Record<string, string>, body?: ArrayBuffer): Promise<Response> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: body ? { ...headers, 'content-length': String(body.byteLength) } : headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') h.set(k, v);
        const status = res.statusCode ?? 502;
        resolve(new Response(status === 204 ? null : Buffer.concat(chunks), { status, headers: h }));
      });
      res.on('error', reject);
    });
    req.setTimeout(SLOW_LIMIT_MS, () => req.destroy(new Error('API took too long')));
    req.on('error', reject);
    req.end(body ? Buffer.from(body) : undefined);
  });
}

async function forward(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const sub = path.join('/');
  if (BLOCKED.some((r) => r.test(sub))) return NextResponse.json({ error: { code: 'NOT_FOUND', message: 'Not found.' } }, { status: 404 });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (origin && origin !== req.nextUrl.origin) return NextResponse.json({ error: { code: 'FORBIDDEN', message: 'Cross-site request refused.' } }, { status: 403 });
  }
  const headers: Record<string, string> = {
    ...API_ACCESS_HEADERS,
    'x-internal-secret': INTERNAL_SECRET,
    'x-client-ip': (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || '127.0.0.1',
  };
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) headers.authorization = `Bearer ${token}`;
  const device = req.cookies.get(DEVICE_COOKIE)?.value;
  if (device) headers['x-device-id'] = device;
  for (const h of ['content-type', 'idempotency-key']) { const v = req.headers.get(h); if (v) headers[h] = v; }

  const url = `${API_URL}/v1/${sub}${req.nextUrl.search}`;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
  const res = SLOW.test(sub) && req.method === 'POST'
    ? await slowRequest(url, req.method, headers, body)
    : await fetch(url, { method: req.method, headers, cache: 'no-store', redirect: 'manual', body });
  const out = new NextResponse(res.status === 204 ? null : await res.arrayBuffer(), { status: res.status });
  for (const h of ['content-type', 'retry-after', 'idempotent-replayed', 'x-correlation-id']) { const v = res.headers.get(h); if (v) out.headers.set(h, v); }
  out.headers.set('cache-control', 'private, no-store');
  // A revoked or expired session: drop the cookie so the site shows the signed-out state.
  if (res.status === 401 && token) out.cookies.delete(SESSION_COOKIE);
  return out;
}

export { forward as GET, forward as POST, forward as PATCH, forward as PUT, forward as DELETE };
