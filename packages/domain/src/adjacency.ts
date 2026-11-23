/**
 * How rooms want to relate to each other: the planning logic an architect carries in their head. Positive scores
 * are rooms that belong side by side (food flows from kitchen to dining to living; a master suite wants its
 * ensuite), negative ones should never share a wall (a toilet beside the kitchen; a cinema against a bedroom).
 * BuildWise's engine arranges rooms to maximise this, ranks designs by it, and the AI architects are given it.
 * Pure data and a few functions; no geometry beyond "which rooms share a wall".
 */
import type { RoomKind } from './design';

type Rule = [RoomKind | RoomKind[], RoomKind | RoomKind[], number, string];

const FOOD: RoomKind[] = ['kitchen', 'dining', 'living-kitchen', 'restaurant'];
const LOOS: RoomKind[] = ['wc', 'toilets', 'bathroom'];
const SLEEP: RoomKind[] = ['master', 'bedroom', 'guest-room', 'ward'];
const LOUD: RoomKind[] = ['cinema', 'gaming', 'gym'];

const RULES: Rule[] = [
  // the daily flow of a home
  ['kitchen', 'dining', 3, 'food goes straight from the kitchen to the table'],
  ['dining', 'living', 3, 'dining and sitting run together for guests and family'],
  ['kitchen', 'laundry', 2, 'wet services share pipes and the back door'],
  ['kitchen', 'store', 2, 'a pantry or store sits beside the kitchen'],
  ['living', 'lounge', 1, 'family rooms open off the main living space'],
  ['master', 'ensuite', 3, 'the master suite keeps its own bathroom'],
  [['bedroom', 'guest-room'], 'bathroom', 2, 'bedrooms share a bathroom close by'],
  ['master', 'study', 1, 'a study can sit quietly by the master suite'],
  ['lounge', ['gaming', 'cinema'], 1, 'leisure rooms gather round the family lounge'],
  ['gym', 'bathroom', 1, 'a gym wants a shower nearby'],
  ['prayer', 'master', 1, 'a prayer room is private and quiet'],
  // what must never touch
  [LOOS, FOOD, -4, 'a toilet must never share a wall with food (hygiene, smell, noise)'],
  [LOUD, SLEEP, -2, 'loud rooms keep away from where people sleep'],
  ['kitchen', SLEEP, -2, 'kitchen noise and smell keep away from bedrooms'],
  [['living', 'living-kitchen'], 'master', -1, 'visitors in the living room should not be beside the master bedroom'],
  ['plant', SLEEP, -2, 'plant rooms hum'],
  // larger buildings
  ['restaurant', 'kitchen', 3, 'a restaurant needs its kitchen right behind it'],
  ['lobby', ['restaurant', 'meeting'], 2, 'guests reach public rooms straight from the lobby'],
  ['lobby', 'toilets', 1, 'visitor toilets sit near the entrance'],
  ['loading', 'warehouse', 3, 'goods come off the truck straight onto the floor'],
  ['stage', 'hall', 3, 'the stage opens onto the hall'],
  ['consult', 'lobby', 1, 'patients go from waiting to consulting rooms'],
  ['classroom', 'toilets', -1, 'classrooms keep a little distance from toilets'],
];

const TABLE = new Map<string, { score: number; why: string }>();
for (const [as, bs, score, why] of RULES) {
  for (const a of [as].flat()) for (const b of [bs].flat()) {
    TABLE.set(`${a}|${b}`, { score, why });
    TABLE.set(`${b}|${a}`, { score, why });
  }
}

/** How much two kinds of room want to be next to each other (positive) or apart (negative). */
export function affinity(a: RoomKind, b: RoomKind): number { return TABLE.get(`${a}|${b}`)?.score ?? 0; }
export function affinityWhy(a: RoomKind, b: RoomKind): string | null { return TABLE.get(`${a}|${b}`)?.why ?? null; }

/** The relationships that matter, as plain lines an AI architect can work from. */
export function planningPrinciples(): string[] {
  return RULES.map(([a, b, s, why]) => `${s > 0 ? 'Together' : 'Apart'} (${s > 0 ? '+' : ''}${s}): ${[a].flat().join('/')} and ${[b].flat().join('/')}: ${why}.`);
}

export interface Relation { a: string; b: string; score: number; why: string }

interface RoomLike { id: string; kind: RoomKind; name: string; storey: number; x: number; y: number; w: number; d: number }
function sharesWall(r: RoomLike, o: RoomLike): boolean {
  const v = Math.abs(r.x + r.w - o.x) < 1e-3 || Math.abs(o.x + o.w - r.x) < 1e-3;
  const h = Math.abs(r.y + r.d - o.y) < 1e-3 || Math.abs(o.y + o.d - r.y) < 1e-3;
  const oy = Math.min(r.y + r.d, o.y + o.d) - Math.max(r.y, o.y);
  const ox = Math.min(r.x + r.w, o.x + o.w) - Math.max(r.x, o.x);
  return (v && oy > 0.3) || (h && ox > 0.3);
}

/** Reads a plan the way an architect does: which relationships work, which fight, and an overall planning score. */
export function planningAnalysis(rooms: RoomLike[]): { score: number; good: Relation[]; bad: Relation[] } {
  const good: Relation[] = []; const bad: Relation[] = [];
  let score = 0;
  for (let i = 0; i < rooms.length; i++) for (let j = i + 1; j < rooms.length; j++) {
    const r = rooms[i]!; const o = rooms[j]!;
    if (r.storey !== o.storey || !sharesWall(r, o)) continue;
    const t = TABLE.get(`${r.kind}|${o.kind}`);
    if (!t) continue;
    score += t.score;
    (t.score > 0 ? good : bad).push({ a: r.name, b: o.name, score: t.score, why: t.why });
  }
  return { score, good: good.sort((p, q) => q.score - p.score), bad: bad.sort((p, q) => p.score - q.score) };
}
