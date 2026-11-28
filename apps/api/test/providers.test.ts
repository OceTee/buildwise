import { createHmac } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  ProviderError, createMemoryLimiter, createPaystack, createPostgresLimiter, createResendEmail, createTermiiSms, createTwilioSms, type Fetch,
} from '../src/platform/providers.js';
import { harness } from './helpers.js';

/** A fake fetch that records requests and answers from a script. */
function fakeFetch(answer: (url: string, init: RequestInit) => { status?: number; body?: unknown }) {
  const calls: { url: string; init: RequestInit; body: any }[] = [];
  const f = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const raw = typeof init.body === 'string' ? init.body : '';
    calls.push({ url, init, body: raw.startsWith('{') ? JSON.parse(raw) : raw });
    const a = answer(url, init);
    return new Response(a.body === undefined ? '' : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as Fetch;
  return { f, calls };
}

describe('message providers', () => {
  it('Twilio sends a form post with basic auth and picks a messaging service by its SID prefix', async () => {
    const { f, calls } = fakeFetch(() => ({ status: 201, body: { sid: 'SM1' } }));
    await createTwilioSms({ accountSid: 'AC123', authToken: 'tok', from: 'MG999' }, f).send('+2348011111111', 'hello', 'otp');
    expect(calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('To')).toBe('+2348011111111');
    expect(form.get('MessagingServiceSid')).toBe('MG999');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('AC123:tok').toString('base64')}`);
  });

  it('Termii sends codes on the DND route and other messages on the generic route', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { code: 'ok' } }));
    const sms = createTermiiSms({ apiKey: 'k', senderId: 'BuildWise', baseUrl: 'https://termii.example/' }, f);
    await sms.send('+2348011111111', 'code 123456', 'otp');
    await sms.send('+2348011111111', 'listing live', 'notification');
    expect(calls[0]!.url).toBe('https://termii.example/api/sms/send');
    expect(calls[0]!.body).toMatchObject({ to: '2348011111111', from: 'BuildWise', channel: 'dnd', type: 'plain' });
    expect(calls[1]!.body.channel).toBe('generic');
  });

  it('Resend sends plain-text email; provider failures raise without echoing secrets or content', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { id: 'em_1' } }));
    await createResendEmail({ apiKey: 're_secret', from: 'BuildWise <no-reply@example.test>' }, f).send('a@example.test', 'Your listing is live.', 'notification');
    expect(calls[0]!.body).toMatchObject({ to: ['a@example.test'], subject: 'BuildWise update', text: 'Your listing is live.' });

    const failing = fakeFetch(() => ({ status: 401, body: { message: 'bad key re_secret' } }));
    const err = await createResendEmail({ apiKey: 're_secret', from: 'x@example.test' }, failing.f).send('a@example.test', 'private text', 'otp').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(String(err.message)).not.toMatch(/re_secret|private text/);
  });
});

describe('Paystack adapter', () => {
  const key = 'sk_test_abc';
  const sign = (raw: string) => createHmac('sha512', key).update(raw).digest('hex');

  it('starts a checkout with the amount in minor units and returns the hosted URL', async () => {
    const { f, calls } = fakeFetch(() => ({ body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/abc' } } }));
    const r = await createPaystack({ secretKey: key }, f).start({ ref: 'chk_1', amountMinor: 1_075_000n, currency: 'NGN', email: 'a@example.test', returnUrl: 'https://web.example/checkout/chk_1', description: 'Top 7 days' });
    expect(r.url).toBe('https://checkout.paystack.com/abc');
    expect(calls[0]!.url).toBe('https://api.paystack.co/transaction/initialize');
    expect(calls[0]!.body).toMatchObject({ amount: '1075000', currency: 'NGN', reference: 'chk_1', callback_url: 'https://web.example/checkout/chk_1' });
  });

  it('accepts only correctly signed webhooks and maps charge.success', () => {
    const p = createPaystack({ secretKey: key }, fakeFetch(() => ({})).f);
    const raw = JSON.stringify({ event: 'charge.success', data: { id: 77, reference: 'chk_1', amount: 500, currency: 'NGN', status: 'success' } });
    expect(p.parseWebhook({ 'x-paystack-signature': sign(raw) }, raw)).toEqual({ id: 'paystack:77', type: 'checkout.completed', data: { ref: 'chk_1', amountMinor: '500', currency: 'NGN' } });
    expect(() => p.parseWebhook({ 'x-paystack-signature': createHmac('sha512', 'wrong').update(raw).digest('hex') }, raw)).toThrow();
    expect(() => p.parseWebhook({}, raw)).toThrow();
    const other = JSON.stringify({ event: 'transfer.success', data: {} });
    expect(p.parseWebhook({ 'x-paystack-signature': sign(other) }, other)).toBeNull();
  });

  it('a direct lookup produces the same event id as the webhook', async () => {
    const { f } = fakeFetch(() => ({ body: { status: true, data: { id: 77, reference: 'chk_1', amount: 500, currency: 'NGN', status: 'success' } } }));
    expect((await createPaystack({ secretKey: key }, f).lookup('chk_1'))?.id).toBe('paystack:77');
  });
});

describe('configuration guards', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });
  const base = { AUTH_SECRET: 'a'.repeat(40), INTERNAL_API_SECRET: 'b'.repeat(40), CHECKOUT_WEBHOOK_SECRET: 'c'.repeat(40), CRON_SECRET: 'd'.repeat(40), DATABASE_URL: 'postgres://x' };
  const clean = ['OTP_LIMIT_PER_HOUR', 'APP_ENV', 'RATE_LIMIT_STORE', 'EXPOSE_OTP', 'SMS_PROVIDER', 'PAYMENT_PROVIDER', 'EMAIL_PROVIDER', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'MALWARE_SCANNER'];
  const env = (extra: Record<string, string>) => {
    process.env = { ...saved, ...base, NODE_ENV: 'production' };
    for (const k of clean) delete process.env[k];
    Object.assign(process.env, extra);
    return () => loadConfig();
  };
  const termii = { SMS_PROVIDER: 'termii', TERMII_API_KEY: 'k', TERMII_SENDER_ID: 'BW' };

  it('production refuses to start without SMS and payment providers, or with a test payment key', () => {
    expect(env({})).toThrow(/SMS provider/);
    expect(env(termii)).toThrow(/payment provider/);
    expect(env({ ...termii, PAYMENT_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: 'sk_test_1' })).toThrow(/live key/);
    // Until a real malware scanner is connected, production refuses to start at all.
    expect(env({ ...termii, PAYMENT_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: 'sk_live_1' })).toThrow(/MALWARE_SCANNER=dev/);
    const cfg = env({ ...termii, APP_ENV: 'staging', PAYMENT_PROVIDER: 'paystack', PAYSTACK_SECRET_KEY: 'sk_live_1' })();
    expect(cfg.rateLimitStore).toBe('postgres');
    expect(cfg.exposeOtp).toBe(false);
  });

  it('deployed environments need CRON_SECRET and refuse unknown scanners', () => {
    expect(env({ APP_ENV: 'staging', CRON_SECRET: '' })).toThrow(/CRON_SECRET/);
    expect(env({ APP_ENV: 'staging', MALWARE_SCANNER: 'magic' })).toThrow(/Unknown MALWARE_SCANNER/);
    expect(env({ APP_ENV: 'staging' })().malwareScanner).toBe('dev');
  });

  it('a selected provider must have all of its settings', () => {
    expect(env({ SMS_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'AC1' })).toThrow(/TWILIO_AUTH_TOKEN, TWILIO_FROM are not set/);
  });

  it('connecting an SMS provider stops sign-in codes from being shown, even on staging', () => {
    expect(env({ APP_ENV: 'staging' })().exposeOtp).toBe(true);
    expect(env({ APP_ENV: 'staging', ...termii })().exposeOtp).toBe(false);
  });
});

describe('rate limiting', () => {
  it('the memory limiter counts per key and reports the wait', async () => {
    const l = createMemoryLimiter();
    expect(await l.hit('ip:a', 2)).toBe(0);
    expect(await l.hit('ip:a', 2)).toBe(0);
    expect(await l.hit('ip:a', 2)).toBeGreaterThan(0);
    expect(await l.hit('ip:b', 2)).toBe(0);
  });
});

describe('paid promotion through a real provider (Paystack, faked at the network edge)', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  const key = 'sk_test_integration';
  let lookupAnswer: Record<string, unknown> = {};
  const paystack = fakeFetch((url) => url.includes('/transaction/initialize')
    ? { body: { status: true, data: { authorization_url: 'https://checkout.paystack.com/xyz' } } }
    : { body: { status: true, data: lookupAnswer } });

  beforeAll(async () => {
    vi.stubGlobal('fetch', paystack.f);
    h = await harness({ providers: { sms: { kind: 'none' }, email: { kind: 'none' }, payments: { kind: 'paystack', secretKey: key }, architect: { kind: 'none' }, builder: { kind: 'none' }, render: { kind: 'none' }, designer: { kind: 'none' }, dream: { kind: 'none' }, receiptEmailDomain: 'receipts.example.test' } });
  });
  afterAll(async () => { vi.unstubAllGlobals(); await h?.close(); });

  it('sends the buyer to Paystack, and the webhook and the return lookup apply the payment exactly once', async () => {
    const mod = await h.signIn('Mod P', { staff: 'moderator' });
    const seller = await h.veteranBusiness(await h.signIn('Seller P'), 'Paystack Supplies');
    const l = await h.liveListing(seller, mod);
    const p = await h.ok(seller.token, 'POST', '/v1/promotions', { listingId: l.id, productCode: 'top-7' });
    expect(p.checkoutUrl).toBe('https://checkout.paystack.com/xyz');
    const init = paystack.calls.find((c) => c.url.endsWith('/transaction/initialize'))!;
    expect(init.body).toMatchObject({ reference: p.checkoutRef, amount: p.gross.amountMinor, email: `u-${seller.id}@receipts.example.test` });

    const page = await h.ok(null, 'GET', `/v1/checkout/${p.checkoutRef}`);
    expect(page.devProvider).toBe(false);
    expect((await h.call(null, 'POST', `/v1/dev/checkout/${p.checkoutRef}/pay`)).status).toBe(404);

    // The buyer comes back before the webhook: the lookup says it is still pending.
    lookupAnswer = { id: 9001, reference: p.checkoutRef, amount: Number(p.gross.amountMinor), currency: p.gross.currency, status: 'ongoing' };
    expect((await h.ok(null, 'POST', `/v1/checkout/${p.checkoutRef}/refresh`, {})).outcome).toBe('pending');

    // A forged webhook is refused; the real one activates the promotion.
    const raw = JSON.stringify({ event: 'charge.success', data: { ...lookupAnswer, status: 'success' } });
    const forged = await h.app.inject({ method: 'POST', url: '/v1/webhooks/paystack', payload: raw, headers: { 'content-type': 'application/json', 'x-paystack-signature': 'f'.repeat(128) } });
    expect(forged.statusCode).toBe(401);
    const real = await h.app.inject({ method: 'POST', url: '/v1/webhooks/paystack', payload: raw, headers: { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', key).update(raw).digest('hex') } });
    expect(real.json().outcome).toBe('activated');
    expect((await h.app.inject({ method: 'POST', url: '/v1/webhooks/paystack', payload: raw, headers: { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', key).update(raw).digest('hex') } })).json().outcome).toBe('duplicate');

    // Returning afterwards changes nothing.
    lookupAnswer = { ...lookupAnswer, status: 'success' };
    expect((await h.ok(null, 'POST', `/v1/checkout/${p.checkoutRef}/refresh`, {})).outcome).toBe('unchanged');
    const mine = await h.ok(seller.token, 'GET', '/v1/my/promotions');
    expect(mine.items.filter((x: any) => x.listingId === l.id && x.status === 'active')).toHaveLength(1);
  });

  it('a signed-in buyer back from Paystack gets the payment applied by the return lookup (row-level security does not block it)', async () => {
    const mod = await h.signIn('Mod Q', { staff: 'moderator' });
    const seller = await h.veteranBusiness(await h.signIn('Seller Q'), 'Return Lookup Supplies');
    const l = await h.liveListing(seller, mod);
    const p = await h.ok(seller.token, 'POST', '/v1/promotions', { listingId: l.id, productCode: 'top-7' });
    // The browser is still signed in when it comes back, so the web proxy sends the session token with both calls.
    const page = await h.ok(seller.token, 'GET', `/v1/checkout/${p.checkoutRef}`);
    expect(page.status).toBe('pending_payment');
    lookupAnswer = { id: 9002, reference: p.checkoutRef, amount: Number(p.gross.amountMinor), currency: p.gross.currency, status: 'success' };
    const r = await h.ok(seller.token, 'POST', `/v1/checkout/${p.checkoutRef}/refresh`, {});
    expect(r).toMatchObject({ status: 'active', outcome: 'activated' });
    // Exactly one invoice, and the webhook arriving later is a duplicate.
    const fees = await h.services.db.tx({ kind: 'system' }, (sql) => sql.query<{ n: number }>(`select count(*)::int as n from platform_fees f join promotion_purchases p on p.id = f.purchase_id where p.checkout_ref = $1`, [p.checkoutRef]));
    expect(fees.rows[0]!.n).toBe(1);
    const raw = JSON.stringify({ event: 'charge.success', data: lookupAnswer });
    const late = await h.app.inject({ method: 'POST', url: '/v1/webhooks/paystack', payload: raw, headers: { 'content-type': 'application/json', 'x-paystack-signature': createHmac('sha512', key).update(raw).digest('hex') } });
    expect(late.json().outcome).toBe('duplicate');
    // Another signed-in user with the reference sees the same public checkout page an anonymous visitor does.
    const other = await h.signIn('Someone Else Q');
    expect((await h.ok(other.token, 'GET', `/v1/checkout/${p.checkoutRef}`)).status).toBe('active');
  });

  it('the shared Postgres limiter counts across calls', async () => {
    const lim = createPostgresLimiter(h.services.db);
    const k = `test:${Math.random()}`;
    expect(await lim.hit(k, 2)).toBe(0);
    expect(await lim.hit(k, 2)).toBe(0);
    const wait = await lim.hit(k, 2);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
  });
});

describe('a deployed environment without a payment provider', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeAll(async () => { h = await harness({ env: 'staging' }); });
  afterAll(async () => { await h?.close(); });

  it('closes paid visibility and has no development checkout that could mark a promotion paid', async () => {
    const mod = await h.signIn('Mod S', { staff: 'moderator' });
    const seller = await h.veteranBusiness(await h.signIn('Seller S'), 'Staging Supplies');
    const l = await h.liveListing(seller, mod);
    const res = await h.call(seller.token, 'POST', '/v1/promotions', { listingId: l.id, productCode: 'top-7' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENTS_UNAVAILABLE');
    expect((await h.call(null, 'POST', '/v1/dev/checkout/chk_000000000000000000000000/pay')).status).toBe(404);
  });
});
