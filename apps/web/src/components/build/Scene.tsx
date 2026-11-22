'use client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { ContactShadows, Environment, Lightformer, Line, OrbitControls, Sky } from '@react-three/drei';
import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { isVerticalPlane, roofPlanes, solidsFor, type Design, type Landscape, type LandscapeItem, type Plot } from '@bw/domain';

/**
 * A true-scale model of the plot and the building: one unit is one metre, so the building sits on the land exactly as
 * it would in real life; the camera simply frames it to fit the screen. Plan x runs along the street frontage and plan
 * y into the plot; in the scene the street is toward the viewer (+Z) and Y is up.
 *
 * Two looks share the same geometry: `model` (the default) is the clean massing model; `photo` is an architectural
 * visualisation with a low warm sun, procedural sky, reflections, materials by style and facade detail (frames,
 * mullions, plinth, slab bands, copings), all drawn from the design data.
 */
export type View = 'outside' | number; // a storey number shows that floor's plan with everything above removed
export type SceneMode = 'model' | 'photo';

export interface SceneProps {
  plot: Plot;
  setbacks: { front: number; side: number; rear: number };
  design: Design | null;
  view: View;
  /** Changes when a new design is chosen, replaying the build-up animation. */
  buildKey: string;
  dark: boolean;
  /** Landscaping to draw round the building (fence, paving, garden), when the person has planned it. */
  landscape?: Landscape | null;
  /** 'model' (default) is the plain massing model; 'photo' is the polished architectural look. */
  mode?: SceneMode;
  /** A slow orbit round the building. Off under reduced motion; stops as soon as the person drags or zooms. */
  autoRotate?: boolean;
  /** Set to a function that renders one frame and returns the canvas as a PNG data URL (null if it fails). */
  captureRef?: { current: (() => string | null) | null };
}

const PALETTE = {
  light: { ground: '#d9e3cf', plot: '#e9dfcc', boundary: '#5b4636', envelope: '#c2410c', road: '#3f3f46', slab: '#cfccc6', wallExt: '#f4efe7', wallInt: '#fbf9f5', glass: '#8fb8d8', door: '#7a4a2a', pad: '#a8a29e' },
  dark: { ground: '#1d2a1f', plot: '#3a3328', boundary: '#e7d7c2', envelope: '#fb7a2c', road: '#18181b', slab: '#57534e', wallExt: '#e7e1d6', wallInt: '#d6d0c4', glass: '#5b8db5', door: '#8a5a37', pad: '#44403c' },
};

interface Label { id: string; at: [number, number, number]; text: string; sub?: string; cls: string }

