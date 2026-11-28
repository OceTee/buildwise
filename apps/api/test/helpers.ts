import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../src/app.js';
import { totp } from '../src/platform/totp.js';

export type Json = Record<string, any>;

export async function harness(over: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'bw-api-'));
  const { app, services } = await buildApp({ env: 'test', pgliteDir: null, storageDir: join(dir, 'objects'), outboxDir: join(dir, 'outbox'), rateLimit: { perMinute: 100_000, browsePerMinute: 100_000, filesPerMinute: 100_000, healthPerMinute: 100_000 }, ...over });
  let ipSeq = 0;

  async function call(token: string | null, method: string, url: string, payload?: unknown, headers: Json = {}) {
    const res = await app.inject({ method: method as 'GET', url, payload: payload as Json, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
    return { status: res.statusCode, body: res.body ? (res.headers['content-type']?.toString().includes('json') ? res.json() : res.body) : null, headers: res.headers };
  }
  async function ok(token: string | null, method: string, url: string, payload?: unknown, headers: Json = {}) {
    const r = await call(token, method, url, payload, headers);
    if (r.status >= 400) throw new Error(`${method} ${url} -> ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as Json;
  }

  let phoneSeq = 0;
  /** Signs in (or up) with a number and returns a fresh session token. */
  async function session(phone: string, name: string) {
    // Each sign-in comes from its own forwarded IP so the per-IP OTP limit does not interfere.
    const headers = { 'x-internal-secret': services.config.internalSecret, 'x-client-ip': `10.0.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}` };
    const r = await ok(null, 'POST', '/v1/auth/otp/request', { phone }, headers);
    const v = await ok(null, 'POST', '/v1/auth/otp/verify', { phone, code: r.devCode, displayName: name, confirmExisting: true }, headers);
    return v as Json;
  }

  /**
   * A new account. With `staff`, the role is set as the seed does, and (MFA being required in tests) the session
   * enrols an authenticator and enters a code, so it can use staff routes; `mfa: false` leaves that undone.
   */
  async function signIn(name: string, opts: { staff?: 'moderator' | 'ops_admin' | 'qs_reviewer'; mfa?: boolean } = {}) {
    phoneSeq += 1;
    const phone = `+23480${String(70000000 + phoneSeq).padStart(8, '0')}`;
    const v = await session(phone, name);
    let totpSecret: string | null = null;
    if (opts.staff) {
      await services.db.tx({ kind: 'system' }, (sql) => sql.query(`update users set is_staff = true, staff_role = $2 where id = $1`, [v.me.id, opts.staff]));
      if (services.config.staffMfa === 'required' && opts.mfa !== false) {
        const e = await ok(v.token, 'POST', '/v1/staff/mfa/enrol');
        totpSecret = e.secret as string;
        await ok(v.token, 'POST', '/v1/staff/mfa/verify', { code: totp(totpSecret) });
      }
    }
    return { token: v.token as string, id: v.me.id as string, orgId: v.me.organizations[0].id as string, phone, totpSecret };
  }

  /** Makes the account older than the new-account window and gives it a business org with the larger allowance. */
  async function veteranBusiness<U extends { token: string; id: string; orgId: string }>(u: U, name: string): Promise<U> {
    await services.db.tx({ kind: 'system' }, (sql) => sql.query(`update users set created_at = now() - interval '60 days' where id = $1`, [u.id]));
    const b = await ok(u.token, 'POST', '/v1/businesses', { name, email: 'sales@example.test', areaCode: 'hilltop' });
    u.orgId = b.id;
    return u;
  }

  let shade = 0;
  async function photo(token: string, orgId?: string) {
    shade += 37;
    const img = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r: shade % 255, g: (shade * 3) % 255, b: (shade * 7) % 255 } } })
      .composite([{ input: Buffer.from(`<svg width="640" height="480"><rect x="${shade % 300}" y="40" width="200" height="300" fill="white"/><circle cx="500" cy="${100 + (shade % 250)}" r="80" fill="black"/></svg>`), top: 0, left: 0 }])
      .png().toBuffer();
    const res = await app.inject({ method: 'POST', url: `/v1/photos${orgId ? `?orgId=${orgId}` : ''}`, payload: img, headers: { authorization: `Bearer ${token}`, 'content-type': 'image/png' } });
    if (res.statusCode >= 400) throw new Error(`photo -> ${res.statusCode} ${res.body}`);
    return res.json().id as string;
  }

  const cementBody = (photoIds: string[], over: Json = {}) => ({
    categorySlug: 'cement', title: 'Portland cement 42.5, 50 kg bags', description: 'Fresh stock with delivery.',
    attributes: { brand: 'Demo', grade: '42.5', pack_size: { value: 50, unit: 'kg' }, delivery_offered: true },
    price: '9500', unit: 'bag', areaCode: 'hilltop', photoIds, ...over,
  });

  /** Creates a listing, submits it and (if it lands in review) approves it with the given moderator. */
  async function liveListing(seller: { token: string; orgId: string }, moderator: { token: string }, over: Json = {}) {
    const l = await ok(seller.token, 'POST', '/v1/listings', cementBody([await photo(seller.token, seller.orgId)], { orgId: seller.orgId, ...over }));
    const sub = await ok(seller.token, 'POST', `/v1/listings/${l.id}/submit`, { expectedVersion: l.version });
    if (sub.listing.status === 'in_review') await ok(moderator.token, 'POST', `/v1/moderation/listings/${l.id}/decide`, { decision: 'approve', expectedVersion: sub.listing.version });
    return ok(seller.token, 'GET', `/v1/listings/${l.id}`);
  }

  return { app, services, call, ok, signIn, session, photo, cementBody, liveListing, veteranBusiness, close: () => app.close() };
}

/** A minimal PDF with `pages` A3-landscape pages. */
export function pdf(pages = 1, extra = '') {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objs = Array.from({ length: pages }, (_, i) => `${3 + i} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 1191 842]>>endobj`).join('\n');
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj\n${objs}\n${extra}trailer<</Root 1 0 R>>\n%%EOF`);
}
