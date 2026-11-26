import { useMemo } from 'react';
import { Matrix4 } from 'three';
import { furnishFloor, WET, type Design, type FurnishingKind } from '@bw/domain';

// [finish, x, depth, height, width, depth, height]. Plan offsets and sizes are fractions of the footprint.
type Piece = [colour: string, x: number, y: number, z: number, w: number, d: number, h: number];
const oak = '#a17048';
const chalk = '#f2eadc';
const linen = '#d6c6ae';
const olive = '#79866d';
const basalt = '#44464b';
const ceramic = '#f3f4f2';
const legs = (z: number, colour = oak): Piece[] => [0.1, 0.9].flatMap((x) =>
  [0.15, 0.85].map((y): Piece => [colour, x, y, z / 2, 0.055, 0.065, z]));
const table: Piece[] = [[oak, 0.5, 0.5, 0.72, 0.76, 0.46, 0.05],
  ...[0.29, 0.71].flatMap((x) => [0.14, 0.86].flatMap((y): Piece[] =>
    [[olive, x, y, 0.43, 0.17, 0.23, 0.08], [oak, x, y, 0.19, 0.095, 0.13, 0.38]])),
  ...[0.2, 0.8].flatMap((x) => [0.34, 0.66].map((y): Piece => [oak, x, y, 0.34, 0.035, 0.04, 0.68]))];
const desk: Piece[] = [[oak, 0.5, 0.25, 0.73, 0.95, 0.45, 0.055], [oak, 0.16, 0.25, 0.35, 0.1, 0.31, 0.7],
  [oak, 0.84, 0.25, 0.35, 0.1, 0.31, 0.7], [olive, 0.5, 0.74, 0.43, 0.34, 0.31, 0.1],
  [basalt, 0.5, 0.74, 0.19, 0.15, 0.15, 0.38], [olive, 0.5, 0.89, 0.63, 0.32, 0.045, 0.32]];
const models: Record<FurnishingKind, Piece[]> = {
  bed: [[oak, 0.5, 0.5, 0.16, 0.99, 0.98, 0.24], [chalk, 0.5, 0.51, 0.35, 0.94, 0.93, 0.17],
    [olive, 0.5, 0.66, 0.445, 0.96, 0.6, 0.04], [oak, 0.5, 0.035, 0.48, 1, 0.07, 0.96],
    [linen, 0.27, 0.18, 0.46, 0.4, 0.17, 0.07], [linen, 0.73, 0.18, 0.46, 0.4, 0.17, 0.07]],
  sofa: [[linen, 0.5, 0.5, 0.27, 1, 1, 0.3], [linen, 0.5, 0.08, 0.58, 1, 0.16, 0.42],
    ...[0.055, 0.945].map((x): Piece => [linen, x, 0.5, 0.52, 0.11, 0.92, 0.28]),
    ...[0.22, 0.5, 0.78].map((x): Piece => [chalk, x, 0.56, 0.45, 0.26, 0.73, 0.1]), ...legs(0.12)],
  'dining-table': table,
  counter: [[oak, 0.5, 0.5, 0.42, 0.97, 0.96, 0.84], [chalk, 0.5, 0.5, 0.88, 1, 1, 0.06],
    ...[0.17, 0.5, 0.83].map((x): Piece => [basalt, x, 0.99, 0.7, 0.13, 0.02, 0.025])],
  toilet: [[ceramic, 0.5, 0.73, 0.55, 0.94, 0.28, 0.55], [ceramic, 0.5, 0.39, 0.21, 0.68, 0.48, 0.42],
    [ceramic, 0.5, 0.36, 0.43, 0.98, 0.64, 0.07], [chalk, 0.5, 0.36, 0.474, 0.88, 0.54, 0.024]],
  shower: [[ceramic, 0.5, 0.5, 0.05, 1, 1, 0.1], [basalt, 0.5, 0.5, 0.105, 0.12, 0.12, 0.012],
    [basalt, 0.92, 0.08, 0.88, 0.035, 0.035, 1.65]],
  desk,
  'gaming-desk': [...desk, [basalt, 0.5, 0.1, 1.01, 0.65, 0.045, 0.38]],
  'training-bench': [[basalt, 0.5, 0.5, 0.51, 0.9, 0.5, 0.1], ...legs(0.46, basalt)],
  armchair: [[olive, 0.5, 0.55, 0.25, 1, 0.9, 0.28], [olive, 0.5, 0.1, 0.55, 1, 0.2, 0.42],
    ...[0.07, 0.93].map((x): Piece => [olive, x, 0.55, 0.5, 0.14, 0.9, 0.22]), [chalk, 0.5, 0.6, 0.42, 0.72, 0.62, 0.1], ...legs(0.11)],
  'coffee-table': [[oak, 0.5, 0.5, 0.42, 1, 1, 0.05], ...legs(0.4)],
  'tv-unit': [[basalt, 0.5, 0.5, 0.25, 1, 1, 0.5], [basalt, 0.5, 0.2, 1.05, 0.72, 0.06, 0.62], [oak, 0.5, 0.5, 0.51, 1, 1, 0.03]],
  'side-table': [[oak, 0.5, 0.5, 0.27, 1, 1, 0.54], [chalk, 0.5, 0.5, 0.75, 0.4, 0.4, 0.4]],
  wardrobe: [[chalk, 0.5, 0.5, 1.1, 1, 1, 2.2], ...[0.25, 0.75].map((x): Piece => [oak, x, 0.99, 1.1, 0.02, 0.02, 0.5])],
  fridge: [[chalk, 0.5, 0.5, 0.9, 1, 1, 1.8], [basalt, 0.85, 0.99, 1.2, 0.04, 0.02, 0.6]],
  basin: [[oak, 0.5, 0.5, 0.4, 1, 1, 0.8], [ceramic, 0.5, 0.5, 0.83, 0.8, 0.7, 0.08]],
};

