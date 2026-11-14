import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { canDo, loadProject, loadProjectConfig } from '@/lib/projects';
import { money } from '@/lib/format';

export const metadata: Metadata = { title: 'Project' };

const OUTCOME: Record<string, { label: string; cls: string }> = {
  can_proceed: { label: 'Ready for a reviewed estimate', cls: 'notice-good' },
  needs_professional: { label: 'Needs professional input first', cls: 'notice-warn' },
  cannot_estimate: { label: 'Cannot be estimated responsibly yet', cls: 'notice-bad' },
};
const ICON: Record<string, string> = { ok: '✓', missing: '✗', attention: '!' };

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p) notFound();
  const cfg = await loadProjectConfig();
  const label = (list: { code: string; label: string }[], code: unknown) => list.find((x) => x.code === code)?.label ?? '—';
  const ind = p.indicative;
  const o = OUTCOME[p.readiness.outcome]!;
  return (
    <div className="layout-2">
      <div className="stack">
        <h1 className="sr-only">Project overview</h1>
        <section className={`notice ${o.cls} stack-sm`} aria-labelledby="ready-h">
          <h2 id="ready-h" style={{ margin: 0 }}>{o.label}</h2>
          <p style={{ margin: 0 }}>{p.readiness.explanation}</p>
          <ul className="plain stack-sm" style={{ margin: 0 }}>
            {p.readiness.items.map((i) => (
              <li key={i.code}><span aria-hidden="true" style={{ display: 'inline-block', width: '1.2rem', fontWeight: 800 }}>{ICON[i.status]}</span><strong>{i.label}</strong> <span className="sr-only">({i.status})</span>: {i.detail}</li>
            ))}
          </ul>
          <p className="small" style={{ margin: 0 }}>BuildWise does not verify land title, approve permits or certify designs.</p>
        </section>

        <section className="card stack-sm" aria-labelledby="ind-h">
          <h2 id="ind-h">Indicative range</h2>
          {ind.ok ? (
            <>
              <div className="price-big">{money({ amountMinor: ind.lowMinor, currency: p.currency })} – {money({ amountMinor: ind.highMinor, currency: p.currency })}</div>
              <p className="small" style={{ margin: 0 }}><strong>Indicative only.</strong> Not a bill of quantities or a supplier quote. Based on {ind.areaM2} m² of {ind.classLabel.toLowerCase()} at {label(cfg.finishBands, p.brief.finishBand).toLowerCase()} finish, local benchmarks dated {ind.benchmark.observedAt}, with {ind.contingencyPct}% contingency.</p>
              <p className="small muted" style={{ margin: 0 }}>Includes {ind.benchmark.includes.join(', ')}. Excludes {ind.benchmark.excludes.join(', ')}.</p>
            </>
          ) : (
            <>
              <p style={{ margin: 0 }}>{ind.message}</p>
              {ind.missing && ind.missing.length > 0 && <ul className="small" style={{ margin: 0 }}>{ind.missing.map((m) => <li key={m}>{m}</li>)}</ul>}
            </>
          )}
          {canDo(p, 'estimate.read') && <div><Link href={`/projects/${id}/estimates`}>Estimates for this project</Link></div>}
        </section>

        <section className="card stack-sm" aria-labelledby="path-h">
          <h2 id="path-h">Which estimate do you need?</h2>
          <dl className="facts">
            <dt>Indicative range</dt><dd>A quick range from local benchmarks, for early planning. Not measured from your drawings.</dd>
            <dt>Your own quantities</dt><dd>Enter or import a quantity list from your own QS. Labelled “client-specified”; BuildWise does not check it.</dd>
            <dt>Professionally reviewed</dt><dd>A named, qualified reviewer measures your drawings, prices each line from dated sources and issues a versioned estimate.</dd>
          </dl>
          {canDo(p, 'estimate.request_review') && <div className="inline"><Link className="btn btn-primary" href={`/projects/${id}/estimates`}>Choose an estimate</Link></div>}
        </section>
      </div>

      <aside className="stack">
        <section className="card stack-sm" aria-labelledby="sum-h">
          <div className="inline" style={{ justifyContent: 'space-between' }}><h2 id="sum-h" style={{ margin: 0 }}>Details</h2>{canDo(p, 'project.edit') && <Link className="btn btn-small" href={`/projects/${id}/brief`}>Edit</Link>}</div>
          <dl className="facts small">
            <dt>Building</dt><dd>{label(cfg.buildingUses, p.brief.buildingUse)}</dd>
            <dt>Area</dt><dd>{p.area ? `${p.area.label}, ${p.area.region}` : '—'}</dd>
            <dt>Floors</dt><dd>{p.brief.floors ?? '—'}</dd>
            <dt>Floor area</dt><dd>{p.brief.grossFloorAreaM2 ? `${p.brief.grossFloorAreaM2} m²` : '—'}</dd>
            <dt>Finish</dt><dd>{label(cfg.finishBands, p.brief.finishBand)}</dd>
            <dt>Site</dt><dd>{label(cfg.siteStatuses, p.brief.siteStatus)}</dd>
            <dt>Drawings</dt><dd>{label(cfg.designStages, p.brief.designStage)}</dd>
            <dt>Currency</dt><dd>{p.currency}</dd>
          </dl>
        </section>
        {p.missing.length > 0 && (
          <section className="card stack-sm" aria-labelledby="miss-h">
            <h2 id="miss-h" style={{ fontSize: '1rem', margin: 0 }}>Still to answer</h2>
            <ul className="small" style={{ margin: 0 }}>{p.missing.map((m) => <li key={m.field}>{m.label} <span className="muted">({m.requiredFor === 'review' ? 'for a reviewed estimate' : m.requiredFor === 'indicative' ? 'for a range' : 'required'})</span></li>)}</ul>
          </section>
        )}
        <section className="card" aria-label="Activity">
          <dl className="facts small">
            <dt>Documents</dt><dd><Link href={`/projects/${id}/documents`}>{p.counts.documents}</Link></dd>
            <dt>Open RFIs</dt><dd><Link href={`/projects/${id}/rfis`}>{p.counts.open_rfis}</Link></dd>
            <dt>Estimates</dt><dd>{p.counts.estimates}</dd>
            <dt>Team</dt><dd>{p.counts.members}</dd>
          </dl>
        </section>
      </aside>
    </div>
  );
}
