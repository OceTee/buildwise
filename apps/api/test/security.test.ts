import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactUrl } from '../src/platform/log-redact.js';
import { secretEquals } from '../src/http/route.js';
import { harness } from './helpers.js';

/** Public-beta hardening (spec §19, §28): headers, sessions, client IPs, rate limits, health, log redaction. */
const CRON = 'c'.repeat(40);
let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness({ cronSecret: CRON, rateLimit: { perMinute: 100_000, browsePerMinute: 4, filesPerMinute: 3, healthPerMinute: 5 } });
});
afterAll(async () => { await h?.close(); });

const web = (ip: string, device?: string) => ({ 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': ip, ...(device ? { 'x-device-id': device } : {}) });

async function signInFrom(phone: string, headers: Record<string, string>, displayName = 'Device User') {
  const r = await h.ok(null, 'POST', '/v1/auth/otp/request', { phone }, headers);
  const v = await h.ok(null, 'POST', '/v1/auth/otp/verify', { phone, code: r.devCode, displayName }, headers);
  return v as { token: string; me: { id: string } };
}

describe('responses', () => {
  it('every API response refuses framing and script execution', async () => {
    const r = await h.call(null, 'GET', '/v1/market', undefined, web('10.50.0.1'));
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['strict-transport-security']).toBeUndefined(); // only on deployed (HTTPS) environments
  });
});

describe('health and cron', () => {
  it('the public health check says only that the API is up; the cron secret shows the configuration', async () => {
    const open = await h.ok(null, 'GET', '/health');
    expect(open).toEqual({ ok: true });
    const detail = await h.ok(null, 'GET', '/health', undefined, { authorization: `Bearer ${CRON}` });
    expect(detail.providers.sms).toBe('none');
    expect(detail.malwareScanner).toBe('dev');
    expect((await h.ok(null, 'GET', '/health', undefined, { authorization: 'Bearer wrong' })).providers).toBeUndefined();
  });

  it('the health check is rate limited', async () => {
    let last = 200;
    for (let i = 0; i < 8; i++) last = (await h.call(null, 'GET', '/health')).status;
    expect(last).toBe(429);
  });

  it('cron needs the exact secret', async () => {
    expect((await h.call(null, 'GET', '/v1/internal/cron')).status).toBe(401);
    expect((await h.call(null, 'GET', '/v1/internal/cron', undefined, { authorization: `Bearer ${CRON}x` })).status).toBe(401);
    expect(secretEquals(`Bearer ${CRON}`, `Bearer ${CRON}`)).toBe(true);
    expect(secretEquals(undefined, CRON)).toBe(false);
    expect(secretEquals('', '')).toBe(false);
  });
});

describe('sessions', () => {
  it('signing in again from the same browser revokes that browser\'s earlier session', async () => {
    const headers = web('10.50.1.1', 'samebrowser0001');
    const first = await signInFrom('+2348091110001', headers);
    const second = await signInFrom('+2348091110001', headers);
    expect(second.me.id).toBe(first.me.id);
    expect((await h.call(first.token, 'GET', '/v1/me')).status).toBe(401);
    expect((await h.call(second.token, 'GET', '/v1/me')).status).toBe(200);
    // Another browser's session is untouched.
    const other = await signInFrom('+2348091110001', web('10.50.1.2', 'otherbrowser001'));
    expect((await h.call(second.token, 'GET', '/v1/me')).status).toBe(200);
    expect((await h.call(other.token, 'GET', '/v1/me')).status).toBe(200);
  });

  it('a session unused for 14 days stops working', async () => {
    const u = await h.signIn('Idle Ida');
    expect((await h.call(u.token, 'GET', '/v1/me')).status).toBe(200);
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update sessions set last_seen_at = now() - interval '15 days' where user_id = $1`, [u.id]));
    expect((await h.call(u.token, 'GET', '/v1/me')).status).toBe(401);
  });

  it('use keeps a session alive (last use is recorded)', async () => {
    const u = await h.signIn('Busy Bo');
    await h.services.db.tx({ kind: 'system' }, (sql) => sql.query(`update sessions set last_seen_at = now() - interval '13 days' where user_id = $1`, [u.id]));
    expect((await h.call(u.token, 'GET', '/v1/me')).status).toBe(200);
    const r = await h.services.db.tx({ kind: 'system' }, (sql) => sql.query<{ recent: boolean }>(`select last_seen_at > now() - interval '1 minute' as recent from sessions where user_id = $1`, [u.id]));
    expect(r.rows[0]!.recent).toBe(true);
  });

  it('a signed-in browser can still request and verify a code for another number', async () => {
    const u = await h.signIn('Already In');
    const r = await h.ok(u.token, 'POST', '/v1/auth/otp/request', { phone: '+2348091110009' }, web('10.50.1.9'));
    const v = await h.ok(u.token, 'POST', '/v1/auth/otp/verify', { phone: '+2348091110009', code: r.devCode, displayName: 'Second Person' }, web('10.50.1.9'));
    expect(v.token).toBeTruthy();
    expect(v.me.id).not.toBe(u.id);
  });
});

describe('client addresses and rate limits', () => {
  it('x-forwarded-for from a client does not choose the rate-limit bucket', async () => {
    // browsePerMinute is 4 in this harness: spoofing a new address on each call must not reset the count.
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await h.call(null, 'GET', '/v1/search?q=cement', undefined, { 'x-forwarded-for': `203.0.113.${i}`, 'x-client-ip': `203.0.113.${i}` })).status);
    expect(statuses.slice(0, 4).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('search and listing pages have their own per-IP limit, counted per forwarded visitor', async () => {
    const a = web('10.60.0.1'); const b = web('10.60.0.2');
    const hits = async (headers: Record<string, string>, n: number) => { let s = 0; for (let i = 0; i < n; i++) s = (await h.call(null, 'GET', '/v1/search?q=sand', undefined, headers)).status; return s; };
    expect(await hits(a, 5)).toBe(429);
    expect(await hits(b, 1)).toBe(200);
    expect((await h.call(null, 'GET', '/v1/public/sellers/nobody-here', undefined, a)).status).toBe(429);
  });

  it('signed file links and uploads are rate limited', async () => {
    const ip = web('10.70.0.1');
    const files: number[] = [];
    for (let i = 0; i < 4; i++) files.push((await h.call(null, 'GET', `/v1/files/not-a-token-${i}`, undefined, ip)).status);
    expect(files.slice(0, 3)).toEqual([404, 404, 404]);
    expect(files[3]).toBe(429);
    const up = web('10.70.0.2');
    const uploads: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await h.app.inject({ method: 'PUT', url: `/v1/uploads/not-a-token-${i}`, payload: Buffer.from('x'), headers: { ...up, 'content-type': 'application/octet-stream' } });
      uploads.push(r.statusCode);
    }
    expect(uploads.slice(0, 3)).toEqual([403, 403, 403]);
    expect(uploads[3]).toBe(429);
  });
});

describe('log redaction', () => {
  it('signed links, checkout references, phone numbers and emails never reach request logs', () => {
    expect(redactUrl('/v1/files/eyJhbGciOi.abc?download=1')).toBe('/v1/files/[token]?download=1');
    expect(redactUrl('/v1/uploads/abc.def')).toBe('/v1/uploads/[token]');
    expect(redactUrl('/v1/checkout/chk_123/refresh')).toBe('/v1/checkout/[ref]/refresh');
    expect(redactUrl('/v1/dev/checkout/chk_1/success')).toBe('/v1/dev/checkout/[ref]/success');
    expect(redactUrl('/v1/search?q=call+08012345678&page=2')).toBe('/v1/search?q=call+[phone]&page=2');
    expect(redactUrl('/v1/x?email=a%40b.com&token=t')).toBe('/v1/x?email=[redacted]&token=[redacted]');
    // '+' is valid in an email's local part, so the words before it go too: over-redaction is the safe side.
    expect(redactUrl('/v1/x?note=write+to+a.b%40example.com')).toBe('/v1/x?note=[email]');
    const id = '/v1/listings/0190a3b2-1234-7abc-8def-012345678901';
    expect(redactUrl(id)).toBe(id);
  });
});
