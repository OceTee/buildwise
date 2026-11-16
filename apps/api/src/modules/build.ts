import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { redact, respond, uuidv7, validPlot, type DesignBrief } from '@bw/domain';
import { route, type Services } from '../http/route.js';
import { tooMany } from '../platform/platform.js';
import { brainInfo, getBrain, registerAssistantAdmin, sessionOf } from './assistant.js';
import { searchListings } from './listings.js';

/**
 * The AI-first build flow's server side (the design engine is pure and runs in the browser):
 *  - /v1/build/config      the market's design rules, so the browser designs with the same values;
 *  - /v1/build/interpret   the BuildWise assistant: reads the plot and brief, answers building questions, stays in scope;
 *  - /v1/build/feedback    what happened next (continued, shopped, corrected the brief, helpful or not): learning signals;
 *  - /v1/build/sourcing    prices each material line from live marketplace listings.
 */

const BRIEF_KEYS = ['storeys', 'bedrooms', 'bathrooms', 'ensuite', 'kitchen', 'study', 'guestWc', 'store', 'parking', 'style', 'roof'] as const;
const briefPatch = z.object(Object.fromEntries(BRIEF_KEYS.map((k) => [k, z.union([z.number(), z.string().max(20), z.boolean()]).optional()]))).strict();

export function registerBuild(app: FastifyInstance, s: Services) {
  registerAssistantAdmin(app, s);

  route(app, s, {
    method: 'GET', url: '/v1/build/config', auth: 'public', systemContext: true,
    handler: async ({ sql }) => { await getBrain(s, sql); return { design: s.pack.design, currency: s.pack.currency, assistant: brainInfo() }; },
  });

  route(app, s, {
    method: 'POST', url: '/v1/build/interpret', auth: 'public', systemContext: true, successStatus: 200,
    body: z.object({
      message: z.string().trim().min(1).max(2000),
      plot: z.object({ widthM: z.number(), depthM: z.number() }).nullable().optional(),
      brief: z.record(z.string(), z.unknown()).optional(),
    }),
    handler: async ({ sql, body, client }) => {
      const wait = await s.limiter.hit(`assistant:${client.ip}`, s.config.assistantPerMinute);
      if (wait) throw tooMany('You are sending messages very quickly. Try again in a moment.', wait);
      const state = { plot: body.plot && validPlot(body.plot) ? body.plot : null, brief: (body.brief ?? {}) as Partial<DesignBrief> };
      const brain = await getBrain(s, sql);
      const r = respond(brain, body.message, state);
      const id = uuidv7();
      // Stored redacted, against an anonymous session, so the assistant can learn from it (kept 180 days).
      await sql.query(
        `insert into assistant_messages (id, session, text, intent, confidence, knowledge_id, unanswered) values ($1, $2, $3, $4, $5, $6, $7)`,
        [id, sessionOf(s, client), redact(body.message), r.intent, r.confidence, r.knowledgeId, r.unanswered]);
      return { messageId: id, intent: r.intent, confidence: r.confidence, plot: r.plot, brief: r.brief, reply: r.reply, knowledgeId: r.knowledgeId };
    },
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

/** Listing units are market codes ('bag', 'piece', 'tonne', 'm2'); bill-of-materials units are display units. */
function unitMatches(listingUnit: string, lineUnit: string): boolean {
  const norm = (u: string) => u.toLowerCase().replace('²', '2').replace('³', '3').replace(/s$/, '');
  return norm(listingUnit) === norm(lineUnit);
}
