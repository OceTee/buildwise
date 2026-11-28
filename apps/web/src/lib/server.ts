import { cookies, headers } from 'next/headers';
import { cache } from 'react';
import { API_ACCESS_HEADERS, API_URL, DEVICE_COOKIE, INTERNAL_SECRET, SESSION_COOKIE } from './env';
import { clientIp } from './security';

export interface ApiResult<T> { status: number; data: T }

/** Headers that let the API trust the end user's IP and device id (it ignores them without the secret). */
export async function forwardHeaders(): Promise<Record<string, string>> {
  const h = await headers();
  const c = await cookies();
  const ip = clientIp(h);
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
  /** Staff only: whether this session has passed the second factor the staff tools need. */
  staffMfa: 'not_required' | 'verified' | 'needs_code' | 'needs_enrolment' | null;
  organizations: { id: string; kind: 'personal' | 'business'; name: string; handle: string; role: string; chatOnly: boolean; areaCode: string | null; businessEmail: string | null; closed: boolean; reservedName: boolean }[];
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

/** The market pack's public rules (`GET /v1/policies`) for the legal and help pages. */
export interface Policies {
  market: { id: string; name: string; illustrative: boolean; currency: string; locale: string };
  tax: { code: string; label: string; ratePercent: number };
  itemRules: { prohibited: { title: string; detail: string; examples?: string[] }[]; restricted: { title: string; detail: string; examples?: string[] }[] };
  prohibitedTerms: string[]; restrictedTerms: string[]; scamPhrases: string[];
  retention: { record: string; period: string; note?: string }[];
  privacy: { exportPerDay: number; exportLinkMinutes: number; deletedAccountDays: number; retainedAfterDeletion: string[] };
  safetyTips: string[];
  limits: { listingsPerNewAccountPerDay: number; chatsPerNewAccountPerDay: number; revealsPerUserPerDay: number };
  moderation: { reportThreshold: number; establishedSellerMinLiveDays: number; materialPriceChangePct: number };
  policy: { goneAfterDays: number; quoteRequestExpiryDays: number; reviewCooldownDays: number; priceFreshDays: number };
  categories: { slug: string; name: string; parent: string | null; minPhotos: number; listingPeriodDays: number; freeAllowance: { individual: number; business: number }; alwaysReviewed: boolean; priceUnits: string[] }[];
}
export const getPolicies = cache(async () => (await api<Policies>('/v1/policies')).data);
