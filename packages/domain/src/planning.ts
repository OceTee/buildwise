/**
 * Planning calculators: cooling, water, energy (with optional solar) and budget. Deterministic, so the AI explains
 * numbers instead of inventing them. Every result carries how it was worked out (steps), what was assumed and what
 * to watch. All rates and factors come from the market pack's `planning` section and are [Proposed] until a
 * qualified professional confirms them for a market.
 */
import { HABITABLE, WET, type Design, type RoomKind } from './design';
import { BUILDING_TYPES, isHouse } from './building';

// ---------------------------------------------------------------- configuration

export type FinishBand = 'basic' | 'standard' | 'premium';
export type CostStage = 'substructure' | 'frame' | 'walls' | 'roof' | 'openings' | 'finishes' | 'services';

export interface PlanningConfig {
  cost: {
    /** Construction cost per m² of gross floor, by finish band, in minor units. */
    perM2Minor: Record<FinishBand, number>;
    /** How the building cost splits by stage (fractions, adding up to 1). */
    split: Record<CostStage, number>;
    feesPct: number; permitsPct: number; externalWorksPct: number; furniturePct: number; contingencyPct: number;
    /** ± band shown around every preliminary figure. */
    uncertaintyPct: number;
    solarPerKwpMinor: number; batteryPerKwhMinor: number; inverterPerKwMinor: number;
    acPerUnitMinor: Record<number, number>; boreholeMinor: number; pumpPerHpMinor: number; tankPerLitreMinor: number; heaterPerUnitMinor: number;
    priceDate: string;
  };
  energy: {
    peakSunHours: number; performanceRatio: number; panelW: number;
    batteryDoD: number; roundTripEfficiency: number; inverterHeadroom: number; systemVoltage: number;
    nightShare: number; inverterSizesKw: number[];
    simultaneity: Record<LoadCategory, number>;
  };
  water: {
    litresPerPersonDay: number; storageDays: number; tankSizesL: number[]; boreholeDepthM: number; tankHeightM: number;
    pumpHoursPerDay: number; pumpEfficiency: number; pumpSizesHp: number[]; heaterLitres: number; heaterKw: number; heaterHoursPerDay: number;
  };
  cooling: {
    wPerM2: Partial<Record<RoomKind, number>>; wPerPerson: number; glassWPerM2: number; acSizesBtu: number[]; cop: number;
    hoursPerDay: Partial<Record<RoomKind, number>>; dutyCycle: number; fanW: number;
  };
}

/** [Proposed] illustrative values for a hot-humid West African market (demo pack). */
export const DEFAULT_PLANNING_CONFIG: PlanningConfig = {
  cost: {
    perM2Minor: { basic: 250_000_00, standard: 350_000_00, premium: 550_000_00 },
    split: { substructure: 0.12, frame: 0.15, walls: 0.14, roof: 0.12, openings: 0.09, finishes: 0.21, services: 0.17 },
    feesPct: 8, permitsPct: 2, externalWorksPct: 6, furniturePct: 10, contingencyPct: 10, uncertaintyPct: 20,
    solarPerKwpMinor: 650_000_00, batteryPerKwhMinor: 450_000_00, inverterPerKwMinor: 180_000_00,
    acPerUnitMinor: { 9000: 380_000_00, 12000: 450_000_00, 18000: 680_000_00, 24000: 850_000_00 },
    boreholeMinor: 1_500_000_00, pumpPerHpMinor: 180_000_00, tankPerLitreMinor: 150_00, heaterPerUnitMinor: 120_000_00,
    priceDate: '2026-11 (illustrative)',
  },
  energy: {
    peakSunHours: 4.8, performanceRatio: 0.75, panelW: 550, batteryDoD: 0.9, roundTripEfficiency: 0.92, inverterHeadroom: 1.25,
    systemVoltage: 48, nightShare: 0.6, inverterSizesKw: [3, 5, 6, 8, 10, 12, 15, 20],
    simultaneity: { essential: 1, comfort: 0.7, heavy: 0.4, scheduled: 0.5, future: 0 },
  },
  water: {
    litresPerPersonDay: 120, storageDays: 2, tankSizesL: [1000, 2000, 3000, 5000], boreholeDepthM: 60, tankHeightM: 6,
    pumpHoursPerDay: 3, pumpEfficiency: 0.45, pumpSizesHp: [0.5, 0.75, 1, 1.5, 2, 3], heaterLitres: 50, heaterKw: 1.5, heaterHoursPerDay: 1.5,
  },
  cooling: {
    wPerM2: { living: 140, 'living-kitchen': 160, lounge: 140, dining: 130, kitchen: 170, master: 120, bedroom: 120, study: 130 },
    wPerPerson: 100, glassWPerM2: 220, acSizesBtu: [9000, 12000, 18000, 24000], cop: 3.2,
    hoursPerDay: { living: 6, 'living-kitchen': 6, lounge: 5, dining: 2, kitchen: 0, master: 8, bedroom: 8, study: 6 },
    dutyCycle: 0.7, fanW: 75,
  },
};

