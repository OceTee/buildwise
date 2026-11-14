'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { call, errorText } from '@/lib/client';

export function UnsaveButton({ id }: { id: string }) {
  const router = useRouter();
  return <button type="button" className="btn btn-small" onClick={async () => { await call(`/v1/favourites/${id}`, { method: 'PUT', body: { saved: false } }); router.refresh(); }}>Remove</button>;
}

export function SavedSearchRow({ s }: { s: { id: string; label: string; query: Record<string, string>; frequency: string } }) {
  const router = useRouter();
  const [error, setError] = useState('');
  const qs = new URLSearchParams(Object.entries(s.query ?? {}).filter(([, v]) => v)).toString();
  return (
    <div className="card inline" style={{ justifyContent: 'space-between' }}>
      <div><Link href={`/search?${qs}`}>{s.label}</Link></div>
      <div className="inline">
        <label htmlFor={`fq-${s.id}`} className="sr-only">Alerts for {s.label}</label>
        <select id={`fq-${s.id}`} defaultValue={s.frequency} style={{ width: 'auto' }} onChange={async (e) => { try { await call(`/v1/saved-searches/${s.id}`, { method: 'PATCH', body: { frequency: e.target.value } }); } catch (x) { setError(errorText(x)); } }}>
          <option value="instant">Alert me straight away</option>
          <option value="daily">Daily summary</option>
          <option value="off">No alerts</option>
        </select>
        <button type="button" className="btn btn-small" onClick={async () => { await call(`/v1/saved-searches/${s.id}`, { method: 'DELETE' }); router.refresh(); }}>Delete</button>
      </div>
      {error && <p role="alert" className="small">{error}</p>}
    </div>
  );
}
