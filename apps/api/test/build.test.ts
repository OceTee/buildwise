import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SEED_TESTS, billOfMaterials, generateDesigns, uuidv7 } from '@bw/domain';
import { trainAssistant } from '../src/modules/assistant.js';
import { harness } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
beforeAll(async () => { h = await harness(); });
afterAll(async () => { await h?.close(); });

/** A visitor: requests carry a device id through the trusted web proxy headers, like the real website. */
const visitor = (n: number) => ({ 'x-internal-secret': h.services.config.internalSecret, 'x-client-ip': `10.9.0.${n}`, 'x-device-id': `device-${String(n).padStart(4, '0')}` });
const say = (n: number, message: string, extra: Record<string, unknown> = {}) => h.ok(null, 'POST', '/v1/build/interpret', { message, ...extra }, visitor(n));
const sys = <T>(q: string, p: unknown[] = []) => h.services.db.tx({ kind: 'system' }, (sql) => sql.query<T>(q, p));

describe('the BuildWise assistant (local model, no external AI)', () => {
  it('serves the design rules and the current model', async () => {
    const c = await h.ok(null, 'GET', '/v1/build/config');
    expect(c.design.setbacksM.front).toBeGreaterThan(0);
    expect(c.assistant).toMatchObject({ accuracy: expect.any(Number) });
    expect(c.assistant.accuracy).toBeGreaterThanOrEqual(0.95);
  });

  it('reads the plot and brief, answers building questions, and stays in scope', async () => {
    const r = await say(1, 'A 4 bedroom duplex with a study on 50 by 100 ft');
    expect(r).toMatchObject({ intent: 'build_home', plot: { widthM: 15.24, depthM: 30.48 }, brief: { bedrooms: 4, storeys: 2, study: true } });
    expect(r.messageId).toBeTruthy();
    expect((await say(1, 'how many blocks can a bag of cement make?')).knowledgeId).toBe('blocks-per-bag');
    const off = await say(1, 'tell me a joke');
    expect(off.intent).toBe('out_of_scope');
    expect(off.reply).toMatch(/only help with building/);
  });

  it('stores messages redacted, against an anonymous session', async () => {
    const r = await say(2, 'call me on 08012345678 about a 3 bedroom bungalow');
    const row = (await sys<{ text: string; session: string }>(`select text, session from assistant_messages where id = $1`, [r.messageId])).rows[0]!;
    expect(row.text).toBe('call me on [number] about a 3 bedroom bungalow');
    expect(row.session).toMatch(/^[0-9a-f]{32}$/);
  });

  it('only the same session can report what happened next', async () => {
    const r = await say(3, 'a 3 bedroom bungalow');
    expect((await h.ok(null, 'POST', '/v1/build/feedback', { messageId: r.messageId, outcome: 'shopped' }, visitor(4))).recorded).toBe(false);
    expect((await h.ok(null, 'POST', '/v1/build/feedback', { messageId: r.messageId, outcome: 'proceeded', changes: { parking: 2 } }, visitor(3))).recorded).toBe(true);
    const row = (await sys<{ outcome: string; confirmed_intent: string; changes: unknown }>(`select outcome, confirmed_intent, changes from assistant_messages where id = $1`, [r.messageId])).rows[0]!;
    expect(row).toMatchObject({ outcome: 'proceeded', confirmed_intent: 'build_home' });
    expect(h.app.inject).toBeTruthy();
    const bad = await h.call(null, 'POST', '/v1/build/feedback', { messageId: r.messageId, changes: { evil: 'x' } }, visitor(3));
    expect(bad.status).toBe(400);
  });
});

