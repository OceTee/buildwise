'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, Ruler, ShoppingCart } from 'lucide-react';
import {
  BUILDING_TYPES, COMMON_PLOTS, DEFAULT_BRIEF, DEFAULT_DESIGN_CONFIG, DEFAULT_LANDSCAPE, DEFAULT_PLANNING_CONFIG, DEFAULT_PROJECT, ROOF_FINISHES, ROOF_OPTIONS,
  applyAiReview, applyEdits, billOfMaterials, candidateDesigns, chooseTaste, conceptFor, shapedBy, tasteBrief, designFromLayout, designKey, generateDesigns, isBuildingType, isHouse, landscapeMaterials, normaliseBrief,
  normaliseLandscape, normaliseProject, planLandscape, planProject, recordDecision, suggestedParking, validPlot,
  type AiArchitectReview, type AiLayout, type BuildingType, type Design, type DesignBrief, type DesignConfig, type DesignEdit, type LandscapeOptions, type MaterialLine,
  type PlanningConfig, type Plot, type ProjectRecord, type PreferenceReading,
} from '@bw/domain';
import { call, errorText } from '@/lib/client';
import { money } from '@/lib/format';
import type { View } from './Scene';
import { EditStep } from './EditStep';
import { OutdoorStep } from './OutdoorStep';
import { Nav, StepHead, type StepRef } from './ui';
import { ChatPanel, type Chat, type RevisionProposal } from './ChatPanel';
import { SystemsStep } from './SystemsStep';
import { BudgetStep } from './BudgetStep';
import { RecordStep } from './RecordStep';
import { WhatStep, WhereStep, YoursStep } from './CreateSteps';
import { ConceptCard, OverviewTab, type PlanCard } from './DesignReveal';
import { DreamGallery } from './DreamGallery';
import { PlanLibrary } from './PlanLibrary';

const Scene = dynamic(() => import('./Scene'), { ssr: false, loading: () => <div className="scene-loading">Preparing the 3D view…</div> });

type CreateStep = 'what' | 'where' | 'yours';
type Tab = 'overview' | 'adjust' | 'outdoors' | 'systems' | 'budget' | 'materials' | 'buy' | 'record';
type Step = CreateStep | 'library' | Tab;
const CREATE: { key: CreateStep; label: string }[] = [{ key: 'what', label: 'What' }, { key: 'where', label: 'Where' }, { key: 'yours', label: 'Make it yours' }];
const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' }, { key: 'adjust', label: 'Adjust rooms' }, { key: 'outdoors', label: 'Outdoors' },
  { key: 'systems', label: 'Cooling, water, power' }, { key: 'budget', label: 'Cost' }, { key: 'materials', label: 'Materials' },
  { key: 'buy', label: 'Where to buy' }, { key: 'record', label: 'Project record' },
];
const isTab = (s: Step): s is Tab => TABS.some((t) => t.key === s);
/** Steps saved by the older, longer wizard, mapped onto this one. */
const OLD_STEPS: Record<string, Step> = { land: 'where', plan: 'where', brief: 'yours', site: 'yours', designs: 'overview', edit: 'adjust', generating: 'yours', reveal: 'library' };

const SECTION_LABEL: Record<MaterialLine['section'], string> = {
  substructure: 'Foundations and ground floor', frame: 'Concrete frame and steel', walls: 'Walls', roof: 'Roof',
  openings: 'Doors and windows', finishes: 'Finishes', services: 'Electrical and plumbing', external: 'Landscaping and external works',
};
const STORE_KEY = 'bw-build-v1';
const QUESTIONS = ['Why is it laid out this way?', 'What will it cost to run each month?', 'Is solar worth it here?', 'Who do I hire next, and in what order?'];

