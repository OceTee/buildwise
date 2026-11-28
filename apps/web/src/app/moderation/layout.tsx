import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { staffCan } from '@bw/domain';
import { getMe } from '@/lib/server';

export const metadata = { robots: { index: false } };

export default async function ModerationLayout({ children }: { children: React.ReactNode }) {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=/moderation');
  if (!me.isStaff) notFound();
  // Staff tools need the second factor on this session (§19.1).
  if (me.staffMfa === 'needs_code' || me.staffMfa === 'needs_enrolment') redirect('/account/two-step?next=/moderation');
  const can = (area: Parameters<typeof staffCan>[1]) => staffCan(me.staffRole, area);
  return (
    <div className="stack">
      <nav aria-label="Moderation" className="inline">
        {can('moderation') && <>
          <Link className="btn btn-small" href="/moderation">Listing queue</Link>
          <Link className="btn btn-small" href="/moderation/reports">Reports</Link>
          <Link className="btn btn-small" href="/moderation/appeals">Appeals</Link>
          <Link className="btn btn-small" href="/moderation/held">Held messages and reviews</Link>
        </>}
        {can('cases') && <Link className="btn btn-small" href="/moderation/cases">Cases</Link>}
        {can('marketplace') && <Link className="btn btn-small" href="/moderation/liquidity">Liquidity</Link>}
        {can('feedback') && <Link className="btn btn-small" href="/moderation/feedback">Feedback</Link>}
        {can('estimateReview') && <Link className="btn btn-small" href="/moderation/review">Estimate reviews</Link>}
        {can('estimateReview') && <Link className="btn btn-small" href="/moderation/catalog">Catalog and rates</Link>}
        {can('admin') && <Link className="btn btn-small" href="/moderation/reviewers">Reviewers</Link>}
        {can('assistant') && <Link className="btn btn-small" href="/moderation/assistant">Assistant</Link>}
        {can('projectAccess') && <Link className="btn btn-small" href="/moderation/project-access">Project access</Link>}
        {can('audit') && <Link className="btn btn-small" href="/moderation/audit">Audit log</Link>}
        {can('admin') && <Link className="btn btn-small" href="/moderation/categories">Categories</Link>}
        {can('admin') && <Link className="btn btn-small" href="/moderation/staff">Staff roles</Link>}
      </nav>
      {children}
    </div>
  );
}
