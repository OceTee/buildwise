import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EDITABLE_KINDS, applyEdits, designDigest, generateDesigns, normaliseBrief, normaliseProject, planProject,
  projectChecks, projectFacts, redact, respond, uuidv7, validPlot,
  type Design, type DesignBrief, type DesignEdit, type ProjectRecord,
} from '@bw/domain';
import { BUILDER_PROMPT_VERSION, BUILDER_SYSTEM_PROMPT } from '../ai/builder-prompt.js';
import { one } from '../db/database.js';
import { clientOf, type Services } from '../http/route.js';
import { ApiError, badRequest } from '../platform/platform.js';
import type { BuilderTool } from '../platform/providers.js';
import { getBrain, sessionOf } from './assistant.js';

/**
 * The Builder AI conversation (POST /v1/build/chat). Every message goes to the connected model with the master
 * system prompt and a compact, numbers-only project context the server rebuilds itself (design from plot, brief and
 * edits; cooling, water, energy and budget from the calculators). The model answers questions, using our calculators
 * and the design engine as tools; it never changes the project (the person does that with the app's controls).
 * When no model is connected, over its limits or failing, BuildWise's local assistant answers instead.
 *
 * Registered without route(): the model can take a while, and that must not hold a database transaction open.
 */

const plotSchema = z.object({ widthM: z.number(), depthM: z.number() });
const side = z.enum(['front', 'rear', 'left', 'right']);
const editSchema: z.ZodType<DesignEdit> = z.union([
  z.object({ op: z.literal('move'), room: z.string().max(20), side, by: z.number().min(-50).max(50) }),
  z.object({ op: z.literal('split'), room: z.string().max(20), dir: z.enum(['v', 'h']), at: z.number().optional() }),
  z.object({ op: z.literal('merge'), room: z.string().max(20), with: z.string().max(20) }),
  z.object({ op: z.literal('rename'), room: z.string().max(20), name: z.string().max(40) }),
  z.object({ op: z.literal('use'), room: z.string().max(20), kind: z.enum(EDITABLE_KINDS as [string, ...string[]]) }),
]) as z.ZodType<DesignEdit>;

const chatBody = z.object({
  message: z.string().trim().min(1).max(2000),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(4000) })).max(12).default([]),
  step: z.string().max(20).optional(),
  plot: plotSchema.nullable().optional(),
  brief: z.record(z.string(), z.unknown()).optional(),
  designId: z.string().max(80).nullable().optional(),
  edits: z.array(editSchema).max(200).optional(),
  project: z.record(z.string(), z.unknown()).optional(),
});

const TOOLS: BuilderTool[] = [
  {
    name: 'calculate',
    description: 'Run one of BuildWise\'s deterministic planning calculators on the current project and return the result with its working, assumptions and warnings. Use it for every number about cooling (AC sizes, loads), water (demand, tanks, pump, heaters, septic), energy (daily kWh, peak kW, solar array, battery, inverter, generator) or budget (cost by item, total, range, gap, savings options). Overrides let you try a what-if without changing the project.',
    input_schema: {
      type: 'object',
      properties: {
        plan: { type: 'string', enum: ['cooling', 'water', 'energy', 'budget'] },
        overrides: {
          type: 'object',
          description: 'Optional what-if values: occupants, airConditioning, kitchenAc, borehole, hotWater, storageDays, solar (boolean), solarCover (essential|most|all), autonomyDays, budget (whole currency units), finish (basic|standard|premium), furniture (boolean).',
          additionalProperties: true,
        },
      },
      required: ['plan'],
    },
  },
  {
    name: 'generate_designs',
    description: 'Generate and check concept layouts with BuildWise\'s design engine for a plot and brief (defaults to the current ones), to compare alternatives such as another bedroom, two storeys or a different plot. Returns each design\'s name, floor area, coverage, rooms, rule checks and the engine\'s architect notes.',
    input_schema: {
      type: 'object',
      properties: {
        plot: { type: 'object', properties: { widthM: { type: 'number' }, depthM: { type: 'number' } } },
        brief: { type: 'object', description: 'Brief fields to change: type (bungalow|duplex|terrace|apartments|shops|office|mixed-use|warehouse|hotel|event-hall|school|clinic|worship), storeys (1-10 within the type\'s range), units (flats/shops/guest rooms/classrooms per floor, seats, or m² of storage, by type), features (gym, gaming, cinema, family-lounge, laundry, prayer, lift, conference, restaurant, canteen, library, lab, pharmacy, upper-offices), bedrooms, bathrooms, ensuite, kitchen (open|closed), study, guestWc, store, parking, roof, bq.', additionalProperties: true },
      },
    },
  },
];

interface Ctx { plot: { widthM: number; depthM: number } | null; brief: DesignBrief; design: Design | null; project: ProjectRecord; edits: DesignEdit[] }

/** All the plans for a project, from the calculators (shared with the browser). */
export function plansFor(s: Services, c: Ctx, o: Record<string, unknown> = {}) {
  return c.design ? planProject(c.design, c.project, s.pack.planning, o) : null;
}

