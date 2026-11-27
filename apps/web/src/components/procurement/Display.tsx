import Link from 'next/link';
import { dateText } from '@/lib/format';

/** Server-rendered procurement displays shared by the client workspace and the provider pages. */

export const RFQ_STATE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' }, published: { label: 'Open for quotes', cls: 'pill-good' }, closed: { label: 'Closed, comparing', cls: 'pill-warn' },
  awarded: { label: 'Awarded', cls: 'pill-good' }, cancelled: { label: 'Cancelled', cls: 'pill-bad' }, no_award: { label: 'Closed without award', cls: '' },
};
export const QUOTE_STATE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: '' }, submitted: { label: 'Submitted', cls: 'pill-good' }, needs_revision: { label: 'Needs revision', cls: 'pill-warn' },
  revised: { label: 'Replaced by a newer version', cls: '' }, withdrawn: { label: 'Withdrawn', cls: 'pill-bad' }, expired: { label: 'Expired', cls: 'pill-bad' },
  rejected: { label: 'Not selected', cls: '' }, accepted: { label: 'Awarded', cls: 'pill-good' },
};
export const INVITE_STATE: Record<string, string> = { invited: 'Invited', viewed: 'Viewed', quoted: 'Quoted', declined: 'Declined (no bid)', revoked: 'No longer eligible' };
export const ORDER_STATE: Record<string, { label: string; cls: string }> = {
  placed: { label: 'Placed, awaiting supplier', cls: 'pill-warn' }, confirmed: { label: 'Confirmed by supplier', cls: 'pill-good' }, partially_fulfilled: { label: 'Partly delivered', cls: 'pill-warn' },
  fulfilled: { label: 'Delivered', cls: 'pill-good' }, closed: { label: 'Closed', cls: '' }, cancelled: { label: 'Cancelled', cls: 'pill-bad' }, disputed: { label: 'Disputed', cls: 'pill-bad' },
};
export const FLAG_LABEL: Record<string, string> = {
  missing: 'Not quoted', excluded: 'Excluded', substitution: 'Substitution', unit_differs: 'Different unit (converted)', non_comparable_unit: 'Unit not comparable', quantity_differs: 'Different quantity',
};

export const Pill = ({ map, k }: { map: Record<string, { label: string; cls: string }>; k: string }) => <span className={`pill ${map[k]?.cls ?? ''}`}>{map[k]?.label ?? k}</span>;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '');
export { when };

export function RfqFacts({ rfq }: { rfq: any }) {
  return (
    <dl className="facts small">
      <dt>Reference</dt><dd>{rfq.reference}, version {rfq.versionNumber}</dd>
      <dt>Category</dt><dd>{rfq.category.name}</dd>
      <dt>Delivery area</dt><dd>{rfq.area.label}{rfq.area.region ? `, ${rfq.area.region}` : ''}</dd>
      <dt>Quote deadline</dt><dd>{when(rfq.deadline)}{rfq.sealed ? ' · quotes sealed until then' : ''}</dd>
      {rfq.neededBy && (<><dt>Needed by</dt><dd>{dateText(rfq.neededBy)}</dd></>)}
      <dt>Scope</dt><dd>{rfq.scope.label}</dd>
    </dl>
  );
}

export function ScopeNotice({ scope }: { scope: { maturity: string; label: string; notice: string } }) {
  return <p className={`notice small ${scope.maturity === 'client_specified' ? 'notice-warn' : ''}`} style={{ margin: 0 }}><strong>{scope.label}.</strong> {scope.notice}</p>;
}

