import { DEFAULT_DESIGN_CONFIG, type Design, type Room } from '../src/index';

/** Public zones can have an open side. Enclosed rooms still need a drawn door. */
export function hasPlanAccess(d: Design, room: Room): boolean {
  if (d.openings.some((o) => o.roomId === room.id && o.kind === 'door')) return true;
  if (!['living', 'dining', 'living-kitchen', 'kitchen', 'lounge'].includes(room.kind)) return false;

  const same = (a: number, b: number) => Math.abs(a - b) < 0.001;
  for (const other of d.rooms) {
    if (other.id === room.id || other.storey !== room.storey) continue;
    const contacts = [
      { dir: 'v', at: room.x, matches: same(room.x, other.x + other.w), from: Math.max(room.y, other.y), to: Math.min(room.y + room.d, other.y + other.d) },
      { dir: 'v', at: room.x + room.w, matches: same(room.x + room.w, other.x), from: Math.max(room.y, other.y), to: Math.min(room.y + room.d, other.y + other.d) },
      { dir: 'h', at: room.y, matches: same(room.y, other.y + other.d), from: Math.max(room.x, other.x), to: Math.min(room.x + room.w, other.x + other.w) },
      { dir: 'h', at: room.y + room.d, matches: same(room.y + room.d, other.y), from: Math.max(room.x, other.x), to: Math.min(room.x + room.w, other.x + other.w) },
    ];
    if (contacts.some((e) => e.matches && e.to - e.from >= DEFAULT_DESIGN_CONFIG.minDoorM
      && !d.walls.some((w) => w.storey === room.storey && w.dir === e.dir && same(w.at, e.at)
        && Math.min(w.to, e.to) - Math.max(w.from, e.from) > 0.001))) return true;
  }
  return false;
}
