import type { Metadata } from 'next';
import { Studio } from '@/components/studio/Studio';

export const metadata: Metadata = {
  title: 'Design Studio',
  description: 'Edit your building room by room in 2D and 3D: walls, wings, storeys, porches, balconies and materials. Certified architects can publish their designs for sale.',
};

export default function StudioPage() {
  return <Studio />;
}
