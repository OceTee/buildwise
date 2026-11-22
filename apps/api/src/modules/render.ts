import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { redact } from '@bw/domain';
import { one } from '../db/database.js';
import { clientOf, type Services } from '../http/route.js';
import { ApiError, badRequest } from '../platform/platform.js';
import { isPng } from '../platform/render.js';

/**
 * Photoreal render (POST /v1/build/render). The browser sends a PNG snapshot of its 3D model; an image model
 * turns exactly that massing into a photorealistic exterior impression. The prompt is built here from a few
 * checked fields, never taken from the browser. Off unless RENDER_PROVIDER is set.
 *
 * Registered without route(): the model takes up to a minute, and that must not hold a database transaction open.
 */

const DATA_URL_PREFIX = 'data:image/png;base64,';
/** The data URL as sent (~3 MiB of PNG); keeps the request under the 4.5 MB serverless body limit. */
export const MAX_RENDER_DATA_URL = 4 * 1024 * 1024;
const MAX_PNG_BYTES = Math.floor((MAX_RENDER_DATA_URL - DATA_URL_PREFIX.length) * 3 / 4);

const label = z.string().trim().max(40).regex(/^[\p{L}\p{N} ,.'&()/-]*$/u, 'Use letters, numbers and simple punctuation.');
const renderBody = z.object({
  image: z.string().max(MAX_RENDER_DATA_URL).startsWith(DATA_URL_PREFIX, 'Send a PNG data URL.'),
  type: label.optional(),
  style: label.optional(),
  storeys: z.number().int().min(1).max(10).optional(),
  summary: z.string().max(300).optional(),
});
type RenderBody = z.infer<typeof renderBody>;

const clean = (t: string) => t.replace(/[\p{Cc}\p{Cf}<>{}`]/gu, ' ').replace(/\s+/g, ' ').trim();

/** The prompt sent to the image model: built server-side from checked fields only. */
export function renderPrompt(b: Pick<RenderBody, 'type' | 'style' | 'storeys' | 'summary'>): string {
  const storeys = b.storeys ? `${b.storeys === 1 ? 'single-storey' : `${b.storeys}-storey`} ` : '';
  const type = b.type ? clean(b.type) : 'house';
  const style = b.style ? clean(b.style) : 'contemporary';
  const summary = b.summary ? clean(redact(b.summary)).slice(0, 300) : '';
  return [
    `Photorealistic exterior architectural visualisation of exactly the ${storeys}${type} shown in the input image, a 3D massing model of a planned building.`,
    'Keep the building exactly as modelled: the same massing, footprint and proportions, the same number of storeys, the same roof form and pitch, and every window and door in the same position and size. Do not add or remove wings, floors, balconies or openings, and keep the same camera angle.',
    `Replace the flat model surfaces with tasteful, realistic materials for a ${style} style: rendered and painted blockwork walls, a well-detailed roof covering, clear glazing with slim frames, and neat paving.`,
    summary ? `About the design: ${summary}.` : '',
    'Setting: a residential plot in Nigeria, West Africa, in warm late-afternoon sunlight with soft long shadows and a clear sky; tidy tropical landscaping with lawn, shrubs and a few palms; a perimeter fence and gate where the plot edge is visible.',
    'Professional architectural photography look, natural colours, high detail. No people, no vehicles in motion, no text, no labels, no logos and no watermarks.',
  ].filter(Boolean).join(' ');
}

export function registerRender(app: FastifyInstance, s: Services) {
  app.post('/v1/build/render', { bodyLimit: MAX_RENDER_DATA_URL + 64 * 1024 }, async (req, reply) => {
    const client = clientOf(req, s);
    const wait = await s.limiter.hit(`ip:${client.ip}`, s.config.rateLimit.perMinute);
    if (wait) { reply.header('retry-after', String(wait)); throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again shortly.'); }
    const parsed = renderBody.safeParse(req.body ?? {});
    if (!parsed.success) throw badRequest('VALIDATION_FAILED', 'Check the snapshot.', parsed.error.issues.map((i) => ({ path: i.path.map(String).join('.') || 'body', message: i.message })));
    const b = parsed.data;
    const png = Buffer.from(b.image.slice(DATA_URL_PREFIX.length), 'base64');
    if (png.length > MAX_PNG_BYTES || !isPng(png)) throw badRequest('NOT_PNG', 'The snapshot must be a PNG image under 3 MB.');
    reply.header('cache-control', 'private, no-store');

    const none = (reason: 'not_connected' | 'busy' | 'unavailable') => ({ source: 'none' as const, reason });
    if (s.render.kind === 'none') return none('not_connected');
    if (await s.limiter.hit(`render:${client.ip}`, s.config.renderLimits.perMinute)) return none('busy');
    const used = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql,
      `insert into ai_usage (day, kind, n) values (current_date, 'render', 1) on conflict (day, kind) do update set n = ai_usage.n + 1 returning n`));
    if ((used?.n ?? 0) > s.config.renderLimits.perDay) return none('busy');

    let out: { png: Buffer } | null = null;
    try {
      out = await s.render.render({ png, prompt: renderPrompt(b) });
    } catch (err) {
      req.log.warn({ err: (err as Error)?.name ?? 'error' }, 'Photoreal render failed');
    }
    if (!out || !isPng(out.png)) return none('unavailable');
    return { source: 'render' as const, image: `${DATA_URL_PREFIX}${out.png.toString('base64')}` };
  });
}
