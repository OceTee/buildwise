'use client';
import { useState } from 'react';
import { call, errorText } from '@/lib/client';

export function SaveSearchButton({ query }: { query: Record<string, string | undefined> }) {
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  const clean = Object.fromEntries(Object.entries(query).filter(([k, v]) => v && k !== 'page'));
  const label = [clean.q, clean.category, clean.area].filter(Boolean).join(' · ') || 'All listings';
  async function save() {
    setState('saving'); setError('');
    try { await call('/v1/saved-searches', { body: { label: label.slice(0, 80), query: clean, frequency: 'daily' } }); setState('saved'); }
    catch (e) { setError(errorText(e)); setState('idle'); }
  }
  return (
    <span className="inline">
      <button type="button" className="btn btn-small" onClick={save} disabled={state !== 'idle'}>{state === 'saved' ? 'Search saved' : 'Save search'}</button>
      <span role="status" className="small muted">{state === 'saved' ? 'We will tell you about new matches daily.' : error}</span>
    </span>
  );
}
