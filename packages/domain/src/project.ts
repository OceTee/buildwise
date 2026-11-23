/**
 * The project record: the building as a connected set of decisions, not a chat history. It keeps apart what the
 * person confirmed, what was assumed, what was estimated and what a professional must verify, records decisions
 * with their status and revisions with what each change affects, and checks the systems against each other.
 * Stored with the build in the browser; pure, so the page and the AI see the same record.
 */
import type { Design, DesignBrief, Plot } from './design';
import { BUILDING_TYPES, FEATURES, isHouse } from './building';
import { DEFAULT_PLANNING_CONFIG, budgetPlan, coolingPlan, defaultLoads, energyPlan, waterPlan, type BudgetPlan, type EnergyPlan, type FinishBand, type Load, type PlanningConfig, type SolarOptions, type WaterPlan } from './planning';

// ---------------------------------------------------------------- stages

export type StageKey = 'understand' | 'constraints' | 'concept' | 'systems' | 'estimate' | 'refine';
export const STAGES: { key: StageKey; n: string; label: string; blurb: string }[] = [
  { key: 'understand', n: '01', label: 'Understand', blurb: 'Who will live here, what you want, the land and the budget.' },
  { key: 'constraints', n: '02', label: 'Constraints', blurb: 'Site, setbacks, climate, access, budget and rules.' },
  { key: 'concept', n: '03', label: 'Concept', blurb: 'Building form, rooms and how they work together.' },
  { key: 'systems', n: '04', label: 'Systems', blurb: 'Cooling, water, power and optional solar, coordinated with the rooms.' },
  { key: 'estimate', n: '05', label: 'Estimate', blurb: 'Budget, materials, quantities and where to buy.' },
  { key: 'refine', n: '06', label: 'Refine', blurb: 'Decisions, open questions, conflicts and deliverables.' },
];

// ---------------------------------------------------------------- the record

export type FactStatus = 'confirmed' | 'assumed' | 'estimated' | 'recommended' | 'needs_verification';
export type DecisionStatus = 'suggested' | 'proposed' | 'confirmed' | 'rejected' | 'superseded' | 'pending_verification';
export type Author = 'you' | 'ai' | 'engine';

export interface ProjectFact { id: string; label: string; value: string; status: FactStatus; by: Author; stage: StageKey }
export interface ProjectDecision { id: string; topic: string; choice: string; status: DecisionStatus; by: Author; at: string; note?: string; affects: string[] }
export interface OpenQuestion { id: string; question: string; stage: StageKey; by: Author; at: string; resolved: boolean }
export interface Revision { at: string; summary: string; affects: string[] }

export interface ProjectRecord {
  version: 1;
  name: string;
  location: { country: string; state: string; city: string };
  occupants: { adults: number; children: number; elders: number; staff: number };
  lifestyle: string;
  budget: { amountMinor: number | null; includesLand: boolean; landCostMinor: number; finish: FinishBand; externalWorks: boolean; furniture: boolean };
  systems: { airConditioning: boolean; kitchenAc: boolean; borehole: boolean; hotWater: boolean; solar: SolarOptions; loads: Load[] | null };
  /** Where each brief value came from: said or chosen by the person, or read by the AI from their words. */
  briefSource: Partial<Record<keyof DesignBrief, Author>>;
  /** Facts the AI proposed (assumptions, recommendations); the person can confirm or drop them. */
  notes: ProjectFact[];
  decisions: ProjectDecision[];
  questions: OpenQuestion[];
  revisions: Revision[];
}

export const DEFAULT_PROJECT: ProjectRecord = {
  version: 1, name: 'My home', location: { country: 'Nigeria', state: '', city: '' }, occupants: { adults: 2, children: 2, elders: 0, staff: 0 }, lifestyle: '',
  budget: { amountMinor: null, includesLand: false, landCostMinor: 0, finish: 'standard', externalWorks: true, furniture: false },
  systems: { airConditioning: true, kitchenAc: false, borehole: true, hotWater: true, solar: { enabled: false, cover: 'most', autonomyDays: 1 }, loads: null },
  briefSource: {}, notes: [], decisions: [], questions: [], revisions: [],
};

