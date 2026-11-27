import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { INVITE_STATE, LinesTable, Pill, QUOTE_STATE, RFQ_STATE, RfqFacts, ScopeNotice, VersionHistory, when } from '@/components/procurement/Display';
import { RfqActions } from '@/components/procurement/ProcurementControls';
import { Nominations, OpenBids, OpeningRegister, TenderClarifications, TenderPackage } from '@/components/procurement/Tender';
import { loadProject } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Request or tender' };

export default async function RfqPage({ params }: { params: Promise<{ id: string; rfqId: string }> }) {
  const { id, rfqId } = await params;
  const p = await loadProject(id);
  if (!p || !/^[0-9a-f-]{36}$/.test(rfqId)) notFound();
  const r = await api<any>(`/v1/rfqs/${rfqId}`);
  if (r.status !== 200 || r.data.side !== 'client' || r.data.projectId !== id) notFound();
  const rfq = r.data;
  const q = rfq.quotes;
  const tender = rfq.kind === 'tender';
  const bids = tender ? 'bid' : 'quote';
  return (
    <div className="stack">
      <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href={`/projects/${id}/rfqs`}>Procurement</Link></li><li aria-current="page">{rfq.reference}</li></ol></nav>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '1.3rem', margin: 0 }}>{rfq.title}</h1>
        <Pill map={RFQ_STATE} k={rfq.state} />
      </div>
      <ScopeNotice scope={rfq.scope} />
      <RfqFacts rfq={rfq} />
      <p className="small" style={{ margin: 0 }}><strong>Who can {bids}:</strong> {rfq.sourcing.label}</p>
      {rfq.notes && <p className="small" style={{ margin: 0 }}><strong>Notes:</strong> {rfq.notes}</p>}
      {tender && <TenderPackage rfqId={rfq.id} pkg={rfq.tender.package} />}
      <LinesTable lines={rfq.lines} />
      <VersionHistory versions={rfq.versions} />
      {rfq.sourcingMode === 'nominated' && rfq.canManage && ['draft', 'published'].includes(rfq.state) && <Nominations rfq={rfq} />}
      {tender && rfq.state !== 'draft' && <TenderClarifications rfq={rfq} />}
      {tender && rfq.state === 'published' && <OpenBids rfq={rfq} />}
      {tender && <OpeningRegister opening={rfq.tender.opening} currency={rfq.currency} />}

      {rfq.state !== 'draft' && (
        <section aria-labelledby="inv-h" className="stack-sm">
          <div className="inline" style={{ justifyContent: 'space-between' }}>
            <h2 id="inv-h" style={{ margin: 0 }}>{tender ? 'Bidders and bids' : 'Suppliers and quotes'}</h2>
            {rfq.state !== 'draft' && <Link className="btn btn-small" href={`/projects/${id}/rfqs/${rfqId}/compare`}>{q.pricesOpen ? (tender ? 'Compare and evaluate bids' : 'Compare quotes') : (tender ? 'Bid status' : 'Quote status')}</Link>}
          </div>
          {!q.pricesOpen && <p className="small notice" style={{ margin: 0 }}>{tender ? `Bids are sealed until they are opened together at the deadline (${when(q.sealedUntil)}). You can see how many arrived, not their prices or responses.` : `Quotes are sealed until ${when(q.sealedUntil)}. You can see how many arrived, not their prices.`}</p>}
          <p className="small" style={{ margin: 0 }}>{q.count} {bids}{q.count === 1 ? '' : 's'} received from {rfq.invitations.filter((i: any) => i.state !== 'revoked').length} invited.</p>
          <div className="table-wrap card" style={{ padding: 0 }}>
            <table>
              <caption className="sr-only">Invited suppliers</caption>
              <thead><tr><th scope="col">Supplier</th><th scope="col">Invitation</th><th scope="col">Quote</th><th scope="col">Why this provider</th></tr></thead>
              <tbody>
                {rfq.invitations.map((i: any) => (
                  <tr key={i.id}>
                    <td><Link href={`/seller/${i.handle}`}>{i.providerName}</Link>{i.source === 'quote_request' && <div className="small muted">From your quote request</div>}{i.match?.promoted && <div><span className="pill pill-promo">Promoted listing</span></div>}</td>
                    <td className="small">{INVITE_STATE[i.state] ?? i.state}{i.declineReason ? `: ${i.declineReason}` : ''}</td>
                    <td>{i.quote ? <><Pill map={QUOTE_STATE} k={i.quote.status} /> <span className="small muted">v{i.quote.versionNumber}</span></> : <span className="small muted">None yet</span>}</td>
                    <td className="small">{i.match?.why?.join(' · ') ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {rfq.order && <p className="notice notice-good" style={{ margin: 0 }}>Awarded. <Link href={`/projects/${id}/orders/${rfq.order.id}`}>Open {tender ? 'contract CT' : 'order PO'}-{String(rfq.order.number).padStart(3, '0')}</Link></p>}
      {rfq.closeReason && ['cancelled', 'no_award'].includes(rfq.state) && <p className="small muted">Reason: {rfq.closeReason}</p>}
      <RfqActions rfq={rfq} />
    </div>
  );
}
