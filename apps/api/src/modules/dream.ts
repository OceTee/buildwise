import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { redact } from '@bw/domain';
import { one } from '../db/database.js';
import { clientOf, type Services } from '../http/route.js';
import { ApiError, badRequest } from '../platform/platform.js';
import type { CheckResult, DreamFacts, DreamImage } from '../platform/dream.js';
import { isPng } from '../platform/render.js';

/**
 * Dream renders (POST /v1/build/dream): an image model paints a photoreal impression of the design from one of four
 * views; when Claude is connected and a 3D snapshot was sent, Claude checks the painting against the snapshot and the
 * design's facts, and a misleading painting is redone once with Claude's correction. The prompt is built here from
 * checked fields only, never taken from the browser. Off unless DREAM_PROVIDER is set.
 *
 * Registered without route(): the models take up to a few minutes, and that must not hold a database transaction.
 */

const DATA_URL_PREFIX = 'data:image/png;base64,';
/** The snapshot data URL as sent. Note: Vercel's serverless functions cap request bodies at 4.5 MB. */
export const MAX_DREAM_SNAPSHOT = 5.5 * 1024 * 1024;
export const DREAM_BODY_LIMIT = 6 * 1024 * 1024;
const MAX_PNG_BYTES = Math.floor((MAX_DREAM_SNAPSHOT - DATA_URL_PREFIX.length) * 3 / 4);

export const DREAM_VIEWS = ['street', 'aerial', 'garden', 'interior'] as const;
export type DreamView = (typeof DREAM_VIEWS)[number];

