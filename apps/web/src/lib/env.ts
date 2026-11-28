/** Server-side settings. The browser never sees the API address or the internal secret. */
export const SITE_URL = (process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
/**
 * A deployed site (Vercel, or staging/production by APP_ENV, or a public https address) never runs on development
 * stand-ins: it needs its own INTERNAL_API_SECRET and Secure cookies.
 */
export const DEPLOYED = !!process.env.VERCEL || process.env.APP_ENV === 'staging' || process.env.APP_ENV === 'production'
  || (SITE_URL.startsWith('https://') && !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(SITE_URL));
export const API_URL = process.env.API_URL ?? 'http://localhost:4000';
/** Shared with the API so it trusts the forwarded client IP and device id. Deployed sites must set it (see assertServerEnv). */
export const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET || (DEPLOYED ? '' : 'dev-only-internal-secret');
const apiPreviewSecret = process.env.API_PREVIEW_AUTH_SECRET;
/** Server-to-server authentication for a protected API preview. */
export const API_ACCESS_HEADERS: Record<string, string> = apiPreviewSecret
  ? { 'x-vercel-protection-bypass': apiPreviewSecret }
  : {};
export const SESSION_COOKIE = 'bw_session';
export const DEVICE_COOKIE = 'bw_device';
/** The session cookie's absolute lifetime; the API also ends sessions unused for 14 days. */
export const SESSION_MAX_AGE_S = 30 * 86_400;

/** Refuses to start a deployed web server without the settings it must not fall back on. */
export function assertServerEnv() {
  if (!DEPLOYED) return;
  if (!process.env.INTERNAL_API_SECRET || process.env.INTERNAL_API_SECRET.includes('dev-only')) throw new Error('Set INTERNAL_API_SECRET: a deployed web server must not use the development secret');
  if (!process.env.API_URL) throw new Error('Set API_URL: a deployed web server cannot reach the API on localhost');
}
