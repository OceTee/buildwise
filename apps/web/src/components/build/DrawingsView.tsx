'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import {
  DEFAULT_DESIGN_CONFIG, applyEdits, conceptTitle, designFromLayout, designKey, findDesign, generateDesigns, normaliseBrief, normaliseLandscape, planLandscape, validPlot,
  type AiLayout, type DesignBrief, type DesignConfig, type DesignEdit, type LandscapeOptions, type Plot, type ProjectRecord,
} from '@bw/domain';
import { call } from '@/lib/client';
import { DrawingSet } from './DrawingSet';
import { PlanBoards } from './plan-board';

/** The drawings for the design chosen in the build flow (read from this browser's saved build). */
export function DrawingsView() {
  const [saved, setSaved] = useState<{ plot: Plot; brief: DesignBrief; designId: string | null; edits: Record<string, DesignEdit[]>; landscape: LandscapeOptions | null; layouts: AiLayout[]; plotUnknown: boolean } | null | 'none'>(null);
  const [cfg, setCfg] = useState<DesignConfig>(DEFAULT_DESIGN_CONFIG);
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem('bw-build-v1') ?? '{}') as { plot?: Plot; brief?: Partial<DesignBrief>; designId?: string; project?: Partial<ProjectRecord>; edits?: Record<string, DesignEdit[]>; landscape?: LandscapeOptions | null; aiLayouts?: { layouts?: AiLayout[] } | null };
      setSaved(s.plot && validPlot(s.plot) ? { plot: s.plot, brief: normaliseBrief(s.brief ?? {}), designId: s.designId ?? null, plotUnknown: s.project?.preferences?.plotUnknown === true, edits: s.edits ?? {}, landscape: s.landscape ? normaliseLandscape(s.landscape) : null, layouts: Array.isArray(s.aiLayouts?.layouts) ? s.aiLayouts!.layouts! : [] } : 'none');
    } catch { setSaved('none'); }
    call<{ design: DesignConfig }>('/v1/build/config').then((c) => setCfg(c.design)).catch(() => undefined);
  }, []);
  const design = useMemo(() => {
    if (!saved || saved === 'none') return null;
    // A design the AI designer composed is rebuilt from its saved layout; otherwise from the engine.
    const ai = saved.designId?.startsWith('ai-') ? saved.layouts[Number(saved.designId.slice(3)) - 1] : undefined;
    const fromAi = ai ? designFromLayout(saved.plot, saved.brief, ai, saved.designId!, cfg).design : null;
    const { designs } = generateDesigns(saved.plot, saved.brief, cfg);
    const chosen = fromAi ?? designs.find((d) => d.id === saved.designId) ?? (saved.designId ? findDesign(saved.plot, saved.brief, saved.designId, cfg) : null) ?? designs[0] ?? null;
    // The person's own edits and landscaping, exactly as in the build flow.
    return chosen ? applyEdits(chosen, saved.edits[designKey(saved.plot, saved.brief, chosen.id)] ?? [], cfg).design : null;
  }, [saved, cfg]);
  const landscape = useMemo(() => (design && saved && saved !== 'none' && saved.landscape ? planLandscape(design, saved.landscape, cfg) : null), [design, saved, cfg]);

  if (saved === null) return <p className="muted">Loading your design…</p>;
  if (!design) {
    return (
      <div className="stack">
        <h1>No design yet</h1>
        <p>Start with your land size and the home you want, choose a design, then come back for its drawings.</p>
        <p><Link className="btn btn-primary" href="/build">Design your home</Link></p>
      </div>
    );
  }
  const b = design.brief;
  const examplePlot = saved && saved !== 'none' && saved.plotUnknown;
  // The same name the design goes by on its concept card and design page; the project line says what it is.
  const name = conceptTitle(design);
  const what = (design.summary.split(/[,.]/)[0] ?? `${b.bedrooms}-bedroom house`).trim();
  const project = examplePlot ? `${what} (example plot)` : what;
  const date = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  return (
    <div className="stack drawings-page">
      <div className="no-print stack-sm">
        {saved && saved !== 'none' && saved.plotUnknown && <p className="notice">Preliminary concept on an example plot. Fit on your land is unverified.</p>}
        <p><Link href="/build"><ArrowLeft size={16} aria-hidden="true" /> Back to your design</Link></p>
        <h1>Concept drawings: {name}</h1>
        <p className="muted">{project}, {design.metrics.grossFloorM2} m² on a {design.plot.widthM.toFixed(2)} × {design.plot.depthM.toFixed(2)} m plot. Print on A3 landscape, or choose “Save as PDF” in the print dialog.</p>
        <p className="notice notice-warn small">Concept drawings to discuss with your family, an architect and builders. They are not construction or permit drawings: a registered architect must prepare and stamp those, and a structural engineer must design the structure.</p>
        <p><button type="button" className="btn btn-primary" onClick={() => window.print()}><Printer size={16} aria-hidden="true" /> Print or save as PDF</button></p>
      </div>
      <div className="drawing-set">
        <PlanBoards design={design} name={name} project={project} date={date} />
        <DrawingSet design={design} name={name} project={project} date={date} landscape={landscape} />
      </div>
    </div>
  );
}
