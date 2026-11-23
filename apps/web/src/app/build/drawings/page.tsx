import type { Metadata } from 'next';
import { DrawingsView } from '@/components/build/DrawingsView';

export const metadata: Metadata = {
  title: 'Concept drawings',
  description: 'Site plan, floor plans, elevations and a section for your chosen design, ready to print or save as PDF.',
  robots: { index: false },
};

export default function Drawings() {
  return <DrawingsView />;
}