// ---------------------------------------------------------------- results

/** One line of working: what was worked out, the value, and how. */
export interface CalcStep { label: string; value: number; unit: string; how: string }
export interface Calc<T> { result: T; steps: CalcStep[]; assumptions: string[]; warnings: string[] }

const r1 = (n: number) => Math.round(n * 10) / 10;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pick = (sizes: number[], need: number) => sizes.find((s) => s >= need) ?? sizes[sizes.length - 1]!;

// ---------------------------------------------------------------- cooling

export interface CoolingOptions { airConditioning: boolean; kitchenAc: boolean }
export interface CoolingRoom { roomId: string; name: string; areaM2: number; loadW: number; btu: number; ac: { btu: number; units: number; inputKw: number } | null; fans: number; hoursPerDay: number; kwhPerDay: number }

/** Room-by-room preliminary cooling loads from the actual rooms and windows of the design. */
export function coolingPlan(d: Design, opts: CoolingOptions, cfg: PlanningConfig = DEFAULT_PLANNING_CONFIG): Calc<{ rooms: CoolingRoom[]; acUnits: number; inputKw: number; kwhPerDay: number; fans: number }> {
  const c = cfg.cooling;
  const steps: CalcStep[] = [];
  const rooms: CoolingRoom[] = [];
  const houseIds = new Set(d.blocks.filter((b) => b.kind === 'house').map((b) => b.id));
  for (const r of d.rooms.filter((x) => houseIds.has(x.block) && HABITABLE.has(x.kind))) {
    const area = r.w * r.d;
    const people = r.kind === 'master' || r.kind === 'bedroom' ? 2 : r.kind === 'study' ? 1 : r.kind === 'kitchen' ? 2 : 4;
    const glass = d.openings.filter((o) => o.roomId === r.id && o.kind === 'window').reduce((s, o) => s + (o.to - o.from) * (o.headM - o.sillM), 0);
    const loadW = area * (c.wPerM2[r.kind] ?? 130) + people * c.wPerPerson + glass * c.glassWPerM2;
    const btu = loadW * 3.412;
    const wantsAc = opts.airConditioning && (r.kind !== 'kitchen' || opts.kitchenAc) && r.kind !== 'dining';
    let ac: CoolingRoom['ac'] = null;
    if (wantsAc) {
      const max = c.acSizesBtu[c.acSizesBtu.length - 1]!;
      const units = Math.max(1, Math.ceil(btu / max));
      const size = pick(c.acSizesBtu, btu / units);
      ac = { btu: size, units, inputKw: r2((units * size) / 3412 / c.cop) };
    }
    const hours = ac ? c.hoursPerDay[r.kind] ?? 4 : 0;
    const fans = r.kind === 'kitchen' ? 0 : 1;
    const kwh = (ac ? ac.inputKw * hours * c.dutyCycle : 0) + (fans * c.fanW * (ac ? 4 : 10)) / 1000;
    rooms.push({ roomId: r.id, name: r.name, areaM2: r1(area), loadW: Math.round(loadW), btu: Math.round(btu), ac, fans, hoursPerDay: hours, kwhPerDay: r2(kwh) });
  }
  const acUnits = rooms.reduce((s, r) => s + (r.ac?.units ?? 0), 0);
  const inputKw = r2(rooms.reduce((s, r) => s + (r.ac?.inputKw ?? 0), 0));
  const kwhPerDay = r1(rooms.reduce((s, r) => s + r.kwhPerDay, 0));
  const fans = rooms.reduce((s, r) => s + r.fans, 0);
  steps.push(
    { label: 'Cooling load per room', value: rooms.reduce((s, r) => s + r.loadW, 0), unit: 'W', how: `floor area × W/m² by room type + ${c.wPerPerson} W per person + window glass × ${c.glassWPerM2} W/m² of sun through glass` },
    { label: 'Air-conditioner units', value: acUnits, unit: 'units', how: `smallest standard size (${c.acSizesBtu.map((b) => b / 1000 + 'k').join(', ')} BTU/h) at or above each room's load` },
    { label: 'Electrical input of all ACs together', value: inputKw, unit: 'kW', how: `cooling capacity ÷ 3,412 BTU/h per kW ÷ COP ${c.cop} (inverter units)` },
    { label: 'Cooling energy per day', value: kwhPerDay, unit: 'kWh/day', how: `input kW × hours of use × ${c.dutyCycle} duty cycle, plus ${c.fanW} W ceiling fans` },
  );
  return {
    result: { rooms, acUnits, inputKw, kwhPerDay, fans },
    steps,
    assumptions: [
      'Loads are rules of thumb for a hot, humid climate with a roof that is not insulated; roof insulation and shading can cut them by a quarter or more.',
      'Kitchens are ventilated with an extractor rather than air-conditioned unless you choose otherwise.',
      'An HVAC engineer should size units room by room from orientation, insulation and glazing before you buy.',
    ],
    warnings: inputKw > 6 ? [`All ACs together draw about ${inputKw} kW: this drives the inverter and generator size. Run bedroom units at night and living-room units by day.`] : [],
  };
}

