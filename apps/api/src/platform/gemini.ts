/**
 * Gemini as BuildWise's brain on Google's free tier, through the Interactions API (POST /v1beta/interactions):
 *
 *  - the Builder AI conversation (a tool loop over BuildWise's own calculators and design engine);
 *  - the AI architect (ranks the engine's designs and writes the concept, as structured JSON);
 *  - the live brain behind the assistant: reads the person's first message (intent, plot, brief) and replies, while
 *    BuildWise's own small model is the instant fallback and learns from every Gemini reading (see modules/assistant).
 *
 * Every request is stateless (`store: false`): the conversation is sent each time, so Google keeps nothing for later
 * retrieval, and BuildWise redacts phone numbers and emails before anything is sent. `model` is a comma-separated
 * chain, best first: free-tier capacity varies by model and hour, so a busy (429/5xx), timed-out or failed model
 * hands over to the next. Within one tool loop the model that answered first is kept (its steps carry signatures).
 * Injectable fetch for tests; the key is never logged.
 */
import { z } from 'zod';
import { ASSISTANT_INTENTS, BUILDING_TYPE_KEYS, normaliseBrief, validPlot, type AssistantIntent, type DesignBrief } from '@bw/domain';
import { PERSONA } from '../ai/persona.js';
import { geminiSchema, interactionText } from './designer.js';
import { ARCHITECT_SYSTEM, ArchitectOutput, architectMessage, toArchitectReview, type ArchitectProvider, type BuilderProvider } from './providers.js';

export interface GeminiSettings {
  apiKey: string;
  /** One model or a comma-separated chain, best first. */
  model: string;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  timeoutMs?: number;
  warn?: (m: string) => void;
}


const RETRY_NEXT = new Set([429, 500, 502, 503, 504]);

type Step = { type?: string; [k: string]: unknown };
export interface Interaction { model: string; status: string; steps: Step[]; body: unknown }

/**
 * One stateless interaction on the first model in the chain that answers (or on `only`, the model a tool loop is
 * already using). Null when every model failed or declined.
 */