describe('learning from the platform', () => {
  it('learns a local phrase once three different people confirm what it means', async () => {
    for (const n of [11, 12, 13]) {
      const r = await say(n, 'I want a decking house with 3 bedrooms');
      // The assistant does not know "decking" yet, so each person sets two storeys by hand and continues.
      expect(r.brief.storeys).toBeUndefined();
      await h.ok(null, 'POST', '/v1/build/feedback', { messageId: r.messageId, outcome: 'proceeded', changes: { storeys: 2 } }, visitor(n));
    }
    const report = await trainAssistant(h.services, { force: true });
    expect(report!.phrases).toBeGreaterThan(0);
    const after = await say(14, 'a decking house please');
    expect(after.brief.storeys).toBe(2);
  });

  it('turns live listing prices into answers', async () => {
    const mod = await h.signIn('Mod L', { staff: 'moderator' });
    const seller = await h.veteranBusiness(await h.signIn('Seller L'), 'Learning Supplies');
    await h.liveListing(seller, mod, { title: 'Dangote cement 42.5 bag', price: '9800' });
    await h.liveListing(seller, mod, { title: 'Portland cement 42.5 bags', price: '9200' });
    await trainAssistant(h.services, { force: true });
    const r = await say(20, 'how much does cement cost per bag?');
    expect(r.knowledgeId).toBe('price-cement-bag');
    expect(r.reply).toMatch(/live cement listings are priced per bag: typically/);
  });

  it('staff answers unanswered questions, and the assistant uses the answer', async () => {
    const q = await say(21, 'how often should I service a concrete mixer?');
    expect(q.intent).toBe('question');
    const ops = await h.signIn('Ops A', { staff: 'ops_admin' });
    const admin = await h.ok(ops.token, 'GET', '/v1/admin/assistant');
    expect(admin.unanswered.some((m: any) => m.id === q.messageId)).toBe(true);
    await h.ok(ops.token, 'POST', '/v1/admin/assistant/knowledge', {
      question: 'How often should a concrete mixer be serviced?', answer: 'Clean the drum after every use and service the engine every 100 hours or as the maker says.',
      tags: ['concrete mixer', 'mixer', 'service', 'maintenance'], answersMessageId: q.messageId,
    });
    const again = await say(21, 'how often should I service my concrete mixer?');
    expect(again.knowledgeId).toMatch(/^staff-/);
    const anon = await h.call(null, 'GET', '/v1/admin/assistant');
    expect(anon.status).toBe(401);
  });

  it('a retrain that would make it worse is rejected (poisoning guard)', async () => {
    const before = (await h.ok(null, 'GET', '/v1/build/config')).assistant;
    // Twenty "sessions" try to teach it that every held-out test message is off-topic.
    await h.services.db.tx({ kind: 'system' }, async (sql) => {
      for (let sIdx = 0; sIdx < 20; sIdx++) for (const t of SEED_TESTS) {
        await sql.query(`insert into assistant_messages (id, session, text, intent, confidence, confirmed_intent, label_source) values ($1, $2, $3, 'build_home', 0.5, 'out_of_scope', 'outcome')`, [uuidv7(), `poison-${sIdx}`, t.text]);
      }
    });
    const report = await trainAssistant(h.services, { force: true });
    expect(report!.promoted).toBe(false);
    expect(report!.note).toMatch(/kept the previous model/);
    const after = (await h.ok(null, 'GET', '/v1/build/config')).assistant;
    expect(after.accuracy).toBeGreaterThanOrEqual(before.accuracy - 0.02);
    expect((await say(30, 'where can i buy blocks')).intent).toBe('shopping');
  });
});