export function normaliseProject(x: Partial<ProjectRecord> | null | undefined): ProjectRecord {
  const p = { ...DEFAULT_PROJECT, ...(x ?? {}) };
  const num = (v: unknown, d: number, lo = 0, hi = 1e15) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  return {
    version: 1,
    name: String(p.name || 'My home').slice(0, 80),
    location: { country: String(p.location?.country ?? 'Nigeria').slice(0, 60), state: String(p.location?.state ?? '').slice(0, 60), city: String(p.location?.city ?? '').slice(0, 60) },
    occupants: { adults: num(p.occupants?.adults, 2, 1, 20), children: num(p.occupants?.children, 0, 0, 20), elders: num(p.occupants?.elders, 0, 0, 10), staff: num(p.occupants?.staff, 0, 0, 10) },
    lifestyle: String(p.lifestyle ?? '').slice(0, 600),
    budget: {
      amountMinor: p.budget?.amountMinor == null ? null : num(p.budget.amountMinor, 0), includesLand: !!p.budget?.includesLand, landCostMinor: num(p.budget?.landCostMinor, 0),
      finish: (['basic', 'standard', 'premium'] as const).includes(p.budget?.finish as FinishBand) ? p.budget!.finish : 'standard',
      externalWorks: p.budget?.externalWorks !== false, furniture: !!p.budget?.furniture,
    },
    systems: {
      airConditioning: p.systems?.airConditioning !== false, kitchenAc: !!p.systems?.kitchenAc, borehole: p.systems?.borehole !== false, hotWater: p.systems?.hotWater !== false,
      solar: { enabled: !!p.systems?.solar?.enabled, cover: (['essential', 'most', 'all'] as const).includes(p.systems?.solar?.cover as SolarOptions['cover']) ? p.systems!.solar.cover : 'most', autonomyDays: num(p.systems?.solar?.autonomyDays, 1, 0.5, 3) },
      loads: Array.isArray(p.systems?.loads) ? p.systems!.loads!.slice(0, 80) : null,
    },
    briefSource: p.briefSource && typeof p.briefSource === 'object' ? p.briefSource : {},
    notes: Array.isArray(p.notes) ? p.notes.slice(-60) : [],
    decisions: Array.isArray(p.decisions) ? p.decisions.slice(-120) : [],
    questions: Array.isArray(p.questions) ? p.questions.slice(-60) : [],
    revisions: Array.isArray(p.revisions) ? p.revisions.slice(-120) : [],
  };
}

export const occupantCount = (p: ProjectRecord) => p.occupants.adults + p.occupants.children + p.occupants.elders + p.occupants.staff;

// ---------------------------------------------------------------- what a change affects

/** What a change to each part of the project touches, so a revision never forgets its consequences. */
export const IMPACTS: Record<string, string[]> = {
  plot: ['setbacks and coverage', 'layout options', 'parking and driveway', 'landscaping', 'cost'],
  bedrooms: ['floor area', 'structure (columns, beams, slabs)', 'roof', 'cooling loads', 'electrical points', 'plumbing', 'finishes', 'cost', 'energy demand'],
  storeys: ['structure and foundations', 'stair', 'roof', 'plumbing stacks', 'cooling loads', 'cost'],
  'room size': ['floor area', 'structure (column positions, beam spans, slab)', 'window placement', 'cooling load', 'electrical outlets', 'furniture layout', 'flooring and wall finishes', 'cost', 'energy demand'],
  layout: ['rooms and circulation', 'structure', 'roof', 'plumbing routes', 'cooling', 'cost', 'drawings'],
  roof: ['roof structure', 'roofing materials', 'gutters and drainage', 'heat gain and cooling', 'solar panel space', 'cost'],
  budget: ['finish level', 'scope and phasing', 'systems (solar, cooling)', 'contingency'],
  occupants: ['water demand and storage', 'septic tank', 'energy demand', 'room programme'],
  solar: ['battery space and ventilation', 'inverter and wiring', 'roof loading and layout', 'generator size', 'cost'],
  cooling: ['electrical demand', 'inverter and generator size', 'solar size', 'wall sleeves and drainage', 'cost'],
  water: ['pump power', 'tank stand structure', 'plumbing', 'energy demand', 'cost'],
  location: ['climate assumptions', 'cooling loads', 'solar yield', 'materials and prices', 'regulations'],
  finish: ['cost', 'materials', 'interior concept'],
};

