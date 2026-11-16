/**
 * The BuildWise assistant: a small, self-contained model that does exactly the build flow's jobs and nothing else.
 *
 *  - Intent: a multinomial naive Bayes classifier over word and word-pair features, trained on labelled examples
 *    (the seed set below plus examples confirmed by what people actually did on the platform).
 *  - Slots: the plot and the brief are read by explicit rules, plus a learned phrase list (for example "storey
 *    building" meaning two storeys) that only grows when several different people confirm the same meaning.
 *  - Knowledge: BM25 search over building questions and answers (seed answers, staff answers, and facts built from
 *    the platform's own data such as live prices).
 *  - Replies: fixed templates. Nothing is generated freely, and anything outside home building gets a polite no.
 *
 * Everything is deterministic and runs in a few milliseconds on the API server; no external AI service is used.
 */
import { normaliseBrief, parsePlotSize, readBriefText, type DesignBrief, type Plot } from './design';

// ---------------------------------------------------------------- text features

export type AssistantIntent = 'build_home' | 'other_project' | 'shopping' | 'question' | 'greeting' | 'thanks' | 'out_of_scope';
export const ASSISTANT_INTENTS: AssistantIntent[] = ['build_home', 'other_project', 'shopping', 'question', 'greeting', 'thanks', 'out_of_scope'];

/** Everyday words that say nothing about building: never enough on their own to count as in scope or to match an answer. */
const GENERIC = new Set(('what whats how why when where which who whom tell know get got make made give show find best good bad new old big small much many '
  + 'time today now day price prices cost costs cheap expensive buy sell help please thing things way ok okay yes no one two three '
  + 'four five six first last next more less most least lot lots kind type sort use used using work works go going come say said see look often always never usually much need needs').split(' '));

const STOP = new Set(('a an the and or but if of to in on at for with from by as is are was were be been am i me my we our you your it its this that these those '
  + 'there here so do does did can could would should will shall just very really please want wants need needs like would also some any about into than then').split(' '));

/** Lower-cased words; numbers become <num>; a few spelling variants are folded together. */
export function words(text: string): string[] {
  return text.toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/(\d)\s*(ft|feet|foot|m|metres?|meters?)\b/g, '$1 $2')
    .split(/[^a-z0-9<>]+/)
    .filter(Boolean)
    .map((w) => (/^\d+(\.\d+)?$/.test(w) ? '<num>' : w.replace(/^(storey|story|stories)$/, 'storey').replace(/^bedrooms?$/, 'bedroom').replace(/^bathrooms?$/, 'bathroom')));
}

/** Content words and adjacent word pairs: the classifier's features. */
export function features(text: string): string[] {
  const w = words(text);
  const content = w.filter((x) => !STOP.has(x));
  const pairs: string[] = [];
  for (let i = 0; i + 1 < w.length; i++) if (!(STOP.has(w[i]!) && STOP.has(w[i + 1]!))) pairs.push(`${w[i]}_${w[i + 1]}`);
  return [...content, ...pairs];
}

// ---------------------------------------------------------------- naive Bayes intent model

export interface TrainingExample { text: string; intent: AssistantIntent; weight?: number }

export interface IntentModel {
  version: number;
  trainedAt: string;
  labels: AssistantIntent[];
  docs: Record<string, number>;
  counts: Record<string, Record<string, number>>;
  totals: Record<string, number>;
  vocab: string[];
  examples: number;
  metrics?: { accuracy: number; tested: number };
}

export function trainIntentModel(examples: TrainingExample[], trainedAt = new Date().toISOString(), version = 1): IntentModel {
  const docs: Record<string, number> = {}; const counts: Record<string, Record<string, number>> = {}; const totals: Record<string, number> = {};
  const vocab = new Set<string>();
  for (const l of ASSISTANT_INTENTS) { docs[l] = 0; counts[l] = {}; totals[l] = 0; }
  for (const ex of examples) {
    const w = ex.weight ?? 1;
    docs[ex.intent] = (docs[ex.intent] ?? 0) + w;
    for (const f of features(ex.text)) {
      counts[ex.intent]![f] = (counts[ex.intent]![f] ?? 0) + w;
      totals[ex.intent] = (totals[ex.intent] ?? 0) + w;
      vocab.add(f);
    }
  }
  return { version, trainedAt, labels: ASSISTANT_INTENTS, docs, counts, totals, vocab: [...vocab].sort(), examples: examples.length };
}

