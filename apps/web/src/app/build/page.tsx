import type { Metadata } from 'next';
import { BuildWizard } from '@/components/build/BuildWizard';

export const metadata: Metadata = {
  title: 'Design your building',
  description: 'Pick what to build and your plot size; BuildWise designs it to scale in 3D with drawings, systems, costs and every material with live prices.',
};

export default async function Build({ searchParams }: { searchParams: Promise<{ q?: string; type?: string; plan?: string }> }) {
  const { q, type, plan } = await searchParams;
  return <BuildWizard initialMessage={q?.trim() ? q.trim().slice(0, 500) : null} initialType={type?.slice(0, 20) ?? null} initialPlan={plan && /^[0-9a-f-]{36}$/i.test(plan) ? plan : null} />;
}