// ---------------------------------------------------------------- water

export interface WaterOptions { occupants: number; borehole: boolean; hotWater: boolean; storageDays?: number }

export function waterPlan(d: Design, opts: WaterOptions, cfg: PlanningConfig = DEFAULT_PLANNING_CONFIG) {
  const w = cfg.water;
  const people = Math.max(1, Math.round(opts.occupants));
  const days = opts.storageDays ?? w.storageDays;
  const demand = people * w.litresPerPersonDay;
  const storage = demand * days;
  // Tanks: as few as possible, largest first.
  const tanks: number[] = [];
  let left = storage;
  const largest = w.tankSizesL[w.tankSizesL.length - 1]!;
  while (left > largest) { tanks.push(largest); left -= largest; }
  if (left > 0) tanks.push(pick(w.tankSizesL, left));
  const wet = d.rooms.filter((r) => WET.has(r.kind));
  // Flats and hotel rooms have their own bathrooms; a public toilet room holds a WC per 4 m² or so.
  const own = d.rooms.filter((r) => r.kind === 'flat' || r.kind === 'guest-room').length;
  const flatBaths = d.rooms.filter((r) => r.kind === 'flat').length * Math.floor((d.brief.bedrooms ?? 2) / 2);
  const showers = wet.filter((r) => r.kind !== 'wc' && r.kind !== 'toilets').length + own + flatBaths;
  const wcCount = wet.reduce((s2, r) => s2 + (r.kind === 'toilets' ? Math.max(2, Math.round((r.w * r.d) / 4)) : 1), 0) + own + flatBaths;
  const steps: CalcStep[] = [
    { label: 'Daily water use', value: demand, unit: 'litres/day', how: `${people} people × ${w.litresPerPersonDay} L per person per day` },
    { label: 'Storage', value: tanks.reduce((s, t) => s + t, 0), unit: 'litres', how: `${days} days of use, in standard tanks: ${tanks.map((t) => `${t} L`).join(' + ')}` },
  ];
  let pump: { hp: number; kw: number; flowM3h: number; headM: number; kwhPerDay: number } | null = null;
  if (opts.borehole) {
    const flowM3h = demand / 1000 / w.pumpHoursPerDay;
    const head = (w.boreholeDepthM + w.tankHeightM) * 1.15;
    const kw = (1000 * 9.81 * (flowM3h / 3600) * head) / 1000 / w.pumpEfficiency;
    const hp = pick(w.pumpSizesHp, kw / 0.746);
    pump = { hp, kw: r2(hp * 0.746), flowM3h: r2(flowM3h), headM: r1(head), kwhPerDay: r2(hp * 0.746 * w.pumpHoursPerDay) };
    steps.push(
      { label: 'Pump flow', value: pump.flowM3h, unit: 'm³/h', how: `daily use pumped in ${w.pumpHoursPerDay} hours` },
      { label: 'Total head', value: pump.headM, unit: 'm', how: `${w.boreholeDepthM} m borehole + ${w.tankHeightM} m tank stand, + 15% pipe friction` },
      { label: 'Pump size', value: hp, unit: 'hp', how: `ρ·g·Q·H ÷ ${w.pumpEfficiency} efficiency, rounded up to a standard size` },
    );
  }
  const heaters = opts.hotWater ? showers : 0;
  if (heaters) steps.push({ label: 'Water heaters', value: heaters, unit: 'units', how: `one ${w.heaterLitres} L, ${w.heaterKw} kW heater per bathroom or ensuite` });
  const septicL = Math.max(3000, people * 400);
  steps.push({ label: 'Septic tank (indicative)', value: septicL, unit: 'litres', how: 'about 400 L per person, at least 3,000 L; the engineer sizes it with the soakaway' });
  return {
    result: {
      people, demandLPerDay: demand, storageL: tanks.reduce((s, t) => s + t, 0), tanks, pump, heaters,
      heaterKwhPerDay: r2(heaters * w.heaterKw * w.heaterHoursPerDay), fixtures: { wcs: wcCount, basins: wcCount, showers }, septicL,
    },
    steps,
    assumptions: [
      `${w.litresPerPersonDay} L per person per day covers drinking, cooking, bathing, toilets and laundry; gardens and pools are extra.`,
      opts.borehole ? `Borehole depth of ${w.boreholeDepthM} m is assumed; the driller confirms depth and yield after a survey.` : 'Mains or delivered water is assumed (no borehole).',
      'A water engineer or plumber should confirm pipe sizes, pump and treatment (filtration, chlorination) for your water quality.',
    ],
    warnings: tanks.reduce((s, t) => s + t, 0) >= 5000 ? ['Over 5,000 L on a tank stand is heavy: the stand needs an engineered base; consider part of the storage at ground level with a booster pump.'] : [],
  };
}
export type WaterPlan = ReturnType<typeof waterPlan>;

