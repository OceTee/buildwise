/**
 * What a person wants from a building beyond its rooms: who it is for (purpose), how it should feel (taste) and what
 * matters most (priorities). These are kept apart from the design brief on purpose:
 *
 *  - the brief is geometry (type, storeys, rooms) and only changes on explicit evidence;
 *  - taste picks a look and which concepts are shown first, never floor area or spend: "grand" means a memorable
 *    entry, a dramatic living space or generous room to host, and a bigger or costlier building needs its own
 *    evidence (a room count, an area, a budget, a finish level);
 *  - priorities weigh the trade-offs between otherwise valid concepts.
 *
 * Everything here is deterministic: the build flow's clicks set these directly, and `readPreferences` reads them from
 * plain words (the local assistant's job), including later corrections ("for tenants, not my family") and revisions
 * ("make the plot smaller but keep the gym").
 */
import { BUILDING_TYPES, isHouse, type BuildingType } from './building';
import type { DesignBrief } from './design';

// ---------------------------------------------------------------- the choices

export type Purpose = 'family' | 'tenants' | 'both' | 'own' | 'community' | 'exploring';
export type Taste = 'simple' | 'modern' | 'tropical' | 'grand';
export type Priority = 'garden' | 'privacy' | 'host';
/** What "grand" should be spent on, when the person says. */
export type GrandFocus = 'entry' | 'living' | 'hosting';

export interface Preferences {
  purpose: Purpose | null;
  taste: Taste | null;
  priorities: Priority[];
  /** "Choose for me": BuildWise picked the taste; shown as such, and the person can change it. */
  tasteChosenForMe: boolean;
  /** The plot size is not known yet: designs use a typical plot and never claim to fit the person's land. */
  plotUnknown: boolean;
}
export const DEFAULT_PREFERENCES: Preferences = { purpose: null, taste: null, priorities: [], tasteChosenForMe: false, plotUnknown: false };

export const PURPOSES: Record<Purpose, { label: string; short: string }> = {
  family: { label: 'My family', short: 'Family home' },
  tenants: { label: 'Tenants', short: 'For tenants' },
  both: { label: 'Both', short: 'Family and tenants' },
  own: { label: 'My own business', short: 'Own use' },
  community: { label: 'A community or organisation', short: 'Community' },
  exploring: { label: 'Still exploring', short: 'Exploring' },
};

/** The one purpose question for a building type: who it is for, in that type's words. */
export function purposeQuestion(type: BuildingType): { question: string; options: { key: Purpose; label: string; blurb: string }[] } {
  const family = BUILDING_TYPES[type].family;
  if (family === 'home') {
    return { question: 'Who is it for?', options: [
      { key: 'family', label: 'My family', blurb: 'We will live in it' },
      { key: 'tenants', label: 'Tenants', blurb: 'To rent out' },
      { key: 'both', label: 'Both', blurb: 'Live in part, rent part' },
      { key: 'exploring', label: 'Still exploring', blurb: 'Not decided yet' },
    ] };
  }
  if (family === 'institutional') {
    return { question: 'Who will it serve?', options: [
      { key: 'community', label: 'A community', blurb: 'A congregation, town or organisation' },
      { key: 'own', label: 'My own practice', blurb: 'I will run it' },
      { key: 'exploring', label: 'Still exploring', blurb: 'Not decided yet' },
    ] };
  }
  return { question: 'Who will use it?', options: [
    { key: 'own', label: 'My own business', blurb: 'We will run it' },
    { key: 'tenants', label: 'Tenants', blurb: 'To let out' },
    { key: 'both', label: 'Both', blurb: 'Use part, let part' },
    { key: 'exploring', label: 'Still exploring', blurb: 'Not decided yet' },
  ] };
}

