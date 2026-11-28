import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  EDITABLE_KINDS, PRIORITIES, PURPOSES, TASTES, applyEdits, conceptSet, designDigest, designFromLayout, formatMoney, findDesign, generateDesigns, normaliseBrief, normaliseProject, planProject,
  projectChecks, projectFacts, redact, respond, reviseBrief, uuidv7, validPlot,
  type AiLayout, type BriefRevision, type Design, type DesignBrief, type DesignEdit, type Plot, type ProjectRecord, type RevisedBrief,
} from '@bw/domain';
import { BUILDER_PROMPT_VERSION, BUILDER_SYSTEM_PROMPT } from '../ai/builder-prompt.js';
import { one } from '../db/database.js';
import { clientOf, type Services } from '../http/route.js';
import { ApiError, badRequest } from '../platform/platform.js';
import type { BuilderTool } from '../platform/providers.js';
import { getBrain, sessionOf } from './assistant.js';
import { recordAiOutcome } from './ops.js';

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
  /** The AI designer's layout of the chosen design, when it is one (it cannot be regenerated on the server). */
  layout: z.object({ name: z.string().max(80), idea: z.string().max(400), blocks: z.array(z.any()).max(8), rooms: z.array(z.any()).max(600) }).passthrough().optional(),
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
    description: 'Develop concept options with BuildWise\'s design engine for a plot and brief (defaults to the current ones): up to three checked concepts that differ in plan or massing, chosen for the person\'s purpose, taste and priorities. Use it for "show me three designs", to compare alternatives such as another bedroom or two storeys, or to look at a different plot. Returns each option\'s name, the measured reason to choose it, its trade-off, key metrics, rooms and rule checks, and a note when fewer than three distinct options exist.',
    input_schema: {
      type: 'object',
      properties: {
        plot: { type: 'object', properties: { widthM: { type: 'number' }, depthM: { type: 'number' } } },
        brief: { type: 'object', description: 'Brief fields to change: type (bungalow|duplex|terrace|apartments|shops|office|mixed-use|warehouse|hotel|event-hall|school|clinic|worship), storeys (1-10 within the type\'s range), units (flats/shops/guest rooms/classrooms per floor, seats, or m² of storage, by type), features (gym, gaming, cinema, family-lounge, laundry, prayer, lift, conference, restaurant, canteen, library, lab, pharmacy, upper-offices), bedrooms, bathrooms, ensuite, kitchen (open|closed), study, guestWc, store, parking, roof, bq.', additionalProperties: true },
      },
    },
  },
  {
    name: 'revise_design',
    description: 'Work out a revision that makes something smaller while keeping what the person wants protected. For a smaller plot it tries the plot size given (or the next common plot sizes down); for a tighter budget it looks for the first version that comes within the budget (or about 10% cheaper when no amount is given). It gives up unprotected things one at a time (extras, the boys\' quarters, a parking space), then adds a storey, then drops a bedroom, never anything in "keep", and returns whether it fits, the revised plot and brief, exactly what changed, what was kept, and the checked designs. The app shows the person an Apply button for a revision that fits; it is never applied for them.',
    input_schema: {
      type: 'object',
      properties: {
        smaller: { type: 'array', items: { type: 'string', enum: ['plot', 'budget', 'house'] }, description: 'What has to shrink.' },
        keep: { type: 'array', items: { type: 'string' }, description: 'What must be kept: feature keys (gym, gaming, cinema, family-lounge, laundry, prayer, lift, conference, restaurant…), or study, bq, parking, bedrooms, storeys.' },
        plot: { type: 'object', properties: { widthM: { type: 'number' }, depthM: { type: 'number' } }, description: 'The new plot size in metres, when the person gave one.' },
        budget: { type: 'number', description: 'The new budget in whole currency units, when the person gave one.' },
      },
      required: ['smaller', 'keep'],
    },
  },
];

