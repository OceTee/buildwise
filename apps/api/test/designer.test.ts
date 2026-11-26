import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { designFromLayout, distinctDesigns, hasMasterEnsuite, type AiLayout } from '@bw/domain';
import { chainDesigners, claudeSchema, createGeminiDesigner, interactionText, noDesigner, type CritiqueInput, type DesignerInput, type DesignerProvider } from '../src/platform/designer.js';
import { harness } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h?.close(); });

const visitor = (n: number) => ({ 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': `10.8.0.${n}` });
const use = (p: DesignerProvider) => { (h.services as { designer: DesignerProvider }).designer = p; };
const plot = { widthM: 18.29, depthM: 36.58 };
const brief = { type: 'bungalow', bedrooms: 3, ensuite: false };

const L: AiLayout = {
  name: 'Garden L', idea: 'A living wing to the street and a bedroom wing around a garden.', roof: 'hip',
  concept: { title: 'The Garden House', story: 'You step in to a bright living room.', moves: ['Living wing to the street.', 'Bedrooms on the quiet side.'], palette: { walls: 'White render', accents: 'Timber louvres', roof: 'Charcoal tiles' } },
  blocks: [{ id: 'A', name: 'Living wing', x: 1.5, y: 6, w: 15, d: 5, storeys: 1 }, { id: 'B', name: 'Bedroom wing', x: 1.5, y: 11, w: 9.6, d: 12, storeys: 1 }],
  rooms: [
    { block: 'A', storey: 0, kind: 'living', name: 'Living room', x: 1.5, y: 6, w: 7, d: 5 },
    { block: 'A', storey: 0, kind: 'dining', name: 'Dining', x: 8.5, y: 6, w: 4, d: 5 },
    { block: 'A', storey: 0, kind: 'kitchen', name: 'Kitchen', x: 12.5, y: 6, w: 4, d: 5 },
    { block: 'B', storey: 0, kind: 'corridor', name: 'Bedroom lobby', x: 5.1, y: 11, w: 1.8, d: 6 },
    { block: 'B', storey: 0, kind: 'master', name: 'Master bedroom', x: 1.5, y: 11, w: 3.6, d: 4 },
    { block: 'B', storey: 0, kind: 'bathroom', name: 'Bathroom', x: 1.5, y: 15, w: 3.6, d: 2 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 2', x: 6.9, y: 11, w: 4.2, d: 3 },
    { block: 'B', storey: 0, kind: 'store', name: 'Store', x: 6.9, y: 14, w: 4.2, d: 1.5 },
    { block: 'B', storey: 0, kind: 'wc', name: 'Guest WC', x: 6.9, y: 15.5, w: 4.2, d: 1.5 },
    { block: 'B', storey: 0, kind: 'bedroom', name: 'Bedroom 3', x: 1.5, y: 17, w: 3.3, d: 6 },
    { block: 'B', storey: 0, kind: 'lounge', name: 'Family lounge', x: 4.8, y: 17, w: 6.3, d: 6 },
  ],
};
const broken: AiLayout = { ...L, name: 'Broken', rooms: L.rooms.filter((r) => r.name !== 'Bedroom 3') };

describe('the AI designer', () => {
  it('builds distinct checked homes from directions while keeping the requested programme', async () => {
    const seen: DesignerInput[] = [];
    use({ live: true, engineGeometry: true, model: 'direction-test', compose: async (input) => {
      seen.push(input);
      return { options: [
        { form: 'entry-court', emphasis: 'garden', rooms: [] },
        { form: 'entry-court', emphasis: 'host' },
        { form: 'garden-wing', emphasis: 'privacy' },
        { form: 'compact', emphasis: 'host' },
      ] };
    } });
    const required = { type: 'bungalow' as const, bedrooms: 4, features: ['gym' as const] };
    const r = await h.ok(null, 'POST', '/v1/build/design', { plot, brief: required }, visitor(19));
    expect(r).toMatchObject({ source: 'ai', composition: 'engine-guided' });
    expect(r.layouts).toHaveLength(3);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0]!.schema)).not.toMatch(/"rooms"/);
    const builds = (r.layouts as AiLayout[]).map((layout, i) => designFromLayout(plot, required, layout, `guided-${i}`, h.services.pack.design));
    for (const [i, entry] of builds.entries()) {
      expect(entry.problems).toEqual([]);
      expect(hasMasterEnsuite(entry.design!)).toBe(true);
      expect(entry.design!.rooms.some((room) => room.kind === 'gym')).toBe(true);
      expect(builds.slice(i + 1).every((other: typeof entry) => distinctDesigns(entry.design!, other.design!))).toBe(true);
    }
    const duplex = { type: 'duplex', storeys: 2, bedrooms: 4, study: true } as const;
    const withStudy = await h.ok(null, 'POST', '/v1/build/design', { plot, brief: duplex }, visitor(20));
    expect(withStudy).toMatchObject({ source: 'ai', composition: 'engine-guided' });
    expect(withStudy.layouts.length).toBeGreaterThanOrEqual(2);
    expect(withStudy.layouts.every((layout: AiLayout) => layout.rooms.some((room) => room.kind === 'study'))).toBe(true);
  });

  it('draws fresh houses from the design ideas the model chose, under its own titles and stories', async () => {
    const seen: DesignerInput[] = [];
    use({ live: true, engineGeometry: true, model: 'ideas-test', compose: async (input) => {
      seen.push(input);
      const offered = JSON.parse(input.prompt).availableIdeas as { idea: string }[];
      return { options: offered.slice(0, 3).map((o, i) => ({ idea: o.idea, title: `Family home <b>${i + 1}</b>`, story: 'A calm house round a garden. *Plain words only*' })) };
    } });
    const wide = { widthM: 30, depthM: 36 };
    const brief3 = { type: 'bungalow' as const, bedrooms: 3 };
    const prefs = { taste: 'tropical' as const, priorities: ['garden' as const] };
    const a = await h.ok(null, 'POST', '/v1/build/design', { plot: wide, brief: brief3, preferences: prefs, seed: 101 }, visitor(31));
    expect(a).toMatchObject({ source: 'ai', composition: 'engine-guided' });
    expect(JSON.parse(seen[0]!.prompt).availableIdeas.length).toBeGreaterThanOrEqual(3);
    expect(a.layouts).toHaveLength(3);
    for (const [i, layout] of (a.layouts as AiLayout[]).entries()) {
      // The model's title, stripped of markup; the design passes every check.
      expect(layout.concept?.title).toMatch(new RegExp(`^Family home b ${i + 1}`));
      expect(layout.concept?.title).not.toMatch(/[<>]/);
      expect(layout.concept?.story).not.toMatch(/[*<>]/);
      expect(designFromLayout(wide, brief3, layout, `idea-${i}`, h.services.pack.design).problems).toEqual([]);
    }
    // Another seed: other houses from the same ideas, not the cached answer.
    const b = await h.ok(null, 'POST', '/v1/build/design', { plot: wide, brief: brief3, preferences: prefs, seed: 202 }, visitor(32));
    expect(b.cached).toBe(false);
    expect(seen).toHaveLength(2);
  });

  it('answers engine/not_connected without a provider, and config says so', async () => {
    use(noDesigner);
    const r = await h.ok(null, 'POST', '/v1/build/design', { plot, brief }, visitor(1));
    expect(r).toMatchObject({ source: 'engine', reason: 'not_connected', conceptSite: { plot, preliminary: false } });
    expect((await h.ok(null, 'GET', '/v1/build/config')).designer).toEqual({ connected: false, model: 'engine', critique: false });
  });

  it('returns only the layouts that pass the checks, then serves them from the cache', async () => {
    const seen: DesignerInput[] = [];
    use({ live: true, model: 'test-designer', compose: async (i) => { seen.push(i); return { options: [L, { ...L, name: 'Same layout' }, broken] }; } });
    const r = await h.ok(null, 'POST', '/v1/build/design', { plot, brief, location: 'Ibadan, Oyo' }, visitor(2));
    expect(r).toMatchObject({ source: 'ai', model: 'test-designer', cached: false });
    expect(r.layouts.map((l: AiLayout) => l.name)).toEqual(['Garden L']);
    expect(seen[0]!.system).toMatch(/Compose original contemporary concept designs/);
    expect(seen[0]!.system).toMatch(/different arrival routes, room relationships, outdoor spaces and silhouettes/);
    expect(seen[0]!.prompt).toMatch(/"buildableArea"/);
    expect(seen[0]!.prompt).not.toMatch(/Ibadan, Oyo/);
    expect(JSON.stringify(seen[0]!.schema)).toMatch(/"options"/);
    const again = await h.ok(null, 'POST', '/v1/build/design', { plot, brief, location: 'Toronto, Ontario' }, visitor(3));
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

  it('the Gemini designer can request structured output through generateContent', async () => {
    const fetch: typeof globalThis.fetch = async (url, init) => {
      expect(String(url)).toContain('/models/gemini-3.6-flash:generateContent');
      expect(JSON.parse(String(init?.body))).toMatchObject({
        systemInstruction: { parts: [{ text: 'sys' }] },
        contents: [{ parts: [{ text: 'brief' }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: { type: 'object' } },
      });
      return Response.json({ candidates: [{ finishReason: 'STOP', content: { parts: [{ thought: true, text: 'private' }, { text: '{"options":[]}' }] } }] });
    };
    const d = createGeminiDesigner({ apiKey: 'test', model: 'gemini-3.6-flash', transport: 'generateContent', fetch });
    expect(await d.compose({ system: 'sys', prompt: 'brief', schema: { type: 'object' } })).toEqual({ options: [] });
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
    // Limits that make Gemini's schema too large are dropped; enums stay.
    await g.compose({ system: 's', prompt: 'p', schema: { type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 9 }, k: { type: 'string', enum: ['a', 'b'] }, xs: { type: 'array', maxItems: 3, items: { type: 'string' } } } } });
    expect(JSON.parse(String(calls[1]!.init.body)).response_format.schema).toEqual({ type: 'object', properties: { n: { type: 'integer' }, k: { type: 'string', enum: ['a', 'b'] }, xs: { type: 'array', items: { type: 'string' } } } });
    expect(interactionText({ steps: [{ type: 'model_output', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }] })).toBe('ab');

    const cut = createGeminiDesigner({ apiKey: 'test-key-123', model: 'm', fetch: (async () => reply(200, { status: 'incomplete', steps: [] })) as unknown as typeof globalThis.fetch, warn: (m) => warned.push(m) });
    expect(await cut.compose({ system: 's', prompt: 'p', schema: {} })).toBeNull();
    const denied = createGeminiDesigner({ apiKey: 'test-key-123', model: 'm', fetch: (async () => reply(429, { error: { code: 'quota_exceeded', message: 'x' } })) as unknown as typeof globalThis.fetch, warn: (m) => warned.push(m) });
    expect(await denied.compose({ system: 's', prompt: 'p', schema: {} })).toBeNull();
    expect(warned.join(' ')).toMatch(/HTTP 429 \(quota_exceeded\)/);

    // A busy model hands over to the next in the chain.
    const tried: string[] = [];
    const chain = createGeminiDesigner({ apiKey: 'test-key-123', model: 'busy-model, good-model', warn: (m) => warned.push(m), fetch: (async (_u: string, init: RequestInit) => {
      const m = JSON.parse(String(init.body)).model as string;
      tried.push(m);
      return m === 'busy-model' ? reply(503, { error: { code: 'service_unavailable' } }) : reply(200, { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: '{"options":[1]}' }] }] });
    }) as unknown as typeof globalThis.fetch });
    expect(await chain.compose({ system: 's', prompt: 'p', schema: {} })).toEqual({ options: [1] });
    expect(tried).toEqual(['busy-model', 'good-model']);
    expect(warned.join(' ')).not.toMatch(/test-key-123/);
  });
});

