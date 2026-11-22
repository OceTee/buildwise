import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DESIGN_ENGINE_VERSION, aiLayoutSchema, designFromLayout, designerBrief, normaliseBrief, requiredRooms, validPlot,
  type AiLayout, type DesignBrief, type RuledKind,
} from '@bw/domain';
import { DESIGNER_PROMPT_VERSION, DESIGNER_SYSTEM_PROMPT } from '../ai/designer-prompt.js';
import { one } from '../db/database.js';
import { clientOf, type Services } from '../http/route.js';
import { ApiError, badRequest, sha256 } from '../platform/platform.js';

/**
 * The AI designer (POST /v1/build/design). The model composes the massing and room layout; BuildWise turns each
 * option into a full design with its own pipeline and checks it (setbacks, coverage, tiling, room sizes, stairs,
 * lifts, light). Options that fail go back to the model once with the list of problems. Only layouts that pass are
 * returned (and cached); otherwise the answer is `source: 'engine'` and the browser uses BuildWise's own designs.
 *
 * Registered without route(): the model can take minutes, and that must not hold a database transaction open.
 */
const body = z.object({
  plot: z.object({ widthM: z.number(), depthM: z.number() }),
  brief: z.record(z.string(), z.unknown()),
  location: z.string().trim().max(80).regex(/^[\p{L}\p{M} ,.'-]*$/u).optional(),
});
const CACHE_DAYS = 30;
const MAX_REPAIRS = 1;

function promptFor(s: Services, plot: { widthM: number; depthM: number }, brief: DesignBrief, location?: string) {
  const req = requiredRooms(brief, s.pack.design);
  const tall = brief.storeys >= 4;
  const floors = tall ? req.floors.slice(0, 2) : req.floors;
  const kinds = [...new Set(req.floors.flatMap((f) => f.rooms.map((r) => r.kind)))].filter((k) => k !== 'stair' && k !== 'lift' && k !== 'corridor') as RuledKind[];
  const minimums = Object.fromEntries(kinds.map((k) => [k, { minAreaM2: s.pack.design.rooms[k].minM2, minWidthM: s.pack.design.rooms[k].minDimM }]));
  return JSON.stringify({
    market: s.pack.name,
    ...(location ? { location } : {}),
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
    const { plot } = parsed.data;
    if (!validPlot(plot)) throw badRequest('INVALID_PLOT', 'Enter a plot between 6 m and 200 m on each side.');
    const brief = normaliseBrief(parsed.data.brief as Partial<DesignBrief>);
    const location = parsed.data.location || undefined;
    reply.header('cache-control', 'private, no-store');
    const engine = (reason: 'not_connected' | 'busy' | 'unavailable' | 'unusable', problems?: string[]) => ({ source: 'engine' as const, reason, ...(problems ? { problems: problems.slice(0, 8) } : {}) });
    if (!s.designer.live) return engine('not_connected');

    const cacheKey = sha256(JSON.stringify({ p: DESIGNER_PROMPT_VERSION, v: DESIGN_ENGINE_VERSION, model: s.designer.model, market: s.pack.id, plot: { w: Math.round(plot.widthM * 100), d: Math.round(plot.depthM * 100) }, brief, location }));
    const hit = await s.db.tx({ kind: 'system' }, (sql) => one<{ layouts: AiLayout[] }>(sql,
      `select layouts from ai_designs where cache_key = $1 and created_at > now() - make_interval(days => $2)`, [cacheKey, CACHE_DAYS]));
    if (hit) return { source: 'ai' as const, model: s.designer.model, cached: true, layouts: hit.layouts };

    if (await s.limiter.hit(`designer:${client.ip}`, s.config.designerLimits.perMinute)) return engine('busy');
    const used = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql,
      `insert into ai_usage (day, kind, n) values (current_date, 'designer', 1) on conflict (day, kind) do update set n = ai_usage.n + 1 returning n`));
    if ((used?.n ?? 0) > s.config.designerLimits.perDay) return engine('busy');

    const prompt = promptFor(s, plot, brief, location);
    const check = (opts: unknown) => (Array.isArray((opts as { options?: unknown })?.options) ? (opts as { options: AiLayout[] }).options : [])
      .filter((o) => o && Array.isArray(o.blocks) && Array.isArray(o.rooms))
      .map((o, i) => ({ raw: o, ...designFromLayout(plot, brief, o, `ai-${cacheKey.slice(0, 8)}-${i + 1}`, s.pack.design) }));
    let answer: unknown = null;
    try {
      answer = await s.designer.compose({ system: DESIGNER_SYSTEM_PROMPT, prompt, schema: aiLayoutSchema(2) });
    } catch (err) {
      req.log.warn({ err: String(err) }, 'AI designer failed; using the engine');
    }
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
    const layouts = good.map((o) => o.layout);
    await s.db.tx({ kind: 'system' }, (sql) => sql.query(
      `insert into ai_designs (cache_key, model, layouts) values ($1, $2, $3::jsonb)
       on conflict (cache_key) do update set layouts = excluded.layouts, model = excluded.model, created_at = now()`,
      [cacheKey, s.designer.model, JSON.stringify(layouts)]));
    return { source: 'ai' as const, model: s.designer.model, cached: false, layouts };
  });
}
