import Link from 'next/link';

/** The date the public-beta legal drafts were last changed. Change it with any edit to their text. */
export const LEGAL_UPDATED = '2026-11-27';
const updatedLabel = new Date(`${LEGAL_UPDATED}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** Every legal page opens with this: the text is a draft and has not been reviewed by a lawyer yet. */
export function DraftNotice() {
  return (
    <p className="notice notice-warn small" role="note">
      <strong>Draft for the public beta, pending legal review.</strong> Last updated <time dateTime={LEGAL_UPDATED}>{updatedLabel}</time>. This text may change before launch; we will say so on this page when it does.
    </p>
  );
}

export function LegalPage({ title, intro, children }: { title: string; intro?: React.ReactNode; children: React.ReactNode }) {
  return (
    <article className="stack legal" style={{ maxWidth: '46rem' }}>
      <h1>{title}</h1>
      <DraftNotice />
      {intro && <p className="lede-sm">{intro}</p>}
      {children}
      <nav aria-label="Other policies" className="small">
        <Link href="/terms">Terms of use</Link> · <Link href="/privacy">Privacy notice</Link> · <Link href="/cookies">Cookies</Link> · <Link href="/help/posting-rules">Posting rules</Link> · <Link href="/help/prohibited-items">Prohibited and restricted items</Link> · <Link href="/contact">Contact and support</Link>
      </nav>
    </article>
  );
}
