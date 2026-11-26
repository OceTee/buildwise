'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, ImageOff } from 'lucide-react';
import type { DesignBrief, Plot, ProjectRecord } from '@bw/domain';
import { call } from '@/lib/client';
import { StepHead, type StepRef } from './ui';

type PublishedPlan = {
  title: string; url: string; publisher: string; planPreview: string | null; exteriorPreview: string | null;
  licence: 'required' | 'check'; disclosedAi: boolean; excerpt: string | null;
};
type LibraryResult = { status: 'ready' | 'not_configured' | 'unavailable'; plans: PublishedPlan[] };

export function PlanLibrary({ brief, plot, preferences, stepRef, onBack }: {
  brief: DesignBrief; plot: Plot | null; preferences: ProjectRecord['preferences']; stepRef: StepRef; onBack: () => void;
}) {
  const [aiOnly, setAiOnly] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<LibraryResult | null>(null);
  const query = JSON.stringify({
    type: brief.type, bedrooms: brief.bedrooms, storeys: brief.storeys,
    features: brief.features, study: brief.study, openKitchen: brief.kitchen === 'open',
    ...(!preferences.plotUnknown && plot ? { plot } : {}),
    taste: preferences.taste ?? 'modern', purpose: preferences.purpose, priorities: preferences.priorities, aiOnly,
  });
  useEffect(() => {
    let active = true;
    call<LibraryResult>('/v1/build/library', { body: JSON.parse(query) })
      .then((response) => { if (active) setResult(response); })
      .catch(() => { if (active) setResult({ status: 'unavailable', plans: [] }); });
    return () => { active = false; };
  }, [query, retry]);
  return <div className="build-shell stack">
    <StepHead stepRef={stepRef} kicker="Plan library" title="Explore published designs">
      Browse public plan and exterior previews. Check dimensions and build rights with the publisher before choosing.
    </StepHead>
    <div className="row wrap">
      <button type="button" className="btn btn-ghost" onClick={onBack}>Change the brief</button>
      <button type="button" className="btn" aria-pressed={aiOnly} onClick={() => { setResult(null); setAiOnly(!aiOnly); }}>Publisher-disclosed AI plans</button>
    </div>
    <p className="small muted">* A build licence is required. Where terms are unclear, check with the publisher.</p>
    {result === null ? <p role="status">Finding published plans…</p>
      : result.status !== 'ready' ? <div className="notice" role="status">
        <p>{result.status === 'not_configured' ? 'Plan search needs the Exa key on the BuildWise server.' : 'Plan search is temporarily unavailable.'}</p>
        <button type="button" className="btn" onClick={() => { setResult(null); setRetry((value) => value + 1); }}>Try again</button>
      </div>
      : !result.plans.length ? <p role="status">{aiOnly ? 'No matching plans with published AI attribution and a preview were found.' : 'No matching public previews were found. Try adjusting your brief.'}</p>
      : <div className="concept-options">{result.plans.map((plan) => <PublishedPlanCard key={plan.url} plan={plan} />)}</div>}
  </div>;
}

function PublishedPlanCard({ plan }: { plan: PublishedPlan }) {
  const [view, setView] = useState<'plan' | 'exterior'>(plan.planPreview ? 'plan' : 'exterior');
  const [failed, setFailed] = useState(false);
  const image = view === 'plan' ? plan.planPreview : plan.exteriorPreview;
  return <article className="card concept-option">
    <div className="published-preview">
      {image && !failed ? (
        // Publisher-hosted preview. BuildWise does not cache or resize it.
        // eslint-disable-next-line @next/next/no-img-element
        <img key={image} src={image} alt={view === 'plan' ? 'Publisher’s floor-plan preview' : 'Publisher’s exterior preview'} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
      ) : <p className="small muted"><ImageOff size={17} aria-hidden="true" /> Preview available at the publisher</p>}
    </div>
    <div className="stack-sm concept-option-body">
      <p className="small muted">{plan.publisher}{plan.disclosedAi ? ' · AI disclosed by publisher' : ''}</p>
      <h2>{plan.title}{plan.licence === 'required' ? ' *' : ''}</h2>
      {(!plan.planPreview || !plan.exteriorPreview) && <p className="small muted">{plan.planPreview ? 'Floor-plan preview' : 'Exterior preview only'}</p>}
      {plan.planPreview && plan.exteriorPreview && <div className="row wrap" role="group" aria-label="Preview">
        <button type="button" className="chip" aria-pressed={view === 'plan'} onClick={() => { setFailed(false); setView('plan'); }}>Floor plan</button>
        <button type="button" className="chip" aria-pressed={view === 'exterior'} onClick={() => { setFailed(false); setView('exterior'); }}>Exterior</button>
      </div>}
      {view === 'plan' && plan.planPreview && !failed && <a className="small" href={plan.planPreview} target="_blank" rel="noreferrer">Open floor-plan preview</a>}
      <p className="small">{plan.licence === 'required' ? 'Build licence required' : 'Build rights: check publisher terms'}</p>
      <a className="btn btn-small" href={plan.url} target="_blank" rel="noreferrer">View full plan <ArrowUpRight size={15} aria-hidden="true" /></a>
    </div>
  </article>;
}
