import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DESIGN_ENGINE_VERSION, aiLayoutSchema, designFromLayout, designerBrief, distinctDesigns, isHouse, normaliseBrief, planningAnalysis, requiredRooms, underlitRooms, validPlot,
  type AiLayout, type DesignBrief, type RuledKind,
} from '@bw/domain';
import { CRITIQUE_INSTRUCTIONS, DESIGNER_PROMPT_VERSION, DESIGNER_SYSTEM_PROMPT } from '../ai/designer-prompt.js';
import { one } from '../db/database.js';
import { clientOf, type Services } from '../http/route.js';
import { ApiError, badRequest, sha256 } from '../platform/platform.js';
import { reviewPlanningSources } from './build-sources.js';
import { DIRECTION_PROMPT, DIRECTION_PROMPT_VERSION, DIRECTION_SCHEMA, prepareDirections, prepareIdeas, realiseDirections } from '../ai/concept-directions.js';
import { recordAiOutcome } from './ops.js';

/**
 * The AI designer (POST /v1/build/design). The model composes the massing and room layout; BuildWise turns each
 * option into a full design with its own pipeline and checks it (setbacks, coverage, tiling, room sizes, stairs,
 * lifts, light). Options that fail go back to the model once with the list of problems. Only layouts that pass are
 * returned (and cached); otherwise the answer is `source: 'engine'` and the browser uses BuildWise's own designs.
 *
 * Registered without route(): the model can take minutes, and that must not hold a database transaction open.
 */
