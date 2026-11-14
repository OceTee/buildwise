import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { dateText } from '@/lib/format';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Invoice', robots: { index: false } };

export default async function Invoice({ params }: { params: Promise<{ number: string }> }) {
  const { number } = await params;
  if (!(await getMe())) redirect(`/sign-in?next=/account/invoices/${number}`);
  const r = await api<any>(`/v1/my/invoices/${encodeURIComponent(number)}`);
  if (r.status !== 200) notFound();
  const i = r.data;
  return (
    <article className="card stack" style={{ maxWidth: '40rem' }}>
      <h1>Invoice {i.number}</h1>
      <dl className="facts">
        <dt>Issued</dt><dd>{dateText(i.issuedAt)}</dd>
        <dt>Billed to</dt><dd>{i.billedTo}</dd>
        <dt>Supplier</dt><dd>BuildWise</dd>
      </dl>
      <table>
        <caption className="sr-only">Invoice lines</caption>
        <thead><tr><th scope="col">Description</th><th scope="col">Amount</th></tr></thead>
        <tbody>
          <tr><td>{i.line.description}</td><td>{i.line.net.display}</td></tr>
          <tr><td>{i.tax.code} at {i.tax.ratePercent}%</td><td>{i.tax.display}</td></tr>
          <tr><th scope="row">Total</th><td><strong>{i.total.display}</strong></td></tr>
        </tbody>
      </table>
      {i.illustrative && <p className="small muted">Demo market: this invoice is illustrative and not a tax document.</p>}
    </article>
  );
}
