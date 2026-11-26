import type { Metadata, Viewport } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import Link from 'next/link';
import { cookies } from 'next/headers';
import { Search } from 'lucide-react';
import { SignOutButton } from '@/components/SignOutButton';
import { ThemeToggle } from '@/components/ThemeToggle';
import { THEME_COOKIE } from '@/lib/theme';
import { SITE_URL } from '@/lib/env';
import { api, getMarket, getMe } from '@/lib/server';
import './globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist', display: 'swap' });
const geistMono = Geist_Mono({ subsets: ['latin'], variable: '--font-geist-mono', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'BuildWise: building materials, tools, plant hire and trades', template: '%s · BuildWise' },
  description: 'Find building materials, tools, plant hire, tradespeople and professionals near you. Compare prices by unit and contact sellers directly.',
  openGraph: { siteName: 'BuildWise', type: 'website' },
};
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#fafaf9' }, { media: '(prefers-color-scheme: dark)', color: '#09090b' }],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [me, market, jar] = await Promise.all([getMe(), getMarket(), cookies()]);
  const chosen = jar.get(THEME_COOKIE)?.value;
  const theme = chosen === 'light' || chosen === 'dark' ? chosen : undefined;
  const unread = me ? (await api<{ unread: number }>('/v1/notifications?limit=1')).data?.unread ?? 0 : 0;
  return (
    <html lang="en" className={`${geist.variable} ${geistMono.variable}`} data-theme={theme} suppressHydrationWarning>
      <body>

        <a className="skip" href="#main">Skip to content</a>
        {process.env.APP_ENV === 'staging' && (
          <div role="note" className="staging-note">Staging site: sign-in codes are shown on screen, payments are simulated, and data may be reset.</div>
        )}
        <header className="site-header glass">
          <div className="wrap">
            <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">BW</span>BuildWise</Link>
            <form action="/search" className="header-search" role="search">
              <label htmlFor="hq" className="sr-only">Search listings</label>
              <Search size={16} aria-hidden="true" />
              <input id="hq" name="q" type="search" placeholder="Cement, blocks, a mason, a tipper…" autoComplete="off" />
              <button className="btn btn-small" type="submit">Search</button>
            </form>
            <nav className="nav" aria-label="Main">
              <Link href="/build">Build</Link>
              <Link href="/market">Marketplace</Link>
              {me ? (
                <>
                  <Link href="/projects">Projects</Link>
                  <Link href="/messages">Messages</Link>
                  <Link href="/saved">Saved</Link>
                  <Link href="/my-ads">My ads</Link>
                  <Link href="/provider/rfqs">Quotes</Link>
                  <Link href="/account">Account{unread > 0 && <span className="count" aria-label={`${unread} unread notifications`}>{unread}</span>}</Link>
                  {me.isStaff && <Link href={me.staffRole === 'qs_reviewer' ? '/moderation/review' : '/moderation'}>Staff</Link>}
                </>
              ) : (
                <Link href="/sign-in">Sign in</Link>
              )}
              <ThemeToggle />
              {me && <SignOutButton />}
              <Link href="/post" className="btn btn-primary btn-small">Post an ad</Link>
            </nav>
          </div>
        </header>
        <main id="main"><div className="wrap">{children}</div></main>
        <footer className="site-footer">
          <div className="wrap cols">
            <div style={{ maxWidth: '30rem' }}>
              <Link href="/" className="brand" style={{ marginBottom: '.8rem' }}><span className="brand-mark" aria-hidden="true">BW</span>BuildWise</Link>
              <p className="small">A marketplace and project workspace for building. We connect buyers and sellers and never take payment for goods or services, so inspect before you pay.</p>
              {market?.illustrative && <p className="small">{market.name}: places, prices and fees shown here are illustrative.</p>}
            </div>
            <nav aria-labelledby="f-market">
              <h2 id="f-market">Marketplace</h2>
              <ul className="plain stack-sm">
                <li><Link href="/search?sort=newest">Just listed</Link></li>
                <li><Link href="/post">Post an ad</Link></li>
                <li><Link href="/help/selling">Selling and promotions</Link></li>
              </ul>
            </nav>
            <nav aria-labelledby="f-help">
              <h2 id="f-help">Help</h2>
              <ul className="plain stack-sm">
                <li><Link href="/build">Design your home</Link></li>
                <li><Link href="/projects">Projects and estimates</Link></li>
                <li><Link href="/help">Help</Link></li>
                <li><Link href="/help/safety">Stay safe</Link></li>
              </ul>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
