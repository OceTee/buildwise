import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { ListingForm } from '@/components/ListingForm';
import { getCategories, getMarket, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Post an ad', robots: { index: false } };

export default async function Post() {
  const me = await getMe();
  if (!me) redirect('/sign-in?next=/post');
  const [categories, market] = await Promise.all([getCategories(), getMarket()]);
  const orgs = me.organizations.filter((o) => ['owner', 'admin', 'member'].includes(o.role));
  return (
    <div style={{ maxWidth: '48rem' }}>
      <h1>Post an ad</h1>
      <p className="muted">Free to post. Your ad is checked before it goes live.</p>
      <ListingForm categories={categories as any} orgs={orgs} regions={market.regions} />
    </div>
  );
}
