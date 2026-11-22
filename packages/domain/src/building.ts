/**
 * What can be built: homes, commercial, hospitality and institutional buildings, each with its own storey range,
 * the one number that sizes it (flats per floor, guest rooms per floor, seats…), optional features, and the
 * proportions the generator tries. Values are [proposed] concept-design defaults, not code requirements.
 */

export type BuildingFamily = 'home' | 'commercial' | 'hospitality' | 'institutional';

export type BuildingType =
  | 'bungalow' | 'duplex' | 'terrace' | 'apartments'
  | 'shops' | 'office' | 'mixed-use' | 'warehouse'
  | 'hotel' | 'event-hall'
  | 'school' | 'clinic' | 'worship';

export type FeatureKey =
  | 'gym' | 'gaming' | 'cinema' | 'family-lounge' | 'laundry' | 'prayer' | 'lift'
  | 'conference' | 'restaurant' | 'canteen' | 'library' | 'lab' | 'pharmacy' | 'upper-offices';

export const FEATURES: Record<FeatureKey, { label: string; blurb: string }> = {
  gym: { label: 'Gym', blurb: 'A room for exercise equipment.' },
  gaming: { label: 'Gaming room', blurb: 'Games, consoles and a big screen.' },
  cinema: { label: 'Home cinema', blurb: 'A dark room for films.' },
  'family-lounge': { label: 'Family lounge', blurb: 'A second, private sitting room.' },
  laundry: { label: 'Laundry', blurb: 'Washing machine, dryer and ironing.' },
  prayer: { label: 'Prayer room', blurb: 'A quiet room for prayer.' },
  lift: { label: 'Lift', blurb: 'A passenger lift (added automatically in tall buildings).' },
  conference: { label: 'Conference room', blurb: 'A large meeting room.' },
  restaurant: { label: 'Restaurant', blurb: 'Dining room with its own kitchen.' },
  canteen: { label: 'Canteen', blurb: 'Where staff or pupils eat.' },
  library: { label: 'Library', blurb: 'Books and quiet study.' },
  lab: { label: 'Laboratory', blurb: 'Science lab or medical lab.' },
  pharmacy: { label: 'Pharmacy', blurb: 'Dispensary by the entrance.' },
  'upper-offices': { label: 'Offices above (instead of flats)', blurb: 'Upper floors let as offices.' },
};

export interface BuildingTypeInfo {
  label: string;
  family: BuildingFamily;
  blurb: string;
  storeys: { min: number; max: number; default: number };
  /** The number that sizes the building, when it has one. `perFloor` counts per typical floor. */
  units?: { label: string; short: string; min: number; max: number; step: number; default: number; perFloor: boolean };
  /** Bedrooms per home or flat, when the type has them. */
  bedrooms?: { label: string; min: number; max: number; default: number };
  features: FeatureKey[];
  /** Features switched on when the type is first chosen. */
  defaultFeatures?: FeatureKey[];
  /** Floor-to-floor height, metres. */
  storeyHeightM: number;
  corridorM: number;
  corridorNames: [string, string];
  /** Depth pairs (front band, rear band) the generator tries, metres. A front depth of 0 means one row of rooms. */
  bands: [number, number][];
  /** True when the rooms have no shared corridor (each home in a terrace has its own front door). */
  noCorridor?: boolean;
  /** Building cost per m² relative to a standard home. */
  costFactor: number;
  /** Square metres of floor per person using the building at once (sizes water, power and toilets). */
  m2PerPerson: number;
}

export const BUILDING_FAMILIES: Record<BuildingFamily, { label: string; blurb: string }> = {
  home: { label: 'Homes', blurb: 'Bungalows, duplexes, terraces and blocks of flats.' },
  commercial: { label: 'Commercial', blurb: 'Shops and plazas, offices, mixed-use and warehouses.' },
  hospitality: { label: 'Hospitality', blurb: 'Hotels, guest houses and event centres.' },
  institutional: { label: 'Institutional', blurb: 'Schools, clinics and places of worship.' },
};

const HOME_FEATURES: FeatureKey[] = ['family-lounge', 'gym', 'gaming', 'cinema', 'laundry', 'prayer'];

