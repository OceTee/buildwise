import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { getMe } from '@/lib/server';

export const metadata = { robots: { index: false } };

export default async function ModerationLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=/moderation');
  if (!me.isStaff) notFound();
  return (
    <div className="stack">
      <nav aria-label="Moderation" className="inline">
        {me.staffRole !== 'qs_reviewer' && <>
          <Link className="btn btn-small" href="/moderation">Listing queue</Link>
          <Link className="btn btn-small" href="/moderation/reports">Reports</Link>
          <Link className="btn btn-small" href="/moderation/appeals">Appeals</Link>
          <Link className="btn btn-small" href="/moderation/held">Held messages and reviews</Link>
        </>}
        {(me.staffRole === 'qs_reviewer' || me.staffRole === 'ops_admin') && <Link className="btn btn-small" href="/moderation/review">Estimate reviews</Link>}
        {(me.staffRole === 'qs_reviewer' || me.staffRole === 'ops_admin') && <Link className="btn btn-small" href="/moderation/catalog">Catalog and rates</Link>}
        {me.staffRole === 'ops_admin' && <Link className="btn btn-small" href="/moderation/reviewers">Reviewers</Link>}
        {me.staffRole !== 'qs_reviewer' && <Link className="btn btn-small" href="/moderation/assistant">Assistant</Link>}
        <Link className="btn btn-small" href="/moderation/project-access">Project access</Link>
        <Link className="btn btn-small" href="/moderation/audit">Audit log</Link>
        {me.staffRole === 'ops_admin' && <Link className="btn btn-small" href="/moderation/categories">Categories</Link>}
      </nav>
      {children}
    </div>
  );
}