export default function Scene(props: SceneProps) {
  const { plot, design } = props;
  const photo = props.mode === 'photo';
  const span = Math.max(plot.widthM, plot.depthM);
  const bounds = useMemo(() => boundsOf(plot, design), [plot, design]);
  // Everything that scales with the scene (camera, shadows) follows the plot, or a tall building when it is taller.
  const reach = Math.max(span, bounds.height * 1.4);
  const labels = useMemo(() => labelsFor(props), [props.plot, props.design, props.view, photo]); // eslint-disable-line react-hooks/exhaustive-deps
  const els = useRef(new Map<string, HTMLDivElement>());
  const reduce = useReducedMotion();
  const [userMoved, setUserMoved] = useState(false);
  useEffect(() => { setUserMoved(false); }, [props.autoRotate, props.buildKey]);
  const rotate = !!props.autoRotate && !reduce && !userMoved;
  const sky = skyDistance(reach);
  return (
    <div className="scene-canvas">
    <Canvas
      shadows
      dpr={[1, 2]}
      camera={{ fov: 40, near: 0.1, far: span * 20, position: [span * 0.75, span * 0.85, span * 1.15] }}
      aria-label={description(props)}
      role="img"
    >
      {photo
        ? <PhotoLighting reach={reach} plot={plot} height={bounds.height} dusk={props.dark} />
        : <ModelLighting reach={reach} dark={props.dark} />}
      <Fit plot={plot} photo={photo} plan={props.view !== 'outside'} bounds={bounds} reach={reach} skyFar={sky * 2} />
      {photo ? <PhotoSite plot={plot} reach={reach} /> : <Site {...props} />}
      {design && <House key={props.buildKey} {...props} design={design} photo={photo} />}
      {photo && design && <GroundContact key={`${props.buildKey}:${designSerial(design)}`} bounds={bounds} />}
      {props.landscape && <Grounds plot={plot} items={props.landscape.items} dark={props.dark} photo={photo} />}
      <OrbitControls
        makeDefault enableDamping
        maxPolarAngle={photo ? Math.PI / 2.06 : Math.PI / 2.15}
        minDistance={4} maxDistance={reach * (photo ? 5 : 4)}
        autoRotate={rotate} autoRotateSpeed={0.55}
        onStart={() => { if (props.autoRotate) setUserMoved(true); }}
      />
      <Projector labels={labels} els={els} />
      {props.captureRef && <Capture target={props.captureRef} />}
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

function useReducedMotion() {
  return useMemo(() => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches, []);
}

function labelsFor({ plot, design, view, mode }: SceneProps): Label[] {
  const W = plot.widthM; const D = plot.depthM;
  // The photo look is a clean picture: plot dimensions stay in the model view; room names still show on floor plans.
  const out: Label[] = mode === 'photo' ? [] : [
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

// ---------------------------------------------------------------- description (the canvas's accessible name)

const TYPE_LABEL: Record<string, string> = {
  bungalow: 'bungalow', duplex: 'duplex', terrace: 'terrace', apartments: 'apartment building', shops: 'shopping block',
  office: 'office building', 'mixed-use': 'mixed-use building', warehouse: 'warehouse', hotel: 'hotel', 'event-hall': 'event hall',
  school: 'school', clinic: 'clinic', worship: 'place of worship',
};
const STOREY_WORDS = ['', 'single', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const typeOfBrief = (d: Design): string | undefined => {
  const t = (d.brief as { type?: unknown }).type;
  return typeof t === 'string' ? t : undefined;
};

function description({ plot, design }: SceneProps) {
  const base = `3D model of a ${plot.widthM} m by ${plot.depthM} m plot`;
  if (!design) return `${base}.`;
  const n = Math.max(1, Math.round(design.storeys));
  const storeys = `${STOREY_WORDS[n] ?? String(n)}-storey`;
  const type = typeOfBrief(design);
  const what = type ? TYPE_LABEL[type] ?? type.replace(/-/g, ' ') : 'house';
  const article = /^(8|11-|18-|eight)/.test(storeys) ? 'an' : 'a';
  return `${base} with ${article} ${storeys} ${what}, ${design.footprint.w.toFixed(1)} m by ${design.footprint.d.toFixed(1)} m, drawn to scale.`;
}

// ---------------------------------------------------------------- framing

interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number; height: number; key: string }

/** The building's box in scene metres (blocks, outbuildings and parking), or the plot when there is no design. */
function boundsOf(plot: Plot, design: Design | null): Bounds {
  const W = plot.widthM; const D = plot.depthM;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, height = 0;
  if (design) {
    for (const r of [...design.blocks, ...design.parking]) {
      minX = Math.min(minX, r.x - W / 2); maxX = Math.max(maxX, r.x + r.w - W / 2);
      minZ = Math.min(minZ, D / 2 - (r.y + r.d)); maxZ = Math.max(maxZ, D / 2 - r.y);
    }
    const H = design.storeyHeightM;
    height = design.storeys * H;
    if (design.roof.kind === 'flat' || design.roof.kind === 'hidden') height += design.slabM + design.roof.parapetM + 0.06;
    for (const p of roofPlanes(design)) for (const v of p) height = Math.max(height, v[2]);
  }
  if (!Number.isFinite(minX)) { minX = -W / 2; maxX = W / 2; minZ = -D / 2; maxZ = D / 2; }
  const key = [minX, maxX, minZ, maxZ, height].map((v) => v.toFixed(1)).join(',');
  return { minX, maxX, minZ, maxZ, height, key };
}

/**
 * The photo camera: a three-quarter view from the street side, slightly low, pulled back just far enough that every
 * corner of the building's box (plus a margin) is inside the frustum, so a 10-storey block is framed as well as a bungalow.
 */
function photoFrame(b: Bounds, fovDeg: number, aspect: number, plan = false) {
  // Floor plans are read from higher up; the outside view stays near eye level.
  const az = THREE.MathUtils.degToRad(34); const el = THREE.MathUtils.degToRad(plan ? 40 : b.height > 14 ? 9 : 11);
  const m = 1.6; // metres of ground round the building
  const x0 = b.minX - m, x1 = b.maxX + m, z0 = b.minZ - m, z1 = b.maxZ + m, h = Math.max(b.height, 2.5);
  const target = new THREE.Vector3((x0 + x1) / 2, h * 0.42, (z0 + z1) / 2);
  const back = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
  const right = new THREE.Vector3(Math.cos(az), 0, -Math.sin(az));
  const up = new THREE.Vector3().crossVectors(back, right).normalize();
  const tanV = Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)); const tanH = tanV * Math.max(0.3, aspect);
  let d = 12;
  const v = new THREE.Vector3();
  for (const x of [x0, x1]) for (const y of [0, h]) for (const z of [z0, z1]) {
    v.set(x, y, z).sub(target);
    const along = v.dot(back);
    d = Math.max(d, along + Math.abs(v.dot(right)) / tanH, along + Math.abs(v.dot(up)) / tanV);
  }
  d *= 1.08;
  return { position: target.clone().addScaledVector(back, d), target };
}

/** Re-frames the camera whenever the plot, the building's size or the look changes. */
function Fit({ plot, photo, plan, bounds, reach, skyFar }: { plot: Plot; photo: boolean; plan: boolean; bounds: Bounds; reach: number; skyFar: number }) {
  const { camera, controls, size } = useThree() as unknown as { camera: THREE.PerspectiveCamera; controls: { target: THREE.Vector3; update: () => void } | null; size: { width: number; height: number } };
  const portrait = size.height > size.width;
  const aspect = Math.round((size.width / Math.max(1, size.height)) * 4) / 4;
  useEffect(() => {
    if (photo) {
      const f = photoFrame(bounds, camera.fov, aspect, plan);
      camera.position.copy(f.position);
      camera.near = 0.5;
      camera.far = skyFar;
      camera.updateProjectionMatrix();
      controls?.target.copy(f.target);
    } else {
      // Pull back on tall (phone) frames so the whole plot stays in view; aim higher at a building taller than the
      // plot is wide (zero for houses, so their framing is unchanged).
      const span = reach * (portrait ? 1.45 : 1);
      const lift = Math.max(0, bounds.height * 0.5 - Math.max(plot.widthM, plot.depthM) * 0.3);
      camera.position.set(span * 0.75, span * 0.85 + lift, span * 1.15);
      camera.near = 0.1;
      camera.far = span * 20;
      camera.updateProjectionMatrix();
      controls?.target.set(0, lift, 0);
    }
    controls?.update();
  }, [plot.widthM, plot.depthM, camera, controls, portrait, photo, bounds.key, reach, photo ? aspect : 0, photo && plan, skyFar]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

/** Renders one frame and reads it back in the same tick, so the canvas never needs preserveDrawingBuffer. */
function Capture({ target }: { target: { current: (() => string | null) | null } }) {
  const { gl, scene, camera, size } = useThree();
  useEffect(() => {
    const fn = () => {
      try {
        const prev = gl.getPixelRatio();
        // At least twice the CSS size (capped at 2560 px wide) so the image is crisp for downloads and renders.
        const ratio = Math.max(prev, Math.min(2, 2560 / Math.max(1, size.width)));
        if (ratio !== prev) gl.setPixelRatio(ratio);
        gl.render(scene, camera);
        const url = gl.domElement.toDataURL('image/png');
        if (ratio !== prev) { gl.setPixelRatio(prev); gl.render(scene, camera); }
        return url;
      } catch {
        return null;
      }
    };
    target.current = fn;
    return () => { if (target.current === fn) target.current = null; };
  }, [target, gl, scene, camera, size.width]);
  return null;
}

const toScene = (plot: Plot) => (x: number, y: number) => [x - plot.widthM / 2, plot.depthM / 2 - y] as const;

// ---------------------------------------------------------------- lighting

function ModelLighting({ reach, dark }: { reach: number; dark: boolean }) {
  return (
    <>
      <color attach="background" args={[dark ? '#0b0b0d' : '#f3f1ec']} />
      <hemisphereLight args={[dark ? '#cbd5e1' : '#ffffff', dark ? '#1f2937' : '#b8a98f', dark ? 0.7 : 0.9]} />
      <directionalLight position={[reach * 0.6, reach * 1.2, reach * 0.8]} intensity={dark ? 1.2 : 1.6} castShadow shadow-mapSize={[2048, 2048]}>
        <orthographicCamera attach="shadow-camera" args={[-reach, reach, reach, -reach, 0.1, reach * 4]} />
      </directionalLight>
      <Exposure value={1} />
    </>
  );
}

/** Two moods: a warm mid-morning sun (light theme) and golden hour with lit windows (dark theme). */
const MOODS = {
  day: {
    elev: 27, az: 52, sun: '#ffe6c4', sunI: 3.1, hemiSky: '#d3e3f5', hemiGround: '#8f7d5f', hemi: 0.5, env: 0.75, exposure: 0.95,
    fog: '#dfe5e8', turbidity: 5, rayleigh: 1.8, mie: 0.003, mieG: 0.8, envSky: '#c7d9ec', envGround: '#7a7360', envSun: 3.2,
  },
  dusk: {
    elev: 8, az: 64, sun: '#ffa463', sunI: 2.2, hemiSky: '#7385b8', hemiGround: '#3d3029', hemi: 0.5, env: 0.5, exposure: 0.8,
    fog: '#a8928c', turbidity: 9, rayleigh: 2.6, mie: 0.006, mieG: 0.86, envSky: '#5a6790', envGround: '#2e2723', envSun: 2.4,
  },
};

const skyDistance = (reach: number) => Math.max(3000, reach * 60);

/** From the street-left, so the street front is lit and the side the camera sees is in soft shade. */
function sunDirection(elevDeg: number, azDeg: number) {
  const e = THREE.MathUtils.degToRad(elevDeg); const a = THREE.MathUtils.degToRad(azDeg);
  return new THREE.Vector3(-Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

function PhotoLighting({ reach, plot, height, dusk }: { reach: number; plot: Plot; height: number; dusk: boolean }) {
  const m = dusk ? MOODS.dusk : MOODS.day;
  const dir = useMemo(() => sunDirection(m.elev, m.az), [m]);
  // The shadow camera must hold the plot, the road and a tall building's long shadow.
  const half = Math.max(plot.widthM, plot.depthM) / 2 + 14 + height * 0.95;
  const R = reach * 3 + height;
  const res = half > 45 ? 4096 : 2048;
  const sky = skyDistance(reach);
  return (
    <>
      <color attach="background" args={[m.fog]} />
      <fog attach="fog" args={[m.fog, reach * 4, reach * 22]} />
      <Sky distance={sky} sunPosition={[dir.x, dir.y, dir.z]} turbidity={m.turbidity} rayleigh={m.rayleigh} mieCoefficient={m.mie} mieDirectionalG={m.mieG} />
      <hemisphereLight args={[m.hemiSky, m.hemiGround, m.hemi]} />
      <directionalLight
        key={res}
        position={[dir.x * R, dir.y * R, dir.z * R]} color={m.sun} intensity={m.sunI}
        castShadow shadow-mapSize={[res, res]} shadow-bias={-0.0002} shadow-normalBias={0.035}
      >
        <orthographicCamera attach="shadow-camera" args={[-half, half, half, -half, 0.5, R + half * 2.5]} />
      </directionalLight>
      {/* Reflections from an offline studio of light panels: no HDR file is fetched. */}
      <Environment resolution={256} frames={1} environmentIntensity={m.env}>
        <color attach="background" args={[m.envSky]} />
        <Lightformer form="rect" intensity={0.9} color="#ffffff" position={[0, 30, 0]} rotation={[Math.PI / 2, 0, 0]} scale={[80, 80, 1]} />
        <Lightformer form="rect" intensity={0.6} color={m.envGround} position={[0, -3, 0]} rotation={[-Math.PI / 2, 0, 0]} scale={[120, 120, 1]} />
        <Lightformer form="rect" intensity={m.envSun} color={m.sun} position={[dir.x * 20, Math.max(3, dir.y * 20), dir.z * 20]} target={[0, 0, 0]} scale={[14, 5, 1]} />
        <Lightformer form="rect" intensity={1.1} color="#e3ecff" position={[18, 6, -14]} target={[0, 0, 0]} scale={[26, 3, 1]} />
        <Lightformer form="rect" intensity={0.8} color="#fff4e6" position={[-22, 4, -6]} target={[0, 0, 0]} scale={[18, 2, 1]} />
        <Lightformer form="ring" intensity={0.7} color="#ffffff" position={[6, 12, 22]} target={[0, 0, 0]} scale={6} />
      </Environment>
      <Exposure value={m.exposure} />
    </>
  );
}

/** ACES filmic tone mapping and sRGB output are react-three-fiber's defaults; the mood only sets the exposure. */
function Exposure({ value }: { value: number }) {
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = value;
  }, [gl, value]);
  return null;
}

/** Soft contact shadow under the building; it re-renders through the build-up animation, then holds still. */
function GroundContact({ bounds }: { bounds: Bounds }) {
  const w = bounds.maxX - bounds.minX; const d = bounds.maxZ - bounds.minZ;
  return (
    <ContactShadows
      position={[(bounds.minX + bounds.maxX) / 2, 0.05, (bounds.minZ + bounds.maxZ) / 2]}
      scale={[w + 8, d + 8]} resolution={1024} blur={2.6} opacity={0.55} far={Math.min(6, Math.max(2, bounds.height))}
      frames={600} color="#1d1a16"
    />
  );
}

let serial = 0;
const serials = new WeakMap<Design, number>();
function designSerial(d: Design) {
  let n = serials.get(d);
  if (n === undefined) { n = ++serial; serials.set(d, n); }
  return n;
}

// ---------------------------------------------------------------- site

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

// Deterministic value noise, for grass colour variation and for scattering context trees.
function hash2(x: number, y: number) { const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453; return s - Math.floor(s); }
function vnoise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi), c = hash2(xi, yi + 1), d = hash2(xi + 1, yi + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
const fbm = (x: number, y: number) => vnoise(x, y) * 0.6 + vnoise(x * 2.3 + 5.2, y * 2.3 + 1.3) * 0.3 + vnoise(x * 5.1 + 9.7, y * 5.1 + 3.1) * 0.1;

/** A ground plane with gently varying grass colour; with `fade` the variation dies out at the edges into the base colour. */
function grassPlane(w: number, d: number, base: string, amp: number, cell: number, fade: boolean) {
  const sw = Math.min(160, Math.max(4, Math.ceil((w / cell) * 4))); const sd = Math.min(160, Math.max(4, Math.ceil((d / cell) * 4)));
  const g = new THREE.PlaneGeometry(w, d, sw, sd);
  const pos = g.attributes.position!;
  const col = new Float32Array(pos.count * 3);
  const c0 = new THREE.Color(base); const dry = new THREE.Color('#b3a866'); const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    let k = 1;
    if (fade) k = Math.min(1, Math.min(w / 2 - Math.abs(x), d / 2 - Math.abs(y)) / (0.2 * Math.min(w, d)));
    const n = fbm(x / cell, y / cell) * k; const n2 = Math.max(0, vnoise(x / (cell * 2.7) + 17, y / (cell * 2.7) + 4)) * k;
    c.copy(c0).multiplyScalar(1 + amp * n).lerp(dry, 0.35 * n2);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

const SITE = { field: '#88956a', lawn: '#6f924f', asphalt: '#45474b', kerb: '#cfcbc2', footway: '#bfb9ad', marking: '#f2efe6', boundary: '#d9d4c9' };

function PhotoSite({ plot, reach }: { plot: Plot; reach: number }) {
  const W = plot.widthM; const D = plot.depthM;
  const G = skyDistance(reach) * 0.8; // the far ground stops inside the sky dome
  const patch = Math.max(W, D) * 5 + 80;
  const field = useMemo(() => grassPlane(patch, patch, SITE.field, 0.16, 7, true), [patch]);
  const lawn = useMemo(() => grassPlane(W, D, SITE.lawn, 0.1, 3, false), [W, D]);
  const roadW = 7; const road0 = D / 2 + 0.5; const roadZ = road0 + roadW / 2;
  const dashes = useMemo(() => {
    const b = new BoxBuilder(); const L = Math.min(G / 2, reach * 10);
    for (let x = -L; x < L; x += 7.5) b.add(x, 0, 0, 3, 0.004, 0.12);
    return b.geometry();
  }, [G, reach]);
  const trees = useMemo(() => {
    const out: { x: number; z: number; size: number; seed: number }[] = [];
    const L = Math.max(W / 2 + 26, 40);
    // Neighbours' trees: a loose belt behind the plot and a few along the rear half of each side, never between the
    // street-side camera and the building. Street trees stand on the far footway, left of the plot (the camera looks from the right).
    for (let x = -L, i = 0; x <= L; x += 8.5, i++) out.push({ x: x + (hash2(i, 5) - 0.5) * 4, z: -D / 2 - 4 - hash2(i, 6) * 6, size: 5 + hash2(i, 7) * 2.5, seed: i + 50 });
    for (let z = -D / 2 + 3, i = 0; z < -2; z += 9, i++) {
      out.push({ x: -W / 2 - 3.5 - hash2(i, 8) * 3, z: z + hash2(i, 9) * 3, size: 4.5 + hash2(i, 10) * 2, seed: i + 100 });
      out.push({ x: W / 2 + 3.5 + hash2(i, 11) * 3, z: z + hash2(i, 12) * 3, size: 4.5 + hash2(i, 13) * 2, seed: i + 150 });
    }
    for (let x = -L, i = 0; x <= L; x += 12, i++) {
      const tx = x + (hash2(i, 1) - 0.5) * 3;
      if (tx < -W / 2 - 10) out.push({ x: tx, z: roadZ + roadW / 2 + 1.3, size: 4.4 + hash2(i, 2) * 1.6, seed: i });
    }
    return out;
  }, [W, D, roadZ]);
  const at = toScene(plot);
  const edges: [number, number, number, number][] = [[W / 2, 0, W + 0.12, 0.12], [W / 2, D, W + 0.12, 0.12], [0, D / 2, 0.12, D], [W, D / 2, 0.12, D]];
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.04, 0]} receiveShadow>
        <planeGeometry args={[G, G]} />
        <meshStandardMaterial color={SITE.field} roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.015, 0]} geometry={field} receiveShadow>
        <meshStandardMaterial vertexColors roughness={1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.02, 0]} geometry={lawn} receiveShadow>
        <meshStandardMaterial vertexColors roughness={0.95} />
      </mesh>
      {edges.map(([x, y, w, d], i) => { const [X, Z] = at(x, y); return (
        <mesh key={i} position={[X, 0.06, Z]} castShadow receiveShadow><boxGeometry args={[w, 0.1, d]} /><meshStandardMaterial color={SITE.boundary} roughness={0.85} /></mesh>
      ); })}
      {/* Verge, road with kerbs and markings, far footway. */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.012, D / 2 + 0.25]} receiveShadow><planeGeometry args={[G, 0.5]} /><meshStandardMaterial color={SITE.footway} roughness={0.9} /></mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.008, roadZ]} receiveShadow><planeGeometry args={[G, roadW]} /><meshStandardMaterial color={SITE.asphalt} roughness={0.92} /></mesh>
      {[road0 - 0.09, road0 + roadW + 0.09].map((z) => (
        <mesh key={z} position={[0, 0.07, z]} castShadow receiveShadow><boxGeometry args={[G, 0.14, 0.18]} /><meshStandardMaterial color={SITE.kerb} roughness={0.8} /></mesh>
      ))}
      <mesh position={[0, 0.065, road0 + roadW + 0.18 + 1.1]} receiveShadow><boxGeometry args={[G, 0.13, 2.2]} /><meshStandardMaterial color={SITE.footway} roughness={0.9} /></mesh>
      {[road0 + 0.35, road0 + roadW - 0.35].map((z) => (
        <mesh key={z} rotation-x={-Math.PI / 2} position={[0, 0.011, z]}><planeGeometry args={[G, 0.1]} /><meshStandardMaterial color={SITE.marking} roughness={0.7} /></mesh>
      ))}
      {dashes && <mesh geometry={dashes} position={[0, 0.012, roadZ]}><meshStandardMaterial color={SITE.marking} roughness={0.7} /></mesh>}
      {trees.map((t) => <PhotoTree key={t.seed} x={t.x} z={t.z} size={t.size} seed={t.seed} />)}
    </group>
  );
}

