/**
 * The ideas library: named architectural ideas the free-form solver designs from, each in BuildWise's own words.
 *
 * An idea is how a house is composed (the solver's `FreeParti` and its knobs), the story an architect would tell about
 * it, the moves that make it, and the tastes, priorities and households it suits. Ideas are planning principles that
 * recur across good houses everywhere (a court between pavilions, a quiet sleeping wing, a breezeway, a long veranda
 * front), never copies of anyone's plans. The person's choices weight which ideas are tried; what people choose over
 * time (`IdeaPriors`) can nudge the weights further.
 */
import type { Priority, Purpose, Taste } from './preferences';
import type { FreeParti } from './solver';

export interface DesignIdea {
  key: string;
  title: string;
  story: string;
  moves: string[];
  parti: FreeParti;
  /** Dining room and kitchen stacked in a kitchen wing (true), in the front row (false), or the seed decides. */
  stacked?: boolean;
  /** Bedrooms down one side of a gallery (single-loaded) rather than both sides of a lobby. */
  single?: boolean;
  /** Only for one storey, only for two, or either. */
  storeys?: 1 | 2;
  suits: { tastes: Taste[]; priorities: Priority[]; purposes?: Purpose[] };
}

export const DESIGN_IDEAS: DesignIdea[] = [
  {
    key: 'quiet-wing', title: 'Quiet Wing House', parti: 'behind', stacked: false,
    story: 'Living rooms face the street round a generous entrance hall; the bedrooms sit behind them in a quiet wing of their own, reached by a short lobby, so the day side and the night side never mix.',
    moves: ['A day side and a night side', 'A short bedroom lobby, no corridor', 'Every room on an outside wall'],
    suits: { tastes: ['simple', 'modern'], priorities: ['privacy'], purposes: ['family'] },
  },
  {
    key: 'kitchen-yard', title: 'Kitchen Yard House', parti: 'behind', stacked: true,
    story: 'The kitchen and dining room stand in their own wing on a service yard at the side, with the cooking smells, gas and deliveries kept away from the living room and the front door.',
    moves: ['A kitchen wing on a service yard', 'Dining between kitchen and living', 'A compact frontage for a narrow plot'],
    suits: { tastes: ['simple', 'tropical'], priorities: ['host'], purposes: ['family', 'tenants'] },
  },
  {
    key: 'gallery-house', title: 'Gallery House', parti: 'behind', single: true, storeys: 1,
    story: 'The bedrooms line one side of a bright gallery, each opening to the garden on the other, so every bedroom gets light and a breeze from two sides.',
    moves: ['Bedrooms along a gallery', 'Cross-ventilation in every bedroom', 'A long garden elevation'],
    suits: { tastes: ['tropical', 'modern'], priorities: ['garden'] },
  },
  {
    key: 'garden-court', title: 'Garden Court House', parti: 'offset', stacked: false,
    story: 'The bedroom wing steps out past the living rooms into an L, wrapping a sheltered garden court that both wings look onto: an outdoor room the street never sees.',
    moves: ['An L round a private court', 'Living and bedrooms both face the court', 'Shelter from the street'],
    suits: { tastes: ['tropical', 'modern'], priorities: ['garden', 'privacy'], purposes: ['family'] },
  },
  {
    key: 'stepped-wings', title: 'Stepped Wings House', parti: 'offset', stacked: true,
    story: 'Three volumes step back from the street, living, kitchen and sleeping, each with its own roof, so the house reads as a small village of rooms rather than one box.',
    moves: ['Three stepped volumes', 'A roof for each wing', 'A garden corner at every step'],
    suits: { tastes: ['modern', 'grand'], priorities: ['garden'] },
  },
  {
    key: 'breezeway', title: 'Breezeway Pavilions', parti: 'pavilion', stacked: false,
    story: 'Living and sleeping are two pavilions across a garden court, joined by a short covered breezeway: air moves through every room, and the court is the heart of the house.',
    moves: ['Two pavilions', 'A covered breezeway', 'A garden court between'],
    suits: { tastes: ['tropical', 'simple'], priorities: ['garden', 'privacy'] },
  },
  {
    key: 'courtyard-retreat', title: 'Courtyard Retreat', parti: 'pavilion', stacked: true,
    story: 'You arrive in the living pavilion; the private house waits across a courtyard, reached by a gallery. Guests stay on the near side, the family lives on the far side.',
    moves: ['Arrival pavilion', 'A courtyard threshold', 'A private house beyond'],
    suits: { tastes: ['grand', 'tropical'], priorities: ['privacy', 'host'] },
  },
  {
    key: 'long-veranda', title: 'Long Veranda House', parti: 'side-wing', stacked: false,
    story: 'A long, low house across the width of the plot: the entrance in the middle, living rooms one side, bedrooms the other, every room opening onto the garden behind.',
    moves: ['A long low frontage', 'Entrance at the centre', 'Every room to the garden'],
    suits: { tastes: ['tropical', 'simple'], priorities: ['garden', 'host'] },
  },
  {
    key: 'grand-frontage', title: 'Grand Frontage House', parti: 'side-wing', stacked: true,
    story: 'A wide, balanced front with the entrance hall at its heart; the reception rooms open to one side and the family wing to the other, as a formal house should.',
    moves: ['A balanced, wide front', 'A central entrance hall', 'Reception and family wings'],
    suits: { tastes: ['grand', 'modern'], priorities: ['host'] },
  },
  {
    key: 'master-retreat', title: 'Master Retreat House', parti: 'split-wings', storeys: 1,
    story: "The master suite has a wing of its own beside the entrance; the children's bedrooms are in a second wing behind, round a garden court. Parents and children each get their quiet.",
    moves: ['A master wing apart', "A children's wing", 'A court between them'],
    suits: { tastes: ['grand', 'modern'], priorities: ['privacy'], purposes: ['family'] },
  },
  {
    key: 'family-wings', title: 'Family Wings House', parti: 'split-wings', stacked: true, storeys: 1,
    story: 'Two bedroom wings meet at the entrance hall and hold a garden between them, with the kitchen in its own wing: a sprawling family house that keeps every part close to the heart.',
    moves: ['Two bedroom wings', 'A garden held between', 'Everything meets at the hall'],
    suits: { tastes: ['tropical', 'simple'], priorities: ['garden', 'privacy'], purposes: ['family'] },
  },
];

