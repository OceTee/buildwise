import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { api, getMe } from '@/lib/server';
import { TwoStep } from './TwoStep';

export const metadata: Metadata = { title: 'Two-step verification', robots: { index: false } };

interface MfaStatus { required: boolean; enrolled: boolean; verified: boolean; lockedUntil: string | null; recoveryCodesLeft: number; sessionHours: number; devCode?: string }

/** The staff second factor (§19.1): set up an authenticator app on first use, then enter a code on each new session. */
export default async function TwoStepPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/moderation';
  const me = await getMe();
  if (!me) redirect(`/sign-in?next=${encodeURIComponent(`/account/two-step?next=${safeNext}`)}`);
  if (!me.isStaff) notFound();
  const status = (await api<MfaStatus>('/v1/staff/mfa')).data;
  return (
    <div className="stack" style={{ maxWidth: '36rem' }}>
      <h1>Two-step verification</h1>
      <p className="muted" style={{ margin: 0 }}>
        Staff tools reach other people’s data, so they need a second step: a 6-digit code from an authenticator app on your phone
        (for example Google Authenticator, Microsoft Authenticator or 1Password).
      </p>
      <TwoStep enrolled={status.enrolled} verified={status.verified} required={status.required} lockedUntil={status.lockedUntil}
        recoveryCodesLeft={status.recoveryCodesLeft} devCode={status.devCode ?? null} next={safeNext} sessionHours={status.sessionHours} />
    </div>
  );
}
