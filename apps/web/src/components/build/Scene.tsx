'use client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Line, OrbitControls } from '@react-three/drei';
import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { roofPlanes, solidsFor, type Design, type Plot } from '@bw/domain';

/**
 * A true-scale model of the plot and the house: one unit is one metre, so the house sits on the land exactly as it
 * would in real life; the camera simply frames it to fit the screen. Plan x runs along the street frontage and plan
 * y into the plot; in the scene the street is toward the viewer (+Z) and Y is up.
 */
export type View = 'outside' | number; // a storey number shows that floor's plan with everything above removed

export interface SceneProps {
  plot: Plot;
  setbacks: { front: number; side: number; rear: number };
  design: Design | null;
  view: View;
  /** Changes when a new design is chosen, replaying the build-up animation. */
  buildKey: string;
  dark: boolean;
}

const PALETTE = {
  light: { ground: '#d9e3cf', plot: '#e9dfcc', boundary: '#5b4636', envelope: '#c2410c', road: '#3f3f46', slab: '#cfccc6', wallExt: '#f4efe7', wallInt: '#fbf9f5', glass: '#8fb8d8', door: '#7a4a2a', pad: '#a8a29e' },
  dark: { ground: '#1d2a1f', plot: '#3a3328', boundary: '#e7d7c2', envelope: '#fb7a2c', road: '#18181b', slab: '#57534e', wallExt: '#e7e1d6', wallInt: '#d6d0c4', glass: '#5b8db5', door: '#8a5a37', pad: '#44403c' },
};
const ROOF = { modern: '#3f3f46', classic: '#9a3b1f', tropical: '#4d6b57' } as const;

interface Label { id: string; at: [number, number, number]; text: string; sub?: string; cls: string }

export default function Scene(props: SceneProps) {
  const { plot } = props;
  const span = Math.max(plot.widthM, plot.depthM);
  const labels = useMemo(() => labelsFor(props), [props.plot, props.design, props.view]); // eslint-disable-line react-hooks/exhaustive-deps
  const els = useRef(new Map<string, HTMLDivElement>());
  return (
    <div className="scene-canvas">
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: 40, near: 0.1, far: span * 20, position: [span * 0.75, span * 0.85, span * 1.15] }}
      aria-label={description(props)}
      role="img"
    >
      <color attach="background" args={[props.dark ? '#0b0b0d' : '#f3f1ec']} />
      <hemisphereLight args={[props.dark ? '#cbd5e1' : '#ffffff', props.dark ? '#1f2937' : '#b8a98f', props.dark ? 0.7 : 0.9]} />
      <directionalLight position={[span * 0.6, span * 1.2, span * 0.8]} intensity={props.dark ? 1.2 : 1.6} castShadow shadow-mapSize={[2048, 2048]}>
        <orthographicCamera attach="shadow-camera" args={[-span, span, span, -span, 0.1, span * 4]} />
      </directionalLight>
      <Fit plot={plot} />
      <Site {...props} />
      {props.design && <House key={props.buildKey} {...props} design={props.design} />}
      <OrbitControls makeDefault enableDamping maxPolarAngle={Math.PI / 2.15} minDistance={4} maxDistance={span * 4} />
      <Projector labels={labels} els={els} />
    </Canvas>
    {/* One plain DOM layer for every label, positioned by the render loop (no extra React roots). */}
    <div className="scene-labels" aria-hidden="true">
      {labels.map((l) => (
        <div key={l.id} className={l.cls} ref={(el) => { if (el) els.current.set(l.id, el); else els.current.delete(l.id); }}>
          {l.text}{l.sub && <span>{l.sub}</span>}
        </div>
      ))}
    </div>
    </div>
  );
}

function labelsFor({ plot, design, view }: SceneProps): Label[] {
  const W = plot.widthM; const D = plot.depthM;
  const out: Label[] = [
    { id: 'front', at: [0, 0.1, D / 2 + 1.4], text: `${W} m frontage`, cls: 'scene-label' },
    { id: 'depth', at: [W / 2 + 1.2, 0.1, 0], text: `${D} m deep`, cls: 'scene-label' },
    { id: 'road', at: [0, 0.1, D / 2 + 4], text: 'Road', cls: 'scene-label scene-label-muted' },
  ];
  if (design && view !== 'outside') {
    const at = toScene(plot);
    for (const r of design.rooms.filter((x) => x.storey === view && x.kind !== 'corridor')) {
      const [X, Z] = at(r.x + r.w / 2, r.y + r.d / 2);
      out.push({ id: r.id, at: [X, view * design.storeyHeightM + 0.4, Z], text: r.name, sub: `${(r.w * r.d).toFixed(1)} m²`, cls: 'scene-room' });
    }
  }
  return out;
}

