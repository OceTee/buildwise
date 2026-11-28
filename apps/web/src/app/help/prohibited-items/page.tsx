import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal/Legal';
import { getPolicies } from '@/lib/server';

export const metadata: Metadata = { title: 'Prohibited and restricted items', description: 'What cannot be listed on BuildWise, and what needs extra details and a review.' };

export default async function ProhibitedItems() {
  const p = await getPolicies();
  return (
    <LegalPage title="Prohibited and restricted items" intro={<>Some things cannot be listed on BuildWise at all. Others can be listed only with extra details, after a person has reviewed them. This list comes from the rules for {p.market.name}.</>}>
      <section aria-labelledby="prohibited-h">
        <h2 id="prohibited-h">Prohibited: never allowed</h2>
        <ul className="plain stack">
          {p.itemRules.prohibited.map((r) => (
            <li key={r.title} className="card stack-sm">
              <h3 style={{ margin: 0 }}>{r.title}</h3>
              <p style={{ margin: 0 }}>{r.detail}</p>
              {r.examples?.length ? <p className="small muted" style={{ margin: 0 }}>For example: {r.examples.join(', ')}.</p> : null}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="restricted-h">
        <h2 id="restricted-h">Restricted: extra details and a review</h2>
        <ul className="plain stack">
          {p.itemRules.restricted.map((r) => (
            <li key={r.title} className="card stack-sm">
              <h3 style={{ margin: 0 }}>{r.title}</h3>
              <p style={{ margin: 0 }}>{r.detail}</p>
              {r.examples?.length ? <p className="small muted" style={{ margin: 0 }}>For example: {r.examples.join(', ')}.</p> : null}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2>How we check</h2>
        <p>Listings are checked automatically when you submit them. A listing that mentions any of these words is held: prohibited ({p.prohibitedTerms.join(', ')}); restricted ({p.restrictedTerms.join(', ')}). A person then decides, and you see the reason in <Link href="/my-ads">My ads</Link>. Words alone are not the whole test: a moderator can also remove a listing for an item on this page that the checks missed.</p>
        <p>A promotion on a listing removed for a prohibited item is forfeited. Repeated prohibited listings can restrict or suspend an account.</p>
        <p>Seen something that should not be here? Use “Report” on the listing.</p>
      </section>
    </LegalPage>
  );
}
