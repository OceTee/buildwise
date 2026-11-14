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

/**
 * Sends a file to an upload target from the API. Relative targets are the development upload endpoint behind the
 * web proxy; absolute targets are presigned storage URLs. Reports progress for large drawings.
 */
export async function uploadFile(target: { method: 'PUT'; url: string; complete?: string | null }, file: File, onProgress?: (pct: number) => void): Promise<{ duplicateOf: string | null }> {
  const sent = await sendFile(target, file, onProgress);
  // Tell the API the bytes arrived (needed after a direct upload to storage; harmless otherwise).
  if (target.complete) {
    const done = await call<{ duplicateOf: string | null }>(target.complete, { method: 'POST' });
    return { duplicateOf: sent.duplicateOf ?? done.duplicateOf ?? null };
  }
  return sent;
}

function sendFile(target: { method: 'PUT'; url: string }, file: File, onProgress?: (pct: number) => void): Promise<{ duplicateOf: string | null }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(target.method, target.url.startsWith('/') ? `/api${target.url}` : target.url);
    xhr.setRequestHeader('content-type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let data: any = null; try { data = JSON.parse(xhr.responseText); } catch { /* storage providers return no body */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve({ duplicateOf: data?.duplicateOf ?? null });
      else reject(new ApiFailure(xhr.status, data?.error?.code ?? 'UPLOAD_FAILED', data?.error?.message ?? 'The upload failed. Try again.'));
    };
    xhr.onerror = () => reject(new ApiFailure(0, 'NETWORK', 'The upload was interrupted. Check your connection and try again.'));
    xhr.send(file);
  });
}

/**
 * Shrinks large photos in the browser before upload (longest side 2560 px, JPEG) so they stay well under
 * hosting request limits. The server re-encodes and strips metadata either way.
 */
export async function shrinkImage(file: File, maxSide = 2560, maxBytes = 3_500_000): Promise<File> {
  if (!file.type.startsWith('image/') || (file.size <= maxBytes && file.type !== 'image/heic')) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

export const errorText = (e: unknown) => (e instanceof ApiFailure ? e.message : 'Something went wrong. Check your connection and try again.');
export const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));
