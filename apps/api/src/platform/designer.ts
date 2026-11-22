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

export function createGeminiDesigner(cfg: GeminiDesignerSettings): DesignerProvider {
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const warn = cfg.warn ?? ((m: string) => console.warn(m));
  return {
    live: true,
    model: cfg.model,
    async compose({ system, prompt, schema }) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/interactions`, {
          method: 'POST',
          headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: cfg.model,
            system_instruction: system,
            input: prompt,
            generation_config: { thinking_level: 'medium', max_output_tokens: 60_000 },
            response_format: { type: 'text', mime_type: 'application/json', schema },
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs ?? 240_000),
        });
      } catch (err) {
        warn(`gemini designer: request failed (${(err as Error)?.name ?? 'error'})`);
        return null;
      }
      const raw = await res.text().catch(() => '');
      let body: any = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      if (!res.ok) {
        const code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 40) : 'unknown';
        warn(`gemini designer: HTTP ${res.status} (${code})`);
        return null;
      }
      if (body?.status && body.status !== 'completed') { warn(`gemini designer: status ${String(body.status).slice(0, 30)}`); return null; }
      const text = interactionText(body);
      if (!text) { warn('gemini designer: no text in the answer'); return null; }
      try { return JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { warn('gemini designer: answer is not JSON'); return null; }
    },
  };
}
