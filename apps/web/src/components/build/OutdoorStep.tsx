'use client';
import { useRef, useState } from 'react';
import { MousePointer2, Trash2 } from 'lucide-react';
import { type Design, type Landscape, type LandscapeItem, type LandscapeOptions, type PlaceableKind } from '@bw/domain';
import { Nav, StepHead, type StepRef } from './ui';

type Tool = 'pick' | PlaceableKind;
const TOOL_LABEL: Record<Tool, string> = { pick: 'Select / remove', tree: 'Tree', palm: 'Palm', shrub: 'Shrub', bed: 'Flower bed', light: 'Light' };

/**
 * Landscaping: choose the boundary, paving and garden, then place or remove individual trees, shrubs, beds and
 * lights on the site plan. Everything shows in 3D and goes into the materials list as external works.
 */
export function OutdoorStep({ stepRef, kicker, design, landscape, options, setOptions, next = 'List the materials', onBack, onNext }: {
  stepRef: StepRef; kicker: string; design: Design; landscape: Landscape | null; options: LandscapeOptions;
  setOptions: (o: LandscapeOptions) => void; next?: string; onBack: () => void; onNext: () => void;
}) {
  const set = <K extends keyof LandscapeOptions>(k: K, v: LandscapeOptions[K]) => setOptions({ ...options, [k]: v });
  const [tool, setTool] = useState<Tool>('pick');
  const [picked, setPicked] = useState<string | null>(null);
  const items = landscape?.items ?? [];
  const sel = items.find((i) => i.id === picked) ?? null;

  const remove = (it: LandscapeItem) => {
    if (it.placed) {
      const i = Number(it.id.replace('added-', ''));
      set('added', options.added.filter((_, k) => k !== i));
    } else set('removed', [...options.removed, it.id]);
    setPicked(null);
  };
  const place = (x: number, y: number) => { if (tool !== 'pick') set('added', [...options.added, { kind: tool, x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }]); };

  const count = (k: LandscapeItem['kind']) => items.filter((i) => i.kind === k).length;
  const len = items.filter((i) => i.kind === 'fence').reduce((s, f) => s + Math.max(f.w, f.d), 0);
  const paved = items.filter((i) => i.kind === 'paving').reduce((s, p) => s + p.w * p.d, 0);

  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker={kicker} title="Landscape your plot">Choose the fence, gate, paving and garden, then place trees, shrubs, flower beds and lights where you want them. It all appears in 3D and in the materials list.</StepHead>

      <div className="brief-grid">
        <fieldset className="field stack-sm">
          <legend className="label">Boundary</legend>
          <label htmlFor="ls-fence" className="small">Fence</label>
          <select id="ls-fence" value={options.fence} onChange={(e) => set('fence', e.target.value as LandscapeOptions['fence'])}>
            <option value="block">Block wall, 2.1 m</option><option value="block-railing">Block wall with steel railing</option><option value="none">No fence</option>
          </select>
          {options.fence !== 'none' && (
            <div className="segs" role="radiogroup" aria-label="Gate">
              {(['sliding', 'swing'] as const).map((g) => <label key={g} className={`seg${options.gate === g ? ' on' : ''}`}><input type="radio" name="ls-gate" checked={options.gate === g} onChange={() => set('gate', g)} />{g === 'sliding' ? 'Sliding gate' : 'Swing gate'}</label>)}
            </div>
          )}
        </fieldset>
        <fieldset className="field stack-sm">
          <legend className="label">Paving</legend>
          <label htmlFor="ls-drive" className="small">Driveway</label>
          <select id="ls-drive" value={options.driveway} onChange={(e) => set('driveway', e.target.value as LandscapeOptions['driveway'])}>
            <option value="interlock">Interlocking paving stones</option><option value="concrete">Concrete</option><option value="gravel">Gravel</option><option value="none">No driveway</option>
          </select>
          <label className="check"><input type="checkbox" checked={options.walkway} onChange={(e) => set('walkway', e.target.checked)} /> Walkway to the front door</label>
          <label className="check"><input type="checkbox" checked={options.apron} onChange={(e) => set('apron', e.target.checked)} /> Paved apron round the house</label>
        </fieldset>
        <fieldset className="field stack-sm">
          <legend className="label">Garden</legend>
          <label className="check"><input type="checkbox" checked={options.lawn} onChange={(e) => set('lawn', e.target.checked)} /> Lawn (carpet grass)</label>
          <label htmlFor="ls-trees" className="small">Trees and palms</label>
          <select id="ls-trees" value={options.trees} onChange={(e) => set('trees', e.target.value as LandscapeOptions['trees'])}>
            <option value="few">A few, round the edges</option><option value="many">Many, a green boundary</option><option value="none">None</option>
          </select>
          <label className="check"><input type="checkbox" checked={options.hedge} onChange={(e) => set('hedge', e.target.checked)} /> Hedge along the front</label>
          <label className="check"><input type="checkbox" checked={options.flowerBeds} onChange={(e) => set('flowerBeds', e.target.checked)} /> Flower beds in front of the house</label>
        </fieldset>
        <fieldset className="field stack-sm">
          <legend className="label">Extras</legend>
          <label className="check"><input type="checkbox" checked={options.pool} onChange={(e) => set('pool', e.target.checked)} /> Swimming pool</label>
          <label className="check"><input type="checkbox" checked={options.gazebo} onChange={(e) => set('gazebo', e.target.checked)} /> Gazebo</label>
          <label className="check"><input type="checkbox" checked={options.lights} onChange={(e) => set('lights', e.target.checked)} /> Garden and gate lights</label>
        </fieldset>
      </div>

      <div className="editor-bar" role="radiogroup" aria-label="Site plan tool">
        {(Object.keys(TOOL_LABEL) as Tool[]).map((t) => (
          <label key={t} className={`seg${tool === t ? ' on' : ''}`}>
            <input type="radio" name="ls-tool" checked={tool === t} onChange={() => { setTool(t); setPicked(null); }} />
            {t === 'pick' && <MousePointer2 size={14} aria-hidden="true" />} {t === 'pick' ? TOOL_LABEL[t] : `Place ${TOOL_LABEL[t].toLowerCase()}`}
          </label>
        ))}
      </div>
      <SitePlan design={design} items={items} tool={tool} picked={picked} onPick={setPicked} onPlace={place} />
      <p className="small muted" role="status">
        {tool === 'pick' ? 'Click an item to select it, then remove it.' : `Click on the plot to place a ${TOOL_LABEL[tool].toLowerCase()}.`}
        {' '}{len ? `Fence ${Math.round(len)} m · ` : ''}{paved ? `${Math.round(paved)} m² paving · ` : ''}{count('tree') + count('palm')} trees and palms · {count('light')} lights
      </p>
      {sel && (
        <div className="row wrap">
          <span><strong>{sel.label}</strong>{sel.placed ? ' (placed by you)' : ''}</span>
          <button type="button" className="btn btn-small" onClick={() => remove(sel)}><Trash2 size={14} aria-hidden="true" /> Remove</button>
        </div>
      )}
      {options.removed.length > 0 && <p className="small"><button type="button" className="btn btn-small btn-ghost" onClick={() => set('removed', [])}>Bring back {options.removed.length} removed item{options.removed.length > 1 ? 's' : ''}</button></p>}
      {landscape?.notes.map((n) => <p key={n} className="notice notice-warn small" role="status">{n}</p>)}
      <Nav onBack={onBack} onNext={onNext} next={next} />
    </div>
  );
}

