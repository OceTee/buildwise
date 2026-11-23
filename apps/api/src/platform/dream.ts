import { z } from 'zod';
import type { Fetch } from './providers.js';
import { RENDER_SIZE, createOpenAiRender, isPng } from './render.js';

/**
 * "Dream renders": AI-painted photoreal impressions of a design, and Claude as the art director who checks each
 * picture against the 3D model of the real design so the image does not lie (storeys, roof form, wings).
 *
 * Image providers:
 * - Gemini image models ("Nano Banana") through Google's Interactions API (POST /v1beta/interactions with
 *   `response_format: { type: 'image', ... }`; the image is a base64 `image` content block in a `model_output` step).
 *   `model` may be a comma-separated chain that falls back on 429/5xx/timeouts, like the AI designer.
 * - OpenAI's Images API: edits (image-to-image from the 3D snapshot) or generations (text only).
 *
 * Injectable fetch for tests. Keys, prompts and images are never logged: warnings carry the model, HTTP status and
 * error code only.
 */

export type ImageMime = 'image/png' | 'image/jpeg';
export interface DreamImage { data: Buffer; mimeType: ImageMime }
export interface DreamInput {
  prompt: string;
  /** The 3D snapshot of the real design (PNG). When present the model edits it instead of painting from text only. */
  image?: DreamImage;
}
export interface DreamProvider {
  kind: 'gemini' | 'openai' | 'none';
  model: string;
  /** The painted image, or null when every model declined, failed or was busy. */
  dream(input: DreamInput): Promise<DreamImage | null>;
}

export const noDream: DreamProvider = { kind: 'none', model: 'none', dream: async () => null };

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
/** The real type of image bytes (never trust a declared mime type). */
export function imageMime(b: Buffer): ImageMime | null {
  if (isPng(b)) return 'image/png';
  if (b.length > JPEG_MAGIC.length && b.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) return 'image/jpeg';
  return null;
}

// ---------------------------------------------------------------- Gemini (Interactions API)

/** Image models as of 2026-11 (none has a free tier on AI Studio: free keys get HTTP 429 "limit: 0"). Best first. */
export const DEFAULT_GEMINI_DREAM_MODELS = 'gemini-nano-banana-2.1,gemini-3.1-flash-image,gemini-3.1-flash-lite-image';
/** Landscape, the shape of an architectural view. */
export const DREAM_ASPECT = '16:9';

export interface GeminiDreamSettings {
  apiKey: string;
  model: string;
  fetch?: Fetch;
  baseUrl?: string;
  timeoutMs?: number;
  warn?: (m: string) => void;
}

/**
 * The last image in the interaction's `model_output` steps (thought steps may hold draft images and are skipped),
 * else the `output_image` convenience field when present.
 */
export function interactionImage(body: unknown): DreamImage | null {
  type Block = { type?: string; data?: unknown };
  const b = body as { steps?: { type?: string; content?: Block[] }[]; output_image?: Block } | null;
  let data: string | null = null;
  for (const st of Array.isArray(b?.steps) ? b!.steps : []) {
    if (st?.type !== 'model_output' || !Array.isArray(st.content)) continue;
    for (const c of st.content) if (c?.type === 'image' && typeof c.data === 'string' && c.data) data = c.data;
  }
  if (!data && typeof b?.output_image?.data === 'string') data = b.output_image.data;
  if (!data) return null;
  const buf = Buffer.from(data, 'base64');
  const mimeType = imageMime(buf);
  return mimeType ? { data: buf, mimeType } : null;
}

/** Busy or failing models: try the next one in the chain. */
const RETRY_NEXT = new Set([429, 500, 502, 503, 504]);

export function createGeminiDream(cfg: GeminiDreamSettings): DreamProvider {
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const warn = cfg.warn ?? ((m: string) => console.warn(m));
  const models = (cfg.model || DEFAULT_GEMINI_DREAM_MODELS).split(',').map((m) => m.trim()).filter(Boolean);
  const once = async (model: string, { prompt, image }: DreamInput): Promise<DreamImage | 'next' | null> => {
    const input = [
      ...(image ? [{ type: 'image', mime_type: image.mimeType, data: image.data.toString('base64') }] : []),
      { type: 'text', text: prompt },
    ];
    let res: Response;
    try {
      res = await fetchImpl(`${base}/interactions`, {
        method: 'POST',
        headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ model, input, response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: DREAM_ASPECT } }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 150_000),
      });
    } catch (err) {
      warn(`gemini dream: ${model} request failed (${(err as Error)?.name ?? 'error'})`);
      return 'next';
    }
    const raw = await res.text().catch(() => '');
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 40) : 'unknown';
      warn(`gemini dream: ${model} HTTP ${res.status} (${code})`);
      return RETRY_NEXT.has(res.status) ? 'next' : null;
    }
    if (body?.status && body.status !== 'completed') { warn(`gemini dream: ${model} status ${String(body.status).slice(0, 30)}`); return 'next'; }
    const out = interactionImage(body);
    if (!out) { warn(`gemini dream: ${model} gave no PNG or JPEG image`); return 'next'; }
    return out;
  };
  return {
    kind: 'gemini',
    model: models.join(','),
    async dream(input) {
      for (const m of models) {
        const r = await once(m, input);
        if (r === null) return null;
        if (r !== 'next') return r;
      }
      return null;
    },
  };
}

// ---------------------------------------------------------------- OpenAI (Images API)

export interface OpenAiDreamSettings { apiKey: string; model?: string; fetch?: Fetch; baseUrl?: string; timeoutMs?: number; warn?: (m: string) => void }

