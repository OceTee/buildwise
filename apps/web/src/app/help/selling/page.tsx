import type { Metadata } from 'next';
import { money } from '@/lib/format';
import { api, getMarket } from '@/lib/server';

export const metadata: Metadata = { title: 'Selling and promotions', description: 'Free listing allowances and paid promotions on BuildWise.' };

export default async function Selling() {
  const [market, products] = await Promise.all([getMarket(), api<{ items: any[] }>('/v1/promotions/products')]);
  return (
    <article className="stack" style={{ maxWidth: '46rem' }}>
      <h1>Selling and promotions</h1>
      <p>Posting is free up to each category's allowance. Promotions are optional and never affect whether a listing is approved.</p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Promotion prices</caption>
          <thead><tr><th scope="col">Promotion</th><th scope="col">Price</th><th scope="col">Including {market.tax.label}</th></tr></thead>
          <tbody>
            {products.data.items.map((p) => (
              <tr key={p.code}><td>{p.name}{p.extraAllowance ? <div className="small muted">+{p.extraAllowance} free listings while active</div> : null}</td><td>{p.net.display}</td><td>{money(p.gross)}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <section>
        <h2>How promotions are shown</h2>
        <p>Paid listings are always labelled “Top ad” or “Promoted”, and they only appear in searches they match. They are never mixed into price comparisons.</p>
        <p>If your listing goes back to review or is closed, the promotion pauses and the remaining time resumes when it is live again. If we remove it for something that was not your fault, unused time becomes a credit. Time is forfeited only for prohibited items or scams.</p>
      </section>
      {market.illustrative && <p className="small muted">Prices shown are for the demo market and are illustrative.</p>}
    </article>
  );
}
