'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { BUILDING_FAMILIES, BUILDING_TYPES, BUILDING_TYPE_KEYS, type BuildingFamily } from '@bw/domain';
import { TYPE_ICON } from './CreateSteps';

/** The front door: pick what to build (no prompting needed), or describe it in a sentence. */
export function WelcomePrompt() {
  const router = useRouter();
  const [text, setText] = useState('');
  const start = (message: string) => router.push(message.trim() ? `/build?q=${encodeURIComponent(message.trim().slice(0, 500))}` : '/build');
  return (
    <div className="welcome-prompt rise rise-4">
      <div className="welcome-types">
        {(Object.keys(BUILDING_FAMILIES) as BuildingFamily[]).map((f) => (
          <section key={f} aria-labelledby={`fam-${f}`} className="welcome-family">
            <h2 id={`fam-${f}`} className="kicker">{BUILDING_FAMILIES[f].label}</h2>
            <ul className="plain welcome-type-list">
              {BUILDING_TYPE_KEYS.filter((t) => BUILDING_TYPES[t].family === f).map((t) => {
                const Icon = TYPE_ICON[t];
                return (
                  <li key={t}>
                    <Link className="welcome-type glass" href={`/build?type=${t}`}>
                      <Icon size={20} aria-hidden="true" /><span>{BUILDING_TYPES[t].label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
      <form className="prompt glass" onSubmit={(e) => { e.preventDefault(); start(text); }}>
        <label htmlFor="build-q" className="sr-only">Or describe what you want to build</label>
        <textarea
          id="build-q" rows={1} value={text} maxLength={500} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(text); } }}
          placeholder="Or describe it: a 4-storey hotel with 40 rooms on a 100 by 120 ft plot"
        />
        <div className="prompt-actions">
          <span className="small muted">Optional</span>
          <button className="btn btn-primary" type="submit" aria-label="Start from my description" disabled={!text.trim()}><ArrowUp size={20} aria-hidden="true" /></button>
        </div>
      </form>
    </div>
  );
}