/** A brief the assistant read from someone's words: what it set, so later hand corrections can teach it. */
interface Pending { messageId: string; briefAfter: DesignBrief }
interface Sourcing {
  currency: string; pricedLines: number; total: { amountMinor: string; currency: string };
  lines: { key: string; name: string; unit: string; quantity: number; searchPath: string;
    offers: { listingId: string; path: string; title: string; sellerName: string | null; area: string | null; price: { amountMinor: string; currency: string } | null; unitLabel: string; deliveryOffered: boolean; promoted: boolean; lineTotal: { amountMinor: string; currency: string } | null }[] }[];
}
interface Saved {
  step: Step; plot: Plot | null; unit: 'ft' | 'm'; brief: DesignBrief; picked: boolean; designId: string | null; chat: Chat[];
  /** The person's edits per design (see designKey), and their landscape. */
  edits: Record<string, DesignEdit[]>; landscape: LandscapeOptions | null;
  project: ProjectRecord;
  /** Layouts the AI designer composed for this plot and brief (they cannot be regenerated, so they are kept). */
  aiLayouts: { key: string; preferencesKey?: string; layouts: AiLayout[] } | null;
}
function load(): Partial<Saved> & { step?: string } {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<Saved>; } catch { return {}; }
}
function save(s: Saved) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* private mode: the flow still works */ }
}
/** A town or state the architect may see: letters and simple punctuation only. */
const placeOf = (p: ProjectRecord) => [p.location.city, p.location.state].map((x) => x.trim()).filter(Boolean).join(', ').replace(/[^\p{L}\p{M} ,.'-]/gu, '').slice(0, 80);

export function BuildWizard({ initialMessage, initialType, initialPlan }: { initialMessage: string | null; initialType?: string | null; initialPlan?: string | null }) {
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState<Step>('what');
  const [plot, setPlot] = useState<Plot | null>(null);
  const [unit, setUnit] = useState<'ft' | 'm'>('ft');
  const [brief, setBrief] = useState<DesignBrief>(DEFAULT_BRIEF);
  const [picked, setPicked] = useState(false);
  const [designId, setDesignId] = useState<string | null>(null);
  const [chat, setChat] = useState<Chat[]>([]);
  const [cfg, setCfg] = useState<DesignConfig>(DEFAULT_DESIGN_CONFIG);
  const [edits, setEdits] = useState<Record<string, DesignEdit[]>>({});
  const [landscapeOpts, setLandscapeOpts] = useState<LandscapeOptions | null>(null);
  const [project, setProject] = useState<ProjectRecord>(DEFAULT_PROJECT);
  const [planningCfg, setPlanningCfg] = useState<PlanningConfig>(DEFAULT_PLANNING_CONFIG);
  const [currency, setCurrency] = useState('NGN');
  const [builderOn, setBuilderOn] = useState(false);
  const [architectOn, setArchitectOn] = useState(false);
  const [renderOn, setRenderOn] = useState(false);
  const [dreamOn, setDreamOn] = useState(false);
  /** What the designer changed after looking at the 3D model of its design (shown with the concept). */
  const [aiLayouts, setAiLayouts] = useState<Saved['aiLayouts']>(null);
  const pending = useRef<Pending[]>([]);
  const [view, setView] = useState<View>('outside');
  const [facing, setFacing] = useState<'street' | 'garden'>('street');
  const [dark, setDark] = useState(false);
  const stepRef = useRef<HTMLHeadingElement>(null);
  const [dusk, setDusk] = useState(false);
  const capture = useRef<(() => string | null) | null>(null);

  // Restore a build in progress, and read the market's design rules.
  useEffect(() => {
    const s = load();
    if (s.plot && validPlot(s.plot)) setPlot(s.plot);
    if (s.unit) setUnit(s.unit);
    if (s.brief) setBrief(normaliseBrief(s.brief));
    setPicked(!!s.picked || !!s.designId);
    if (s.designId) { autoPick.current = false; setDesignId(s.designId); }
    if (s.chat) setChat(s.chat.slice(-12));
    if (s.edits && typeof s.edits === 'object') setEdits(s.edits);
    if (s.landscape) setLandscapeOpts(normaliseLandscape(s.landscape));
    if (s.project) setProject(normaliseProject(s.project));
    if (s.aiLayouts && Array.isArray(s.aiLayouts.layouts)) setAiLayouts(s.aiLayouts);
    const st = s.step ? (OLD_STEPS[s.step] ?? s.step) as Step : null;
    if (st && !initialMessage && !initialType && !initialPlan) setStep(st);
    setReady(true);
    call<{ design: DesignConfig; planning?: PlanningConfig; currency?: string; architect?: { connected: boolean }; builderAi?: { connected: boolean }; render?: { connected: boolean }; dream?: { connected: boolean } }>('/v1/build/config').then((c) => {
      setCfg(c.design); if (c.planning) setPlanningCfg(c.planning); if (c.currency) setCurrency(c.currency);
      setArchitectOn(!!c.architect?.connected); setBuilderOn(!!c.builderAi?.connected); setRenderOn(!!c.render?.connected); setDreamOn(!!c.dream?.connected);
    }).catch(() => undefined);
    const html = document.documentElement;
    const sync = () => setDark(html.dataset.theme === 'dark' || (!html.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(html, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, [initialMessage, initialType]);
  useEffect(() => { if (ready) save({ step, plot, unit, brief, picked, designId, chat, edits, landscape: landscapeOpts, project, aiLayouts }); }, [ready, step, plot, unit, brief, picked, designId, chat, edits, landscapeOpts, project, aiLayouts]);

  const showingSavedDesign = isTab(step);
  const generated = useMemo(() => (showingSavedDesign && plot ? generateDesigns(plot, brief, cfg) : { designs: [], notes: [] }), [plot, brief, cfg, showingSavedDesign]);
  const place = placeOf(project);

  // The AI architect, when the server has one: it re-ranks the designs, writes the notes and presents the best as a
  // concept. The engine's ranking and concept stand until (and unless) its review arrives for this plot and brief.
  const aiKey = plot ? JSON.stringify({ plot, brief, place }) : '';
  const [ai, setAi] = useState<{ key: string; review: AiArchitectReview } | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const aiFlight = useRef<{ key: string; p: Promise<AiArchitectReview | null> } | null>(null);
  const askArchitect = useCallback((): Promise<AiArchitectReview | null> => {
    if (!architectOn || !plot || !generated.designs.length) return Promise.resolve(null);
    if (ai?.key === aiKey) return Promise.resolve(ai.review);
    if (aiFlight.current?.key === aiKey) return aiFlight.current.p;
    const key = aiKey;
    setAiBusy(true);
    const p = call<{ source: 'ai' | 'engine' } & Partial<AiArchitectReview>>('/v1/build/architect', { body: { plot, brief, ...(place ? { location: place } : {}) } })
      .then((r) => {
        if (r.source !== 'ai' || !r.order || !r.reviews) return null;
        const review: AiArchitectReview = { overview: r.overview ?? '', order: r.order, reviews: r.reviews, ...(r.concept ? { concept: r.concept } : {}) };
        setAi({ key, review });
        return review;
      })
      .catch(() => null)
      .finally(() => { if (aiFlight.current?.key === key) aiFlight.current = null; setAiBusy(false); });
    aiFlight.current = { key, p };
    return p;
  }, [architectOn, plot, brief, place, aiKey, ai, generated.designs.length]);
  const aiNow = ai && ai.key === aiKey ? ai.review : null;
  // Landing on a design (after a reload, say) without the architect's review: ask for it.
  useEffect(() => { if (isTab(step) && architectOn && plot && !aiNow && !(aiLayouts?.key === aiKey)) void askArchitect(); }, [step, architectOn, aiKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Designs the AI designer composed (first), then BuildWise's own, re-ranked by the AI architect when it reviewed them.
  const aiDesigns = useMemo(() => (showingSavedDesign && plot && aiLayouts && aiLayouts.key === aiKey
    ? aiLayouts.layouts.map((l, i) => designFromLayout(plot, brief, l, `ai-${i + 1}`, cfg).design).filter((d): d is Design => !!d)
    : []), [plot, brief, cfg, aiLayouts, aiKey, showingSavedDesign]);
  const result = useMemo(() => {
    if (!showingSavedDesign) return generated;
    const engine = aiNow ? applyAiReview(generated.designs, aiNow) : generated.designs;
    const others = plot && designId && !engine.some((d) => d.id === designId) && !aiDesigns.some((d) => d.id === designId)
      ? candidateDesigns(plot, brief, cfg).filter((d) => d.id === designId) : [];
    const all = [...aiDesigns, ...engine, ...others];
    return { ...generated, designs: [...new Map(all.map((d) => [d.id, d])).values()] };
  }, [generated, aiNow, aiDesigns, plot, designId, brief, cfg, showingSavedDesign]);
  // The design BuildWise picked stays the person's until they choose another direction; a late AI pick replaces it.
  const autoPick = useRef(true);
  useEffect(() => { if (aiNow && autoPick.current && isTab(step) && result.designs[0] && result.designs[0].id !== designId) setDesignId(result.designs[0].id); }, [aiNow]); // eslint-disable-line react-hooks/exhaustive-deps
  const chosen: Design | null = result.designs.find((d) => d.id === designId) ?? result.designs[0] ?? null;
  // A design the AI designer finished after the person skipped ahead takes over, unless they chose another.
  useEffect(() => { if (autoPick.current && isTab(step) && aiDesigns[0] && designId !== aiDesigns[0].id) setDesignId(aiDesigns[0].id); }, [aiDesigns]); // eslint-disable-line react-hooks/exhaustive-deps

  // Ready-made house plans that architects list in the marketplace and that fit this plot.
  const [plans, setPlans] = useState<{ key: string; items: PlanCard[] } | null>(null);
  useEffect(() => {
    if (step !== 'overview' || !plot || project.preferences.plotUnknown || !isHouse(brief.type) || plans?.key === aiKey) return;
    let live = true;
    const q = new URLSearchParams({ widthM: String(plot.widthM), depthM: String(plot.depthM), bedrooms: String(brief.bedrooms), storeys: String(brief.storeys) });
    call<{ items: PlanCard[] }>(`/v1/build/plans?${q}`).then((r) => { if (live) setPlans({ key: aiKey, items: r.items }); }).catch(() => undefined);
    return () => { live = false; };
  }, [step, aiKey, project.preferences.plotUnknown]); // eslint-disable-line react-hooks/exhaustive-deps

  // The person's own edits to the chosen design, replayed on top of it. Everything after this uses the edited design.
  const editKey = chosen && plot ? designKey(plot, brief, chosen.id) : '';
  const myEdits = useMemo(() => (editKey ? edits[editKey] ?? [] : []), [edits, editKey]);
  const edited = useMemo(() => (chosen ? applyEdits(chosen, myEdits, cfg) : null), [chosen, myEdits, cfg]);
  const design: Design | null = edited?.design ?? null;
  const setMyEdits = useCallback((ops: DesignEdit[]) => { if (editKey) setEdits((e) => ({ ...e, [editKey]: ops })); }, [editKey]);

  const landscape = useMemo(() => (design && landscapeOpts ? planLandscape(design, landscapeOpts, cfg) : null), [design, landscapeOpts, cfg]);
  const bom = useMemo(() => (design ? [...billOfMaterials(design, cfg), ...(landscape ? landscapeMaterials(landscape, design, cfg) : [])] : []), [design, landscape, cfg]);
  const projectPlans = useMemo(() => (design ? planProject(design, project, planningCfg) : null), [design, project, planningCfg]);

  /** A brief change by the person: it becomes a confirmed fact. */
  const touchBrief = useCallback((patch: Partial<DesignBrief>) => {
    const keys = Object.keys(patch) as (keyof DesignBrief)[];
    if (!keys.length) return;
    setBrief((b) => normaliseBrief({ ...b, ...patch }));
    setProject((p) => ({ ...p, briefSource: { ...p.briefSource, ...Object.fromEntries(keys.map((k) => [k, 'you'])) } }));
  }, []);
  /** Choosing a type starts from that type's sensible defaults. */
  const pickType = useCallback((t: BuildingType, then: Step = 'where') => {
    const info = BUILDING_TYPES[t];
    const storeys = info.storeys.default; const units = info.units?.default ?? 0;
    touchBrief({ type: t, storeys, units, features: info.defaultFeatures ?? [], ...(info.bedrooms ? { bedrooms: info.bedrooms.default } : {}), parking: isHouse(t) ? 1 : suggestedParking(t, storeys, units) });
    setPicked(true);
    go(then);
  }, [touchBrief]); // eslint-disable-line react-hooks/exhaustive-deps
  const setBriefFromEditor = (f: (b: DesignBrief) => DesignBrief) => {
    const next = f(brief);
    const changed = (Object.keys(next) as (keyof DesignBrief)[]).filter((k) => next[k] !== brief[k]);
    touchBrief(Object.fromEntries(changed.map((k) => [k, next[k]])) as Partial<DesignBrief>);
    if (changed.some((k) => k.startsWith('roof'))) setProject((p) => recordDecision(p, 'roof', `${ROOF_OPTIONS[next.roof].label}${next.roof === 'flat' ? '' : `, ${ROOF_FINISHES[next.roofFinish].label.toLowerCase()}, ${next.roofPitch}°`}`, 'you'));
  };
  const chooseDesign = (id: string) => {
    autoPick.current = false;
    setDesignId(id);
    const d = result.designs.find((x) => x.id === id);
    if (d) setProject((p) => recordDecision(p, 'layout', d.name, 'you'));
  };
  const confirmSystems = () => setProject((p) => {
    const sy = p.systems; const c = projectPlans?.cooling.result; const w = projectPlans?.water.result; const e = projectPlans?.energy.result;
    let n = recordDecision(p, 'cooling', sy.airConditioning ? `${c?.acUnits ?? 0} inverter AC units${sy.kitchenAc ? ' including the kitchen' : ''}` : 'Ceiling fans, no air conditioning', 'you');
    n = recordDecision(n, 'water', `${w?.storageL ?? 0} L storage${sy.borehole ? `, borehole with ${w?.pump?.hp ?? '?'} hp pump` : ''}${sy.hotWater ? ', water heaters' : ''}`, 'you');
    n = recordDecision(n, 'solar', sy.solar.enabled && e?.solar ? `${e.solar.arrayKwp} kWp solar, ${e.solar.batteryUsableKwh} kWh usable battery, ${e.solar.inverterKw} kW inverter (${sy.solar.cover})` : 'No solar: grid and generator', 'you');
    return n;
  });
  const confirmedSystems = ['cooling', 'water', 'solar'].every((t) => project.decisions.some((d) => d.topic === t && d.status === 'confirmed'));

  const report = (body: Record<string, unknown>) => call('/v1/build/feedback', { body }).catch(() => undefined);
  const go = (s: Step) => {
    setStep(s);
    if (s !== 'overview' && s !== 'adjust') setView('outside');
    requestAnimationFrame(() => stepRef.current?.focus());
  };

  const findPlans = () => {
    for (const entry of pending.current) {
      const changes = Object.fromEntries((Object.keys(brief) as (keyof DesignBrief)[]).filter((key) =>
        JSON.stringify(brief[key]) !== JSON.stringify(entry.briefAfter[key])).map((key) => [key, brief[key]]));
      void report({ messageId: entry.messageId, outcome: 'proceeded', ...(Object.keys(changes).length ? { changes } : {}) });
    }
    pending.current = [];
    go('library');
  };

  // The chat answers questions; it never changes the design (the controls do).
  const [busy, setBusy] = useState(false);
  const [pendingRevision, setPendingRevision] = useState<{ key: string; proposal: RevisionProposal } | null>(null);
  const revisionKey = JSON.stringify([aiKey, designId, project, myEdits]);
  const revision = pendingRevision?.key === revisionKey ? {
    proposal: pendingRevision.proposal,
    apply: () => {
      const { proposal } = pendingRevision;
      const plotChanged = proposal.plot.widthM !== plot?.widthM || proposal.plot.depthM !== plot?.depthM;
      setPendingRevision(null);
      setPlot(proposal.plot);
      touchBrief(proposal.brief);
      setProject((p) => {
        const updated = proposal.budgetMinor === undefined ? p : { ...p, budget: { ...p.budget, amountMinor: proposal.budgetMinor } };
        return plotChanged && !p.preferences.plotUnknown ? recordDecision(updated, 'plot', `${proposal.plot.widthM} × ${proposal.plot.depthM} m`, 'you') : updated;
      });
      setAiLayouts(null);
      autoPick.current = false;
      setDesignId(null);
      go('library');
    },
  } : undefined;
  const ask = useCallback(async (message: string) => {
    const history = chat.slice(-10).map((c) => ({ role: c.from === 'you' ? 'user' : 'assistant', text: c.text.slice(0, 4000) }));
    setChat((c) => [...c, { from: 'you', text: message }]);
    setBusy(true);
    setPendingRevision(null);
    try {
      const layout = chosen?.id.startsWith('ai-') && aiLayouts?.key === aiKey ? aiLayouts.layouts[Number(chosen.id.slice(3)) - 1] : undefined;
      const r = await call<{ source: 'ai' | 'local'; messageId: string; reply: string; proposal?: RevisionProposal }>('/v1/build/chat', { body: { message, history, step, plot, brief, designId: chosen?.id ?? null, edits: myEdits, project, ...(layout ? { layout } : {}) } });
      setChat((c) => [...c, { from: 'assistant', text: r.reply, messageId: r.messageId, source: r.source }]);
      if (r.proposal) setPendingRevision({ key: revisionKey, proposal: r.proposal });
    } catch (e) {
      setChat((c) => [...c, { from: 'assistant', text: `Sorry, that did not go through: ${errorText(e)}` }]);
    } finally { setBusy(false); }
  }, [chat, step, plot, brief, chosen, myEdits, project, aiLayouts, aiKey, revisionKey]);
  const rate = (messageId: string, helpful: boolean) => {
    setChat((c) => c.map((x) => (x.messageId === messageId ? { ...x, helpful } : x)));
    void report({ messageId, helpful });
  };

  /** Someone's own words (the welcome box, or "describe it"): read them, fill in the choices, open the next step. */
  const describe = useCallback(async (text: string) => {
    try {
      const r = await call<{ messageId: string; intent: string; plot: Plot | null; brief: Partial<DesignBrief>; preferences?: PreferenceReading }>('/v1/build/interpret', { body: { message: text, plot, brief } });
      if (r.intent === 'shopping') { window.location.href = `/search?q=${encodeURIComponent(text.slice(0, 100))}`; return; }
      const patch = r.brief ?? {};
      const t = patch.type && isBuildingType(patch.type) ? patch.type : brief.type;
      const info = BUILDING_TYPES[t];
      const full: Partial<DesignBrief> = { ...patch, type: t };
      if (patch.type && patch.type !== brief.type) {
        full.storeys = patch.storeys ?? info.storeys.default; full.units = patch.units ?? info.units?.default ?? 0;
        full.features = patch.features ?? info.defaultFeatures ?? [];
        if (patch.parking === undefined) full.parking = isHouse(t) ? 1 : suggestedParking(t, full.storeys, full.units);
      }
      const reading = r.preferences;
      const taste = reading?.taste ?? (reading?.chooseForMe ? chooseTaste(t, reading.purpose ?? null) : null);
      if (taste) Object.assign(full, tasteBrief(taste), patch);
      touchBrief(full);
      if (reading) setProject((p) => ({
        ...p,
        location: { ...p.location, city: reading.place ?? p.location.city },
        budget: { ...p.budget, amountMinor: reading.budgetMinor ?? p.budget.amountMinor, finish: reading.finish ?? p.budget.finish },
        preferences: {
          ...p.preferences,
          purpose: reading.purpose ?? p.preferences.purpose,
          taste: taste ?? p.preferences.taste,
          tasteChosenForMe: taste ? reading.chooseForMe : p.preferences.tasteChosenForMe,
          priorities: [...new Set([...p.preferences.priorities, ...reading.priorities])],
          plotUnknown: !r.plot && (reading.plotUnknown || p.preferences.plotUnknown),
        },
      }));
      setPicked(true);
      if (r.plot) setPlot(r.plot);
      else if (reading?.plotUnknown) setPlot(COMMON_PLOTS[0]!.plot);
      pending.current = [...pending.current.slice(-5), { messageId: r.messageId, briefAfter: normaliseBrief({ ...brief, ...full }) }];
      go(r.plot || plot || reading?.plotUnknown ? 'yours' : 'where');
    } catch { go('what'); }
  }, [plot, brief, touchBrief]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arriving from the welcome screen with words or a building type, or from a plan listing ("Try this design").
  const started = useRef(false);
  useEffect(() => {
    if (!ready || started.current) return;
    if (initialPlan) {
      started.current = true;
      call<{ title: string; layout: AiLayout; brief: Partial<DesignBrief>; plot: Plot }>(`/v1/studio/designs/${initialPlan}`).then((r) => {
        // The design keeps its own coordinates: on a plot at least as big it fits as drawn; otherwise it shows on its own plot.
        const target = plot && plot.widthM >= r.plot.widthM && plot.depthM >= r.plot.depthM ? plot : r.plot;
        const b = normaliseBrief(r.brief);
        setPlot(target); setBrief(b); setPicked(true);
        setAiLayouts({ key: JSON.stringify({ plot: target, brief: b, place }), layouts: [{ ...r.layout, name: r.title || r.layout.name }] });
        autoPick.current = false; setDesignId('ai-1');
        if (!landscapeOpts) setLandscapeOpts(DEFAULT_LANDSCAPE);
        go('overview');
        window.history.replaceState(null, '', '/build');
      }).catch(() => go('what'));
      return;
    }
    if (initialType && isBuildingType(initialType)) { started.current = true; pickType(initialType, 'what'); window.history.replaceState(null, '', '/build'); }
    else if (initialMessage) { started.current = true; void describe(initialMessage).then(() => window.history.replaceState(null, '', '/build')); }
  }, [ready, initialMessage, initialType, initialPlan, describe, pickType]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready) return <div className="build-shell"><div className="scene-loading">Loading…</div></div>;

  const creating = !isTab(step);
  const showDesign = isTab(step);
  const scene = (photo: boolean) => (plot
    ? <Scene plot={plot} setbacks={cfg.setbacksM} design={showDesign ? design : null} view={showDesign ? view : 'outside'} buildKey={showDesign ? design?.id ?? 'none' : 'plot'} dark={photo ? dusk : dark}
        landscape={photo && landscape ? landscape : null} mode={photo ? 'photo' : 'model'} captureRef={capture} furnished={showDesign && view !== 'outside'} renderOnDemand={photo && (view !== 'outside' || softwareGl())}
        quality={photo && isTab(step) && view === 'outside' && !softwareGl() ? 'still' : 'live'} facing={isTab(step) ? facing : 'street'} />
    : <div className="scene-empty"><Ruler size={28} aria-hidden="true" /><p>Your land appears here, to scale, once you give its size.</p></div>);
  const hud = plot && (
    <div className="scene-hud">
      <span className="pill">{project.preferences.plotUnknown && 'Example plot · '}<Ruler size={13} aria-hidden="true" /> {plot.widthM} × {plot.depthM} m · {(plot.widthM * plot.depthM).toFixed(0)} m²</span>
      {design && showDesign && <span className="pill">{BUILDING_TYPES[design.brief.type].label} {design.footprint.w.toFixed(1)} × {design.footprint.d.toFixed(1)} m · {design.storeys} storey{design.storeys > 1 ? 's' : ''}</span>}
    </div>
  );
  const createIndex = CREATE.findIndex((c) => c.key === step);

  if (step === 'library') return <PlanLibrary brief={brief} plot={plot} preferences={project.preferences} stepRef={stepRef} onBack={() => go('yours')} />;

  if (creating) {
    return (
      <div className="build-shell">
        <nav aria-label="Create your design" className="build-stages create-steps">
            <ol>
              {CREATE.map((c, i) => {
                const reachable = i <= createIndex || (i === 1 && picked) || (i === 2 && picked && !!plot);
                return (
                  <li key={c.key} aria-current={c.key === step ? 'step' : undefined} className={i < createIndex ? 'done' : ''}>
                    <button type="button" onClick={() => reachable && go(c.key)} disabled={!reachable}>
                      <span className="n" aria-hidden="true">{i < createIndex ? <Check size={13} /> : i + 1}</span>{c.label}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
        <div className="build-grid">
          <section className="build-panel card" aria-labelledby="step-h">
            {step === 'what' && <WhatStep stepRef={stepRef} kicker="Step 1 of 3" type={picked ? brief.type : null} purpose={project.preferences.purpose} onPick={(t) => {
              if (!picked || brief.type !== t) {
                pickType(t, 'what');
                setProject((p) => ({ ...p, preferences: { ...p.preferences, purpose: null } }));
              }
            }} onPurpose={(purpose) => {
              setProject((p) => ({ ...p, preferences: { ...p.preferences, purpose } }));
              go('where');
            }} onDescribe={(t) => void describe(t)} />}
            {step === 'where' && <WhereStep stepRef={stepRef} kicker={`Step 2 of 3 · ${BUILDING_TYPES[brief.type].label}`} plot={project.preferences.plotUnknown ? null : plot} unit={unit} setUnit={setUnit}
              setPlot={(p) => { setPlot(p); if (p) setProject((x) => recordDecision({ ...x, preferences: { ...x.preferences, plotUnknown: false } }, 'plot', `${p.widthM} × ${p.depthM} m`, 'you')); }}
              project={project} setProject={setProject} onBack={() => go('what')} onNext={() => { if (project.preferences.plotUnknown) setPlot(COMMON_PLOTS[0]!.plot); go('yours'); }} />}
            {step === 'yours' && <YoursStep stepRef={stepRef} kicker="Step 3 of 3" brief={brief} setBrief={touchBrief} project={project} setProject={setProject} currency={currency}
              onBack={() => go('where')} onFindPlans={findPlans} />}
          </section>
          <section className="build-stage" aria-label="3D model">
            <div className="scene-frame glass">{scene(false)}{hud}</div>
            {plot && <p className="small muted scene-hint">Drag to turn, scroll or pinch to zoom. The dashed line shows the building setbacks.</p>}
              <details className="ask-drawer">
                <summary className="small">Have a question? Ask the Builder AI</summary>
                <ChatPanel chat={chat} busy={busy} ask={ask} rate={rate} aiOn={builderOn} revision={revision} placeholder="Ask about plots, costs, rules or materials…" />
              </details>
          </section>
        </div>
      </div>
    );
  }

  if (!design || !plot) {
    return (
      <div className="build-shell">
        <section className="build-panel card stack">
          <StepHead stepRef={stepRef} kicker="Your design" title="Nothing fits yet" />
          {generated.notes.map((n) => <p key={n} className="notice notice-warn">{n}</p>)}
          <Nav onBack={() => go('yours')} />
        </section>
      </div>
    );
  }

  const tabKicker = (k: Tab) => `Your design · ${TABS.find((t) => t.key === k)!.label}`;
  const tabIndex = TABS.findIndex((t) => t.key === step);
  const next = (k: Tab) => () => go(TABS[TABS.findIndex((t) => t.key === k) + 1]?.key ?? 'record');
  const back = (k: Tab) => () => go(TABS[TABS.findIndex((t) => t.key === k) - 1]?.key ?? 'overview');
  return (
    <div className="build-shell result">
      <div className="result-hero">
        <section className="build-stage hero-stage" aria-label="3D model">
          <div className="scene-frame glass hero-frame">{scene(true)}{hud}</div>
          <p className="small muted scene-hint">Drag to turn, scroll or pinch to zoom.</p>
        </section>
        <ConceptCard design={design} location={place} plans={projectPlans} currency={currency} aiPending={aiBusy && !aiNow}
          capture={() => capture.current?.() ?? null} renderConnected={renderOn} onChange={() => go('yours')} onAdjust={() => go('adjust')} />
      </div>

      {project.preferences.plotUnknown && <p className="notice">Preliminary concept on an example plot. Fit on your land is unverified.</p>}
      {shapedBy(design, project.preferences).length > 0 && <ul className="plain stack-sm">
        {shapedBy(design, project.preferences).slice(0, 3).map(({ choice, effect }) => <li key={choice}><strong>{choice}</strong> · {effect}</li>)}
      </ul>}
      <div className="row wrap">
        <button type="button" className="btn" onClick={() => go('library')}>Browse published plans</button>
        <button type="button" className="btn" aria-pressed={dusk} onClick={() => { setView('outside'); setDusk(!dusk); }}>At dusk</button>
      </div>
      {dreamOn && (
        <section className="card" aria-label="AI impressions">
          <DreamGallery key={design.id} connected={dreamOn} autoStart capture={() => capture.current?.() ?? null}
            facts={{ type: BUILDING_TYPES[design.brief.type].label, style: design.brief.style, storeys: design.storeys, roof: design.roof.kind, blocks: design.blocks.length, summary: design.summary.slice(0, 300) }}
            concept={(() => { const c = design.concept ?? conceptFor(design); return { title: c.title, story: c.story, palette: c.palette }; })()} />
        </section>
      )}

      <nav aria-label="Your design" className="result-tabs">
        {TABS.map((t, i) => <button key={t.key} type="button" className={`seg${t.key === step ? ' on' : ''}`} aria-current={t.key === step ? 'page' : undefined} onClick={() => go(t.key)}>{i === tabIndex ? t.label : t.label}</button>)}
      </nav>

      <div className="result-body">
        <section className="build-panel card" aria-label={TABS[tabIndex]?.label}>
          {step === 'overview' && <OverviewTab design={design} designs={result.designs} notes={generated.notes} overview={aiNow?.overview ?? null} choose={chooseDesign} view={view} setView={setView} facing={facing} setFacing={setFacing} plans={!project.preferences.plotUnknown && plans?.key === aiKey ? plans.items : []} />}
          {step === 'adjust' && chosen && <EditStep stepRef={stepRef} kicker={tabKicker('adjust')} design={design} edits={myEdits} results={edited?.results ?? []} setEdits={setMyEdits} cfg={cfg} brief={brief} setBrief={setBriefFromEditor} view={view} setView={setView} onBack={back('adjust')} onNext={next('adjust')} />}
          {step === 'outdoors' && <OutdoorStep stepRef={stepRef} kicker={tabKicker('outdoors')} design={design} landscape={landscape} options={landscapeOpts ?? DEFAULT_LANDSCAPE} setOptions={setLandscapeOpts} next="Cooling, water and power" onBack={back('outdoors')} onNext={next('outdoors')} />}
          {step === 'systems' && projectPlans && <SystemsStep stepRef={stepRef} kicker={tabKicker('systems')} project={project} setProject={setProject} plans={projectPlans} confirmed={confirmedSystems} onConfirm={confirmSystems} onBack={back('systems')} onNext={next('systems')} />}
          {step === 'budget' && projectPlans && <BudgetStep stepRef={stepRef} kicker={tabKicker('budget')} project={project} setProject={setProject} plans={projectPlans} currency={currency} onBack={back('budget')} onNext={next('budget')} />}
          {step === 'materials' && <MaterialsStep stepRef={stepRef} design={design} bom={bom} onBack={back('materials')} onNext={next('materials')} />}
          {step === 'buy' && <BuyStep stepRef={stepRef} bom={bom} onBack={back('buy')} onNext={next('buy')} />}
          {step === 'record' && <RecordStep stepRef={stepRef} kicker={tabKicker('record')} project={project} setProject={setProject} plot={plot} brief={brief} design={design} plans={projectPlans} onBack={back('record')}
            onStage={(k) => go(k === 'understand' || k === 'constraints' ? 'yours' : k === 'concept' ? 'overview' : k === 'systems' ? 'systems' : k === 'estimate' ? 'budget' : 'record')} />}
        </section>
        <aside className="result-aside">
          <ChatPanel chat={chat} busy={busy} ask={ask} rate={rate} aiOn={builderOn} revision={revision} placeholder="Ask anything about your design…" suggestions={QUESTIONS} />
          <p className="small muted"><Link href="/market">Browse the marketplace</Link> for materials, trades and professionals.</p>
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- materials and where to buy

function fmtQty(n: number) { return Number.isInteger(n) ? n.toLocaleString('en') : n.toLocaleString('en', { maximumFractionDigits: 1 }); }

function MaterialsStep({ stepRef, design, bom, onBack, onNext }: { stepRef: StepRef; design: Design; bom: MaterialLine[]; onBack: () => void; onNext: () => void }) {
  const sections = [...new Set(bom.map((l) => l.section))];
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Your design · Materials" title="Everything you need to build it">Quantities for this design, {design.metrics.grossFloorM2} m², from the foundations up. Each line shows how it was worked out.</StepHead>
      {sections.map((sec) => (
        <section key={sec} aria-labelledby={`sec-${sec}`} className="stack-sm">
          <h2 id={`sec-${sec}`} className="h-sub">{SECTION_LABEL[sec]}</h2>
          <div className="table-wrap">
            <table className="table bom">
              <thead><tr><th scope="col">Item</th><th scope="col" className="num">Quantity</th></tr></thead>
              <tbody>
                {bom.filter((l) => l.section === sec).map((l) => (
                  <tr key={l.key}>
                    <td>{l.name}{l.provisional && <span className="tag-soft">Provisional</span>}<span className="basis">{l.basis}</span></td>
                    <td className="num"><strong>{fmtQty(l.quantity)}</strong> {l.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <p className="small muted">Quantities are estimates with typical waste allowances. Labour, transport and items marked provisional depend on your site and trades; confirm with a quantity surveyor before ordering in bulk.</p>
      <Nav onBack={onBack} onNext={onNext} next="Find where to buy" />
    </div>
  );
}

function BuyStep({ stepRef, bom, onBack, onNext }: { stepRef: StepRef; bom: MaterialLine[]; onBack: () => void; onNext: () => void }) {
  const [data, setData] = useState<Sourcing | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    call<Sourcing>('/v1/build/sourcing', { body: { items: bom.map(({ key, name, unit, quantity, shop }) => ({ key, name, unit, quantity, shop })) } })
      .then((r) => { if (alive) setData(r); }).catch((e) => { if (alive) setError(errorText(e)); });
    return () => { alive = false; };
  }, [bom]);
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker="Your design · Where to buy" title="Where to buy, and what it costs">Live prices from sellers on BuildWise for each item, cheapest comparable offer first.</StepHead>
      {error && <p className="notice notice-bad" role="alert">{error}</p>}
      {!data && !error && <p className="muted" role="status">Finding sellers…</p>}
      {data && (
        <>
          <div className="buy-total card-inset" role="status">
            <ShoppingCart size={20} aria-hidden="true" />
            <div>
              <strong className="big">{money(data.total)}</strong>
              <span className="small muted">for the {data.pricedLines} of {data.lines.length} items with a matching price. Others need a quote or are not listed yet.</span>
            </div>
          </div>
          <ul className="plain stack buy-list">
            {[...data.lines].sort((a, b) => Number(b.offers.length > 0) - Number(a.offers.length > 0)).map((l) => (
              <li key={l.key} className="buy-line">
                <div className="buy-head"><strong>{l.name}</strong><span className="muted">{fmtQty(l.quantity)} {l.unit}</span></div>
                {l.offers.length === 0
                  ? <p className="small muted" style={{ margin: 0 }}>No listings yet. <Link href={l.searchPath}>Search the marketplace</Link> or post a request later.</p>
                  : (
                    <ul className="plain offers">
                      {l.offers.map((o) => (
                        <li key={o.listingId}>
                          <Link href={o.path} className="offer">
                            <span className="offer-title">{o.title}{o.promoted && <span className="tag-soft">Promoted</span>}</span>
                            <span className="small muted">{o.sellerName ?? 'Seller'}{o.area ? ` · ${o.area}` : ''}{o.deliveryOffered ? ' · Delivers' : ''}</span>
                            <span className="offer-price">{o.price ? `${money(o.price)} / ${o.unitLabel}` : 'Quote on request'}{o.lineTotal && <strong> = {money(o.lineTotal)}</strong>}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
              </li>
            ))}
          </ul>
          <p className="small muted">Prices are what sellers list today and can change. BuildWise never takes payment for goods: agree delivery and inspect before you pay.</p>
        </>
      )}
      <Nav onBack={onBack} onNext={onNext} next="Open the project record" />
    </div>
  );
}

/** True when WebGL is drawn in software (no GPU: headless browsers, some VMs); soft-shadow stills are too slow there. */
let soft: boolean | null = null;
export function softwareGl(): boolean {
  if (soft !== null) return soft;
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const name = gl && info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    soft = !gl || /swiftshader|llvmpipe|software|softpipe/i.test(name);
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
  } catch { soft = true; }
  return soft;
}
