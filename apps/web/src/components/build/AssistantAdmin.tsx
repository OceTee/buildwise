'use client';
import { useRouter } from 'next/navigation';
import { useId, useState } from 'react';
import { call, errorText } from '@/lib/client';

export function RetrainButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  return (
    <div className="inline">
      <button type="button" className="btn" disabled={busy} onClick={async () => {
        setBusy(true); setMsg('');
        try {
          const r = await call<{ promoted: boolean; note: string; accuracy: number }>('/v1/admin/assistant/train', { body: {} });
          setMsg(`${r.promoted ? 'New model in use' : 'Previous model kept'}: ${r.note}.`);
          router.refresh();
        } catch (e) { setMsg(errorText(e)); } finally { setBusy(false); }
      }}>{busy ? 'Training…' : 'Retrain now'}</button>
      <span role="status" className="small">{msg}</span>
    </div>
  );
}

export function AnswerForm({ id, messageId, question = '', answer = '', tags = [] }: { id?: string; messageId?: string; question?: string; answer?: string; tags?: string[] }) {
  const router = useRouter();
  const uid = useId();
  const [q, setQ] = useState(question);
  const [a, setA] = useState(answer);
  const [t, setT] = useState(tags.join(', '));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <form className="stack-sm" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setErr('');
      try {
        await call('/v1/admin/assistant/knowledge', { body: { ...(id ? { id } : {}), ...(messageId ? { answersMessageId: messageId } : {}), question: q, answer: a, tags: t.split(',').map((x) => x.trim()).filter(Boolean) } });
        if (!id) { setA(''); }
        router.refresh();
      } catch (x) { setErr(errorText(x)); } finally { setBusy(false); }
    }}>
      <div className="field"><label htmlFor={`${uid}-q`}>Question</label><input id={`${uid}-q`} value={q} onChange={(e) => setQ(e.target.value)} required minLength={5} maxLength={300} /></div>
      <div className="field"><label htmlFor={`${uid}-a`}>Answer</label><textarea id={`${uid}-a`} rows={3} value={a} onChange={(e) => setA(e.target.value)} required minLength={10} maxLength={1500} /></div>
      <div className="field"><label htmlFor={`${uid}-t`}>Tags (comma separated: the words people use for this topic)</label><input id={`${uid}-t`} value={t} onChange={(e) => setT(e.target.value)} /></div>
      <div role="alert">{err && <p className="notice notice-bad small">{err}</p>}</div>
      <button className="btn btn-primary btn-small" type="submit" disabled={busy}>{id ? 'Save answer' : 'Add answer'}</button>
    </form>
  );
}

export function ArchiveAnswer({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={async () => {
      setBusy(true);
      try { await call(`/v1/admin/assistant/knowledge/${encodeURIComponent(id)}/archive`, { body: {} }); router.refresh(); } finally { setBusy(false); }
    }}>Remove</button>
  );
}

export function LabelMessage({ id, intents, current, dismiss }: { id: string; intents: string[]; current: string; dismiss?: boolean }) {
  const router = useRouter();
  const uid = useId();
  const [v, setV] = useState(current);
  const [done, setDone] = useState(false);
  return (
    <form className="inline" onSubmit={async (e) => {
      e.preventDefault();
      await call(`/v1/admin/assistant/messages/${id}/label`, { body: { intent: v, ...(dismiss ? { dismiss: true } : {}) } });
      setDone(true); router.refresh();
    }}>
      <label htmlFor={`${uid}-l`} className="sr-only">What this message is</label>
      <select id={`${uid}-l`} value={v} onChange={(e) => setV(e.target.value)}>
        {intents.map((i) => <option key={i} value={i}>{i.replace(/_/g, ' ')}</option>)}
      </select>
      <button className="btn btn-small" type="submit">{dismiss ? 'Label and dismiss' : 'Label'}</button>
      {done && <span role="status" className="small">Saved</span>}
    </form>
  );
}
