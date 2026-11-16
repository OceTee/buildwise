import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  SEED_EXAMPLES, SEED_KNOWLEDGE, SEED_TESTS, buildBrain, evaluateIntentModel, formatMoney, learnLexicon, trainIntentModel, unitLabel, words,
  ASSISTANT_INTENTS, type AssistantIntent, type Brain, type BriefField, type IntentModel, type KnowledgeDoc, type LexiconEntry, type TrainingExample,
} from '@bw/domain';
import { many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, notFound } from '../platform/platform.js';

/**
 * Server side of the BuildWise assistant (the model itself lives in @bw/domain).
 *
 * How it learns from the platform, safely:
 *  - Messages are stored redacted, kept 180 days, and tied only to an anonymous session hash.
 *  - What people do next labels their message: continuing to the designs confirms a home brief; going to the
 *    marketplace confirms shopping; brief values they then change by hand teach the phrase list. Staff can label
 *    messages and write answers for questions it could not answer.
 *  - Live listings and rate observations become knowledge ("cement is typically ₦… per bag right now").
 *  - Each retrain is checked against held-out seed tests and only replaces the current model if it does as well.
 *    One session's examples are capped, and phrases need several different sessions, so no single user can steer it.
 */

export const LEARNING = {
  retrainEveryHours: 6,
  messageRetentionDays: 180,
  exampleWindowDays: 365,
  perSessionExampleCap: 20,
  staffLabelWeight: 3,
  minAccuracy: 0.9,
  maxAccuracyDrop: 0.02,
  priceMinListings: 2,
};

// ---------------------------------------------------------------- the brain, cached per server instance

let cache: { brain: Brain; modelId: number; model: IntentModel; at: number; lexicon: LexiconEntry[] } | null = null;
const CACHE_MS = 5 * 60_000;

export function sessionOf(s: Services, client: { ip: string; deviceId: string | null }): string {
  return createHash('sha256').update(`${s.config.authSecret}|assistant|${client.deviceId ?? client.ip}`).digest('hex').slice(0, 32);
}

async function ensureSeeded(sql: Sql) {
  for (const d of SEED_KNOWLEDGE) {
    await sql.query(`insert into assistant_knowledge (id, question, answer, tags, source) values ($1, $2, $3, $4, 'seed') on conflict (id) do nothing`, [d.id, d.question, d.answer, d.tags]);
  }
  const has = await one(sql, `select 1 from assistant_models where promoted limit 1`);
  if (!has) {
    const model = trainIntentModel(SEED_EXAMPLES);
    model.metrics = evaluateIntentModel(model, SEED_TESTS);
    await sql.query(`insert into assistant_models (model, metrics, promoted, note) values ($1::jsonb, $2::jsonb, true, 'seed model')`, [JSON.stringify(model), JSON.stringify(model.metrics)]);
  }
}

/** Pass the request's system-context transaction when there is one (a second transaction could wait on it). */
export async function getBrain(s: Services, sqlIn?: Sql, force = false): Promise<Brain> {
  if (cache && !force && Date.now() - cache.at < CACHE_MS) return cache.brain;
  const run = <T>(fn: (sql: Sql) => Promise<T>) => (sqlIn ? fn(sqlIn) : s.db.tx({ kind: 'system' }, fn));
  return run(async (sql) => {
    await ensureSeeded(sql);
    const row = (await one<{ id: string; model: IntentModel; lexicon: LexiconEntry[]; domain_words: string[] }>(sql,
      `select id, model, lexicon, domain_words from assistant_models where promoted order by id desc limit 1`))!;
    const docs = await many<{ id: string; question: string; answer: string; tags: string[]; source: KnowledgeDoc['source'] }>(sql,
      `select id, question, answer, tags, source from assistant_knowledge where active`);
    const model = typeof row.model === 'string' ? JSON.parse(row.model) : row.model;
    const lexicon = typeof row.lexicon === 'string' ? JSON.parse(row.lexicon) : row.lexicon;
    const domain = typeof row.domain_words === 'string' ? JSON.parse(row.domain_words) : row.domain_words;
    const brain = buildBrain(model, lexicon, docs, domain);
    cache = { brain, modelId: Number(row.id), model, at: Date.now(), lexicon };
    return brain;
  });
}

export function brainInfo() {
  return cache ? { modelId: cache.modelId, trainedAt: cache.model.trainedAt, examples: cache.model.examples, accuracy: cache.model.metrics?.accuracy ?? null, phrases: cache.lexicon.length } : null;
}

