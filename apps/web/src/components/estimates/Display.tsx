import { dateText } from '@/lib/format';
import { statePill, type Indicative, type Totals, type Version } from './types';

/** The maturity label and notice, shown prominently on every estimate view (MVP spec §5). */
export function MaturityBanner({ v }: { v: Pick<Version, 'maturity' | 'label' | 'notice' | 'state' | 'number' | 'reviewer' | 'reviewedAt' | 'issuedAt' | 'validUntil'> }) {
  const p = statePill(v.state);
  const tone = v.maturity === 'reviewed_cost_plan' && ['issued', 'accepted'].includes(v.state) ? 'notice-good' : 'notice-warn';
  return (
    <div className={`notice ${tone} stack-sm`} role="note" aria-label="Estimate type">
      <div className="inline"><strong style={{ fontSize: '1.05rem' }}>{v.label}</strong><span className={`pill ${p.cls}`}>{p.label}</span>{v.maturity !== 'indicative' && <span className="small">Version {v.number}</span>}</div>
      <div>{v.maturity === 'indicative' ? 'Indicative range — not a bill of quantities or a supplier quote.' : v.notice}</div>
      {v.maturity === 'reviewed_cost_plan' && !['issued', 'accepted', 'expired', 'superseded'].includes(v.state) && (
        <div className="small">Not yet professionally reviewed. Lines and totals here are working figures until a reviewer issues this version.</div>
      )}
      {v.reviewer && (v.issuedAt || v.reviewedAt) && (
        <div className="small">Reviewer: <strong>{v.reviewer.name}</strong>{v.reviewedAt ? ` · reviewed ${dateText(v.reviewedAt)}` : ''}{v.issuedAt ? ` · issued ${dateText(v.issuedAt)}` : ''}{v.validUntil ? ` · valid until ${dateText(v.validUntil)}` : ''}</div>
      )}
    </div>
  );
}

export function IndicativeCard({ i, projectId, showCta = true }: { i: Indicative; projectId: string; showCta?: boolean }) {
  return (
    <section className="card stack-sm" aria-labelledby="ind-h">
      <h2 id="ind-h" style={{ margin: 0 }}>Indicative range</h2>
      <p className="small muted" style={{ margin: 0 }}>Not a bill of quantities or a supplier quote. For early planning only.</p>
      <div style={{ fontSize: '1.5rem', fontWeight: 800 }}>{i.low.display} – {i.high.display}</div>
      <dl className="facts small">
        <dt>Building</dt><dd>{i.classLabel}, about {i.areaM2} m²</dd>
        <dt>Per m²</dt><dd>{i.perM2.low.display} – {i.perM2.high.display} (before contingency)</dd>
        <dt>Contingency</dt><dd>{i.contingencyPct}% added to the top of the range</dd>
        <dt>Benchmark</dt><dd>{i.benchmark.source}, dated {dateText(i.benchmark.observedAt)}</dd>
        <dt>Includes</dt><dd>{i.benchmark.includes.join(', ')}</dd>
        <dt>Excludes</dt><dd>{i.benchmark.excludes.join(', ')}</dd>
      </dl>
      {showCta && <p className="small" style={{ margin: 0 }}>For a figure you can budget against, <a href={`/projects/${projectId}/estimates#new`}>request a professionally reviewed estimate</a>.</p>}
    </section>
  );
}

export function TotalsTable({ t, caption = 'Estimate totals' }: { t: Totals; caption?: string }) {
  return (
    <div className="table-wrap">
      <table>
        <caption className="sr-only">{caption}</caption>
        <tbody>
          {t.bySection.map((s) => <tr key={s.code}><th scope="row" style={{ fontWeight: 400 }}>{s.label}</th><td className="num">{s.amount.display}</td></tr>)}
          <tr><th scope="row">Net total</th><td className="num">{t.net.display}</td></tr>
          <tr><th scope="row" style={{ fontWeight: 400 }}>Contingency ({t.contingency.pct}%)</th><td className="num">{t.contingency.display}</td></tr>
          <tr><th scope="row" style={{ fontWeight: 400 }}>{t.tax.label}</th><td className="num">{t.tax.display}</td></tr>
          <tr><th scope="row">Total including tax and contingency</th><td className="num"><strong>{t.gross.display}</strong></td></tr>
        </tbody>
      </table>
      <p className="small muted" style={{ margin: '.25rem 0 0' }}>Line amounts exclude tax; tax is shown separately and included in the total. Calculation {t.calculationVersion}.</p>
    </div>
  );
}