export function impactOf(topic: string): string[] { return IMPACTS[topic] ?? ['related parts of the design', 'cost']; }

const nowIso = () => new Date().toISOString();
let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Records a decision. A new confirmed choice on a topic supersedes the previous one and adds a revision with what
 * the change affects. AI proposals arrive as `proposed` and never become confirmed without the person.
 */
export function recordDecision(p: ProjectRecord, topic: string, choice: string, by: Author, status: DecisionStatus = by === 'you' ? 'confirmed' : 'proposed', note?: string): ProjectRecord {
  const current = p.decisions.find((d) => d.topic === topic && d.status === 'confirmed');
  if (current && current.choice === choice && status === 'confirmed') return p;
  if (status !== 'confirmed' && p.decisions.some((d) => d.topic === topic && d.choice === choice && (d.status === 'proposed' || d.status === 'suggested'))) return p;
  const at = nowIso();
  const decisions = p.decisions.map((d) => (status === 'confirmed' && d.topic === topic && d.status === 'confirmed' ? { ...d, status: 'superseded' as const } : d));
  decisions.push({ id: newId('d'), topic, choice, status, by, at, note, affects: impactOf(topic) });
  const revisions = status === 'confirmed' && current ? [...p.revisions, { at, summary: `${topic}: ${current.choice} → ${choice}`, affects: impactOf(topic) }] : p.revisions;
  return { ...p, decisions, revisions };
}

/** The person confirms or rejects a proposal. */
export function settleDecision(p: ProjectRecord, id: string, to: 'confirmed' | 'rejected'): ProjectRecord {
  const d = p.decisions.find((x) => x.id === id);
  if (!d) return p;
  if (to === 'rejected') return { ...p, decisions: p.decisions.map((x) => (x.id === id ? { ...x, status: 'rejected' } : x)) };
  const withOut = { ...p, decisions: p.decisions.filter((x) => x.id !== id) };
  return recordDecision(withOut, d.topic, d.choice, 'you', 'confirmed', d.note);
}

export function addQuestion(p: ProjectRecord, question: string, stage: StageKey, by: Author): ProjectRecord {
  const q = question.trim();
  if (!q || p.questions.some((x) => !x.resolved && x.question.toLowerCase() === q.toLowerCase())) return p;
  return { ...p, questions: [...p.questions, { id: newId('q'), question: q.slice(0, 300), stage, by, at: nowIso(), resolved: false }] };
}

export function addNote(p: ProjectRecord, label: string, value: string, status: FactStatus, by: Author, stage: StageKey): ProjectRecord {
  if (p.notes.some((n) => n.label === label && n.value === value)) return p;
  return { ...p, notes: [...p.notes, { id: newId('n'), label: label.slice(0, 120), value: value.slice(0, 400), status, by, stage }] };
}

// ---------------------------------------------------------------- facts, derived

const BRIEF_LABELS: Record<keyof DesignBrief, string> = {
  type: 'Building type', units: 'Size', features: 'Extra rooms and services', storeys: 'Storeys', bedrooms: 'Bedrooms', bathrooms: 'Shared bathrooms', ensuite: 'Master ensuite', kitchen: 'Kitchen', study: 'Study', guestWc: 'Guest toilet',
  store: 'Store room', parking: 'Parking spaces', style: 'Style', roof: 'Roof form', roofFinish: 'Roof covering', roofColour: 'Roof colour', roofPitch: 'Roof pitch', bq: "Boys' quarters",
};