export function LinesTable({ lines }: { lines: any[] }) {
  return (
    <div className="table-wrap card" style={{ padding: 0 }}>
      <table>
        <caption className="sr-only">Lines to price</caption>
        <thead><tr><th scope="col">#</th><th scope="col">Item</th><th scope="col" className="num">Quantity</th><th scope="col">Unit</th><th scope="col">From</th></tr></thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.lineKey}>
              <td>{l.position}</td>
              <td>{l.description}{l.specification && <div className="small muted">{l.specification}</div>}</td>
              <td className="num">{l.quantity}</td>
              <td>{l.unitLabel}</td>
              <td className="small">{l.provenance.label}{l.provenance.estimateVersionNumber ? `, v${l.provenance.estimateVersionNumber}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function VersionHistory({ versions }: { versions: any[] }) {
  if (versions.length < 2) return null;
  return (
    <details className="small"><summary>Versions of this request ({versions.length})</summary>
      <ol>{versions.map((v) => <li key={v.number}>Version {v.number}, {when(v.createdAt)}{v.changeReason ? `: ${v.changeReason}` : ''}{v.changes?.length ? <ul>{v.changes.map((c: string) => <li key={c}>{c}</li>)}</ul> : null}</li>)}</ol>
    </details>
  );
}

export function Clarifications({ items }: { items: any[] }) {
  if (!items.length) return <p className="small muted" style={{ margin: 0 }}>No clarifications yet.</p>;
  return (
    <ul className="plain stack-sm">
      {items.map((c) => <li key={c.id} className="card-inset small"><strong>{c.side === 'client' ? 'Client' : 'Supplier'}</strong> · {c.author} · {when(c.at)}<p style={{ margin: '.25rem 0 0' }}>{c.body}</p></li>)}
    </ul>
  );
}

export function OrderView({ o, rfqHref }: { o: any; rfqHref: string | null }) {
  const t = o.terms;
  return (
    <div className="stack">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: '1.3rem', margin: 0 }}>{o.kind === 'contract' ? 'Contract' : 'Order'} {o.reference}</h1>
        <Pill map={ORDER_STATE} k={o.state} />
      </div>
      <p className="notice small" style={{ margin: 0 }}><strong>Record only.</strong> {o.paymentNotice}</p>
      <dl className="facts small">
        <dt>Supplier</dt><dd><Link href={`/seller/${o.provider.handle}`}>{o.provider.name}</Link></dd>
        <dt>From</dt><dd>{rfqHref ? <Link href={rfqHref}>{o.rfq.reference}: {o.rfq.title}</Link> : `${o.rfq.reference}: ${o.rfq.title}`}</dd>
        <dt>{o.kind === 'contract' ? 'Bid' : 'Quote'}</dt><dd>Version {t.number}, submitted {when(t.submittedAt)} · scope: {t.scope}</dd>
        {o.revisionNumber > 1 && (<><dt>Contract value now</dt><dd>{o.contractValue.display} (revision {o.revisionNumber}, after approved variations)</dd></>)}
        {o.retentionPct > 0 && (<><dt>Retention</dt><dd>{o.retentionPct}%</dd></>)}
        {t.tenderResponse && (<><dt>Programme</dt><dd>{t.tenderResponse.startDate ? `From ${t.tenderResponse.startDate}` : ''}{t.tenderResponse.programmeWeeks ? `, ${t.tenderResponse.programmeWeeks} weeks` : ''}</dd></>)}
        <dt>Valid until</dt><dd>{dateText(t.terms.validUntil)}</dd>
        {t.terms.paymentTerms && (<><dt>Payment terms</dt><dd>{t.terms.paymentTerms}</dd></>)}
        {t.terms.warranty && (<><dt>Warranty</dt><dd>{t.terms.warranty}</dd></>)}
        {t.terms.leadTimeDays != null && (<><dt>Lead time</dt><dd>{t.terms.leadTimeDays} days</dd></>)}
        <dt>Placed</dt><dd>{when(o.createdAt)}{o.confirmedAt ? ` · confirmed ${when(o.confirmedAt)}` : ''}{o.fulfilledAt ? ` · delivered in full ${when(o.fulfilledAt)}` : ''}{o.closedAt ? ` · closed ${when(o.closedAt)}` : ''}</dd>
        {o.cancelReason && (<><dt>Reason</dt><dd>{o.cancelReason}</dd></>)}
      </dl>
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table>
          <caption className="sr-only">Order lines, exactly as quoted</caption>
          <thead><tr><th scope="col">Item</th><th scope="col">Offered</th><th scope="col" className="num">Quantity</th><th scope="col" className="num">Unit price</th><th scope="col" className="num">Amount</th></tr></thead>
          <tbody>
            {t.lines.map((l: any) => (
              <tr key={l.rfqLineKey}>
                <td>{l.description}{l.isSubstitution && <div><span className="pill pill-warn">Substitution</span> <span className="small">{l.substitutionNote}</span></div>}</td>
                <td className="small">{l.offered ?? '—'}</td>
                <td className="num">{l.status === 'excluded' ? 'Excluded' : `${l.quantity} ${l.unitLabel}`}</td>
                <td className="num">{l.status === 'excluded' ? '—' : l.unitPriceDisplay}</td>
                <td className="num">{l.amountDisplay}</td>
              </tr>
            ))}
          </tbody>
          <tfoot><tr><th scope="row" colSpan={4}>{o.kind === 'contract' ? 'Awarded total including tax' : 'Total including delivery and tax'}</th><td className="num"><strong>{o.total.display}</strong></td></tr></tfoot>
        </table>
      </div>
      {t.terms.exclusions?.length > 0 && <div className="small"><strong>Supplier exclusions:</strong> {t.terms.exclusions.join('; ')}</div>}
      <p className="small muted" style={{ margin: 0 }}>Terms fingerprint (SHA-256 of the quote version): <code style={{ wordBreak: 'break-all' }}>{o.termsHash}</code></p>
    </div>
  );
}
