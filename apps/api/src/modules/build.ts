import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  DESIGN_ENGINE_VERSION, designDigest, generateDesigns, normaliseBrief, redact, respond, uuidv7, validPlot,
  type AiArchitectReview, type DesignBrief,
} from '@bw/domain';
import { many, one } from '../db/database.js';
import { clientOf, route, type Services } from '../http/route.js';
import { ApiError, badRequest, sha256, tooMany } from '../platform/platform.js';
import { brainInfo, getBrain, registerAssistantAdmin, sessionOf } from './assistant.js';
import { registerBuilderAi } from './builder-ai.js';
import { registerBuildSources } from './build-sources.js';
import { registerPlanLibrary } from './plan-library.js';
import { cardsFor, searchListings } from './listings.js';

/**
 * The AI-first build flow's server side (the design engine is pure and runs in the browser):
 *  - /v1/build/config      the market's design rules, so the browser designs with the same values;
 *  - /v1/build/interpret   the BuildWise assistant: reads the plot and brief, answers building questions, stays in scope;
 *  - /v1/build/feedback    what happened next (continued, shopped, corrected the brief, helpful or not): learning signals;
 *  - /v1/build/sourcing    prices each material line from live marketplace listings;
 *  - /v1/build/architect   an AI architect's review and ranking of the generated designs, when one is connected;
 *  - /v1/build/plans       ready-made plans that architects list in the marketplace, that fit the plot.
 */

const BRIEF_KEYS = ['type', 'storeys', 'units', 'bedrooms', 'bathrooms', 'ensuite', 'kitchen', 'study', 'guestWc', 'store', 'parking', 'style', 'roof', 'roofFinish', 'roofColour', 'roofPitch', 'bq'] as const;
const briefPatch = z.object({
  ...Object.fromEntries(BRIEF_KEYS.map((k) => [k, z.union([z.number(), z.string().max(20), z.boolean()]).optional()])),
  features: z.array(z.string().max(30)).max(20).optional(),
}).strict();

