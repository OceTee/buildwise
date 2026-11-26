import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { API_ACCESS_HEADERS, API_URL, DEVICE_COOKIE, INTERNAL_SECRET, SESSION_COOKIE } from './env';

export interface ApiResult<T> { status: number; data: T }

/** Headers that let the API trust the end user's IP and device id (it ignores them without the secret). */
export async function forwardHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const c = await cookies();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || h.get('x-real-ip') || '127.0.0.1';
  const out: Record<string, string> = { ...API_ACCESS_HEADERS, 'x-internal-secret': INTERNAL_SECRET, 'x-client-ip': ip };
  const dev = c.get(DEVICE_COOKIE)?.value;
  if (dev) out['x-device-id'] = dev;
  const token = c.get(SESSION_COOKIE)?.value;
  if (token) out.authorization = `Bearer ${token}`;
  return out;
}

/** Server-side API call for pages. Never throws for HTTP errors; callers decide (notFound, redirect, ...). */
export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult<T>> {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: { ...(await forwardHeaders()), ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    cache: 'no-store',
    redirect: 'manual',
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

export interface Me {
  id: string; displayName: string; phoneMasked: string | null; email: string | null; isStaff: boolean; staffRole: string | null;
  organizations: { id: string; kind: 'personal' | 'business'; name: string; handle: string; role: string; chatOnly: boolean }[];
}

/** The signed-in user for this request, or null. Cached per request. */
export const getMe = cache(async (): Promise<Me | null> => {
  const c = await cookies();
  if (!c.get(SESSION_COOKIE)) return null;
  const r = await api<Me>('/v1/me');
  return r.status === 200 ? r.data : null;
});

export interface Market {
  id: string; name: string; illustrative: boolean; locale: string; currency: string; defaultCallingCode: string;
  regions: { code: string; label: string; areas: { code: string; label: string }[] }[];
  safetyTips: string[]; tax: { label: string; ratePercent: number };
}
export const getMarket = cache(async () => (await api<Market>('/v1/market')).data);

export interface Category { slug: string; parent: string | null; name: string; listingType: string; priceUnits: string[]; minPhotos: number; attributes: any[]; seoText: string | null; liveCount: number }
export const getCategories = cache(async () => (await api<{ items: Category[] }>('/v1/categories')).data.items);
