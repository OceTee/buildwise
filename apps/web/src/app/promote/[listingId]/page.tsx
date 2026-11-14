import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { api, getMe } from '@/lib/server';
import { PromoteForm } from './PromoteForm';

export const metadata: Metadata = { title: 'Promote your ad', robots: { index: false } };

export default async function Promote({ params }: { params: Promise<{ listingId: string }> }) {
  const { listingId } = await params;
  if (!(await getMe())) redirect(`/sign-in?next=/promote/${listingId}`);
  const [l, products, mine] = await Promise.all([api<any>(`/v1/listings/${listingId}`), api<{ items: any[] }>('/v1/promotions/products'), api<{ credits: any[] }>('/v1/my/promotions')]);
  if (l.status !== 200) notFound();
  return (
    <div className="stack" style={{ maxWidth: '44rem' }}>
      <h1>Promote “{l.data.title}”</h1>
      <p className="muted">Promoted ads are labelled and only shown in searches they match. Promotion never affects review.</p>
      <PromoteForm listingId={listingId} products={products.data.items} credits={mine.data.credits} />
    </div>
  );
}
