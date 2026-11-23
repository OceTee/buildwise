import type { Fetch } from './providers.js';

/**
 * Photoreal render provider: turns a PNG snapshot of the browser's 3D model into a photorealistic exterior
 * impression with an image-generation model. Claude does not generate images, so this uses OpenAI's Images API.
 * Null output means the model declined or failed; the caller answers with a friendly fallback. The API key is
 * never logged, nor the prompt or the image.
 */
export interface RenderInput { png: Buffer; prompt: string }
export interface RenderProvider { kind: 'openai' | 'none'; render(input: RenderInput): Promise<{ png: Buffer } | null> }

export const noRender: RenderProvider = { kind: 'none', render: async () => null };

export const DEFAULT_RENDER_MODEL = 'gpt-image-1.5';
/** Landscape output, the shape of an architectural exterior view. */
export const RENDER_SIZE = '1536x1024';

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const isPng = (b: Buffer) => b.length > PNG_MAGIC.length && b.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC);

export interface OpenAiRenderSettings {
  apiKey: string;
  model?: string;
  fetch?: Fetch;
  baseUrl?: string;
  timeoutMs?: number;
  /** Short warnings (HTTP status and error code only). */
  warn?: (message: string) => void;
}

/**
 * OpenAI Images "create image edit" (POST /v1/images/edits, multipart/form-data) with the snapshot as the input
 * image. GPT image models always answer with base64 (`data[0].b64_json`); `response_format` is not sent.
 */
export function createOpenAiRender(cfg: OpenAiRenderSettings): RenderProvider {
  const model = cfg.model || DEFAULT_RENDER_MODEL;
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const warn = cfg.warn ?? ((m: string) => console.warn(m));
  // High input fidelity keeps the snapshot's geometry; only the gpt-image-1 / 1.5 family accepts the parameter.
  const fidelity = model === 'gpt-image-1' || model.startsWith('gpt-image-1.5');
  return {
    kind: 'openai',
    async render({ png, prompt }) {
      const form = new FormData();
      form.append('model', model);
      form.append('image[]', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'model.png');
      form.append('prompt', prompt);
      form.append('n', '1');
      form.append('size', RENDER_SIZE);
      form.append('quality', 'medium');
      form.append('output_format', 'png');
      if (fidelity) form.append('input_fidelity', 'high');
      let res: Response;
      try {
        res = await fetchImpl(`${base}/images/edits`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}` },
          body: form,
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 150_000),
        });
      } catch (err) {
        warn(`openai render: request failed (${(err as Error)?.name ?? 'error'})`);
        return null;
      }
      const text = await res.text().catch(() => '');
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      if (!res.ok) {
        const code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 40) : 'unknown';
        warn(`openai render: HTTP ${res.status} (${code})`);
        return null;
      }
      const b64 = body?.data?.[0]?.b64_json;
      if (typeof b64 !== 'string' || !b64) { warn('openai render: no image in the response'); return null; }
      const out = Buffer.from(b64, 'base64');
      if (!isPng(out)) { warn('openai render: the response is not a PNG'); return null; }
      return { png: out };
    },
  };
}
