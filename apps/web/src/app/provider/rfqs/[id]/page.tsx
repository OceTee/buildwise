import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Clarifications, LinesTable, Pill, QUOTE_STATE, RFQ_STATE, RfqFacts, ScopeNotice, VersionHistory } from '@/components/procurement/Display';
import { ClarificationForm, DeclineForm, QuoteForm, StartQuote, WithdrawQuote } from '@/components/procurement/ProcurementControls';
import { TenderClarifications, TenderPackage } from '@/components/procurement/Tender';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Respond to a request', robots: { index: false } };

export default async function ProviderRfq({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getMe())) redirect(`/sign-in?next=/provider/rfqs/${id}`);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const r = await api<any>(`/v1/rfqs/${id}`);
  if (r.status !== 200 || r.data.side !== 'provider') notFound();
  const rfq = r.data;
  const q = rfq.quote;
  const [draft, cfg] = await Promise.all([
    q?.draftVersionId && rfq.canQuote ? api<any>(`/v1/quote-versions/${q.draftVersionId}`).then((x) => x.data) : Promise.resolve(null),
    api<any>('/v1/procurement-config').then((x) => x.data),
  ]);
  const live = q?.versions.find((v: any) => ['submitted', 'needs_revision'].includes(v.state));
  const tender = rfq.kind === 'tender';
  const word = tender ? 'bid' : 'quote';
  return (
    <div className="stack">
      <nav aria-label="Breadcrumb" className="breadcrumbs"><ol><li><Link href="/provider/rfqs">Requests for quotes</Link></li><li aria-current="page">{rfq.reference}</li></ol></nav>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '1.3rem', margin: 0 }}>{rfq.title}</h1>
        <Pill map={RFQ_STATE} k={rfq.state} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>Responding for {rfq.provider.name}. Only the delivery area is shared until an order is placed.</p>
      <ScopeNotice scope={rfq.scope} />
      <RfqFacts rfq={rfq} />
      {rfq.notes && <p className="small" style={{ margin: 0 }}><strong>Notes from the client:</strong> {rfq.notes}</p>}
      {tender && <TenderPackage rfqId={rfq.id} pkg={rfq.tender.package} />}
      <LinesTable lines={rfq.lines} />
      <VersionHistory versions={rfq.versions} />
      {tender && <TenderClarifications rfq={rfq} />}
      {tender && rfq.tender.openedAt && <p className="notice small" style={{ margin: 0 }}>The bids were opened together on {new Date(rfq.tender.openedAt).toLocaleString('en-GB', { timeZone: 'Africa/Lagos' })}. The client is evaluating them.</p>}
      {live?.state === 'submitted' && <p className="notice notice-good" style={{ margin: 0 }}>{tender ? 'Bid' : 'Quote'} version {live.number} submitted{live.gross ? `: ${live.gross.display}` : ''}.{tender ? ' It stays sealed until the deadline; you can withdraw it or bid again until then.' : ' It can’t be edited; a change means a new version.'}</p>}
      {live?.state === 'needs_revision' && <p className="notice notice-warn" style={{ margin: 0 }}>The request changed after you quoted. Start a new version to re-quote; your previous quote can no longer be awarded.</p>}
      {rfq.invitation.state === 'declined' && <p className="notice" style={{ margin: 0 }}>You declined: {rfq.invitation.declineReason}</p>}
      {rfq.order && <p className="notice notice-good" style={{ margin: 0 }}>You were awarded this request. <Link href={`/provider/orders/${rfq.order.id}`}>Open the order</Link></p>}

      {q && q.versions.length > 0 && (
        <section aria-labelledby="qv-h" className="stack-sm">
          <h2 id="qv-h" style={{ fontSize: '1.05rem', margin: 0 }}>Your {word} versions</h2>
          <ul className="plain stack-sm">
            {q.versions.map((v: any) => <li key={v.id} className="card-inset inline" style={{ justifyContent: 'space-between' }}><span>Version {v.number} <span className="small muted">for request v{v.rfqVersionNumber}</span></span><span className="inline"><Pill map={QUOTE_STATE} k={v.state} />{v.gross && <strong>{v.gross.display}</strong>}</span></li>)}
          </ul>
          {live && rfq.canWithdraw && <WithdrawQuote versionId={live.id} label={word} />}
        </section>
      )}

      {rfq.canQuote && (draft ? <QuoteForm key={`${draft.id}-${draft.version}`} draft={draft} rfqLines={rfq.lines} units={cfg.units} pkg={tender ? rfq.tender.package : null} /> : (
        <div className="stack-sm">
          <StartQuote rfqId={id} label={tender ? 'Start a bid' : 'Start a quote'} />
          {live && <p className="small muted" style={{ margin: 0 }}>A new version starts from your last one. The submitted version stays exactly as it was.</p>}
        </div>
      ))}
      {rfq.canDecline && !live && <DeclineForm rfqId={id} />}

      {q && !tender && (
        <section aria-labelledby="cl-h" className="stack-sm">
          <h2 id="cl-h" style={{ fontSize: '1.05rem', margin: 0 }}>Clarifications</h2>
          <Clarifications items={q.clarifications} />
          {['published', 'closed'].includes(rfq.state) && <ClarificationForm quoteId={q.id} label="Reply or ask the client" />}
        </section>
      )}
    </div>
  );
}
