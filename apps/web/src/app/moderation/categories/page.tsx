import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { api, getMe } from '@/lib/server';
import { CategoryVersion } from '../ModControls';

export const metadata: Metadata = { title: 'Categories' };

/** Category configuration is versioned data, not code (spec §3.3). Only operations admins publish versions. */
export default async function Categories() {
  const me = await getMe();
  if (me?.staffRole !== 'ops_admin') notFound();
  const cats = (await api<{ items: any[] }>('/v1/admin/categories')).data.items;
  return (
    <>
      <h1>Categories</h1>
      <p className="small muted">Publishing a version applies to new and edited listings. Live listings keep the version they were created with.</p>
      <ul className="plain stack">
        {cats.map((c) => (
          <li key={c.slug} className="card">
            <details>
              <summary><strong>{c.name}</strong> <span className="small muted">{c.slug}{c.parent ? ` · in ${c.parent}` : ''} · version {c.version}</span></summary>
              <CategoryVersion slug={c.slug} definition={c.definition} />
            </details>
          </li>
        ))}
      </ul>
    </>
  );
}