const FILL: Partial<Record<LandscapeItem['kind'], string>> = {
  lawn: 'ls-lawn', paving: 'ls-paving', fence: 'ls-fence', gate: 'ls-gate', hedge: 'ls-hedge', bed: 'ls-bed', pool: 'ls-pool', gazebo: 'ls-gazebo',
};

function SitePlan({ design, items, tool, picked, onPick, onPlace }: {
  design: Design; items: LandscapeItem[]; tool: Tool; picked: string | null; onPick: (id: string | null) => void; onPlace: (x: number, y: number) => void;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const W = design.plot.widthM; const D = design.plot.depthM;
  const Y = (y: number) => D - y;
  const click = (ev: React.MouseEvent) => {
    if (tool === 'pick') { if (ev.target === svg.current) onPick(null); return; }
    const el = svg.current!; const pt = el.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(el.getScreenCTM()!.inverse());
    onPlace(p.x, D - p.y);
  };
  const order: LandscapeItem['kind'][] = ['lawn', 'paving', 'bed', 'hedge', 'pool', 'gazebo', 'fence', 'gate', 'shrub', 'palm', 'tree', 'light'];
  const sorted = [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return (
    <div className="site-editor">
      <svg ref={svg} viewBox={`-1 -1 ${W + 2} ${D + 4}`} role="group" aria-label="Site plan: click to place or select" onClick={click} className={tool === 'pick' ? '' : 'placing'}>
        <rect x={0} y={0} width={W} height={D} className="ls-plot" />
        <rect x={-1} y={D} width={W + 2} height={3} className="ls-road" />
        <text x={W / 2} y={D + 2} fontSize={0.9} textAnchor="middle" className="ls-road-label">ROAD</text>
        {sorted.map((it) => {
          const on = it.id === picked;
          const common = {
            className: `${FILL[it.kind] ?? `ls-${it.kind}`}${on ? ' on' : ''}`,
            onClick: (e: React.MouseEvent) => { if (tool === 'pick' && it.kind !== 'lawn') { e.stopPropagation(); onPick(it.id); } },
          };
          if (it.kind === 'tree' || it.kind === 'palm' || it.kind === 'shrub' || it.kind === 'light') {
            return <circle key={it.id} {...common} cx={it.x + it.w / 2} cy={Y(it.y + it.d / 2)} r={Math.max(it.w / 2, 0.25)}><title>{it.label}</title></circle>;
          }
          return <rect key={it.id} {...common} x={it.x} y={Y(it.y + it.d)} width={it.w} height={it.d}><title>{it.label}</title></rect>;
        })}
        {design.blocks.map((b) => <rect key={b.id} x={b.x} y={Y(b.y + b.d)} width={b.w} height={b.d} className="ls-house" />)}
        {design.parking.map((p, i) => <rect key={i} x={p.x} y={Y(p.y + p.d)} width={p.w} height={p.d} className="ls-park" />)}
      </svg>
    </div>
  );
}

