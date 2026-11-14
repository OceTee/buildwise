'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { formatDec, measure, polylineLength, type Calibration, type MeasureKind, type Pt } from '@bw/domain';
import { ApiFailure, call, errorText } from '@/lib/client';
import type { Revision } from './DocumentWorkspace';

interface Cal extends Calibration { id: string; page: number; at: string }
export interface Measurement {
  id: string; page: number; kind: MeasureKind; label: string; layer: string; points: Pt[]; count: number | null; depth: string | null;
  value: string; unit: string; derivation: string; potentiallyAffected: boolean; confirmed: boolean; author: string | null; at: string;
}
interface Takeoff { calibrations: Cal[]; measurements: Measurement[]; canMeasure: boolean; superseded: boolean }

type Tool = 'select' | 'calibrate' | 'count' | 'linear' | 'perimeter' | 'area' | 'volume';
const TOOLS: { code: Tool; label: string; needsScale: boolean }[] = [
  { code: 'select', label: 'Look', needsScale: false },
  { code: 'calibrate', label: 'Set scale', needsScale: false },
  { code: 'count', label: 'Count', needsScale: false },
  { code: 'linear', label: 'Length', needsScale: true },
  { code: 'perimeter', label: 'Perimeter', needsScale: true },
  { code: 'area', label: 'Area', needsScale: true },
  { code: 'volume', label: 'Volume', needsScale: true },
];
const INSTRUCTIONS: Record<Tool, string> = {
  select: 'Viewing only. Choose a tool to measure.',
  calibrate: 'Click both ends of a dimension you know (for example a dimensioned wall). Then enter its real length. Optionally add a second known dimension as a check.',
  count: 'Click each item to count it. Press Enter or double-click when done. Backspace removes the last marker; Escape cancels.',
  linear: 'Click along the line. Press Enter or double-click to finish. Backspace removes the last point; Escape cancels.',
  perimeter: 'Click around the outline; it closes automatically. Press Enter or double-click to finish.',
  area: 'Click around the outline of the area. Press Enter or double-click to finish.',
  volume: 'Click around the outline of the area, finish with Enter or double-click, then enter the depth or thickness.',
};
const LAYER_STYLE: Record<string, { stroke: string; dash: string }> = {
  architectural: { stroke: 'var(--accent)', dash: '' },
  structural: { stroke: 'var(--focus)', dash: '10 4' },
  mep: { stroke: 'var(--promo)', dash: '4 3' },
  site: { stroke: 'var(--good)', dash: '14 4 3 4' },
  specification: { stroke: 'var(--text-2)', dash: '2 3' },
  other: { stroke: 'var(--text-2)', dash: '6 6' },
};
const UNIT_LABEL: Record<string, string> = { m: 'm', m2: 'm²', m3: 'm³', piece: 'pcs' };
const MANUAL_UNITS = ['m', 'm2', 'm3', 'piece', 'kg', 'tonne', 'bag', 'trip', 'litre', 'job'];
/** Display value: stored to 6 dp, shown to 3. */
const fmtVal = (v: string) => { const [w, f = ''] = v.split('.'); const t = f.slice(0, 3).replace(/0+$/, ''); return t ? `${w}.${t}` : w!; };
const KIND_LABEL: Record<string, string> = { count: 'Count', linear: 'Length', perimeter: 'Perimeter', area: 'Area', volume: 'Volume', manual: 'Manual' };

