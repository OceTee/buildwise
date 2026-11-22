'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';

/**
 * Dream renders: AI-painted photoreal impressions of the design from four views (street, aerial, garden, interior),
 * made one after another by POST /api/v1/build/dream (sequential, to respect the image model's limits). When Claude
 * is connected it checks each exterior painting against the 3D model so the picture does not misstate storeys, roof
 * or wings. Always labelled as an AI impression. Renders nothing when not connected
 * (GET /v1/build/config → dream.connected).
 */

export type DreamView = 'street' | 'aerial' | 'garden' | 'interior';
export interface DreamFacts { type: string; style: string; storeys: number; roof: string; blocks: number; summary?: string }
export interface DreamConcept { title: string; story?: string; palette: { walls: string; accents: string; roof: string } }

const VIEWS: { view: DreamView; label: string }[] = [
  { view: 'street', label: 'Street view' },
  { view: 'aerial', label: 'Aerial view' },
  { view: 'garden', label: 'Garden view' },
  { view: 'interior', label: 'Inside' },
];

/** Matches the API's limit on the snapshot data URL. Larger snapshots are left out and the image is painted from the facts. */
const MAX_SNAPSHOT = Math.floor(5.5 * 1024 * 1024);
const PNG_PREFIX = 'data:image/png;base64,';

type Item =
  | { status: 'waiting' }
  | { status: 'busy' }
  | { status: 'done'; image: string; checked: boolean; consistent?: boolean; issues?: string[] }
  | { status: 'failed'; message: string };

const FALLBACK: Record<string, string> = {
  not_connected: 'AI impressions are not available right now.',
  busy: 'The image service is busy. Try again in a minute.',
  unavailable: 'This impression could not be made this time. Try again.',
};

type Outcome = { ok: true; item: Item } | { ok: false; message: string; stop: boolean };

const clip = (t: string | undefined, n: number) => (t ? t.slice(0, n) : undefined);

