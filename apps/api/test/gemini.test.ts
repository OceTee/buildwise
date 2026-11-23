import { describe, expect, it } from 'vitest';
import { PERSONA } from '../src/ai/persona.js';
import { createGeminiDesigner } from '../src/platform/designer.js';
import { createGeminiArchitect, createGeminiBrain, createGeminiBuilder } from '../src/platform/gemini.js';

/** A fake Interactions API: answers queued in order, every request recorded. */
function fakeGemini(answers: { status?: number; body: unknown }[]) {
  const requests: Record<string, any>[] = [];
  const fetch = (async (_url: string, init: { body: string; headers: Record<string, string> }) => {
    requests.push({ ...JSON.parse(init.body), key: init.headers['x-goog-api-key'] });
    const a = answers.shift() ?? { status: 500, body: { error: { code: 'none_left' } } };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, requests };
}
const output = (text: string, model = 'gemini-3.8-flash') => ({ body: { id: 'i1', status: 'completed', model, steps: [{ type: 'thought', summary: [] }, { type: 'model_output', content: [{ type: 'text', text }] }] } });
const quiet = () => {};

describe('Gemini as the Builder AI', () => {
  const tools = [{ name: 'calculate', description: 'Run a calculator.', input_schema: { type: 'object' as const, properties: { plan: { type: 'string', enum: ['energy'] }, overrides: { type: 'object', additionalProperties: true } }, required: ['plan'] } }];

  it('runs the tool loop statelessly, echoing the call id, on the model that answered first', async () => {
    const g = fakeGemini([
      { status: 429, body: { error: { code: 'RESOURCE_EXHAUSTED' } } },
      { body: { status: 'requires_action', model: 'gemini-3.6-flash', steps: [{ type: 'thought', summary: [], signature: 'sig' }, { type: 'function_call', id: 'call-1', name: 'calculate', arguments: { plan: 'energy' } }] } },
      output('About 12 kWh a day; a 5 kW solar array covers the essentials.', 'gemini-3.6-flash'),
    ]);
    const ran: unknown[] = [];
    const b = createGeminiBuilder({ apiKey: 'k', model: 'gemini-3.8-flash,gemini-3.6-flash', fetch: g.fetch, warn: quiet });
    const out = await b.chat({ system: 'TASK PROMPT', history: [{ role: 'user', text: 'hi' }, { role: 'assistant', text: 'Hello!' }], message: 'How much power will I use?', tools, runTool: async (name, input) => { ran.push({ name, input }); return { dailyKwh: 12 }; } });
    expect(out).toMatchObject({ text: expect.stringMatching(/12 kWh/), toolCalls: 1, model: 'gemini-3.6-flash' });
    expect(ran).toEqual([{ name: 'calculate', input: { plan: 'energy' } }]);
    // The busy model was skipped; the loop then stayed on the model that answered.
    expect(g.requests.map((r) => r.model)).toEqual(['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.6-flash']);
    for (const r of g.requests) {
      expect(r.store).toBe(false);
      expect(r.system_instruction.startsWith(PERSONA)).toBe(true);
      expect(r.system_instruction).toContain('TASK PROMPT');
      expect(r.tools[0]).toMatchObject({ type: 'function', name: 'calculate' });
      expect(JSON.stringify(r.tools)).not.toContain('additionalProperties');
    }
    const last = g.requests[2]!.input as Record<string, any>[];
    expect(last.map((st) => st.type)).toEqual(['user_input', 'model_output', 'user_input', 'thought', 'function_call', 'function_result']);
    expect(last[3]!.signature).toBe('sig');
    expect(last[5]).toMatchObject({ type: 'function_result', call_id: 'call-1', name: 'calculate', result: [{ type: 'text', text: '{"dailyKwh":12}' }] });
  });

  it('gives up (so the local assistant answers) when every model fails or a tool loop runs on', async () => {
    const down = fakeGemini([{ status: 503, body: {} }, { status: 503, body: {} }]);
    expect(await createGeminiBuilder({ apiKey: 'k', model: 'a,b', fetch: down.fetch, warn: quiet }).chat({ system: '', history: [], message: 'x', tools, runTool: async () => ({}) })).toBeNull();
    const call = { body: { status: 'requires_action', steps: [{ type: 'function_call', id: 'c', name: 'calculate', arguments: { plan: 'energy' } }] } };
    const loop = fakeGemini([call, call, call]);
    expect(await createGeminiBuilder({ apiKey: 'k', model: 'a', fetch: loop.fetch, warn: quiet }).chat({ system: '', history: [], message: 'x', tools, runTool: async () => ({}), maxSteps: 3 })).toBeNull();
  });
});

describe('Gemini as the AI architect', () => {
  const input = { market: 'Nigeria', climate: 'hot humid', plot: { widthM: 15, depthM: 30 }, brief: {}, designs: [] };
  const review = {
    overview: 'Build the Central hall.', order: ['a', 'b'],
    reviews: [{ id: 'a', score: 140, highlights: ['Good light.'], considerations: ['Long hall.'] }],
    concept: { designId: 'a', title: 'The Courtyard House', story: 'You arrive under a deep porch.', moves: ['A forward living wing.'], palette: { walls: 'White render', accents: 'Timber louvres', roof: 'Charcoal tiles' } },
  };
  it('returns a checked, trimmed review', async () => {
    const g = fakeGemini([output(JSON.stringify(review))]);
    const r = await createGeminiArchitect({ apiKey: 'k', model: 'm', fetch: g.fetch, warn: quiet }).review(input);
    expect(r).toMatchObject({ order: ['a', 'b'], reviews: { a: { score: 100 } }, concept: { title: 'The Courtyard House' } });
    expect(g.requests[0]!.response_format).toMatchObject({ mime_type: 'application/json' });
    expect(g.requests[0]!.system_instruction.startsWith(PERSONA)).toBe(true);
  });
  it('returns null for an answer that does not match the schema', async () => {
    const g = fakeGemini([output('{"overview":"x"}')]);
    expect(await createGeminiArchitect({ apiKey: 'k', model: 'm', fetch: g.fetch, warn: quiet }).review(input)).toBeNull();
  });
});

describe('Gemini as the live brain', () => {
  const read = (fetch: typeof globalThis.fetch) => createGeminiBrain({ apiKey: 'k', model: 'm', fetch, warn: quiet }, 'BRAIN TASK').read({ message: 'i wan build 4 bedroom duplex for 60 by 120', state: { plot: null, brief: {} }, local: { intent: 'build_home', plot: null, brief: {} } });

  it('returns the reading with the brief normalised and the plot checked', async () => {
    const g = fakeGemini([output(JSON.stringify({ intent: 'build_home', reply: 'A four-bedroom duplex on 60 by 120 ft.', plotWidthM: 18.29, plotDepthM: 36.58, brief: { type: 'duplex', storeys: 2, bedrooms: 4 } }))]);
    expect(await read(g.fetch)).toMatchObject({ intent: 'build_home', plot: { widthM: 18.29, depthM: 36.58 }, brief: { type: 'duplex', storeys: 2, bedrooms: 4 }, model: 'gemini-3.8-flash' });
    expect(g.requests[0]!.input).toContain('<message>i wan build 4 bedroom duplex for 60 by 120</message>');
    expect(g.requests[0]!.system_instruction).toContain('BRAIN TASK');
  });
  it('drops the plot and brief unless it is a build, and rejects malformed answers', async () => {
    const q = fakeGemini([output(JSON.stringify({ intent: 'question', reply: 'Typically 1:2:4.', plotWidthM: 0, plotDepthM: 0, brief: { bedrooms: 3 } }))]);
    expect(await read(q.fetch)).toMatchObject({ intent: 'question', plot: null, brief: {} });
    const bad = fakeGemini([output(JSON.stringify({ intent: 'build_a_rocket', reply: 'x', plotWidthM: 0, plotDepthM: 0, brief: {} }))]);
    expect(await read(bad.fetch)).toBeNull();
  });
});

describe('Gemini as the designer that can see', () => {
  it('sends the 3D snapshot with the prompt for a critique', async () => {
    const g = fakeGemini([output('{"rooms":[]}')]);
    const d = createGeminiDesigner({ apiKey: 'k', model: 'm', fetch: g.fetch, warn: quiet });
    expect(await d.critique!({ system: 's', prompt: 'Look at this design.', schema: { type: 'object' }, image: { mediaType: 'image/jpeg', data: 'BASE64' } })).toEqual({ rooms: [] });
    expect(g.requests[0]!.input).toEqual([{ type: 'text', text: 'Look at this design.' }, { type: 'image', data: 'BASE64', mime_type: 'image/jpeg' }]);
    expect(g.requests[0]!.store).toBe(false);
  });
});

describe('Gemini chat replies in the app\'s formatting', () => {
  it('turns "*" bullets into "- " lists and headings into bold lines', async () => {
    const { tidyReply } = await import('../src/platform/gemini.js');
    expect(tidyReply('## Daily use\n* **41.7 kWh** a day\n  * essentials 5.5 kWh\n\n\n\nDone.')).toBe('**Daily use**\n- **41.7 kWh** a day\n  - essentials 5.5 kWh\n\nDone.');
  });
});