// ---------------------------------------------------------------- learning from the platform

/** Facts from the platform's own data: typical live prices per material and unit, and reference rates. */
async function platformKnowledge(sql: Sql, s: Services): Promise<KnowledgeDoc[]> {
  const docs: KnowledgeDoc[] = [];
  const names = new Map(s.pack.categories.map((c) => [c.slug, c.name]));
  const rows = await many<{ category_slug: string; unit: string; n: number; p50: string; lo: string; hi: string; currency: string }>(sql,
    `select category_slug, unit, count(*)::int as n, percentile_disc(0.5) within group (order by price_minor)::text as p50,
            min(price_minor)::text as lo, max(price_minor)::text as hi, min(currency) as currency
       from listings where status = 'live' and price_minor is not null and listing_type = 'product'
      group by category_slug, unit having count(*) >= $1`, [LEARNING.priceMinListings]);
  const today = new Date().toISOString().slice(0, 10);
  for (const r of rows) {
    const name = names.get(r.category_slug) ?? r.category_slug;
    const per = unitLabel(r.unit);
    const m = (v: string) => formatMoney({ amountMinor: v, currency: r.currency }, s.pack.locale);
    docs.push({
      id: `price-${r.category_slug}-${r.unit}`,
      question: `How much does ${name.toLowerCase()} cost per ${per}?`,
      answer: `On BuildWise right now, ${r.n} live ${name.toLowerCase()} listings are priced per ${per}: typically ${m(r.p50)} (from ${m(r.lo)} to ${m(r.hi)}), as of ${today}. Prices differ by area, so compare sellers near you in the marketplace.`,
      tags: [name, ...r.category_slug.split('-'), 'price', 'cost', per],
      source: 'platform',
    });
  }
  const rates = await many<{ code: string; name: string; unit: string; region_code: string; n: number; p50: string; currency: string }>(sql,
    `select c.code, c.name, o.unit, o.region_code, count(*)::int as n, percentile_disc(0.5) within group (order by o.rate_minor)::text as p50, min(o.currency) as currency
       from rate_observations o join catalog_items c on c.id = o.catalog_item_id
      where c.status = 'active' and (o.valid_until is null or o.valid_until > now()) and o.observed_at > now() - interval '120 days'
      group by c.code, c.name, o.unit, o.region_code`);
  const regions = new Map(s.pack.regions.map((r) => [r.code, r.label]));
  const byItem = new Map<string, typeof rates>();
  for (const r of rates) byItem.set(r.code, [...(byItem.get(r.code) ?? []), r]);
  for (const [code, list] of byItem) {
    const first = list[0]!;
    const parts = list.map((r) => `${formatMoney({ amountMinor: String(Math.round(Number(r.p50))), currency: r.currency }, s.pack.locale)} per ${unitLabel(r.unit)} in ${regions.get(r.region_code) ?? r.region_code}`);
    docs.push({
      id: `rate-${code}`,
      question: `What is the rate for ${first.name.toLowerCase()}?`,
      answer: `Recent reference rates for ${first.name.toLowerCase()}: ${parts.join('; ')}. These come from rate observations used in BuildWise estimates.`,
      tags: [first.name, 'rate', 'price', 'cost', unitLabel(first.unit)],
      source: 'platform',
    });
  }
  return docs;
}

export interface TrainingReport { promoted: boolean; accuracy: number; previousAccuracy: number | null; examples: number; learnedExamples: number; phrases: number; platformFacts: number; pruned: number; note: string }

