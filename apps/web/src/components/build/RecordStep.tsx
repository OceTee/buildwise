'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Check, CircleAlert, Download, FileText, Printer, TriangleAlert, X } from 'lucide-react';
import {
  STAGES, addQuestion, projectChecks, projectFacts, settleDecision, stageProgress, verificationRegister,
  type Design, type DesignBrief, type FactStatus, type Plot, type ProjectPlans, type ProjectRecord,
} from '@bw/domain';
import { Nav, StepHead, type StepRef } from './ui';

const STATUS: Record<FactStatus, string> = { confirmed: 'Confirmed by you', assumed: 'Assumed', estimated: 'Estimated', recommended: 'Recommended', needs_verification: 'Needs a professional' };

/** Stage 06: the project as a connected record of decisions, open questions, checks and what must be verified. */
export function RecordStep({ stepRef, kicker, project, setProject, plot, brief, design, plans, onBack, onStage }: {
  stepRef: StepRef; kicker: string; project: ProjectRecord; setProject: (f: (p: ProjectRecord) => ProjectRecord) => void; plot: Plot | null; brief: DesignBrief;
  design: Design | null; plans: ProjectPlans | null; onBack: () => void; onStage: (key: (typeof STAGES)[number]['key']) => void;
}) {
  const [q, setQ] = useState('');
  const facts = projectFacts(project, plot, brief, design);
  const progress = stageProgress(project, plot, design, { budget: plans?.budget });
  const issues = projectChecks(project, design, plans ?? {});
  const verify = verificationRegister(project, design);
  const proposals = project.decisions.filter((d) => d.status === 'proposed' || d.status === 'suggested');
  const decided = project.decisions.filter((d) => d.status === 'confirmed' || d.status === 'pending_verification');
  const history = project.decisions.filter((d) => d.status === 'superseded' || d.status === 'rejected');
  const open = project.questions.filter((x) => !x.resolved);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ project, plot, brief, design: design ? { id: design.id, name: design.name, metrics: design.metrics, rooms: design.rooms, checks: design.checks } : null, plans: plans ? { cooling: plans.cooling.result, water: plans.water.result, energy: plans.energy.result, budget: plans.budget.result } : null, facts, issues, verification: verify }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${project.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'project'}-record.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="stack project-record">
      <StepHead stepRef={stepRef} kicker={kicker} title="Your project record">Everything decided, assumed, estimated and still open, in one place. Confirm or reject what the Builder AI proposed; changes record what they affect.</StepHead>

      <div className="field">
        <label htmlFor="p-name" className="label">Project name</label>
        <input id="p-name" value={project.name} maxLength={80} onChange={(e) => setProject((p) => ({ ...p, name: e.target.value }))} />
      </div>

      <ol className="plain stage-progress">
        {progress.map((s) => {
          const st = STAGES.find((x) => x.key === s.key)!;
          return (
            <li key={s.key} className={s.done ? 'done' : ''}>
              <button type="button" onClick={() => onStage(s.key)}>
                <span className="n">{s.done ? <Check size={13} aria-hidden="true" /> : st.n}</span>
                <span><strong>{st.label}</strong><br /><span className="small muted">{s.done ? 'Done' : s.next}</span></span>
              </button>
            </li>
          );
        })}
      </ol>

      {proposals.length > 0 && (
        <section aria-labelledby="prop-h" className="stack-sm">
          <h2 id="prop-h" className="h-sub">Waiting for you</h2>
          <ul className="plain stack-sm">{proposals.map((d) => (
            <li key={d.id} className="card-inset decision">
              <span><strong>{d.topic}</strong>: {d.choice}{d.note ? <span className="small muted"> · {d.note}</span> : null}<br /><span className="small muted">Proposed by the Builder AI · affects {d.affects.join(', ')}</span></span>
              <span className="row">
                <button type="button" className="btn btn-small btn-primary" onClick={() => setProject((p) => settleDecision(p, d.id, 'confirmed'))}><Check size={14} aria-hidden="true" /> Confirm</button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setProject((p) => settleDecision(p, d.id, 'rejected'))}><X size={14} aria-hidden="true" /> Reject</button>
              </span>
            </li>
          ))}</ul>
        </section>
      )}

      <section aria-labelledby="facts-h" className="stack-sm">
        <h2 id="facts-h" className="h-sub">What we know</h2>
        <div className="table-wrap">
          <table className="table small">
            <caption className="sr-only">Project facts and where they came from</caption>
            <thead><tr><th scope="col">Item</th><th scope="col">Value</th><th scope="col">Status</th></tr></thead>
            <tbody>{facts.map((f) => <tr key={f.id}><th scope="row">{f.label}</th><td>{f.value}</td><td><span className={`fact ${f.status}`}>{STATUS[f.status]}</span>{f.by === 'ai' ? <span className="small muted"> · AI</span> : null}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="dec-h" className="stack-sm">
        <h2 id="dec-h" className="h-sub">Decisions</h2>
        {decided.length ? <ul className="plain stack-sm small">{decided.map((d) => <li key={d.id}><Check size={14} aria-hidden="true" /> <strong>{d.topic}</strong>: {d.choice} <span className="muted">({new Date(d.at).toLocaleDateString('en-GB')})</span></li>)}</ul> : <p className="small muted">Nothing confirmed yet. Choosing a design, confirming systems or setting a budget records a decision.</p>}
        {history.length > 0 && (
          <details className="checklist"><summary><strong>Earlier and rejected choices</strong> <span className="small muted">{history.length}</span></summary>
            <ul className="plain stack-sm small">{history.map((d) => <li key={d.id}><span className="muted">{d.status}</span> · {d.topic}: {d.choice}</li>)}</ul>
          </details>
        )}
      </section>

      <section aria-labelledby="q-h" className="stack-sm">
        <h2 id="q-h" className="h-sub">Open questions</h2>
        {open.length ? <ul className="plain stack-sm small">{open.map((x) => (
          <li key={x.id} className="row wrap"><label className="check"><input type="checkbox" onChange={() => setProject((p) => ({ ...p, questions: p.questions.map((y) => (y.id === x.id ? { ...y, resolved: true } : y)) }))} /> {x.question}</label><span className="muted">({STAGES.find((s) => s.key === x.stage)?.label})</span></li>
        ))}</ul> : <p className="small muted">No open questions.</p>}
        <form className="row wrap" onSubmit={(e) => { e.preventDefault(); if (q.trim()) { setProject((p) => addQuestion(p, q, 'refine', 'you')); setQ(''); } }}>
          <div className="field"><label htmlFor="new-q" className="small">Add a question to settle</label><input id="new-q" value={q} maxLength={300} onChange={(e) => setQ(e.target.value)} /></div>
          <button type="submit" className="btn btn-small" disabled={!q.trim()}>Add</button>
        </form>
      </section>

      <section aria-labelledby="iss-h" className="stack-sm">
        <h2 id="iss-h" className="h-sub">Coordination checks</h2>
        {issues.length === 0 && <p className="small muted">No conflicts found between the design, the systems and the budget.</p>}
        <ul className="plain stack-sm small">{issues.map((i, k) => (
          <li key={k} className={`check-row ${i.level === 'conflict' ? 'fail' : i.level === 'warn' ? 'warn' : 'pass'}`}>{i.level === 'info' ? <CircleAlert size={16} aria-hidden="true" /> : <TriangleAlert size={16} aria-hidden="true" />}<span><span className="sr-only">{i.level}: </span>{i.text}</span></li>
        ))}</ul>
      </section>

      {project.revisions.length > 0 && (
        <section aria-labelledby="rev-h" className="stack-sm">
          <h2 id="rev-h" className="h-sub">Changes and what they affect</h2>
          <ul className="plain stack-sm small">{[...project.revisions].reverse().map((r, k) => <li key={k}><strong>{r.summary}</strong><br /><span className="muted">Check: {r.affects.join(', ')}</span></li>)}</ul>
        </section>
      )}

      <section aria-labelledby="ver-h" className="stack-sm">
        <h2 id="ver-h" className="h-sub">What professionals must verify</h2>
        <div className="table-wrap">
          <table className="table small">
            <caption className="sr-only">Professional verification</caption>
            <thead><tr><th scope="col">Item</th><th scope="col">Who</th><th scope="col">Why</th></tr></thead>
            <tbody>{verify.map((v) => <tr key={v.item}><th scope="row">{v.item}</th><td>{v.professional}</td><td className="muted">{v.why}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="del-h" className="stack-sm">
        <h2 id="del-h" className="h-sub">Deliverables</h2>
        <div className="row wrap">
          <Link className="btn" href="/build/drawings"><FileText size={16} aria-hidden="true" /> Concept drawings</Link>
          <button type="button" className="btn" onClick={() => window.print()}><Printer size={16} aria-hidden="true" /> Print this record</button>
          <button type="button" className="btn" onClick={exportJson}><Download size={16} aria-hidden="true" /> Export the record (JSON)</button>
        </div>
        <p className="small muted">These are concept and planning documents. Stamped drawings, structural design and permits come from registered professionals.</p>
      </section>
      <Nav onBack={onBack} />
    </div>
  );
}