const tmp = new THREE.Vector3();
function Projector({ labels, els }: { labels: Label[]; els: React.RefObject<Map<string, HTMLDivElement>> }) {
  useFrame(({ camera, size }) => {
    for (const l of labels) {
      const el = els.current.get(l.id);
      if (!el) continue;
      tmp.set(...l.at).project(camera);
      const visible = tmp.z < 1 && Math.abs(tmp.x) < 1.2 && Math.abs(tmp.y) < 1.2;
      el.style.visibility = visible ? 'visible' : 'hidden';
      el.style.transform = `translate(${((tmp.x + 1) / 2) * size.width}px, ${((1 - tmp.y) / 2) * size.height}px) translate(-50%, -50%)`;
    }
  });
  return null;
}

function description({ plot, design }: SceneProps) {
  const base = `3D model of a ${plot.widthM} m by ${plot.depthM} m plot`;
  if (!design) return `${base}.`;
  return `${base} with a ${design.storeys === 2 ? 'two-storey' : 'single-storey'} house, ${design.footprint.w.toFixed(1)} m by ${design.footprint.d.toFixed(1)} m, drawn to scale.`;
}

/** Re-frames the camera whenever the plot size changes. */
function Fit({ plot }: { plot: Plot }) {
  const { camera, controls, size } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update: () => void } | null; size: { width: number; height: number } };
  const portrait = size.height > size.width;
  useEffect(() => {
    // Pull back on tall (phone) frames so the whole plot stays in view.
    const span = Math.max(plot.widthM, plot.depthM) * (portrait ? 1.45 : 1);
    camera.position.set(span * 0.75, span * 0.85, span * 1.15);
    camera.far = span * 20;
    camera.updateProjectionMatrix();
    controls?.target.set(0, 0, 0);
    controls?.update();
  }, [plot.widthM, plot.depthM, camera, controls, portrait]);
  return null;
}

const toScene = (plot: Plot) => (x: number, y: number) => [x - plot.widthM / 2, plot.depthM / 2 - y] as const;

function Site({ plot, setbacks, dark }: SceneProps) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  const at = toScene(plot);
  const W = plot.widthM; const D = plot.depthM;
  const corners: [number, number][] = [[0, 0], [W, 0], [W, D], [0, D]];
  const boundary = [...corners, corners[0]!].map(([x, y]) => { const [X, Z] = at(x, y); return new THREE.Vector3(X, 0.06, Z); });
  const env = [[setbacks.side, setbacks.front], [W - setbacks.side, setbacks.front], [W - setbacks.side, D - setbacks.rear], [setbacks.side, D - setbacks.rear], [setbacks.side, setbacks.front]]
    .map(([x, y]) => { const [X, Z] = at(x!, y!); return new THREE.Vector3(X, 0.07, Z); });
  const size = Math.max(W, D) * 4;
  const roadDepth = 7;
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[size, size]} />
        <meshStandardMaterial color={c.ground} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.01, D / 2 + roadDepth / 2 + 0.5]} receiveShadow>
        <planeGeometry args={[size, roadDepth]} />
        <meshStandardMaterial color={c.road} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]} receiveShadow>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial color={c.plot} />
      </mesh>
      <gridHelper args={[Math.ceil(Math.max(W, D)), Math.ceil(Math.max(W, D)), dark ? '#4a4237' : '#d6cab5', dark ? '#3d362d' : '#e0d5c2']} position={[0, 0.03, 0]} />
      <Line points={boundary} color={c.boundary} lineWidth={2.5} />
      <Line points={env} color={c.envelope} lineWidth={1.5} dashed dashSize={0.6} gapSize={0.4} />
      {corners.map(([x, y]) => { const [X, Z] = at(x, y); return (
        <mesh key={`${x},${y}`} position={[X, 0.25, Z]} castShadow>
          <cylinderGeometry args={[0.12, 0.12, 0.5, 12]} />
          <meshStandardMaterial color={c.boundary} />
        </mesh>
      ); })}
    </group>
  );
}