export async function trainAssistant(s: Services, opts: { force?: boolean; sql?: Sql } = {}): Promise<TrainingReport | null> {
  const run = <T>(fn: (sql: Sql) => Promise<T>) => (opts.sql ? fn(opts.sql) : s.db.tx({ kind: 'system' }, fn));
  const report = await run(async (sql) => {
    await ensureSeeded(sql);
    const last = await one<{ trained_at: string; model: IntentModel }>(sql, `select trained_at, model from assistant_models where promoted order by id desc limit 1`);
    if (!opts.force && last && Date.now() - new Date(String(last.trained_at)).getTime() < LEARNING.retrainEveryHours * 3_600_000) return null;
    const pruned = (await sql.query(`delete from assistant_messages where created_at < now() - make_interval(days => $1) returning 1`, [LEARNING.messageRetentionDays])).rows.length;

    // 1. Facts from the platform's own data replace the previous set.
    const facts = await platformKnowledge(sql, s);
    await sql.query(`update assistant_knowledge set active = false, updated_at = now() where source = 'platform' and not (id = any($1::text[]))`, [facts.map((f) => f.id)]);
    for (const f of facts) {
      await sql.query(`insert into assistant_knowledge (id, question, answer, tags, source, active) values ($1, $2, $3, $4, 'platform', true)
                       on conflict (id) do update set question = excluded.question, answer = excluded.answer, tags = excluded.tags, active = true, updated_at = now()
                       where assistant_knowledge.source = 'platform'`, [f.id, f.question, f.answer, f.tags]);
    }

    // 2. Examples labelled by what people did next, or by staff; capped per session.
    const labelled = await many<{ session: string; text: string; confirmed_intent: AssistantIntent; label_source: string }>(sql,
      `select session, text, confirmed_intent, label_source from (
         select session, text, confirmed_intent, label_source, row_number() over (partition by session order by created_at desc) as k
           from assistant_messages
          where confirmed_intent is not null and coalesce(helpful, true) and created_at > now() - make_interval(days => $1)) x
        where k <= $2`, [LEARNING.exampleWindowDays, LEARNING.perSessionExampleCap]);
    const learned: TrainingExample[] = labelled
      .filter((m) => (ASSISTANT_INTENTS as string[]).includes(m.confirmed_intent))
      .map((m) => ({ text: m.text, intent: m.confirmed_intent, weight: m.label_source === 'staff' ? LEARNING.staffLabelWeight : 1 }));
    const candidate = trainIntentModel([...SEED_EXAMPLES, ...learned], new Date().toISOString(), (last?.model.version ?? 0) + 1);
    candidate.metrics = evaluateIntentModel(candidate, SEED_TESTS);
    const previous = last?.model.metrics?.accuracy ?? null;
    const good = candidate.metrics.accuracy >= LEARNING.minAccuracy && (previous === null || candidate.metrics.accuracy >= previous - LEARNING.maxAccuracyDrop);

    // 3. Phrases from hand corrections; 4. building words from live listing titles (the scope guard's vocabulary).
    const corrections = await many<{ session: string; text: string; changes: Record<string, unknown> }>(sql,
      `select session, text, changes from assistant_messages where changes is not null and created_at > now() - make_interval(days => $1)`, [LEARNING.exampleWindowDays]);
    const lexicon = learnLexicon(corrections.map((c) => ({ session: c.session, text: c.text, changes: (typeof c.changes === 'string' ? JSON.parse(c.changes) : c.changes) as Partial<Record<BriefField, unknown>> })));
    const titles = await many<{ title: string }>(sql, `select title from listings where status = 'live' order by published_at desc limit 2000`);
    const counts = new Map<string, number>();
    for (const t of titles) for (const w of new Set(words(t.title))) if (w.length > 2 && w !== '<num>') counts.set(w, (counts.get(w) ?? 0) + 1);
    const domainWords = [...counts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2000).map(([w]) => w);

    const model = good ? candidate : last!.model;
    const note = good ? `retrained on ${learned.length} platform examples` : `candidate scored ${candidate.metrics.accuracy.toFixed(3)}; kept the previous model`;
    await sql.query(`insert into assistant_models (model, lexicon, domain_words, metrics, promoted, note) values ($1::jsonb, $2::jsonb, $3::jsonb, $4::jsonb, true, $5)`,
      [JSON.stringify(model), JSON.stringify(lexicon), JSON.stringify(domainWords), JSON.stringify({ ...candidate.metrics, previous, learnedExamples: learned.length, phrases: lexicon.length, platformFacts: facts.length }), note]);
    // Keep the history short.
    await sql.query(`delete from assistant_models where id not in (select id from assistant_models order by id desc limit 30)`);
    return { promoted: good, accuracy: candidate.metrics.accuracy, previousAccuracy: previous, examples: SEED_EXAMPLES.length + learned.length, learnedExamples: learned.length, phrases: lexicon.length, platformFacts: facts.length, pruned, note };
  });
  if (report) cache = null;
  return report;
}

// ---------------------------------------------------------------- staff curation

