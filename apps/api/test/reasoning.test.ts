import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadProviders, paidAiJobs } from '../src/config.js';
import { createGeminiBuilder } from '../src/platform/gemini.js';
import { harness } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h?.close(); });

const visitor = (n: number) => ({ 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': `10.8.0.${n}`, 'x-device-id': `device-r${String(n).padStart(3, '0')}` });
const talk = (n: number, body: Record<string, unknown>) => h.ok(null, 'POST', '/v1/build/chat', body, visitor(n));
const P60 = { widthM: 18.29, depthM: 36.58 };
const family = { type: 'duplex', storeys: 2, bedrooms: 4, features: ['gym'] };
const project = { preferences: { purpose: 'family', taste: 'tropical', priorities: ['garden'] } };

/** Every outgoing request while a test runs: a call to Anthropic or OpenAI would be a paid call. */
const realFetch = globalThis.fetch;
let outgoing: string[] = [];
afterEach(() => { globalThis.fetch = realFetch; outgoing = []; (h.services as { builder: unknown }).builder = { live: false, model: 'local', chat: async () => null }; });
const watchNetwork = () => {
  globalThis.fetch = (async (url: unknown) => { outgoing.push(String(url)); throw new Error('no network in tests'); }) as typeof fetch;
};
const env = (vars: Record<string, string | undefined>, fn: () => void) => {
  const old = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { fn(); } finally { for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
};
const FREE = { BUILDER_AI_PROVIDER: 'gemini', ASSISTANT_PROVIDER: 'gemini', ARCHITECT_PROVIDER: 'gemini', CRITIQUE_PROVIDER: 'gemini', DESIGNER_PROVIDER: 'gemini', RENDER_PROVIDER: 'none', DREAM_PROVIDER: 'none', GEMINI_API_KEY: 'test-key', ANTHROPIC_API_KEY: undefined, PAID_AI: undefined };

describe('the reasoning provider is Google\'s free tier, and cannot fall back to a paid model', () => {
  it('a Gemini configuration has no paid AI job, and needs no Anthropic key at all', () => {
    env(FREE, () => {
      const p = loadProviders();
      expect(p.builder).toMatchObject({ kind: 'gemini' });
      expect(p.brain).toMatchObject({ kind: 'gemini' });
      expect(p.architect).toMatchObject({ kind: 'gemini' });
      expect(paidAiJobs(p)).toEqual([]);
    });
  });
  it('reports each paid job by name, and PAID_AI=off refuses to start with one', () => {
    env({ ...FREE, DESIGNER_PROVIDER: 'anthropic,gemini', CRITIQUE_PROVIDER: 'designer', ANTHROPIC_API_KEY: 'sk-test' }, () => {
      expect(paidAiJobs(loadProviders())).toEqual(['designer (anthropic first in its chain)', '3D critique (the designer chain, anthropic)']);
    });
    env({ ...FREE, DESIGNER_PROVIDER: 'anthropic,gemini', ANTHROPIC_API_KEY: 'sk-test', PAID_AI: 'off' }, () => {
      expect(() => loadProviders()).toThrow(/PAID_AI=off.*designer/);
    });
    env({ ...FREE, PAID_AI: 'off' }, () => { expect(paidAiJobs(loadProviders())).toEqual([]); });
  });
  it('the health check lists paid AI jobs (none in the test configuration)', async () => {
    expect((await h.ok(null, 'GET', '/health')).paidAi).toEqual([]);
  });

  for (const [name, status] of [['quota exhausted', 429], ['server error', 503]] as const) {
    it(`${name}: the local assistant and engine answer, the brief is untouched, and nothing paid is called`, async () => {
      watchNetwork();
      const calls: string[] = [];
      (h.services as { builder: unknown }).builder = createGeminiBuilder({ apiKey: 'k', model: 'gemini-a,gemini-b', warn: () => {},
        fetch: (async (url: unknown) => { calls.push(String(url)); return new Response(JSON.stringify({ error: { code: 'x' } }), { status }); }) as typeof fetch });
      const r = await talk(10, { message: 'how much will this house cost to build', plot: P60, brief: family, project });
      expect(r).toMatchObject({ source: 'local', reason: 'unavailable', route: 'calculate:budget' });
      expect(r.reply).toMatch(/likely to cost about/);
      expect(r.plot).toBeUndefined();
      expect(r.brief).toBeUndefined();
      // Both Gemini models were tried, then BuildWise answered itself: no other host was contacted.
      expect(calls.length).toBe(2);
      expect(calls.every((u) => u.includes('generativelanguage.googleapis.com'))).toBe(true);
      expect(outgoing).toEqual([]);
    });
  }
  it('a timeout falls back the same way', async () => {
    watchNetwork();
    (h.services as { builder: unknown }).builder = createGeminiBuilder({ apiKey: 'k', model: 'gemini-a', warn: () => {}, timeoutMs: 20,
      fetch: ((_u: unknown, init: { signal: AbortSignal }) => new Promise((_ok, bad) => { init.signal.addEventListener('abort', () => bad(new DOMException('timed out', 'TimeoutError'))); })) as unknown as typeof fetch });
    const r = await talk(11, { message: 'what size of solar system do i need for it', plot: P60, brief: family, project });
    expect(r).toMatchObject({ source: 'local', reason: 'unavailable', route: 'calculate:energy' });
    expect(r.reply).toMatch(/kWh a day/);
    expect(outgoing).toEqual([]);
  });
});

describe('the held-out conversation: three designs for a family home, then a smaller plot that keeps the gym', () => {
  it('with no model: the local assistant routes to the engine, keeps the brief, and offers a checked revision', async () => {
    const first = await talk(20, { message: 'show me three designs for a family home', plot: P60, brief: family, project });
    expect(first).toMatchObject({ source: 'local', route: 'design' });
    expect(first.reply).toMatch(/3 checked concepts fit/);
    expect((first.reply.match(/^- \*\*/gm) ?? []).length).toBe(3);

    const second = await talk(20, { message: 'make the plot smaller but keep the gym', plot: P60, brief: family, project, history: [{ role: 'user', text: 'show me three designs for a family home' }, { role: 'assistant', text: first.reply }] });
    expect(second).toMatchObject({ source: 'local', route: 'revise', intent: 'build_home' });
    // What changed, and what was kept.
    expect(second.proposal.plot.widthM * second.proposal.plot.depthM).toBeLessThan(P60.widthM * P60.depthM);
    expect(second.proposal.kept).toContain('gym');
    expect(second.proposal.brief.features ?? family.features).toContain('gym');
    expect(second.reply).toMatch(/gym/);
    expect(second.reply).toMatch(/Apply/);
    // The chat proposes; it never changes the project itself.
    expect(second.plot).toBeUndefined();
    expect(second.brief).toBeUndefined();
  });

  it('with a model: it gets the brief and the local reading, calls the right tools, and the revision keeps the gym', async () => {
    const seen: { message: string; tools: string[] }[] = [];
    const results: Record<string, any>[] = [];
    (h.services as { builder: unknown }).builder = {
      live: true, model: 'fake-gemini',
      chat: async (input: { message: string; tools: { name: string }[]; runTool: (n: string, i: unknown) => Promise<unknown> }) => {
        seen.push({ message: input.message, tools: input.tools.map((t) => t.name) });
        const local = JSON.parse(input.message.match(/<local_reading>(.*)<\/local_reading>/s)![1]!);
        // A model that follows the routing hint, as the prompt tells it to.
        const out = local.suggestedTool === 'revise'
          ? await input.runTool('revise_design', { smaller: local.revision.smaller, keep: local.revision.keep })
          : await input.runTool('generate_designs', {});
        results.push(out as Record<string, any>);
        return { text: 'explained', stopReason: 'completed', toolCalls: 1, model: 'fake-gemini' };
      },
    };
    const first = await talk(21, { message: 'show me three designs for a family home', plot: P60, brief: family, project });
    expect(first).toMatchObject({ source: 'ai', route: 'design' });
    expect(seen[0]!.tools).toEqual(['calculate', 'generate_designs', 'revise_design']);
    const ctx = JSON.parse(seen[0]!.message.match(/<project_context>\n(.*)\n<\/project_context>/s)![1]!);
    expect(ctx.preferences).toMatchObject({ purpose: 'Family home', taste: 'Tropical & open', priorities: ['Bigger garden'] });
    expect(ctx.brief).toMatchObject({ bedrooms: 4, features: ['gym'] });
    // Three checked options, each with a different measured reason and a trade-off.
    expect(results[0]!.options).toHaveLength(3);
    expect(new Set(results[0]!.options.map((o: { reasonToChoose: string }) => o.reasonToChoose.split(':')[0])).size).toBe(3);
    for (const o of results[0]!.options) expect(o.rooms.some((x: string) => /^Gym/.test(x))).toBe(true);

    const second = await talk(21, { message: 'make the plot smaller but keep the gym', plot: P60, brief: family, project });
    expect(second).toMatchObject({ source: 'ai', route: 'revise' });
    const ctx2 = JSON.parse(seen[1]!.message.match(/<project_context>\n(.*)\n<\/project_context>/s)![1]!);
    expect(ctx2.brief).toMatchObject({ bedrooms: 4, features: ['gym'] }); // the brief is retained
    expect(results[1]).toMatchObject({ fits: true, kept: ['gym'], applyButtonShown: true });
    expect(results[1]!.plot.widthM * results[1]!.plot.depthM).toBeLessThan(P60.widthM * P60.depthM);
    expect(results[1]!.brief.features).toContain('gym');
    expect(results[1]!.designs.every((d: { rooms: string[] }) => d.rooms.some((x) => /^Gym/.test(x)))).toBe(true);
    expect(second.proposal).toMatchObject({ kept: ['gym'] });
  });

  it('a tighter budget protects what was asked for, or says plainly that nothing fits', async () => {
    const r = await talk(22, { message: 'we can only afford 40 million now, keep the four bedrooms', plot: P60, brief: { ...family, study: true, bq: true }, project });
    expect(r).toMatchObject({ source: 'local', route: 'revise' });
    expect(r.reply).toMatch(/within|Nothing comes/);
    if (r.proposal) { expect(r.proposal.kept).toContain('bedrooms'); expect(r.proposal.brief.bedrooms ?? 4).toBe(4); }
  });
});
