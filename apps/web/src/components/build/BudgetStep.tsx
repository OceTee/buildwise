'use client';
import type { CostStage, FinishBand, ProjectPlans, ProjectRecord } from '@bw/domain';
import { Working, fmtMinor } from './planning-ui';
import { Nav, StepHead, type StepRef } from './ui';

const STAGE: Record<CostStage, string> = { substructure: 'Foundations', frame: 'Frame', walls: 'Walls', roof: 'Roof', openings: 'Doors and windows', finishes: 'Finishes', services: 'Services' };

/** Stage 05: what the project is likely to cost, against the budget, and how to close any gap. */
export function BudgetStep({ stepRef, kicker, project, setProject, plans, currency, onBack, onNext }: {
  stepRef: StepRef; kicker: string; project: ProjectRecord; setProject: (f: (p: ProjectRecord) => ProjectRecord) => void; plans: ProjectPlans; currency: string; onBack: () => void; onNext: () => void;
}) {
  const b = plans.budget.result;
  const m = (n: number) => fmtMinor(n, currency);
  const setBudget = <K extends keyof ProjectRecord['budget']>(k: K, v: ProjectRecord['budget'][K]) => setProject((p) => ({ ...p, budget: { ...p.budget, [k]: v } }));
  const totalStages = b.stages.reduce((s, x) => s + x.minor, 0) || 1;
  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker={kicker} title="Budget and cost plan">A preliminary estimate for the whole project from illustrative rates, with a range. The materials list next prices actual items from sellers.</StepHead>

      <div className="row wrap">
        <div className="field">
          <label htmlFor="b-amount" className="label">Your budget ({currency})</label>
          <input id="b-amount" inputMode="numeric" value={project.budget.amountMinor === null ? '' : String(Math.round(project.budget.amountMinor / 100))}
            onChange={(e) => setBudget('amountMinor', e.target.value.trim() === '' ? null : Math.max(0, Math.round(Number(e.target.value.replace(/[^\d.]/g, '')) * 100)))} placeholder="Not set" />
        </div>
        <div className="field">
          <label htmlFor="b-finish" className="label">Finish level</label>
          <select id="b-finish" value={project.budget.finish} onChange={(e) => setBudget('finish', e.target.value as FinishBand)}>
            <option value="basic">Basic</option><option value="standard">Standard</option><option value="premium">Premium</option>
          </select>
        </div>
      </div>

      <div className={`notice ${b.gapMinor !== null && b.gapMinor > 0 ? 'notice-warn' : b.gapMinor !== null ? 'notice-good' : ''}`} role="status">
        <p style={{ margin: 0 }}><strong>Estimated total: {m(b.totalMinor)}</strong> <span className="small">(likely between {m(b.lowMinor)} and {m(b.highMinor)})</span></p>
        <p className="small" style={{ margin: 0 }}>
          {b.gapMinor === null ? 'Set a budget to see how the plan compares.' : b.gapMinor > 0 ? `About ${m(b.gapMinor)} over your budget of ${m(b.budgetMinor!)}.` : `About ${m(-b.gapMinor)} within your budget of ${m(b.budgetMinor!)}.`}
        </p>
      </div>

      <div className="table-wrap">
        <table className="table small">
          <caption className="sr-only">Cost plan</caption>
          <thead><tr><th scope="col">Item</th><th scope="col">How it was worked out</th><th scope="col" className="num">Amount</th></tr></thead>
          <tbody>
            {b.lines.map((l) => <tr key={l.key}><th scope="row">{l.label}{l.optional ? <span className="small muted"> (optional)</span> : null}</th><td className="muted">{l.basis}</td><td className="num">{m(l.minor)}</td></tr>)}
            <tr><th scope="row">Total</th><td /><td className="num"><strong>{m(b.totalMinor)}</strong></td></tr>
          </tbody>
        </table>
      </div>

      <section aria-labelledby="stages-h" className="stack-sm">
        <h2 id="stages-h" className="h-sub">The building cost by stage</h2>
        <div className="stage-bar" aria-hidden="true">{b.stages.map((s) => <span key={s.stage} style={{ flexGrow: s.minor / totalStages }} title={STAGE[s.stage]} />)}</div>
        <ul className="plain stage-list small">{b.stages.map((s) => <li key={s.stage}><span>{STAGE[s.stage]}</span><span>{m(s.minor)}</span></li>)}</ul>
      </section>

      {b.options.length > 0 && (
        <section aria-labelledby="ve-h" className="stack-sm">
          <h2 id="ve-h" className="h-sub">Ways to close the gap</h2>
          <ul className="plain stack-sm">{b.options.map((o) => <li key={o.label} className="card-inset"><strong>{o.label}</strong> <span className="small">saves about {m(o.savesMinor)}</span><br /><span className="small muted">{o.note}</span></li>)}</ul>
          <p className="small muted">Never close a gap by cutting structure, foundations, electrical protection or waterproofing.</p>
        </section>
      )}
      <Working calc={plans.budget} />
      <Nav onBack={onBack} onNext={onNext} next="List the materials" />
    </div>
  );
}