export function registerBuild(app: FastifyInstance, s: Services) {
  registerAssistantAdmin(app, s);
  registerArchitect(app, s);
  registerBuilderAi(app, s);
  registerBuildSources(app, s);
  registerPlanLibrary(app, s);

  route(app, s, {
    method: 'GET', url: '/v1/build/config', auth: 'public', systemContext: true,
    handler: async ({ sql }) => { await getBrain(s, sql); return { design: s.pack.design, planning: s.pack.planning, currency: s.pack.currency, assistant: brainInfo(), liveBrain: { connected: s.brain.live, model: s.brain.live ? s.brain.model : null }, architect: { connected: s.architect.live }, builderAi: { connected: s.builder.live }, render: { connected: s.render.kind !== 'none' }, designer: { connected: s.designer.live, model: s.designer.model, critique: !!s.designer.critique, ...(s.designer.engineGeometry ? { engineGeometry: true } : {}) }, dream: { connected: s.dream.kind !== 'none', checked: s.dream.kind !== 'none' && s.checker.live } }; },
  });

  // The assistant: BuildWise's own small model reads every message at once (it is also the fallback); when the live
  // brain (Gemini) is connected it reads the message too and its answer is the one shown, and its reading is kept as a
  // teacher label for the small model. Registered without route(): the brain can take seconds, and that must not hold
  // a database transaction open (PGlite runs transactions one at a time).
  const interpretBody = z.object({
    message: z.string().trim().min(1).max(2000),
    plot: z.object({ widthM: z.number(), depthM: z.number() }).nullable().optional(),
    brief: z.record(z.string(), z.unknown()).optional(),
  });
  app.post('/v1/build/interpret', async (req, reply) => {
    const client = clientOf(req, s);
    const wait = (await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute)) || (await s.limiter.hit(`assistant:${client.ip}`, s.config.assistantPerMinute));
    if (wait) { reply.header('retry-after', String(wait)); throw tooMany('You are sending messages very quickly. Try again in a moment.', wait); }
    const parsed = interpretBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the message.', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'body', message: i.message })));
    const body = parsed.data;
    reply.header('cache-control', 'private, no-store');
    const state = { plot: body.plot && validPlot(body.plot) ? body.plot : null, brief: (body.brief ?? {}) as Partial<DesignBrief> };
    const id = uuidv7();
    const message = redact(body.message);
    // Stored redacted, against an anonymous session, so the assistant can learn from it (kept 180 days).
    const r = await s.db.tx({ kind: 'system' }, async (sql) => {
      const brain = await getBrain(s, sql);
      const local = respond(brain, body.message, state);
      await sql.query(
        `insert into assistant_messages (id, session, text, intent, confidence, knowledge_id, unanswered) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, sessionOf(s, client), message, local.intent, local.confidence, local.knowledgeId, local.unanswered]);
      return local;
    });
    const local = { messageId: id, source: 'local' as const, intent: r.intent, confidence: r.confidence, plot: r.plot, brief: r.brief, reply: r.reply, knowledgeId: r.knowledgeId, preferences: r.preferences, revision: r.revision, route: r.route };
    if (!s.brain.live) return local;
    const used = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql,
      `insert into ai_usage (day, kind, n) values (current_date, 'brain', 1) on conflict (day, kind) do update set n = ai_usage.n + 1 returning n`));
    if ((used?.n ?? 0) > s.config.assistantDailyLimit) return local;
    let read = null;
    try {
      read = await s.brain.read({ message, state, local: { intent: r.intent, plot: r.plot, brief: r.brief, preferences: r.preferences, revision: r.revision, route: r.route } });
    } catch (err) {
      req.log.warn({ err: String(err) }, 'The live brain failed; the local assistant answers');
    }
    if (!read) return local;
    // The teacher label: the brain's intent, and the brief fields it read differently from the local rules.
    const changes = Object.fromEntries(Object.entries(read.brief).filter(([k, v]) => JSON.stringify((r.brief as Record<string, unknown>)[k]) !== JSON.stringify(v)));
    await s.db.tx({ kind: 'system' }, (sql) => sql.query(
      `update assistant_messages set teacher_intent = $2, teacher_changes = $3::jsonb, teacher_model = $4 where id = $1`,
      [id, read!.intent, Object.keys(changes).length ? JSON.stringify(changes) : null, read!.model]));
    const home = read.intent === 'build_home';
    // A curated answer (the knowledge base, or live marketplace prices) stays when both readings agree on it.
    const curated = r.knowledgeId && r.intent === read.intent;
    return {
      messageId: id, source: 'ai' as const, model: read.model, intent: read.intent, confidence: Math.max(r.intent === read.intent ? r.confidence : 0, 0.9),
      plot: home ? read.plot ?? r.plot : null,
      brief: home ? { ...r.brief, ...read.brief } : {},
      reply: curated ? r.reply : read.reply,
      knowledgeId: curated ? r.knowledgeId : null,
      // The brain's reading of purpose, taste and priorities fills in what the local rules missed; places, budgets,
      // revisions and the tool route stay BuildWise's own (they are checked, not generated).
      preferences: { ...r.preferences, ...(read.purpose ? { purpose: read.purpose } : {}), ...(read.taste ? { taste: read.taste } : {}), priorities: [...new Set([...r.preferences.priorities, ...(read.priorities ?? [])])] },
      revision: r.revision, route: r.route,
    };
  });

  route(app, s, {
    method: 'POST', url: '/v1/build/feedback', auth: 'public', systemContext: true, successStatus: 200,
    body: z.object({
      messageId: z.uuid(),
      outcome: z.enum(['proceeded', 'shopped', 'abandoned']).optional(),
      changes: briefPatch.optional(),
      helpful: z.boolean().optional(),
    }),
    handler: async ({ sql, body, client }) => {
      const session = sessionOf(s, client);
      // Only the session that sent the message can describe what happened next, and the outcome is set once.
      const confirmed = body.outcome === 'proceeded' ? 'build_home' : body.outcome === 'shopped' ? 'shopping' : null;
      const r = await sql.query(
        `update assistant_messages
            set outcome = coalesce(outcome, $3),
                confirmed_intent = case when confirmed_intent is null and $4::text is not null and intent in ('build_home', 'shopping', 'question', 'other_project') then $4 else confirmed_intent end,
                label_source = case when label_source is null and $4::text is not null then 'outcome' else label_source end,
                changes = coalesce(changes, $5::jsonb),
                helpful = coalesce($6, helpful),
                feedback_at = now()
          where id = $1 and session = $2 and created_at > now() - interval '1 day'
          returning id`,
        [body.messageId, session, body.outcome ?? null, confirmed, body.changes && Object.keys(body.changes).length ? JSON.stringify(body.changes) : null, body.helpful ?? null]);
      return { recorded: r.rows.length > 0 };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/build/plans', auth: 'public',
    query: z.object({
      widthM: z.coerce.number().min(6).max(200),
      depthM: z.coerce.number().min(6).max(400),
      bedrooms: z.coerce.number().int().min(1).max(12).optional(),
      storeys: z.coerce.number().int().min(1).max(3).optional(),
    }),
    handler: async ({ sql, query }) => {
      if (!s.pack.categories.some((c) => c.slug === PLANS)) return { items: [] };
      // Plans that fit within the plot, the closest to the brief first: bedrooms, then storeys, then newest.
      const rows = await many<Record<string, any>>(sql,
        `select l.*, o.name as seller_name, o.kind as seller_kind,
                exists (select 1 from verification_checks v where v.org_id = l.seller_org_id and v.state = 'passed' and (v.expires_at is null or v.expires_at > now())) as verified
           from listings l join organizations o on o.id = l.seller_org_id
          where l.status = 'live' and l.category_slug = $1
            and (l.attributes->>'min_plot_width_m')::numeric <= $2 and (l.attributes->>'min_plot_depth_m')::numeric <= $3
          order by abs((l.attributes->>'bedrooms')::numeric - $4), ((l.attributes->>'storeys') = $5) desc, l.published_at desc
          limit 6`,
        [PLANS, query.widthM, query.depthM, query.bedrooms ?? 3, String(query.storeys ?? 1)]);
      const cards = await cardsFor(sql, s, rows);
      return {
        items: cards.map((c, i) => {
          const a = rows[i]!.attributes as Record<string, unknown>;
          return { ...c, plan: { bedrooms: Number(a.bedrooms), storeys: Number(a.storeys), floorAreaM2: Number(a.floor_area_m2), minPlot: { widthM: Number(a.min_plot_width_m), depthM: Number(a.min_plot_depth_m) }, drawingsIncluded: String(a.drawings_included ?? '') } };
        }),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/build/sourcing', auth: 'public', successStatus: 200,
    body: z.object({
      area: z.string().max(40).optional(),
      items: z.array(z.object({
        key: z.string().max(40),
        name: z.string().max(120),
        unit: z.string().max(20),
        quantity: z.number().nonnegative().max(1e7),
        shop: z.object({ category: z.string().max(60).optional(), q: z.string().max(80) }),
      })).min(1).max(80),
    }),
    handler: async ({ sql, body }) => {
      const known = new Set(s.pack.categories.map((c) => c.slug));
      const area = body.area && s.pack.regions.some((r) => r.areas.some((a) => a.code === body.area)) ? body.area : undefined;
      const lines = [];
      let totalMinor = 0n;
      let pricedLines = 0;
      for (const it of body.items) {
        const category = it.shop.category && known.has(it.shop.category) ? it.shop.category : undefined;
        const res = await searchListings(sql, s, { q: it.shop.q, category, area, sort: 'relevance', page: 1 }, { limit: 12 });
        const cards = res.groups.flatMap((g) => g.items.map((x) => ({ ...x.listing, promoted: x.slot !== 'organic' })));
        // Cheapest first among listings priced per the same unit as the line; others follow as "ask for a quote".
        const sameUnit = cards.filter((c) => c.price && unitMatches(c.unit, it.unit)).sort((a, b) => (BigInt(a.price!.amountMinor) < BigInt(b.price!.amountMinor) ? -1 : 1));
        const others = cards.filter((c) => !sameUnit.includes(c));
        const offers = [...sameUnit, ...others].slice(0, 3).map((c) => {
          const comparable = sameUnit.includes(c);
          const lineMinor = comparable ? BigInt(c.price!.amountMinor) * BigInt(Math.ceil(it.quantity)) : null;
          return {
            listingId: c.id, path: c.path, title: c.title, sellerName: c.sellerName, area: c.area?.label ?? null,
            price: c.price, unitLabel: c.unitLabel, deliveryOffered: c.deliveryOffered, promoted: c.promoted,
            lineTotal: lineMinor === null ? null : { amountMinor: lineMinor.toString(), currency: c.price!.currency },
          };
        });
        const best = offers.find((o) => o.lineTotal);
        if (best) { totalMinor += BigInt(best.lineTotal!.amountMinor); pricedLines++; }
        lines.push({
          key: it.key, name: it.name, unit: it.unit, quantity: it.quantity, offers,
          searchPath: `/search?${new URLSearchParams({ q: it.shop.q, ...(category ? { category } : {}) }).toString()}`,
        });
      }
      return { currency: s.pack.currency, lines, pricedLines, total: { amountMinor: totalMinor.toString(), currency: s.pack.currency } };
    },
  });
}

const ARCHITECT_CACHE_DAYS = 30;
const PLANS = 'house-plans';
const architectBody = z.object({
  plot: z.object({ widthM: z.number(), depthM: z.number() }),
  brief: briefPatch,
  /** Town or state for the concept (letters only; no other personal details). */
  location: z.string().trim().max(80).regex(/^[\p{L}\p{M} ,.'-]*$/u).optional(),
});

/**
 * The AI architect. The server regenerates the designs itself from the plot and brief (the engine is the same code
 * the browser runs), so the model only ever sees numbers we produced. Reviews are cached per plot, brief, engine
 * version and model; fresh ones are limited per IP and per day. Whenever the AI is not connected, busy, over its
 * limits or fails, the answer is the engine's own ranking (`source: 'engine'`) and the page keeps its notes.
 *
 * Registered without route(): the model can take a minute, and that must not hold a database transaction open.
 */
function registerArchitect(app: FastifyInstance, s: Services) {
  app.post('/v1/build/architect', async (req, reply) => {
    const client = clientOf(req, s);
    const wait = await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute);
    if (wait) { reply.header('retry-after', String(wait)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
    const parsed = architectBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the form.', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'body', message: i.message })));
    const { plot } = parsed.data;
    if (!validPlot(plot)) throw badRequest('INVALID_PLOT', 'Enter a plot between 6 m and 200 m on each side.');
    const brief = normaliseBrief(parsed.data.brief as Partial<DesignBrief>);
    const result = generateDesigns(plot, brief, s.pack.design);
    const ids = result.designs.map((d) => d.id);
    const engine = (why: 'not_connected' | 'no_designs' | 'busy' | 'unavailable') => ({ source: 'engine' as const, reason: why, order: ids });
    reply.header('cache-control', 'private, no-store');
    if (!result.designs.length) return engine('no_designs');
    if (!s.architect.live) return engine('not_connected');

    const location = parsed.data.location || undefined;
    const cacheKey = sha256(JSON.stringify({ v: DESIGN_ENGINE_VERSION, model: s.architect.model, market: s.pack.id, plot: { w: Math.round(plot.widthM * 100), d: Math.round(plot.depthM * 100) }, brief, ids, location }));
    const hit = await s.db.tx({ kind: 'system' }, (sql) => one<{ review: AiArchitectReview }>(sql,
      `select review from architect_reviews where cache_key = $1 and created_at > now() - make_interval(days => $2)`, [cacheKey, ARCHITECT_CACHE_DAYS]));
    if (hit) return { source: 'ai' as const, model: s.architect.model, cached: true, ...hit.review };

    if (await s.limiter.hit(`architect:${client.ip}`, s.config.architectLimits.perMinute)) return engine('busy');
    const today = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql, `select count(*)::int as n from architect_reviews where created_at > now() - interval '1 day'`));
    if ((today?.n ?? 0) >= s.config.architectLimits.perDay) return engine('busy');

    let ai: AiArchitectReview | null = null;
    try {
      ai = await s.architect.review({ market: s.pack.name, climate: s.pack.design.climate, plot, brief: { ...brief }, designs: result.designs.map(designDigest), location });
    } catch (err) {
      req.log.warn({ err: String(err) }, 'AI architect failed; using the engine review');
    }
    if (!ai) return engine('unavailable');
    // Keep only what refers to designs we generated.
    const known = new Set(ids);
    const review: AiArchitectReview = {
      overview: ai.overview,
      order: [...new Set(ai.order.filter((id) => known.has(id)))],
      reviews: Object.fromEntries(Object.entries(ai.reviews).filter(([id]) => known.has(id))),
      ...(ai.concept && known.has(ai.concept.designId) ? { concept: ai.concept } : {}),
    };
    await s.db.tx({ kind: 'system' }, (sql) => sql.query(
      `insert into architect_reviews (cache_key, model, review) values ($1, $2, $3::jsonb)
       on conflict (cache_key) do update set review = excluded.review, model = excluded.model, created_at = now()`,
      [cacheKey, s.architect.model, JSON.stringify(review)]));
    return { source: 'ai' as const, model: s.architect.model, cached: false, ...review };
  });
}

/** Listing units are market codes ('bag', 'piece', 'tonne', 'm2'); bill-of-materials units are display units. */
function unitMatches(listingUnit: string, lineUnit: string): boolean {
  const norm = (u: string) => u.toLowerCase().replace('²', '2').replace('³', '3').replace(/s$/, '');
  return norm(listingUnit) === norm(lineUnit);
}
