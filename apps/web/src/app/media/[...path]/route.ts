import { type NextRequest, NextResponse } from 'next/server';
import { API_ACCESS_HEADERS, API_URL, SESSION_COOKIE } from '@/lib/env';

/** Listing photos. Public photos are cacheable; owners and staff can preview photos on unpublished listings. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const res = await fetch(`${API_URL}/media/${path.map(encodeURIComponent).join('/')}`, { headers: { ...API_ACCESS_HEADERS, ...(token ? { authorization: `Bearer ${token}` } : {}) }, cache: 'no-store', redirect: 'manual' });
  if (!res.ok) return new NextResponse(null, { status: res.status === 404 ? 404 : 502 });
  return new NextResponse(res.body, { status: 200, headers: { 'content-type': res.headers.get('content-type') ?? 'image/webp', 'cache-control': res.headers.get('cache-control') ?? 'private, no-store' } });
}
