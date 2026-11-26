/** Server-side settings. The browser never sees the API address or the internal secret. */
export const API_URL = process.env.API_URL ?? 'http://localhost:4000';
export const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? 'dev-only-internal-secret';
const apiPreviewSecret = process.env.API_PREVIEW_AUTH_SECRET;
/** Server-to-server authentication for a protected API preview. */
export const API_ACCESS_HEADERS: Record<string, string> = apiPreviewSecret
  ? { 'x-vercel-protection-bypass': apiPreviewSecret }
  : {};
export const SITE_URL = (process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const SESSION_COOKIE = 'bw_session';
export const DEVICE_COOKIE = 'bw_device';
export const SECURE_COOKIES = process.env.NODE_ENV === 'production';
