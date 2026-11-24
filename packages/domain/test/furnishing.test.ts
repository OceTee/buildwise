import { describe, expect, it } from 'vitest';
import { furnishFloor, type Opening, type Room } from '../src/index';

const room: Room = { id: 'bedroom', kind: 'master', name: 'Master bedroom', storey: 0, block: 'house', x: 1, y: 1, w: 4, d: 4 };
const door: Opening = { id: 'door', kind: 'door', storey: 0, roomId: 'hall', dir: 'h', at: 1, from: 1, to: 2, sillM: 0, headM: 2, external: false, label: 'Door' };

describe('suggested furnishings', () => {
  it('places furniture on the selected floor, clear of a door connected to the neighbouring room', () => {
    const design = { rooms: [room, { ...room, id: 'upstairs', storey: 1 }], openings: [door] };
    const [bed] = furnishFloor(design, 0);
    expect(bed).toMatchObject({ kind: 'bed', roomId: room.id, x: 3.02, y: 1.18 });
    expect(furnishFloor(design, 1).map((item) => item.roomId)).toEqual(['upstairs']);
  });

  it('omits furnishings when the available space cannot fit them', () => {
    expect(furnishFloor({ rooms: [{ ...room, w: 1.7, d: 2.2 }], openings: [] }, 0)).toEqual([]);
  });
});
