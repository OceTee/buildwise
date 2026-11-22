/**
 * The AI designer: a model that composes the massing and room layout of a building as structured JSON.
 * Gemini through Google's Interactions API (POST /v1beta/interactions, `response_format` JSON schema, the answer in
 * the `model_output` step's text). Injectable fetch for tests; the key is never logged.
 */

export interface DesignerInput { system: string; prompt: string; schema: Record<string, unknown> }
export interface DesignerProvider {
  live: boolean;
  model: string;
  /** The parsed JSON answer, or null when the model failed, declined or was cut short. */
  compose(input: DesignerInput): Promise<unknown | null>;
}

export const noDesigner: DesignerProvider = { live: false, model: 'engine', compose: async () => null };

export interface GeminiDesignerSettings {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  warn?: (m: string) => void;
}

/** Text of the first model_output step (thought steps are skipped). */
export function interactionText(body: unknown): string | null {
  const steps = (body as { steps?: { type?: string; content?: { type?: string; text?: string }[] }[] })?.steps;
  if (!Array.isArray(steps)) return null;
  for (const st of steps) {
    if (st?.type !== 'model_output' || !Array.isArray(st.content)) continue;
    const text = st.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('');
    if (text) return text;
  }
  return null;
}

/** Busy or failing models: try the next one in the chain. */
const RETRY_NEXT = new Set([429, 500, 502, 503, 504]);

/**
 * `model` may be a comma-separated chain (best first): free-tier capacity varies by model and hour, so a model that
 * is busy (429/5xx), times out or stops short hands over to the next one.
 */
export function createGeminiDesigner(cfg: GeminiDesignerSettings): DesignerProvider {
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const warn = cfg.warn ?? ((m: string) => console.warn(m));
  const models = cfg.model.split(',').map((m) => m.trim()).filter(Boolean);
  const once = async (model: string, { system, prompt, schema }: DesignerInput): Promise<{ value: unknown } | 'next' | null> => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/interactions`, {
        method: 'POST',
        headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          system_instruction: system,
          input: prompt,
          generation_config: { thinking_level: 'medium', max_output_tokens: 60_000 },
          response_format: { type: 'text', mime_type: 'application/json', schema },
        }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 180_000),
      });
    } catch (err) {
      warn(`gemini designer: ${model} request failed (${(err as Error)?.name ?? 'error'})`);
      return 'next';
    }
    const raw = await res.text().catch(() => '');
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 40) : 'unknown';
      warn(`gemini designer: ${model} HTTP ${res.status} (${code})`);
      return RETRY_NEXT.has(res.status) ? 'next' : null;
    }
    if (body?.status && body.status !== 'completed') { warn(`gemini designer: ${model} status ${String(body.status).slice(0, 30)}`); return 'next'; }
    const text = interactionText(body);
    if (!text) { warn(`gemini designer: ${model} gave no text`); return 'next'; }
    try { return { value: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) }; } catch { warn(`gemini designer: ${model} answer is not JSON`); return 'next'; }
  };
  return {
    live: true,
    model: models.join(','),
    async compose(input) {
      for (const m of models) {
        const r = await once(m, input);
        if (r === null) return null;
        if (r !== 'next') return r.value;
      }
      return null;
    },
  };
}
