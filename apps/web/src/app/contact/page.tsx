import type { Metadata } from 'next';
import Link from 'next/link';
import { LegalPage } from '@/components/legal/Legal';
import { SUPPORT_EMAIL } from '@/lib/env';

export const metadata: Metadata = { title: 'Contact and support', description: 'How to reach BuildWise: help, reports, privacy requests and feedback.' };

export default function Contact() {
  return (
    <LegalPage title="Contact and support" intro="We are a small team running a public beta. Here is the quickest way to reach us for each kind of question.">
      <section>
        <h2>Something is not working, or you have an idea</h2>
        <p><Link className="btn btn-primary" href="/feedback">Send feedback</Link></p>
        <p className="small muted">Say what you were doing and what went wrong. We read every message.</p>
      </section>
      <section>
        <h2>A listing, seller, message or review looks wrong</h2>
        <p>Use “Report” on it. Reports of scams, impersonation and unsafe work are reviewed first. Read <Link href="/help/safety">how to stay safe</Link>.</p>
      </section>
      <section>
        <h2>A problem with an order or a delivery</h2>
        <p>Open the order in your project or your quotes, and raise a discrepancy or a case there, so the other side and our staff see the same record.</p>
      </section>
      <section>
        <h2>Your account, your data or anything else</h2>
        <p>Email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. For a privacy request (a copy, a correction or a deletion) write from, or tell us, the mobile number on your account. Never send us a sign-in code: we will never ask for one.</p>
        <p className="small muted">We aim to reply within two working days during the beta.</p>
      </section>
      <section>
        <h2>Emergencies</h2>
        <p>If anyone is in danger, for example from a collapsing structure, call the local emergency services first. BuildWise cannot send help.</p>
      </section>
    </LegalPage>
  );
}
