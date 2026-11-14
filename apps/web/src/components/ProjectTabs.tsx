'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function ProjectTabs({ tabs }: { tabs: { href: string; label: string }[] }) {
  const path = usePathname();
  const active = (href: string) => (href.split('/').length === 3 ? path === href : path.startsWith(href));
  return (
    <nav aria-label="Project sections" className="tabs">
      {tabs.map((t) => <Link key={t.href} href={t.href} aria-current={active(t.href) ? 'page' : undefined}>{t.label}</Link>)}
    </nav>
  );
}