describe('sourcing', () => {
  it('prices material lines from live listings, cheapest comparable offer first', async () => {
    const mod = await h.signIn('Mod B', { staff: 'moderator' });
    const seller = await h.veteranBusiness(await h.signIn('Seller B'), 'Build Supplies');
    await h.liveListing(seller, mod, { title: 'Cheapest cement 42.5 bags', price: '9000' });
    const r = await h.ok(null, 'POST', '/v1/build/sourcing', {
      items: [
        { key: 'cement', name: 'Cement (50 kg bags)', unit: 'bag', quantity: 10, shop: { category: 'cement', q: 'cement' } },
        { key: 'unobtainium', name: 'Something nobody sells', unit: 'piece', quantity: 2, shop: { q: 'zzzz nothing' } },
      ],
    });
    const cement = r.lines.find((l: any) => l.key === 'cement');
    expect(cement.offers[0].price.amountMinor).toBe('900000');
    expect(cement.offers[0].lineTotal.amountMinor).toBe('9000000');
    expect(r.lines.find((l: any) => l.key === 'unobtainium').offers).toEqual([]);
    expect(r.pricedLines).toBe(1);
  });

  it('accepts a full bill of materials from a generated design', async () => {
    const d = generateDesigns({ widthM: 15.24, depthM: 30.48 }, { bedrooms: 3 }).designs[0]!;
    const items = billOfMaterials(d).map(({ key, name, unit, quantity, shop }) => ({ key, name, unit, quantity, shop }));
    const r = await h.ok(null, 'POST', '/v1/build/sourcing', { items });
    expect(r.lines).toHaveLength(items.length);
  });
});

describe('the AI architect (optional; the engine is the default)', () => {
  const plot = { widthM: 18.29, depthM: 36.58 };
  const brief = { bedrooms: 3 };
  const ask = (n: number) => h.ok(null, 'POST', '/v1/build/architect', { plot, brief }, visitor(n));
  const restore = () => { (h.services as { architect: unknown }).architect = { live: false, model: 'engine', review: async () => null }; };

  it('without a connected AI, returns the engine ranking and makes no call', async () => {
    const r = await ask(40);
    expect(r).toMatchObject({ source: 'engine', reason: 'not_connected' });
    expect(r.order).toEqual(generateDesigns(plot, brief).designs.map((d) => d.id));
    expect((await h.ok(null, 'GET', '/v1/build/config')).architect).toEqual({ connected: false });
  });

  it('with an AI connected, reviews the server-generated designs once and caches the answer', async () => {
    const ids = generateDesigns(plot, brief).designs.map((d) => d.id);
    const seen: unknown[] = [];
    (h.services as { architect: unknown }).architect = {
      live: true, model: 'test-architect',
      async review(input: { designs: { id: string; rooms: unknown[] }[]; climate: string }) {
        seen.push(input);
        return {
          overview: 'Build the second one.',
          order: [ids[1]!, 'made-up-id', ids[0]!],
          reviews: { [ids[1]!]: { score: 91, highlights: ['Good breeze through every bedroom.'], considerations: ['Shade the west windows.'] }, 'made-up-id': { score: 1, highlights: ['x'], considerations: ['y'] } },
        };
      },
    };
    try {
      const r = await ask(41);
      expect(r).toMatchObject({ source: 'ai', model: 'test-architect', cached: false, overview: 'Build the second one.' });
      // Ids it invented are dropped; its notes are kept for designs we generated.
      expect(r.order).toEqual([ids[1], ids[0]]);
      expect(Object.keys(r.reviews)).toEqual([ids[1]]);
      // It was given numbers we produced, never the client's designs.
      const input = seen[0] as { designs: { id: string; rooms: unknown[] }[]; climate: string };
      expect(input.designs.map((d) => d.id)).toEqual(ids);
      expect(input.designs[0]!.rooms.length).toBeGreaterThan(3);
      expect(input.climate).toMatch(/tropical/);
      // The same plot and brief again: served from the cache, no second call.
      const again = await ask(42);
      expect(again).toMatchObject({ source: 'ai', cached: true });
      expect(seen).toHaveLength(1);
    } finally { restore(); }
  });

  it('presents a hotel as a named concept, with the town it is in, and drops concepts for unknown designs', async () => {
    const hotel = { type: 'hotel' as const, storeys: 4, units: 8, features: ['restaurant' as const] };
    const big = { widthM: 30, depthM: 40 };
    const ids = generateDesigns(big, hotel).designs.map((d) => d.id);
    const seen: { location?: string; designs: { buildingType: string }[] }[] = [];
    const concept = (designId: string) => ({ designId, title: 'The Garden Hotel', story: 'Guests arrive under a shaded canopy into a bright lobby.', moves: ['A central corridor serves every room.', 'The restaurant faces the street.'], palette: { walls: 'White render', accents: 'Bronze frames', roof: 'Charcoal standing seam' } });
    (h.services as { architect: unknown }).architect = {
      live: true, model: 'test-architect',
      async review(input: { location?: string; designs: { buildingType: string }[] }) {
        seen.push(input);
        return { overview: 'The first.', order: ids, reviews: {}, concept: concept(seen.length === 1 ? ids[0]! : 'made-up') };
      },
    };
    try {
      const r = await h.ok(null, 'POST', '/v1/build/architect', { plot: big, brief: hotel, location: 'Ibadan, Oyo' }, visitor(45));
      expect(r.concept).toMatchObject({ designId: ids[0], title: 'The Garden Hotel' });
      expect(seen[0]!.location).toBe('Ibadan, Oyo');
      expect(seen[0]!.designs[0]!.buildingType).toBe('Hotel');
      const other = await h.ok(null, 'POST', '/v1/build/architect', { plot: big, brief: hotel, location: 'Lagos' }, visitor(46));
      expect(other.concept).toBeUndefined();
      const bad = await h.call(null, 'POST', '/v1/build/architect', { plot: big, brief: hotel, location: 'call 080<script>' }, visitor(47));
      expect(bad.status).toBe(400);
    } finally { restore(); }
  });

  it('falls back to the engine when the AI fails or declines', async () => {
    (h.services as { architect: unknown }).architect = { live: true, model: 'broken', review: async () => { throw new Error('upstream down'); } };
    try {
      expect(await h.ok(null, 'POST', '/v1/build/architect', { plot: { widthM: 15.24, depthM: 30.48 }, brief: { bedrooms: 2 } }, visitor(43))).toMatchObject({ source: 'engine', reason: 'unavailable' });
    } finally { restore(); }
  });

  it('rejects an impossible plot', async () => {
    const r = await h.call(null, 'POST', '/v1/build/architect', { plot: { widthM: 2, depthM: 3 }, brief: {} }, visitor(44));
    expect(r.status).toBe(400);
  });
});

