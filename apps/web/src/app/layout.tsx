import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { SignOutButton } from '@/components/SignOutButton';
import { SITE_URL } from '@/lib/env';
import { api, getMarket, getMe } from '@/lib/server';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'BuildWise: building materials, tools, plant hire and trades', template: '%s · BuildWise' },
  description: 'Find building materials, tools, plant hire, tradespeople and professionals near you. Compare prices by unit and contact sellers directly.',
  openGraph: { siteName: 'BuildWise', type: 'website' },
};
export const viewport: Viewport = {
  width: 'device-width', initialScale: 1,
  themeColor: [{ media: '(prefers-color-scheme: light)', color: '#ffffff' }, { media: '(prefers-color-scheme: dark)', color: '#1e1b16' }],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [me, market] = await Promise.all([getMe(), getMarket()]);
  const unread = me ? (await api<{ unread: number }>('/v1/notifications?limit=1')).data?.unread ?? 0 : 0;
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">Skip to content</a>
        <header className="site-header">
          <div className="wrap">
            <Link href="/" className="brand"><span className="brand-mark" aria-hidden="true">BW</span>BuildWise</Link>
            <form action="/search" className="header-search" role="search">
              <label htmlFor="hq" className="sr-only">Search listings</label>
              <input id="hq" name="q" type="search" placeholder="Cement, blocks, a mason, a tipper…" autoComplete="off" />
              <button className="btn" type="submit">Search</button>
            </form>
            <nav className="nav" aria-label="Main">
              <Link href="/post" className="btn btn-primary btn-small">Post an ad</Link>
              {me ? (
                <>
                  <Link href="/messages">Messages</Link>
                  <Link href="/saved">Saved</Link>
                  <Link href="/my-ads">My ads</Link>
                  <Link href="/account">Account{unread > 0 && <span className="count" aria-label={`${unread} unread notifications`}>{unread}</span>}</Link>
                  {me.isStaff && <Link href="/moderation">Moderation</Link>}
                  <SignOutButton />
                </>
              ) : (
                <Link href="/sign-in">Sign in</Link>
              )}
            </nav>
          </div>
        </header>
        <main id="main"><div className="wrap">{children}</div></main>
        <footer className="site-footer">
          <div className="wrap cols">
            <div style={{ maxWidth: '32rem' }}>
              <strong>BuildWise</strong>
              <p className="small">A marketplace that connects buyers and sellers. We do not take payment for goods or services; inspect before you pay.</p>
              {market?.illustrative && <p className="small">{market.name}: places, prices and fees shown here are illustrative.</p>}
            </div>
            <nav aria-label="Help">
              <ul className="plain stack-sm small">
                <li><Link href="/help">Help</Link></li>
                <li><Link href="/help/safety">Stay safe</Link></li>
                <li><Link href="/help/selling">Selling and promotions</Link></li>
              </ul>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
