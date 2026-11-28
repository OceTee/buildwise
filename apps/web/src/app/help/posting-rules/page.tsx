import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal/Legal';
import { getPolicies } from '@/lib/server';

export const metadata: Metadata = { title: 'Posting rules', description: 'What a listing on BuildWise must include, what it must not, and how listings are checked.' };

export default async function PostingRules() {
  const p = await getPolicies();
  const subs = p.categories.filter((c) => c.parent || !p.categories.some((x) => x.parent === c.slug));
  return (
    <LegalPage title="Posting rules" intro="Clear, honest listings help buyers find you and keep everyone safe. Every listing is checked against these rules before and after it goes live.">
      <section>
        <h2>Every listing must</h2>
        <ul>
          <li>Be a real item or service you can sell or provide now, in the area you choose.</li>
          <li>Show the price and the unit it is for (per bag, tonne, trip, day, m² and so on), including the pack size where the category asks for it, so buyers can compare fairly.</li>
          <li>Use your own photos of the actual item, as many as the category needs (below).</li>
          <li>Fill in the details the category requires, such as brand and grade. Grades and registrations are shown as declared by you unless a check confirms them.</li>
          <li>Be in the right category, once. Edit or renew a listing instead of posting it again.</li>
        </ul>
      </section>
      <section>
        <h2>A listing must not</h2>
        <ul>
          <li>Contain phone numbers, emails or links in the title or description. Buyers reach you through chat, a quote request or "Show phone number".</li>
          <li>Ask for payment up front, a deposit to "reserve", or a "booking" or "release" fee, or name a wallet or payment app to pay into.</li>
          <li>Offer anything on the <Link href="/help/prohibited-items">prohibited items</Link> list. Restricted items need the extra details listed there and are reviewed by a person.</li>
          <li>Make claims we cannot check (for example "best in Nigeria", or a standard the product does not meet).</li>
          <li>Use someone else's photos, name or brand.</li>
        </ul>
      </section>
      <section>
        <h2>How listings are checked</h2>
        <p>Every listing is checked automatically for contact details, payment instructions, scam phrases, reused photos and prices far from similar listings. New sellers' listings are always reviewed by a person; once a seller has had listings live for {p.moderation.establishedSellerMinLiveDays} days, listings that pass every check in an open category go live straight away. If we ask for changes or reject a listing, the reason is shown in <Link href="/my-ads">My ads</Link>, and you can appeal once; a different moderator decides.</p>
        <p>Changing the price by more than {p.moderation.materialPriceChangePct}%, the category or the main details sends a live listing back for review. A listing that gets {p.moderation.reportThreshold} reports goes back to review while we look. New accounts can post up to {p.limits.listingsPerNewAccountPerDay} listings a day.</p>
      </section>
      <section>
        <h2>Rules by category</h2>
        <div className="table-wrap"><table>
          <caption className="sr-only">Photos, listing period, free allowance and review by category</caption>
          <thead><tr><th scope="col">Category</th><th scope="col" className="num">Photos</th><th scope="col" className="num">Listed for</th><th scope="col" className="num">Free listings (person / business)</th><th scope="col">Reviewed by a person</th></tr></thead>
          <tbody>
            {subs.map((c) => (
              <tr key={c.slug}>
                <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 'inherit', color: 'inherit', fontWeight: 500 }}>{c.name}</th>
                <td className="num">{c.minPhotos === 0 ? 'Optional' : `At least ${c.minPhotos}`}</td>
                <td className="num">{c.listingPeriodDays} days</td>
                <td className="num">{c.freeAllowance.individual} / {c.freeAllowance.business}</td>
                <td>{c.alwaysReviewed ? 'Always' : 'New sellers'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        <p className="small muted">When a listing period ends, renewing asks you to confirm the price is still right. Fees for promotions are on <Link href="/help/selling">Selling and promotions</Link>{p.market.illustrative && ' (illustrative while the market data is illustrative)'}.</p>
      </section>
    </LegalPage>
  );
}
