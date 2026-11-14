import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { IndicativeCard, MaturityBanner, TotalsTable } from '@/components/estimates/Display';
import { PrintButton } from '@/components/estimates/PrintButton';
import { QSOURCE_LABELS, STATUS_LABELS, type Line, type Version } from '@/components/estimates/types';
import { dateText } from '@/lib/format';
import { loadProject, loadProjectConfig } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Estimate report', robots: { index: false } };

type Report = Version & { project: { name: string; area: string | null }; documents: { title: string; number: string | null; revision: string; sha256: string | null }[]; packVersion: string; illustrative: boolean; statement: string };

/** The customer-facing estimate report, designed to print (MVP spec §4.4, §5). */
export default async function EstimateReport({ params }: { params: Promise<{ id: string; estimateId: string; versionId: string }> }) {
  const { id, estimateId, versionId } = await params;
  const p = await loadProject(id);
  if (!p) notFound();
  const r = await api<Report>(`/v1/estimate-versions/${versionId}/report`);
  if (r.status !== 200 || r.data.estimateId !== estimateId) notFound();
  const v = r.data;
  const cfg = await loadProjectConfig();
  const sectionLabel = (c: string) => cfg.workSections.find((w) => w.code === c)?.label ?? c;
  const sections = [...new Set(v.lines.map((l) => l.section))];
  const frozen = !!v.snapshotHash;
  return (
    <article className="stack">
      <div className="inline no-print" style={{ justifyContent: 'space-between' }}>
        <Link href={`/projects/${id}/estimates/${estimateId}`}>Back to the estimate</Link>
        <PrintButton />
      </div>
      <header className="stack-sm">
        <h1 style={{ margin: 0 }}>{v.title} — version {v.number}</h1>
        <p className="muted" style={{ margin: 0 }}>{v.project.name}{p.area ? `, ${p.area.label}, ${p.area.region}` : ''} · prices in {v.currency}</p>
      </header>
      <MaturityBanner v={v} />
      {!frozen && v.maturity !== 'indicative' && <p className="notice notice-warn small">This is a working draft, not an issued estimate. Figures may change.</p>}

      {v.maturity === 'indicative' && v.indicative && <IndicativeCard i={v.indicative} projectId={id} showCta={false} />}

      {v.maturity !== 'indicative' && (
        <>
          <section className="card stack-sm" aria-labelledby="basis-h">
            <h2 id="basis-h" style={{ margin: 0 }}>Basis</h2>
            <dl className="facts small">
              {v.reviewer && <><dt>Reviewed by</dt><dd>{v.reviewer.name}{v.reviewedAt ? `, ${dateText(v.reviewedAt)}` : ''}</dd></>}
              {v.issuedAt && <><dt>Issued</dt><dd>{dateText(v.issuedAt)}</dd></>}
              {v.validUntil && <><dt>Valid until</dt><dd>{dateText(v.validUntil)} (rates are dated; reprice after this date)</dd></>}
              <dt>Contingency</dt><dd>{v.contingencyPct}%</dd>
              <dt>Market settings</dt><dd>{v.packVersion}{v.illustrative ? ' (demo values, illustrative)' : ''}</dd>
            </dl>
            {v.documents.length > 0 && (
              <div className="small"><strong>Drawings measured</strong>
                <ul style={{ margin: 0 }}>{v.documents.map((d) => <li key={`${d.title}-${d.revision}`}>{d.number ? `${d.number} ` : ''}{d.title}, revision {d.revision}</li>)}</ul>
              </div>
            )}
            <div className="row small">
              <div><strong>Assumptions</strong>{v.assumptions.length ? <ul style={{ margin: 0 }}>{v.assumptions.map((a) => <li key={a}>{a}</li>)}</ul> : <p className="muted" style={{ margin: 0 }}>None recorded.</p>}</div>
              <div><strong>Exclusions</strong>{v.exclusions.length ? <ul style={{ margin: 0 }}>{v.exclusions.map((a) => <li key={a}>{a}</li>)}</ul> : <p className="muted" style={{ margin: 0 }}>None recorded.</p>}</div>
            </div>
          </section>

          {sections.map((sec) => (
            <section key={sec} className="card" style={{ padding: 0 }}>
              <div className="table-wrap">
                <table className="small">
                  <caption style={{ textAlign: 'left', padding: '.6rem .5rem', fontWeight: 700 }}>{sectionLabel(sec)}</caption>
                  <thead><tr><th scope="col">Item</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Rate</th><th scope="col" className="num">Amount (excl. tax)</th><th scope="col">Basis</th></tr></thead>
                  <tbody>
                    {v.lines.filter((l) => l.section === sec).map((l: Line) => (
                      <tr key={l.id}>
                        <td>{l.description}{l.specification && <div className="muted">{l.specification}</div>}</td>
                        <td className="num">{l.net} {l.unit}</td>
                        <td className="num">{l.unitRate !== '0' ? l.unitRate : '—'}</td>
                        <td className="num">{l.status === 'excluded' ? 'Excluded' : l.amount.display}</td>
                        <td>{STATUS_LABELS[l.status]}{l.quantitySource ? `; ${QSOURCE_LABELS[l.quantitySource]}` : ''}{l.rateSource ? `; rate: ${l.rateSource.label}, ${dateText(l.rateSource.reconfirmedAt ?? l.rateSource.observedAt)}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          {v.totals && <section className="card" aria-labelledby="tot-h"><h2 id="tot-h">Totals</h2><TotalsTable t={v.totals} /></section>}
        </>
      )}

      <footer className="small muted stack-sm">
        <p style={{ margin: 0 }}>{v.statement}</p>
        {v.snapshotHash && <p style={{ margin: 0, overflowWrap: 'anywhere' }}>Snapshot SHA-256: <code>{v.snapshotHash}</code></p>}
      </footer>
    </article>
  );
}