export function classifyIntent(model: IntentModel, text: string): { intent: AssistantIntent; confidence: number; scores: Record<string, number> } {
  const f = features(text);
  const V = model.vocab.length + 1;
  const totalDocs = Object.values(model.docs).reduce((a, b) => a + b, 0) || 1;
  const logs: Record<string, number> = {};
  for (const l of model.labels) {
    let lp = Math.log(((model.docs[l] ?? 0) + 1) / (totalDocs + model.labels.length));
    const tot = model.totals[l] ?? 0;
    for (const x of f) lp += Math.log(((model.counts[l]?.[x] ?? 0) + 1) / (tot + V));
    logs[l] = lp;
  }
  const max = Math.max(...Object.values(logs));
  const exp = Object.fromEntries(Object.entries(logs).map(([k, v]) => [k, Math.exp(v - max)]));
  const sum = Object.values(exp).reduce((a, b) => a + b, 0);
  const scores = Object.fromEntries(Object.entries(exp).map(([k, v]) => [k, v / sum]));
  const intent = (Object.entries(scores).sort((a, b) => b[1] - a[1])[0]![0]) as AssistantIntent;
  return { intent, confidence: scores[intent]!, scores };
}

export function evaluateIntentModel(model: IntentModel, tests: TrainingExample[]): { accuracy: number; tested: number } {
  if (!tests.length) return { accuracy: 1, tested: 0 };
  const ok = tests.filter((t) => classifyIntent(model, t.text).intent === t.intent).length;
  return { accuracy: ok / tests.length, tested: tests.length };
}

// ---------------------------------------------------------------- learned phrases for the brief

export type BriefField = 'storeys' | 'bedrooms' | 'bathrooms' | 'ensuite' | 'kitchen' | 'study' | 'guestWc' | 'store' | 'parking' | 'style' | 'roof';
export interface LexiconEntry { term: string; field: BriefField; value: string | number | boolean; support: number; sessions: number; precision: number }

/** A phrase is trusted only when enough different people confirmed it, and it nearly always meant the same thing. */
export const LEXICON_RULES = { minSessions: 3, minPrecision: 0.75, maxEntries: 500 };

export function applyLexicon(text: string, lexicon: LexiconEntry[]): Partial<DesignBrief> {
  const f = new Set(features(text));
  const out: Record<string, unknown> = {};
  // Most specific (pairs) and best-supported first.
  for (const e of [...lexicon].sort((a, b) => Number(b.term.includes('_')) - Number(a.term.includes('_')) || b.sessions - a.sessions)) {
    if (f.has(e.term) && out[e.field] === undefined) out[e.field] = e.value;
  }
  return out as Partial<DesignBrief>;
}

/**
 * Builds the phrase list from correction signals: the words someone typed, and the brief values they then set by
 * hand. A phrase is linked to a value when it co-occurs across enough distinct sessions with high precision.
 */
export function learnLexicon(signals: { text: string; session: string; changes: Partial<Record<BriefField, unknown>> }[], rules = LEXICON_RULES): LexiconEntry[] {
  const pair = new Map<string, { field: BriefField; value: unknown; sessions: Set<string>; support: number }>();
  const termSessions = new Map<string, Set<string>>();
  for (const s of signals) {
    const terms = new Set(features(s.text).filter((t) => t !== '<num>' && !t.includes('<num>')));
    for (const t of terms) { const set = termSessions.get(t) ?? new Set(); set.add(s.session); termSessions.set(t, set); }
    for (const [field, value] of Object.entries(s.changes)) {
      if (value === undefined || value === null) continue;
      for (const t of terms) {
        const k = `${t}\u0000${field}\u0000${JSON.stringify(value)}`;
        const p = pair.get(k) ?? { field: field as BriefField, value, sessions: new Set<string>(), support: 0 };
        p.sessions.add(s.session); p.support++;
        pair.set(k, p);
      }
    }
  }
  const out: LexiconEntry[] = [];
  for (const [k, p] of pair) {
    const term = k.split('\u0000')[0]!;
    const seen = termSessions.get(term)?.size ?? 0;
    const precision = seen ? p.sessions.size / seen : 0;
    if (p.sessions.size >= rules.minSessions && precision >= rules.minPrecision) {
      out.push({ term, field: p.field, value: p.value as LexiconEntry['value'], support: p.support, sessions: p.sessions.size, precision: Math.round(precision * 100) / 100 });
    }
  }
  // One meaning per term and field: keep the best supported.
  const best = new Map<string, LexiconEntry>();
  for (const e of out) {
    const k = `${e.term}:${e.field}`;
    const cur = best.get(k);
    if (!cur || e.sessions > cur.sessions || (e.sessions === cur.sessions && e.precision > cur.precision)) best.set(k, e);
  }
  return [...best.values()].sort((a, b) => b.sessions - a.sessions).slice(0, rules.maxEntries);
}

// ---------------------------------------------------------------- knowledge search (BM25)

