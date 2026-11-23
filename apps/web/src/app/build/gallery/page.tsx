import type { Metadata } from 'next';
import { Gallery } from '@/components/build/Gallery';

export const metadata: Metadata = {
  title: 'Design engine gallery',
  description: 'Every design BuildWise’s own engine makes for one brief, side by side.',
  robots: { index: false },
};

export default function GalleryPage() {
  return <Gallery />;
}
