'use client';
import { useRef, useState } from 'react';
import { Download, Sparkles } from 'lucide-react';

/**
 * "Create a photoreal render": sends a PNG snapshot of the 3D model to POST /api/v1/build/render, where an image
 * model turns that massing into a photorealistic exterior. Always labelled as an AI impression. Renders nothing
 * when no render provider is connected (GET /v1/build/config → render.connected).
 */

/** Matches the API's limit on the data URL (keeps the request under the 4.5 MB serverless body limit). */
const MAX_DATA_URL = 4 * 1024 * 1024;

type State =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; image: string }
  | { kind: 'failed'; message: string };

const FALLBACK: Record<string, string> = {
  not_connected: 'Photoreal renders are not available right now.',
  busy: 'The render service is busy. Try again in a minute.',
  unavailable: 'The render could not be made this time. Try again, or change the view and retry.',
};

export function RenderButton({ connected, capture, type, style, storeys, summary }: {
  connected: boolean;
  /** Returns a `data:image/png;base64,…` snapshot of the 3D view, or null if the scene is not ready. */
  capture: () => string | null;
  type?: string;
  style?: string;
  storeys?: number;
  summary?: string;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const inFlight = useRef(false);
  if (!connected) return null;

  async function go() {
    if (inFlight.current) return;
    let image: string | null = null;
    try { image = capture(); } catch { image = null; }
    if (!image || !image.startsWith('data:image/png;base64,')) { setState({ kind: 'failed', message: 'The 3D view is not ready yet. Wait for it to load and try again.' }); return; }
    if (image.length > MAX_DATA_URL) { setState({ kind: 'failed', message: 'The snapshot is too large. Make the window smaller and try again.' }); return; }
    inFlight.current = true;
    setState({ kind: 'busy' });
    try {
      const res = await fetch('/api/v1/build/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image, type, style, storeys, summary: summary?.slice(0, 300) }),
      });
      const body = await res.json().catch(() => null) as { source?: string; image?: string; reason?: string; error?: { message?: string } } | null;
      if (res.ok && body?.source === 'render' && typeof body.image === 'string' && body.image.startsWith('data:image/png;base64,')) setState({ kind: 'done', image: body.image });
      else if (res.ok && body?.source === 'none') setState({ kind: 'failed', message: FALLBACK[body.reason ?? ''] ?? FALLBACK.unavailable! });
      else if (res.status === 429) setState({ kind: 'failed', message: FALLBACK.busy! });
      else setState({ kind: 'failed', message: body?.error?.message ?? FALLBACK.unavailable! });
    } catch {
      setState({ kind: 'failed', message: 'No connection. Check your internet and try again.' });
    } finally {
      inFlight.current = false;
    }
  }

  const busy = state.kind === 'busy';
  return (
    <section className="stack-sm" aria-label="Photoreal render">
      <div>
        <button type="button" className="btn btn-outline" onClick={go} disabled={busy} aria-busy={busy}>
          <Sparkles size={16} aria-hidden="true" /> {state.kind === 'done' ? 'Create another render' : 'Create a photoreal render'}
        </button>
      </div>
      <div role="status" aria-live="polite" className="small muted">
        {busy ? 'Rendering… this takes up to a minute.' : state.kind === 'done' ? 'Render ready.' : ''}
      </div>
      {state.kind === 'failed' && <p className="notice notice-warn small" role="alert">{state.message}</p>}
      {state.kind === 'done' && (
        <figure className="stack-sm" style={{ margin: 0 }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL from the API, not an optimisable asset */}
          <img
            src={state.image}
            alt={`AI photoreal impression of the ${storeys ? `${storeys}-storey ` : ''}${type ?? 'house'} from the 3D model`}
            style={{ display: 'block', width: '100%', height: 'auto', borderRadius: 'var(--radius)' }}
          />
          <figcaption className="small muted">AI impression from your 3D model — details may differ from the plan.</figcaption>
          <div>
            <a className="btn btn-small btn-ghost" href={state.image} download="buildwise-render.png">
              <Download size={16} aria-hidden="true" /> Download render
            </a>
          </div>
        </figure>
      )}
    </section>
  );
}
