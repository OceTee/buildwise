import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal/Legal';
import { SUPPORT_EMAIL } from '@/lib/env';
import { getPolicies } from '@/lib/server';

export const metadata: Metadata = { title: 'Terms of use', description: 'The rules for using BuildWise during the public beta.' };

export default async function Terms() {
  const p = await getPolicies();
  return (
    <LegalPage title="Terms of use" intro="These terms are the agreement between you and BuildWise when you use this website, the build assistant, the marketplace and the project workspace. Please read them before you use BuildWise.">
      <section>
        <h2>1. What BuildWise is</h2>
        <p>BuildWise is software and services for people who build. It helps you design a building concept, estimate costs and materials, find sellers, tradespeople and professionals, and run a project with documents, requests for quotes and orders.</p>
        <p>BuildWise <strong>is not</strong> a seller, a contractor, an architect, an engineer, a quantity surveyor or a lawyer, and nothing on BuildWise is legal, financial, engineering or professional advice. Designs from the build assistant are <strong>concept designs</strong>: before you build, have them checked and drawn up by a qualified professional and approved by the building authority where you build.</p>
      </section>
      <section>
        <h2>2. The public beta</h2>
        <p>BuildWise is in a public beta. Features may change, stop working for a while or be removed, and data in the beta may be reset with notice. While the market data is illustrative ({p.market.name}), places, prices, fees and tax figures on BuildWise are examples, not real offers or quotations. Please <Link href="/feedback">tell us</Link> when something is wrong.</p>
      </section>
      <section>
        <h2>3. Your account</h2>
        <ul>
          <li>You sign in with your mobile number and a one-time code. Keep your phone and codes to yourself: anyone with them can use your account. We will never ask you for a code.</li>
          <li>Give a name that is yours or your business's. Do not pretend to be another person or business.</li>
          <li>You must be old enough to make a binding agreement where you live.</li>
          <li>You can delete your account at any time from <Link href="/account">Account</Link>. Some records stay for the periods in our <Link href="/privacy">privacy notice</Link>.</li>
        </ul>
      </section>
      <section>
        <h2>4. Buying, selling and hiring</h2>
        <ul>
          <li>Contracts for goods and services are between the buyer and the seller or provider. BuildWise is not a party to them.</li>
          <li><strong>BuildWise never holds money for goods or services.</strong> You pay the seller or provider directly, on terms you agree with them. Inspect goods before you pay, and never pay a "booking" or "release" fee. Order and payment records in the project workspace are records only; they do not move money.</li>
          <li>Sellers are responsible for what they list: it must be accurate, theirs to sell, safe and legal, and follow the <Link href="/help/posting-rules">posting rules</Link> and the <Link href="/help/prohibited-items">prohibited and restricted items</Link> list.</li>
          <li>A verification check confirms one fact on the date shown (for example a business registration). It is not a guarantee of quality, honesty or workmanship.</li>
          <li>Search results and requests for quotes are ranked by the factors we show. Paid promotions are always labelled and never change a moderation or verification decision.</li>
        </ul>
      </section>
      <section>
        <h2>5. Paid services</h2>
        <p>The only things you pay BuildWise for are our own services, such as promoting a listing. You pay through the payment provider's hosted checkout; we never see your card details. A promotion starts when the payment provider confirms payment. If a promoted listing is rejected or blocked, unused time becomes a credit for another listing, unless it was blocked for fraud or a prohibited item, in which case the unused time is forfeited. Prices are shown in {p.market.currency} with {p.tax.label} at {p.tax.ratePercent}%.</p>
      </section>
      <section>
        <h2>6. What you must not do</h2>
        <ul>
          <li>Break the law, scam, harass or threaten anyone, or ask for payment outside the agreed terms.</li>
          <li>Post someone else's photos, plans or work without their permission.</li>
          <li>Put phone numbers, emails, links or payment instructions in listings or chats where the posting rules forbid it.</li>
          <li>Scrape BuildWise, collect other people's contact details, or get around rate limits, checks or bans.</li>
          <li>Try to break into accounts, systems or data that are not yours.</li>
        </ul>
        <p>If you do, we may hold or remove content, limit features, or suspend your account. We tell you the reason and you can appeal a moderation decision once; a different moderator decides the appeal.</p>
      </section>
      <section>
        <h2>7. Your content</h2>
        <p>You keep the rights in what you post and upload: listings, photos, drawings, documents, messages and reviews. You give BuildWise permission to store, show, resize and check it so the service works (for example to show your listing to buyers or a drawing to the project members you invite). We do not sell your content. Our own software, designs and text belong to BuildWise.</p>
      </section>
      <section>
        <h2>8. The build assistant and AI features</h2>
        <p>Some features use AI services (see the <Link href="/privacy">privacy notice</Link>). AI answers and designs can be wrong. Check figures, sizes and rules yourself and with a professional; BuildWise labels AI suggestions and never confirms a design decision for you.</p>
      </section>
      <section>
        <h2>9. Responsibility</h2>
        <p>We work to keep BuildWise accurate and available, but we provide it "as is" during the beta. As far as the law allows, BuildWise is not responsible for what users list, say or do, for the goods and services they provide, or for losses from relying on concept designs, estimates or illustrative prices. Nothing in these terms takes away rights you have under consumer law that cannot be excluded.</p>
      </section>
      <section>
        <h2>10. Changes and contact</h2>
        <p>We may update these terms. We will show the new date at the top of this page, and tell signed-in users about important changes before they apply. Questions: <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> or the <Link href="/contact">contact page</Link>.</p>
      </section>
    </LegalPage>
  );
}