export interface TasteInfo {
  label: string;
  blurb: string;
  /** The engine style this taste is drawn in. */
  style: DesignBrief['style'];
  /** The roof it starts with when the person has not picked one. */
  roof: DesignBrief['roof'];
  /** Three materials, as colours with names (shown as swatches). */
  swatches: { name: string; hex: string }[];
  /** What the taste is spent on in the design, in the person's words. */
  means: string;
}
export const TASTES: Record<Taste, TasteInfo> = {
  simple: { label: 'Simple & welcoming', blurb: 'Warm, familiar and easy to build', style: 'classic', roof: 'hip',
    swatches: [{ name: 'Cream render', hex: '#efe6d2' }, { name: 'Warm timber', hex: '#c08a52' }, { name: 'Sand plaster', hex: '#e2d6c0' }],
    means: 'a sheltered porch, a pitched roof and warm cream walls' },
  modern: { label: 'Modern & clean', blurb: 'Crisp lines, big glass, calm colours', style: 'modern', roof: 'hidden',
    swatches: [{ name: 'Pale concrete', hex: '#c9c9c4' }, { name: 'Charcoal', hex: '#3f3f46' }, { name: 'White marble', hex: '#f1efea' }],
    means: 'clean volumes, a roof hidden behind a parapet and floor-to-ceiling glass' },
  tropical: { label: 'Tropical & open', blurb: 'Shade, breeze and rooms that open outside', style: 'tropical', roof: 'hip',
    swatches: [{ name: 'Woven cane', hex: '#c9a26b' }, { name: 'Forest green', hex: '#2f5d3a' }, { name: 'Lime plaster', hex: '#efece2' }],
    means: 'deep shading eaves, verandas and timber louvres' },
  grand: { label: 'Grand & striking', blurb: 'A memorable arrival and room to host', style: 'modern', roof: 'hidden',
    swatches: [{ name: 'Dark stone', hex: '#2b2b2e' }, { name: 'Brass', hex: '#b8975a' }, { name: 'Grey granite', hex: '#8c8c8a' }],
    means: 'a strong entrance, a stone-clad living wing and tall glass' },
};
export const TASTE_KEYS = Object.keys(TASTES) as Taste[];

export const PRIORITIES: Record<Priority, { label: string; blurb: string }> = {
  garden: { label: 'Bigger garden', blurb: 'Keep more of the plot open' },
  privacy: { label: 'More privacy', blurb: 'Bedrooms and outdoor rooms away from the street' },
  host: { label: 'Room to host', blurb: 'Generous living, dining and terrace' },
};
export const PRIORITY_KEYS = Object.keys(PRIORITIES) as Priority[];

export function normalisePreferences(x: Partial<Preferences> | null | undefined): Preferences {
  const p = x ?? {};
  return {
    purpose: p.purpose && p.purpose in PURPOSES ? p.purpose : null,
    taste: p.taste && p.taste in TASTES ? p.taste : null,
    priorities: [...new Set((Array.isArray(p.priorities) ? p.priorities : []).filter((k): k is Priority => k in PRIORITIES))],
    tasteChosenForMe: !!p.tasteChosenForMe && !!p.taste,
    plotUnknown: !!p.plotUnknown,
  };
}

/** "Choose for me": the taste that suits the purpose and the building (the person can change it afterwards). */
export function chooseTaste(type: BuildingType, purpose: Purpose | null): Taste {
  if (!isHouse(type) && BUILDING_TYPES[type].family !== 'home') return 'modern';
  if (purpose === 'tenants') return 'simple';
  return 'tropical';
}

/** What a taste changes in the brief: the look only (and the roof, unless the person picked one themselves). */
export function tasteBrief(taste: Taste, roofChosen = false): Partial<DesignBrief> {
  const t = TASTES[taste];
  return { style: t.style, roofColour: 'auto', ...(roofChosen ? {} : { roof: t.roof }) };
}

