import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PaymentActions, PaymentForm } from '@/components/projects/ProjectControls';
import { canDo, loadProject } from '@/lib/projects';
import { dateText } from '@/lib/format';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Payments' };

const METHOD: Record<string, string> = { bank_transfer: 'Bank transfer', cash: 'Cash', card: 'Card', mobile_money: 'Mobile money', cheque: 'Cheque', other: 'Other' };

/** Record-only payments (§14.1): never presented as processed or protected by the platform. */
export default async function Payments({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p || !canDo(p, 'payments.read')) notFound();
  const r = await api<any>(`/v1/projects/${id}/payments`);
  const d = r.data;
  return (
    <div className="stack">
      <h1 style={{ fontSize: '1.3rem', margin: 0 }}>Payment records</h1>
      <p className="notice">{d.notice}</p>
      {d.canRecord && <PaymentForm projectId={id} />}
      {d.items.length === 0 ? <p className="muted">No payments recorded.</p> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table>
            <caption className="sr-only">Recorded payments</caption>
            <thead><tr><th scope="col">Date</th><th scope="col">Paid to</th><th scope="col">For</th><th scope="col">Method</th><th scope="col" className="num">Amount</th><th scope="col">Recorded</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {d.items.map((x: any) => (
                <tr key={x.id} style={x.voided ? { opacity: .65 } : undefined}>
                  <td className="small">{x.paidOn}</td>
                  <td>{x.payee}</td>
                  <td className="small">{x.description}{x.reference && <div className="muted">Ref {x.reference}</div>}</td>
                  <td className="small">{METHOD[x.method] ?? x.method}</td>
                  <td className="num">{x.voided ? <s>{x.amount.display}</s> : x.amount.display}</td>
                  <td className="small">by {x.recordedBy}{x.acknowledgedBy ? <div><span className="pill pill-good">Acknowledged by {x.acknowledgedBy}</span></div> : <div className="muted">Not acknowledged</div>}{x.voided && <div><span className="pill pill-bad">Void: {x.voided.reason}</span> <span className="muted">{dateText(x.voided.at)}</span></div>}</td>
                  <td>{!x.voided && d.canRecord && <PaymentActions id={x.id} canAcknowledge={x.canAcknowledge} />}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th scope="row" colSpan={4}>Total recorded (excluding void records)</th><td className="num"><strong>{d.total.display}</strong></td><td colSpan={2} /></tr></tfoot>
          </table>
        </div>
      )}
    </div>
  );
}