const plotSchema = z.object({ widthM: z.number(), depthM: z.number() });
const body = z.object({
  plot: plotSchema.optional(),
  brief: z.record(z.string(), z.unknown()),
  location: z.string().trim().max(80).regex(/^[\p{L}\p{M} ,.'-]*$/u).optional(),
  preferences: z.object({
    purpose: z.enum(['family', 'tenants', 'both', 'own', 'community', 'exploring']).nullable().optional(),
    taste: z.enum(['simple', 'modern', 'tropical', 'grand']).nullable().optional(),
    priorities: z.array(z.enum(['garden', 'privacy', 'host'])).max(3).optional(),
    plotUnknown: z.boolean().optional(),
    budgetMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    finish: z.enum(['basic', 'standard', 'premium']).optional(),
  }).optional(),
  /** The set of concepts asked for: a new seed draws new houses from the same ideas. */
  seed: z.number().int().min(0).max(999_999_999).optional(),
});
const CACHE_DAYS = 30;
const MAX_REPAIRS = 1;

function promptFor(s: Services, plot: { widthM: number; depthM: number }, brief: DesignBrief,
  preferences?: z.infer<typeof body>['preferences'],
  planningSources?: Awaited<ReturnType<typeof reviewPlanningSources>>) {
  const req = requiredRooms(brief, s.pack.design);
  const tall = brief.storeys >= 4;
  const floors = tall ? req.floors.slice(0, 2) : req.floors;
  const kinds = [...new Set(req.floors.flatMap((f) => f.rooms.map((r) => r.kind)))].filter((k) => k !== 'stair' && k !== 'lift' && k !== 'corridor') as RuledKind[];
  const minimums = Object.fromEntries(kinds.map((k) => [k, { minAreaM2: s.pack.design.rooms[k].minM2, minWidthM: s.pack.design.rooms[k].minDimM }]));
  return JSON.stringify({
    ...(preferences ? { preferences } : {}),
    ...(planningSources ? { planningSources } : {}),
    site: designerBrief(plot, brief, s.pack.design),
    programme: { note: tall ? `Ground floor and one typical upper floor; floors 2 to ${brief.storeys - 1} repeat floor 1.` : 'Rooms per floor (areas are targets; arrange them freely, merge or split where it helps).', corridorWidthM: req.corridorM || undefined, floors },
    minimumRoomSizes: minimums,
    stair: { minWidthM: s.pack.design.stair.minWidthM, minLengthM: s.pack.design.stair.minRunM },
    minCorridorWidthM: s.pack.design.minCorridorM,
  });
}

/** Problems first, as a short numbered list the model can act on. */
const problemList = (ps: string[]) => ps.slice(0, 14).map((p, i) => `${i + 1}. ${p}`).join('\n');

export function registerAiDesign(app: FastifyInstance, s: Services) {
  app.post('/v1/build/design', async (req, reply) => {
    const client = clientOf(req, s);
    const wait = await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute);
    if (wait) { reply.header('retry-after', String(wait)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
    const parsed = body.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the form.', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'body', message: i.message })));
    const plot = parsed.data.plot ?? { widthM: 20, depthM: 34 };
    if (!validPlot(plot)) throw badRequest('INVALID_PLOT', 'Enter a plot between 6 m and 200 m on each side.');
    const brief = normaliseBrief(parsed.data.brief as Partial<DesignBrief>);
    const preferences = parsed.data.plot ? parsed.data.preferences : { ...parsed.data.preferences, plotUnknown: true };
    const conceptSite = { plot, preliminary: preferences?.plotUnknown === true };
    reply.header('cache-control', 'private, no-store');
    const planningSources = await s.limiter.hit(`build-sources:${client.ip}`, 20)
        ? { geometry: 'unverified' as const, scope: 'global' as const, sourceStatus: 'unavailable' as const }
        : await reviewPlanningSources(undefined, { type: brief.type, taste: preferences?.taste });
    const engine = (reason: 'not_connected' | 'busy' | 'unavailable' | 'unusable', problems?: string[]) => ({ source: 'engine' as const, reason, conceptSite, planningSources, ...(problems ? { problems: problems.slice(0, 8) } : {}) });
    if (!s.designer.live) return engine('not_connected');

    const guided = s.designer.engineGeometry && isHouse(brief.type);
    const composition = guided ? 'engine-guided' : 'model-geometry';
    const seed = parsed.data.seed ?? 0;
    const cacheKey = sha256(JSON.stringify({ p: guided ? DIRECTION_PROMPT_VERSION : DESIGNER_PROMPT_VERSION, v: DESIGN_ENGINE_VERSION, model: s.designer.model, market: s.pack.id, plot: { w: Math.round(plot.widthM * 100), d: Math.round(plot.depthM * 100) }, brief, preferences, planningSources, ...(guided ? { seed } : {}) }));
    const hit = await s.db.tx({ kind: 'system' }, (sql) => one<{ layouts: AiLayout[] }>(sql,
      `select layouts from ai_designs where cache_key = $1 and created_at > now() - make_interval(days => $2)`, [cacheKey, CACHE_DAYS]));
    if (hit) return { source: 'ai' as const, composition, model: s.designer.model, cached: true, layouts: hit.layouts, conceptSite, planningSources };

    if (await s.limiter.hit(`designer:${client.ip}`, s.config.designerLimits.perMinute)) return engine('busy');
    const used = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql,
      `insert into ai_usage (day, kind, n) values (current_date, 'designer', 1) on conflict (day, kind) do update set n = ai_usage.n + 1 returning n`));
    if ((used?.n ?? 0) > s.config.designerLimits.perDay) return engine('busy');

    const prompt = promptFor(s, plot, brief, preferences, planningSources);
    if (guided) {
      const viable = prepareDirections(plot, brief, s.pack.design);
      const ideas = prepareIdeas(plot, brief, s.pack.design, seed, { taste: preferences?.taste ?? null, priorities: preferences?.priorities ?? [], purpose: preferences?.purpose ?? null });
      if (!viable.length && !ideas.length) return engine('unusable');
      let answer: unknown;
      try {
        answer = await s.designer.compose({ system: DIRECTION_PROMPT, prompt: JSON.stringify({
          ...JSON.parse(prompt),
          availableIdeas: ideas.map(({ idea }) => ({ idea: idea.key, title: idea.title, story: idea.story, suits: idea.suits })),
          availableDirections: viable.map((entry) => entry.direction),
        }), schema: DIRECTION_SCHEMA, maxOutputTokens: 2_048 });
      } catch (err) {
        req.log.warn({ err: String(err) }, 'AI planning failed; using the engine');
      }
      await recordAiOutcome(s, 'designer', !!answer, answer ? undefined : 'no answer');
      if (!answer) return engine('unavailable');
      const layouts = realiseDirections(answer, viable, ideas).map((entry) => entry.layout);
      if (!layouts.length) return engine('unusable');
      await saveLayouts(s, cacheKey, layouts);
      return { source: 'ai' as const, composition, model: s.designer.model, cached: false, layouts, conceptSite, planningSources };
    }
    const check = (opts: unknown) => (Array.isArray((opts as { options?: unknown })?.options) ? (opts as { options: AiLayout[] }).options : [])
      .filter((o) => o && Array.isArray(o.blocks) && Array.isArray(o.rooms))
      .map((o, i) => {
        const id = `ai-${cacheKey.slice(0, 8)}-${i + 1}`;
        const original = designFromLayout(plot, brief, o, id, s.pack.design);
        if (!original.design?.checks.some((c) => c.code === 'daylight' && c.status === 'fail')) return original;
        const dark = new Set(underlitRooms(original.design, s.pack.design).map((room) => room.id));
        const rooms = original.layout.rooms.map((room, j) => dark.has(`r${j + 1}`)
          ? { ...room, glazing: 'full-height' as const } : room);
        const repaired = designFromLayout(plot, brief, { ...original.layout, rooms }, id, s.pack.design);
        return repaired.problems.length < original.problems.length ? repaired : original;
      });
    let answer: unknown = null;
    try {
      answer = await s.designer.compose({ system: DESIGNER_SYSTEM_PROMPT, prompt, schema: aiLayoutSchema(2) });
    } catch (err) {
      req.log.warn({ err: String(err) }, 'AI designer failed; using the engine');
    }
    await recordAiOutcome(s, 'designer', answer != null, answer != null ? undefined : 'no answer');
    let options = check(answer);
    if (!options.length) return engine('unavailable');
    let good = options.filter((o) => o.design && !o.problems.length);
    // One round of corrections: the model gets its best attempt back with BuildWise's list of problems.
    for (let round = 0; round < MAX_REPAIRS && !good.length; round++) {
      const best = [...options].sort((a, b) => a.problems.length - b.problems.length)[0]!;
      try {
        answer = await s.designer.compose({
          system: DESIGNER_SYSTEM_PROMPT,
          prompt: `${prompt}\n\nYour previous layout failed BuildWise's checks:\n${problemList(best.problems)}\n\nPrevious layout (JSON):\n${JSON.stringify(best.layout)}\n\nReturn corrected options that fix every problem while keeping the design idea.`,
          schema: aiLayoutSchema(2),
        });
      } catch (err) {
        req.log.warn({ err: String(err) }, 'AI designer repair failed');
        break;
      }
      const fixed = check(answer);
      if (fixed.length) options = fixed;
      good = options.filter((o) => o.design && !o.problems.length);
    }
    if (!good.length) return engine('unusable', [...options].sort((a, b) => a.problems.length - b.problems.length)[0]?.problems ?? []);
    const distinct: typeof good = [];
    for (const option of good) {
      if (distinct.every((other) => distinctDesigns(other.design!, option.design!))) distinct.push(option);
    }
    const layouts = distinct.map((o) => o.layout);
    await saveLayouts(s, cacheKey, layouts);
    return { source: 'ai' as const, composition, model: s.designer.model, cached: false, layouts, conceptSite, planningSources };
  });
}

async function saveLayouts(s: Services, cacheKey: string, layouts: AiLayout[]) {
  await s.db.tx({ kind: 'system' }, (sql) => sql.query(
      `insert into ai_designs (cache_key, model, layouts) values ($1, $2, $3::jsonb)
       on conflict (cache_key) do update set layouts = excluded.layouts, model = excluded.model, created_at = now()`,
      [cacheKey, s.designer.model, JSON.stringify(layouts)]));
}

const critiqueBody = body.extend({
  plot: plotSchema,
  layout: z.object({ name: z.string().max(80), idea: z.string().max(400), blocks: z.array(z.any()).max(8), rooms: z.array(z.any()).max(600) }).passthrough(),
  image: z.string().max(6 * 1024 * 1024).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/),
});

