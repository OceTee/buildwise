import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal/Legal';

export const metadata: Metadata = { title: 'Cookies', description: 'The cookies and browser storage BuildWise uses.' };

const COOKIES = [
  { name: 'bw_device', what: 'A random id for this browser, used only to limit abuse (sign-in codes, phone reveals, feedback).', lasts: '2 years' },
  { name: 'bw_session', what: 'Keeps you signed in. Only set when you sign in.', lasts: '30 days, or until you sign out' },
  { name: 'bw-theme', what: 'Remembers light or dark mode, only if you choose one.', lasts: '1 year' },
];
const STORAGE = [
  { name: 'bw-build-v1', what: 'Your build: plot, choices, designs and edits, so you can come back to them. It stays in your browser.' },
  { name: 'bw:draft:new-listing', what: 'An unsent listing draft, so you do not lose it.' },
  { name: 'bw-beta-banner', what: 'Hides the public beta banner for this browser session after you close it.' },
];

export default function Cookies() {
  return (
    <LegalPage title="Cookies" intro="BuildWise uses only essential cookies: the ones needed to sign you in, keep the site safe and remember a choice you made. We do not use advertising or tracking cookies, so we do not ask for consent; if that ever changes, we will ask first.">
      <section>
        <h2>Cookies</h2>
        <div className="table-wrap"><table>
          <caption className="sr-only">Cookies BuildWise sets</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">What it does</th><th scope="col">How long</th></tr></thead>
          <tbody>{COOKIES.map((c) => <tr key={c.name}><td><code>{c.name}</code></td><td>{c.what}</td><td>{c.lasts}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section>
        <h2>Browser storage</h2>
        <p>Some pages also keep things in your browser's own storage. It is never sent to us unless you send it (for example by asking for a design).</p>
        <div className="table-wrap"><table>
          <caption className="sr-only">Browser storage BuildWise uses</caption>
          <thead><tr><th scope="col">Name</th><th scope="col">What it holds</th></tr></thead>
          <tbody>{STORAGE.map((c) => <tr key={c.name}><td><code>{c.name}</code></td><td>{c.what}</td></tr>)}</tbody>
        </table></div>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>You can delete cookies and site data in your browser's settings. If you block <code>bw_session</code> you cannot sign in; if you clear browser storage you lose builds and drafts kept there. More in the <Link href="/privacy">privacy notice</Link>.</p>
      </section>
    </LegalPage>
  );
}