/** A one-line recap of the choices, for the summary beside the plot. */
export function describePreferences(p: Preferences): string {
  return [p.purpose ? PURPOSES[p.purpose].short : null, p.taste ? TASTES[p.taste].label : null, ...p.priorities.map((k) => PRIORITIES[k].label)].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- reading them from words

export interface PreferenceReading {
  purpose?: Purpose;
  taste?: Taste;
  priorities: Priority[];
  /** "You choose", "surprise me": the person asked BuildWise to pick the look. */
  chooseForMe: boolean;
  grandFocus?: GrandFocus;
  /** The plot size is explicitly not known. */
  plotUnknown: boolean;
  /** They want to plan for later upgrades or extensions. */
  future: boolean;
  /** A town or state named in the message (first one; alternatives after it). */
  place?: string;
  alternatives?: string[];
  /** Separate evidence of spend: an overall budget, a finish level, or a budget for one system. */
  budgetMinor?: number;
  finish?: 'basic' | 'standard' | 'premium';
  solarBudgetMinor?: [number, number];
}

const PLACES = ['Lagos', 'Ibadan', 'Abuja', 'Port Harcourt', 'Kano', 'Kaduna', 'Benin City', 'Enugu', 'Abeokuta', 'Ilorin', 'Jos', 'Owerri', 'Uyo', 'Calabar', 'Akure', 'Osogbo', 'Warri',
  'Asaba', 'Onitsha', 'Aba', 'Ile-Ife', 'Ado-Ekiti', 'Lekki', 'Ikeja', 'Ikorodu', 'Epe', 'Ajah', 'Accra', 'Kumasi', 'Lome', 'Cotonou', 'Oyo', 'Ogun', 'Osun', 'Ondo', 'Ekiti', 'Kwara',
  'Rivers', 'Delta', 'Edo', 'Anambra', 'Imo', 'Abia', 'Plateau', 'Minna', 'Sokoto', 'Maiduguri', 'Yola', 'Makurdi', 'Lokoja', 'Awka', 'Umuahia', 'Sagamu', 'Ogbomoso', 'Iseyin'];

const KEEPABLE: [string, RegExp][] = [
  ['gym', /\b(gym|fitness)\b/], ['gaming', /\b(gaming|games? room)\b/], ['cinema', /\b(cinema|movie room)\b/], ['family-lounge', /\bfamily (lounge|room)\b/],
  ['laundry', /\blaundry\b/], ['prayer', /\bprayer room\b/], ['lift', /\b(lift|elevator)\b/], ['conference', /\b(conference|boardroom)\b/], ['restaurant', /\brestaurant\b/],
  ['study', /\b(study|home office)\b/], ['bq', /\b(bq|boys'? ?quarters?|staff quarters?)\b/], ['parking', /\b(parking|garage|car ?port)\b/],
  ['bedrooms', /\bbed(room)?s?\b/], ['garden', /\b(garden|yard|compound|lawn|outdoor space)\b/], ['privacy', /\bprivacy\b/], ['host', /\b(hosting|entertain\w*|space to host)\b/],
  ['pool', /\b(swimming )?pool\b/], ['storeys', /\b(stor(e)?ys?|floors?)\b/],
];

/** A naira amount in words: "40 million", "₦10m", "N15,000,000", "2.5bn". Whole currency units, or null. */
export function readAmount(s: string): number | null {
  const m = s.toLowerCase().replace(/,/g, '').match(/(?:₦|ngn|n|naira)?\s*(\d+(?:\.\d+)?)\s*(billion|bn|b|million|m|mil|thousand|k)?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const k = !m[2] ? 1 : /^b/.test(m[2]) ? 1e9 : /^m/.test(m[2]) ? 1e6 : 1e3;
  const v = n * k;
  return v >= 100_000 ? Math.round(v) : null;
}

export function readPreferences(text: string): PreferenceReading {
  const t = ` ${text.toLowerCase().replace(/[‐–—]/g, '-').replace(/[’`]/g, "'")} `;
  const out: PreferenceReading = { priorities: [], chooseForMe: false, plotUnknown: false, future: false };
  const not = (re: RegExp) => new RegExp(`\\b(?:not|no longer|isn'?t|instead of|rather than)(?: for)?(?: (?:my|our|the|a))?\\s*(?:${re.source})`).test(t);

  // Purpose. A negated purpose ("not my family") is dropped, so a correction can replace it.
  const FAMILY = /(?:(?:my|our) (?:own )?(?:family|wife|husband|kids|children|parents|mother|father|household)|family (?:home|house|residence)|we (?:will|want to|plan to|are going to) live|(?:to|will) live in(?: it)?|for us to live|our (?:own |forever |dream )?home|retire(?:ment)?)/;
  const TENANTS = /(?:tenants?|rent(?:al|ing|ed)? (?:income|property|out|units?)|(?:to|for) (?:rent|let)(?: out)?|rent (?:it |them |part )?out|let (?:it |them )?out|to let|investment (?:property)?|as an investment|landlord|short[- ]let|airbnb|income property)/;
  const OWN = /(?:(?:my|our) (?:own )?(?:business|company|firm|practice|shop|store|brand|staff|team)|(?:run|operate|manage) (?:it )?(?:myself|ourselves)|owner[- ]occup|we will (?:run|use) it)/;
  const COMMUNITY = /(?:(?:our|the|my) (?:community|congregation|church members|parish|town|village|ngo|foundation|association|members)|for the community|non[- ]?profit|charity)/;
  const EXPLORE = /(?:not (?:sure|certain|decided)|unsure|still (?:exploring|thinking|deciding|looking|considering)|just (?:exploring|looking|curious|browsing|checking)|haven'?t decided|have not decided|don'?t know (?:yet|what)|undecided|exploring (?:ideas|options)|maybe .* or )/;
  const fam = new RegExp(`\\b${FAMILY.source}\\b`).test(t) && !not(FAMILY);
  const ten = new RegExp(`\\b${TENANTS.source}\\b`).test(t) && !not(TENANTS);
  const own = new RegExp(`\\b${OWN.source}\\b`).test(t) && !not(OWN);
  const both = /\b(live (?:in )?(?:upstairs|downstairs|one|part|the top|the ground)[^.]*\b(?:rent|let)|rent[^.]*\band live\b|family and tenants|tenants and (?:my|our) family|part for (?:us|me)[^.]*part (?:for|to) (?:rent|tenants))/.test(t);
  if (both || (fam && ten) || (own && ten)) out.purpose = 'both';
  else if (ten) out.purpose = 'tenants';
  else if (fam) out.purpose = 'family';
  else if (new RegExp(`\\b${COMMUNITY.source}\\b`).test(t)) out.purpose = 'community';
  else if (own) out.purpose = 'own';
  else if (new RegExp(`\\b${EXPLORE.source}`).test(t)) out.purpose = 'exploring';

  // Taste. The most specific wins: tropical over modern ("contemporary tropical"), grand over the rest.
  const GRAND = /\b(grand\w*|striking|impressive|imposing|stately|luxur(?:y|ious)|mansion|statement|majestic|prestig\w*|palatial|magnificent|wow factor|stand out|turn heads|double[- ]height|double volume)\b/;
  const TROPICAL = /\b(tropical|airy|breez[ey]\w*|cross[- ]?(?:breeze|ventilat\w*)|open[- ]air|verandah?s?|indoor[- ]outdoor|louvres?|shad(?:e|ed|y)|open to the garden)\b/;
  const MODERN = /\b(modern|contemporary|minimal(?:ist)?|clean lines?|sleek|boxy|lots of glass|glass walls?)\b/;
  const SIMPLE = /\b(simple|modest|humble|cos[yi]\w*|coz[yi]\w*|welcoming|homely|nothing fancy|plain|low[- ]key|cottage|unpretentious|warm and)\b/;
  if (GRAND.test(t)) out.taste = 'grand';
  else if (TROPICAL.test(t)) out.taste = 'tropical';
  else if (MODERN.test(t)) out.taste = 'modern';
  else if (SIMPLE.test(t) || /\b(classic|traditional)\b/.test(t)) out.taste = 'simple';
  if (/\b(you (?:choose|decide|pick)|choose for me|surprise me|whatever (?:you think|looks|is) best|not sure (?:about|of) (?:the )?(?:style|look)|any style)\b/.test(t)) { out.chooseForMe = true; delete out.taste; }
  if (out.taste === 'grand') {
    if (/\b(entrance|entry|arrival|porch|front door|from the street|facade|façade|approach|gate)\b/.test(t)) out.grandFocus = 'entry';
    else if (/\b(double[- ]height|double volume|living (?:room|space|area)|high ceilings?|sitting room|parlou?r)\b/.test(t)) out.grandFocus = 'living';
    else if (/\b(host\w*|entertain\w*|gatherings?|guests|parties|events?)\b/.test(t)) out.grandFocus = 'hosting';
  }

  // Priorities.
  const pri: [Priority, RegExp][] = [
    ['garden', /\b((?:bigger|big|large|larger|more|spacious|huge) (?:garden|yard|compound|lawn|outdoor space|green space|backyard)|garden for|room (?:for (?:the )?(?:kids|children) )?to play|space outside|lots of (?:garden|outdoor|green)|keep (?:the plot|it) open|don'?t (?:want to )?lose the garden)\b/],
    ['privacy', /\b(priva(?:te|cy)|overlooked|secluded|seclusion|away from (?:the )?(?:road|street|neighbou?rs)|prying eyes|quiet bedrooms?|sheltered)\b/],
    ['host', /\b(room to host|host(?:ing)?|entertain(?:ing|ment)?(?: a lot)?|parties|gatherings?|owambe|lots of (?:guests|visitors)|big (?:family )?(?:meals|dinners|gatherings)|space for (?:guests|visitors|parties))\b/],
  ];
  out.priorities = pri.filter(([, re]) => re.test(t)).map(([k]) => k);

  out.plotUnknown = /\b(?:don'?t|do not|didn'?t) know (?:the |my |our )?(?:exact )?(?:plot|land|site)(?: size| dimensions?| measurements?)?|(?:plot|land|site)(?: size| dimensions?)? (?:is )?(?:not known|unknown|not sure|not measured)|not sure (?:of|about) (?:the |my )?(?:plot|land)(?: size)?|haven'?t (?:measured|surveyed|bought)|no survey(?: plan)? yet|size not known\b/.test(t);
  out.future = /\b(future (?:upgrades?|expansion|extension|provision|proof\w*)|upgrade (?:it )?later|expand later|add (?:more |it |them )?later|room to (?:grow|upgrade|expand)|phase(?:d|s)?|in stages|later on)\b/.test(t);

  // Places: the first named is where they are building; later ones are alternatives.
  const places = PLACES.map((p) => ({ p, i: t.search(new RegExp(`\\b${p.toLowerCase().replace(/-/g, '[- ]')}\\b`)) })).filter((x) => x.i >= 0).sort((a, b) => a.i - b.i).map((x) => x.p);
  if (places.length) { out.place = places[0]!; if (places.length > 1) out.alternatives = places.slice(1); }

  // Spend needs its own evidence: an amount with "budget", or a finish level. Solar budgets are their own line.
  const solar = t.match(/\bsolar[^.]{0,40}?(\d[\d.,]*)\s*(?:-|to|and)\s*(\d[\d.,]*\s*(?:billion|bn|million|m|mil|k)?)|(\d[\d.,]*)\s*(?:-|to)\s*(\d[\d.,]*\s*(?:billion|bn|million|m|mil|k)?)[^.]{0,30}\bsolar\b/);
  if (solar) {
    const hiText = solar[2] ?? solar[4]!; const hi = readAmount(hiText);
    const unit = hiText.match(/(billion|bn|million|m|mil|k)\b/)?.[1] ?? '';
    const lo = readAmount(`${solar[1] ?? solar[3]} ${unit}`);
    if (lo && hi) out.solarBudgetMinor = [lo * 100, hi * 100];
  }
  const budget = t.replace(/\bsolar[^.]*/, ' ').match(/\b(?:budget|afford|spend|cost(?:ing)?|have)(?: is| of| about| around| up to| only)*\s*(?:₦|ngn|n\b|naira)?\s*(\d[\d.,]*\s*(?:billion|bn|million|m|mil|k)?)|(\d[\d.,]*\s*(?:billion|bn|million|m|mil))\s*(?:naira\s*)?(?:budget|to (?:spend|build))/);
  if (budget) { const v = readAmount(budget[1] ?? budget[2]!); if (v) out.budgetMinor = v * 100; }
  if (/\b(premium|high[- ]end|top[- ]quality|luxury) (?:finish\w*|fittings|materials)|no expense spared\b/.test(t)) out.finish = 'premium';
  else if (/\b(basic|cheap\w*|low[- ]cost|budget|affordable|economy) (?:finish\w*|fittings|materials|build)\b/.test(t)) out.finish = 'basic';
  return out;
}

// ---------------------------------------------------------------- revisions

export interface BriefRevision {
  /** What has to get smaller. */
  smaller: ('plot' | 'budget' | 'house')[];
  /** What must survive the change: feature keys, 'study', 'bq', 'parking', 'bedrooms', 'garden', 'privacy', 'host', 'pool'. */
  keep: string[];
}

/** A change that shrinks something while protecting something else, or null when the message is not one. */
export function readRevision(text: string): BriefRevision | null {
  const t = ` ${text.toLowerCase().replace(/[’`]/g, "'")} `;
  const smaller: BriefRevision['smaller'] = [];
  const LESS = '(?:smaller|small|reduc\\w*|shrink\\w*|less|tighter|half|cut\\w*|lower\\w*|downsiz\\w*|trim\\w*|narrower|shorter)';
  if (new RegExp(`\\b${LESS}\\b[^.]{0,30}\\b(?:plot|land|site)\\b|\\b(?:plot|land|site)\\b[^.]{0,25}\\b${LESS}\\b`).test(t)) smaller.push('plot');
  if (new RegExp(`\\b${LESS}\\b[^.]{0,30}\\b(?:budget|costs?|spend|price)\\b|\\b(?:budget|costs?|money)\\b[^.]{0,25}\\b${LESS}\\b|\\b(?:cheaper|can'?t afford|cannot afford|too expensive|can only afford|only afford|less money)\\b`).test(t)) smaller.push('budget');
  if (new RegExp(`\\b${LESS}\\b[^.]{0,20}\\b(?:house|home|building|footprint|floor area)\\b|\\b(?:house|home|building|footprint)\\b[^.]{0,20}\\b${LESS}\\b`).test(t)) smaller.push('house');
  const keepClause = t.match(/\b(?:keep(?:ing)?|retain(?:ing)?|without (?:losing|removing|dropping)|don'?t (?:lose|remove|drop|touch)|do not (?:lose|remove|drop)|must (?:have|keep|stay)|still (?:have|want|need)|protect(?:ing)?|not (?:losing|removing))\b([^.;]{0,60})/g) ?? [];
  const keep = [...new Set(keepClause.flatMap((c) => KEEPABLE.filter(([, re]) => re.test(c)).map(([k]) => k)))];
  if (!smaller.length && !keep.length) return null;
  if (!smaller.length) return null; // "keep the gym" alone is not a revision
  return { smaller, keep };
}

// ---------------------------------------------------------------- routing to BuildWise's tools

export type Route = 'design' | 'revise' | 'calculate:budget' | 'calculate:energy' | 'calculate:water' | 'calculate:cooling' | 'marketplace' | 'knowledge' | 'none';

/** Which BuildWise tool a message needs (the local assistant's routing; a connected model gets it as a hint). */
export function routeFor(text: string, intent: string, revision: BriefRevision | null): Route {
  const t = ` ${text.toLowerCase()} `;
  if (intent === 'shopping') return 'marketplace';
  if (intent === 'greeting' || intent === 'thanks' || intent === 'out_of_scope') return 'none';
  if (revision) return 'revise';
  const mine = /\b(this|my|the|our|it)\b/.test(t);
  const general = /\b(what is|what'?s|what are|meaning of|difference between|define)\b/.test(t);
  if (!general) {
    if (/\b(solar|inverter|batter(?:y|ies)|electric\w*|power|generator|kwh|nepa|light bill|energy)\b/.test(t) && /\b(how (?:much|many|big)|what size|size|need|use|cost|worth)\b/.test(t)) return 'calculate:energy';
    if (/\b(water|borehole|tank|septic|soakaway|pump)\b/.test(t) && /\b(how (?:much|many|big)|what size|size|need)\b/.test(t)) return 'calculate:water';
    if (/\b(air ?con\w*|\bacs?\b|cooling|air conditioners?)\b/.test(t) && /\b(how (?:much|many|big)|what size|size|need)\b/.test(t)) return 'calculate:cooling';
    if (/\b(cost|budget|afford|price|spend|how much)\b/.test(t) && mine && /\b(build|house|home|design|building|it|this)\b/.test(t)) return 'calculate:budget';
  }
  if (/\b(designs?|options?|concepts?|layouts?|alternatives?|versions?)\b/.test(t) && /\b(show|give|three|two|3|2|different|other|another|more|compare|generate|make)\b/.test(t)) return 'design';
  if (intent === 'build_home') return 'design';
  if (intent === 'question') return 'knowledge';
  return 'none';
}