// Trees share geometry and materials (module level, created once in the browser).
let treeKit: { blob: THREE.BufferGeometry; trunk: THREE.BufferGeometry; leaves: THREE.Material[]; bark: THREE.Material; frond: THREE.BufferGeometry; palm: THREE.Material } | null = null;
function kit() {
  if (!treeKit) {
    treeKit = {
      blob: new THREE.IcosahedronGeometry(1, 2),
      trunk: new THREE.CylinderGeometry(0.7, 1, 1, 8),
      leaves: ['#3d6430', '#4a7337', '#365a2a', '#56793c'].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.95 })),
      bark: new THREE.MeshStandardMaterial({ color: '#6a4c34', roughness: 0.95 }),
      frond: new THREE.BoxGeometry(1, 0.03, 0.5),
      palm: new THREE.MeshStandardMaterial({ color: '#5b923b', roughness: 0.9, side: THREE.DoubleSide }),
    };
  }
  return treeKit;
}

function PhotoTree({ x, z, size, seed }: { x: number; z: number; size: number; seed: number }) {
  const k = kit(); const r = size / 2; const h = 1.9 + r * 0.55;
  const blobs: [number, number, number, number][] = [
    [0, h + r * 0.7, 0, r * 0.82], [r * 0.5, h + r * 0.45, r * 0.18, r * 0.58], [-r * 0.45, h + r * 0.5, -r * 0.25, r * 0.62], [r * 0.05, h + r * 1.2, -r * 0.1, r * 0.55],
  ];
  return (
    <group position={[x, 0, z]} rotation-y={seed * 1.7}>
      <mesh geometry={k.trunk} material={k.bark} position={[0, (h + r * 0.5) / 2, 0]} scale={[0.14 + r * 0.03, h + r * 0.5, 0.14 + r * 0.03]} castShadow />
      {blobs.map(([bx, by, bz, br], i) => (
        <mesh key={i} geometry={k.blob} material={k.leaves[(seed + i) % k.leaves.length]} position={[bx, by, bz]} scale={[br, br * 0.88, br]} castShadow receiveShadow />
      ))}
    </group>
  );
}