describe('ready-made house plans from architects', () => {
  const attrs = (bedrooms: number, storeys: string, w: number, d: number) => ({ bedrooms, storeys, floor_area_m2: 120, min_plot_width_m: w, min_plot_depth_m: d, drawings_included: 'Architectural set', architect_registration: 'X-1', rights_confirmed: true });
  const body = (title: string, a: Record<string, unknown>) => ({ categorySlug: 'house-plans', title, description: 'A ready-made plan with elevations and sections.', attributes: a, unit: 'set', price: '300000' });

  it('shows live plans that fit the plot, closest to the brief first', async () => {
    const mod = await h.signIn('Plans moderator', { staff: 'moderator' });
    const seller = await h.veteranBusiness(await h.signIn('Plan Studio owner'), 'Plan Studio');
    // A seller must declare they hold the rights to sell the plans.
    const draft = await h.ok(seller.token, 'POST', '/v1/listings', h.cementBody([await h.photo(seller.token, seller.orgId)], { orgId: seller.orgId, ...body('Plan without the rights confirmed', { ...attrs(3, '1', 10, 20), rights_confirmed: false }) }));
    const bad = await h.call(seller.token, 'POST', `/v1/listings/${draft.id}/submit`, { expectedVersion: draft.version });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(bad.body)).toMatch(/Confirm/);

    const fits = await h.liveListing(seller, mod, body('Three bedroom bungalow plan', attrs(3, '1', 12, 24)));
    const bigger = await h.liveListing(seller, mod, body('Four bedroom duplex plan', attrs(4, '2', 15, 30)));
    const tooBig = await h.liveListing(seller, mod, body('Large villa plan for wide plots', attrs(3, '1', 20, 40)));
    for (const l of [fits, bigger, tooBig]) expect(l.status).toBe('live');

    const r = await h.ok(null, 'GET', '/v1/build/plans?widthM=15.24&depthM=30.48&bedrooms=3&storeys=1');
    expect(r.items.map((x: { id: string }) => x.id)).toEqual([fits.id, bigger.id]);
    expect(r.items[0]).toMatchObject({ title: 'Three bedroom bungalow plan', plan: { bedrooms: 3, storeys: 1, minPlot: { widthM: 12, depthM: 24 } }, sellerName: 'Plan Studio' });
    expect(r.items[0].path).toMatch(/^\/listing\//);
  });
});

