import type { Metadata } from 'next';
import { getMarket } from '@/lib/server';

export const metadata: Metadata = { title: 'Stay safe', description: 'How to buy and hire safely on BuildWise.' };

export default async function Safety() {
  const market = await getMarket();
  return (
    <article className="stack" style={{ maxWidth: '46rem' }}>
      <h1>Stay safe</h1>
      <ul>{market.safetyTips.map((t) => <li key={t}>{t}</li>)}</ul>
      <section>
        <h2>Warning signs</h2>
        <ul>
          <li>A seller asks for a deposit or full payment before you have seen the goods.</li>
          <li>A price far below everyone else's for the same item and unit.</li>
          <li>Pressure to move to another app or to pay a third party.</li>
          <li>Someone claims to be a well-known business but the profile has no business check.</li>
        </ul>
      </section>
      <section>
        <h2>What the checks mean</h2>
        <p>A check confirms one fact on the date shown, such as a business registration. It is not a guarantee of quality or honesty. Professional registration numbers are declared by the seller unless a check is shown.</p>
      </section>
      <section>
        <h2>Report a problem</h2>
        <p>Use “Report” on any listing, seller, message or review. Reports of scams, impersonation and unsafe work are reviewed first.</p>
      </section>
    </article>
  );
}