export function FurnishedFloor({ design, floor }: { design: Design; floor: number }) {
  const rooms = useMemo(() => design.rooms.filter((room) => room.storey === floor), [design, floor]);
  const batches = useMemo(() => {
    const x0 = design.plot.widthM / 2;
    const z0 = design.plot.depthM / 2;
    const out = new Map<string, Matrix4[]>();
    const place = (colour: string, x: number, y: number, z: number, w: number, d: number, h: number) => {
      const matrix = new Matrix4().makeScale(w, h, d).setPosition(x, y, z);
      const batch = out.get(colour) ?? [];
      batch.push(matrix);
      out.set(colour, batch);
    };
    for (const room of rooms) {
      const colour = WET.has(room.kind) ? '#c4cfca' : room.kind === 'gym' ? '#8b9090' : '#cbb495';
      place(colour, room.x + room.w / 2 - x0, -0.006, z0 - room.y - room.d / 2,
        Math.max(0.01, room.w - 0.08), Math.max(0.01, room.d - 0.08), 0.012);
    }
    for (const item of furnishFloor(design, floor)) {
      const centreX = item.x + item.w / 2 - x0;
      const centreZ = z0 - item.y - item.d / 2;
      // A model is drawn with its back at local y = 0; turn it so its back is to the item's wall (n, s, e or w).
      const width = item.turn ? item.d : item.w;
      const depth = item.turn ? item.w : item.d;
      for (const [colour, x, y, z, w, d, h] of models[item.kind]) {
        const u = (x - 0.5) * width; const v = (y - 0.5) * depth; // across the item, and from its back to its front
        // Plan offsets from the item's centre (px along x, py along y), by the side its back is to.
        const [px, py] = item.back === 'n' ? [u, v] : item.back === 's' ? [-u, -v] : item.back === 'e' ? [-v, u] : [v, -u];
        place(colour, centreX + px, z, centreZ - py, item.turn ? d * depth : w * width, item.turn ? w * width : d * depth, h);
      }
    }
    return [...out];
  }, [design, floor, rooms]);
  const level = floor === 0 ? design.slabM : 0;
  return <group position={[0, level + 0.015, 0]} name="Furnished floor">
    {batches.map(([colour, matrices]) => (
      <instancedMesh key={colour} args={[undefined, undefined, matrices.length]} castShadow receiveShadow ref={(mesh) => {
        if (!mesh) return;
        matrices.forEach((matrix, i) => mesh.setMatrixAt(i, matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color={colour} roughness={0.8} />
      </instancedMesh>
    ))}
  </group>;
}
