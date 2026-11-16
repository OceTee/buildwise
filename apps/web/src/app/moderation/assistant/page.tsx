import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { AnswerForm, ArchiveAnswer, LabelMessage, RetrainButton } from '@/components/build/AssistantAdmin';
import { api, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Assistant' };

interface Msg { id: string; text: string; intent: string; confidence: number; created_at: string }
interface Admin {
  model: { trainedAt: string; examples: number; accuracy: number | null; phrases: number } | null;
  stats: Record<string, number>;
  unanswered: Msg[];
  unsure: Msg[];
  knowledge: { id: string; question: string; answer: string; tags: string[]; source: string; active: boolean }[];
  history: { id: string; metrics: Record<string, number | null>; promoted: boolean; note: string | null; trained_at: string }[];
  phrases: { term: string; field: string; value: unknown; sessions: number; precision: number }[];
  intents: string[];
}

const pct = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(n * 1000) / 10}%`);
const day = (s: string) => new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

export default async function AssistantAdminPage() {
  const me = await getMe();
  if (!me || me.staffRole === 'qs_reviewer') notFound();
  const r = await api<Admin>('/v1/admin/assistant');
  if (r.status !== 200) notFound();
  const a = r.data;
  const s = a.stats ?? {};
  return (
    <>
      <h1>BuildWise assistant</h1>
      <p className="small muted">A local model that runs on our own server: an intent classifier, a phrase list learned from corrections, and a searchable knowledge base. It only talks about building. It retrains every few hours from what people do on the site, and a new model only replaces the current one if it still passes the held-out tests.</p>

      <section aria-labelledby="m-h" className="card stack-sm">
        <h2 id="m-h">Current model</h2>
        <dl className="facts">
          <dt>Trained</dt><dd>{a.model ? day(a.model.trainedAt) : '–'}</dd>
          <dt>Training examples</dt><dd>{a.model?.examples ?? '–'}</dd>
          <dt>Held-out test accuracy</dt><dd>{pct(a.model?.accuracy)}</dd>
          <dt>Learned phrases</dt><dd>{a.model?.phrases ?? 0}</dd>
          <dt>Last 30 days</dt><dd>{s.messages ?? 0} messages, {s.answered ?? 0} answered from knowledge, {s.unanswered ?? 0} unanswered, {s.out_of_scope ?? 0} off-topic, {s.not_helpful ?? 0} rated not helpful</dd>
        </dl>
        <RetrainButton />
      </section>

      <section aria-labelledby="u-h" className="stack-sm">
        <h2 id="u-h">Questions it could not answer ({a.unanswered.length})</h2>
        <p className="small muted">Write an answer and it is used straight away. Messages are stored without phone numbers or emails.</p>
        {a.unanswered.length === 0 ? <p className="muted">None right now.</p> : (
          <ul className="plain stack-sm">
            {a.unanswered.map((m) => (
              <li key={m.id} className="card stack-sm">
                <p style={{ margin: 0 }}><strong>“{m.text}”</strong> <span className="small muted">{day(m.created_at)}</span></p>
                <AnswerForm messageId={m.id} question={m.text} />
                <LabelMessage id={m.id} intents={a.intents} current={m.intent} dismiss />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="s-h" className="stack-sm">
        <h2 id="s-h">Messages it was unsure about ({a.unsure.length})</h2>
        <p className="small muted">Labelling a message teaches the model what that kind of message means; staff labels count three times as much as automatic ones.</p>
        {a.unsure.length === 0 ? <p className="muted">None right now.</p> : (
          <div className="table-wrap">
            <table className="table small">
              <thead><tr><th scope="col">Message</th><th scope="col">Guess</th><th scope="col">Confidence</th><th scope="col">Label</th></tr></thead>
              <tbody>{a.unsure.map((m) => (
                <tr key={m.id}><td>{m.text}</td><td>{m.intent.replace(/_/g, ' ')}</td><td>{pct(m.confidence)}</td><td><LabelMessage id={m.id} intents={a.intents} current={m.intent} /></td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="p-h" className="stack-sm">
        <h2 id="p-h">Learned phrases ({a.phrases.length})</h2>
        <p className="small muted">A phrase is learned when at least three different people typed it and then set the same value by hand.</p>
        {a.phrases.length === 0 ? <p className="muted">None yet.</p> : (
          <div className="table-wrap">
            <table className="table small">
              <thead><tr><th scope="col">Phrase</th><th scope="col">Means</th><th scope="col">People</th><th scope="col">Agreement</th></tr></thead>
              <tbody>{a.phrases.map((p) => <tr key={`${p.term}-${p.field}`}><td>{p.term.replace(/_/g, ' ')}</td><td>{p.field} = {String(p.value)}</td><td>{p.sessions}</td><td>{pct(p.precision)}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="k-h" className="stack-sm">
        <h2 id="k-h">Knowledge base ({a.knowledge.filter((k) => k.active).length} active)</h2>
        <details className="card"><summary><strong>Add an answer</strong></summary><div style={{ marginTop: '.8rem' }}><AnswerForm /></div></details>
        <ul className="plain stack-sm">
          {a.knowledge.filter((k) => k.active).map((k) => (
            <li key={k.id} className="card stack-sm">
              <p style={{ margin: 0 }}><strong>{k.question}</strong> <span className="pill">{k.source === 'platform' ? 'From platform data' : k.source === 'staff' ? 'Staff' : 'Starter'}</span></p>
              <p className="small" style={{ margin: 0 }}>{k.answer}</p>
              <p className="small muted" style={{ margin: 0 }}>Tags: {k.tags.join(', ') || '–'}</p>
              {k.source !== 'platform' && (
                <div className="inline">
                  <details><summary className="small">Edit</summary><div style={{ marginTop: '.6rem' }}><AnswerForm id={k.id} question={k.question} answer={k.answer} tags={k.tags} /></div></details>
                  <ArchiveAnswer id={k.id} />
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="h-h" className="stack-sm">
        <h2 id="h-h">Training history</h2>
        <div className="table-wrap">
          <table className="table small">
            <thead><tr><th scope="col">When</th><th scope="col">Test accuracy</th><th scope="col">Learned examples</th><th scope="col">Platform facts</th><th scope="col">Result</th></tr></thead>
            <tbody>{a.history.map((h) => (
              <tr key={h.id}><td>{day(h.trained_at)}</td><td>{pct(h.metrics.accuracy as number | null)}</td><td>{h.metrics.learnedExamples ?? 0}</td><td>{h.metrics.platformFacts ?? 0}</td><td>{h.note ?? '–'}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </section>
    </>
  );
}