export interface KnowledgeDoc { id: string; question: string; answer: string; tags: string[]; source: 'seed' | 'staff' | 'platform' }

export interface KnowledgeIndex { docs: KnowledgeDoc[]; tf: Map<string, number>[]; len: number[]; df: Map<string, number>; avg: number }

function docTerms(d: KnowledgeDoc): string[] {
  // The question and tags count double: they say what the answer is about.
  const q = words(`${d.question} ${d.tags.join(' ')}`).filter((w) => !STOP.has(w));
  return [...q, ...q, ...words(d.answer).filter((w) => !STOP.has(w))];
}

export function indexKnowledge(docs: KnowledgeDoc[]): KnowledgeIndex {
  const tf = docs.map((d) => { const m = new Map<string, number>(); for (const t of docTerms(d)) m.set(t, (m.get(t) ?? 0) + 1); return m; });
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0));
  const df = new Map<string, number>();
  for (const m of tf) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  return { docs, tf, len, df, avg: len.reduce((a, b) => a + b, 0) / Math.max(1, len.length) };
}

export function searchKnowledge(ix: KnowledgeIndex, query: string, limit = 3): { doc: KnowledgeDoc; score: number }[] {
  const q = [...new Set(words(query).filter((w) => !STOP.has(w) && w !== '<num>'))];
  const qs = new Set(specific(q));
  const N = ix.docs.length; const k1 = 1.4; const b = 0.75;
  const scored = ix.docs.map((doc, i) => {
    let score = 0;
    for (const t of q) {
      const f = ix.tf[i]!.get(t); if (!f) continue;
      const n = ix.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * ix.len[i]!) / ix.avg)));
    }
    return { doc, score };
  });
  // An answer must be about the question: it covers at least half of the question's specific words, and at least
  // one of them appears in its own question or tags (one shared word such as "site" is not enough).
  const topical = (d: KnowledgeDoc) => {
    if (!qs.size) return false;
    const head = new Set(specific(words(`${d.question} ${d.tags.join(' ')}`)));
    const all = new Set([...head, ...words(d.answer)]);
    const covered = [...qs].filter((w) => all.has(w)).length;
    return [...qs].some((w) => head.has(w)) && covered / qs.size >= 0.5;
  };
  return scored.filter((x) => x.score > 0 && topical(x.doc)).sort((a, b) => b.score - a.score).slice(0, limit);
}

// ---------------------------------------------------------------- the assistant

export interface Brain {
  model: IntentModel;
  lexicon: LexiconEntry[];
  index: KnowledgeIndex;
  /** Words seen in the building domain (training examples, knowledge, listing titles): the scope guard. */
  domain: Set<string>;
}

export interface AssistantState { plot: Plot | null; brief: Partial<DesignBrief> }
export interface AssistantReply {
  intent: AssistantIntent;
  confidence: number;
  plot: Plot | null;
  brief: Partial<DesignBrief>;
  reply: string;
  knowledgeId: string | null;
  /** A question the assistant could not answer: logged so staff can add an answer. */
  unanswered: boolean;
}

const IN_DOMAIN: AssistantIntent[] = ['build_home', 'shopping', 'other_project', 'question'];

/** Specific words: not stop words, not generic, not numbers. */
const specific = (ws: string[]) => ws.filter((w) => !STOP.has(w) && !GENERIC.has(w) && w !== '<num>');

export function buildBrain(model: IntentModel, lexicon: LexiconEntry[], knowledge: KnowledgeDoc[], extraDomainWords: string[] = []): Brain {
  const domain = new Set<string>();
  // Words the model has mostly seen in building messages, not in off-topic ones.
  for (const v of model.vocab) {
    if (v.includes('_') || GENERIC.has(v) || v === '<num>') continue;
    const inside = IN_DOMAIN.reduce((sum, l) => sum + (model.counts[l]?.[v] ?? 0), 0);
    const outside = model.counts.out_of_scope?.[v] ?? 0;
    if (inside > outside) domain.add(v);
  }
  for (const d of knowledge) for (const w of specific(words(`${d.question} ${d.tags.join(' ')}`))) domain.add(w);
  for (const w of specific(extraDomainWords.flatMap((x) => words(x)))) domain.add(w);
  return { model, lexicon, index: indexKnowledge(knowledge), domain };
}

const QUESTION_START = /^(how|what|whats|why|when|where|which|who|can|could|should|is|are|do|does|will|would|explain|tell me)\b/;
const MIN_ANSWER_SCORE = 2.2;

