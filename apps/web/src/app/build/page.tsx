import type { Metadata } from 'next';
import { BuildWizard } from '@/components/build/BuildWizard';

export const metadata: Metadata = {
  title: 'Design your home',
  description: 'Enter your land size, see your plot in 3D, choose a design that fits, and get every material you need with live prices.',
};

export default async function Build({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  return <BuildWizard initialMessage={q?.trim() ? q.trim().slice(0, 500) : null} />;
}