export function TakeoffViewer({ projectId, revision, page, onPage, disciplines, canMeasure, canConfirm, canRaiseRfi, onDownload }: {
  projectId: string; revision: Revision; page: number; onPage: (p: number) => void; disciplines: { code: string; label: string }[];
  canMeasure: boolean; canConfirm: boolean; canRaiseRfi: boolean; onDownload: () => void;
}) {
  const [data, setData] = useState<Takeoff | null>(null);
  const [loadError, setLoadError] = useState('');
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [layer, setLayer] = useState(disciplines[0]?.code ?? 'architectural');
  const [draft, setDraft] = useState<Pt[]>([]);
  const [finished, setFinished] = useState(false);
  const [scale, setScale] = useState(1);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pages = revision.pages ?? 1;
  const size = revision.pageSizes?.[page - 1] ?? { w: 1000, h: 700 };
  const editable = canMeasure && !!data?.canMeasure;

  const loadTakeoff = useCallback(async () => {
    try { setData(await call<Takeoff>(`/v1/revisions/${revision.id}/takeoff`)); } catch (e) { setLoadError(errorText(e)); }
  }, [revision.id]);
  const loadFile = useCallback(async () => {
    if (revision.preview === 'none') return;
    try { const l = await call<{ url: string }>(`/v1/revisions/${revision.id}/file-link`, { body: { disposition: 'inline' } }); setFileUrl(`/api${l.url}`); }
    catch (e) { setLoadError(errorText(e)); }
  }, [revision.id, revision.preview]);
  useEffect(() => { void loadTakeoff(); void loadFile(); }, [loadTakeoff, loadFile]);

  const cal = useMemo(() => data?.calibrations.find((c) => c.page === page) ?? null, [data, page]);
  const pageMeasurements = useMemo(() => (data?.measurements ?? []).filter((m) => m.page === page), [data, page]);
  const toolDef = TOOLS.find((t) => t.code === tool)!;
  const blocked = toolDef.needsScale && !cal;

  const reset = () => { setDraft([]); setFinished(false); };
  const chooseTool = (t: Tool) => { setTool(t); reset(); setMsg(null); };
  useEffect(() => { reset(); }, [page]);

  const preview = useMemo(() => {
    if (!draft.length || tool === 'select' || tool === 'calibrate') return null;
    try {
      if (tool === 'count') return `${draft.length} counted`;
      if (tool === 'volume') { const r = measure({ kind: 'area', points: draft }, cal); return `${formatDec(r.value, 2)} m² outline (depth entered on save)`; }
      const r = measure({ kind: tool, points: draft }, cal);
      return `${formatDec(r.value, 2)} ${UNIT_LABEL[r.unit] ?? r.unit}`;
    } catch { return null; }
  }, [draft, tool, cal]);

  function addPoint(p: Pt) {
    if (!editable || tool === 'select' || blocked || finished) return;
    if (tool === 'calibrate' && draft.length >= 4) return;
    const last = draft[draft.length - 1];
    if (last && Math.hypot(last.x - p.x, last.y - p.y) < 1) return;
    const next = [...draft, p];
    setDraft(next);
    if (tool === 'calibrate' && next.length === 2) setFinished(true);
    if (tool === 'calibrate' && next.length === 4) setFinished(true);
  }
  function finish() {
    if (tool === 'select' || tool === 'calibrate') return;
    const min = tool === 'count' ? 1 : tool === 'linear' ? 2 : 3;
    if (draft.length < min) { setMsg({ ok: false, text: `Add at least ${min} point${min === 1 ? '' : 's'} first.` }); return; }
    setFinished(true);
  }
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') { reset(); e.preventDefault(); }
    else if (e.key === 'Enter') { finish(); e.preventDefault(); }
    else if (e.key === 'Backspace' && draft.length && !finished) { setDraft(draft.slice(0, -1)); e.preventDefault(); }
  }

  async function del(m: Measurement) {
    if (!window.confirm(`Delete the measurement “${m.label}”?`)) return;
    try { await call(`/v1/measurements/${m.id}`, { method: 'DELETE' }); setMsg({ ok: true, text: 'Measurement deleted.' }); void loadTakeoff(); }
    catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  }
  async function confirmM(m: Measurement) {
    try { await call(`/v1/measurements/${m.id}/confirm`, { body: {} }); setMsg({ ok: true, text: `“${m.label}” confirmed.` }); void loadTakeoff(); }
    catch (e) { setMsg({ ok: false, text: errorText(e) }); }
  }

  if (loadError) return <div className="notice notice-bad" role="alert">{loadError}</div>;

  return (
    <section className="stack" aria-labelledby="viewer-h">
      <h2 id="viewer-h" className="sr-only">Revision {revision.revision} viewer</h2>

      <div className="card stack-sm">
        <div className="inline" style={{ justifyContent: 'space-between' }}>
          <div className="inline">
            <strong>Revision {revision.revision}</strong>
            <span className="small muted">{revision.fileName}</span>
          </div>
          <button type="button" className="btn btn-small" onClick={onDownload}>Download original</button>
        </div>

        {revision.preview === 'pdf' && (
          <div className="inline" role="toolbar" aria-label="Page and zoom">
            <button type="button" className="btn btn-small" onClick={() => onPage(Math.max(1, page - 1))} disabled={page <= 1}>Previous page</button>
            <label htmlFor="pg" className="sr-only">Page</label>
            <select id="pg" value={page} onChange={(e) => onPage(Number(e.target.value))} style={{ width: 'auto' }}>
              {Array.from({ length: pages }, (_, i) => <option key={i} value={i + 1}>Page {i + 1} of {pages}</option>)}
            </select>
            <button type="button" className="btn btn-small" onClick={() => onPage(Math.min(pages, page + 1))} disabled={page >= pages}>Next page</button>
            <span aria-hidden="true" style={{ width: '1rem' }} />
            <button type="button" className="btn btn-small" onClick={() => setScale((s) => Math.max(0.1, +(s / 1.25).toFixed(3)))} aria-label="Zoom out">−</button>
            <span className="small" aria-live="polite">{Math.round(scale * 100)}%</span>
            <button type="button" className="btn btn-small" onClick={() => setScale((s) => Math.min(6, +(s * 1.25).toFixed(3)))} aria-label="Zoom in">+</button>
            <button type="button" className="btn btn-small" onClick={() => setScale(-1)}>Fit width</button>
          </div>
        )}

        {revision.preview === 'pdf' && editable && (
          <div className="stack-sm">
            <div className="inline" role="radiogroup" aria-label="Measuring tool">
              {TOOLS.map((t) => (
                <button key={t.code} type="button" role="radio" aria-checked={tool === t.code} className={`btn btn-small ${tool === t.code ? 'btn-primary' : ''}`} onClick={() => chooseTool(t.code)}>
                  {t.label}{t.needsScale && !cal ? ' (needs scale)' : ''}
                </button>
              ))}
              <label htmlFor="layer" className="small" style={{ margin: '0 0 0 .5rem' }}>Layer</label>
              <select id="layer" value={layer} onChange={(e) => setLayer(e.target.value)} style={{ width: 'auto' }}>{disciplines.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</select>
            </div>
            <p className="small" id="tool-help" style={{ margin: 0 }}>
              <strong>{toolDef.label}:</strong> {blocked ? 'This page has no scale yet. Use “Set scale” first; lengths, areas and volumes are blocked until then. Count and manual measurements still work.' : INSTRUCTIONS[tool]}
            </p>
            <p className="small muted" style={{ margin: 0 }}>
              Scale on this page: {cal ? <>set from {cal.knownLength} {cal.knownUnit}{cal.check ? `, checked against a second dimension (within ${cal.check.deviationPct}%)` : ', no check dimension'}.</> : 'not set.'}
            </p>
          </div>
        )}
        {revision.preview === 'pdf' && !editable && (
          <p className="small muted" style={{ margin: 0 }}>{data?.superseded ? 'This revision is superseded and read-only.' : 'You can view measurements on this drawing but not change them.'}</p>
        )}
      </div>

      {revision.preview === 'pdf' && fileUrl && (
        <PdfCanvas
          url={fileUrl} page={page} pageW={size.w} pageH={size.h} scale={scale} onFit={setScale}
          measurements={pageMeasurements} cal={cal} draft={draft} tool={tool} layer={layer}
          interactive={editable && tool !== 'select' && !blocked}
          onPoint={addPoint} onFinish={finish} onKey={onKey} preview={preview}
        />
      )}
      {revision.preview === 'image' && fileUrl && (
        <div className="card"><img src={fileUrl} alt={`${revision.fileName}, revision ${revision.revision}`} style={{ maxWidth: '100%', height: 'auto' }} /></div>
      )}
      {revision.preview === 'none' && (
        <div className="notice">This file type ({revision.typeLabel ?? 'unknown'}) can be downloaded but not previewed. <button type="button" className="linkish" onClick={onDownload}>Download it</button>.</div>
      )}

      {finished && tool === 'calibrate' && (
        <CalibrationForm revisionId={revision.id} page={page} points={draft}
          onAddCheck={() => setFinished(false)}
          onCancel={reset}
          onSaved={() => { reset(); setTool('select'); setMsg({ ok: true, text: 'Scale set for this page.' }); void loadTakeoff(); }} />
      )}
      {finished && tool !== 'calibrate' && tool !== 'select' && (
        <SaveMeasurementForm revisionId={revision.id} page={page} kind={tool} points={draft} layer={layer} preview={preview}
          onCancel={reset}
          onSaved={(m) => { reset(); setMsg({ ok: true, text: `Saved “${m.label}”: ${fmtVal(m.value)} ${UNIT_LABEL[m.unit] ?? m.unit}.` }); void loadTakeoff(); }} />
      )}

      <div role="status" aria-live="polite">{msg && <p className={`notice small ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>

      <div className="layout-2">
        <MeasurementTable items={pageMeasurements} page={page} disciplines={disciplines} canDelete={editable} canConfirm={canConfirm && !data?.superseded} onDelete={del} onConfirm={confirmM} />
        <div className="stack">
          {editable && <ManualForm revisionId={revision.id} page={page} layer={layer} onSaved={(m) => { setMsg({ ok: true, text: `Saved “${m.label}”.` }); void loadTakeoff(); }} />}
          {canRaiseRfi && <RfiForm projectId={projectId} revisionId={revision.id} page={page} />}
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- canvas and overlay
function PdfCanvas({ url, page, pageW, pageH, scale, onFit, measurements, cal, draft, tool, layer, interactive, onPoint, onFinish, onKey, preview }: {
  url: string; page: number; pageW: number; pageH: number; scale: number; onFit: (s: number) => void;
  measurements: Measurement[]; cal: Cal | null; draft: Pt[]; tool: Tool; layer: string; interactive: boolean;
  onPoint: (p: Pt) => void; onFinish: () => void; onKey: (e: React.KeyboardEvent) => void; preview: string | null;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const docRef = useRef<any>(null);
  const [error, setError] = useState('');
  const [rendering, setRendering] = useState(true);
  const [hover, setHover] = useState<Pt | null>(null);

  // Fit to width on first load and when asked (scale -1).
  useEffect(() => {
    if (scale !== -1 && scale !== 1) return;
    if (scale === 1 && docRef.current) return;
    const w = (wrap.current?.clientWidth ?? 800) - 2;
    onFit(Math.max(0.1, +(w / pageW).toFixed(3)));
  }, [scale, pageW, onFit]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
        const task = pdfjs.getDocument({ url, disableFontFace: false });
        const doc = await task.promise;
        if (cancelled) { void task.destroy(); return; }
        docRef.current = doc;
        setError('');
      } catch { if (!cancelled) setError('The drawing could not be loaded. Reload the page to get a fresh link.'); }
    })();
    return () => { cancelled = true; void docRef.current?.destroy?.(); docRef.current = null; };
  }, [url]);

  useEffect(() => {
    if (scale <= 0) return;
    let cancelled = false; let task: any = null;
    const draw = async () => {
      for (let i = 0; i < 50 && !docRef.current && !cancelled; i++) await new Promise((r) => setTimeout(r, 100));
      const doc = docRef.current;
      if (!doc || cancelled || !canvas.current) return;
      setRendering(true);
      try {
        const p = await doc.getPage(page);
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const vp = p.getViewport({ scale: scale * dpr });
        const c = canvas.current;
        c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
        c.style.width = `${Math.floor(vp.width / dpr)}px`; c.style.height = `${Math.floor(vp.height / dpr)}px`;
        task = p.render({ canvas: c, viewport: vp });
        await task.promise;
      } catch (e: any) { if (e?.name !== 'RenderingCancelledException' && !cancelled) setError('This page could not be drawn.'); }
      finally { if (!cancelled) setRendering(false); }
    };
    void draw();
    return () => { cancelled = true; task?.cancel?.(); };
  }, [page, scale, url]);

  const toPage = (e: React.MouseEvent): Pt | null => {
    const r = svg.current?.getBoundingClientRect();
    if (!r) return null;
    return { x: ((e.clientX - r.left) / r.width) * pageW, y: ((e.clientY - r.top) / r.height) * pageH };
  };
  const sw = 2 / Math.max(scale, 0.1); // constant on-screen stroke width
  const label = (m: Measurement) => `${m.label}: ${fmtVal(m.value)} ${UNIT_LABEL[m.unit] ?? m.unit}${m.potentiallyAffected ? ' (may be affected by a newer revision)' : ''}`;
  const w = Math.max(1, Math.floor(pageW * Math.max(scale, 0.1)));
  const h = Math.max(1, Math.floor(pageH * Math.max(scale, 0.1)));

  return (
    <div ref={wrap} className="card" style={{ padding: 0, overflow: 'auto', maxHeight: '80vh', position: 'relative' }}>
      {error && <p className="notice notice-bad" role="alert" style={{ margin: '.5rem' }}>{error}</p>}
      <div
        tabIndex={0}
        role="group"
        aria-label={`Drawing, page ${page}. ${interactive ? 'Measuring: use the mouse to place points, Enter to finish, Backspace to undo, Escape to cancel. A manual measurement form is below.' : 'Viewing only.'}`}
        aria-describedby="tool-help"
        onKeyDown={onKey}
        style={{ position: 'relative', width: w, height: h, cursor: interactive ? 'crosshair' : 'default' }}
      >
        <canvas ref={canvas} aria-hidden="true" style={{ display: 'block', background: '#fff' }} />
        {rendering && <span className="small muted" style={{ position: 'absolute', top: 8, left: 8 }} role="status">Drawing page…</span>}
        <svg
          ref={svg}
          viewBox={`0 0 ${pageW} ${pageH}`}
          width={w} height={h}
          style={{ position: 'absolute', inset: 0 }}
          onClick={(e) => { if (!interactive) return; const p = toPage(e); if (p) onPoint(p); }}
          onDoubleClick={(e) => { if (!interactive) return; e.preventDefault(); onFinish(); }}
          onMouseMove={(e) => { if (interactive && draft.length) setHover(toPage(e)); }}
          onMouseLeave={() => setHover(null)}
          role="img"
          aria-label={`${measurements.length} measurement(s) on this page${cal ? ', scale set' : ', no scale set'}`}
        >
          {cal && (
            <g aria-hidden="true">
              <line x1={cal.a.x} y1={cal.a.y} x2={cal.b.x} y2={cal.b.y} stroke="var(--warn)" strokeWidth={sw * 1.5} strokeDasharray={`${sw * 4} ${sw * 2}`} />
              <text x={(cal.a.x + cal.b.x) / 2} y={(cal.a.y + cal.b.y) / 2 - sw * 4} fontSize={sw * 7} fill="var(--warn)" stroke="#fff" strokeWidth={sw * 2} paintOrder="stroke">scale {cal.knownLength} {cal.knownUnit}</text>
            </g>
          )}
          {measurements.map((m) => {
            const st = LAYER_STYLE[m.layer] ?? LAYER_STYLE.other!;
            const stroke = m.potentiallyAffected ? 'var(--bad)' : st.stroke;
            const dash = m.potentiallyAffected ? `${sw * 2} ${sw * 2}` : st.dash.split(' ').filter(Boolean).map((n) => Number(n) * sw).join(' ');
            const pts = m.points.map((p) => `${p.x},${p.y}`).join(' ');
            const first = m.points[0];
            return (
              <g key={m.id}>
                <title>{label(m)}</title>
                {m.kind === 'count' && m.points.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={sw * 5} fill="none" stroke={stroke} strokeWidth={sw * 2} />)}
                {m.kind === 'linear' && <polyline points={pts} fill="none" stroke={stroke} strokeWidth={sw * 2} strokeDasharray={dash} />}
                {(m.kind === 'perimeter' || m.kind === 'area' || m.kind === 'volume') && <polygon points={pts} fill={m.kind === 'perimeter' ? 'none' : stroke} fillOpacity={0.12} stroke={stroke} strokeWidth={sw * 2} strokeDasharray={dash} />}
                {first && <text x={first.x + sw * 4} y={first.y - sw * 4} fontSize={sw * 7} fill={stroke} stroke="#fff" strokeWidth={sw * 2} paintOrder="stroke">{m.potentiallyAffected ? '⚠ ' : ''}{m.label}</text>}
              </g>
            );
          })}
          {draft.length > 0 && (
            <g aria-hidden="true">
              {tool === 'count'
                ? draft.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={sw * 5} fill="none" stroke="var(--focus)" strokeWidth={sw * 2} />)
                : <polyline points={[...draft, ...(hover ? [hover] : [])].map((p) => `${p.x},${p.y}`).join(' ') + (['area', 'perimeter', 'volume'].includes(tool) && draft.length > 2 ? ` ${draft[0]!.x},${draft[0]!.y}` : '')}
                    fill={['area', 'volume'].includes(tool) ? 'var(--focus)' : 'none'} fillOpacity={0.1} stroke="var(--focus)" strokeWidth={sw * 2} />}
              {tool !== 'count' && draft.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={sw * 3} fill="var(--focus)" />)}
              {tool === 'calibrate' && draft.length >= 2 && <text x={draft[1]!.x + sw * 4} y={draft[1]!.y} fontSize={sw * 7} fill="var(--focus)">{Math.round(polylineLength(draft.slice(0, 2)))} units</text>}
            </g>
          )}
        </svg>
        {preview && <span className="pill" role="status" style={{ position: 'absolute', top: 8, right: 8 }}>{preview}</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- forms
function CalibrationForm({ revisionId, page, points, onAddCheck, onCancel, onSaved }: { revisionId: string; page: number; points: Pt[]; onAddCheck: () => void; onCancel: () => void; onSaved: () => void }) {
  const [length, setLength] = useState('');
  const [unit, setUnit] = useState<'m' | 'mm'>('m');
  const [checkLength, setCheckLength] = useState('');
  const [checkUnit, setCheckUnit] = useState<'m' | 'mm'>('m');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const hasCheck = points.length === 4;
  return (
    <form className="card stack-sm" aria-labelledby="cal-h" onSubmit={async (e) => {
      e.preventDefault(); setBusy(true); setError('');
      try {
        await call(`/v1/revisions/${revisionId}/calibrations`, { body: {
          page, a: points[0], b: points[1], knownLength: length, knownUnit: unit,
          check: hasCheck ? { a: points[2], b: points[3], knownLength: checkLength, knownUnit: checkUnit } : null,
        } });
        onSaved();
      } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
    }}>
      <h3 id="cal-h" style={{ margin: 0 }}>Set the scale for page {page}</h3>
      <p className="small muted" style={{ margin: 0 }}>Never assume a PDF is printed to scale: measure a dimension that is written on the drawing.</p>
      <div className="row">
        <div><label htmlFor="cal-len">Real length of the line you drew</label><input id="cal-len" inputMode="decimal" required value={length} onChange={(e) => setLength(e.target.value)} pattern="\d+(\.\d{1,6})?" autoFocus /></div>
        <div><label htmlFor="cal-unit">Unit</label><select id="cal-unit" value={unit} onChange={(e) => setUnit(e.target.value as 'm' | 'mm')}><option value="m">metres</option><option value="mm">millimetres</option></select></div>
      </div>
      {hasCheck ? (
        <fieldset style={{ margin: 0 }}>
          <legend>Check dimension</legend>
          <div className="row">
            <div><label htmlFor="cal-clen">Real length of the second line</label><input id="cal-clen" inputMode="decimal" required value={checkLength} onChange={(e) => setCheckLength(e.target.value)} pattern="\d+(\.\d{1,6})?" /></div>
            <div><label htmlFor="cal-cunit">Unit</label><select id="cal-cunit" value={checkUnit} onChange={(e) => setCheckUnit(e.target.value as 'm' | 'mm')}><option value="m">metres</option><option value="mm">millimetres</option></select></div>
          </div>
        </fieldset>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          A second known dimension catches drawings that are not to scale. <button type="button" className="linkish" onClick={onAddCheck}>Add a check dimension</button> (then click both ends of it on the drawing).
        </p>
      )}
      <div className="inline">
        <button className="btn btn-primary btn-small" type="submit" disabled={busy}>Save scale</button>
        <button className="btn btn-small" type="button" onClick={onCancel}>Cancel</button>
      </div>
      <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
    </form>
  );
}

function SaveMeasurementForm({ revisionId, page, kind, points, layer, preview, onCancel, onSaved }: {
  revisionId: string; page: number; kind: Exclude<Tool, 'select' | 'calibrate'>; points: Pt[]; layer: string; preview: string | null; onCancel: () => void; onSaved: (m: Measurement) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form className="card stack-sm" aria-labelledby="save-h" onSubmit={async (e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError('');
      try {
        const m = await call<Measurement>(`/v1/revisions/${revisionId}/measurements`, { body: {
          page, kind, label: String(f.get('label')), layer, points, count: kind === 'count' ? points.length : undefined,
          depth: kind === 'volume' ? String(f.get('depth')) : undefined,
        } });
        onSaved(m);
      } catch (x) { setError(x instanceof ApiFailure ? x.message : errorText(x)); } finally { setBusy(false); }
    }}>
      <h3 id="save-h" style={{ margin: 0 }}>Save {KIND_LABEL[kind]?.toLowerCase()} {preview ? `(${preview})` : ''}</h3>
      <div className="row">
        <div><label htmlFor="ms-label">Name</label><input id="ms-label" name="label" required maxLength={120} placeholder="e.g. External walls, ground floor" autoFocus /></div>
        {kind === 'volume' && <div><label htmlFor="ms-depth">Depth or thickness (m)</label><input id="ms-depth" name="depth" inputMode="decimal" required pattern="\d+(\.\d{1,6})?" placeholder="0.15" /></div>}
      </div>
      <div className="inline">
        <button className="btn btn-primary btn-small" type="submit" disabled={busy}>Save measurement</button>
        <button className="btn btn-small" type="button" onClick={onCancel}>Discard</button>
      </div>
      <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
    </form>
  );
}

function ManualForm({ revisionId, page, layer, onSaved }: { revisionId: string; page: number; layer: string; onSaved: (m: Measurement) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef<HTMLFormElement>(null);
  return (
    <section className="card" aria-labelledby="manual-h">
      <h3 id="manual-h" style={{ marginTop: 0 }}>Manual measurement</h3>
      <p className="small muted">For quantities read from a schedule or worked out by hand. Record how you got the value.</p>
      <form ref={ref} className="stack-sm" onSubmit={async (e) => {
        e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError('');
        try {
          const m = await call<Measurement>(`/v1/revisions/${revisionId}/measurements`, { body: {
            page, kind: 'manual', label: String(f.get('label')), layer, manualValue: String(f.get('value')), manualUnit: String(f.get('unit')), formula: String(f.get('formula')),
          } });
          ref.current?.reset(); onSaved(m);
        } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
      }}>
        <label htmlFor="mn-label">Name</label>
        <input id="mn-label" name="label" required maxLength={120} />
        <div className="row">
          <div><label htmlFor="mn-value">Value</label><input id="mn-value" name="value" inputMode="decimal" required pattern="\d+(\.\d{1,6})?" /></div>
          <div><label htmlFor="mn-unit">Unit</label><select id="mn-unit" name="unit">{MANUAL_UNITS.map((u) => <option key={u} value={u}>{UNIT_LABEL[u] ?? u}</option>)}</select></div>
        </div>
        <label htmlFor="mn-formula">How it was worked out</label>
        <input id="mn-formula" name="formula" required maxLength={300} placeholder="e.g. 4 rooms × 3.6 m × 2.7 m from door schedule D-01" />
        <button className="btn btn-small" type="submit" disabled={busy}>Save manual measurement</button>
        <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
      </form>
    </section>
  );
}

function MeasurementTable({ items, page, disciplines, canDelete, canConfirm, onDelete, onConfirm }: {
  items: Measurement[]; page: number; disciplines: { code: string; label: string }[]; canDelete: boolean; canConfirm: boolean;
  onDelete: (m: Measurement) => void; onConfirm: (m: Measurement) => void;
}) {
  return (
    <section className="card" aria-labelledby="mt-h">
      <h3 id="mt-h" style={{ marginTop: 0 }}>Measurements on page {page} ({items.length})</h3>
      {items.length === 0 ? <p className="muted small" style={{ margin: 0 }}>None yet.</p> : (
        <div className="table-wrap">
          <table>
            <caption className="sr-only">Measurements on page {page}</caption>
            <thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col" className="num">Value</th><th scope="col">How</th><th scope="col">By</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
            <tbody>
              {items.map((m) => (
                <tr key={m.id}>
                  <th scope="row">{m.label}<div className="small muted">{disciplines.find((d) => d.code === m.layer)?.label ?? m.layer}</div></th>
                  <td className="small">{KIND_LABEL[m.kind] ?? m.kind}</td>
                  <td className="num">{fmtVal(m.value)} {UNIT_LABEL[m.unit] ?? m.unit}</td>
                  <td className="small">{m.derivation}</td>
                  <td className="small">{m.author ?? '—'}</td>
                  <td className="small">
                    {m.potentiallyAffected && <div><span className="pill pill-warn">⚠ May be affected</span></div>}
                    {m.confirmed ? <span className="pill pill-good">Confirmed by reviewer</span> : <span className="pill">Not reviewed</span>}
                  </td>
                  <td>
                    <div className="inline">
                      {canConfirm && (!m.confirmed || m.potentiallyAffected) && <button type="button" className="btn btn-small" onClick={() => onConfirm(m)} aria-label={`Confirm ${m.label}`}>Confirm</button>}
                      {canDelete && <button type="button" className="btn btn-small btn-danger" onClick={() => onDelete(m)} aria-label={`Delete ${m.label}`}>Delete</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function RfiForm({ projectId, revisionId, page }: { projectId: string; revisionId: string; page: number }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ id: string; number: number } | null>(null);
  const [error, setError] = useState('');
  return (
    <section className="card stack-sm" aria-labelledby="rfi-h">
      <h3 id="rfi-h" style={{ margin: 0 }}>Question about this page?</h3>
      {done && <p className="notice notice-good small" role="status" style={{ margin: 0 }}>RFI {done.number} raised. <Link href={`/projects/${projectId}/rfis/${done.id}`}>Open RFI {done.number}</Link></p>}
      {!open ? <div><button type="button" className="btn btn-small" onClick={() => { setOpen(true); setDone(null); }}>Raise an RFI on page {page}</button></div> : (
        <form className="stack-sm" onSubmit={async (e) => {
          e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError('');
          try {
            const r = await call<{ id: string; number: number }>(`/v1/projects/${projectId}/rfis`, { body: { subject: String(f.get('subject')), question: String(f.get('question')), revisionId, page } });
            setDone(r); setOpen(false);
          } catch (x) { setError(errorText(x)); } finally { setBusy(false); }
        }}>
          <label htmlFor="rfi-subject">Subject</label>
          <input id="rfi-subject" name="subject" required minLength={3} maxLength={200} />
          <label htmlFor="rfi-q">Question</label>
          <textarea id="rfi-q" name="question" required minLength={5} maxLength={4000} />
          <div className="inline">
            <button className="btn btn-small btn-primary" type="submit" disabled={busy}>Raise RFI</button>
            <button className="btn btn-small" type="button" onClick={() => setOpen(false)}>Cancel</button>
          </div>
          <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
        </form>
      )}
    </section>
  );
}