const SAFE = /^[\p{L}\p{M}\p{N} ,.'&()/;:!?-]*$/u;
const label = z.string().trim().max(40).regex(SAFE, 'Use letters, numbers and simple punctuation.');
const phrase = z.string().trim().max(110).regex(SAFE, 'Use letters, numbers and simple punctuation.');
const dreamBody = z.object({
  snapshot: z.string().max(MAX_DREAM_SNAPSHOT).startsWith(DATA_URL_PREFIX, 'Send a PNG data URL.').optional(),
  view: z.enum(DREAM_VIEWS),
  facts: z.object({
    type: label.min(1),
    style: label,
    storeys: z.number().int().min(1).max(10),
    roof: label,
    blocks: z.number().int().min(1).max(8),
    summary: z.string().max(300).optional(),
  }),
  concept: z.object({
    title: z.string().trim().max(60).regex(SAFE, 'Use letters, numbers and simple punctuation.'),
    story: z.string().max(600).optional(),
    palette: z.object({ walls: phrase, accents: phrase, roof: phrase }),
  }).optional(),
});
type DreamBody = z.infer<typeof dreamBody>;

/** Free text becomes plain prose: no control or format characters, no markup or braces, numbers and emails redacted. */
const prose = (t: string, n: number) => redact(t).replace(/[\p{Cc}\p{Cf}<>{}`[\]]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

const VIEW_TEXT: Record<DreamView, string> = {
  street: 'Viewpoint: eye level from the street in front of the plot, looking at the front of the building from slightly to one side, the gate and front yard in the foreground.',
  aerial: 'Viewpoint: an elevated three-quarter aerial view from about 30 metres up, showing the whole building, its roof and the plot around it.',
  garden: 'Viewpoint: eye level from the garden at the back or side of the plot, looking towards the building across the lawn.',
  interior: 'Viewpoint: inside the main living space (for a non-residential building, the main hall or lobby), with windows looking out to the garden.',
};

/** The prompt sent to the image model: built server-side from checked fields only. */
export function dreamPrompt(b: Pick<DreamBody, 'view' | 'facts' | 'concept'>, hasSnapshot: boolean, fix?: string): string {
  const f = b.facts;
  const storeys = f.storeys === 1 ? 'single-storey' : `${f.storeys}-storey`;
  const type = prose(f.type, 40) || 'house';
  const style = prose(f.style, 40) || 'contemporary';
  const roof = prose(f.roof, 40);
  const summary = f.summary ? prose(f.summary, 300) : '';
  const c = b.concept;
  const interior = b.view === 'interior';
  return [
    interior
      ? `Photorealistic interior architectural visualisation of a ${storeys} ${type} in a ${style} style, planned for a plot in Nigeria, West Africa.`
      : `Photorealistic exterior architectural visualisation of exactly one ${storeys} ${type} in a ${style} style, planned for a residential plot in Nigeria, West Africa.`,
    c?.title ? `The scheme is called "${prose(c.title, 60)}".` : '',
    hasSnapshot && !interior
      ? 'The input image is a 3D massing model of the planned building. Keep the building exactly as modelled: the same massing, footprint and proportions, the same number of storeys, the same roof form and pitch, the same wings and blocks, and the windows and doors in the same places. Do not add or remove floors, wings, balconies or openings.'
      : '',
    hasSnapshot && interior ? 'The input image is a 3D model of the building\'s exterior: match its style and window pattern.' : '',
    !interior ? `The building has exactly ${f.storeys === 1 ? 'one storey' : `${f.storeys} storeys`}${roof ? ` and a ${roof} roof` : ''}${f.blocks > 1 ? `, and is made of ${f.blocks} blocks or wings as modelled` : ''}.` : '',
    summary ? `About the design: ${summary}.` : '',
    c?.story ? `Mood: ${prose(c.story, 240)}` : '',
    VIEW_TEXT[b.view],
    c ? `Materials: walls ${prose(c.palette.walls, 110)}; windows, doors and accents ${prose(c.palette.accents, 110)}; roof ${prose(c.palette.roof, 110)}.`
      : 'Materials: rendered and painted blockwork walls, a well-detailed roof covering, clear glazing with slim frames, and neat paving.',
    interior
      ? 'Warm natural daylight, tasteful local furniture and finishes.'
      : 'Warm late-afternoon sunlight with soft long shadows and a clear sky; tidy tropical landscaping with lawn, shrubs and a few palms; a perimeter fence and gate where the plot edge is visible.',
    'Professional architectural photography, natural colours, high detail. No people, no text, no labels, no logos and no watermarks.',
    fix ? `Correct these differences from the planned building: ${prose(fix, 400)}` : '',
  ].filter(Boolean).join(' ');
}

export function registerDream(app: FastifyInstance, s: Services) {
  app.post('/v1/build/dream', { bodyLimit: DREAM_BODY_LIMIT }, async (req, reply) => {
    const client = clientOf(req, s);
    const wait = await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute);
    if (wait) { reply.header('retry-after', String(wait)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
    const parsed = dreamBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the request.', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'body', message: i.message })));
    const b = parsed.data;
    let snapshot: DreamImage | undefined;
    if (b.snapshot) {
      const png = Buffer.from(b.snapshot.slice(DATA_URL_PREFIX.length), 'base64');
      if (png.length > MAX_PNG_BYTES || !isPng(png)) throw badRequest('NOT_PNG', 'The snapshot must be a PNG image under 4 MB.');
      snapshot = { data: png, mimeType: 'image/png' };
    }
    reply.header('cache-control', 'private, no-store');

    const none = (reason: 'not_connected' | 'busy' | 'unavailable') => ({ source: 'none' as const, reason });
    if (s.dream.kind === 'none') return none('not_connected');
    if (await s.limiter.hit(`dream:${client.ip}`, s.config.dreamLimits.perMinute)) return none('busy');
    const used = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql,
      `insert into ai_usage (day, kind, n) values (current_date, 'dream', 1) on conflict (day, kind) do update set n = ai_usage.n + 1 returning n`));
    if ((used?.n ?? 0) > s.config.dreamLimits.perDay) return none('busy');

    const paint = async (fix?: string) => {
      try {
        return await s.dream.dream({ prompt: dreamPrompt(b, !!snapshot, fix), image: snapshot });
      } catch (err) {
        req.log.warn({ err: (err as Error)?.name ?? 'error' }, 'Dream render failed');
        return null;
      }
    };
    const facts: DreamFacts = { type: b.facts.type, style: b.facts.style, storeys: b.facts.storeys, roof: b.facts.roof, blocks: b.facts.blocks, ...(b.facts.summary ? { summary: prose(b.facts.summary, 300) } : {}) };
    const check = async (generated: DreamImage): Promise<CheckResult | null> => {
      try {
        return await s.checker.check({ generated, snapshot: snapshot!, facts, view: b.view });
      } catch (err) {
        req.log.warn({ err: (err as Error)?.name ?? 'error' }, 'Dream check failed');
        return null;
      }
    };

    let image = await paint();
    if (!image) return none('unavailable');
    // An interior cannot be compared with the exterior massing model, so only exterior views are checked.
    let verdict: CheckResult | null = null;
    if (s.checker.live && snapshot && b.view !== 'interior') {
      verdict = await check(image);
      if (verdict && !verdict.consistent) {
        const again = await paint(verdict.promptFix || verdict.issues.join(' '));
        // The redone painting is checked again so the label never claims more than Claude saw.
        if (again) { image = again; verdict = await check(again); }
      }
    }
    const out = { source: 'dream' as const, image: `data:${image.mimeType};base64,${image.data.toString('base64')}`, checked: !!verdict };
    return verdict ? { ...out, consistent: verdict.consistent, issues: verdict.issues.slice(0, 5) } : out;
  });
}
