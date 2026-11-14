import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { ListingForm } from '@/components/ListingForm';
import { api, getCategories, getMarket, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Edit ad', robots: { index: false } };

export default async function Edit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await getMe();
  if (!me) redirect(`/sign-in?next=/my-ads/${id}/edit`);
  const [r, categories, market] = await Promise.all([api<any>(`/v1/listings/${id}`), getCategories(), getMarket()]);
  if (r.status !== 200) notFound();
  const l = r.data;
  if (l.status === 'blocked') redirect('/my-ads');
  return (
    <div style={{ maxWidth: '48rem' }}>
      <h1>Edit ad</h1>
      {l.status === 'live' && <p className="notice small">Changing the title, category, photos or price by a lot sends the ad back for review. Small edits stay live.</p>}
      <ListingForm categories={categories as any} orgs={[]} regions={market.regions} initial={{
        id: l.id, version: l.version, status: l.status, categorySlug: l.categorySlug, title: l.title, description: l.description, attributes: l.attributes ?? {},
        price: l.price, unit: l.unit, negotiable: l.negotiable, quoteOnRequest: l.quoteOnRequest, areaCode: l.areaCode, serviceAreas: l.serviceAreas ?? [], photos: l.photos ?? [],
      }} />
    </div>
  );
}