/** A checked change the person can apply with one click (the chat never applies it). */
export interface Proposal { plot: Plot; brief: Partial<DesignBrief>; label: string; changes: string[]; kept: string[]; budgetMinor?: number }

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
    preferences: {
      purpose: c.project.preferences.purpose ? PURPOSES[c.project.preferences.purpose].short : null,
      taste: c.project.preferences.taste ? `${TASTES[c.project.preferences.taste].label}${c.project.preferences.tasteChosenForMe ? ' (chosen by BuildWise)' : ''}` : null,
      priorities: c.project.preferences.priorities.map((k) => PRIORITIES[k].label),
      plotSize: c.project.preferences.plotUnknown ? 'not known: a typical plot is assumed, so nothing here is checked against the real land' : 'given by the person',
    },
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
      const fromAi = b.layout && b.designId?.startsWith('ai-') ? designFromLayout(plot, brief, b.layout as unknown as AiLayout, b.designId, s.pack.design).design : null;
      const { designs } = fromAi ? { designs: [] as Design[] } : generateDesigns(plot, brief, s.pack.design);
      const chosen = fromAi ?? designs.find((x) => x.id === b.designId) ?? (b.designId ? findDesign(plot, brief, b.designId, s.pack.design) : null) ?? designs[0] ?? null;
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
    const prefs = project.preferences;
    let proposal: Proposal | null = null;
    /** Up to three distinct checked concepts for a plot and brief, as numbers the model (or a template) can explain. */
    const options = (p: Plot, b: DesignBrief) => {
      const set = conceptSet(p, b, prefs, { cfg: s.pack.design });
      return compact({ note: set.note, considered: set.considered, options: set.options.map((o) => ({
        name: o.title, layout: o.design.name, reasonToChoose: `${o.tag}: ${o.reason}`, tradeOff: o.tradeoff, points: o.points,
        metrics: { floorAreaM2: o.metrics.grossFloorM2, footprintM2: o.metrics.footprintM2, plotOpenPct: o.metrics.openPct, gardenM2: o.metrics.gardenM2, coveredOutdoorM2: o.metrics.outdoorRoomM2, hallAndStairPct: o.metrics.circulationPct, livingAndDiningM2: o.metrics.livingM2, bedroomsAwayFromStreet: `${o.metrics.bedsAway} of ${o.metrics.beds}`, roomsThatWorkTogether: o.metrics.relations.works, clashes: o.metrics.relations.conflicts },
        rooms: designDigest(o.design).rooms.map((r) => `${r.name} (${r.floor}) ${r.size}`), checksToNote: designDigest(o.design).checksToNote,
      })) });
    };
    /** The revision planner: smaller plot, house or budget, keeping what is protected. A fit becomes a proposal. */
    const revise = (rev: BriefRevision, toPlot: Plot | null, budgetMajor: number | null): RevisedBrief | { error: string } => {
      if (!plot) return { error: 'No plot size yet.' };
      const cost = (ds: Design[]) => Math.min(...ds.map((d) => planProject(d, project, s.pack.planning).budget.result.totalMinor));
      let accept: ((ds: Design[]) => boolean) | undefined; let goal: string | undefined;
      let budgetMinor: number | undefined;
      if (rev.smaller.includes('budget')) {
        const now = design ? planProject(design, project, s.pack.planning).budget.result.totalMinor : null;
        const target = budgetMajor ? budgetMajor * 100 : now ? Math.round(now * 0.9) : null;
        if (target) { if (budgetMajor) budgetMinor = target; accept = (ds) => cost(ds) <= target; goal = budgetMajor ? `within ${formatMoney({ amountMinor: String(target), currency: s.pack.currency }, s.pack.locale)}` : 'about a tenth cheaper'; }
      }
      const r = reviseBrief(plot, brief, rev, { cfg: s.pack.design, toPlot, ...(accept ? { accept, goal: goal! } : {}) });
      if (r.fits && (budgetMinor !== undefined || r.changes.length || r.plot.widthM !== plot.widthM || r.plot.depthM !== plot.depthM)) {
        const changed = Object.fromEntries((Object.keys(r.brief) as (keyof DesignBrief)[]).filter((k) => JSON.stringify(r.brief[k]) !== JSON.stringify(brief[k])).map((k) => [k, r.brief[k]])) as Partial<DesignBrief>;
        const size = r.plot.widthM !== plot.widthM || r.plot.depthM !== plot.depthM ? `${r.plot.widthM} × ${r.plot.depthM} m plot` : null;
        proposal = { plot: r.plot, brief: changed, label: [size, ...r.changes].filter(Boolean).join(', ') || 'this revision', changes: r.changes, kept: r.kept, ...(budgetMinor === undefined ? {} : { budgetMinor }) };
      }
      return r;
    };
    /** With no model: BuildWise's own tools answer what the local assistant routed (numbers from the calculators). */
    const localReply = (): string => {
      const money = (minor: number) => formatMoney({ amountMinor: String(Math.round(minor)), currency: s.pack.currency }, s.pack.locale);
      const plans = plansFor(s, ctx);
      const route = local.route;
      if (route === 'revise' && local.revision && plot) {
        const r = revise(local.revision, local.plot, local.preferences.budgetMinor ? local.preferences.budgetMinor / 100 : null);
        if ('error' in r) return local.reply;
        const top = r.designs[0];
        return `${r.note}${top ? ` The revised design is ${top.name.toLowerCase()}, ${Math.round(top.metrics.grossFloorM2)} m² of floor covering ${top.metrics.coveragePct}% of the plot.` : ''}${proposal ? ' Use Apply below to switch to it; nothing changes until you do.' : ''}`;
      }
      if (route === 'design' && plot) {
        const set = conceptSet(plot, brief, prefs, { cfg: s.pack.design });
        if (set.options.length) return `${set.options.length === 1 ? 'One checked concept fits' : `${set.options.length} checked concepts fit`} this plot:\n${set.options.map((o) => `- **${o.title}** (${o.tag.toLowerCase()}): ${o.reason}${o.tradeoff ? ` Trade-off: ${o.tradeoff.replace(/^./, (ch) => ch.toLowerCase())}` : ''}`).join('\n')}${set.note ? `\n\n${set.note}` : ''}`;
      }
      if (plans && route === 'calculate:budget') { const b = plans.budget.result; return `This design is likely to cost about ${money(b.totalMinor)} to build (between ${money(b.lowMinor)} and ${money(b.highMinor)}), from BuildWise's illustrative rates for ${Math.round(design!.metrics.grossFloorM2)} m² at a ${project.budget.finish} finish. A quantity surveyor's estimate from the drawings is the figure to build on.`; }
      if (plans && route === 'calculate:energy') { const e = plans.energy.result; return `The house would use about ${e.dailyKwh} kWh a day with a peak of ${e.peakKw} kW${e.solar ? `; the solar option sized for it is ${e.solar.arrayKwp} kWp of panels, a ${e.solar.inverterKw} kW inverter and ${e.solar.batteryUsableKwh} kWh of usable battery` : ''}. These come from typical appliances for this design; an installer confirms them from your real loads.`; }
      if (plans && route === 'calculate:water') { const w = plans.water.result; return `Plan for about ${w.demandLPerDay} litres of water a day and ${w.storageL} litres of storage${w.pump ? `, with a ${w.pump.hp} hp pump` : ''}. That is BuildWise's estimate for the people this design houses; a plumber confirms it on site.`; }
      if (plans && route === 'calculate:cooling') { const c = plans.cooling.result; return `This design needs about ${c.acUnits} air conditioner${c.acUnits === 1 ? '' : 's'}, drawing roughly ${c.inputKw} kW together and ${c.kwhPerDay} kWh a day. Room-by-room sizes are in the Cooling, water, power tab; an installer confirms them.`; }
      return local.reply;
    };
    const fallback = (reason: string) => { const reply = localReply(); return { source: 'local' as const, reason, messageId, intent: local.intent, route: local.route, reply, promptVersion: BUILDER_PROMPT_VERSION, ...(proposal ? { proposal } : {}) }; };
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
        const b2 = normaliseBrief({ ...brief, ...((args.brief as Partial<DesignBrief>) ?? {}) });
        return { ...options(p, b2), notes: generateDesigns(p, b2, s.pack.design).notes };
      }
      if (name === 'revise_design') {
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
        const smaller = list(args.smaller).filter((x): x is BriefRevision['smaller'][number] => ['plot', 'budget', 'house'].includes(x));
        if (!smaller.length) return { error: 'smaller must list plot, budget or house' };
        const to = args.plot && validPlot(args.plot as Plot) ? (args.plot as Plot) : null;
        const r = revise({ smaller, keep: list(args.keep).slice(0, 12) }, to, Number.isFinite(Number(args.budget)) && Number(args.budget) > 0 ? Number(args.budget) : null);
        if ('error' in r) return r;
        return compact({ fits: r.fits, note: r.note, plot: r.plot, whatChanged: r.changes, kept: r.kept, brief: r.brief,
          designs: r.designs.slice(0, 3).map((d) => ({ name: d.name, floorAreaM2: d.metrics.grossFloorM2, coveragePct: d.metrics.coveragePct, storeys: d.storeys, rooms: designDigest(d).rooms.map((x) => `${x.name} ${x.size}`) })),
          applyButtonShown: !!proposal });
      }
      return { error: `Unknown tool ${name}` };
    };

    const context = contextFor(s, ctx, b.step);
    const hint = { intent: local.intent, plot: local.plot, brief: local.brief, preferences: local.preferences, revision: local.revision, suggestedTool: local.route };
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
    await recordAiOutcome(s, 'builder', !!out, out ? undefined : 'no answer');
    if (!out) return fallback('unavailable');
    // Questions only: the chat never changes the plot, brief or project; the person uses the app's controls.
    return { source: 'ai' as const, messageId, model: out.model, promptVersion: BUILDER_PROMPT_VERSION, intent: local.intent, route: local.route, reply: out.text, ...(proposal ? { proposal } : {}) };
  });
}