/** Everything known about the project, each with where it came from. */
export function projectFacts(p: ProjectRecord, plot: Plot | null, brief: DesignBrief, design: Design | null): ProjectFact[] {
  const out: ProjectFact[] = [];
  const f = (id: string, label: string, value: string, status: FactStatus, by: Author, stage: StageKey) => out.push({ id, label, value, status, by, stage });
  const loc = [p.location.city, p.location.state, p.location.country].filter(Boolean).join(', ');
  f('location', 'Location', loc || 'Not given: a hot, humid West African climate is assumed', p.location.city || p.location.state ? 'confirmed' : 'assumed', p.location.city ? 'you' : 'engine', 'understand');
  f('plot', 'Plot', plot ? `${plot.widthM} × ${plot.depthM} m (${Math.round(plot.widthM * plot.depthM)} m²)` : 'Not given', plot ? 'confirmed' : 'assumed', 'you', 'understand');
  f('occupants', 'Household', `${occupantCount(p)} people (${p.occupants.adults} adults, ${p.occupants.children} children${p.occupants.elders ? `, ${p.occupants.elders} elders` : ''}${p.occupants.staff ? `, ${p.occupants.staff} staff` : ''})`, p.decisions.some((d) => d.topic === 'occupants' && d.status === 'confirmed') ? 'confirmed' : 'assumed', 'you', 'understand');
  f('budget', 'Budget', p.budget.amountMinor === null ? 'Not given yet' : `${Math.round(p.budget.amountMinor / 100).toLocaleString('en')}${p.budget.includesLand ? ' including land' : ''}`, p.budget.amountMinor === null ? 'assumed' : 'confirmed', 'you', 'understand');
  const info = BUILDING_TYPES[brief.type] ?? BUILDING_TYPES.bungalow;
  const house = isHouse(brief.type);
  const HOUSE_ONLY = new Set<keyof DesignBrief>(['bathrooms', 'ensuite', 'kitchen', 'study', 'guestWc', 'store', 'bq']);
  for (const k of Object.keys(BRIEF_LABELS) as (keyof DesignBrief)[]) {
    if (!house && HOUSE_ONLY.has(k)) continue;
    if (k === 'units' && !info.units) continue;
    if (k === 'bedrooms' && !info.bedrooms) continue;
    const v = brief[k];
    const value = k === 'type' ? info.label
      : k === 'units' ? `${v} ${info.units!.short}`
      : k === 'bedrooms' ? `${v}${info.bedrooms && info.bedrooms.label !== 'Bedrooms' ? ` (${info.bedrooms.label.toLowerCase()})` : ''}`
      : k === 'features' ? (brief.features.length ? brief.features.map((x) => FEATURES[x].label).join(', ') : 'None')
      : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v);
    const src = p.briefSource[k];
    f(`brief-${k}`, BRIEF_LABELS[k], value, src ? 'confirmed' : 'assumed', src ?? 'engine', k.startsWith('roof') || k === 'style' ? 'concept' : 'understand');
  }
  f('setbacks', 'Setbacks and coverage limit', 'Proposed market values until the local planning office confirms them', 'needs_verification', 'engine', 'constraints');
  f('soil', 'Soil and foundations', 'Unknown: needs a soil investigation', 'needs_verification', 'engine', 'constraints');
  if (design) {
    f('design', 'Design', `${design.name}, ${design.metrics.grossFloorM2} m² gross floor, ${design.metrics.coveragePct}% site coverage${design.edits ? `, ${design.edits} of your edits` : ''}`, 'estimated', 'engine', 'concept');
  }
  for (const n of p.notes) out.push(n);
  return out;
}

// ---------------------------------------------------------------- progress, checks and verification

export interface StageStatus { key: StageKey; done: boolean; next: string }

export function stageProgress(p: ProjectRecord, plot: Plot | null, design: Design | null, plans: { budget?: BudgetPlan | null }): StageStatus[] {
  const confirmed = (t: string) => p.decisions.some((d) => d.topic === t && d.status === 'confirmed');
  const stages: StageStatus[] = [
    { key: 'understand', done: !!plot && Object.keys(p.briefSource).length > 0, next: !plot ? 'Give the plot size.' : 'Describe the home you want.' },
    { key: 'constraints', done: !!(p.location.city || p.location.state) && p.budget.amountMinor !== null, next: !(p.location.city || p.location.state) ? 'Say where the plot is.' : 'Set a budget.' },
    { key: 'concept', done: !!design && confirmed('layout'), next: 'Choose a design and confirm it.' },
    { key: 'systems', done: confirmed('cooling') && confirmed('water') && confirmed('solar'), next: 'Confirm cooling, water and power.' },
    { key: 'estimate', done: !!plans.budget && p.budget.amountMinor !== null, next: 'Review the budget and materials.' },
  ];
  // Refining is only finished once every earlier stage is, with nothing left open.
  const settled = p.questions.every((q) => q.resolved) && !p.decisions.some((d) => d.status === 'proposed');
  stages.push({ key: 'refine', done: settled && stages.every((x) => x.done), next: settled ? 'Finish the earlier stages first.' : 'Settle open questions and proposals.' });
  return stages;
}