/** Each storey rises in turn, then the roof settles on top. Transform-only, and instant under reduced motion. */
function useBuildUp(groups: number) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const start = useRef<number | null>(null);
  const reduce = useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
  useFrame(({ clock }) => {
    if (start.current === null) start.current = clock.elapsedTime;
    const t = clock.elapsedTime - start.current;
    refs.current.forEach((g, i) => {
      if (!g) return;
      const p = reduce ? 1 : Math.min(1, Math.max(0, (t - i * 0.55) / 0.7));
      const e = 1 - (1 - p) ** 3;
      g.scale.y = Math.max(0.0001, e);
      g.visible = p > 0;
    });
  });
  return refs;
}

function House({ plot, design, view, dark }: SceneProps & { design: Design }) {
  const c = dark ? PALETTE.dark : PALETTE.light;
  const at = toScene(plot);
  const solids = useMemo(() => solidsFor(design), [design]);
  const top = view === 'outside' ? design.storeys : view + 1; // storeys shown
  const showRoof = view === 'outside';
  const refs = useBuildUp(design.storeys + 1);
  const roof = useMemo(() => roofGeometry(design, plot), [design, plot]);
  const H = design.storeyHeightM;

  return (
    <group>
      {design.parking.map((p, i) => { const [X, Z] = at(p.x + p.w / 2, p.y + p.d / 2); return (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[X, 0.04, Z]} receiveShadow>
          <planeGeometry args={[p.w, p.d]} />
          <meshStandardMaterial color={c.pad} />
        </mesh>
      ); })}
      {Array.from({ length: design.storeys + 1 }, (_, s) => (
        // Each storey's group scales from its own floor level.
        <group key={s} ref={(g) => { refs.current[s] = g; }} position={[0, s * H, 0]} visible={false}>
          {(s < top || (s === design.storeys && showRoof)) && solids.filter((b) => b.storey === s).map((b, i) => {
            const [X, Z] = at(b.cx, b.cy);
            const color = b.kind === 'slab' ? c.slab : b.external || b.kind === 'parapet' ? c.wallExt : c.wallInt;
            return (
              <mesh key={i} position={[X, b.cz - s * H, Z]} castShadow receiveShadow>
                <boxGeometry args={[b.sx, b.sz, b.sy]} />
                <meshStandardMaterial color={color} roughness={0.9} />
              </mesh>
            );
          })}
          {s < top && design.openings.filter((o) => o.storey === s).map((o) => {
            const mid = (o.from + o.to) / 2; const len = o.to - o.from; const h = o.headM - o.sillM;
            const [X, Z] = o.dir === 'h' ? at(mid, o.at) : at(o.at, mid);
            const rotY = o.dir === 'h' ? 0 : Math.PI / 2;
            return (
              <mesh key={o.id} position={[X, o.sillM + h / 2, Z]} rotation-y={rotY}>
                <boxGeometry args={[len, h, o.kind === 'door' ? 0.05 : 0.02]} />
                {o.kind === 'door'
                  ? <meshStandardMaterial color={c.door} roughness={0.7} />
                  : <meshPhysicalMaterial color={c.glass} transparent opacity={0.45} roughness={0.1} metalness={0.1} />}
              </mesh>
            );
          })}
          {s === design.storeys && showRoof && roof && (
            <mesh geometry={roof} position={[0, -s * H, 0]} castShadow>
              <meshStandardMaterial color={ROOF[design.brief.style]} side={THREE.DoubleSide} roughness={0.6} metalness={0.2} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

function roofGeometry(design: Design, plot: Plot): THREE.BufferGeometry | null {
  const planes = roofPlanes(design);
  if (!planes.length) return null;
  const at = toScene(plot);
  const pos: number[] = [];
  for (const poly of planes) {
    const pts = poly.map(([x, y, z]) => { const [X, Z] = at(x, y); return [X, z, Z] as const; });
    for (let i = 1; i + 1 < pts.length; i++) for (const p of [pts[0]!, pts[i]!, pts[i + 1]!]) pos.push(p[0], p[1], p[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}
