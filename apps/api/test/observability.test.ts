import { describe, expect, it } from 'vitest';
import { createSentryTracker, runWithContext, scrubEvent, scrubText, userHashOf, type SentryLike } from '../src/platform/observability.js';

function fakeSdk() {
  const calls = { init: null as Record<string, any> | null, tags: {} as Record<string, string>, user: undefined as unknown, captured: [] as unknown[], flushed: 0 };
  const sdk: SentryLike = {
    init: (o) => { calls.init = o; },
    withScope: (fn) => fn({ setTag: (k, v) => { calls.tags[k] = v; }, setUser: (u) => { calls.user = u; } }),
    captureException: (e) => { calls.captured.push(e); },
    flush: async () => { calls.flushed += 1; return true; },
  };
  return { sdk, calls };
}

describe('error tracking', () => {
  it('loads the SDK only through the adapter and tags events with the correlation id, route and hashed user', async () => {
    const { sdk, calls } = fakeSdk();
    const t = await createSentryTracker({ dsn: 'https://key@o1.ingest.example/1', environment: 'staging', release: 'abc123' }, async () => sdk);
    expect(t.kind).toBe('sentry');
    expect(calls.init).toMatchObject({ dsn: 'https://key@o1.ingest.example/1', environment: 'staging', release: 'abc123', tracesSampleRate: 0 });
    expect(calls.init!.dataCollection).toMatchObject({ userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false, stackFrameVariables: false });
    const hash = userHashOf('secret', 'user-1');
    runWithContext({ correlationId: 'corr-1', route: '/v1/projects/:id', userHash: hash }, () => t.capture(new Error('x')));
    expect(calls.captured).toHaveLength(1);
    expect(calls.tags).toMatchObject({ correlation_id: 'corr-1', route: '/v1/projects/:id' });
    expect(calls.user).toEqual({ id: hash });
    t.capture(new Error('y'), { correlationId: 'worker-2', tags: { job: 'worker-cycle' } });
    expect(calls.tags).toMatchObject({ correlation_id: 'worker-2', job: 'worker-cycle' });
    await t.flush();
    expect(calls.flushed).toBe(1);
  });

  it('hashes user ids stably without revealing them', () => {
    expect(userHashOf('s', 'u1')).toMatch(/^[0-9a-f]{16}$/);
    expect(userHashOf('s', 'u1')).toBe(userHashOf('s', 'u1'));
    expect(userHashOf('s', 'u1')).not.toBe(userHashOf('s', 'u2'));
    expect(userHashOf('s', 'u1')).not.toBe(userHashOf('other', 'u1'));
  });
});

describe('PII scrubbing before events leave (beforeSend)', () => {
  const token = `${Buffer.from(JSON.stringify({ op: 'download', key: 'documents/abc', exp: 2_000_000_000 })).toString('base64url')}.${'A'.repeat(43)}`;

  it('scrubs phone numbers, emails, bearer, JWT and signed file tokens from text', () => {
    expect(scrubText('call +234 803 123 4567 or 08031234567, mail ada@example.com')).toBe('call [phone] or [phone], mail [email]');
    expect(scrubText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop')).toBe('Authorization: Bearer [redacted]');
    expect(scrubText('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop end')).toBe('jwt [jwt] end');
    expect(scrubText(`GET /v1/files/${token}?x=1`)).toBe('GET /v1/files/[token]?x=1');
    expect(scrubText(`token ${token} here`)).toBe('token [token] here');
    expect(scrubText('Quote 2 of 3 for 50 bags at 9500 on 2026-11-27')).toBe('Quote 2 of 3 for 50 bags at 9500 on 2026-11-27');
  });

  it('drops auth headers, cookies, query strings and the bodies of auth and chat routes', async () => {
    const { sdk, calls } = fakeSdk();
    await createSentryTracker({ dsn: 'https://k@x/1', environment: 'test' }, async () => sdk);
    const beforeSend = calls.init!.beforeSend as (e: Record<string, any>) => Record<string, any>;

    const auth = beforeSend({
      message: 'Sign-in failed for +2348031234567',
      request: { url: 'https://api.example/v1/auth/otp/verify?phone=%2B2348031234567', method: 'POST',
        headers: { authorization: 'Bearer abc', cookie: 'bw_session=abc', 'x-internal-secret': 's', 'x-client-ip': '1.2.3.4', 'content-type': 'application/json' },
        cookies: { bw_session: 'abc' }, query_string: 'phone=%2B2348031234567', data: { phone: '+2348031234567', code: '123456' } },
      user: { id: 'raw-user-id', email: 'ada@example.com', ip_address: '1.2.3.4' },
      exception: { values: [{ type: 'Error', value: 'No user ada@example.com' }] },
      breadcrumbs: [{ message: 'fetch /v1/files/' + token, data: { url: '/v1/uploads/' + token } }],
      extra: { phone: '+2348031234567', note: 'called 08031234567' },
    });
    expect(auth.message).toBe('Sign-in failed for [phone]');
    expect(auth.request.url).toBe('https://api.example/v1/auth/otp/verify');
    expect(auth.request.headers).toEqual({ authorization: '[redacted]', cookie: '[redacted]', 'x-internal-secret': '[redacted]', 'x-client-ip': '[redacted]', 'content-type': 'application/json' });
    expect(auth.request.cookies).toBeUndefined();
    expect(auth.request.query_string).toBeUndefined();
    expect(auth.request.data).toBeUndefined();
    expect(auth.user).toEqual({});
    expect(auth.exception.values[0].value).toBe('No user [email]');
    expect(auth.breadcrumbs[0]).toMatchObject({ message: 'fetch /v1/files/[token]', data: { url: '/v1/uploads/[token]' } });
    expect(auth.extra).toEqual({ phone: '[redacted]', note: 'called [phone]' });

    const chat = beforeSend({ request: { url: 'https://api.example/v1/build/chat', data: { message: 'my number is 08031234567' } } });
    expect(chat.request.data).toBeUndefined();
    for (const path of ['/v1/staff/mfa/verify', '/v1/moderation/staff/grants', '/v1/feedback', '/v1/me/export']) {
      expect(beforeSend({ request: { url: `https://api.example${path}`, data: { code: '123456', note: 'x' } } }).request.data).toBeUndefined();
    }

    const other = beforeSend({ request: { url: 'https://api.example/v1/listings', data: { title: 'Cement', description: 'Call 0803 123 4567', phone: '+2348031234567' } }, user: { id: 'abcdef0123456789' } });
    expect(other.request.data).toEqual({ title: 'Cement', description: 'Call [phone]', phone: '[redacted]' });
    expect(other.user).toEqual({ id: 'abcdef0123456789' });
  });

  it('is the same scrubber the website uses', () => {
    expect(scrubEvent({ message: 'ada@example.com' })).toEqual({ message: '[email]' });
  });
});