export interface ProjectIssue { level: 'info' | 'warn' | 'conflict'; text: string; stage: StageKey }

/** Coordination checks across the systems, the design and the budget. */
export function projectChecks(p: ProjectRecord, design: Design | null, plans: { cooling?: ReturnType<typeof coolingPlan> | null; water?: WaterPlan | null; energy?: EnergyPlan | null; budget?: BudgetPlan | null }): ProjectIssue[] {
  const out: ProjectIssue[] = [];
  if (!p.location.city && !p.location.state) out.push({ level: 'info', text: 'Location not given: climate, prices and rules are assumed for a hot, humid West African city.', stage: 'constraints' });
  if (design) for (const c of design.checks.filter((x) => x.status !== 'pass')) out.push({ level: c.status === 'fail' ? 'conflict' : 'warn', text: `${c.label}: ${c.detail}`, stage: 'concept' });
  const e = plans.energy?.result;
  if (e?.solar && plans.cooling && plans.cooling.result.inputKw > e.solar.inverterKw && p.systems.solar.cover === 'all') out.push({ level: 'conflict', text: `The air conditioners draw ${plans.cooling.result.inputKw} kW together, more than the ${e.solar.inverterKw} kW inverter: limit which run together or take ACs off solar.`, stage: 'systems' });
  if (e?.solar && design && e.solar.panels * 2.6 > design.metrics.footprintM2 * 0.6) out.push({ level: 'warn', text: `${e.solar.panels} panels need about ${Math.round(e.solar.panels * 2.6)} m² of roof; check the roof faces that get sun, or mount some on a carport.`, stage: 'systems' });
  if (e?.solar && design?.roof.kind === 'butterfly') out.push({ level: 'info', text: 'A butterfly roof suits panels on the outer slopes only; plan their tilt and the valley gutter together.', stage: 'systems' });
  const w = plans.water?.result;
  if (w && w.storageL > 3000 && design?.roof.kind !== 'flat') out.push({ level: 'info', text: `${w.storageL} L of storage needs an engineered tank stand or a ground tank with a booster pump.`, stage: 'systems' });
  const b = plans.budget?.result;
  if (b && b.gapMinor !== null && b.gapMinor > 0) out.push({ level: 'conflict', text: `The estimate is over budget by about ${Math.round(b.gapMinor / 100).toLocaleString('en')}; see the options to close the gap.`, stage: 'estimate' });
  if (p.budget.amountMinor === null) out.push({ level: 'info', text: 'No budget given yet, so the design cannot be checked against what you can spend.', stage: 'understand' });
  for (const d of p.decisions.filter((x) => x.status === 'proposed')) out.push({ level: 'info', text: `Waiting for you: ${d.topic} → ${d.choice}`, stage: 'refine' });
  return out;
}

/** What a qualified professional must verify before building, and why. */
export function verificationRegister(p: ProjectRecord, design: Design | null): { item: string; professional: string; why: string }[] {
  const out = [
    { item: 'Structure: columns, beams, slabs and reinforcement', professional: 'Structural engineer', why: 'Concept designs are not structural calculations.' },
    { item: 'Foundations and soil', professional: 'Geotechnical engineer (soil test)', why: 'Foundation type and depth depend on the soil.' },
    { item: 'Stamped drawings and the building permit', professional: 'Registered architect', why: 'Permits need drawings from a registered professional.' },
    { item: 'Setbacks, coverage and approvals', professional: 'Local planning office', why: 'Rule values here are proposed, not confirmed for your area.' },
    { item: 'Electrical installation and protection', professional: 'Licensed electrician / electrical engineer', why: 'Cable sizes, protection and earthing must meet the wiring regulations.' },
    { item: 'Plumbing, drainage and septic tank', professional: 'Plumbing or public health engineer', why: 'Pipe sizes, falls and septic sizing depend on the site.' },
  ];
  if (p.systems.solar.enabled) out.push({ item: 'Solar, battery and inverter', professional: 'Qualified solar installer', why: 'DC protection, battery safety and ventilation must be designed for your equipment.' });
  if (p.systems.airConditioning) out.push({ item: 'Air-conditioning sizes', professional: 'HVAC engineer or installer', why: 'Loads here are rules of thumb.' });
  if (p.systems.borehole) out.push({ item: 'Borehole depth, yield and water quality', professional: 'Licensed driller and water lab', why: 'Depth and treatment depend on the ground water.' });
  if (design && design.storeys > 1) out.push({ item: 'Stair and fire escape', professional: 'Architect and fire officer', why: 'Escape routes for upper floors must be checked.' });
  return out;
}