function describe(b: Partial<DesignBrief>): string {
  const bits: string[] = [];
  if (b.bedrooms) bits.push(`${b.bedrooms}-bedroom`);
  if (b.storeys) bits.push(b.storeys === 2 ? 'two-storey' : 'bungalow');
  if (b.kitchen === 'open') bits.push('open-plan kitchen');
  if (b.study) bits.push('a study');
  if (b.parking) bits.push(`${b.parking} parking space${b.parking > 1 ? 's' : ''}`);
  if (b.roof) bits.push(`${b.roof} roof`);
  if (b.style) bits.push(`${b.style} style`);
  return bits.join(', ');
}

export function respond(brain: Brain, text: string, state: AssistantState): AssistantReply {
  const clean = text.trim().slice(0, 2000);
  const rules = readBriefText(clean);
  const learned = applyLexicon(clean, brain.lexicon);
  const brief = { ...learned, ...rules.brief } as Partial<DesignBrief>;
  const plot = rules.plot ?? parsePlotSize(clean);
  const cls = classifyIntent(brain.model, clean);
  const lower = clean.toLowerCase();
  const content = specific(words(clean));
  const inDomain = content.filter((w) => brain.domain.has(w)).length;
  const looksLikeQuestion = clean.endsWith('?') || QUESTION_START.test(lower);
  const hasBrief = Object.keys(brief).length > 0 || !!plot;

  let intent: AssistantIntent = cls.intent;
  let confidence = cls.confidence;
  // Explicit evidence beats the classifier: a plot size or room counts mean a home brief, unless it is a question.
  if (hasBrief && !looksLikeQuestion && intent !== 'shopping' && intent !== 'other_project') { intent = 'build_home'; confidence = Math.max(confidence, 0.9); }
  if (looksLikeQuestion && !hasBrief && intent === 'build_home' && inDomain > 0) intent = 'question';
  // The scope guard: not a single building word (generic words do not count) and not small talk.
  if (inDomain === 0 && !hasBrief && !['greeting', 'thanks'].includes(intent)) intent = content.length || looksLikeQuestion ? 'out_of_scope' : intent;
  if (intent === 'out_of_scope' && inDomain > 0 && looksLikeQuestion) intent = 'question';

  const base = { intent, confidence: Math.round(confidence * 1000) / 1000, plot: intent === 'build_home' ? plot : null, brief: intent === 'build_home' ? normaliseKnown(brief) : {}, knowledgeId: null as string | null, unanswered: false };
  const nowPlot = base.plot ?? state.plot;
  const nowBeds = (base.brief.bedrooms ?? state.brief.bedrooms) as number | undefined;

  switch (intent) {
    case 'greeting':
      return { ...base, reply: 'Hello! Tell me about the home you want to build (your land size and how many bedrooms), or ask me anything about building materials and costs.' };
    case 'thanks':
      return { ...base, reply: 'You are welcome. Anything else about your build?' };
    case 'out_of_scope':
      return { ...base, reply: 'I can only help with building: your land, home designs, materials, quantities and prices. What would you like to build?' };
    case 'other_project':
      return { ...base, reply: 'For now I design homes. For other projects, the marketplace lists materials, tradespeople and professionals near you.' };
    case 'shopping': {
      const hit = searchKnowledge(brain.index, clean, 1)[0];
      const price = hit && hit.score >= MIN_ANSWER_SCORE && hit.doc.source === 'platform' ? ` ${hit.doc.answer}` : '';
      return { ...base, knowledgeId: price ? hit!.doc.id : null, reply: `Taking you to the marketplace, where you can compare prices from sellers near you.${price}` };
    }
    case 'question': {
      const hit = searchKnowledge(brain.index, clean, 1)[0];
      if (hit && hit.score >= MIN_ANSWER_SCORE) return { ...base, knowledgeId: hit.doc.id, reply: hit.doc.answer };
      return { ...base, unanswered: true, reply: 'I do not know that one yet. I have noted your question so our team can add an answer. Meanwhile, I can design your home and count the materials.' };
    }
    case 'build_home':
    default: {
      const understood = describe(base.brief);
      const start = understood ? `Got it: ${understood}. ` : '';
      if (!nowPlot) return { ...base, reply: `${start}How big is your land? For example "50 by 100 ft" or "15 x 30 m".` };
      if (!nowBeds) return { ...base, reply: `${start}How many bedrooms would you like?` };
      return { ...base, reply: `${start}Adjust anything below, then pick a design.` };
    }
  }
}

function normaliseKnown(b: Partial<DesignBrief>): Partial<DesignBrief> {
  const n = normaliseBrief(b);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof DesignBrief)[]) if (b[k] !== undefined && b[k] !== null) out[k] = n[k];
  return out as Partial<DesignBrief>;
}

/** Removes phone numbers, emails and long digit runs before a message is stored for learning. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]')
    .slice(0, 1000);
}
