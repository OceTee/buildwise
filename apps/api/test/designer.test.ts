import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AiLayout } from '@bw/domain';
import { createGeminiDesigner, interactionText, noDesigner, type DesignerInput, type DesignerProvider } from '../src/platform/designer.js';
import { harness } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h?.close(); });

const visitor = (n: number) => ({ 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': `10.8.0.${n}` });
const use = (p: DesignerProvider) => { (h.services as { designer: DesignerProvider }).designer = p; };
const plot = { widthM: 18.29, depthM: 36.58 };
const brief = { type: 'bungalow', bedrooms: 3 };

const L: AiLayout = {
  name: 'Garden L', idea: 'A living wing to the street and a bedroom wing around a garden.', roof: 'hip',
  concept: { title: 'The Garden House', story: 'You step in to a bright living room.', moves: ['Living wing to the street.', 'Bedrooms on the quiet side.'], palette: { walls: 'White render', accents: 'Timber louvres', roof: 'Charcoal tiles' } },
  blocks: [{ id: 'A', name: 'Living wing', x: 1.5, y: 6, w: 15, d: 5, storeys: 1 }, { id: 'B', name: 'Bedroom wing', x: 1.5, y: 11, w: 9.6, d: 12, storeys: 1 }],
  rooms: [
    { block: 'A', storey: 0, kind: 'living', name: 'Living room', x: 1.5, y: 6, w: 7, d: 5 },
    { block: 'A', storey: 0, kind: 'dining', name: 'Dining', x: 8.5, y: 6, w: 4, d: 5 },
    { block: 'A', storey: 0, kind: 'kitchen', name: 'Kitchen', x: 12.5, y: 6, w: 4, d: 5 },
    { block: 'B', storey: 0, kind: 'corridor', name: 'Hallway', x: 5.1, y: 11, w: 1.2, d: 12 },
    { block: 'B', storey: 0, kind: 'master', name: 'Master bedroom', x: 1.5, y: 11, w: 3.6, d: 4 },
    { block: 'B', storey: 0, kind: 'bathroom', name: 'Bathroom', x: 1.5, y: 15, w: 3.6, d: 2 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 2', x: 1.5, y: 17, w: 3.6, d: 3 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 3', x: 1.5, y: 20, w: 3.6, d: 3 },
    { block: 'B', storey: 0, kind: 'wc', name: 'Guest WC', x: 6.3, y: 11, w: 4.8, d: 1.5 },
    { block: 'B', storey: 0, kind: 'study', name: 'Study', x: 6.3, y: 12.5, w: 4.8, d: 2.5 },
    { block: 'B', storey: 0, kind: 'store', name: 'Store', x: 6.3, y: 15, w: 4.8, d: 1.5 },
    { block: 'B', storey: 0, kind: 'lounge', name: 'Family lounge', x: 6.3, y: 16.5, w: 4.8, d: 6.5 },
  ],
};
const broken: AiLayout = { ...L, name: 'Broken', rooms: L.rooms.filter((r) => r.name !== 'Study') };

describe('the AI designer', () => {
  it('answers engine/not_connected without a provider, and config says so', async () => {
    use(noDesigner);
    const r = await h.ok(null, 'POST', '/v1/build/design', { plot, brief }, visitor(1));
    expect(r).toEqual({ source: 'engine', reason: 'not_connected' });
    expect((await h.ok(null, 'GET', '/v1/build/config')).designer).toEqual({ connected: false, model: 'engine' });
  });

  it('returns only the layouts that pass the checks, then serves them from the cache', async () => {
    const seen: DesignerInput[] = [];
    use({ live: true, model: 'test-designer', compose: async (i) => { seen.push(i); return { options: [L, broken] }; } });
    const r = await h.ok(null, 'POST', '/v1/build/design', { plot, brief, location: 'Ibadan, Oyo' }, visitor(2));
    expect(r).toMatchObject({ source: 'ai', model: 'test-designer', cached: false });
    expect(r.layouts.map((l: AiLayout) => l.name)).toEqual(['Garden L']);
    // The model got the master prompt's architecture reasoning, the site in numbers, the programme and the location.
    expect(seen[0]!.system).toMatch(/Architectural design reasoning/);
    expect(seen[0]!.system).toMatch(/prison yard/);
    expect(seen[0]!.prompt).toMatch(/"buildableArea"/);
    expect(seen[0]!.prompt).toMatch(/Ibadan, Oyo/);
    expect(JSON.stringify(seen[0]!.schema)).toMatch(/"options"/);
    const again = await h.ok(null, 'POST', '/v1/build/design', { plot, brief, location: 'Ibadan, Oyo' }, visitor(3));
    expect(again).toMatchObject({ source: 'ai', cached: true });
    expect(seen).toHaveLength(1);
  });

  it('sends a failing layout back once with the list of problems, and falls back to the engine if still wrong', async () => {
    const seen: DesignerInput[] = [];
    use({ live: true, model: 'test-designer', compose: async (i) => { seen.push(i); return { options: [seen.length === 1 ? broken : L] }; } });
    const fixed = await h.ok(null, 'POST', '/v1/build/design', { plot, brief: { ...brief, style: 'tropical' } }, visitor(4));
    expect(fixed.source).toBe('ai');
    expect(seen[1]!.prompt).toMatch(/failed BuildWise's checks/);
    expect(seen[1]!.prompt).toMatch(/not covered by any room/);
    use({ live: true, model: 'test-designer', compose: async () => ({ options: [broken] }) });
    const bad = await h.ok(null, 'POST', '/v1/build/design', { plot, brief: { ...brief, style: 'classic' } }, visitor(5));
    expect(bad).toMatchObject({ source: 'engine', reason: 'unusable' });
    expect(bad.problems.join(' ')).toMatch(/not covered/);
  });

  it('the Gemini adapter calls the Interactions API with a JSON schema and reads the model output step', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return reply(200, { status: 'completed', steps: [{ type: 'thought', summary: 'x' }, { type: 'model_output', content: [{ type: 'text', text: '{"options":[]}' }] }] });
    }) as unknown as typeof globalThis.fetch;
    const warned: string[] = [];
    const g = createGeminiDesigner({ apiKey: 'test-key-123', model: 'gemini-4-hydrogen', fetch, warn: (m) => warned.push(m) });
    expect(await g.compose({ system: 'sys', prompt: 'p', schema: { type: 'object' } })).toEqual({ options: [] });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect((calls[0]!.init.headers as Record<string, string>)['x-goog-api-key']).toBe('test-key-123');
    const sent = JSON.parse(String(calls[0]!.init.body));
    expect(sent).toMatchObject({ model: 'gemini-4-hydrogen', system_instruction: 'sys', input: 'p', response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } } });
    expect(interactionText({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] })).toBe('ab');

    const cut = createGeminiDesigner({ apiKey: 'test-key-123', model: 'm', fetch: (async () => reply(200, { status: 'incomplete', steps: [] })) as unknown as typeof globalThis.fetch, warn: (m) => warned.push(m) });
    expect(await cut.compose({ system: 's', prompt: 'p', schema: {} })).toBeNull();
    const denied = createGeminiDesigner({ apiKey: 'test-key-123', model: 'm', fetch: (async () => reply(429, { error: { code: 'quota_exceeded', message: 'x' } })) as unknown as typeof globalThis.fetch, warn: (m) => warned.push(m) });
    expect(await denied.compose({ system: 's', prompt: 'p', schema: {} })).toBeNull();
    expect(warned.join(' ')).toMatch(/HTTP 429 \(quota_exceeded\)/);
    expect(warned.join(' ')).not.toMatch(/test-key-123/);
  });
});
