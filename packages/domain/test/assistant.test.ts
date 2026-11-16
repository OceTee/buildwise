import { describe, expect, it } from 'vitest';
import {
  SEED_EXAMPLES, SEED_KNOWLEDGE, SEED_TESTS, applyLexicon, buildBrain, classifyIntent, evaluateIntentModel, learnLexicon, redact, respond,
  searchKnowledge, indexKnowledge, trainIntentModel, type KnowledgeDoc,
} from '../src/index';

const model = trainIntentModel(SEED_EXAMPLES, '2026-01-01T00:00:00Z');
const brain = buildBrain(model, [], SEED_KNOWLEDGE);
const ask = (t: string, state = { plot: null, brief: {} }) => respond(brain, t, state);

describe('intent model', () => {
  it('classifies the held-out seed tests', () => {
    expect(evaluateIntentModel(model, SEED_TESTS).accuracy).toBeGreaterThanOrEqual(0.95);
  });
  it('is deterministic and serialisable', () => {
    const again = trainIntentModel(SEED_EXAMPLES, '2026-01-01T00:00:00Z');
    expect(JSON.stringify(again)).toBe(JSON.stringify(model));
    const restored = JSON.parse(JSON.stringify(model));
    expect(classifyIntent(restored, 'where can i buy cement').intent).toBe('shopping');
  });
  it('weights let confirmed examples teach new phrasing', () => {
    const phrase = 'abeg help me raise my structure';
    const taught = trainIntentModel([...SEED_EXAMPLES, { text: phrase, intent: 'build_home', weight: 3 }]);
    expect(classifyIntent(taught, 'help me raise my structure').intent).toBe('build_home');
  });
});

describe('assistant replies', () => {
  it('reads a home brief and asks for what is missing', () => {
    const r = ask('I want a 4 bedroom duplex with a study');
    expect(r.intent).toBe('build_home');
    expect(r.brief).toMatchObject({ bedrooms: 4, storeys: 2, study: true });
    expect(r.reply).toMatch(/How big is your land/);
    const r2 = ask('my land is 50 by 100 ft', { plot: null, brief: { bedrooms: 4 } });
    expect(r2.plot).toEqual({ widthM: 15.24, depthM: 30.48 });
    expect(r2.reply).toMatch(/pick a design/);
  });

  it('answers building questions from the knowledge base', () => {
    expect(ask('How many blocks can one bag of cement make?').knowledgeId).toBe('blocks-per-bag');
    expect(ask('what mix ratio for concrete?').knowledgeId).toBe('concrete-mix');
    expect(ask('do I need a building permit?').knowledgeId).toBe('permit');
    expect(ask('what is a setback').knowledgeId).toBe('setback');
  });

  it('notes building questions it cannot answer yet', () => {
    const r = ask('how often should I service a concrete mixer?');
    expect(r.intent).toBe('question');
    expect(r.unanswered).toBe(true);
  });

  it('stays inside its field', () => {
    for (const t of ['tell me a joke', 'who is messi', 'what is the weather in lagos', 'what is the price of a ps5?', 'write me a poem', 'what is quantum physics?']) {
      const r = ask(t);
      expect(r.intent, t).toBe('out_of_scope');
      expect(r.reply).toMatch(/only help with building/);
      expect(r.brief).toEqual({});
    }
  });

  it('handles small talk, shopping and other projects', () => {
    expect(ask('hello').intent).toBe('greeting');
    expect(ask('thank you').intent).toBe('thanks');
    expect(ask('where can I buy 9 inch blocks').intent).toBe('shopping');
    expect(ask('I want to build a fence').intent).toBe('other_project');
  });

  it('quotes platform prices when the knowledge base has them', () => {
    const price: KnowledgeDoc = { id: 'price-cement-bag', question: 'How much does cement cost per bag?', answer: 'On BuildWise right now, 12 live cement listings are priced per bag: typically ₦9,500.', tags: ['cement', 'price', 'cost', 'bag'], source: 'platform' };
    const b = buildBrain(model, [], [...SEED_KNOWLEDGE, price]);
    expect(respond(b, 'how much is a bag of cement?', { plot: null, brief: {} }).knowledgeId).toBe('price-cement-bag');
    expect(respond(b, 'where can i buy cement', { plot: null, brief: {} }).reply).toContain('₦9,500');
  });
});

describe('learning phrases from corrections', () => {
  const sig = (session: string, text: string, changes: Record<string, unknown>) => ({ session, text, changes });

  it('trusts a phrase only after several different people confirm the same meaning', () => {
    const two = learnLexicon([sig('a', 'a decking house', { storeys: 2 }), sig('b', 'decking house for me', { storeys: 2 })]);
    expect(two.find((e) => e.term === 'decking')).toBeUndefined();
    const three = learnLexicon([sig('a', 'a decking house', { storeys: 2 }), sig('b', 'decking house for me', { storeys: 2 }), sig('c', 'i want decking', { storeys: 2 })]);
    const e = three.find((x) => x.term === 'decking' && x.field === 'storeys')!;
    expect(e).toMatchObject({ value: 2, sessions: 3 });
    expect(applyLexicon('build me a decking', three)).toMatchObject({ storeys: 2 });
  });

  it('one person repeating themselves cannot teach it', () => {
    const spam = Array.from({ length: 50 }, () => sig('same', 'zzz house', { storeys: 2 }));
    expect(learnLexicon(spam).find((e) => e.term === 'zzz')).toBeUndefined();
  });

  it('ignores phrases that mean different things to different people', () => {
    const mixed = [sig('a', 'big house', { storeys: 2 }), sig('b', 'big house', { storeys: 1 }), sig('c', 'big house', { storeys: 2 }), sig('d', 'big house', { storeys: 1 })];
    expect(learnLexicon(mixed).find((e) => e.term === 'big' && e.field === 'storeys')).toBeUndefined();
  });

  it('learned phrases help the assistant, but explicit words still win', () => {
    const lex = learnLexicon(['a', 'b', 'c'].map((s) => sig(s, 'a decking house', { storeys: 2 })));
    const b = buildBrain(model, lex, SEED_KNOWLEDGE);
    expect(respond(b, 'a 3 bedroom decking house', { plot: null, brief: {} }).brief).toMatchObject({ storeys: 2 });
    expect(respond(b, 'a decking bungalow with 3 bedrooms', { plot: null, brief: {} }).brief).toMatchObject({ storeys: 1 });
  });
});

describe('knowledge search and privacy', () => {
  it('ranks the matching answer first and ignores generic overlap', () => {
    const ix = indexKnowledge(SEED_KNOWLEDGE);
    expect(searchKnowledge(ix, 'difference between 6 and 9 inch blocks')[0]!.doc.id).toBe('block-sizes');
    expect(searchKnowledge(ix, 'what time is it')).toEqual([]);
  });
  it('removes contact details before a message is stored', () => {
    expect(redact('call me on +234 801 234 5678 or mail ada@example.com')).toBe('call me on [number] or mail [email]');
  });
});
