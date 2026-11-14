import type { Metadata } from 'next';
import { StaffAccessForm } from '@/components/projects/ProjectControls';

export const metadata: Metadata = { title: 'Project access' };

/** Reason-coded, time-boxed staff access to a customer project (§7.6). */
export default function ProjectAccess() {
  return (
    <div className="stack" style={{ maxWidth: '40rem' }}>
      <h1>Open a customer project</h1>
      <p className="muted">Staff never have standing access to projects. Give the ticket or case that requires it.</p>
      <StaffAccessForm />
    </div>
  );
}
