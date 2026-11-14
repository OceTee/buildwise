import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { api, getMe } from '@/lib/server';
import { Thread } from './Thread';

export const metadata: Metadata = { title: 'Conversation', robots: { index: false } };

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getMe())) redirect(`/sign-in?next=/messages/${id}`);
  const r = await api<any>(`/v1/threads/${id}`);
  if (r.status !== 200) notFound();
  const eligibility = r.data.role === 'buyer' ? (await api<{ eligible: boolean; reason: string | null }>(`/v1/sellers/${r.data.listing.sellerOrgId}/review-eligibility`)).data : null;
  return <Thread initial={r.data} reviewEligible={!!eligibility?.eligible} />;
}