// ---------------------------------------------------------------- energy

export type LoadCategory = 'essential' | 'comfort' | 'heavy' | 'scheduled' | 'future';
export interface Load { id: string; name: string; category: LoadCategory; watts: number; qty: number; hoursPerDay: number; surgeFactor: number }
export interface SolarOptions { enabled: boolean; cover: 'essential' | 'most' | 'all'; autonomyDays: number }

/** A starting load schedule for the house, from its rooms, cooling and water plans. The person edits it. */
export function defaultLoads(d: Design, cooling: ReturnType<typeof coolingPlan> | null, water: WaterPlan | null): Load[] {
  const rooms = d.rooms.filter((r) => r.kind !== 'corridor' && r.kind !== 'stair');
  const lights = rooms.reduce((s, r) => s + (r.w * r.d > 16 ? 2 : 1), 0) + d.rooms.filter((r) => r.kind === 'corridor').length * 2 + 4;
  const loads: Load[] = [
    { id: 'lights', name: 'LED lighting (inside and outside)', category: 'essential', watts: 10, qty: lights, hoursPerDay: 6, surgeFactor: 1 },
    { id: 'fridge', name: 'Fridge-freezer', category: 'essential', watts: 150, qty: 1, hoursPerDay: 10, surgeFactor: 3 },
    { id: 'router', name: 'Wi-Fi router and network', category: 'essential', watts: 20, qty: 1, hoursPerDay: 24, surgeFactor: 1 },
    { id: 'cctv', name: 'CCTV and security', category: 'essential', watts: 40, qty: 1, hoursPerDay: 24, surgeFactor: 1 },
    { id: 'devices', name: 'Phones, laptops and small devices', category: 'essential', watts: 60, qty: 3, hoursPerDay: 5, surgeFactor: 1 },
    { id: 'tv', name: 'Television and decoder', category: 'comfort', watts: 120, qty: 2, hoursPerDay: 5, surgeFactor: 1 },
    { id: 'washer', name: 'Washing machine', category: 'scheduled', watts: 500, qty: 1, hoursPerDay: 1, surgeFactor: 2 },
    { id: 'microwave', name: 'Microwave', category: 'heavy', watts: 1200, qty: 1, hoursPerDay: 0.3, surgeFactor: 1 },
    { id: 'kettle', name: 'Electric kettle', category: 'heavy', watts: 2000, qty: 1, hoursPerDay: 0.2, surgeFactor: 1 },
    { id: 'iron', name: 'Pressing iron', category: 'heavy', watts: 1200, qty: 1, hoursPerDay: 0.4, surgeFactor: 1 },
  ];
  if (cooling) {
    const fans = cooling.result.fans;
    if (fans) loads.push({ id: 'fans', name: 'Ceiling fans', category: 'comfort', watts: 75, qty: fans, hoursPerDay: 8, surgeFactor: 1 });
    for (const r of cooling.result.rooms.filter((x) => x.ac)) {
      loads.push({ id: `ac-${r.roomId}`, name: `Air conditioner, ${r.name} (${r.ac!.btu / 1000}k BTU${r.ac!.units > 1 ? ` × ${r.ac!.units}` : ''})`, category: 'heavy', watts: Math.round((r.ac!.inputKw * 1000) / r.ac!.units), qty: r.ac!.units, hoursPerDay: r2(r.hoursPerDay * 0.7), surgeFactor: 1.5 });
    }
  }
  if (water?.result.pump) loads.push({ id: 'pump', name: `Borehole pump (${water.result.pump.hp} hp)`, category: 'scheduled', watts: Math.round(water.result.pump.kw * 1000), qty: 1, hoursPerDay: DEFAULT_PLANNING_CONFIG.water.pumpHoursPerDay, surgeFactor: 3 });
  // Larger buildings: equipment in proportion to their floor area, besides the household-style list above.
  if (!isHouse(d.brief.type)) {
    const wPerM2: Partial<Record<string, number>> = { office: 15, 'mixed-use': 8, shops: 20, hotel: 6, school: 4, clinic: 15, 'event-hall': 6, worship: 3, warehouse: 3, apartments: 4, terrace: 4 };
    const w = wPerM2[d.brief.type] ?? 5;
    loads.push({ id: 'equipment', name: `Equipment and sockets (about ${w} W/m² over ${Math.round(d.metrics.grossFloorM2)} m²)`, category: 'comfort', watts: Math.round(w * d.metrics.grossFloorM2), qty: 1, hoursPerDay: 8, surgeFactor: 1.2 });
    const lifts = new Set(d.rooms.filter((r) => r.kind === 'lift').map((r) => `${r.x},${r.y}`)).size;
    if (lifts) loads.push({ id: 'lift', name: 'Passenger lift', category: 'heavy', watts: 11000, qty: lifts, hoursPerDay: 1.5, surgeFactor: 2 });
  }
  if (water?.result.heaters) loads.push({ id: 'heaters', name: 'Water heaters', category: 'scheduled', watts: 1500, qty: water.result.heaters, hoursPerDay: 1.5, surgeFactor: 1 });
  loads.push({ id: 'ev', name: 'EV charger (future provision)', category: 'future', watts: 7000, qty: 1, hoursPerDay: 0, surgeFactor: 1 });
  return loads;
}