export function registerAssistantAdmin(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/admin/assistant', auth: 'staff', systemContext: true,
    handler: async ({ sql }) => {
      await getBrain(s, sql);
      const stats = await one<Record<string, number>>(sql,
        `select count(*)::int as messages, count(*) filter (where unanswered)::int as unanswered, count(*) filter (where knowledge_id is not null)::int as answered,
                count(*) filter (where intent = 'out_of_scope')::int as out_of_scope, count(*) filter (where confirmed_intent is not null)::int as labelled,
                count(*) filter (where helpful = false)::int as not_helpful
           from assistant_messages where created_at > now() - interval '30 days'`);
      const open = await many(sql,
        `select id, text, intent, confidence, created_at from assistant_messages
          where unanswered and created_at > now() - interval '90 days' order by created_at desc limit 50`);
      const unsure = await many(sql,
        `select id, text, intent, confidence, created_at from assistant_messages
          where confirmed_intent is null and confidence < 0.6 and created_at > now() - interval '30 days' order by created_at desc limit 30`);
      const knowledge = await many(sql, `select id, question, answer, tags, source, active, updated_at from assistant_knowledge order by source, id`);
      const history = await many(sql, `select id, metrics, promoted, note, trained_at from assistant_models order by id desc limit 10`);
      const latest = await one<{ lexicon: LexiconEntry[] }>(sql, `select lexicon from assistant_models where promoted order by id desc limit 1`);
      return { model: brainInfo(), stats, unanswered: open, unsure, knowledge, history, phrases: latest?.lexicon ?? [], intents: ASSISTANT_INTENTS, learning: LEARNING };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/assistant/knowledge', auth: 'staff', systemContext: true,
    body: z.object({ id: z.string().regex(/^[a-z0-9-]{3,60}$/).optional(), question: z.string().trim().min(5).max(300), answer: z.string().trim().min(10).max(1500), tags: z.array(z.string().trim().min(2).max(40)).max(12).default([]), answersMessageId: z.uuid().optional() }),
    handler: async ({ sql, body, user }) => {
      const id = body.id ?? `staff-${createHash('sha1').update(body.question.toLowerCase()).digest('hex').slice(0, 10)}`;
      const cur = await one<{ source: string }>(sql, `select source from assistant_knowledge where id = $1`, [id]);
      if (cur?.source === 'platform') throw notFound('Answer');
      await sql.query(`insert into assistant_knowledge (id, question, answer, tags, source, active, updated_by) values ($1, $2, $3, $4, 'staff', true, $5)
                       on conflict (id) do update set question = excluded.question, answer = excluded.answer, tags = excluded.tags, source = 'staff', active = true, updated_by = excluded.updated_by, updated_at = now()`,
        [id, body.question, body.answer, body.tags, user.id]);
      if (body.answersMessageId) await sql.query(`update assistant_messages set unanswered = false, confirmed_intent = 'question', label_source = 'staff' where id = $1`, [body.answersMessageId]);
      await audit(sql, { actorUserId: user.id, action: 'assistant.knowledge_saved', targetType: 'AssistantKnowledge', targetId: id, metadata: {} });
      cache = null;
      return { id };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/assistant/knowledge/:id/archive', auth: 'staff', systemContext: true, successStatus: 200,
    params: z.object({ id: z.string().max(80) }),
    handler: async ({ sql, params, user }) => {
      const r = await sql.query(`update assistant_knowledge set active = false, updated_by = $2, updated_at = now() where id = $1 and source <> 'platform' returning id`, [params.id, user.id]);
      if (!r.rows.length) throw notFound('Answer');
      await audit(sql, { actorUserId: user.id, action: 'assistant.knowledge_archived', targetType: 'AssistantKnowledge', targetId: params.id, metadata: {} });
      cache = null;
      return { archived: true };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/assistant/messages/:id/label', auth: 'staff', systemContext: true, successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ intent: z.enum(ASSISTANT_INTENTS as [AssistantIntent, ...AssistantIntent[]]), dismiss: z.boolean().optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await sql.query(`update assistant_messages set confirmed_intent = $2, label_source = 'staff', unanswered = case when $3 then false else unanswered end where id = $1 returning id`, [params.id, body.intent, !!body.dismiss]);
      if (!r.rows.length) throw notFound('Message');
      await audit(sql, { actorUserId: user.id, action: 'assistant.message_labelled', targetType: 'AssistantMessage', targetId: params.id, metadata: { intent: body.intent } });
      return { labelled: true };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/admin/assistant/train', auth: 'staff', systemContext: true, successStatus: 200,
    handler: async ({ sql, user }) => {
      const report = await trainAssistant(s, { force: true, sql });
      await audit(sql, { actorUserId: user.id, action: 'assistant.retrained', targetType: 'AssistantModel', targetId: 'latest', metadata: { promoted: report?.promoted ?? false } });
      return report;
    },
  });
}
