import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FLAG_LABEL, Pill, QUOTE_STATE, ScopeNotice, when } from '@/components/procurement/Display';
import { AwardButton, ClarificationForm } from '@/components/procurement/ProcurementControls';
import { OpeningRegister, TenderEvaluation } from '@/components/procurement/Tender';
import { dateText } from '@/lib/format';
import { loadProject } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Compare quotes' };

/** Normalised comparison (spec §10.4 step 4): source values kept, flags shown, no lowest total across unlike quotes. */
export default async function Compare({ params }: { params: Promise<{ id: string; rfqId: string }> }) {
  const { id, rfqId } = await params;
  const p = await loadProject(id);
  if (!p || !/^[0-9a-f-]{36}$/.test(rfqId)) notFound();
  const [r, c] = await Promise.all([api<any>(`/v1/rfqs/${rfqId}`), api<any>(`/v1/rfqs/${rfqId}/comparison`)]);
  if (r.status !== 200 || c.status !== 200 || r.data.projectId !== id) notFound();
  const rfq = r.data; const d = c.data;
  const crumbs = <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href={`/projects/${id}/rfqs`}>Procurement</Link></li><li><Link href={`/projects/${id}/rfqs/${rfqId}`}>{rfq.reference}</Link></li><li aria-current="page">Compare</li></ol></nav>;
  if (d.sealed) {
    return (
      <div className="stack">
        {crumbs}
        <h1 style={{ fontSize: '1.3rem', margin: 0 }}>{d.kind === 'tender' ? 'Bids' : 'Quotes'} for {rfq.title}</h1>
        <p className="notice" style={{ margin: 0 }}>{d.message} {d.kind === 'tender' ? `Deadline ${when(d.sealedUntil)}.` : `Sealed until ${when(d.sealedUntil)}.`}</p>
        <p>{d.count} {d.kind === 'tender' ? 'bid' : 'quote'}{d.count === 1 ? '' : 's'} received.</p>
        <ul>{d.statuses.map((x: any) => <li key={x.providerName}>{x.providerName}: {QUOTE_STATE[x.status]?.label ?? x.status}</li>)}</ul>
      </div>
    );
  }
  const cols: any[] = d.columns;
  return (
    <div className="stack">
      {crumbs}
      <h1 style={{ fontSize: '1.3rem', margin: 0 }}>{d.kind === 'tender' ? 'Compare bids' : 'Compare quotes'}: {rfq.title}</h1>
      <ScopeNotice scope={d.scope} />
      {d.tender && <OpeningRegister opening={d.tender.opening} currency={d.currency} />}
      {cols.length === 0 ? <p className="muted">No quotes to compare yet.</p> : (
        <>
          <p className={`notice small ${d.lowestTotal ? 'notice-good' : ''}`} style={{ margin: 0 }}>
            {d.lowestTotal ? <><strong>Lowest total: {cols.find((x) => x.quoteId === d.lowestTotal.quoteId)?.providerName}, {d.lowestTotal.display}.</strong> {d.lowestTotalNote}</> : d.lowestTotalNote}
            {' '}Check exclusions, validity and terms as well as price.
          </p>
          <div className="table-wrap card" style={{ padding: 0 }}>
            <table>
              <caption className="sr-only">Quotes side by side, line by line</caption>
              <thead>
                <tr><th scope="col">Requested</th>{cols.map((col) => <th key={col.quoteId} scope="col">{col.providerName}<div className="small muted">v{col.versionNumber} · <Pill map={QUOTE_STATE} k={col.state} /></div></th>)}</tr>
              </thead>
              <tbody>
                {d.rows.map((row: any) => (
                  <tr key={row.line.lineKey}>
                    <th scope="row">{row.line.description}<div className="small muted">{row.line.quantity} {row.line.unitLabel}{row.line.specification ? ` · ${row.line.specification}` : ''}</div></th>
                    {row.cells.map((cell: any) => (
                      <td key={cell.quoteId} className="small">
                        {cell.source && cell.status === 'priced' ? (
                          <>
                            <div><strong>{cell.display.amount}</strong>{cell.lowest && <> <span className="pill pill-good">Lowest</span></>}</div>
                            <div>{cell.source.quantity} {cell.source.unit} at {cell.display.unitPrice}</div>
                            {cell.display.perBase && <div className="muted">{cell.display.perBase}</div>}
                            {cell.source.offered && <div className="muted">{cell.source.offered}</div>}
                            {cell.source.substitutionNote && <div>{cell.source.substitutionNote}</div>}
                          </>
                        ) : null}
                        <div className="inline">{cell.flags.map((f: string) => <span key={f} className={`pill ${['missing', 'excluded', 'non_comparable_unit'].includes(f) ? 'pill-bad' : 'pill-warn'}`}>{FLAG_LABEL[f] ?? f}</span>)}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr><th scope="row">Lines</th>{cols.map((col) => <td key={col.quoteId} className="num">{col.display.lines}</td>)}</tr>
                <tr><th scope="row">Delivery</th>{cols.map((col) => <td key={col.quoteId} className="num">{col.display.delivery}</td>)}</tr>
                <tr><th scope="row">Tax</th>{cols.map((col) => <td key={col.quoteId} className="num">{col.display.tax}</td>)}</tr>
                <tr><th scope="row">Total</th>{cols.map((col) => <td key={col.quoteId} className="num"><strong>{col.display.gross}</strong>{!col.likeForLike && <div className="small muted">Not like for like</div>}</td>)}</tr>
                <tr><th scope="row">Valid until</th>{cols.map((col) => <td key={col.quoteId} className="small">{dateText(col.terms.validUntil)}</td>)}</tr>
                <tr><th scope="row">Terms</th>{cols.map((col) => <td key={col.quoteId} className="small">{[col.terms.paymentTerms, col.terms.warranty && `Warranty: ${col.terms.warranty}`, col.terms.leadTimeDays != null && `${col.terms.leadTimeDays} days lead time`].filter(Boolean).join(' · ') || '—'}{col.terms.exclusions.length > 0 && <div><strong>Excludes:</strong> {col.terms.exclusions.join('; ')}</div>}</td>)}</tr>
                <tr><th scope="row">Flags</th>{cols.map((col) => <td key={col.quoteId} className="small"><div className="inline">
                  {col.flags.partial && <span className="pill pill-bad">Partial bid</span>}
                  {col.flags.substitutions > 0 && <span className="pill pill-warn">{col.flags.substitutions} substitution{col.flags.substitutions === 1 ? '' : 's'}</span>}
                  {col.flags.nonComparableLines > 0 && <span className="pill pill-bad">{col.flags.nonComparableLines} not comparable</span>}
                  {col.flags.needsRevision && <span className="pill pill-warn">Answers an older version</span>}
                  {col.likeForLike && <span className="pill pill-good">Like for like</span>}
                </div></td>)}</tr>
                {d.canAward && <tr><th scope="row">Award</th>{cols.map((col) => <td key={col.quoteId}><AwardButton rfqId={rfqId} projectId={id} quoteVersionId={col.versionId} providerName={col.providerName} expectedVersion={d.rfqVersion} blockers={col.awardBlockers} /></td>)}</tr>}
              </tfoot>
            </table>
          </div>
          {rfq.state === 'published' && <p className="small muted">Close the request to award. Quotes can still arrive until then.</p>}
          {d.tender && <TenderEvaluation rfqId={rfqId} t={d.tender} columns={cols} />}
        </>
      )}
      {d.noBids.length > 0 && <section aria-labelledby="nb-h"><h2 id="nb-h" style={{ fontSize: '1rem' }}>No bids</h2><ul>{d.noBids.map((n: any) => <li key={n.providerOrgId}>{n.providerName}{n.reason ? `: ${n.reason}` : ''}</li>)}</ul></section>}
      {d.waiting.length > 0 && <p className="small muted">Not yet answered: {d.waiting.join(', ')}.</p>}
      {rfq.canManage && cols.length > 0 && ['published', 'closed'].includes(rfq.state) && d.kind !== 'tender' && (
        <section aria-labelledby="cl-h" className="stack-sm">
          <h2 id="cl-h" style={{ fontSize: '1rem' }}>Ask a supplier about their quote</h2>
          <div className="row">{cols.map((col) => <div key={col.quoteId} className="card"><ClarificationForm quoteId={col.quoteId} label={`Question for ${col.providerName}`} /></div>)}</div>
        </section>
      )}
    </div>
  );
}