export function energyPlan(loadsIn: Load[], solar: SolarOptions, cfg: PlanningConfig = DEFAULT_PLANNING_CONFIG) {
  const e = cfg.energy;
  const loads = loadsIn.filter((l) => l.qty > 0 && l.watts > 0);
  const kwh = (ls: Load[]) => ls.reduce((s, l) => s + (l.watts * l.qty * l.hoursPerDay) / 1000, 0);
  const daily = kwh(loads);
  const byCat = Object.fromEntries((['essential', 'comfort', 'heavy', 'scheduled', 'future'] as LoadCategory[]).map((c) => [c, r2(kwh(loads.filter((l) => l.category === c)))])) as Record<LoadCategory, number>;
  const connectedKw = loads.reduce((s, l) => s + l.watts * l.qty, 0) / 1000;
  const peakKw = loads.reduce((s, l) => s + (l.watts * l.qty * e.simultaneity[l.category]) / 1000, 0);
  const surge = loads.reduce((m, l) => Math.max(m, (l.watts * l.surgeFactor) / 1000), 0);
  const steps: CalcStep[] = [
    { label: 'Energy per day', value: r1(daily), unit: 'kWh/day', how: 'Σ watts × quantity × hours of use ÷ 1,000' },
    { label: 'Connected load', value: r1(connectedKw), unit: 'kW', how: 'everything switched on at once (it never is)' },
    { label: 'Peak demand', value: r1(peakKw), unit: 'kW', how: `connected load × likelihood of running together (${Object.entries(e.simultaneity).map(([k, v]) => `${k} ${v}`).join(', ')})` },
    { label: 'Largest starting surge', value: r1(surge), unit: 'kW', how: 'watts × surge factor of the biggest motor (fridge, pump, AC compressor)' },
  ];
  const warnings: string[] = [];
  const assumptions: string[] = ['Hours of use are typical; change them in the load schedule to match how you live.'];
  let system: null | { coveredKwh: number; arrayKwp: number; panels: number; batteryUsableKwh: number; batteryNominalKwh: number; batteryAh: number; inverterKw: number; dailyYieldKwh: number } = null;
  if (solar.enabled) {
    const covered = loads.filter((l) => l.category !== 'future' && (solar.cover === 'all' || l.category === 'essential' || (solar.cover === 'most' && l.category !== 'heavy')));
    const coveredKwh = kwh(covered);
    const arrayKwp = coveredKwh / (e.peakSunHours * e.performanceRatio);
    const panels = Math.ceil((arrayKwp * 1000) / e.panelW);
    const usable = (coveredKwh * e.nightShare * Math.max(0.5, solar.autonomyDays)) / e.roundTripEfficiency;
    const nominal = usable / e.batteryDoD;
    const coveredPeak = covered.reduce((s, l) => s + (l.watts * l.qty * e.simultaneity[l.category]) / 1000, 0);
    const coveredSurge = covered.reduce((m, l) => Math.max(m, (l.watts * l.surgeFactor) / 1000), 0);
    const inverterKw = pick(e.inverterSizesKw, Math.max(coveredPeak * e.inverterHeadroom, coveredSurge / 2));
    system = {
      coveredKwh: r1(coveredKwh), arrayKwp: r2((panels * e.panelW) / 1000), panels,
      batteryUsableKwh: r1(usable), batteryNominalKwh: r1(nominal), batteryAh: Math.ceil((nominal * 1000) / e.systemVoltage),
      inverterKw, dailyYieldKwh: r1(((panels * e.panelW) / 1000) * e.peakSunHours * e.performanceRatio),
    };
    steps.push(
      { label: 'Energy the solar system covers', value: system.coveredKwh, unit: 'kWh/day', how: solar.cover === 'essential' ? 'essential loads only' : solar.cover === 'most' ? 'everything except heavy appliances' : 'every load' },
      { label: 'Solar array', value: system.arrayKwp, unit: 'kWp', how: `covered kWh ÷ (${e.peakSunHours} peak sun hours × ${e.performanceRatio} performance ratio), as ${panels} × ${e.panelW} W panels` },
      { label: 'Battery, usable', value: system.batteryUsableKwh, unit: 'kWh', how: `${Math.round(e.nightShare * 100)}% of covered energy is used after dark × ${solar.autonomyDays} day(s) of autonomy ÷ ${e.roundTripEfficiency} round-trip efficiency` },
      { label: 'Battery, nominal', value: system.batteryNominalKwh, unit: 'kWh', how: `usable ÷ ${e.batteryDoD} depth of discharge (lithium iron phosphate); ${system.batteryAh} Ah at ${e.systemVoltage} V` },
      { label: 'Inverter', value: inverterKw, unit: 'kW', how: `peak demand of covered loads × ${e.inverterHeadroom} headroom, and at least half the largest surge; rounded to a standard size` },
    );
    assumptions.push(
      `${e.peakSunHours} peak sun hours a day on average; in the rainy season it can drop by a third, so plan a generator or grid backup for cloudy spells.`,
      'kW is power (how much runs at once); kWh is energy (how long it runs). The inverter limits kW, the battery limits kWh.',
      'A qualified solar installer must confirm the design: cable sizes, DC and AC isolators, surge protection, earthing and the battery management system.',
    );
    if (loads.some((l) => l.category === 'heavy') && solar.cover !== 'all') warnings.push('Heavy loads (ACs, kettle, iron) are not on solar: they run from the grid or generator, or move them to sunny hours with load management.');
    if (peakKw > inverterKw && solar.cover === 'all') warnings.push(`Peak demand (${r1(peakKw)} kW) is above the inverter's ${inverterKw} kW: avoid running heavy appliances together, or choose a bigger inverter.`);
  } else {
    assumptions.push('No solar: the grid and a generator supply everything.');
  }
  const generatorKva = pick([3.5, 5, 7.5, 10, 15, 20, 30], (peakKw / 0.8) * 1.25);
  steps.push({ label: 'Backup generator', value: generatorKva, unit: 'kVA', how: 'peak demand ÷ 0.8 power factor × 1.25 headroom' });
  const management = [
    'Run the washing machine, water heaters and borehole pump in the middle of the day.',
    'Keep fridge, lighting, router and security on an essential circuit that is never shed.',
    ...(solar.enabled ? ['Let the inverter shed air conditioning when the battery falls below about 30%.'] : []),
    'Do not run the kettle, iron and microwave at the same time as the ACs.',
  ];
  return {
    result: { dailyKwh: r1(daily), byCategory: byCat, connectedKw: r1(connectedKw), peakKw: r1(peakKw), surgeKw: r1(surge), solar: system, generatorKva, management },
    steps, assumptions, warnings,
  };
}
export type EnergyPlan = ReturnType<typeof energyPlan>;