function PhotoPalm({ x, z, size, seed }: { x: number; z: number; size: number; seed: number }) {
  const k = kit(); const H = 5.2; const L = Math.max(1.6, size * 0.6);
  return (
    <group position={[x, 0, z]} rotation-y={seed}>
      <mesh geometry={k.trunk} material={k.bark} position={[0, H / 2, 0]} scale={[0.14, H, 0.14]} rotation-z={0.04} castShadow />
      {Array.from({ length: 9 }, (_, i) => (
        <group key={i} position={[0.1, H, 0]} rotation-y={(i / 9) * Math.PI * 2}>
          <group rotation-z={-0.35 - (i % 3) * 0.12}>
            <mesh geometry={k.frond} material={k.palm} position={[L / 2, 0, 0]} scale={[L, 1, 1]} castShadow />
          </group>
        </group>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- the building

/** Each storey rises in turn, then the roof settles on top. Transform-only, and instant under reduced motion. */
function useBuildUp() {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const start = useRef<number | null>(null);
  const reduce = useReducedMotion();
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

/** Many boxes merged into one geometry: a 10-storey block stays a few dozen draw calls. */
class BoxBuilder {
  private pos: number[] = [];
  private nor: number[] = [];
  private idx: number[] = [];
  get empty() { return this.idx.length === 0; }
  add(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number) {
    if (!(sx > 1e-4 && sy > 1e-4 && sz > 1e-4)) return;
    const hx = sx / 2, hy = sy / 2, hz = sz / 2;
    for (const [nx, ny, nz, corners] of BOX_FACES) {
      const v = this.pos.length / 3;
      for (const [a, b, c] of corners) { this.pos.push(cx + a * hx, cy + b * hy, cz + c * hz); this.nor.push(nx, ny, nz); }
      this.idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
    }
  }
  geometry(): THREE.BufferGeometry | null {
    if (this.empty) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}
type Face = [number, number, number, [number, number, number][]];
const BOX_FACES: Face[] = [
  [1, 0, 0, [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]]],
  [-1, 0, 0, [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]]],
  [0, 1, 0, [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]]],
  [0, -1, 0, [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]],
  [0, 0, 1, [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]]],
  [0, 0, -1, [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]]],
];

interface Look {
  wall: string; wallInt: string; slab: string; plinth: string; band: string; bandProud: number; coping: string;
  frame: string; frameMetal: number; frameRough: number; door: string; sill: string; glass: string; spandrel: string;
  /** Office, hotel, shops, mixed use: full-height glazing reads continuous, with metal frames and dark spandrels. */
  commercial: boolean;
}

const STYLE_LOOK: Record<'modern' | 'classic' | 'tropical', Look> = {
  modern: {
    wall: '#f1eee8', wallInt: '#f7f5f0', slab: '#d8d4cc', plinth: '#3c3f43', band: '#e1ddd5', bandProud: 0.03, coping: '#33363a',
    frame: '#26292c', frameMetal: 0.45, frameRough: 0.45, door: '#30353a', sill: '#d4d0c8', glass: '#a9bcc6', spandrel: '#2c3840', commercial: false,
  },
  classic: {
    wall: '#eedfc1', wallInt: '#f7f1e4', slab: '#dbd2c0', plinth: '#a5977f', band: '#f6eedd', bandProud: 0.06, coping: '#f3ead7',
    frame: '#f5f2ea', frameMetal: 0, frameRough: 0.55, door: '#5a3920', sill: '#e7dbc2', glass: '#b0c0c6', spandrel: '#3a3f42', commercial: false,
  },
  tropical: {
    wall: '#f7f5ef', wallInt: '#faf8f3', slab: '#dcd7cd', plinth: '#857c6e', band: '#9a6a42', bandProud: 0.04, coping: '#e8e3d9',
    frame: '#8a5a36', frameMetal: 0, frameRough: 0.6, door: '#74482a', sill: '#9a6a42', glass: '#a8c0c2', spandrel: '#33403f', commercial: false,
  },
};

const COMMERCIAL = new Set(['office', 'hotel', 'mixed-use', 'shops']);

function lookFor(design: Design): Look {
  const style = (['modern', 'classic', 'tropical'] as const).find((s) => s === design.brief.style) ?? 'modern';
  const base = STYLE_LOOK[style];
  const type = typeOfBrief(design) ?? '';
  if (COMMERCIAL.has(type)) {
    return { ...base, plinth: '#3f4348', band: '#d3d4d2', bandProud: 0.04, coping: '#555a61', frame: '#4a5057', frameMetal: 0.75, frameRough: 0.32, door: '#4a5057', glass: '#8fb0c2', commercial: true };
  }
  if (type === 'warehouse') return { ...base, wall: '#dfe2e4', plinth: '#55595e', band: '#c9cdd1', frame: '#4a5057', frameMetal: 0.7, frameRough: 0.35, door: '#5c6670' };
  return base;
}

const ROOF_SURFACE: Record<string, { roughness: number; metalness: number }> = {
  'concrete-tile': { roughness: 0.82, metalness: 0 },
  'stone-coated': { roughness: 0.7, metalness: 0.08 },
  aluminium: { roughness: 0.42, metalness: 0.4 },
  'standing-seam': { roughness: 0.32, metalness: 0.55 },
};

interface Part { mat: string; geo: THREE.BufferGeometry; cast: boolean; receive: boolean }

function makeMaterials(photo: boolean, dark: boolean, look: Look): Record<string, THREE.Material> {
  if (!photo) {
    const c = dark ? PALETTE.dark : PALETTE.light;
    return {
      slab: new THREE.MeshStandardMaterial({ color: c.slab, roughness: 0.9 }),
      wallExt: new THREE.MeshStandardMaterial({ color: c.wallExt, roughness: 0.9 }),
      wallInt: new THREE.MeshStandardMaterial({ color: c.wallInt, roughness: 0.9 }),
      door: new THREE.MeshStandardMaterial({ color: c.door, roughness: 0.7 }),
      glass: new THREE.MeshPhysicalMaterial({ color: c.glass, transparent: true, opacity: 0.45, roughness: 0.1, metalness: 0.1 }),
    };
  }
  const std = (color: string, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return {
    wall: std(look.wall, 0.9),
    wallInt: std(look.wallInt, 0.95),
    slab: std(look.slab, 0.9),
    plinth: std(look.plinth, 0.8),
    band: std(look.band, 0.85),
    coping: std(look.coping, 0.7, look.commercial ? 0.4 : 0),
    frame: std(look.frame, look.frameRough, look.frameMetal),
    door: std(look.door, 0.55),
    sill: std(look.sill, 0.7),
    spandrel: new THREE.MeshPhysicalMaterial({ color: look.spandrel, metalness: 0.6, roughness: 0.18, clearcoat: 0.6 }),
    glass: new THREE.MeshPhysicalMaterial({ color: look.glass, metalness: 0.82, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 1.25 }),
    glassLit: new THREE.MeshStandardMaterial({ color: '#ffe0ad', emissive: '#ffb563', emissiveIntensity: 1.5, roughness: 0.4 }),
  };
}

/** True when the plan point lies inside a block that has the given storey. */
const insideBlock = (d: Design, x: number, y: number, storey: number) =>
  d.blocks.find((b) => storey < b.storeys && x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.d);

/** Which side of a wall line is outdoors: +1 toward larger plan coordinates, -1 toward smaller. */
function outward(d: Design, dir: 'h' | 'v', line: number, mid: number, storey: number): 1 | -1 {
  const probe = (off: number) => (dir === 'h' ? insideBlock(d, mid, line + off, storey) : insideBlock(d, line + off, mid, storey));
  return probe(0.35) && !probe(-0.35) ? -1 : 1;
}

/** Splits [from, to] round the holes, keeping the pieces. */
function runs(from: number, to: number, holes: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let cur = from;
  for (const [a, b] of [...holes].sort((p, q) => p[0] - q[0])) {
    if (a > cur + 1e-3) out.push([cur, Math.min(a, to)]);
    cur = Math.max(cur, b);
  }
  if (to > cur + 1e-3) out.push([cur, to]);
  return out;
}

/**
 * Every storey's merged geometry, one entry per material. Model mode draws exactly the massing model (walls, slabs,
 * plain openings); photo mode swaps in style materials and adds frames, mullions, sills, plinth, bands and copings.
 */
function buildParts(design: Design, plot: Plot, photo: boolean, look: Look, dusk: boolean): Part[][] {
  const at = toScene(plot);
  const H = design.storeyHeightM;
  const builders = new Map<string, { s: number; mat: string; cast: boolean; b: BoxBuilder }>();
  const add = (s: number, mat: string, X: number, Y: number, Z: number, sx: number, sy: number, sz: number, cast = true) => {
    const k = `${s}|${mat}|${cast ? 1 : 0}`;
    let e = builders.get(k);
    if (!e) { e = { s, mat, cast, b: new BoxBuilder() }; builders.set(k, e); }
    e.b.add(X, Y, Z, sx, sy, sz);
  };
  /** A box in a wall's own frame: u along the wall, n across it (plan metres), z up from the storey's floor. */
  const place = (s: number, mat: string, dir: 'h' | 'v', u: number, n: number, z: number, su: number, sn: number, sz: number, cast = true) => {
    const [X, Z] = dir === 'h' ? at(u, n) : at(n, u);
    add(s, mat, X, z, Z, dir === 'h' ? su : sn, sz, dir === 'h' ? sn : su, cast);
  };

  for (const b of solidsFor(design)) {
    const s = b.storey;
    const [X, Z] = at(b.cx, b.cy);
    const mat = !photo
      ? (b.kind === 'slab' ? 'slab' : b.external || b.kind === 'parapet' ? 'wallExt' : 'wallInt')
      : b.kind === 'slab' ? 'slab'
        : b.external || b.kind === 'parapet' ? (look.commercial && (b.kind === 'lintel' || b.kind === 'sill') ? 'spandrel' : 'wall')
          : 'wallInt';
    add(s, mat, X, b.cz - s * H, Z, b.sx, b.sz, b.sy);
    if (photo && b.kind === 'parapet') {
      // A coping on every parapet, a little wider than the wall.
      add(s, 'coping', X, b.cz + b.sz / 2 + 0.03 - s * H, Z, b.sx + 0.08, 0.06, b.sy + 0.08);
    }
  }

  for (const o of design.openings) {
    const s = o.storey; const len = o.to - o.from; const h = o.headM - o.sillM; const mid = (o.from + o.to) / 2;
    if (!photo || !o.external) {
      place(s, o.kind === 'door' ? 'door' : 'glass', o.dir, mid, o.at, o.sillM + h / 2, len, o.kind === 'door' ? 0.05 : 0.02, h, false);
      continue;
    }
    const wall = design.walls.find((w) => w.storey === s && w.dir === o.dir && Math.abs(w.at - o.at) < 1e-6 && o.from >= w.from - 1e-6 && o.to <= w.to + 1e-6);
    const t = wall?.thickness ?? 0.225;
    const sg = outward(design, o.dir, o.at, mid, s);
    const face = o.at + sg * t / 2;
    const fw = look.commercial ? 0.05 : 0.065; const fd = 0.09;
    const fn = face - sg * (fd / 2 + 0.03); // frames sit 3 cm back from the face
    const gn = face - sg * 0.08; // glass and door leaves inside the frame depth
    const window = o.kind === 'window';
    const glazed = window || look.commercial || len >= 1.4;
    place(s, 'frame', o.dir, o.from + fw / 2, fn, o.sillM + h / 2, fw, fd, h);
    place(s, 'frame', o.dir, o.to - fw / 2, fn, o.sillM + h / 2, fw, fd, h);
    place(s, 'frame', o.dir, mid, fn, o.headM - fw / 2, len, fd, fw);
    if (window) place(s, 'frame', o.dir, mid, fn, o.sillM + fw / 2, len, fd, fw);
    const u0 = o.from + fw, u1 = o.to - fw, z0 = o.sillM + (window ? fw : 0), z1 = o.headM - fw;
    const iw = u1 - u0, ih = z1 - z0;
    if (iw <= 0.05 || ih <= 0.05) continue;
    if (glazed) {
      const lit = dusk && window && hash2(s * 13.1 + o.from, o.at * 7.7 + o.to) < 0.62;
      place(s, lit ? 'glassLit' : 'glass', o.dir, mid, gn, (z0 + z1) / 2, iw, 0.02, ih, false);
      const pane = look.commercial ? 1.5 : window ? 1.05 : 0.9;
      const panes = Math.max(1, Math.round(iw / pane));
      for (let i = 1; i < panes; i++) place(s, 'frame', o.dir, u0 + (iw * i) / panes, fn, (z0 + z1) / 2, fw * 0.8, fd * 0.8, ih);
      if ((window && !look.commercial && ih >= 1.25) || ih >= 2.6) {
        const zt = z1 - Math.min(0.45, ih * 0.28);
        place(s, 'frame', o.dir, mid, fn, zt, iw, fd * 0.8, fw * 0.8);
      }
    } else {
      place(s, 'door', o.dir, mid, gn, (z0 + z1) / 2, iw, 0.05, ih, false);
    }
    if (window && !look.commercial) {
      // A projecting sill that throws a small shadow line under each window.
      place(s, 'sill', o.dir, mid, face - sg * 0.025, o.sillM - 0.02, len + 0.12, 0.15, 0.06);
    }
  }

  if (photo) {
    const pitched = design.roof.kind !== 'flat' && design.roof.kind !== 'hidden';
    const holes = (s: number, dir: 'h' | 'v', line: number, pred: (o: Design['openings'][number]) => boolean): [number, number][] =>
      design.openings.filter((o) => o.storey === s && o.dir === dir && Math.abs(o.at - line) < 1e-6 && pred(o)).map((o) => [o.from, o.to]);
    for (const w of design.walls) {
      if (!w.external) continue;
      const s = w.storey; const t = w.thickness; const mid = (w.from + w.to) / 2;
      const sg = outward(design, w.dir, w.at, mid, s);
      const inner = w.at - sg * t / 2;
      const strip = (mat: string, zc: number, sz: number, proud: number, cuts: [number, number][]) => {
        const outer = w.at + sg * (t / 2 + proud);
        for (const [a, b] of runs(w.from, w.to, cuts)) {
          // Wrap the corners: a run that reaches the wall's end runs on to the outside face of the wall it meets.
          const a2 = Math.abs(a - w.from) < 1e-6 ? a - t / 2 - proud : a;
          const b2 = Math.abs(b - w.to) < 1e-6 ? b + t / 2 + proud : b;
          place(s, mat, w.dir, (a2 + b2) / 2, (inner + outer) / 2, zc, b2 - a2, Math.abs(outer - inner), sz);
        }
      };
      if (s === 0) strip('plinth', 0.2, 0.5, 0.025, holes(0, w.dir, w.at, (o) => o.sillM < 0.5));
      else strip('band', -0.03, 0.3, look.bandProud, [...holes(s, w.dir, w.at, (o) => o.sillM < 0.15), ...holes(s - 1, w.dir, w.at, (o) => o.headM > H - 0.2)]);
      const blk = w.dir === 'h' ? insideBlock(design, mid, w.at - sg * 0.35, s) : insideBlock(design, w.at - sg * 0.35, mid, s);
      if (pitched && blk && s === blk.storeys - 1) strip('band', H - 0.14, 0.28, look.bandProud, holes(s, w.dir, w.at, (o) => o.headM > H - 0.3));
    }
  }

  const out: Part[][] = Array.from({ length: design.storeys + 1 }, () => []);
  for (const e of builders.values()) {
    const geo = e.b.geometry();
    if (geo && out[e.s]) out[e.s]!.push({ mat: e.mat, geo, cast: e.cast, receive: e.cast });
  }
  return out;
}

function House({ plot, design, view, dark, photo }: SceneProps & { design: Design; photo: boolean }) {
  const look = useMemo(() => lookFor(design), [design]);
  const dusk = photo && dark;
  const parts = useMemo(() => buildParts(design, plot, photo, look, dusk), [design, plot, photo, look, dusk]);
  const mats = useMemo(() => makeMaterials(photo, dark, look), [photo, dark, look]);
  useEffect(() => () => { for (const s of parts) for (const p of s) p.geo.dispose(); }, [parts]);
  useEffect(() => () => { for (const m of Object.values(mats)) m.dispose(); }, [mats]);
  const top = view === 'outside' ? design.storeys : view + 1; // storeys shown
  const showRoof = view === 'outside';
  const refs = useBuildUp();
  const roof = useMemo(() => roofGeometry(design, plot), [design, plot]);
  const roofWalls = useMemo(() => roofGeometry(design, plot, true), [design, plot]);
  useEffect(() => () => { roof?.dispose(); roofWalls?.dispose(); }, [roof, roofWalls]);
  const H = design.storeyHeightM;
  const at = toScene(plot);
  const c = dark ? PALETTE.dark : PALETTE.light;
  const surface = ROOF_SURFACE[design.roof.finish] ?? ROOF_SURFACE.aluminium!;
  const pad = photo ? '#b9b4aa' : c.pad;

  return (
    <group>
      {design.parking.map((p, i) => { const [X, Z] = at(p.x + p.w / 2, p.y + p.d / 2); return (
        <mesh key={i} rotation-x={-Math.PI / 2} position={[X, 0.04, Z]} receiveShadow>
          <planeGeometry args={[p.w, p.d]} />
          <meshStandardMaterial color={pad} roughness={photo ? 0.9 : 1} />
        </mesh>
      ); })}
      {parts.map((storey, s) => (
        // Each storey's group scales from its own floor level.
        <group key={s} ref={(g) => { refs.current[s] = g; }} position={[0, s * H, 0]} visible={false}>
          {(s < top || (s === design.storeys && showRoof)) && storey.map((p) => (
            <mesh key={`${p.mat}${p.cast ? 1 : 0}`} geometry={p.geo} material={mats[p.mat]} castShadow={p.cast} receiveShadow={p.receive} />
          ))}
          {s === design.storeys && showRoof && roof && (
            <mesh geometry={roof} position={[0, -s * H, 0]} castShadow receiveShadow={photo}>
              {photo
                ? <meshStandardMaterial color={design.roof.colour} side={THREE.DoubleSide} roughness={surface.roughness} metalness={surface.metalness} />
                : <meshStandardMaterial color={design.roof.colour} side={THREE.DoubleSide} roughness={design.roof.finish === 'concrete-tile' ? 0.85 : 0.55} metalness={design.roof.finish === 'concrete-tile' ? 0 : 0.25} />}
            </mesh>
          )}
          {s === design.storeys && showRoof && roofWalls && (
            <mesh geometry={roofWalls} position={[0, -s * H, 0]} castShadow receiveShadow>
              <meshStandardMaterial color={photo ? look.wall : c.wallExt} side={THREE.DoubleSide} roughness={0.9} />
            </mesh>
          )}
        </group>
      ))}
    </group>
  );
}

/** The roof slopes, or (walls = true) the upright gable and infill faces under them. */
function roofGeometry(design: Design, plot: Plot, walls = false): THREE.BufferGeometry | null {
  const planes = roofPlanes(design).filter((p) => isVerticalPlane(p) === walls);
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

// ---------------------------------------------------------------- landscaping

const GROUNDS = {
  light: { lawn: '#8fbf6a', interlock: '#b7a48d', concrete: '#c9c6bf', gravel: '#a8a297', fence: '#efe9df', gate: '#2f3338', hedge: '#3f6f35', bed: '#7a5434', flowers: '#e07aa0', leaf: '#4f8a3a', palm: '#5d9a3e', trunk: '#6b4a2f', pool: '#4fb3d9', coping: '#f4f1ea', roof: '#5b3a29', lamp: '#fff3c4' },
  dark: { lawn: '#3f6b33', interlock: '#7d6e5d', concrete: '#77746d', gravel: '#6e6a62', fence: '#d8d1c4', gate: '#1d2024', hedge: '#2e5427', bed: '#5a3d26', flowers: '#c25f86', leaf: '#3b6e2c', palm: '#4a7f31', trunk: '#4f3622', pool: '#3b8fb0', coping: '#cfcac0', roof: '#3f281d', lamp: '#ffe9a3' },
  // Photo mode: the light materials (the mood does the lighting), with a deeper lawn and finer plants.
  photo: { lawn: '#6a9a48', interlock: '#b49c82', concrete: '#c8c4bb', gravel: '#aaa292', fence: '#efe9df', gate: '#2b2f33', hedge: '#3d6a30', bed: '#6b4a30', flowers: '#e0789c', leaf: '#4f8a3a', palm: '#5d9a3e', trunk: '#6b4a2f', pool: '#3aa6cf', coping: '#f1ede4', roof: '#5b3a29', lamp: '#fff3c4' },
};

/** Fence, paving, lawn, plants and garden structures, one mesh each (counts are small). */
function Grounds({ plot, items, dark, photo = false }: { plot: Plot; items: LandscapeItem[]; dark: boolean; photo?: boolean }) {
  const c = photo ? GROUNDS.photo : dark ? GROUNDS.dark : GROUNDS.light;
  const at = toScene(plot);
  const flat = (it: LandscapeItem, y: number, color: string) => {
    const [X, Z] = at(it.x + it.w / 2, it.y + it.d / 2);
    return <mesh key={it.id} rotation-x={-Math.PI / 2} position={[X, y, Z]} receiveShadow><planeGeometry args={[it.w, it.d]} /><meshStandardMaterial color={color} roughness={photo ? 0.95 : 1} /></mesh>;
  };
  const box = (key: string, it: { x: number; y: number; w: number; d: number }, y0: number, h: number, color: string, opts: { metal?: boolean } = {}) => {
    const [X, Z] = at(it.x + it.w / 2, it.y + it.d / 2);
    return <mesh key={key} position={[X, y0 + h / 2, Z]} castShadow receiveShadow><boxGeometry args={[it.w, h, it.d]} /><meshStandardMaterial color={color} roughness={opts.metal ? 0.4 : 0.9} metalness={opts.metal ? 0.5 : 0} /></mesh>;
  };
  return (
    <group>
      {items.map((it, n) => {
        const [X, Z] = at(it.x + it.w / 2, it.y + it.d / 2);
        switch (it.kind) {
          case 'lawn': return flat(it, 0.025, c.lawn);
          case 'paving': return flat(it, 0.04 + (it.use === 'apron' ? 0 : 0.005), c[it.material ?? 'concrete']);
          case 'fence': return (
            <group key={it.id}>
              {box(`${it.id}w`, it, 0, it.heightM ?? 2.1, c.fence)}
              {it.railing && box(`${it.id}r`, { ...it, w: it.w > it.d ? it.w : 0.06, d: it.d > it.w ? it.d : 0.06 }, it.heightM ?? 2.1, 0.6, c.gate, { metal: true })}
              {photo && box(`${it.id}c`, { x: it.x - 0.03, y: it.y - 0.03, w: it.w + 0.06, d: it.d + 0.06 }, (it.heightM ?? 2.1) - 0.06, 0.08, c.coping)}
            </group>
          );
          case 'gate': return box(it.id, { ...it, d: Math.min(it.d, 0.08), y: it.y + it.d / 2 - 0.04 }, 0, it.heightM ?? 2.1, c.gate, { metal: true });
          case 'hedge': return box(it.id, it, 0, it.heightM ?? 1.1, c.hedge);
          case 'bed': return (
            <group key={it.id}>
              {box(`${it.id}b`, it, 0, 0.22, c.bed)}
              <mesh rotation-x={-Math.PI / 2} position={[X, 0.23, Z]}><planeGeometry args={[it.w * 0.9, it.d * 0.7]} /><meshStandardMaterial color={c.flowers} /></mesh>
            </group>
          );
          case 'pool': return (
            <group key={it.id}>
              {box(`${it.id}c`, { x: it.x - 0.3, y: it.y - 0.3, w: it.w + 0.6, d: it.d + 0.6 }, 0, 0.08, c.coping)}
              <mesh rotation-x={-Math.PI / 2} position={[X, 0.09, Z]}>
                <planeGeometry args={[it.w, it.d]} />
                {photo
                  ? <meshPhysicalMaterial color={c.pool} roughness={0.04} metalness={0.1} clearcoat={1} clearcoatRoughness={0.02} />
                  : <meshStandardMaterial color={c.pool} roughness={0.1} metalness={0.2} />}
              </mesh>
            </group>
          );
          case 'gazebo': return (
            <group key={it.id} position={[X, 0, Z]}>
              {[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => (
                <mesh key={`${sx}${sz}`} position={[sx! * (it.w / 2 - 0.15), 1.25, sz! * (it.d / 2 - 0.15)]} castShadow><boxGeometry args={[0.15, 2.5, 0.15]} /><meshStandardMaterial color={c.trunk} /></mesh>
              ))}
              <mesh position={[0, 3.1, 0]} rotation-y={Math.PI / 4} castShadow><coneGeometry args={[it.w * 0.78, 1.2, 4]} /><meshStandardMaterial color={c.roof} /></mesh>
            </group>
          );
          case 'tree': return photo ? <PhotoTree key={it.id} x={X} z={Z} size={it.w} seed={n} /> : (
            <group key={it.id} position={[X, 0, Z]}>
              <mesh position={[0, 1.3, 0]} castShadow><cylinderGeometry args={[0.15, 0.22, 2.6, 8]} /><meshStandardMaterial color={c.trunk} /></mesh>
              <mesh position={[0, 3.6, 0]} castShadow><sphereGeometry args={[it.w / 2, 14, 10]} /><meshStandardMaterial color={c.leaf} roughness={0.95} /></mesh>
            </group>
          );
          case 'palm': return photo ? <PhotoPalm key={it.id} x={X} z={Z} size={it.w} seed={n} /> : (
            <group key={it.id} position={[X, 0, Z]}>
              <mesh position={[0, 2.6, 0]} castShadow><cylinderGeometry args={[0.1, 0.16, 5.2, 8]} /><meshStandardMaterial color={c.trunk} /></mesh>
              <mesh position={[0, 5.3, 0]} scale={[1, 0.35, 1]} castShadow><sphereGeometry args={[it.w / 2, 12, 8]} /><meshStandardMaterial color={c.palm} roughness={0.95} /></mesh>
            </group>
          );
          case 'shrub': return photo ? (
            <mesh key={it.id} geometry={kit().blob} material={kit().leaves[n % 4]} position={[X, (it.w / 2) * 0.7, Z]} scale={[it.w / 2, (it.w / 2) * 0.8, it.w / 2]} castShadow receiveShadow />
          ) : <mesh key={it.id} position={[X, it.w / 2 * 0.8, Z]} castShadow><sphereGeometry args={[it.w / 2, 10, 8]} /><meshStandardMaterial color={c.hedge} roughness={0.95} /></mesh>;
          case 'light': return (
            <group key={it.id} position={[X, 0, Z]}>
              <mesh position={[0, 0.4, 0]}><cylinderGeometry args={[0.05, 0.06, 0.8, 8]} /><meshStandardMaterial color={c.gate} /></mesh>
              <mesh position={[0, 0.85, 0]}><sphereGeometry args={[0.1, 10, 8]} /><meshStandardMaterial color={c.lamp} emissive={c.lamp} emissiveIntensity={dark ? 1.4 : 0.4} /></mesh>
            </group>
          );
          default: return null;
        }
      })}
    </group>
  );
}
