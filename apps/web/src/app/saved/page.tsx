import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { priceText } from '@/lib/format';
import { api, getMe } from '@/lib/server';
import { SavedSearchRow, UnsaveButton } from './SavedControls';

export const metadata: Metadata = { title: 'Saved', robots: { index: false } };

export default async function Saved() {
  if (!(await getMe())) redirect('/sign-in?next=/saved');
  const [favs, searches] = await Promise.all([api<{ items: any[] }>('/v1/favourites'), api<{ items: any[] }>('/v1/saved-searches')]);
  return (
    <div className="stack" style={{ maxWidth: '50rem' }}>
      <h1>Saved</h1>
      <section aria-labelledby="fav-h">
        <h2 id="fav-h">Saved listings</h2>
        {favs.data.items.length === 0 ? <p className="muted">Use “Save” on a listing to keep it here.</p> : (
          <ul className="plain card" style={{ padding: 0 }}>
            {favs.data.items.map((f) => (
              <li key={f.id} className="inline" style={{ justifyContent: 'space-between', padding: '.75rem 1rem', borderBottom: '1px solid var(--border)' }}>
                <div>
                  {f.available ? <Link href={f.path}>{f.title}</Link> : <span>{f.title} <span className="pill">No longer available</span></span>}
                  <div className="small muted">{priceText(f)}</div>
                </div>
                <UnsaveButton id={f.id} />
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="ss-h">
        <h2 id="ss-h">Saved searches</h2>
        {searches.data.items.length === 0 ? <p className="muted">Save a search from the results page to get alerts for new listings.</p> : (
          <ul className="plain stack-sm">{searches.data.items.map((s) => <li key={s.id}><SavedSearchRow s={s} /></li>)}</ul>
        )}
      </section>
    </div>
  );
}
