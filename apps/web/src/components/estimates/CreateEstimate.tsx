'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiFailure, call, errorText } from '@/lib/client';

interface Props {
  projectId: string; canIndicative: boolean; canClient: boolean; canReviewed: boolean;
  indicativeReady: boolean; indicativeMessage: string | null;
  readiness: { outcome: string; explanation: string };
}

export function CreateEstimate(p: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) {
      const missing = e instanceof ApiFailure && Array.isArray(e.details?.missing) && e.details.missing.length ? ` Missing: ${e.details.missing.join(', ')}.` : '';
      setMsg({ ok: false, text: errorText(e) + missing });
    } finally { setBusy(false); }
  }

  const create = (maturity: 'client_specified' | 'reviewed_cost_plan') => (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const title = String(new FormData(e.currentTarget).get('title') ?? '').trim();
    void run(async () => {
      const r = await call<{ estimateId: string }>(`/v1/projects/${p.projectId}/estimates`, { body: { maturity, title } });
      router.push(`/projects/${p.projectId}/estimates/${r.estimateId}`);
    });
  };

  return (
    <section id="new" aria-labelledby="new-h" className="stack">
      <h2 id="new-h" style={{ margin: 0 }}>Start an estimate</h2>
      <div className="row" style={{ alignItems: 'stretch' }}>
        {p.canIndicative && (
          <div className="card stack-sm">
            <h3 style={{ margin: 0 }}>Indicative range</h3>
            <p className="small" style={{ margin: 0 }}>A quick planning range from local benchmarks and your brief. Not a quote.</p>
            {!p.indicativeReady && p.indicativeMessage && <p className="small muted" style={{ margin: 0 }}>{p.indicativeMessage}</p>}
            <button type="button" className="btn" disabled={busy || !p.indicativeReady} onClick={() => run(async () => {
              await call(`/v1/projects/${p.projectId}/estimates/indicative`, { method: 'POST' });
              setMsg({ ok: true, text: 'Indicative range saved.' }); router.refresh();
            })}>Save an indicative range</button>
          </div>
        )}
        {p.canClient && (
          <form className="card stack-sm" onSubmit={create('client_specified')}>
            <h3 style={{ margin: 0 }}>Client-specified estimate</h3>
            <p className="small" style={{ margin: 0 }}>Enter or import your own quantities (for example from your QS). It is labelled as not reviewed by BuildWise.</p>
            <label htmlFor="cs-title">Name</label>
            <input id="cs-title" name="title" required minLength={2} maxLength={120} defaultValue="My quantity list" />
            <button type="submit" className="btn" disabled={busy}>Create</button>
          </form>
        )}
        {p.canReviewed && (
          <form className="card stack-sm" onSubmit={create('reviewed_cost_plan')}>
            <h3 style={{ margin: 0 }}>Professionally reviewed estimate</h3>
            <p className="small" style={{ margin: 0 }}>A qualified reviewer measures your drawings and prices each line with dated sources.</p>
            <p className={`small notice ${p.readiness.outcome === 'can_proceed' ? 'notice-good' : 'notice-warn'}`} style={{ margin: 0 }}>{p.readiness.explanation}</p>
            <label htmlFor="rv-title">Name</label>
            <input id="rv-title" name="title" required minLength={2} maxLength={120} defaultValue="Reviewed estimate" />
            <button type="submit" className="btn btn-primary" disabled={busy || p.readiness.outcome === 'cannot_estimate'}>Create and prepare request</button>
          </form>
        )}
      </div>
      <div role="status" aria-live="polite">{msg && <p className={`notice small ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
    </section>
  );
}
