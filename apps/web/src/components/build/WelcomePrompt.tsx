'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowUp, Home, Building2, Trees } from 'lucide-react';

const IDEAS = [
  { label: '3-bedroom bungalow', text: 'A 3-bedroom bungalow on a 50 by 100 ft plot', icon: Home },
  { label: '4-bedroom duplex', text: 'A 4-bedroom duplex with a home office on a 60 by 120 ft plot', icon: Building2 },
  { label: '2-bedroom starter home', text: 'A 2-bedroom starter home with an open-plan kitchen', icon: Trees },
];

export function WelcomePrompt() {
  const router = useRouter();
  const [text, setText] = useState('');
  const start = (message: string) => router.push(message.trim() ? `/build?q=${encodeURIComponent(message.trim().slice(0, 500))}` : '/build');
  return (
    <div className="welcome-prompt rise rise-4">
      <form className="prompt glass" onSubmit={(e) => { e.preventDefault(); start(text); }}>
        <label htmlFor="build-q" className="sr-only">Describe what you want to build</label>
        <textarea
          id="build-q" rows={2} value={text} maxLength={500} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); start(text); } }}
          placeholder="e.g. A 4-bedroom duplex on a 50 by 100 ft plot, open-plan kitchen, two parking spaces"
        />
        <div className="prompt-actions">
          <span className="small muted">Press Enter to start</span>
          <button className="btn btn-primary" type="submit" aria-label="Start building"><ArrowUp size={20} aria-hidden="true" /></button>
        </div>
      </form>
      <div className="chips" role="group" aria-label="Ideas to start from">
        {IDEAS.map(({ label, text: t, icon: Icon }) => (
          <button key={label} type="button" className="chip" onClick={() => start(t)}><Icon size={15} aria-hidden="true" />{label}</button>
        ))}
        <button type="button" className="chip" onClick={() => start('')}>Start with my land size</button>
      </div>
    </div>
  );
}
