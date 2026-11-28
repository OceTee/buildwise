import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal/Legal';
import { SUPPORT_EMAIL } from '@/lib/env';
import { getPolicies } from '@/lib/server';

export const metadata: Metadata = { title: 'Privacy notice', description: 'What BuildWise collects, why, how long we keep it, and your rights.' };

export default async function Privacy() {
  const p = await getPolicies();
  return (
    <LegalPage title="Privacy notice" intro="This notice explains what personal data BuildWise collects, why we use it, who we share it with, how long we keep it and what you can ask us to do with it.">
      <section>
        <h2>What we collect</h2>
        <div className="table-wrap"><table>
          <caption className="sr-only">Data we collect and why</caption>
          <thead><tr><th scope="col">What</th><th scope="col">Why we use it</th></tr></thead>
          <tbody>
            <tr><td><strong>Your mobile number</strong> and the name you give</td><td>To sign you in with a one-time code, to keep accounts apart, and to show sellers' numbers to signed-in buyers who ask for them (each reveal is logged and limited).</td></tr>
            <tr><td><strong>A device cookie</strong> (<code>bw_device</code>)</td><td>A random id for this browser, used only to limit abuse such as too many sign-in codes, phone reveals or feedback messages. It is not used for advertising or to follow you to other sites.</td></tr>
            <tr><td><strong>A session cookie</strong> (<code>bw_session</code>)</td><td>Keeps you signed in. You can see your devices and sign them out from <Link href="/account">Account</Link>.</td></tr>
            <tr><td><strong>Your IP address</strong></td><td>Security and abuse limits. Where we keep it for limits (for example with feedback), we keep a one-way hash of it, not the address.</td></tr>
            <tr><td><strong>Chats, quote requests, reviews and reports</strong></td><td>To deliver them to the other person, and to keep the marketplace safe: messages are checked for scam patterns and payment instructions, and moderators can read reported conversations.</td></tr>
            <tr><td><strong>Listings, photos, drawings and documents</strong> you upload</td><td>To show them to the people you choose (the public for a listing; project members for a drawing). Photos have their location and camera details removed before they are shown.</td></tr>
            <tr><td><strong>Locations</strong>: the area you choose for a listing or a search, a plot's size and town for a design, a delivery site for an order</td><td>To show nearby sellers, to design for your plot and to arrange deliveries. We do not track your device's location.</td></tr>
            <tr><td><strong>Build assistant messages</strong></td><td>To answer you and to improve the assistant. Phone numbers and email addresses are removed before a message is stored, and it is stored against an anonymous session code, not your account.</td></tr>
            <tr><td><strong>Feedback and bug reports</strong></td><td>To fix problems and improve BuildWise. Contact details in the message are removed; we keep a reply address only if you tick "you may contact me".</td></tr>
            <tr><td><strong>Business and professional details</strong> you give for checks</td><td>To run the checks you ask for and show their results. We keep the result and delete the evidence after the period below.</td></tr>
          </tbody>
        </table></div>
        <p>We do not collect card details: promotion payments go through the payment provider's own checkout page.</p>
      </section>
      <section>
        <h2>AI services</h2>
        <p>Some features send data to AI providers that work for us:</p>
        <ul>
          <li><strong>Google Gemini</strong> (free tier) reads build assistant and Builder AI chat messages <strong>after phone numbers and email addresses are removed</strong>, together with the plot and design figures. Under Google's free-tier terms, Google may use these prompts and answers to improve its products, so please do not type personal details into the assistant.</li>
          <li><strong>Anthropic (Claude)</strong> and, when connected, <strong>OpenAI</strong> receive plot and design figures and pictures of the 3D design to compose designs and pictures. They are not sent your name or number.</li>
        </ul>
        <p>No AI service decides anything about you: AI suggestions are labelled and you choose what to keep.</p>
      </section>
      <section>
        <h2>Who else sees your data</h2>
        <ul>
          <li><strong>Other users</strong> see what you choose to publish: your listings, storefront, reviews and the name you give. Sellers' phone numbers are shown only to signed-in users who ask, and each reveal is logged.</li>
          <li><strong>Project members</strong> you invite see that project's documents, estimates, requests for quotes and orders; invited suppliers see only what is sent to them.</li>
          <li><strong>Service providers</strong> that run BuildWise for us: hosting and database (Vercel, Neon), file storage, text message and email delivery, the payment provider for promotions, and the AI services above. They may only use the data to provide their service to us, except as stated for Google's free tier.</li>
          <li><strong>Authorities</strong>, when the law requires it, or to protect someone from harm or fraud.</li>
        </ul>
        <p>We do not sell personal data and we do not show third-party advertising based on it. Some providers store data outside the country you live in; we are confirming the safeguards for those transfers as part of the legal review.</p>
      </section>
      <section>
        <h2>How long we keep it</h2>
        <p>These are our proposed retention periods. Deleted accounts, deleted users' chats, phone-number reveals and old sign-in sessions are cleared automatically; the other deletions are still being automated during the beta. A report, a case or a legal hold can keep a record longer.</p>
        <div className="table-wrap"><table>
          <caption className="sr-only">Retention periods</caption>
          <thead><tr><th scope="col">Record</th><th scope="col">How long</th></tr></thead>
          <tbody>
            {p.retention.map((r) => (
              <tr key={r.record}><td>{r.record}</td><td>{r.period}{r.note && <span className="small muted"> {r.note}</span>}</td></tr>
            ))}
          </tbody>
        </table></div>
      </section>
      <section>
        <h2>Your rights</h2>
        <ul>
          <li><strong>See and export</strong> your data: use “Download my data” in <Link href="/account">Account</Link> (up to {p.privacy.exportPerDay} times a day; the download link works for {p.privacy.exportLinkMinutes} minutes). Project owners can also download their project documents from the project.</li>
          <li><strong>Correct</strong> it: change your name or mobile number from <Link href="/account">Account</Link>, edit your listings from <Link href="/my-ads">My ads</Link>, or ask us.</li>
          <li><strong>Delete</strong> it: delete your account from <Link href="/account">Account</Link>. Your listings close, your name, number and email are removed from the account at once and erased completely after {p.privacy.deletedAccountDays} days, and people you chatted with see “Deleted user”. Some records must be kept for the periods above and are then deleted: {p.privacy.retainedAfterDeletion.map((x) => x.replace(/\s*\(.*\)\.?$/, '').replace(/\.$/, '').toLowerCase()).join('; ')}.</li>
          <li><strong>Object or withdraw consent</strong>, for example to us contacting you about feedback.</li>
          <li><strong>Complain</strong> to us first, and to the data protection authority where you live (in Nigeria, the Nigeria Data Protection Commission).</li>
        </ul>
        <p>Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from the contact on your account, or use the <Link href="/contact">contact page</Link>. We may ask you to confirm it is you before we act.</p>
      </section>
      <section>
        <h2>Security</h2>
        <p>Data is sent over encrypted connections, sign-in codes expire quickly, project data is separated per project at the database level, and staff access to private projects is time-limited and recorded. Tell us at once if you think your account has been misused.</p>
      </section>
      <section>
        <h2>Cookies</h2>
        <p>We use only essential cookies. See the <Link href="/cookies">cookie notice</Link>.</p>
      </section>
    </LegalPage>
  );
}