// ---------------------------------------------------------------- all the plans for a project

/**
 * Cooling, water, energy and budget for a design and project, the same in the browser and on the server.
 * `o` holds what-if overrides (occupants, airConditioning, kitchenAc, borehole, hotWater, storageDays, solar,
 * solarCover, autonomyDays, budget in whole currency units, finish, furniture) that leave the project unchanged.
 */
/**
 * How many people the water plan should size for. Houses use the household; other buildings count residents or
 * an equivalent (a worker or pupil uses far less water than a resident), from the rooms of the design.
 */
export function buildingOccupants(design: Design, p: ProjectRecord): number {
  if (isHouse(design.brief.type)) return occupantCount(p);
  const n = (k: string) => design.rooms.filter((r) => r.kind === k).length;
  const beds = design.brief.bedrooms;
  const gfa = design.metrics.grossFloorM2;
  const per: Record<string, number> = {
    terrace: n('living-kitchen') * (beds + 1),
    apartments: n('flat') * (beds + 1),
    'mixed-use': n('flat') * (beds + 1) + Math.round((n('shop') * 3 + n('open-office') * 9) * 0.4),
    shops: Math.round(n('shop') * 3 * 0.4),
    office: Math.round((gfa / 10) * 0.4),
    warehouse: Math.round((gfa / 40) * 0.4),
    hotel: Math.round(n('guest-room') * 2 * 1.2) + 4,
    'event-hall': Math.round(design.brief.units * 0.1),
    school: Math.round(n('classroom') * 35 * 0.25),
    clinic: Math.round(gfa / 10 * 0.6),
    worship: Math.round(design.brief.units * 0.1),
  };
  return Math.max(2, per[design.brief.type] ?? Math.round(gfa / 30));
}

export function planProject(design: Design, p: ProjectRecord, cfg: PlanningConfig = DEFAULT_PLANNING_CONFIG, o: Record<string, unknown> = {}) {
  const sys = p.systems;
  const bool = (k: string, d: boolean) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : d);
  const num = (k: string, d: number) => (o[k] !== undefined && o[k] !== null && Number.isFinite(Number(o[k])) ? Number(o[k]) : d);
  const cooling = coolingPlan(design, { airConditioning: bool('airConditioning', sys.airConditioning), kitchenAc: bool('kitchenAc', sys.kitchenAc) }, cfg);
  const water = waterPlan(design, { occupants: num('occupants', buildingOccupants(design, p)), borehole: bool('borehole', sys.borehole), hotWater: bool('hotWater', sys.hotWater), storageDays: num('storageDays', cfg.water.storageDays) }, cfg);
  const cover = (['essential', 'most', 'all'] as const).find((c) => c === o.solarCover) ?? sys.solar.cover;
  const solar = { enabled: bool('solar', sys.solar.enabled), cover, autonomyDays: num('autonomyDays', sys.solar.autonomyDays) };
  const loads = sys.loads ?? defaultLoads(design, cooling, water);
  const energy = energyPlan(loads, solar, cfg);
  const budget = budgetPlan(design, {
    budgetMinor: o.budget !== undefined ? Math.round(num('budget', 0) * 100) : p.budget.amountMinor,
    landIncluded: p.budget.includesLand, landCostMinor: p.budget.landCostMinor,
    finish: (['basic', 'standard', 'premium'] as const).find((f) => f === o.finish) ?? p.budget.finish,
    externalWorks: p.budget.externalWorks, furniture: bool('furniture', p.budget.furniture),
  }, { cooling: cooling.result.acUnits ? cooling : null, water, energy: solar.enabled ? energy : null }, cfg);
  return { cooling, water, energy, budget, loads };
}
export type ProjectPlans = ReturnType<typeof planProject>;
