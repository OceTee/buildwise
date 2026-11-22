'use client';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { AccumulativeShadows, ContactShadows, Environment, Lightformer, Line, OrbitControls, RandomizedLight, Sky } from '@react-three/drei';
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { MATERIALS, isVerticalPlane, roofPlanes, solidsFor, type ArchElement, type BlockFinish, type Design, type Landscape, type LandscapeItem, type MaterialKey, type Plot } from '@bw/domain';

/**
 * A true-scale model of the plot and the building: one unit is one metre, so the building sits on the land exactly as
 * it would in real life; the camera simply frames it to fit the screen. Plan x runs along the street frontage and plan
 * y into the plot; in the scene the street is toward the viewer (+Z) and Y is up.
 *
 * Two looks share the same geometry: `model` (the default) is the clean massing model; `photo` is an architectural
 * visualisation with a low warm sun, procedural sky, reflections, materials by style and facade detail (frames,
 * mullions, plinth, slab bands, copings), all drawn from the design data. Both draw the design's architecture
 * (`Design.elements`: porches, verandas, balconies, canopies, pergolas, louvre screens, feature walls, planters); the
 * photo look also dresses each block in its facade materials (`Design.finishes`), with procedural stone, brick and
 * timber worked out in the shader from world position (nothing is downloaded).
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
  /**
   * 'live' (default) is the interactive view. 'still' (photo mode) is for pictures: no orbit or build-up animation,
   * sharper and softer sun shadows, and soft accumulated ground shadows that converge in about a second and a half;
   * `captureRef` then returns the converged frame (it finishes the accumulation first if it is asked sooner).
   */
  quality?: 'live' | 'still';
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
  const still = photo && props.quality === 'still';
  const rotate = !!props.autoRotate && !reduce && !userMoved && !still;
  const sky = skyDistance(reach);
  const accum = useRef<AccumApi | null>(null);
  const stillVersion = still && design ? `${props.buildKey}:${designSerial(design)}:${props.dark}:${props.view}:${landscapeSerial(props.landscape)}:${plot.widthM}x${plot.depthM}` : '';
  return (
    <div className="scene-canvas">
    <Canvas
      shadows="percentage"
      dpr={[1, 2]}
      camera={{ fov: 40, near: 0.1, far: span * 20, position: [span * 0.75, span * 0.85, span * 1.15] }}
      aria-label={description(props)}
      role="img"
    >
      {photo
        ? <PhotoLighting reach={reach} plot={plot} height={bounds.height} dusk={props.dark} still={still} />
        : <ModelLighting reach={reach} dark={props.dark} />}
      <Fit plot={plot} photo={photo} plan={props.view !== 'outside'} bounds={bounds} reach={reach} skyFar={sky * 2} />
      {photo ? <PhotoSite plot={plot} reach={reach} /> : <Site {...props} />}
      {design && <House key={props.buildKey} {...props} design={design} photo={photo} instant={still} />}
      {photo && design && !still && <GroundContact key={`${props.buildKey}:${designSerial(design)}`} bounds={bounds} />}
      {still && design && <StillShadows bounds={bounds} dusk={props.dark} version={stillVersion} apiRef={accum} />}
      {props.landscape && <Grounds plot={plot} items={props.landscape.items} dark={props.dark} photo={photo} />}
      <OrbitControls
        makeDefault enableDamping
        maxPolarAngle={photo ? Math.PI / 2.06 : Math.PI / 2.15}
        minDistance={4} maxDistance={reach * (photo ? 5 : 4)}
        autoRotate={rotate} autoRotateSpeed={0.55}
        onStart={() => { if (props.autoRotate) setUserMoved(true); }}
      />
      <Projector labels={labels} els={els} />
      {props.captureRef && <Capture target={props.captureRef} accum={still ? accum : null} />}
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
    for (const r of [...design.blocks, ...design.parking, ...(design.elements ?? [])]) {
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
function Capture({ target, accum }: { target: { current: (() => string | null) | null }; accum: { current: AccumApi | null } | null }) {
  const { gl, scene, camera, size } = useThree();
  useEffect(() => {
    const fn = () => {
      try {
        // A still asked for before its soft shadows have converged: finish them now, so the picture is the final one.
        const acc = accum?.current;
        if (acc) while (acc.count < acc.frames) { acc.update(); acc.count++; }
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
  }, [target, accum, gl, scene, camera, size.width]);
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

function PhotoLighting({ reach, plot, height, dusk, still }: { reach: number; plot: Plot; height: number; dusk: boolean; still: boolean }) {
  const m = dusk ? MOODS.dusk : MOODS.day;
  const dir = useMemo(() => sunDirection(m.elev, m.az), [m]);
  // The shadow camera must hold the plot, the road and a tall building's long shadow.
  const half = Math.max(plot.widthM, plot.depthM) / 2 + 14 + height * 0.95;
  const R = reach * 3 + height;
  // Stills get the largest map and a wider filter: crisp contact, soft penumbra.
  const res = still || half > 45 ? 4096 : 2048;
  const sky = skyDistance(reach);
  return (
    <>
      <color attach="background" args={[m.fog]} />
      <fog attach="fog" args={[m.fog, reach * 4, reach * 22]} />
      <Sky distance={sky} sunPosition={[dir.x, dir.y, dir.z]} turbidity={m.turbidity} rayleigh={m.rayleigh} mieCoefficient={m.mie} mieDirectionalG={m.mieG} />
      <hemisphereLight args={[m.hemiSky, m.hemiGround, m.hemi]} />
      <directionalLight
        key={`${res}:${still}`}
        position={[dir.x * R, dir.y * R, dir.z * R]} color={m.sun} intensity={m.sunI}
        castShadow shadow-mapSize={[res, res]} shadow-bias={-0.0002} shadow-normalBias={still ? 0.025 : 0.035} shadow-radius={still ? 2.6 : 1}
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

/** The part of drei's accumulative-shadow API the capture uses to finish converging. */
interface AccumApi { count: number; frames: number; update: (frames?: number) => void }

/**
 * The still's ground shadows: drei's progressive light map, fed by a jittered sun plus light from the whole sky, so the
 * building and its porches sit on the ground with soft, ambient-occlusion-like contact shadows. It re-accumulates
 * (about 90 frames) only when `version` changes, which covers everything it captured (meshes, materials, lights).
 */
const StillShadows = memo(function StillShadows({ bounds, dusk, version, apiRef }: { bounds: Bounds; dusk: boolean; version: string; apiRef: { current: AccumApi | null } }) {
  const m = dusk ? MOODS.dusk : MOODS.day;
  // A higher sun than the key light: this layer grounds the building rather than repeating the long shadow.
  const dir = useMemo(() => sunDirection(Math.max(m.elev, 48), m.az), [m]);
  const ext = Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX), Math.abs(bounds.minZ), Math.abs(bounds.maxZ));
  const scale = Math.ceil(2 * (ext + Math.min(bounds.height * 1.3, 24)) + 8);
  const dist = Math.max(30, scale);
  const res = scale > 70 ? 2048 : 1024;
  return (
    <AccumulativeShadows
      key={res} ref={apiRef as React.Ref<never>} name={`still-shadows:${version}`}
      temporal frames={90} alphaTest={0.82} opacity={dusk ? 0.75 : 0.9} colorBlend={2} scale={scale} resolution={res}
      position={[0, 0.05, 0]} color={dusk ? '#241c18' : '#2e271f'}
    >
      <RandomizedLight
        amount={8} radius={Math.max(2.5, ext * 0.3)} ambient={0.6} intensity={Math.PI} bias={0.0008} mapSize={1024}
        position={[dir.x * dist, dir.y * dist, dir.z * dist]} size={scale / 2 + 4} near={1} far={dist * 2 + scale}
      />
    </AccumulativeShadows>
  );
});

const landscapeSerial = (l: Landscape | null | undefined) => (l ? `${l.items.length}:${l.items.map((i) => i.id).join(',').length}:${l.items.reduce((a, i) => a + i.x * 3 + i.y * 7 + i.w + i.d, 0).toFixed(2)}` : 'none');

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

/** Each storey rises in turn, then the roof settles on top. Transform-only, and instant under reduced motion and for stills. */
function useBuildUp(instant = false) {
  const refs = useRef<(THREE.Group | null)[]>([]);
  const start = useRef<number | null>(null);
  const reduce = useReducedMotion();
  useFrame(({ clock }) => {
    if (start.current === null) start.current = clock.elapsedTime;
    const t = clock.elapsedTime - start.current;
    refs.current.forEach((g, i) => {
      if (!g) return;
      const p = reduce || instant ? 1 : Math.min(1, Math.max(0, (t - i * 0.55) / 0.7));
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
  /** A square-section bar from a to b (scene metres), for tie rods and braces. */
  addSeg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number) {
    const e1 = new THREE.Vector3(bx - ax, by - ay, bz - az); const L = e1.length();
    if (L < 1e-4) return;
    e1.divideScalar(L);
    const e2 = new THREE.Vector3().crossVectors(e1, Math.abs(e1.y) < 0.9 ? UP : RIGHT).normalize();
    const e3 = new THREE.Vector3().crossVectors(e1, e2);
    const c = new THREE.Vector3((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    const h = [L / 2, t / 2, t / 2] as const; const p = new THREE.Vector3(); const n = new THREE.Vector3();
    for (const [nx, ny, nz, corners] of BOX_FACES) {
      const v = this.pos.length / 3;
      n.set(0, 0, 0).addScaledVector(e1, nx).addScaledVector(e2, ny).addScaledVector(e3, nz);
      for (const [a, b, cc] of corners) {
        p.copy(c).addScaledVector(e1, a * h[0]).addScaledVector(e2, b * h[1]).addScaledVector(e3, cc * h[2]);
        this.pos.push(p.x, p.y, p.z); this.nor.push(n.x, n.y, n.z);
      }
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
const UP = new THREE.Vector3(0, 1, 0); const RIGHT = new THREE.Vector3(1, 0, 0);
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

interface Part { mat: string; geo: THREE.BufferGeometry; cast: boolean; receive: boolean; /** Overhead (porch roofs, canopies, pergola tops): hidden on that storey's floor plan. */ over: boolean }
interface Plant { s: number; x: number; y: number; z: number; r: number; seed: number }

// ---------------------------------------------------------------- facade materials

/**
 * Procedural surface patterns, worked out in the fragment shader from world position and normal (so merged boxes need
 * no UVs): render mottling, coursed stone, running-bond brick, timber boards and grain, board-marked concrete, tiles
 * and pavers. Joints are antialiased with fwidth and the pattern fades to its average colour once units get smaller
 * than a few pixels, so distant facades never shimmer.
 */
type Pattern = 'none' | 'render' | 'stone' | 'brick' | 'boards' | 'grain' | 'concrete' | 'tile' | 'pavers';
const PATTERN_ID: Record<Pattern, number> = { none: 0, render: 1, stone: 2, brick: 3, boards: 4, grain: 5, concrete: 6, tile: 7, pavers: 8 };

const PATTERN_COMMON = /* glsl */ `
varying vec3 vBwPos;
varying vec3 vBwNor;
float bwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(bwHash(i), bwHash(i + vec2(1.0, 0.0)), u.x), mix(bwHash(i + vec2(0.0, 1.0)), bwHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Units of size s (m) in rows, each row shifted by fract(row * shift); joints j (m) wide.
// Returns (unit id, joint amount 0..1, detail fade 0..1).
vec4 bwUnits(vec2 p, vec2 s, float j, float shift) {
  vec2 c = p / s;
  vec2 fw = max(fwidth(c), vec2(1e-5));
  float row = floor(c.y);
  c.x += fract(row * shift);
  vec2 id = floor(c); vec2 f = c - id;
  vec2 w = 0.5 * vec2(j) / s;
  vec2 d = min(f, 1.0 - f);
  vec2 jj = 1.0 - smoothstep(w, w + fw, d);
  float fade = 1.0 - smoothstep(0.18, 0.5, max(fw.x, fw.y));
  return vec4(id, max(jj.x, jj.y) * fade, fade);
}
`;

const PATTERN_APPLY = /* glsl */ `
{
  vec3 an = abs(vBwNor);
  bool flatFace = an.y > 0.6;
  vec2 p = flatFace ? vBwPos.xz : vec2(an.x > an.z ? vBwPos.z : vBwPos.x, vBwPos.y);
  vec3 base = diffuseColor.rgb;
  vec3 col = base;
  float detail = 1.0 - smoothstep(0.02, 0.08, max(fwidth(p.x), fwidth(p.y)));
#if BW_PAT == 1
  col *= 1.0 + (bwNoise(p * 1.2) - 0.5) * 0.07 + (bwNoise(p * 7.0) - 0.5) * 0.035 * detail;
#elif BW_PAT == 2
  vec4 u = bwUnits(p + vec2(0.0, 0.07), vec2(0.62, 0.31), 0.014, 0.37);
  vec2 id = u.xy + (bwHash(u.xy + 5.0) > 0.62 ? vec2(step(0.5, fract((p.x + 0.0) / 0.62 + fract(u.y * 0.37))) * 0.5, 0.0) : vec2(0.0));
  float h = bwHash(id);
  vec3 stone = base * (0.8 + 0.4 * h) * mix(vec3(1.0), vec3(1.07, 1.0, 0.9), bwHash(id + 3.1));
  stone *= 0.93 + 0.14 * bwNoise(p * 13.0) * detail;
  col = mix(base * (0.98 + 0.06 * bwNoise(p * 0.8)), stone, u.w);
  col = mix(col, base * 0.5, u.z * 0.85);
#elif BW_PAT == 3
  vec4 u = bwUnits(p, vec2(0.225, 0.075), 0.01, 0.5);
  float h = bwHash(u.xy);
  vec3 brick = base * (0.8 + 0.38 * h) * mix(vec3(1.0), vec3(0.9, 0.97, 1.05), bwHash(u.xy + 9.7));
  col = mix(base * 1.02, brick, u.w);
  col = mix(col, vec3(0.5, 0.47, 0.43), u.z * 0.9);
#elif BW_PAT == 4
  float row = floor(p.y / 0.15);
  float fy = fract(p.y / 0.15);
  float seg = floor((p.x + bwHash(vec2(row, 1.0)) * 2.4) / 2.4);
  float h = bwHash(vec2(row, seg));
  float fwy = max(fwidth(p.y / 0.15), 1e-5);
  float gap = (1.0 - smoothstep(0.06, 0.06 + fwy, fy)) * (1.0 - smoothstep(0.15, 0.5, fwy));
  vec3 board = base * (0.84 + 0.3 * h) * (0.9 + 0.2 * bwNoise(vec2(p.x * 1.4, p.y * 48.0)) * detail);
  col = mix(board, base * 0.35, gap * 0.9);
#elif BW_PAT == 5
  col *= 0.9 + 0.2 * bwNoise(vec2(p.x * 26.0, p.y * 1.6)) * detail + 0.06 * (bwNoise(p * 3.0) - 0.5);
#elif BW_PAT == 6
  vec4 u = bwUnits(p, vec2(2.4, 1.2), 0.012, 0.0);
  col *= 0.95 + 0.1 * bwNoise(p * 1.7) + 0.05 * bwNoise(p * 9.0) * detail + 0.04 * (bwHash(u.xy) - 0.5);
  col = mix(col, col * 0.72, u.z);
#elif BW_PAT == 7
  vec4 u = bwUnits(p, vec2(0.3, 0.1), 0.007, 0.5);
  vec3 tile = base * (0.84 + 0.3 * bwHash(u.xy));
  col = mix(base, tile, u.w);
  col = mix(col, base * 0.55, u.z * 0.8);
#elif BW_PAT == 8
  vec4 u = bwUnits(p, vec2(0.6, 0.6), 0.008, 0.5);
  col = mix(base, base * (0.9 + 0.2 * bwHash(u.xy)) * (0.96 + 0.08 * bwNoise(p * 6.0)), u.w);
  col = mix(col, base * 0.62, u.z);
#endif
  diffuseColor.rgb = col;
}
`;

function patterned(color: string, roughness: number, metalness: number, pattern: Pattern): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  if (pattern === 'none') return m;
  const id = PATTERN_ID[pattern];
  m.customProgramCacheKey = () => `bw-pattern-${id}`;
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vBwPos;\nvarying vec3 vBwNor;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBwPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nvBwNor = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = `#define BW_PAT ${id}\n` + sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${PATTERN_COMMON}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${PATTERN_APPLY}`);
  };
  return m;
}

/** How each facade material reads: roughness, metalness, and its pattern as cladding and as solid members. */
const SURFACE: Record<MaterialKey, { rough: number; metal: number; clad: Pattern; solid: Pattern }> = {
  'render-white': { rough: 0.92, metal: 0, clad: 'render', solid: 'render' },
  'render-cream': { rough: 0.92, metal: 0, clad: 'render', solid: 'render' },
  'render-sand': { rough: 0.93, metal: 0, clad: 'render', solid: 'render' },
  'render-grey': { rough: 0.9, metal: 0, clad: 'render', solid: 'render' },
  'render-charcoal': { rough: 0.86, metal: 0, clad: 'render', solid: 'render' },
  stone: { rough: 0.88, metal: 0, clad: 'stone', solid: 'render' },
  brick: { rough: 0.9, metal: 0, clad: 'brick', solid: 'brick' },
  timber: { rough: 0.62, metal: 0, clad: 'boards', solid: 'grain' },
  concrete: { rough: 0.84, metal: 0, clad: 'concrete', solid: 'concrete' },
  'metal-dark': { rough: 0.36, metal: 0.65, clad: 'none', solid: 'none' },
  'tile-terracotta': { rough: 0.55, metal: 0, clad: 'tile', solid: 'tile' },
};
const MATERIAL_KEYS = Object.keys(MATERIALS) as MaterialKey[];
const isMaterial = (k: unknown): k is MaterialKey => typeof k === 'string' && Object.hasOwn(MATERIALS, k);

/** Model-mode tint of a material: half way to the plain wall colour, so features read without breaking the model look. */
const modelTint = (k: MaterialKey, wall: string) => '#' + new THREE.Color(MATERIALS[k].hex).lerp(new THREE.Color(wall), 0.45).getHexString();

const finishOf = (d: Design, blockId: string | undefined): BlockFinish | undefined => (d.finishes ?? []).find((f) => f.block === blockId);
/** The style's frames win over a timber accent on a modern house (dark slim frames); otherwise frames take the accent. */
const frameAccent = (d: Design, f: BlockFinish | undefined): MaterialKey | undefined =>
  f?.accent && isMaterial(f.accent) && !(f.accent === 'timber' && d.brief.style === 'modern') && !f.accent.startsWith('render-c') ? f.accent : undefined;

function makeMaterials(photo: boolean, dark: boolean, look: Look, design: Design): Record<string, THREE.Material> {
  if (!photo) {
    const c = dark ? PALETTE.dark : PALETTE.light;
    const out: Record<string, THREE.Material> = {
      slab: new THREE.MeshStandardMaterial({ color: c.slab, roughness: 0.9 }),
      wallExt: new THREE.MeshStandardMaterial({ color: c.wallExt, roughness: 0.9 }),
      wallInt: new THREE.MeshStandardMaterial({ color: c.wallInt, roughness: 0.9 }),
      door: new THREE.MeshStandardMaterial({ color: c.door, roughness: 0.7 }),
      glass: new THREE.MeshPhysicalMaterial({ color: c.glass, transparent: true, opacity: 0.45, roughness: 0.1, metalness: 0.1 }),
      elem: new THREE.MeshStandardMaterial({ color: c.slab, roughness: 0.85 }),
      elemLight: new THREE.MeshStandardMaterial({ color: c.wallExt, roughness: 0.9 }),
      post: new THREE.MeshStandardMaterial({ color: dark ? '#a8a29e' : '#9c958c', roughness: 0.8 }),
      rail: new THREE.MeshPhysicalMaterial({ color: c.glass, transparent: true, opacity: 0.35, roughness: 0.1, metalness: 0.1, depthWrite: false }),
      soil: new THREE.MeshStandardMaterial({ color: dark ? '#4a3a2c' : '#7a5c42', roughness: 1 }),
      green: new THREE.MeshStandardMaterial({ color: dark ? '#4c7a3c' : '#86ad6c', roughness: 0.95 }),
    };
    for (const k of MATERIAL_KEYS) out[`mm:${k}`] = new THREE.MeshStandardMaterial({ color: modelTint(k, c.wallExt), roughness: 0.85 });
    return out;
  }
  const std = (color: string, roughness: number, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  const out: Record<string, THREE.Material> = {
    wall: patterned(look.wall, 0.9, 0, 'render'),
    wallInt: std(look.wallInt, 0.95),
    slab: std(look.slab, 0.9),
    plinth: std(look.plinth, 0.8),
    band: std(look.band, 0.85),
    coping: std(look.coping, 0.7, look.commercial ? 0.4 : 0),
    frame: std(look.frame, look.frameRough, look.frameMetal),
    door: std(look.door, 0.55),
    sill: std(look.sill, 0.7),
    spandrel: new THREE.MeshPhysicalMaterial({ color: look.spandrel, metalness: 0.6, roughness: 0.18, clearcoat: 0.6 }),
    // Lighter glass: less mirror-like, with a faint sky tint, so glass walls read as glass rather than dark slate.
    glass: new THREE.MeshPhysicalMaterial({ color: look.glass, metalness: 0.4, roughness: 0.04, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.7, emissive: '#a9c4d4', emissiveIntensity: 0.16 }),
    glassLit: new THREE.MeshStandardMaterial({ color: '#ffe0ad', emissive: '#ffb563', emissiveIntensity: 1.5, roughness: 0.4 }),
    // Balustrade glass: clear, slightly green-grey, catching the sky.
    rail: new THREE.MeshPhysicalMaterial({ color: '#c4d6d6', metalness: 0.1, roughness: 0.04, transparent: true, opacity: 0.32, clearcoat: 1, envMapIntensity: 1.4, depthWrite: false }),
    paving: patterned('#cfc7b8', 0.82, 0, 'pavers'),
    soil: std('#4a3829', 1),
    downlight: new THREE.MeshStandardMaterial({ color: '#fff4dc', emissive: '#ffd9a0', emissiveIntensity: dark ? 2.2 : 0.4, roughness: 0.4 }),
  };
  for (const k of MATERIAL_KEYS) {
    const f = SURFACE[k]; const hex = MATERIALS[k].hex;
    out[`m:${k}`] = patterned(hex, f.rough, f.metal, f.clad);
    out[`m:${k}:solid`] = patterned(hex, f.rough, f.metal, f.solid);
  }
  for (const f of design.finishes ?? []) {
    if (isMaterial(f.walls)) out[`wall:${f.block}`] = out[`m:${f.walls}`]!;
    if (isMaterial(f.base)) out[`plinth:${f.block}`] = out[`m:${f.base}`]!;
    const fa = frameAccent(design, f);
    if (fa) out[`frame:${f.block}`] = fa === 'metal-dark' ? std(MATERIALS[fa].hex, 0.34, 0.7) : out[`m:${fa}:solid`]!;
  }
  return out;
}

/** True when the plan point lies inside a block that has the given storey. */
const insideBlock = (d: Design, x: number, y: number, storey: number) =>
  d.blocks.find((b) => storey < b.storeys && x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.d);

/** The block whose outline a wall (or other piece) on this storey sits on, within a small tolerance. */
const blockOn = (d: Design, x: number, y: number, storey: number) =>
  d.blocks.find((b) => storey < b.storeys && x >= b.x - 0.2 && x <= b.x + b.w + 0.2 && y >= b.y - 0.2 && y <= b.y + b.d + 0.2);

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

// ---------------------------------------------------------------- architectural elements

interface Sides { front: boolean; rear: boolean; left: boolean; right: boolean }

/** Which sides of an element's rectangle stand against the building on its storey (the rest are open). */
function attachedSides(d: Design, e: ArchElement): Sides {
  const s = Math.max(0, e.storey);
  const inside = (x: number, y: number) => d.blocks.some((b) => s < b.storeys && x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.d);
  const mx = e.x + e.w / 2, my = e.y + e.d / 2, p = 0.12;
  return { front: inside(mx, e.y - p), rear: inside(mx, e.y + e.d + p), left: inside(e.x - p, my), right: inside(e.x + e.w + p, my) };
}

/** Column (or post) positions: open outer corners, and every `spacing` metres or less along each open side. */
function postsFor(e: ArchElement, att: Sides, inset: number, spacing: number): [number, number][] {
  const x0 = e.x + inset, x1 = e.x + e.w - inset, y0 = e.y + inset, y1 = e.y + e.d - inset;
  const pts = new Map<string, [number, number]>();
  const put = (x: number, y: number) => pts.set(`${x.toFixed(2)},${y.toFixed(2)}`, [x, y]);
  const corners: [number, number, boolean][] = [[x0, y0, !att.front && !att.left], [x1, y0, !att.front && !att.right], [x1, y1, !att.rear && !att.right], [x0, y1, !att.rear && !att.left]];
  for (const [x, y, ok] of corners) if (ok) put(x, y);
  const edges: [boolean, number, number, number, number][] = [[!att.front, x0, y0, x1, y0], [!att.rear, x0, y1, x1, y1], [!att.left, x0, y0, x0, y1], [!att.right, x1, y0, x1, y1]];
  for (const [open, ax, ay, bx, by] of edges) {
    if (!open) continue;
    const n = Math.ceil(Math.hypot(bx - ax, by - ay) / spacing - 1e-6);
    for (let i = 1; i < n; i++) put(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n);
  }
  return [...pts.values()];
}

/**
 * Every storey's merged geometry, one entry per material. Model mode draws exactly the massing model (walls, slabs,
 * plain openings, simple elements); photo mode swaps in each block's facade materials and adds frames, mullions,
 * sliding glass walls, sills, plinth, bands and copings, and detailed porches, balconies, canopies, pergolas and screens.
 */
function buildParts(design: Design, plot: Plot, photo: boolean, look: Look, dusk: boolean): { parts: Part[][]; plants: Plant[] } {
  const at = toScene(plot);
  const H = design.storeyHeightM;
  const top = design.storeys;
  const builders = new Map<string, { s: number; mat: string; cast: boolean; over: boolean; b: BoxBuilder }>();
  const builder = (s: number, mat: string, cast: boolean, over: boolean) => {
    const k = `${s}|${mat}|${cast ? 1 : 0}|${over ? 1 : 0}`;
    let e = builders.get(k);
    if (!e) { e = { s, mat, cast, over, b: new BoxBuilder() }; builders.set(k, e); }
    return e.b;
  };
  const add = (s: number, mat: string, X: number, Y: number, Z: number, sx: number, sy: number, sz: number, cast = true, over = false) =>
    builder(s, mat, cast, over).add(X, Y, Z, sx, sy, sz);
  /** A box in a wall's own frame: u along the wall, n across it (plan metres), z up from the storey's floor. */
  const place = (s: number, mat: string, dir: 'h' | 'v', u: number, n: number, z: number, su: number, sn: number, sz: number, cast = true) => {
    const [X, Z] = dir === 'h' ? at(u, n) : at(n, u);
    add(s, mat, X, z, Z, dir === 'h' ? su : sn, sz, dir === 'h' ? sn : su, cast);
  };
  /** A box by plan extents and absolute heights, drawn with storey `s`. */
  const box = (s: number, mat: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, over = false, cast = true) => {
    const [X, Z] = at((x0 + x1) / 2, (y0 + y1) / 2);
    add(s, mat, X, (z0 + z1) / 2 - s * H, Z, Math.abs(x1 - x0), Math.abs(z1 - z0), Math.abs(y1 - y0), cast, over);
  };
  /** A tall box cut at each floor level, so each piece hides and rises with its own storey. */
  const tall = (mat: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    for (let s = Math.max(0, Math.floor(z0 / H + 1e-6)); s <= top; s++) {
      const a = Math.max(z0, s * H); const b = s === top ? z1 : Math.min(z1, (s + 1) * H);
      if (b - a > 1e-3) box(Math.min(s, top), mat, x0, x1, y0, y1, a, b);
      if (b >= z1 - 1e-6) break;
    }
  };
  const rod = (s: number, mat: string, p: [number, number, number], q: [number, number, number], t: number) => {
    const [ax, az] = at(p[0], p[1]); const [bx, bz] = at(q[0], q[1]);
    builder(s, mat, true, true).addSeg(ax, p[2] - s * H, az, bx, q[2] - s * H, bz, t);
  };
  const plants: Plant[] = [];
  const mainFinish = finishOf(design, design.blocks[0]?.id);
  const has = (k: string, fallback: string) => (photo && k ? k : fallback);
  const wallMat = (blockId: string | undefined) => (finishOf(design, blockId) && isMaterial(finishOf(design, blockId)!.walls) ? `wall:${blockId}` : 'wall');

  for (const b of solidsFor(design)) {
    const s = b.storey;
    const [X, Z] = at(b.cx, b.cy);
    const blk = b.external || b.kind === 'parapet' ? blockOn(design, b.cx, b.cy, b.kind === 'parapet' ? s - 1 : s) : undefined;
    const mat = !photo
      ? (b.kind === 'slab' ? 'slab' : b.external || b.kind === 'parapet' ? 'wallExt' : 'wallInt')
      : b.kind === 'slab' ? 'slab'
        : b.external || b.kind === 'parapet' ? (look.commercial && (b.kind === 'lintel' || b.kind === 'sill') ? 'spandrel' : wallMat(blk?.id))
          : 'wallInt';
    add(s, mat, X, b.cz - s * H, Z, b.sx, b.sz, b.sy);
    if (photo && b.kind === 'parapet') {
      // A coping on every parapet, a little wider than the wall.
      add(s, 'coping', X, b.cz + b.sz / 2 + 0.03 - s * H, Z, b.sx + 0.08, 0.06, b.sy + 0.08);
    }
  }

  const roomBlock = new Map(design.rooms.map((r) => [r.id, r.block]));
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
    const window = o.kind === 'window';
    // Floor-to-ceiling glass reads as sliding doors: slim frames, panes about 1.2 m, two tracks. Large windows get wide panes.
    const sliding = window && o.sillM < 0.3;
    const large = window && !sliding && len >= 1.7 && h >= 1.6;
    const blockId = roomBlock.get(o.roomId);
    const frame = finishOf(design, blockId) && frameAccent(design, finishOf(design, blockId)) ? `frame:${blockId}` : 'frame';
    const fw = sliding ? 0.045 : look.commercial ? 0.05 : 0.065; const fd = 0.09;
    const fn = face - sg * (fd / 2 + 0.03); // frames sit 3 cm back from the face
    const gn = face - sg * 0.08; // glass and door leaves inside the frame depth
    const glazed = window || look.commercial || len >= 1.4;
    place(s, frame, o.dir, o.from + fw / 2, fn, o.sillM + h / 2, fw, fd, h);
    place(s, frame, o.dir, o.to - fw / 2, fn, o.sillM + h / 2, fw, fd, h);
    place(s, frame, o.dir, mid, fn, o.headM - fw / 2, len, fd, fw);
    if (window) place(s, frame, o.dir, mid, fn, o.sillM + (sliding ? 0.02 : fw / 2), len, fd, sliding ? 0.04 : fw);
    const u0 = o.from + fw, u1 = o.to - fw, z0 = o.sillM + (window ? (sliding ? 0.04 : fw) : 0), z1 = o.headM - fw;
    const iw = u1 - u0, ih = z1 - z0;
    if (iw <= 0.05 || ih <= 0.05) continue;
    if (glazed) {
      const pane = sliding ? 1.2 : large ? 1.5 : look.commercial ? 1.5 : window ? 1.05 : 0.9;
      const panes = Math.max(1, Math.round(iw / pane));
      if (sliding) {
        // Each leaf in its own track, its own slim stiles; the leaves overlap a few centimetres.
        for (let i = 0; i < panes; i++) {
          const a = u0 + (iw * i) / panes; const b = u0 + (iw * (i + 1)) / panes;
          const track = gn + sg * (i % 2 ? -0.025 : 0.02);
          const lit = dusk && hash2(s * 13.1 + o.from + i, o.at * 7.7 + o.to) < 0.7;
          place(s, lit ? 'glassLit' : 'glass', o.dir, (a + b) / 2, track, (z0 + z1) / 2, b - a + 0.04, 0.02, ih, false);
          if (i > 0) place(s, frame, o.dir, a, fn, (z0 + z1) / 2, fw * 1.2, fd * 0.7, ih);
        }
        if (ih >= 2.75) place(s, frame, o.dir, mid, fn, z1 - 0.38, iw, fd * 0.7, fw * 0.8);
      } else {
        const lit = dusk && window && hash2(s * 13.1 + o.from, o.at * 7.7 + o.to) < 0.62;
        place(s, lit ? 'glassLit' : 'glass', o.dir, mid, gn, (z0 + z1) / 2, iw, 0.02, ih, false);
        for (let i = 1; i < panes; i++) place(s, frame, o.dir, u0 + (iw * i) / panes, fn, (z0 + z1) / 2, fw * 0.8, fd * 0.8, ih);
        if (!large && ((window && !look.commercial && ih >= 1.25) || ih >= 2.6)) {
          const zt = z1 - Math.min(0.45, ih * 0.28);
          place(s, frame, o.dir, mid, fn, zt, iw, fd * 0.8, fw * 0.8);
        }
      }
    } else {
      place(s, 'door', o.dir, mid, gn, (z0 + z1) / 2, iw, 0.05, ih, false);
    }
    if (window && !sliding && !look.commercial) {
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
      const blk = w.dir === 'h' ? insideBlock(design, mid, w.at - sg * 0.35, s) : insideBlock(design, w.at - sg * 0.35, mid, s);
      const strip = (mat: string, zc: number, sz: number, proud: number, cuts: [number, number][]) => {
        const outer = w.at + sg * (t / 2 + proud);
        for (const [a, b] of runs(w.from, w.to, cuts)) {
          // Wrap the corners: a run that reaches the wall's end runs on to the outside face of the wall it meets.
          const a2 = Math.abs(a - w.from) < 1e-6 ? a - t / 2 - proud : a;
          const b2 = Math.abs(b - w.to) < 1e-6 ? b + t / 2 + proud : b;
          place(s, mat, w.dir, (a2 + b2) / 2, (inner + outer) / 2, zc, b2 - a2, Math.abs(outer - inner), sz);
        }
      };
      const plinth = blk && finishOf(design, blk.id)?.base && isMaterial(finishOf(design, blk.id)!.base) ? `plinth:${blk.id}` : 'plinth';
      if (s === 0) strip(plinth, 0.2, 0.5, 0.025, holes(0, w.dir, w.at, (o) => o.sillM < 0.5));
      else strip('band', -0.03, 0.3, look.bandProud, [...holes(s, w.dir, w.at, (o) => o.sillM < 0.15), ...holes(s - 1, w.dir, w.at, (o) => o.headM > H - 0.2)]);
      if (pitched && blk && s === blk.storeys - 1) strip('band', H - 0.14, 0.28, look.bandProud, holes(s, w.dir, w.at, (o) => o.headM > H - 0.3));
    }
  }

  // ------------------------------------------------ the architecture: porches, balconies, canopies, pergolas...
  const accent: MaterialKey = isMaterial(mainFinish?.accent) ? mainFinish!.accent! : 'timber';
  for (const [i, e] of (design.elements ?? []).entries()) {
    if (!(e.w > 0.01 && e.d > 0.01)) continue;
    const s = Math.min(Math.max(0, Math.round(e.storey)), top - 1);
    const att = attachedSides(design, e);
    const x0 = e.x, x1 = e.x + e.w, y0 = e.y, y1 = e.y + e.d;
    const z = s * H;
    const key: MaterialKey = isMaterial(e.material) ? e.material : accent;
    const solid = photo ? `m:${key}:solid` : 'post';
    const clad = photo ? `m:${key}` : `mm:${key}`;
    const near = design.blocks.find((b) => s < b.storeys && x1 >= b.x - 0.2 && x0 <= b.x + b.w + 0.2 && y1 >= b.y - 0.2 && y0 <= b.y + b.d + 0.2) ?? design.blocks[0];
    const render = has(wallMat(near?.id), 'elem');
    switch (e.kind) {
      case 'porch': case 'veranda': {
        // A roofed outdoor room: paved floor, slim columns, a thin roof slab at the storey height with a fascia.
        const zt = z + H; const rt = 0.22; const ov = 0.15;
        const rx0 = x0 - (att.left ? 0 : ov), rx1 = x1 + (att.right ? 0 : ov), ry0 = y0 - (att.front ? 0 : ov), ry1 = y1 + (att.rear ? 0 : ov);
        box(s, has('paving', 'elemLight'), x0, x1, y0, y1, z, z + 0.12);
        if (photo) {
          // Steps down at the open front edge of a raised porch.
          if (!att.front) box(s, 'paving', x0 + 0.3, x1 - 0.3, y0 - 0.32, y0, z, z + 0.06);
          box(s, render, rx0, rx1, ry0, ry1, zt - rt, zt, true);
          // Soffit: timber boarding under a timber porch, else a render ceiling with downlights.
          if (key === 'timber') box(s, 'm:timber', rx0 + 0.03, rx1 - 0.03, ry0 + 0.03, ry1 - 0.03, zt - rt - 0.025, zt - rt, true, false);
          const fasc = (a0: number, a1: number, b0: number, b1: number) => box(s, solid, a0, a1, b0, b1, zt - 0.3, zt + 0.03, true);
          if (!att.front) fasc(rx0 - 0.04, rx1 + 0.04, ry0 - 0.05, ry0);
          if (!att.rear) fasc(rx0 - 0.04, rx1 + 0.04, ry1, ry1 + 0.05);
          if (!att.left) fasc(rx0 - 0.05, rx0, ry0, ry1);
          if (!att.right) fasc(rx1, rx1 + 0.05, ry0, ry1);
          // Downlights along the middle of the ceiling, about every 1.6 m.
          const lx = e.w >= e.d; const L = lx ? e.w : e.d; const n = Math.max(1, Math.round(L / 1.6));
          const under = zt - rt - (key === 'timber' ? 0.025 : 0);
          for (let k = 0; k < n; k++) {
            const px = lx ? x0 + (e.w * (k + 0.5)) / n : x0 + e.w / 2; const py = lx ? y0 + e.d / 2 : y0 + (e.d * (k + 0.5)) / n;
            box(s, 'downlight', px - 0.06, px + 0.06, py - 0.06, py + 0.06, under - 0.012, under, true, false);
          }
        } else box(s, 'elem', rx0, rx1, ry0, ry1, zt - rt, zt, true);
        const cw = 0.2;
        for (const [px, py] of postsFor(e, att, 0.22, 3)) {
          box(s, solid, px - cw / 2, px + cw / 2, py - cw / 2, py + cw / 2, z + 0.12, zt - rt);
          if (photo) {
            const baseMat = key === 'timber' ? (isMaterial(finishOf(design, near?.id)?.base) ? `m:${finishOf(design, near?.id)!.base}` : 'm:stone') : solid;
            box(s, baseMat, px - 0.15, px + 0.15, py - 0.15, py + 0.15, z + 0.12, z + 0.5);
            box(s, solid, px - 0.14, px + 0.14, py - 0.14, py + 0.14, zt - rt - 0.08, zt - rt);
          }
        }
        break;
      }
      case 'balcony': {
        // A cantilevered slab at floor level with a glass balustrade on its open sides (metal shoe and handrail).
        const zt = z - 0.03; const rh = 1.1; const i0 = 0.05;
        box(s, render, x0, x1, y0, y1, z - 0.23, zt);
        if (photo) box(s, 'paving', x0 + 0.04, x1 - 0.04, y0 + 0.04, y1 - 0.04, zt, zt + 0.015, false, false);
        const rail = photo ? (key === 'timber' ? 'm:timber:solid' : 'm:metal-dark:solid') : 'elem';
        const lines: [number, number, number, number][] = []; // x0, x1, y0, y1 of each balustrade line
        const ya = att.front ? y0 : y0 + i0; const yb = att.rear ? y1 : y1 - i0;
        if (!att.front) lines.push([x0 + i0, x1 - i0, y0 + i0, y0 + i0]);
        if (!att.rear) lines.push([x0 + i0, x1 - i0, y1 - i0, y1 - i0]);
        if (!att.left) lines.push([x0 + i0, x0 + i0, ya, yb]);
        if (!att.right) lines.push([x1 - i0, x1 - i0, ya, yb]);
        for (const [a0, a1, b0, b1] of lines) {
          const th = (v0: number, v1: number, t: number): [number, number] => (Math.abs(v1 - v0) < 1e-6 ? [v0 - t / 2, v0 + t / 2] : [v0, v1]);
          const [gx0, gx1] = th(a0, a1, 0.016); const [gy0, gy1] = th(b0, b1, 0.016);
          box(s, 'rail', gx0, gx1, gy0, gy1, zt + 0.07, zt + rh - 0.04, false, false);
          const [hx0, hx1] = th(a0, a1, 0.05); const [hy0, hy1] = th(b0, b1, 0.05);
          box(s, rail, hx0, hx1, hy0, hy1, zt + rh - 0.05, zt + rh);
          if (photo) {
            const [sx0, sx1] = th(a0, a1, 0.06); const [sy0, sy1] = th(b0, b1, 0.06);
            box(s, rail, sx0, sx1, sy0, sy1, zt, zt + 0.08);
            for (const [px, py] of [[a0, b0], [a1, b1]] as const) box(s, rail, px - 0.025, px + 0.025, py - 0.025, py + 0.025, zt, zt + rh);
          }
        }
        break;
      }
      case 'canopy': {
        // A thin flat roof over the door, held by two slim tie rods back to the wall.
        const zc = z + (e.heightM ?? 2.4);
        const mat = photo ? solid : 'elem';
        box(s, mat, x0, x1, y0, y1, zc, zc + 0.15, true);
        if (photo) {
          box(s, 'downlight', (x0 + x1) / 2 - 0.08, (x0 + x1) / 2 + 0.08, (y0 + y1) / 2 - 0.08, (y0 + y1) / 2 + 0.08, zc - 0.012, zc, true, false);
          const rodMat = 'm:metal-dark:solid';
          const ends: [[number, number], [number, number]][] = att.rear ? [[[x0 + 0.12, y0 + 0.06], [x0 + 0.12, y1]], [[x1 - 0.12, y0 + 0.06], [x1 - 0.12, y1]]]
            : att.front ? [[[x0 + 0.12, y1 - 0.06], [x0 + 0.12, y0]], [[x1 - 0.12, y1 - 0.06], [x1 - 0.12, y0]]]
              : att.left ? [[[x1 - 0.06, y0 + 0.12], [x0, y0 + 0.12]], [[x1 - 0.06, y1 - 0.12], [x0, y1 - 0.12]]]
                : att.right ? [[[x0 + 0.06, y0 + 0.12], [x1, y0 + 0.12]], [[x0 + 0.06, y1 - 0.12], [x1, y1 - 0.12]]] : [];
          for (const [[ox, oy], [wx, wy]] of ends) rod(s, rodMat, [ox, oy, zc + 0.15], [wx, wy, zc + 1.15], 0.028);
        }
        break;
      }
      case 'pergola': {
        // Posts, beams on the open sides (a ledger on the wall) and parallel slats running away from the building.
        const h = e.heightM ?? 2.7; const bd = 0.24;
        const mat = solid;
        const pw = 0.15;
        for (const [px, py] of postsFor(e, att, 0.12, 3)) box(s, mat, px - pw / 2, px + pw / 2, py - pw / 2, py + pw / 2, z, z + h - bd, false);
        const beam = (a0: number, a1: number, b0: number, b1: number) => box(s, mat, a0, a1, b0, b1, z + h - bd, z + h, true);
        if (!att.front) beam(x0, x1, y0 + 0.06, y0 + 0.18); else beam(x0, x1, y0, y0 + 0.08);
        if (!att.rear) beam(x0, x1, y1 - 0.18, y1 - 0.06); else beam(x0, x1, y1 - 0.08, y1);
        if (!att.front && !att.rear) {
          if (!att.left) beam(x0 + 0.06, x0 + 0.18, y0, y1);
          if (!att.right) beam(x1 - 0.18, x1 - 0.06, y0, y1);
        }
        const alongY = att.front || att.rear || (!att.left && !att.right && e.d <= e.w);
        const sp = photo ? 0.42 : 0.85; const st = 0.05; const sd = photo ? 0.16 : 0.12;
        const L = alongY ? e.w : e.d; const n = Math.max(2, Math.floor((L - 0.1) / sp) + 1);
        for (let k = 0; k < n; k++) {
          const u = (alongY ? x0 : y0) + 0.05 + ((L - 0.1) * k) / (n - 1);
          if (alongY) box(s, mat, u - st / 2, u + st / 2, y0 - (att.front ? 0 : 0.25), y1 + (att.rear ? 0 : 0.25), z + h - 0.02, z + h - 0.02 + sd, true);
          else box(s, mat, x0 - (att.left ? 0 : 0.25), x1 + (att.right ? 0 : 0.25), u - st / 2, u + st / 2, z + h - 0.02, z + h - 0.02 + sd, true);
        }
        if (photo) {
          // A few climbers at the posts, and a timber deck or paving under the frame.
          box(s, 'paving', x0, x1, y0, y1, z, z + 0.05, false, false);
          postsFor(e, att, 0.12, 3).slice(0, 2).forEach(([px, py], k) => plants.push({ s, x: px, y: py, z: z + 0.45, r: 0.45, seed: i * 7 + k }));
        }
        break;
      }
      case 'screen': {
        // Vertical louvre fins across a thin strip in front of the facade, with top and bottom rails.
        const long = e.w >= e.d; const L = long ? e.w : e.d; const T = Math.max(0.06, long ? e.d : e.w);
        const h = e.heightM ?? top * H; const zb = z; const zt = z + h;
        const ft = photo ? 0.035 : 0.05; const sp = photo ? 0.13 : 0.3;
        const n = Math.max(2, Math.floor((L - ft) / sp) + 1);
        for (let k = 0; k < n; k++) {
          const u = (long ? x0 : y0) + ft / 2 + ((L - ft) * k) / (n - 1);
          if (long) tall(solid, u - ft / 2, u + ft / 2, y0, y0 + T, zb, zt);
          else tall(solid, x0, x0 + T, u - ft / 2, u + ft / 2, zb, zt);
        }
        if (photo) for (const [a, b] of [[zb, zb + 0.06], [zt - 0.06, zt]] as const) {
          if (long) box(Math.min(top - 1, Math.floor(a / H)), solid, x0, x1, y0 + T * 0.2, y0 + T * 0.8, a, b);
          else box(Math.min(top - 1, Math.floor(a / H)), solid, x0 + T * 0.2, x0 + T * 0.8, y0, y1, a, b);
        }
        break;
      }
      case 'feature-wall': {
        // A cladding panel on the facade (stone, timber boards, brick...), standing a little proud with a dark reveal.
        const h = e.heightM ?? H;
        tall(clad, x0, x1, y0, y1, z, z + h);
        if (photo) {
          const lr = e.w >= e.d;
          const cap = (a0: number, a1: number, b0: number, b1: number) => box(Math.min(top - 1, Math.floor((z + h - 0.03) / H)), 'm:metal-dark:solid', a0, a1, b0, b1, z + h - 0.03, z + h);
          if (lr) cap(x0 - 0.01, x1 + 0.01, y0 - 0.01, y1); else cap(x0, x1 + 0.01, y0 - 0.01, y1 + 0.01);
        }
        break;
      }
      case 'planter': {
        // A low box with soil and planting.
        const h = e.heightM ?? 0.6; const t = Math.min(0.08, e.w / 4, e.d / 4);
        const pm = photo ? (isMaterial(e.material) ? `m:${e.material}` : 'm:concrete') : clad;
        box(s, pm, x0, x1, y0, y0 + t, z, z + h); box(s, pm, x0, x1, y1 - t, y1, z, z + h);
        box(s, pm, x0, x0 + t, y0 + t, y1 - t, z, z + h); box(s, pm, x1 - t, x1, y0 + t, y1 - t, z, z + h);
        box(s, photo ? 'soil' : 'green', x0 + t, x1 - t, y0 + t, y1 - t, z, z + h - (photo ? 0.06 : 0.02), false, false);
        const long = e.w >= e.d; const L = long ? e.w : e.d; const r = Math.min(0.42, (Math.min(e.w, e.d) / 2) * 1.05);
        const n = Math.max(1, Math.round(L / (r * 1.5)));
        for (let k = 0; k < n; k++) {
          const u = (k + 0.5) / n;
          plants.push({ s, x: long ? x0 + e.w * u : x0 + e.w / 2, y: long ? y0 + e.d / 2 : y0 + e.d * u, z: z + h + r * 0.15, r: r * (0.85 + hash2(i, k) * 0.3), seed: i * 11 + k });
        }
        break;
      }
      default: break;
    }
  }

  const out: Part[][] = Array.from({ length: design.storeys + 1 }, () => []);
  for (const e of builders.values()) {
    const geo = e.b.geometry();
    if (geo && out[e.s]) out[e.s]!.push({ mat: e.mat, geo, cast: e.cast, receive: e.cast, over: e.over });
  }
  return { parts: out, plants };
}

function House({ plot, design, view, dark, photo, instant = false }: SceneProps & { design: Design; photo: boolean; instant?: boolean }) {
  const look = useMemo(() => lookFor(design), [design]);
  const dusk = photo && dark;
  const { parts, plants } = useMemo(() => buildParts(design, plot, photo, look, dusk), [design, plot, photo, look, dusk]);
  const mats = useMemo(() => makeMaterials(photo, dark, look, design), [photo, dark, look, design]);
  useEffect(() => () => { for (const s of parts) for (const p of s) p.geo.dispose(); }, [parts]);
  useEffect(() => () => { for (const m of new Set(Object.values(mats))) m.dispose(); }, [mats]);
  const top = view === 'outside' ? design.storeys : view + 1; // storeys shown
  const showRoof = view === 'outside';
  const refs = useBuildUp(instant);
  const roof = useMemo(() => roofGeometry(design, plot), [design, plot]);
  const roofWalls = useMemo(() => roofGeometry(design, plot, true), [design, plot]);
  useEffect(() => () => { roof?.dispose(); roofWalls?.dispose(); }, [roof, roofWalls]);
  const H = design.storeyHeightM;
  const at = toScene(plot);
  const c = dark ? PALETTE.dark : PALETTE.light;
  const surface = ROOF_SURFACE[design.roof.finish] ?? ROOF_SURFACE.aluminium!;
  const pad = photo ? '#b9b4aa' : c.pad;
  const gable = mats[`wall:${design.blocks[0]?.id}`] ?? mats.wall;
  const plantMat = mats.green;

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
        <group key={s} ref={(g) => { refs.current[s] = g; }} position={[0, s * H, 0]} visible={instant}>
          {(s < top || (s === design.storeys && showRoof)) && storey.filter((p) => !p.over || view === 'outside' || s < view).map((p) => (
            <mesh key={`${p.mat}${p.cast ? 1 : 0}${p.over ? 1 : 0}`} geometry={p.geo} material={mats[p.mat] ?? mats.wall ?? mats.wallExt} castShadow={p.cast} receiveShadow={p.receive} />
          ))}
          {s < top && plants.filter((p) => p.s === s).map((p) => {
            const [X, Z] = at(p.x, p.y);
            return photo
              ? <mesh key={p.seed} geometry={kit().blob} material={kit().leaves[p.seed % 4]} position={[X, p.z - s * H, Z]} scale={[p.r, p.r * 0.8, p.r]} castShadow receiveShadow />
              : <mesh key={p.seed} geometry={kit().blob} material={plantMat} position={[X, p.z - s * H, Z]} scale={[p.r, p.r * 0.8, p.r]} castShadow />;
          })}
          {s === design.storeys && showRoof && roof && (
            <mesh geometry={roof} position={[0, -s * H, 0]} castShadow receiveShadow={photo}>
              {photo
                ? <meshStandardMaterial color={design.roof.colour} side={THREE.DoubleSide} roughness={surface.roughness} metalness={surface.metalness} />
                : <meshStandardMaterial color={design.roof.colour} side={THREE.DoubleSide} roughness={design.roof.finish === 'concrete-tile' ? 0.85 : 0.55} metalness={design.roof.finish === 'concrete-tile' ? 0 : 0.25} />}
            </mesh>
          )}
          {s === design.storeys && showRoof && roofWalls && (
            photo
              ? <mesh geometry={roofWalls} position={[0, -s * H, 0]} material={gable} castShadow receiveShadow />
              : (
                <mesh geometry={roofWalls} position={[0, -s * H, 0]} castShadow receiveShadow>
                  <meshStandardMaterial color={c.wallExt} side={THREE.DoubleSide} roughness={0.9} />
                </mesh>
              )
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
