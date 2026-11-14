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
    <div className="auth-shell">
      <div className="glass auth-card stack rise">
        <div>
          <span className="brand-mark" aria-hidden="true" style={{ marginBottom: '1rem' }}>BW</span>
          <h1 style={{ fontSize: '1.6rem' }}>Sign in or create an account</h1>
          <p className="muted" style={{ margin: 0 }}>We text a 6-digit code to your mobile number. No password needed.</p>
        </div>
        <SignInForm next={safeNext} callingCode={market.defaultCallingCode} />
      </div>
    </div>
  );
}