describe('the Builder AI conversation', () => {
  const plot = { widthM: 15.24, depthM: 30.48 };
  const talk = (n: number, body: Record<string, unknown>) => h.ok(null, 'POST', '/v1/build/chat', body, visitor(n));
  const off = () => { (h.services as { builder: unknown }).builder = { live: false, model: 'local', chat: async () => null }; };

  it('without a connected model, the local assistant answers (and never changes the project)', async () => {
    const r = await talk(60, { message: 'A 3 bedroom bungalow on 50 by 100 ft' });
    expect(r).toMatchObject({ source: 'local', reason: 'not_connected', intent: 'build_home' });
    expect(r.plot).toBeUndefined();
    expect(r.brief).toBeUndefined();
    expect(r.messageId).toBeTruthy();
    expect((await h.ok(null, 'GET', '/v1/build/config')).builderAi).toEqual({ connected: false });
  });

  it('with a model: it sees the project and answers questions with the calculators, without changing anything', async () => {
    const seen: { system: string; message: string; tools: { name: string }[] }[] = [];
    let calc: Record<string, any> | null = null;
    (h.services as { builder: unknown }).builder = {
      live: true, model: 'test-builder',
      async chat(input: { system: string; message: string; tools: { name: string }[]; runTool: (n: string, i: unknown) => Promise<unknown> }) {
        seen.push(input);
        calc = await input.runTool('calculate', { plan: 'energy', overrides: { solar: true, solarCover: 'essential' } }) as Record<string, any>;
        const hotel = await input.runTool('generate_designs', { brief: { type: 'hotel', storeys: 4, units: 8 }, plot: { widthM: 30, depthM: 40 } }) as Record<string, any>;
        expect(hotel.designs.length).toBeGreaterThan(0);
        const gone = await input.runTool('update_project', { brief: { study: true } }) as Record<string, any>;
        expect(gone.error).toMatch(/Unknown tool/);
        return { text: 'A 3-bedroom bungalow fits well. Where is the plot?', stopReason: 'end_turn', toolCalls: 3, model: 'test-builder' };
      },
    };
    try {
      const r = await talk(61, { message: 'I want a modern 3 bedroom house with a study, call me on 08012345678', plot, brief: { bedrooms: 3 }, step: 'brief', history: [{ role: 'user', text: 'hello' }, { role: 'assistant', text: 'Hi! What would you like to build?' }] });
      expect(r).toMatchObject({ source: 'ai', model: 'test-builder', reply: /Where is the plot/, promptVersion: 'builder-ai.v2' });
      expect(r.brief).toBeUndefined();
      expect(r.updates).toBeUndefined();
      // The model saw the master prompt, the project context with the design, and a redacted message.
      const s0 = seen[0]!;
      expect(s0.system).toMatch(/BUILDER AI/);
      expect(s0.system).toMatch(/Numbers come from tools/);
      expect(s0.message).toMatch(/<project_context>/);
      expect(s0.message).toMatch(/"grossFloorM2"/);
      expect(s0.message).not.toMatch(/08012345678/);
      expect(s0.tools.map((t) => t.name)).toEqual(['calculate', 'generate_designs']);
      expect(s0.system).toMatch(/Your job: answer questions/);
      // The calculator ran for real, with the what-if override.
      expect(calc!.result.solar.panels).toBeGreaterThan(0);
      expect(calc!.steps.length).toBeGreaterThan(3);
    } finally { off(); }
  });

  it('falls back to the local assistant when the model fails', async () => {
    (h.services as { builder: unknown }).builder = { live: true, model: 'broken', chat: async () => { throw new Error('upstream down'); } };
    try {
      expect(await talk(62, { message: 'how many blocks can a bag of cement make?' })).toMatchObject({ source: 'local', reason: 'unavailable' });
    } finally { off(); }
  });
});

