import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getMarket, getMe } from '@/lib/server';
import { SignInForm } from './SignInForm';

export const metadata: Metadata = { title: 'Sign in', robots: { index: false } };

export default async function SignIn({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  if (await getMe()) redirect(safeNext);
  const market = await getMarket();
  return (
    <div style={{ maxWidth: '28rem' }} className="stack">
      <h1>Sign in or create an account</h1>
      <p className="muted">We text a 6-digit code to your mobile number. No password needed.</p>
      <SignInForm next={safeNext} callingCode={market.defaultCallingCode} />
    </div>
  );
}
