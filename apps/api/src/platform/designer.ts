/**
 * The AI designer: a model that composes the massing and room layout of a building as structured JSON.
 * Gemini through Google's Interactions API (POST /v1beta/interactions, `response_format` JSON schema, the answer in
 * the `model_output` step's text, `store: false`); it can also look at a snapshot of its design (the critique). Injectable fetch for tests; the key is never logged.
 */

export interface DesignerInput { system: string; prompt: string; schema: Record<string, unknown>; maxOutputTokens?: number }
/** An image of the design for the designer to look at (a 3D snapshot), with the same JSON schema for its answer. */
export interface CritiqueInput extends DesignerInput { image: { mediaType: 'image/png' | 'image/jpeg'; data: string } }
export interface DesignerProvider {
  live: boolean;
  model: string;
  engineGeometry?: boolean;
  /** The parsed JSON answer, or null when the model failed, declined or was cut short. */
  compose(input: DesignerInput): Promise<unknown | null>;
  /** Looks at a picture of its design and answers in the schema (only models that can see images). */
  critique?(input: CritiqueInput): Promise<unknown | null>;
}

export const noDesigner: DesignerProvider = { live: false, model: 'engine', compose: async () => null };

export interface GeminiDesignerSettings {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  warn?: (m: string) => void;
  transport?: 'interactions' | 'generateContent';
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

/**
 * Gemini refuses schemas whose constraints make "too many states"; numeric and array limits are the usual cause.
 * They are dropped here (BuildWise checks the layout anyway); enums and required fields stay.
 */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema as Record<string, unknown>)
    .filter(([k]) => !['minimum', 'maximum', 'minItems', 'maxItems'].includes(k))
    .map(([k, v]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, d]) => [p, geminiSchema(d)])) : geminiSchema(v)]));
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
  const once = async (model: string, { system, prompt, schema, maxOutputTokens }: DesignerInput, image?: CritiqueInput['image']): Promise<{ value: unknown } | 'next' | null> => {
    const content = cfg.transport === 'generateContent';
    let res: Response;
    try {
      res = await fetchImpl(content ? `${base}/models/${encodeURIComponent(model)}:generateContent` : `${base}/interactions`, {
        method: 'POST',
        headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(content ? {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }, ...(image ? [{ inlineData: { mimeType: image.mediaType, data: image.data } }] : [])] }],
          generationConfig: { maxOutputTokens: maxOutputTokens ?? 12_000, responseMimeType: 'application/json', responseJsonSchema: geminiSchema(schema) },
        } : {
          model,
          system_instruction: system,
          // With a picture (the critique): the prompt and the image as content parts; Gemini can see.
          input: image ? [{ type: 'text', text: prompt }, { type: 'image', data: image.data, mime_type: image.mediaType }] : prompt,
          store: false,
          generation_config: { thinking_level: 'medium', max_output_tokens: maxOutputTokens ?? 60_000 },
          response_format: { type: 'text', mime_type: 'application/json', schema: geminiSchema(schema) },
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
      const status = body?.error?.status ?? body?.error?.code;
      const code = typeof status === 'string' ? status.slice(0, 40) : 'unknown';
      warn(`gemini designer: ${model} HTTP ${res.status} (${code})`);
      return RETRY_NEXT.has(res.status) ? 'next' : null;
    }
    if (body?.status && body.status !== 'completed') { warn(`gemini designer: ${model} status ${String(body.status).slice(0, 30)}`); return 'next'; }
    const candidate = body?.candidates?.[0];
    const text = content
      ? candidate?.finishReason === 'STOP' ? candidate.content?.parts?.filter((part: { thought?: boolean }) => !part.thought).map((part: { text?: string }) => part.text ?? '').join('') : null
      : interactionText(body);
    if (!text) { warn(`gemini designer: ${model} gave no text`); return 'next'; }
    try { return { value: JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, '')) }; } catch { warn(`gemini designer: ${model} answer is not JSON`); return 'next'; }
  };
  const run = async (input: DesignerInput, image?: CritiqueInput['image']) => {
    for (const m of models) {
      const r = await once(m, input, image);
      if (r === null) return null;
      if (r !== 'next') return r.value;
    }
    return null;
  };
  return {
    live: true,
    model: models.join(','),
    compose: (input) => run(input),
    critique: (input) => run(input, input.image),
  };
}


// ---------------------------------------------------------------- Claude as the designer

/**
 * Claude's structured output takes JSON Schema without numeric or length limits, and every object closed
 * (`additionalProperties: false`). The same schema the other designers use, adjusted; the limits are still checked
 * by BuildWise when the layout comes back.
 */
export function claudeSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(claudeSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'multipleOf'].includes(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, d]) => [p, claudeSchema(d)])) : claudeSchema(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

/** The text of a Claude answer, parsed as JSON (null when it declined or was cut short). */
function claudeJson(msg: { stop_reason: string | null; content: { type: string; text?: string }[] }, warn: (m: string) => void): unknown | null {
  if (msg.stop_reason === 'refusal') {
    // Keep what the API says about the refusal (category, which model) so false positives can be traced.
    const details = (msg as { stop_details?: unknown }).stop_details;
    warn(`claude designer: declined${details ? ` ${JSON.stringify(details).slice(0, 300)}` : ''}`);
    return null;
  }
  if (msg.stop_reason === 'max_tokens') { warn('claude designer: answer cut short'); return null; }
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  try { return JSON.parse(text); } catch { warn('claude designer: answer is not JSON'); return null; }
}

/** Claude (Opus) composes the building as structured JSON, and can look at a 3D snapshot of it and revise it. */
export async function createClaudeDesigner(cfg: { apiKey: string; model: string; warn?: (m: string) => void }): Promise<DesignerProvider> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: cfg.apiKey, timeout: 600_000, maxRetries: 1 });
  const warn = cfg.warn ?? ((m: string) => console.warn(m));
  const run = async (system: string, content: unknown[], schema: Record<string, unknown>) => {
    // Long structured answers (a whole building): stream, and take the final message.
    const stream = client.beta.messages.stream({
      model: cfg.model,
      max_tokens: 128_000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: claudeSchema(schema) as Record<string, unknown> } },
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: content as never }],
    } as never);
    return claudeJson(await stream.finalMessage() as never, warn);
  };
  return {
    live: true,
    model: cfg.model,
    compose: ({ system, prompt, schema }) => run(system, [{ type: 'text', text: prompt }], schema),
    critique: ({ system, prompt, schema, image }) => run(system, [
      { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
      { type: 'text', text: prompt },
    ], schema),
  };
}

/** Tries each designer in turn (Claude first, a free model as the fallback): the first answer wins. */
export function chainDesigners(list: DesignerProvider[]): DesignerProvider {
  const live = list.filter((d) => d.live);
  if (!live.length) return noDesigner;
  const seers = live.filter((d) => d.critique);
  return {
    live: true,
    model: live.map((d) => d.model).join(' > '),
    async compose(input) {
      for (const d of live) {
        try { const r = await d.compose(input); if (r) return r; } catch (err) { console.warn(`designer ${d.model} failed: ${(err as Error)?.name ?? 'error'}`); }
      }
      return null;
    },
    // Every designer that can see, in order: one that fails or declines hands the picture to the next.
    ...(seers.length ? {
      critique: async (input: CritiqueInput) => {
        for (const d of seers) {
          try { const r = await d.critique!(input); if (r) return r; } catch (err) { console.warn(`designer ${d.model} critique failed: ${(err as Error)?.name ?? 'error'}`); }
        }
        return null;
      },
    } : {}),
  };
}