/** Learned nudges per idea (from what people chose when shown it), added to the preference weight. */
export type IdeaPriors = Partial<Record<string, number>>;

export interface IdeaPrefs { taste?: Taste | null; priorities?: Priority[]; purpose?: Purpose | null }

/** How strongly an idea suits the person: 1, plus 2 for their taste, 1.5 per priority and 1 for their household. */
export function ideaWeight(idea: DesignIdea, prefs: IdeaPrefs = {}, priors: IdeaPriors = {}): number {
  let w = 1;
  if (prefs.taste && idea.suits.tastes.includes(prefs.taste)) w += 2;
  for (const p of prefs.priorities ?? []) if (idea.suits.priorities.includes(p)) w += 1.5;
  if (prefs.purpose && idea.suits.purposes?.includes(prefs.purpose)) w += 1;
  return Math.max(0.2, w + (priors[idea.key] ?? 0));
}

export const ideaByKey = (key: string) => DESIGN_IDEAS.find((i) => i.key === key);

/** The idea a design was drawn from (`free-<seed>-<idea>-…`), or null for the engine's and AI designs. */
export function ideaOf(designId: string): string | null {
  const m = /^free-\d+-(.+?)-\d+s-\d+b/.exec(designId);
  return m && ideaByKey(m[1]!) ? m[1]! : null;
}

export interface ConceptChoice { chosen: string; shown: string[]; taste: string | null }
/** Learned nudges per taste (and `any`), each idea's from how often it was chosen when shown. */
export type LearnedPriors = Record<string, IdeaPriors>;

/**
 * Nudges from what people chose: for each idea, how often it was chosen when shown against the chance of choosing it
 * blind (one in however many were shown), as a log ratio with a little smoothing, capped at ±1.5 and only once an idea
 * has been shown at least `minShown` times. Per taste, and over everyone (`any`).
 */
export function learnIdeaPriors(rows: ConceptChoice[], minShown = 8): LearnedPriors {
  const tally = new Map<string, Map<string, { shown: number; chosen: number; expected: number }>>();
  const add = (group: string, key: string, chosen: boolean, odds: number) => {
    const g = tally.get(group) ?? new Map(); tally.set(group, g);
    const t = g.get(key) ?? { shown: 0, chosen: 0, expected: 0 }; g.set(key, t);
    t.shown++; t.expected += odds; if (chosen) t.chosen++;
  };
  for (const r of rows) {
    const shown = [...new Set(r.shown.filter((k) => ideaByKey(k)))];
    if (!shown.length) continue;
    const odds = 1 / Math.max(1, r.shown.length);
    for (const k of shown) {
      add('any', k, k === r.chosen, odds);
      if (r.taste) add(r.taste, k, k === r.chosen, odds);
    }
  }
  const out: LearnedPriors = {};
  for (const [group, g] of tally) {
    const p: IdeaPriors = {};
    for (const [k, t] of g) if (t.shown >= minShown) p[k] = Math.max(-1.5, Math.min(1.5, Math.round(Math.log((t.chosen + 1) / (t.expected + 1)) * 100) / 100));
    if (Object.keys(p).length) out[group] = p;
  }
  return out;
}
