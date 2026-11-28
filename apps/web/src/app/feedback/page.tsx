import type { Metadata } from 'next';
import Link from 'next/link';
import { FeedbackForm } from '@/components/FeedbackForm';
import { getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Send feedback', description: 'Tell BuildWise what is not working or what you would like to see.', robots: { index: false } };

/** Only a path on this site counts as "the page it was about"; anything else is ignored. */
function pathOf(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (!s || !s.startsWith('/') || s.startsWith('//')) return null;
  return s.slice(0, 300);
}

export default async function Feedback({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [me, sp] = await Promise.all([getMe(), searchParams]);
  return (
    <article className="stack" style={{ maxWidth: '40rem' }}>
      <h1>Send feedback</h1>
      <p className="lede-sm">BuildWise is in a public beta. Tell us what is not working, what is confusing or what you would like to see. For a problem with a listing or a person, use “Report” on it instead; for anything else, see <Link href="/contact">contact and support</Link>.</p>
      <FeedbackForm signedIn={!!me} from={pathOf(sp.from)} />
    </article>
  );
}