export function DreamGallery({ connected, capture, facts, concept, autoStart }: {
  connected: boolean;
  /** Returns a `data:image/png;base64,…` snapshot of the 3D view, or null if the scene is not ready. */
  capture: () => string | null;
  facts: DreamFacts;
  concept?: DreamConcept;
  autoStart?: boolean;
}) {
  const [items, setItems] = useState<Record<DreamView, Item>>({ street: { status: 'waiting' }, aerial: { status: 'waiting' }, garden: { status: 'waiting' }, interior: { status: 'waiting' } });
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState('');
  const busyRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const started = useRef(false);
  // The latest props, so a run that is already under way paints the design as it is now.
  const latest = useRef({ capture, facts, concept });
  useEffect(() => { latest.current = { capture, facts, concept }; });

  const runId = useRef(0);
  // Leaving the page stops the run (and lets React's development double-mount start it again cleanly).
  useEffect(() => () => { runId.current++; abortRef.current?.abort(); busyRef.current = false; started.current = false; }, []);

  const paint = useCallback(async (view: DreamView, shot: string | undefined, signal: AbortSignal): Promise<Outcome> => {
    const { facts: f, concept: c } = latest.current;
    try {
      const res = await fetch('/api/v1/build/dream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal,
        body: JSON.stringify({
          ...(shot ? { snapshot: shot } : {}),
          view,
          facts: { type: clip(f.type, 40), style: clip(f.style, 40), storeys: f.storeys, roof: clip(f.roof, 40), blocks: Math.max(1, Math.min(8, f.blocks)), summary: clip(f.summary, 300) },
          ...(c ? { concept: { title: clip(c.title, 60), story: clip(c.story, 600), palette: { walls: clip(c.palette.walls, 110), accents: clip(c.palette.accents, 110), roof: clip(c.palette.roof, 110) } } } : {}),
        }),
      });
      const body = await res.json().catch(() => null) as { source?: string; image?: string; checked?: boolean; consistent?: boolean; issues?: string[]; reason?: string; error?: { message?: string } } | null;
      if (res.ok && body?.source === 'dream' && typeof body.image === 'string' && /^data:image\/(png|jpeg);base64,/.test(body.image)) {
        return { ok: true, item: { status: 'done', image: body.image, checked: !!body.checked, consistent: body.consistent, issues: Array.isArray(body.issues) ? body.issues.slice(0, 5) : undefined } };
      }
      if (res.ok && body?.source === 'none') return { ok: false, message: FALLBACK[body.reason ?? ''] ?? FALLBACK.unavailable!, stop: body.reason !== 'unavailable' };
      if (res.status === 429) return { ok: false, message: FALLBACK.busy!, stop: true };
      return { ok: false, message: body?.error?.message ?? FALLBACK.unavailable!, stop: false };
    } catch {
      if (signal.aborted) return { ok: false, message: 'Stopped.', stop: true };
      return { ok: false, message: 'No connection. Check your internet and try again.', stop: true };
    }
  }, []);

  /** Paints the given views one after another; stops early when the service is busy or off. */
  const run = useCallback(async (views: DreamView[]) => {
    if (busyRef.current || !views.length) return;
    busyRef.current = true;
    const id = ++runId.current;
    setRunning(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const set = (view: DreamView, item: Item) => setItems((prev) => ({ ...prev, [view]: item }));
    let shot: string | undefined;
    try {
      const s = latest.current.capture();
      shot = s && s.startsWith(PNG_PREFIX) && s.length <= MAX_SNAPSHOT ? s : undefined;
    } catch { shot = undefined; }
    setItems((prev) => { const next = { ...prev }; for (const v of views) next[v] = { status: 'waiting' }; return next; });
    let done = 0;
    for (const [i, view] of views.entries()) {
      const label = VIEWS.find((x) => x.view === view)!.label.toLowerCase();
      setNote(`Painting the ${label} (${i + 1} of ${views.length})… each one takes up to a minute.`);
      set(view, { status: 'busy' });
      const out = await paint(view, shot, ctrl.signal);
      if (ctrl.signal.aborted) break;
      if (out.ok) { set(view, out.item); done++; continue; }
      set(view, { status: 'failed', message: out.message });
      if (out.stop) {
        for (const rest of views.slice(i + 1)) set(rest, { status: 'failed', message: 'Not painted yet.' });
        break;
      }
    }
    if (!ctrl.signal.aborted) setNote(done === views.length ? `${done === 1 ? 'Impression' : `All ${done} impressions`} ready.` : `${done} of ${views.length} ready.`);
    if (runId.current !== id) return;
    busyRef.current = false;
    setRunning(false);
  }, [paint]);

  useEffect(() => {
    if (connected && autoStart && !started.current) { started.current = true; void run(VIEWS.map((v) => v.view)); }
  }, [connected, autoStart, run]);

  if (!connected) return null;

  const any = VIEWS.some((v) => items[v.view].status !== 'waiting');
  const pending = VIEWS.filter((v) => items[v.view].status === 'failed').map((v) => v.view);
  const storeyText = facts.storeys === 1 ? 'single-storey' : `${facts.storeys}-storey`;

  return (
    <section className="stack-sm" aria-label="AI impressions of your design">
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', alignItems: 'center' }}>
        {!any && (
          <button type="button" className="btn btn-outline" onClick={() => { started.current = true; void run(VIEWS.map((v) => v.view)); }} disabled={running} aria-busy={running}>
            <Sparkles size={16} aria-hidden="true" /> Paint my design
          </button>
        )}
        {any && !running && pending.length > 0 && (
          <button type="button" className="btn btn-small btn-outline" onClick={() => void run(pending)}>
            <RefreshCw size={16} aria-hidden="true" /> Try the missing {pending.length === 1 ? 'view' : 'views'} again
          </button>
        )}
        {any && !running && pending.length === 0 && (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => void run(VIEWS.map((v) => v.view))}>
            <RefreshCw size={16} aria-hidden="true" /> Paint all four again
          </button>
        )}
      </div>
      <div role="status" aria-live="polite" className="small muted">{note}</div>
      {any && (
        <div className="grid">
          {VIEWS.map(({ view, label }) => {
            const it = items[view];
            const ext = it.status === 'done' && it.image.startsWith('data:image/png') ? 'png' : 'jpg';
            return (
              <figure key={view} className="card-inset stack-sm" style={{ margin: 0 }} aria-busy={it.status === 'busy'}>
                <div className="small" style={{ fontWeight: 600 }}>{label}</div>
                {it.status === 'done' ? (
                  // eslint-disable-next-line @next/next/no-img-element -- a data URL from the API, not an optimisable asset
                  <img
                    src={it.image}
                    alt={`AI impression of your ${storeyText} ${facts.type}${concept?.title ? `, ${concept.title}` : ''}: ${label.toLowerCase()}`}
                    style={{ display: 'block', width: '100%', height: 'auto', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 'var(--radius)' }}
                  />
                ) : (
                  <div className="muted small" style={{ display: 'grid', placeItems: 'center', aspectRatio: '16 / 9', borderRadius: 'var(--radius)', border: '1px dashed var(--border)', textAlign: 'center', padding: '.5rem' }}>
                    {it.status === 'busy' ? 'Painting…' : it.status === 'failed' ? it.message : 'Waiting'}
                  </div>
                )}
                <figcaption className="small muted stack-sm">
                  <div>AI impression of your design — details may differ from the plan.</div>
                  {it.status === 'done' && it.checked && it.consistent && (
                    <div style={{ display: 'flex', gap: '.35rem', alignItems: 'center' }}><ShieldCheck size={14} aria-hidden="true" /> Checked by Claude against your 3D model</div>
                  )}
                  {it.status === 'done' && it.checked && it.consistent === false && (
                    <div className="notice notice-warn small">
                      Claude compared this with your 3D model and found differences:
                      <ul style={{ margin: '.3rem 0 0', paddingLeft: '1.1rem' }}>
                        {(it.issues?.length ? it.issues : ['It does not match the plan closely.']).map((x) => <li key={x}>{x}</li>)}
                      </ul>
                    </div>
                  )}
                </figcaption>
                {(it.status === 'done' || it.status === 'failed') && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.35rem' }}>
                    {it.status === 'done' && (
                      <a className="btn btn-small btn-ghost" href={it.image} download={`buildwise-${view}.${ext}`}>
                        <Download size={16} aria-hidden="true" /> Download
                      </a>
                    )}
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => void run([view])} disabled={running} aria-label={`Paint the ${label.toLowerCase()} again`}>
                      <RefreshCw size={16} aria-hidden="true" /> Retry
                    </button>
                  </div>
                )}
              </figure>
            );
          })}
        </div>
      )}
    </section>
  );
}