/** The layout schema with a review: what the designer changed after looking at its own design. */
function critiqueSchema() {
  const base = aiLayoutSchema(1) as { type: string; properties: Record<string, unknown>; required: string[] };
  return {
    ...base,
    properties: { ...base.properties, review: { type: 'object', properties: { notes: { type: 'array', items: { type: 'string' }, maxItems: 5 }, improved: { type: 'boolean' } }, required: ['notes', 'improved'] } },
    required: [...base.required, 'review'],
  };
}

/**
 * The designer looks at a 3D snapshot of its own design and refines it (POST /v1/build/critique). Only designers
 * that can see images do this (Claude). The revised layout is checked like any other; if it fails, the original stands.
 */
export function registerCritique(app: FastifyInstance, s: Services) {
  app.post('/v1/build/critique', { bodyLimit: 7 * 1024 * 1024 }, async (req, reply) => {
    const client = clientOf(req, s);
    const wait = await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute);
    if (wait) { reply.header('retry-after', String(wait)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
    const parsed = critiqueBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the form.', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'body', message: i.message })));
    const { plot, image } = parsed.data;
    if (!validPlot(plot)) throw badRequest('INVALID_PLOT', 'Enter a plot between 6 m and 200 m on each side.');
    const brief = normaliseBrief(parsed.data.brief as Partial<DesignBrief>);
    reply.header('cache-control', 'private, no-store');
    const none = (reason: 'not_connected' | 'busy' | 'unavailable') => ({ source: 'none' as const, reason });
    if (!s.designer.live || !s.designer.critique || (s.designer.engineGeometry && isHouse(brief.type))) return none('not_connected');
    if (await s.limiter.hit(`critique:${client.ip}`, s.config.designerLimits.perMinute)) return none('busy');
    const used = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql,
      `insert into ai_usage (day, kind, n) values (current_date, 'critique', 1) on conflict (day, kind) do update set n = ai_usage.n + 1 returning n`));
    if ((used?.n ?? 0) > s.config.designerLimits.perDay) return none('busy');

    const [, mediaType, data] = image.match(/^data:(image\/(?:png|jpeg));base64,(.+)$/)!;
    const before = designFromLayout(plot, brief, parsed.data.layout as unknown as AiLayout, 'ai-before', s.pack.design);
    const reading = before.design ? planningAnalysis(before.design.rooms) : null;
    const analysis = reading ? [
      `Planning score ${reading.score}.`,
      ...reading.good.slice(0, 6).map((r) => `Works: ${r.a} beside ${r.b} (${r.why}).`),
      ...reading.bad.slice(0, 6).map((r) => `Conflict: ${r.a} beside ${r.b} (${r.why}).`),
      ...before.problems.slice(0, 6).map((p) => `Problem: ${p}`),
    ].join('\n') : 'BuildWise could not read this layout.';
    const prompt = `${promptFor(s, plot, brief, parsed.data.preferences)}\n\n${CRITIQUE_INSTRUCTIONS}\n\nThe layout you composed (JSON):\n${JSON.stringify(parsed.data.layout)}\n\nBuildWise's reading of the plan:\n${analysis}`;
    let answer: unknown = null;
    try {
      answer = await s.designer.critique({ system: DESIGNER_SYSTEM_PROMPT, prompt, schema: critiqueSchema(), image: { mediaType: mediaType as 'image/png' | 'image/jpeg', data: data! } });
    } catch (err) {
      req.log.warn({ err: String(err) }, 'AI designer critique failed');
    }
    const a = answer as { options?: AiLayout[]; review?: { notes?: string[]; improved?: boolean } } | null;
    await recordAiOutcome(s, 'critique', !!a, a ? undefined : 'no answer');
    if (!a) return none('unavailable');
    const notes = (a.review?.notes ?? []).map((n) => String(n).slice(0, 240)).slice(0, 5);
    const option = a.options?.[0];
    if (!a.review?.improved || !option) return { source: 'ai' as const, improved: false, notes };
    const checked = designFromLayout(plot, brief, option, 'ai-critique', s.pack.design);
    if (!checked.design || checked.problems.length) return { source: 'ai' as const, improved: false, notes, problems: checked.problems.slice(0, 6) };
    return { source: 'ai' as const, improved: true, notes, layout: checked.layout };
  });
}
