/**
 * Held-out evaluation of the BuildWise assistant's reading of a message: none of these sentences is in the training
 * examples (assistant-seed.ts). They measure what the intent accuracy does not: whether the brief, the purpose, the
 * taste, the priorities, revisions and tool routing are read as distinct inputs, turn after turn.
 *
 * `evaluateAssistant` scores any brain (the current one, or a retrained candidate) so the two can be compared before a
 * candidate replaces the incumbent. A reply that does not carry a field at all (an older model) scores it as wrong,
 * except the guard checks (`unset`, `noSpend`), which only fail when something was wrongly filled in.
 */
import { respond, type AssistantIntent, type AssistantState, type Brain } from './assistant';
import type { DesignBrief, Plot } from './design';

export interface EvalExpect {
  intent?: AssistantIntent;
  type?: DesignBrief['type']; storeys?: number; bedrooms?: number; study?: boolean; bq?: boolean;
  /** Each of these must be among the features read. */
  features?: string[];
  /** Metres [width, depth], or null when the message gives no size. */
  plot?: [number, number] | null;
  purpose?: string; taste?: string; grandFocus?: string; place?: string; finish?: string; budgetMinor?: number;
  priorities?: string[];
  chooseForMe?: boolean; plotUnknown?: boolean; future?: boolean;
  solarBudgetMinor?: [number, number];
  /** Revisions: each must be among what the reading says shrinks, and what it says must be kept. */
  smaller?: string[]; keep?: string[];
  route?: string;
  /** Guard: brief fields the message gives no evidence for, which must stay unset. */
  unset?: (keyof DesignBrief)[];
  /** Guard: no budget and no finish level may be read (taste is not spend). */
  noSpend?: true;
}
export interface EvalCase { id: string; group: string; text: string; state?: Partial<AssistantState>; expect: EvalExpect }

const c = (id: string, group: string, text: string, expect: EvalExpect, state?: Partial<AssistantState>): EvalCase => ({ id, group, text, expect, ...(state ? { state } : {}) });
const P50: Plot = { widthM: 15.24, depthM: 30.48 }; const P60: Plot = { widthM: 18.29, depthM: 36.58 };