export const BUILDING_TYPES: Record<BuildingType, BuildingTypeInfo> = {
  bungalow: {
    label: 'Bungalow', family: 'home', blurb: 'A single-storey family home.',
    storeys: { min: 1, max: 1, default: 1 }, bedrooms: { label: 'Bedrooms', min: 1, max: 6, default: 3 },
    features: HOME_FEATURES, storeyHeightM: 3.0, corridorM: 1.2, corridorNames: ['Hallway', 'Landing'], bands: [], costFactor: 1, m2PerPerson: 30,
  },
  duplex: {
    label: 'Duplex', family: 'home', blurb: 'A family home on two or three floors.',
    storeys: { min: 2, max: 3, default: 2 }, bedrooms: { label: 'Bedrooms', min: 2, max: 6, default: 4 },
    features: [...HOME_FEATURES, 'lift'], storeyHeightM: 3.0, corridorM: 1.2, corridorNames: ['Hallway', 'Landing'], bands: [], costFactor: 1.05, m2PerPerson: 35,
  },
  terrace: {
    label: 'Terrace houses', family: 'home', blurb: 'A row of townhouses, each with its own front door.',
    storeys: { min: 2, max: 3, default: 2 }, bedrooms: { label: 'Bedrooms per house', min: 2, max: 4, default: 3 },
    units: { label: 'Houses in the row', short: 'houses', min: 2, max: 8, step: 1, default: 4, perFloor: false },
    features: [], storeyHeightM: 3.0, corridorM: 0, corridorNames: ['', ''], bands: [[0, 8], [0, 9.5], [0, 11]], noCorridor: true, costFactor: 1, m2PerPerson: 30,
  },
  apartments: {
    label: 'Block of flats', family: 'home', blurb: 'Apartments around a shared stair (and lift when tall).',
    storeys: { min: 2, max: 10, default: 4 }, bedrooms: { label: 'Bedrooms per flat', min: 1, max: 4, default: 2 },
    units: { label: 'Flats per floor', short: 'flats per floor', min: 2, max: 8, step: 1, default: 4, perFloor: true },
    features: ['gym', 'laundry', 'lift'], storeyHeightM: 3.0, corridorM: 1.5, corridorNames: ['Entrance corridor', 'Corridor'],
    bands: [[9, 9], [10.5, 10.5], [8, 8]], costFactor: 1.05, m2PerPerson: 30,
  },
  shops: {
    label: 'Shops and plaza', family: 'commercial', blurb: 'Lock-up shops facing the street, more off a gallery behind.',
    storeys: { min: 1, max: 4, default: 2 },
    units: { label: 'Shops per floor', short: 'shops per floor', min: 2, max: 16, step: 1, default: 6, perFloor: true },
    features: ['lift'], storeyHeightM: 3.6, corridorM: 2.4, corridorNames: ['Service corridor', 'Shopping gallery'],
    bands: [[5.4, 5.4], [6.6, 6.6], [4.5, 4.5]], costFactor: 0.95, m2PerPerson: 5,
  },
  office: {
    label: 'Office building', family: 'commercial', blurb: 'Lettable office suites around a stair and lift core.',
    storeys: { min: 1, max: 10, default: 4 },
    units: { label: 'Office suites per floor', short: 'suites per floor', min: 1, max: 6, step: 1, default: 2, perFloor: true },
    features: ['conference', 'canteen', 'gym', 'lift'], defaultFeatures: ['conference'], storeyHeightM: 3.5, corridorM: 1.8, corridorNames: ['Reception corridor', 'Corridor'],
    bands: [[9, 9], [7.5, 7.5], [12, 12]], costFactor: 1.15, m2PerPerson: 10,
  },
  'mixed-use': {
    label: 'Mixed-use', family: 'commercial', blurb: 'Shops on the ground floor, flats or offices above.',
    storeys: { min: 2, max: 10, default: 4 }, bedrooms: { label: 'Bedrooms per flat', min: 1, max: 3, default: 2 },
    units: { label: 'Shops on the ground floor', short: 'shops', min: 2, max: 12, step: 1, default: 4, perFloor: false },
    features: ['upper-offices', 'gym', 'lift'], storeyHeightM: 3.3, corridorM: 1.8, corridorNames: ['Service corridor', 'Corridor'],
    bands: [[9, 9], [7.5, 7.5], [10.5, 10.5]], costFactor: 1.1, m2PerPerson: 15,
  },
  warehouse: {
    label: 'Warehouse', family: 'commercial', blurb: 'A clear-span store with offices and a loading bay.',
    storeys: { min: 1, max: 2, default: 1 },
    units: { label: 'Storage floor area (m²)', short: 'm² of storage', min: 200, max: 5000, step: 100, default: 600, perFloor: false },
    features: ['canteen'], storeyHeightM: 6.0, corridorM: 1.5, corridorNames: ['Corridor', 'Corridor'],
    bands: [[6, 15], [6, 20], [6, 25], [5, 9]], costFactor: 0.6, m2PerPerson: 40,
  },
  hotel: {
    label: 'Hotel', family: 'hospitality', blurb: 'Guest rooms with their own bathrooms, a lobby and a restaurant.',
    storeys: { min: 2, max: 10, default: 4 },
    units: { label: 'Guest rooms per floor', short: 'rooms per floor', min: 4, max: 24, step: 1, default: 10, perFloor: true },
    features: ['restaurant', 'conference', 'gym', 'lift'], defaultFeatures: ['restaurant'], storeyHeightM: 3.2, corridorM: 1.6, corridorNames: ['Reception corridor', 'Corridor'],
    bands: [[6.6, 6.6], [7.2, 7.2], [6, 6]], costFactor: 1.3, m2PerPerson: 15,
  },
  'event-hall': {
    label: 'Event centre', family: 'hospitality', blurb: 'A hall for weddings and events, with a stage and catering kitchen.',
    storeys: { min: 1, max: 2, default: 1 },
    units: { label: 'Seats', short: 'seats', min: 100, max: 1500, step: 50, default: 400, perFloor: false },
    features: [], storeyHeightM: 5.0, corridorM: 2.4, corridorNames: ['Foyer', 'Gallery'],
    bands: [[6, 18], [6, 22], [7, 26], [5, 11]], costFactor: 0.9, m2PerPerson: 1,
  },
  school: {
    label: 'School', family: 'institutional', blurb: 'Classrooms off wide corridors, with offices and toilets.',
    storeys: { min: 1, max: 4, default: 2 },
    units: { label: 'Classrooms per floor', short: 'classrooms per floor', min: 2, max: 12, step: 1, default: 6, perFloor: true },
    features: ['library', 'lab', 'canteen'], storeyHeightM: 3.5, corridorM: 2.4, corridorNames: ['Corridor', 'Corridor'],
    bands: [[7.5, 7.5], [8, 8], [9, 9]], costFactor: 0.95, m2PerPerson: 2.5,
  },
  clinic: {
    label: 'Clinic or hospital', family: 'institutional', blurb: 'Consulting rooms on the ground floor, wards above.',
    storeys: { min: 1, max: 6, default: 2 },
    units: { label: 'Consulting rooms or wards per floor', short: 'rooms per floor', min: 2, max: 12, step: 1, default: 4, perFloor: true },
    features: ['pharmacy', 'lab', 'lift'], defaultFeatures: ['pharmacy', 'lab'], storeyHeightM: 3.6, corridorM: 2.4, corridorNames: ['Corridor', 'Ward corridor'],
    bands: [[6, 6], [7, 7], [8, 8]], costFactor: 1.25, m2PerPerson: 10,
  },
  worship: {
    label: 'Church or mosque', family: 'institutional', blurb: 'A main hall with a foyer, offices and toilets.',
    storeys: { min: 1, max: 2, default: 1 },
    units: { label: 'Seats', short: 'seats', min: 100, max: 3000, step: 50, default: 500, perFloor: false },
    features: [], storeyHeightM: 6.0, corridorM: 2.4, corridorNames: ['Foyer', 'Gallery'],
    bands: [[6, 18], [6, 22], [7, 26], [5, 11]], costFactor: 0.9, m2PerPerson: 1,
  },
};