// ---------------------------------------------------------------- budget

export interface BudgetInput {
  /** What the person can spend on the whole project (minor units), if they said. */
  budgetMinor: number | null;
  landIncluded: boolean;
  landCostMinor: number;
  finish: FinishBand;
  /** The landscaping or external works, if planned; otherwise an allowance. */
  externalWorks: boolean;
  furniture: boolean;
}

export function budgetPlan(d: Design, input: BudgetInput, systems: { cooling?: ReturnType<typeof coolingPlan> | null; water?: WaterPlan | null; energy?: EnergyPlan | null }, cfg: PlanningConfig = DEFAULT_PLANNING_CONFIG) {
  const c = cfg.cost;
  const gfa = d.metrics.grossFloorM2;
  // Larger and specialist buildings cost more or less per m² than a home (frames, services, finishes).
  const type = BUILDING_TYPES[d.brief.type];
  const factor = type?.costFactor ?? 1;
  const building = gfa * c.perM2Minor[input.finish] * factor;
  const stages = (Object.keys(c.split) as CostStage[]).map((k) => ({ stage: k, minor: Math.round(building * c.split[k]) }));
  const lines: { key: string; label: string; minor: number; basis: string; optional?: boolean }[] = [
    { key: 'building', label: 'Building (structure to finishes)', minor: Math.round(building), basis: `${gfa} m² × ${Math.round((c.perM2Minor[input.finish] * factor) / 100)} per m² (${input.finish} finish${factor !== 1 ? `, ${type!.label.toLowerCase()} rate ×${factor}` : ''})` },
  ];
  const sys = { cooling: 0, water: 0, solar: 0 };
  if (systems.cooling) {
    sys.cooling = systems.cooling.result.rooms.reduce((s, r) => s + (r.ac ? (c.acPerUnitMinor[r.ac.btu] ?? 0) * r.ac.units : 0), 0);
    if (sys.cooling) lines.push({ key: 'cooling', label: 'Air conditioners (supplied and installed)', minor: sys.cooling, basis: `${systems.cooling.result.acUnits} inverter split units`, optional: true });
  }
  if (systems.water) {
    const w = systems.water.result;
    sys.water = (w.pump ? c.boreholeMinor + w.pump.hp * c.pumpPerHpMinor : 0) + w.storageL * c.tankPerLitreMinor + w.heaters * c.heaterPerUnitMinor;
    lines.push({ key: 'water', label: 'Water supply (borehole, pump, tanks, heaters)', minor: Math.round(sys.water), basis: `${w.pump ? 'borehole and pump, ' : ''}${w.storageL} L storage${w.heaters ? `, ${w.heaters} heaters` : ''}` });
  }
  if (systems.energy?.result.solar) {
    const s = systems.energy.result.solar;
    sys.solar = s.arrayKwp * c.solarPerKwpMinor + s.batteryNominalKwh * c.batteryPerKwhMinor + s.inverterKw * c.inverterPerKwMinor;
    lines.push({ key: 'solar', label: 'Solar power (panels, battery, inverter, installation)', minor: Math.round(sys.solar), basis: `${s.arrayKwp} kWp, ${s.batteryNominalKwh} kWh battery, ${s.inverterKw} kW inverter`, optional: true });
  }
  const construction = building + sys.cooling + sys.water + sys.solar;
  if (input.externalWorks) lines.push({ key: 'external', label: 'Fence, gate, paving and landscaping', minor: Math.round(construction * c.externalWorksPct / 100), basis: `${c.externalWorksPct}% of construction (allowance)` });
  lines.push({ key: 'fees', label: 'Architect, engineers and quantity surveyor', minor: Math.round(construction * c.feesPct / 100), basis: `${c.feesPct}% of construction` });
  lines.push({ key: 'permits', label: 'Permits and approvals', minor: Math.round(construction * c.permitsPct / 100), basis: `${c.permitsPct}% of construction (varies by state)` });
  if (input.furniture) lines.push({ key: 'furniture', label: 'Furniture and appliances', minor: Math.round(building * c.furniturePct / 100), basis: `${c.furniturePct}% of the building cost`, optional: true });
  const subtotal = lines.reduce((s, l) => s + l.minor, 0);
  lines.push({ key: 'contingency', label: 'Contingency', minor: Math.round(subtotal * c.contingencyPct / 100), basis: `${c.contingencyPct}% for the unexpected; do not spend it on upgrades` });
  if (input.landIncluded && input.landCostMinor > 0) lines.push({ key: 'land', label: 'Land', minor: input.landCostMinor, basis: 'as you stated' });
  const total = lines.reduce((s, l) => s + l.minor, 0);
  const gap = input.budgetMinor !== null ? total - input.budgetMinor : null;

  // Value engineering when the budget falls short: what each option saves.
  const options: { label: string; savesMinor: number; note: string }[] = [];
  if (gap !== null && gap > 0) {
    if (input.finish !== 'basic') {
      const lower: FinishBand = input.finish === 'premium' ? 'standard' : 'basic';
      options.push({ label: `Build to a ${lower} finish now, upgrade later`, savesMinor: Math.round(gfa * (c.perM2Minor[input.finish] - c.perM2Minor[lower])), note: 'Finishes can be upgraded room by room once you live in the house.' });
    }
    const m2 = Math.ceil(gap / (c.perM2Minor[input.finish] * 1.3));
    options.push({ label: `Reduce the floor area by about ${m2} m²`, savesMinor: Math.round(m2 * c.perM2Minor[input.finish] * 1.3), note: 'Tighter rooms, fewer hallways, or one bedroom fewer; the Adjust step shows the effect.' });
    if (sys.solar) options.push({ label: 'Provision for solar now, install later', savesMinor: Math.round(sys.solar * 0.85), note: 'Lay conduits, a battery space and the inverter wall now; add panels and batteries when funds allow.' });
    if (sys.cooling) options.push({ label: 'Fans now, air conditioners later', savesMinor: Math.round(sys.cooling * 0.85), note: 'Wire and sleeve every AC point during construction so units can be added without breaking walls.' });
    if (input.furniture) options.push({ label: 'Leave furniture out of the build budget', savesMinor: lines.find((l) => l.key === 'furniture')?.minor ?? 0, note: 'Move in with essentials and furnish over time.' });
    if (['mansard', 'dutch', 'hidden', 'butterfly'].includes(d.roof.kind)) options.push({ label: 'Choose a simple hip or gable roof', savesMinor: Math.round(building * c.split.roof * 0.15), note: 'Complex roofs need more timber, flashing and labour.' });
    options.push({ label: 'Build in phases', savesMinor: Math.round(gap), note: 'Complete the structure and roof first, then finishes room by room; a phased plan must still finish the shell before the rains.' });
  }
  const band = c.uncertaintyPct / 100;
  return {
    result: { grossFloorM2: gfa, lines, stages, totalMinor: Math.round(total), lowMinor: Math.round(total * (1 - band)), highMinor: Math.round(total * (1 + band)), budgetMinor: input.budgetMinor, gapMinor: gap === null ? null : Math.round(gap), options },
    steps: [
      { label: 'Building cost', value: Math.round(building / 100), unit: 'currency', how: `gross floor ${gfa} m² × rate per m² for a ${input.finish} finish` },
      { label: 'Total with fees, permits and contingency', value: Math.round(total / 100), unit: 'currency', how: lines.map((l) => l.label).join(' + ') },
    ] as CalcStep[],
    assumptions: [
      `Rates are illustrative for ${c.priceDate} and marked proposed; prices in your area may differ. The materials list prices actual items from live listings.`,
      `A ±${c.uncertaintyPct}% band applies: this is a budget estimate, not a bill of quantities. A quantity surveyor should price the final drawings.`,
      'Structural reinforcement and foundations depend on the engineer\'s design and the soil; they are inside the building rate but can move it.',
    ],
    warnings: gap !== null && gap > 0 ? [`The estimate is above your budget by about ${Math.round(gap / 100).toLocaleString('en')}: see the options to close the gap.`] : [],
  };
}
export type BudgetPlan = ReturnType<typeof budgetPlan>;