export async function interact(cfg: GeminiSettings, label: string, request: Record<string, unknown>, only?: string): Promise<Interaction | null> {
  const fetchImpl = cfg.fetch ?? globalThis.fetch;
  const base = (cfg.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  const warn = cfg.warn ?? ((m: string) => console.warn(m));
  const models = only ? [only] : cfg.model.split(',').map((m) => m.trim()).filter(Boolean);
  for (const model of models) {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/interactions`, {
        method: 'POST',
        headers: { 'x-goog-api-key': cfg.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({ model, store: false, ...request }),
        signal: AbortSignal.timeout(cfg.timeoutMs ?? 90_000),
      });
    } catch (err) {
      warn(`gemini ${label}: ${model} request failed (${(err as Error)?.name ?? 'error'})`);
      continue;
    }
    const raw = await res.text().catch(() => '');
    let body: any = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const code = typeof body?.error?.code === 'string' ? body.error.code.slice(0, 40) : typeof body?.error?.status === 'string' ? body.error.status.slice(0, 40) : 'unknown';
      warn(`gemini ${label}: ${model} HTTP ${res.status} (${code})`);
      if (RETRY_NEXT.has(res.status)) continue;
      return null;
    }
    const status = typeof body?.status === 'string' ? body.status : 'completed';
    if (status !== 'completed' && status !== 'requires_action') { warn(`gemini ${label}: ${model} status ${status.slice(0, 30)}`); continue; }
    return { model: typeof body?.model === 'string' ? body.model : model, status, steps: Array.isArray(body?.steps) ? body.steps : [], body };
  }
  return null;
}

/** Function declarations take a JSON Schema subset: limits and open-ended objects are described, not enforced. */
function toolSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toolSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(geminiSchema(schema) as Record<string, unknown>)
    .filter(([k]) => k !== 'additionalProperties')
    .map(([k, v]) => [k, k === 'properties' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([p, d]) => [p, toolSchema(d)])) : toolSchema(v)]));
}

const text = (t: string) => [{ type: 'text', text: t }];
/** Chat replies in the only formatting the app shows: paragraphs, "- " lists and **bold** (headings become bold lines). */
export function tidyReply(t: string): string {
  return t.split('\n').map((l) => l
    .replace(/^(\s*)[*•]\s+/, '$1- ')
    .replace(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/, (_m, h: string) => `**${h.replace(/\*\*/g, '')}**`))
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
const jsonOf = (s: string | null): unknown => { if (!s) return null; try { return JSON.parse(s.replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { return null; } };

// ---------------------------------------------------------------- the Builder AI conversation

/**
 * Gemini as the Builder AI: the same tool loop as Claude's. The model asks for a calculator or the design engine,
 * BuildWise computes, the model explains. The persona leads the system instruction so the voice stays BuildWise's.
 */
export function createGeminiBuilder(cfg: GeminiSettings): BuilderProvider {
  return {
    live: true,
    model: cfg.model,
    async chat(input) {
      const tools = input.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: toolSchema(t.input_schema) }));
      const steps: Step[] = [
        ...input.history.map((t) => ({ type: t.role === 'user' ? 'user_input' : 'model_output', content: text(t.text) })),
        { type: 'user_input', content: text(input.message) },
      ];
      let calls = 0;
      let model: string | undefined;
      for (let round = 0; round < (input.maxSteps ?? 5); round++) {
        const res = await interact(cfg, 'builder', {
          system_instruction: `${PERSONA}\n\n${input.system}`,
          input: steps,
          tools,
          generation_config: { thinking_level: 'low', max_output_tokens: 8000 },
        }, model);
        if (!res) return null;
        model = res.model;
        const out = res.steps.filter((s) => s.type !== 'user_input' && s.type !== 'function_result');
        const fcalls = out.filter((s) => s.type === 'function_call') as { type: string; id: string; name: string; arguments: unknown }[];
        if (!fcalls.length) {
          const answer = tidyReply(interactionText(res.body) ?? '');
          return answer ? { text: answer, stopReason: res.status, toolCalls: calls, model: res.model } : null;
        }
        // Replay the model's steps unchanged (thoughts and calls carry signatures), then the results.
        steps.push(...out);
        for (const c of fcalls) {
          calls++;
          let result: unknown; let failed = false;
          try { result = await input.runTool(c.name, c.arguments ?? {}); } catch (err) { result = { error: String(err).slice(0, 300) }; failed = true; }
          steps.push({ type: 'function_result', call_id: c.id, name: c.name, result: text(JSON.stringify(result)), ...(failed ? { is_error: true } : {}) });
        }
      }
      return null; // too many tool rounds: fall back rather than loop
    },
  };
}

// ---------------------------------------------------------------- the AI architect

/** Gemini as the AI architect: the same brief and output as Claude's, as JSON checked against the same schema. */
export function createGeminiArchitect(cfg: GeminiSettings): ArchitectProvider {
  const schema = geminiSchema(z.toJSONSchema(ArchitectOutput));
  return {
    live: true,
    model: cfg.model,
    async review(input) {
      const res = await interact(cfg, 'architect', {
        system_instruction: `${PERSONA}\n\n${ARCHITECT_SYSTEM}`,
        input: architectMessage(input),
        generation_config: { thinking_level: 'medium', max_output_tokens: 16000 },
        response_format: { type: 'text', mime_type: 'application/json', schema },
      });
      const parsed = ArchitectOutput.safeParse(jsonOf(res ? interactionText(res.body) : null));
      return parsed.success ? toArchitectReview(parsed.data) : null;
    },
  };
}

// ---------------------------------------------------------------- the live brain behind the assistant

/** What the brain reads from one message. Only known brief fields survive validation. */
export interface BrainReading { intent: AssistantIntent; reply: string; plot: { widthM: number; depthM: number } | null; brief: Partial<DesignBrief>; model: string }
export interface BrainInput {
  /** Already redacted. */
  message: string;
  state: { plot: { widthM: number; depthM: number } | null; brief: Partial<DesignBrief> };
  /** BuildWise's own reading, a hint (the brain may correct it). */
  local: { intent: AssistantIntent; plot: { widthM: number; depthM: number } | null; brief: Partial<DesignBrief> };
}
export interface BrainProvider { live: boolean; model: string; read(input: BrainInput): Promise<BrainReading | null> }

export const noBrain: BrainProvider = { live: false, model: 'local', read: async () => null };

const BRIEF_FIELDS = ['type', 'storeys', 'units', 'bedrooms', 'bathrooms', 'ensuite', 'kitchen', 'study', 'guestWc', 'store', 'parking', 'style', 'roof', 'bq', 'features'] as const;

export const BrainOutput = z.object({
  intent: z.enum(ASSISTANT_INTENTS as [AssistantIntent, ...AssistantIntent[]]),
  reply: z.string().describe('What BuildWise says back: one to three short sentences.'),
  plotWidthM: z.number().describe('Plot width (frontage) in metres if the message gives a plot size, else 0.'),
  plotDepthM: z.number().describe('Plot depth in metres if the message gives a plot size, else 0.'),
  brief: z.object({
    type: z.enum(BUILDING_TYPE_KEYS as [string, ...string[]]).optional(),
    storeys: z.number().int().optional(),
    units: z.number().int().optional().describe('Flats, shops, guest rooms or classrooms per floor; seats for halls and worship; m² for warehouses.'),
    bedrooms: z.number().int().optional(),
    bathrooms: z.number().int().optional(),
    ensuite: z.boolean().optional(),
    kitchen: z.enum(['open', 'closed']).optional(),
    study: z.boolean().optional(),
    guestWc: z.boolean().optional(),
    store: z.boolean().optional(),
    parking: z.number().int().optional(),
    style: z.enum(['modern', 'tropical', 'classic']).optional(),
    roof: z.enum(['hip', 'gable', 'flat', 'hidden', 'shed', 'butterfly', 'dutch-gable', 'mansard']).optional(),
    bq: z.boolean().optional(),
    features: z.array(z.string()).optional(),
  }).describe('Only what the person actually said or clearly implied, for buildings BuildWise designs; leave the rest out.'),
});

/** Gemini reads the message the way BuildWise's assistant does, but with a model's understanding of language. */
export function createGeminiBrain(cfg: GeminiSettings, system: string): BrainProvider {
  const schema = geminiSchema(z.toJSONSchema(BrainOutput));
  return {
    live: true,
    model: cfg.model,
    async read(input) {
      const res = await interact(cfg, 'brain', {
        system_instruction: `${PERSONA}\n\n${system}`,
        input: `<state>${JSON.stringify(input.state)}</state>\n<local_reading>${JSON.stringify(input.local)}</local_reading>\n<message>${input.message}</message>`,
        generation_config: { thinking_level: 'low', max_output_tokens: 2000 },
        response_format: { type: 'text', mime_type: 'application/json', schema },
      });
      if (!res) return null;
      const parsed = BrainOutput.safeParse(jsonOf(interactionText(res.body)));
      if (!parsed.success) { (cfg.warn ?? console.warn)('gemini brain: answer did not match the schema'); return null; }
      const o = parsed.data;
      const plot = o.plotWidthM > 0 && o.plotDepthM > 0 && validPlot({ widthM: o.plotWidthM, depthM: o.plotDepthM }) ? { widthM: o.plotWidthM, depthM: o.plotDepthM } : null;
      // Keep only the fields the person gave, each normalised to a value the design engine accepts.
      const given = Object.fromEntries(Object.entries(o.brief).filter(([k, v]) => (BRIEF_FIELDS as readonly string[]).includes(k) && v !== undefined && v !== null)) as Partial<DesignBrief>;
      const n = normaliseBrief(given);
      const brief = Object.fromEntries(Object.keys(given).map((k) => [k, n[k as keyof DesignBrief]])) as Partial<DesignBrief>;
      const reply = o.reply.trim().replace(/\s+/g, ' ').slice(0, 600);
      if (!reply) return null;
      return { intent: o.intent, reply, plot: o.intent === 'build_home' ? plot : null, brief: o.intent === 'build_home' ? brief : {}, model: res.model };
    },
  };
}