/**
 * OpenAI images: with a snapshot, the existing photoreal render path (POST /v1/images/edits); without one,
 * POST /v1/images/generations (JSON; GPT image models answer with base64 in `data[0].b64_json`).
 */
export function createOpenAiDream(cfg: OpenAiDreamSettings): DreamProvider {
  const model = cfg.model || 'gpt-image-1.5';
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const base = (cfg.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const warn = cfg.warn ?? ((m: string) => console.warn(m));
  const edits = createOpenAiRender({ ...cfg, model, warn: (m) => warn(m.replace('openai render', 'openai dream')) });
  return {
    kind: 'openai',
    model,
    async dream({ prompt, image }) {
      if (image) {
        if (image.mimeType !== 'image/png') return null;
        const out = await edits.render({ png: image.data, prompt });
        return out ? { data: out.png, mimeType: 'image/png' } : null;
      }
      let res: Response;
      try {
        res = await fetchImpl(`${base}/images/generations`, {
          method: 'POST',
          headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, prompt, n: 1, size: RENDER_SIZE, quality: 'medium', output_format: 'png' }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 150_000),
        });
      } catch (err) {
        warn(`openai dream: request failed (${(err as Error)?.name ?? 'error'})`);
        return null;
      }
      const text = await res.text().catch(() => '');
      let body: any = null;
      try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
      if (!res.ok) {
        const code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 40) : 'unknown';
        warn(`openai dream: HTTP ${res.status} (${code})`);
        return null;
      }
      const b64 = body?.data?.[0]?.b64_json;
      if (typeof b64 !== 'string' || !b64) { warn('openai dream: no image in the response'); return null; }
      const data = Buffer.from(b64, 'base64');
      const mimeType = imageMime(data);
      if (!mimeType) { warn('openai dream: the response is not a PNG or JPEG'); return null; }
      return { data, mimeType };
    },
  };
}

// ---------------------------------------------------------------- Claude as the checker

/** The facts of the real design the picture must match. */
export interface DreamFacts { type: string; style: string; storeys: number; roof: string; blocks: number; summary?: string }
export interface CheckInput { generated: DreamImage; snapshot: DreamImage; facts: DreamFacts; view: string }
export interface CheckResult { consistent: boolean; issues: string[]; promptFix: string }
export interface CheckerProvider { live: boolean; model: string; check(input: CheckInput): Promise<CheckResult | null> }

export const noChecker: CheckerProvider = { live: false, model: 'none', check: async () => null };

// Structured output does not enforce lengths, so the schema only describes them; the reply is trimmed after parsing.
const CheckOutput = z.object({
  consistent: z.boolean().describe('True when the painting shows the same building as the 3D model: same number of storeys, same roof form, same wings or blocks and the same overall footprint shape. Materials, colours, landscaping, sky and small details do not matter.'),
  issues: z.array(z.string().describe('One short sentence, under 20 words.')).describe('Up to five concrete differences between the painting and the 3D model, most important first. Empty when consistent.'),
  promptFix: z.string().describe('One or two sentences to add to the image prompt so the next painting fixes the differences, e.g. "Show exactly two storeys; the roof is a single hipped roof, not a flat one." Empty when consistent.'),
});

const CHECKER_SYSTEM = `You are an architect acting as art director for a building-design service. An image model painted a photorealistic impression of a planned building. You are shown two images: first the 3D massing model of the real design (the truth), then the AI painting. You are also given the facts of the design.

Decide whether the painting would mislead the client about the building they are planning. Compare what matters: the number of storeys, the roof form (hip, gable, flat, mono-pitch and so on), the number and arrangement of wings or blocks (including any separate outbuilding), the overall footprint shape and proportions, and the broad pattern of windows and doors. The camera viewpoint may differ from the model's. Ignore materials, colours, landscaping, sky, furniture, lighting and small details: those are artistic licence.

Be strict about storeys, roof form and wings; be lenient about everything else. Write short, plain sentences.`;

const clip = (t: string, n: number) => { const x = t.trim().replace(/\s+/g, ' '); return x.length <= n ? x : `${x.slice(0, n - 1).replace(/\s+\S*$/, '')}…`; };

/** Anthropic's Claude comparing the painting with the 3D model. Structured output: a valid verdict or nothing. */
export async function createClaudeChecker(cfg: { apiKey: string; model: string }): Promise<CheckerProvider> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const { betaZodOutputFormat } = await import('@anthropic-ai/sdk/helpers/beta/zod');
  const client = new Anthropic({ apiKey: cfg.apiKey, timeout: 90_000, maxRetries: 1 });
  return {
    live: true,
    model: cfg.model,
    async check({ generated, snapshot, facts, view }) {
      const img = (i: DreamImage) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: i.mimeType, data: i.data.toString('base64') } });
      const res = await client.beta.messages.parse({
        model: cfg.model,
        max_tokens: 4000,
        // On a policy decline the API retries on a fallback model in the same call.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: betaZodOutputFormat(CheckOutput) },
        system: CHECKER_SYSTEM,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Image 1: the 3D massing model of the real design.' },
            img(snapshot),
            { type: 'text', text: `Image 2: the AI painting (requested view: ${view}).` },
            img(generated),
            { type: 'text', text: `Facts of the design:\n${JSON.stringify(facts)}\n\nDoes the painting show this building?` },
          ],
        }],
      });
      if (res.stop_reason === 'refusal' || !res.parsed_output) return null;
      const out = res.parsed_output;
      return {
        consistent: out.consistent,
        issues: out.issues.map((x) => clip(x, 160)).filter(Boolean).slice(0, 5),
        promptFix: clip(out.promptFix, 400),
      };
    },
  };
}
