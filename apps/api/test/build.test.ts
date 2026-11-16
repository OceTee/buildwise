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