describe('Claude as designer and critic', () => {
  it('chains designers: the first answer wins, a failing one hands over', async () => {
    const calls: string[] = [];
    const bad: DesignerProvider = { live: true, model: 'claude', compose: async () => { calls.push('claude'); throw new Error('overloaded'); } };
    const good: DesignerProvider = { live: true, model: 'gemini', compose: async () => { calls.push('gemini'); return { options: [] }; } };
    const chain = chainDesigners([bad, good]);
    expect(chain.model).toBe('claude > gemini');
    expect(await chain.compose({ system: 's', prompt: 'p', schema: {} })).toEqual({ options: [] });
    expect(calls).toEqual(['claude', 'gemini']);
    expect(chain.critique).toBeUndefined();
    expect(chainDesigners([noDesigner]).live).toBe(false);
  });

  it('adapts the layout schema for Claude: closed objects, no numeric or array limits', () => {
    const out = claudeSchema({ type: 'object', properties: { n: { type: 'integer', minimum: 0, maximum: 9 }, xs: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'object', properties: { a: { type: 'string' } } } } }, required: ['n'] }) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.n).toEqual({ type: 'integer' });
    expect(out.properties.xs.minItems).toBeUndefined();
    expect(out.properties.xs.items.additionalProperties).toBe(false);
    expect(out.required).toEqual(['n']);
  });

  it('looks at a 3D snapshot of its design and returns an improved, checked layout', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const improved: AiLayout = { ...L, elements: [{ kind: 'veranda', storey: 0, x: 1.5, y: 23, w: 9.6, d: 2.4, material: 'timber' }] } as AiLayout;
    let seen: CritiqueInput | null = null;
    use({ live: true, model: 'test-claude', compose: async () => null, critique: async (i) => { seen = i; return { options: [improved], review: { notes: ['Added a garden veranda.'], improved: true } }; } });
    const r = await h.ok(null, 'POST', '/v1/build/critique', { plot, brief, layout: L, image: png }, visitor(20));
    expect(r).toMatchObject({ source: 'ai', improved: true, notes: ['Added a garden veranda.'] });
    expect(r.layout.elements).toHaveLength(1);
    expect(seen!.image).toEqual({ mediaType: 'image/png', data: 'iVBORw0KGgo=' });
    expect(seen!.prompt).toMatch(/prison yard/);
    expect(JSON.stringify(seen!.schema)).toMatch(/"review"/);
    // A revision that breaks the rules is not taken.
    use({ live: true, model: 'test-claude', compose: async () => null, critique: async () => ({ options: [broken], review: { notes: ['x'], improved: true } }) });
    const kept = await h.ok(null, 'POST', '/v1/build/critique', { plot, brief, layout: L, image: png }, visitor(21));
    expect(kept).toMatchObject({ source: 'ai', improved: false });
    use(noDesigner);
    expect(await h.ok(null, 'POST', '/v1/build/critique', { plot, brief, layout: L, image: png }, visitor(22))).toEqual({ source: 'none', reason: 'not_connected' });
    expect((await h.call(null, 'POST', '/v1/build/critique', { plot, brief, layout: L, image: 'data:text/html;base64,PGI+' }, visitor(23))).status).toBe(400);
  });
});
