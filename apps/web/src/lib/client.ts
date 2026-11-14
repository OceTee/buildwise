'use client';

export class ApiFailure extends Error {
  constructor(public status: number, public code: string, message: string, public fieldErrors: { path: string; message: string }[] = [], public details?: any) { super(message); }
}

/** Browser calls go to the web server's /api/v1 proxy, which adds the session from the httpOnly cookie. */
export async function call<T = any>(path: string, init: { method?: string; body?: unknown; raw?: Blob | File; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  let body: BodyInit | undefined;
  if (init.raw) { headers['content-type'] = init.raw.type || 'application/octet-stream'; body = init.raw; }
  else if (init.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(init.body); }
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  const res = await fetch(`/api${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = data?.error ?? {};
    throw new ApiFailure(res.status, e.code ?? 'ERROR', e.message ?? 'Something went wrong. Try again.', e.fieldErrors ?? [], e.details);
  }
  return data as T;
}

export const errorText = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong. Check your connection and try again.');
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