export const BUILDING_TYPE_KEYS = Object.keys(BUILDING_TYPES) as BuildingType[];

export const isBuildingType = (t: unknown): t is BuildingType => typeof t === 'string' && Object.hasOwn(BUILDING_TYPES, t);

/** Single-household houses designed room by room (bungalows and duplexes). */
export const isHouse = (t: BuildingType) => t === 'bungalow' || t === 'duplex';

/** When a lift is needed: always from five storeys, sooner for hotels and clinics, or when asked for. */
export function needsLift(type: BuildingType, storeys: number, features: readonly FeatureKey[]): boolean {
  if (storeys < 2) return false;
  if (features.includes('lift')) return true;
  if (type === 'clinic') return storeys >= 2;
  if (type === 'hotel') return storeys >= 3;
  return storeys >= 5 && type !== 'duplex' && type !== 'terrace';
}

/** A second protected stair from five storeys, so there are two ways out of every floor. */
export const needsTwoStairs = (type: BuildingType, storeys: number) => storeys >= 5 && !isHouse(type) && type !== 'terrace';

/** Parking spaces a typical planning office would ask for (a [proposed] rule of thumb). */
export function suggestedParking(type: BuildingType, storeys: number, units: number): number {
  const s = Math.max(1, storeys);
  const n = (() => {
    switch (type) {
      case 'bungalow': case 'duplex': return 2;
      case 'terrace': return units;
      case 'apartments': return units * s;
      case 'shops': return Math.ceil((units * s) / 2);
      case 'office': return units * s * 3;
      case 'mixed-use': return units + Math.max(2, Math.round(units / 2)) * (s - 1);
      case 'warehouse': return 4;
      case 'hotel': return Math.ceil((units * Math.max(1, s - 1)) / 3);
      case 'event-hall': return Math.ceil(units / 10);
      case 'school': return units * s;
      case 'clinic': return units * s;
      case 'worship': return Math.ceil(units / 10);
    }
  })();
  return Math.min(60, Math.max(0, n));
}