/** The compact context the model sees with every message. */
function contextFor(s: Services, c: Ctx, step: string | undefined) {
  const plans = plansFor(s, c);
  const d = c.design;
  return {
    step: step ?? 'land',
    currency: s.pack.currency,
    market: s.pack.name,
    climate: s.pack.design.climate,
    plot: c.plot,
    brief: c.brief,
    facts: projectFacts(c.project, c.plot, c.brief, d).map((f) => `${f.label}: ${f.value} [${f.status}]`),
    lifestyle: c.project.lifestyle || undefined,
    design: d ? { ...designDigest(d), edits: d.edits, review: d.review.highlights } : null,
    systems: plans ? {
      cooling: { acUnits: plans.cooling.result.acUnits, acInputKw: plans.cooling.result.inputKw, kwhPerDay: plans.cooling.result.kwhPerDay },
      water: { litresPerDay: plans.water.result.demandLPerDay, storageL: plans.water.result.storageL, pumpHp: plans.water.result.pump?.hp ?? null, heaters: plans.water.result.heaters },
      energy: { dailyKwh: plans.energy.result.dailyKwh, peakKw: plans.energy.result.peakKw, solar: plans.energy.result.solar, generatorKva: plans.energy.result.generatorKva },
    } : null,
    budget: plans ? { totalMinor: plans.budget.result.totalMinor, rangeMinor: [plans.budget.result.lowMinor, plans.budget.result.highMinor], budgetMinor: plans.budget.result.budgetMinor, gapMinor: plans.budget.result.gapMinor, note: 'money in minor units (1/100 of the currency)' } : null,
    decisions: c.project.decisions.filter((x) => x.status !== 'superseded').map((x) => `${x.topic}: ${x.choice} [${x.status}]`),
    openQuestions: c.project.questions.filter((q) => !q.resolved).map((q) => q.question),
    issues: projectChecks(c.project, d, plans ?? {}).map((i) => `${i.level}: ${i.text}`),
  };
}

const compact = (x: unknown) => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v)));

export function registerBuilderAi(app: FastifyInstance, s: Services) {
  app.post('/v1/build/chat', async (req, reply) => {
    const client = clientOf(req, s);
    const wait = await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute);
    if (wait) { reply.header('retry-after', String(wait)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
    const parsed = chatBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the message.', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'body', message: i.message })));
    const b = parsed.data;
    reply.header('cache-control', 'private, no-store');

    const plot = b.plot && validPlot(b.plot) ? b.plot : null;
    const brief = normaliseBrief((b.brief ?? {}) as Partial<DesignBrief>);
    const project = normaliseProject(b.project as Partial<ProjectRecord>);
    let design: Design | null = null;
    if (plot) {
      const { designs } = generateDesigns(plot, brief, s.pack.design);
      const chosen = designs.find((x) => x.id === b.designId) ?? designs[0] ?? null;
      design = chosen ? applyEdits(chosen, b.edits ?? [], s.pack.design).design : null;
    }
    const ctx: Ctx = { plot, brief, design, project, edits: b.edits ?? [] };

    // BuildWise's own reading of the message: a hint for the model, the fallback reply, and a learning signal.
    const message = redact(b.message);
    const messageId = uuidv7();
    const local = await s.db.tx({ kind: 'system' }, async (sql) => {
      const brain = await getBrain(s, sql);
      const r = respond(brain, b.message, { plot, brief });
      await sql.query(`insert into assistant_messages (id, session, text, intent, confidence, knowledge_id, unanswered) values ($1, $2, $3, $4, $5, $6, $7)`,
        [messageId, sessionOf(s, client), message, r.intent, r.confidence, r.knowledgeId, r.unanswered]);
      return r;
    });
    const fallback = (reason: string) => ({ source: 'local' as const, reason, messageId, intent: local.intent, reply: local.reply, promptVersion: BUILDER_PROMPT_VERSION });
    if (!s.builder.live) return fallback('not_connected');
    if (await s.limiter.hit(`builder:${client.ip}`, s.config.builderLimits.perMinute)) return fallback('busy');
    const used = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql,
      `insert into ai_usage (day, kind, n) values (current_date, 'builder', 1) on conflict (day, kind) do update set n = ai_usage.n + 1 returning n`));
    if ((used?.n ?? 0) > s.config.builderLimits.perDay) return fallback('busy');

    const runTool = async (name: string, input: unknown) => {
      const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
      if (name === 'calculate') {
        const plans = plansFor(s, ctx, (args.overrides as Record<string, unknown>) ?? {});
        if (!plans) return { error: 'No plot or design yet: ask for the plot size first.' };
        const plan = plans[args.plan as keyof typeof plans];
        if (!plan) return { error: 'plan must be cooling, water, energy or budget' };
        return compact({ ...plan, currency: s.pack.currency, note: args.plan === 'budget' ? 'money in minor units (1/100 of the currency)' : undefined });
      }
      if (name === 'generate_designs') {
        const p = args.plot && validPlot(args.plot as { widthM: number; depthM: number }) ? (args.plot as { widthM: number; depthM: number }) : plot;
        if (!p) return { error: 'No plot size yet.' };
        const r = generateDesigns(p, normaliseBrief({ ...brief, ...((args.brief as Partial<DesignBrief>) ?? {}) }), s.pack.design);
        return compact({ notes: r.notes, designs: r.designs.map((d) => ({ ...designDigest(d), review: d.review.highlights })) });
      }
      return { error: `Unknown tool ${name}` };
    };

    const context = contextFor(s, ctx, b.step);
    const hint = { intent: local.intent, plot: local.plot, brief: local.brief };
    let out = null;
    try {
      out = await s.builder.chat({
        system: BUILDER_SYSTEM_PROMPT,
        history: b.history.map((h) => ({ role: h.role, text: redact(h.text) })),
        message: `<project_context>\n${JSON.stringify(compact(context))}\n</project_context>\n<local_reading>${JSON.stringify(hint)}</local_reading>\n\n${message}`,
        tools: TOOLS,
        runTool,
        maxSteps: 5,
      });
    } catch (err) {
      req.log.warn({ err: String(err) }, 'Builder AI failed; using the local assistant');
    }
    if (!out) return fallback('unavailable');
    // Questions only: the chat never changes the plot, brief or project; the person uses the app's controls.
    return { source: 'ai' as const, messageId, model: out.model, promptVersion: BUILDER_PROMPT_VERSION, intent: local.intent, reply: out.text };
  });
}