describe('the live brain (Gemini) behind the assistant', () => {
  const noBrain = { live: false, model: 'local', read: async () => null };
  afterAll(() => { (h.services as { brain: unknown }).brain = noBrain; });

  it('answers live, sends only redacted text, keeps the local reading as fallback, and records a teacher label', async () => {
    const seen: { message: string; local: { intent: string } }[] = [];
    (h.services as { brain: unknown }).brain = {
      live: true, model: 'gemini-test',
      read: async (input: { message: string; local: { intent: string } }) => {
        seen.push(input);
        return { intent: 'build_home', reply: 'A three-storey block with two flats a floor. How big is your land?', plot: null, brief: { type: 'apartments', storeys: 3, units: 2, style: 'tropical' }, model: 'gemini-test' };
      },
    };
    const r = await say(41, 'abeg i wan build 6 flats for 3 floors with deep eaves and verandas, call me 08012345678');
    expect(r).toMatchObject({ source: 'ai', model: 'gemini-test', intent: 'build_home', reply: expect.stringMatching(/How big is your land/), brief: { type: 'apartments', storeys: 3, units: 2 } });
    expect(seen[0]!.message).not.toContain('08012345678');
    expect(seen[0]!.local.intent).toBeTruthy();
    const row = (await sys<{ teacher_intent: string; teacher_model: string; teacher_changes: Record<string, unknown> | null }>(`select teacher_intent, teacher_model, teacher_changes from assistant_messages where id = $1`, [r.messageId])).rows[0]!;
    expect(row).toMatchObject({ teacher_intent: 'build_home', teacher_model: 'gemini-test' });
    // Only what the brain read differently from the local rules is kept (here the style the rules have no word for).
    expect(row.teacher_changes).toMatchObject({ style: 'tropical' });
  });

  it('keeps a curated knowledge answer when both readings agree it is a question', async () => {
    (h.services as { brain: unknown }).brain = { live: true, model: 'gemini-test', read: async () => ({ intent: 'question', reply: 'About 35 blocks.', plot: null, brief: {}, model: 'gemini-test' }) };
    const r = await say(42, 'how many blocks can a bag of cement make?');
    expect(r).toMatchObject({ source: 'ai', intent: 'question', knowledgeId: 'blocks-per-bag' });
    expect(r.reply).toMatch(/50 kg bag/);
  });

  it('falls back to the local model when the brain fails or declines', async () => {
    (h.services as { brain: unknown }).brain = { live: true, model: 'gemini-test', read: async () => null };
    expect(await say(43, 'A 3 bedroom bungalow on 50 by 100 ft')).toMatchObject({ source: 'local', intent: 'build_home', brief: { bedrooms: 3 } });
    (h.services as { brain: unknown }).brain = { live: true, model: 'gemini-test', read: async () => { throw new Error('quota'); } };
    expect(await say(43, 'hello')).toMatchObject({ source: 'local', intent: 'greeting' });
  });

  it('retrains the local model on the brain\'s labels', async () => {
    await trainAssistant(h.services, { force: true });
    const m = (await sys<{ metrics: { taughtExamples?: number } }>(`select metrics from assistant_models order by id desc limit 1`)).rows[0]!;
    expect(m.metrics.taughtExamples).toBeGreaterThanOrEqual(1);
  });
});
