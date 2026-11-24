'use client';

import { useState } from 'react';
import { call } from '@/lib/client';

export interface SourceReview {
  sourceStatus: 'unavailable' | 'not_configured' | 'discovered';
  scope?: 'global' | 'local';
  candidates?: { title: string; url: string; host: string; excerpt: string | null }[];
}

export function LocalRequirements({ discovered, type, taste }: { discovered?: SourceReview; type: string; taste: string | null }) {
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<SourceReview | null>(null);
  const shown = review ?? discovered;
  const check = async () => {
    setBusy(true);
    try {
      setReview(await call<SourceReview>(`/v1/build/sources?${new URLSearchParams({
        type, ...(taste ? { taste } : {}),
      })}`));
    } catch {
      setReview({ sourceStatus: 'unavailable' });
    } finally {
      setBusy(false);
    }
  };

  return <section className="stack-sm card" aria-labelledby="local-requirements">
    <h2 id="local-requirements" className="h-sub">Worldwide design references</h2>
    <p className="small">BuildWise checks concept geometry. Site fit and local approvals are assessed separately.</p>
    <button className="btn" type="button" disabled={busy} onClick={() => void check()}>
      {busy ? 'Looking up planning sources…' : 'Look up planning sources'}
    </button>
    <div aria-live="polite">
      {shown?.sourceStatus === 'not_configured' && <p className="small">Global planning search needs an API key on the BuildWise server.</p>}
      {shown?.sourceStatus === 'discovered' && <>
        <p className="small">{shown.candidates?.length
          ? 'Architectural precedents for the brief.'
          : 'No references found for this brief.'}</p>
        <ul>{shown.candidates?.map((candidate) => <li key={candidate.url}>
          <a href={candidate.url} target="_blank" rel="noreferrer">{candidate.title}</a> <span className="muted">{candidate.host}</span>
          {candidate.excerpt && <p className="small muted">{candidate.excerpt}</p>}
        </li>)}</ul>
      </>}
      {shown?.sourceStatus === 'unavailable' && <p className="small">The official guidance could not be checked. Try again later.</p>}
    </div>
  </section>;
}
