import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Help', description: 'How buying and selling on BuildWise works.' };

export default function Help() {
  return (
    <article className="stack" style={{ maxWidth: '46rem' }}>
      <h1>Help</h1>
      <section>
        <h2>Buying</h2>
        <p>Search or browse by category and area. Prices show the unit (per bag, tonne, trip or day); where a pack size is known we also show the price per kilogram so you can compare fairly.</p>
        <p>Contact sellers by chat, by phone (after signing in), or with a quote request that states the quantity, delivery area and date. You arrange payment and delivery directly with the seller. BuildWise does not hold money for goods or services.</p>
      </section>
      <section>
        <h2>Selling</h2>
        <p>Posting is free up to each category's allowance. Every listing is checked automatically; new sellers' listings are also reviewed by a person before they go live, usually within a working day. If we ask for changes, the reason is shown on the listing in <Link href="/my-ads">My ads</Link>, and you can appeal a decision once.</p>
        <p>Listings expire after the category's listing period. Renewing asks you to confirm the price is still right, so buyers see current prices.</p>
      </section>
      <section>
        <h2>Your account</h2>
        <p>You sign in with your mobile number and a one-time code. You can see and sign out your devices, and delete your account, from <Link href="/account">Account</Link>.</p>
      </section>
      <p><Link href="/help/safety">How to stay safe</Link> · <Link href="/help/selling">Selling and promotions</Link></p>
    </article>
  );
}
