'use client';
import { useEffect, useRef, useState } from 'react';
import { Bot, Send, ThumbsDown, ThumbsUp } from 'lucide-react';

export interface Chat { from: 'you' | 'assistant'; text: string; messageId?: string; helpful?: boolean; source?: 'ai' | 'local' }

/** Light formatting for replies: paragraphs, "- " bullet lists and **bold**. No HTML is ever injected. */
function Formatted({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  const inline = (s: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : part));
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n').filter((l) => l.trim());
        if (lines.length && lines.every((l) => /^\s*([-*•]|\d+\.)\s+/.test(l))) {
          return <ul key={i}>{lines.map((l, j) => <li key={j}>{inline(l.replace(/^\s*([-*•]|\d+\.)\s+/, ''))}</li>)}</ul>;
        }
        return <p key={i}>{lines.map((l, j) => <span key={j}>{j > 0 && <br />}{inline(l.replace(/^#+\s*/, ''))}</span>)}</p>;
      })}
    </>
  );
}

/**
 * Questions only: the Builder AI explains the design, the numbers and what to do next. It never changes the design;
 * BuildWise does the designing. With Claude connected it reasons across the whole project and uses BuildWise's
 * calculators; otherwise BuildWise's own assistant answers. Replies can be rated, which teaches the local model.
 */
export function ChatPanel({ chat, busy, ask, rate, aiOn, placeholder, suggestions = [] }: {
  chat: Chat[]; busy: boolean; ask: (m: string) => Promise<unknown>; rate: (id: string, helpful: boolean) => void; aiOn: boolean; placeholder: string;
  /** Ready-made questions shown before the first message. */
  suggestions?: string[];
}) {
  const [msg, setMsg] = useState('');
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight }); }, [chat.length, busy]);
  return (
    <section className="assistant card" aria-labelledby="ai-h">
      <div className="assistant-head">
        <h2 id="ai-h" className="h-sub"><Bot size={16} aria-hidden="true" /> Ask the Builder AI</h2>
        <span className={`tag${aiOn ? ' on' : ''}`}>{aiOn ? 'Claude · knows your whole project' : 'BuildWise assistant'}</span>
      </div>
      <div className="assistant-log" ref={log} aria-live="polite">
        {chat.length === 0 && (
          <>
            <p className="muted small">Ask anything about your building: why it is laid out this way, what a number includes, what it will cost to run, what to watch out for, who to hire next. BuildWise does the designing; use the controls to change it.</p>
            {suggestions.length > 0 && (
              <div className="chips" role="group" aria-label="Questions to ask">
                {suggestions.map((q) => <button key={q} type="button" className="chip" disabled={busy} onClick={() => void ask(q)}>{q}</button>)}
              </div>
            )}
          </>
        )}
        {chat.map((c, i) => (
          <div key={i} className={`bubble ${c.from}`}>
            <div className="bubble-text"><span className="sr-only">{c.from === 'you' ? 'You:' : 'Builder AI:'} </span>{c.from === 'assistant' ? <Formatted text={c.text} /> : <p>{c.text}</p>}</div>
            {c.from === 'assistant' && c.messageId && (
              <div className="rate" role="group" aria-label="Was this helpful?">
                <button type="button" aria-pressed={c.helpful === true} aria-label="Helpful" onClick={() => rate(c.messageId!, true)}><ThumbsUp size={13} aria-hidden="true" /></button>
                <button type="button" aria-pressed={c.helpful === false} aria-label="Not helpful" onClick={() => rate(c.messageId!, false)}><ThumbsDown size={13} aria-hidden="true" /></button>
              </div>
            )}
          </div>
        ))}
        {busy && <p className="bubble assistant muted">{aiOn ? 'Thinking it through…' : 'Thinking…'}</p>}
      </div>
      <form className="assistant-form" onSubmit={(e) => { e.preventDefault(); const m = msg.trim(); if (m) { setMsg(''); void ask(m); } }}>
        <label htmlFor="assist-msg" className="sr-only">Message Builder AI</label>
        <input id="assist-msg" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={placeholder} autoComplete="off" maxLength={2000} />
        <button className="btn btn-primary" type="submit" disabled={busy || !msg.trim()} aria-label="Send"><Send size={16} aria-hidden="true" /></button>
      </form>
      <p className="small muted" style={{ margin: 0 }}>Concept planning only: a registered architect and engineers must prepare and verify the real drawings. Do not share personal details.</p>
    </section>
  );
}