export const ASSISTANT_EVAL: EvalCase[] = [
  // Short briefs, the way the build flow's clicks read when put in a line.
  c('click-1', 'click', 'Family home · Ibadan · 30 × 30 m · Tropical & open · Bigger garden', { intent: 'build_home', purpose: 'family', taste: 'tropical', priorities: ['garden'], plot: [30, 30], place: 'Ibadan', unset: ['bedrooms', 'storeys'], noSpend: true }),
  c('click-2', 'click', 'Duplex, for tenants, 50 x 100 ft, modern and clean', { intent: 'build_home', type: 'duplex', purpose: 'tenants', taste: 'modern', plot: [15.24, 30.48], priorities: [] }),
  c('click-3', 'click', 'Bungalow · my family · simple and welcoming · more privacy', { intent: 'build_home', type: 'bungalow', purpose: 'family', taste: 'simple', priorities: ['privacy'], plot: null }),
  c('click-4', 'click', 'Home for my family and tenants, grand and striking, room to host', { intent: 'build_home', purpose: 'both', taste: 'grand', priorities: ['host'], unset: ['bedrooms', 'storeys'], noSpend: true }),
  c('click-5', 'click', 'Block of flats to rent out, 60 by 120, simple', { intent: 'build_home', type: 'apartments', purpose: 'tenants', taste: 'simple', plot: [18.29, 36.58] }),
  c('click-6', 'click', 'Shops, my own business, modern, 100 by 100 ft', { intent: 'build_home', type: 'shops', purpose: 'own', taste: 'modern', plot: [30.48, 30.48] }),
  c('click-7', 'click', 'A home, still exploring, plot size not known', { intent: 'build_home', purpose: 'exploring', plotUnknown: true, plot: null }),
  c('click-8', 'click', 'Hotel to run ourselves, tropical and open, Lagos', { intent: 'build_home', type: 'hotel', purpose: 'own', taste: 'tropical', place: 'Lagos' }),

  // People who are not sure yet.
  c('unsure-1', 'uncertain', "i'm not sure what i can build on my land yet", { intent: 'build_home', purpose: 'exploring', unset: ['bedrooms', 'storeys'] }),
  c('unsure-2', 'uncertain', "we haven't decided, maybe a bungalow or a duplex", { intent: 'build_home', purpose: 'exploring' }),
  c('unsure-3', 'uncertain', "i want to build a house but i don't know my plot size", { intent: 'build_home', plotUnknown: true, plot: null }),
  c('unsure-4', 'uncertain', 'a family house, not sure about the style, you choose', { intent: 'build_home', purpose: 'family', chooseForMe: true }),
  c('unsure-5', 'uncertain', 'no survey plan yet but i want to see what a duplex could look like', { intent: 'build_home', type: 'duplex', plotUnknown: true }),

  // Follow-up corrections, on top of what is already known.
  c('fix-1', 'correction', 'actually make it 3 bedrooms', { intent: 'build_home', bedrooms: 3 }, { plot: P50, brief: { type: 'duplex', storeys: 2, bedrooms: 4 } }),
  c('fix-2', 'correction', 'no, the plot is 60 by 120 not 50 by 100', { intent: 'build_home', plot: [18.29, 36.58] }, { plot: P50, brief: { bedrooms: 3 } }),
  c('fix-3', 'correction', 'change the style to tropical', { intent: 'build_home', taste: 'tropical' }, { plot: P50, brief: { bedrooms: 3, style: 'modern' } }),
  c('fix-4', 'correction', 'it is for tenants, not my family', { purpose: 'tenants' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('fix-5', 'correction', 'remove the study and add a gym', { intent: 'build_home', study: false, features: ['gym'] }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4, study: true } }),
  c('fix-6', 'correction', "we don't need a boys quarters", { intent: 'build_home', bq: false }, { plot: P60, brief: { bedrooms: 4, bq: true } }),
  c('fix-7', 'correction', 'make it two storeys instead', { intent: 'build_home', storeys: 2 }, { plot: P50, brief: { type: 'bungalow', bedrooms: 3 } }),

  // Purposes, for homes and for other buildings.
  c('for-1', 'purpose', 'a house for my parents to retire in', { intent: 'build_home', purpose: 'family' }),
  c('for-2', 'purpose', 'i want to build flats for rental income', { intent: 'build_home', purpose: 'tenants' }),
  c('for-3', 'purpose', 'we will live upstairs and rent the ground floor', { purpose: 'both' }),
  c('for-4', 'purpose', 'a duplex as an investment to let out', { intent: 'build_home', type: 'duplex', purpose: 'tenants' }),
  c('for-5', 'purpose', 'a clinic for our community', { intent: 'build_home', type: 'clinic', purpose: 'community' }),
  c('for-6', 'purpose', 'an office building for my company', { intent: 'build_home', type: 'office', purpose: 'own' }),
  c('for-7', 'purpose', 'a church for our congregation', { intent: 'build_home', type: 'worship', purpose: 'community' }),

  // Tastes in people's own words.
  c('feel-1', 'taste', 'something simple and homely, nothing fancy', { taste: 'simple', noSpend: true }),
  c('feel-2', 'taste', 'a house with clean lines, minimalist, lots of glass', { intent: 'build_home', taste: 'modern' }),
  c('feel-3', 'taste', 'a home that is airy with verandas and a cross breeze', { intent: 'build_home', taste: 'tropical' }),
  c('feel-4', 'taste', 'i want my house to look impressive from the street', { intent: 'build_home', taste: 'grand', grandFocus: 'entry', noSpend: true }),
  c('feel-5', 'taste', 'a contemporary tropical family home', { intent: 'build_home', taste: 'tropical', purpose: 'family' }),
  c('feel-6', 'taste', 'a bungalow with a cosy cottage feel', { intent: 'build_home', type: 'bungalow', taste: 'simple' }),

  // Grand is a feeling: it never adds rooms, floors or spend by itself.
  c('grand-1', 'grandeur', 'a grand 3 bedroom bungalow', { intent: 'build_home', taste: 'grand', bedrooms: 3, type: 'bungalow', noSpend: true }),
  c('grand-2', 'grandeur', 'i want a house with a grand entrance', { intent: 'build_home', taste: 'grand', grandFocus: 'entry', unset: ['bedrooms', 'storeys'], noSpend: true }),
  c('grand-3', 'grandeur', 'a striking home with a double height living room', { intent: 'build_home', taste: 'grand', grandFocus: 'living', unset: ['bedrooms'], noSpend: true }),
  c('grand-4', 'grandeur', 'a grand home where we can host big family gatherings', { intent: 'build_home', taste: 'grand', grandFocus: 'hosting', priorities: ['host'], unset: ['bedrooms', 'storeys'], noSpend: true }),
  c('grand-5', 'grandeur', 'a luxury home with premium finishes, our budget is 150 million', { intent: 'build_home', taste: 'grand', finish: 'premium', budgetMinor: 15_000_000_000 }),
  c('grand-6', 'grandeur', 'build me a majestic mansion', { intent: 'build_home', taste: 'grand', unset: ['bedrooms', 'storeys'], noSpend: true }),

  // Priorities.
  c('want-1', 'priority', 'a house with a big garden for the children', { intent: 'build_home', priorities: ['garden'] }),
  c('want-2', 'priority', 'privacy matters to us, we do not want the house overlooked', { priorities: ['privacy'] }),
  c('want-3', 'priority', 'we entertain a lot at home', { priorities: ['host'] }),
  c('want-4', 'priority', 'a home with space for parties and a large compound', { intent: 'build_home', priorities: ['garden', 'host'] }),

  // Shrinking the plot or the budget while protecting something that matters.
  c('less-1', 'revision', 'make the plot smaller but keep the gym', { intent: 'build_home', smaller: ['plot'], keep: ['gym'], route: 'revise' }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4, features: ['gym'] } }),
  c('less-2', 'revision', 'the budget is tighter now, but we must keep the study', { smaller: ['budget'], keep: ['study'], route: 'revise' }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4, study: true } }),
  c('less-3', 'revision', "reduce the land to 50 by 100 ft, don't lose the garden", { intent: 'build_home', plot: [15.24, 30.48], smaller: ['plot'], keep: ['garden'], route: 'revise' }, { plot: P60, brief: { bedrooms: 4 } }),
  c('less-4', 'revision', 'we can only afford 40 million now, keep the four bedrooms', { smaller: ['budget'], keep: ['bedrooms'], budgetMinor: 4_000_000_000, route: 'revise' }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4 } }),
  c('less-5', 'revision', 'cut the cost without removing the gym', { smaller: ['budget'], keep: ['gym'], route: 'revise' }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4, features: ['gym'] } }),

  // Routing to BuildWise's tools.
  c('tool-1', 'routing', 'how much will this house cost to build', { intent: 'question', route: 'calculate:budget' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('tool-2', 'routing', 'what size of solar system do i need for it', { intent: 'question', route: 'calculate:energy' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('tool-3', 'routing', 'how big should the water tank be', { intent: 'question', route: 'calculate:water' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('tool-4', 'routing', 'how many air conditioners will it need', { intent: 'question', route: 'calculate:cooling' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('tool-5', 'routing', 'show me three different designs', { route: 'design' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('tool-6', 'routing', 'where can i buy cement in ibadan', { intent: 'shopping', route: 'marketplace' }),
  c('tool-7', 'routing', 'what is a setback', { intent: 'question', route: 'knowledge' }),
  c('tool-8', 'routing', 'compare the other options for me', { route: 'design' }, { plot: P50, brief: { bedrooms: 3 } }),

  // The reference brief: an energy-led home that grows into a full concept.
  c('ref-1', 'reference', 'i want an energy efficient home in ibadan, lagos is an alternative, with a solar budget of 10 to 15 million naira, and room to upgrade later', { intent: 'build_home', place: 'Ibadan', solarBudgetMinor: [1_000_000_000, 1_500_000_000], future: true, unset: ['bedrooms', 'storeys'] }),
  c('ref-2', 'reference', 'a four bedroom two storey family home with a study, gaming room and gym, contemporary tropical', { intent: 'build_home', storeys: 2, bedrooms: 4, study: true, features: ['gaming', 'gym'], purpose: 'family', taste: 'tropical' }),
];

/**
 * A second set, written after the rules were finished and scored once without tuning against it: the honest measure
 * of how the reading holds up on wording it has not been shaped to. Do not adjust rules to these cases; add new
 * training examples and new cases instead.
 */
export const ASSISTANT_EVAL_BLIND: EvalCase[] = [
  c('blind-1', 'click', 'Terrace houses · tenants · Abuja · 100 × 100 ft · Modern & clean', { intent: 'build_home', type: 'terrace', purpose: 'tenants', taste: 'modern', plot: [30.48, 30.48], place: 'Abuja' }),
  c('blind-2', 'click', 'Bungalow for our family in Enugu, simple and welcoming, more privacy, 15 by 30 m', { intent: 'build_home', type: 'bungalow', purpose: 'family', taste: 'simple', priorities: ['privacy'], plot: [15, 30], place: 'Enugu' }),
  c('blind-3', 'click', 'School for the community, plot not measured yet', { intent: 'build_home', type: 'school', purpose: 'community', plotUnknown: true }),
  c('blind-4', 'uncertain', 'honestly we are still thinking about whether to build at all on the land', { purpose: 'exploring' }),
  c('blind-5', 'uncertain', 'surprise me with the look, it is a home for my wife and kids', { intent: 'build_home', purpose: 'family', chooseForMe: true }),
  c('blind-6', 'correction', 'sorry, five bedrooms not four', { intent: 'build_home', bedrooms: 5 }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4 } }),
  c('blind-7', 'correction', 'drop the boys quarters and add a cinema', { intent: 'build_home', bq: false, features: ['cinema'] }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4, bq: true } }),
  c('blind-8', 'correction', 'we will not live there, it is purely for rent', { purpose: 'tenants' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('blind-9', 'purpose', 'a guest house i will manage myself', { intent: 'build_home', type: 'hotel', purpose: 'own' }),
  c('blind-10', 'purpose', 'two flats, one for us and one to rent', { purpose: 'both' }),
  c('blind-11', 'purpose', 'a mosque for our community in Kano', { intent: 'build_home', type: 'worship', purpose: 'community', place: 'Kano' }),
  c('blind-12', 'taste', 'i like sleek boxy houses with glass walls', { intent: 'build_home', taste: 'modern' }),
  c('blind-13', 'taste', 'a shaded home that opens to the garden with louvres', { intent: 'build_home', taste: 'tropical' }),
  c('blind-14', 'taste', 'keep it modest and unpretentious, a plain family house', { intent: 'build_home', taste: 'simple', purpose: 'family', noSpend: true }),
  c('blind-15', 'grandeur', 'a prestigious looking duplex, 4 bedrooms', { intent: 'build_home', taste: 'grand', type: 'duplex', bedrooms: 4, noSpend: true }),
  c('blind-16', 'grandeur', 'the house should make a statement when you arrive at the gate', { intent: 'build_home', taste: 'grand', grandFocus: 'entry', unset: ['bedrooms', 'storeys'], noSpend: true }),
  c('blind-17', 'grandeur', 'an imposing home, high-end finishes, we can spend 200 million', { intent: 'build_home', taste: 'grand', finish: 'premium', budgetMinor: 20_000_000_000 }),
  c('blind-18', 'priority', 'the children need room to play outside and we host a lot of guests', { priorities: ['garden', 'host'] }),
  c('blind-19', 'priority', 'bedrooms should be secluded, away from the road', { priorities: ['privacy'] }),
  c('blind-20', 'revision', 'we sold part of the land so the plot is smaller now, but the cinema must stay', { smaller: ['plot'], keep: ['cinema'], route: 'revise' }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4, features: ['cinema'] } }),
  c('blind-21', 'revision', 'lower the budget to 55 million without losing the boys quarters', { smaller: ['budget'], keep: ['bq'], budgetMinor: 5_500_000_000, route: 'revise' }, { plot: P60, brief: { type: 'duplex', storeys: 2, bedrooms: 4, bq: true } }),
  c('blind-22', 'revision', 'shrink the house a little but protect the garden', { smaller: ['house'], keep: ['garden'], route: 'revise' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('blind-23', 'routing', 'how much electricity will my house use each day', { route: 'calculate:energy' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('blind-24', 'routing', 'what will the borehole and tanks need to be', { route: 'calculate:water' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('blind-25', 'routing', 'give me two other layouts to compare', { route: 'design' }, { plot: P50, brief: { bedrooms: 3 } }),
  c('blind-26', 'routing', 'who sells roofing sheets in port harcourt', { intent: 'shopping', route: 'marketplace' }),
  c('blind-27', 'reference', 'an off grid house in Abeokuta, we have 12 to 18 million for solar and want to add batteries later', { intent: 'build_home', place: 'Abeokuta', solarBudgetMinor: [1_200_000_000, 1_800_000_000], future: true }),
  c('blind-28', 'reference', 'a 4 bedroom duplex with a home office, games room and gym, modern tropical feel', { intent: 'build_home', type: 'duplex', bedrooms: 4, study: true, features: ['gaming', 'gym'], taste: 'tropical' }),
];

// ---------------------------------------------------------------- conversations

export interface EvalTurn { text: string; expect: EvalExpect }
export interface EvalConversation {
  id: string;
  turns: EvalTurn[];
  /** What must be true of the brief and choices carried to the end (nothing said earlier may be lost). */
  final: { features?: string[]; purpose?: string; taste?: string; bedrooms?: number; type?: DesignBrief['type']; plot?: [number, number] | null; study?: boolean };
}

export const CONVERSATION_EVAL: EvalConversation[] = [
  {
    // Held out: three designs for a family home, then a smaller plot that must keep the gym.
    id: 'family-three-then-smaller',
    turns: [
      { text: 'show me three designs for a family home with four bedrooms and a gym on 60 by 120 ft', expect: { intent: 'build_home', purpose: 'family', bedrooms: 4, features: ['gym'], plot: [18.29, 36.58], route: 'design' } },
      { text: 'make the plot smaller but keep the gym', expect: { smaller: ['plot'], keep: ['gym'], route: 'revise', unset: ['bedrooms'] } },
    ],
    final: { purpose: 'family', bedrooms: 4, features: ['gym'], plot: [18.29, 36.58] },
  },
  {
    id: 'tighter-budget-keeps-bedrooms',
    turns: [
      { text: 'a 4 bedroom duplex for my family in ibadan on 50 by 100 ft, tropical and open', expect: { intent: 'build_home', type: 'duplex', bedrooms: 4, purpose: 'family', taste: 'tropical', place: 'Ibadan', plot: [15.24, 30.48] } },
      { text: 'add a study and a gym', expect: { intent: 'build_home', study: true, features: ['gym'] } },
      { text: 'we can only afford 60 million now, keep the four bedrooms', expect: { smaller: ['budget'], keep: ['bedrooms'], budgetMinor: 6_000_000_000, route: 'revise' } },
    ],
    final: { type: 'duplex', bedrooms: 4, study: true, features: ['gym'], purpose: 'family', taste: 'tropical', plot: [15.24, 30.48] },
  },
  {
    id: 'taste-changes-brief-stays',
    turns: [
      { text: 'a 3 bedroom bungalow to rent out on a 50 by 100 plot, simple', expect: { intent: 'build_home', type: 'bungalow', bedrooms: 3, purpose: 'tenants', taste: 'simple', plot: [15.24, 30.48] } },
      { text: 'actually make it modern and clean', expect: { taste: 'modern', unset: ['bedrooms', 'type'] } },
      { text: 'how much will it cost to build', expect: { intent: 'question', route: 'calculate:budget' } },
    ],
    final: { type: 'bungalow', bedrooms: 3, purpose: 'tenants', taste: 'modern', plot: [15.24, 30.48] },
  },
];

// ---------------------------------------------------------------- scoring

export interface EvalFailure { id: string; text: string; field: string; want: unknown; got: unknown }
export interface EvalReport {
  checks: number; passed: number; accuracy: number;
  /** Cases where every check passed. */
  cases: number; casesPassed: number;
  byGroup: Record<string, { checks: number; passed: number; accuracy: number }>;
  byField: Record<string, { checks: number; passed: number; accuracy: number }>;
  failures: EvalFailure[];
}

type Reply = ReturnType<typeof respond> & { preferences?: Record<string, unknown>; revision?: { smaller?: string[]; keep?: string[] } | null; route?: string };

const near = (a: number, b: number) => Math.abs(a - b) <= 0.06;
const sameSet = (a: unknown, b: string[]) => Array.isArray(a) && a.length === b.length && b.every((x) => a.includes(x));

/** Every expectation of one reply, as [field, want, got, passed]. */
function check(r: Reply, e: EvalExpect): [string, unknown, unknown, boolean][] {
  const out: [string, unknown, unknown, boolean][] = [];
  const brief = (r.brief ?? {}) as Record<string, unknown>;
  const pref = r.preferences;
  const add = (field: string, want: unknown, got: unknown, ok: boolean) => out.push([field, want, got, ok]);
  if (e.intent !== undefined) add('intent', e.intent, r.intent, r.intent === e.intent);
  for (const k of ['type', 'storeys', 'bedrooms', 'study', 'bq'] as const) if (e[k] !== undefined) add(k, e[k], brief[k], brief[k] === e[k]);
  if (e.features) add('features', e.features, brief.features, Array.isArray(brief.features) && e.features.every((f) => (brief.features as string[]).includes(f)));
  if (e.plot !== undefined) add('plot', e.plot, r.plot, e.plot === null ? r.plot === null : !!r.plot && near(r.plot.widthM, e.plot[0]) && near(r.plot.depthM, e.plot[1]));
  for (const k of ['purpose', 'taste', 'grandFocus', 'place', 'finish', 'budgetMinor'] as const) if (e[k] !== undefined) add(k, e[k], pref?.[k], pref?.[k] === e[k]);
  if (e.priorities) add('priorities', e.priorities, pref?.priorities, sameSet(pref?.priorities, e.priorities));
  for (const k of ['chooseForMe', 'plotUnknown', 'future'] as const) if (e[k] !== undefined) add(k, e[k], pref?.[k], pref?.[k] === e[k]);
  if (e.solarBudgetMinor) { const g = pref?.solarBudgetMinor as number[] | undefined; add('solarBudgetMinor', e.solarBudgetMinor, g, !!g && g[0] === e.solarBudgetMinor[0] && g[1] === e.solarBudgetMinor[1]); }
  if (e.smaller) add('smaller', e.smaller, r.revision?.smaller, !!r.revision?.smaller && e.smaller.every((x) => r.revision!.smaller!.includes(x)));
  if (e.keep) add('keep', e.keep, r.revision?.keep, !!r.revision?.keep && e.keep.every((x) => r.revision!.keep!.includes(x)));
  if (e.route !== undefined) add('route', e.route, r.route, r.route === e.route);
  for (const k of e.unset ?? []) add(`unset:${k}`, undefined, brief[k], brief[k] === undefined);
  if (e.noSpend) add('noSpend', 'no budget or finish', { budgetMinor: pref?.budgetMinor, finish: pref?.finish }, pref?.budgetMinor === undefined && pref?.finish === undefined);
  return out;
}

function report(rows: { id: string; group: string; text: string; checks: [string, unknown, unknown, boolean][] }[]): EvalReport {
  const byGroup: EvalReport['byGroup'] = {}; const byField: EvalReport['byField'] = {}; const failures: EvalFailure[] = [];
  let checks = 0, passed = 0, casesPassed = 0;
  const bump = (m: EvalReport['byGroup'], k: string, ok: boolean) => { const x = (m[k] ??= { checks: 0, passed: 0, accuracy: 0 }); x.checks++; if (ok) x.passed++; };
  for (const row of rows) {
    if (row.checks.every((x) => x[3])) casesPassed++;
    for (const [field, want, got, ok] of row.checks) {
      checks++; if (ok) passed++;
      bump(byGroup, row.group, ok); bump(byField, field.split(':')[0]!, ok);
      if (!ok) failures.push({ id: row.id, text: row.text, field, want, got });
    }
  }
  const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 1);
  for (const m of [byGroup, byField]) for (const x of Object.values(m)) x.accuracy = pct(x.passed, x.checks);
  return { checks, passed, accuracy: pct(passed, checks), cases: rows.length, casesPassed, byGroup, byField, failures };
}

const stateOf = (s?: Partial<AssistantState>): AssistantState => ({ plot: s?.plot ?? null, brief: s?.brief ?? {} });

/** Scores a brain on single messages. */
export function evaluateAssistant(brain: Brain, cases: EvalCase[] = ASSISTANT_EVAL): EvalReport {
  return report(cases.map((k) => ({ id: k.id, group: k.group, text: k.text, checks: check(respond(brain, k.text, stateOf(k.state)) as Reply, k.expect) })));
}

/**
 * Scores a brain on conversations: each turn is read against what the earlier turns established, and at the end the
 * brief and choices must still hold everything that was said (group `retained`).
 */
export function evaluateConversations(brain: Brain, convs: EvalConversation[] = CONVERSATION_EVAL): EvalReport {
  const rows: Parameters<typeof report>[0] = [];
  for (const conv of convs) {
    let state: AssistantState = { plot: null, brief: {} };
    const kept: Record<string, unknown> = {};
    conv.turns.forEach((turn, i) => {
      const r = respond(brain, turn.text, state) as Reply;
      rows.push({ id: `${conv.id}#${i + 1}`, group: 'turn', text: turn.text, checks: check(r, turn.expect) });
      // Carry forward what was read, the way the build flow does: new values replace old, lists add up.
      const b = (r.brief ?? {}) as Partial<DesignBrief>;
      const features = [...new Set([...(state.brief.features ?? []), ...(b.features ?? [])])];
      state = { plot: r.plot ?? state.plot, brief: { ...state.brief, ...b, ...(features.length ? { features } : {}) } as Partial<DesignBrief> };
      for (const k of ['purpose', 'taste'] as const) if (r.preferences?.[k] !== undefined) kept[k] = r.preferences[k];
    });
    const f = conv.final; const b = state.brief as Record<string, unknown>;
    const fin: [string, unknown, unknown, boolean][] = [];
    for (const k of ['type', 'bedrooms', 'study'] as const) if (f[k] !== undefined) fin.push([k, f[k], b[k], b[k] === f[k]]);
    if (f.features) fin.push(['features', f.features, b.features, Array.isArray(b.features) && f.features.every((x) => (b.features as string[]).includes(x))]);
    for (const k of ['purpose', 'taste'] as const) if (f[k] !== undefined) fin.push([k, f[k], kept[k], kept[k] === f[k]]);
    if (f.plot !== undefined) fin.push(['plot', f.plot, state.plot, f.plot === null ? state.plot === null : !!state.plot && near(state.plot.widthM, f.plot[0]) && near(state.plot.depthM, f.plot[1])]);
    rows.push({ id: `${conv.id}#end`, group: 'retained', text: '(the brief at the end)', checks: fin });
  }
  return report(rows);
}
