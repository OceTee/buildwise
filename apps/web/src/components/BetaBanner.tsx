'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const KEY = 'bw-beta-banner';

/** Pages where money is shown: the banner stays there, whatever the person closed elsewhere. */
export const keepsBetaBanner = (path: string) => /^\/checkout(\/|$)/.test(path) || /\/estimates(\/|$)/.test(path) || /^\/promote(\/|$)/.test(path);

/**
 * Site-wide "Public beta" strip. Closing it hides it for this browser session (sessionStorage), except on checkout,
 * promotion and estimate pages, where the illustrative-figures warning always shows.
 */
export function BetaBanner({ illustrative }: { illustrative: boolean }) {
  const path = usePathname() ?? '/';
  const [closed, setClosed] = useState(false);
  useEffect(() => { try { setClosed(sessionStorage.getItem(KEY) === 'closed'); } catch { /* storage blocked */ } }, []);
  const fixed = keepsBetaBanner(path);
  if (closed && !fixed) return null;
  const feedback = `/feedback?from=${encodeURIComponent(path)}`;
  return (
    <div role="region" aria-label="Public beta" className="beta-banner">
      <p>
        <strong>Public beta.</strong>{' '}
        {illustrative
          ? 'Prices, fees and tax figures shown here are illustrative while we use demo market data.'
          : 'Some features are still being finished.'}{' '}
        <Link href={feedback}>Send feedback</Link>
      </p>
      {!fixed && (
        <button type="button" className="beta-close" aria-label="Close the beta notice for this visit" onClick={() => { setClosed(true); try { sessionStorage.setItem(KEY, 'closed'); } catch { /* storage blocked */ } }}>
          <span aria-hidden="true">×</span>
        </button>
      )}
    </div>
  );
}
