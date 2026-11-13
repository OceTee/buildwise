/**
 * Jurisdiction pack for the marketplace website (spec §8.7, §3). Everything market-specific lives here and is
 * versioned; nothing is hard-coded elsewhere. The demo pack uses ILLUSTRATIVE values only.
 */
export type AttrType = 'text' | 'enum' | 'number' | 'boolean' | 'pack_size';

export interface CategoryAttribute {
  key: string;
  label: string;
  type: AttrType;
  required?: boolean;
  options?: { value: string; label: string }[];
  unit?: string;          // for number
  packUnits?: string[];   // for pack_size
  filterable?: boolean;
  max?: number;
}

export type ListingType = 'product' | 'hire' | 'service' | 'professional';

export interface CategoryDef {
  slug: string;
  name: string;
  parent?: string;           // parent slug for subcategories
  listingType: ListingType;
  priceUnits: string[];
  minPhotos: number;
  listingPeriodDays: number;
  autoPublish: boolean;      // for established sellers when every automated check passes
  freeAllowance: { individual: number; business: number };
  attributes: CategoryAttribute[];
  seoText?: string;
}

export interface Area { code: string; label: string; lat: number; lng: number }
export interface Region { code: string; label: string; areas: Area[] }

export interface PromotionProductDef {
  code: string;
  kind: 'top' | 'package';
  name: string;
  days: number;
  priceMinor: number;
  /** For packages: extra live listings allowed and relative slot share. */
  extraAllowance?: number;
  slotWeight?: number;
}

export interface MarketPack {
  id: string;
  name: string;
  illustrative: boolean;
  locale: string;
  currency: string;
  timeZone: string;
  phone: { defaultCallingCode: string; allowedCallingCodes: string[]; nationalDigits: [number, number] };
  regions: Region[];
  tax: { code: string; label: string; ratePercent: number };
  limits: {
    revealsPerUserPerDay: number; revealsPerDevicePerHour: number;
    otpPerNumberPerHour: number; otpPerIpPerHour: number;
    chatsPerNewAccountPerDay: number; listingsPerNewAccountPerDay: number;
  };
  moderation: {
    materialPriceChangePct: number; outlierMinObservations: number; outlierFactor: number;
    reportThreshold: number; establishedSellerMinLiveDays: number; qaSamplePct: number;
  };
  policy: {
    quoteRequestExpiryDays: number; reviewPromptDays: number; reviewCooldownDays: number; goneAfterDays: number;
    replyWindowHours: number; reputationWindowDays: number; reputationMinThreads: number; priceFreshDays: number;
    sitemapMinListings: number;
  };
  slots: { topPerPage: number; promotedEveryN: number };
  prohibitedTerms: string[];
  restrictedTerms: string[];
  scamPhrases: string[];
  promotionProducts: PromotionProductDef[];
  safetyTips: string[];
  categories: CategoryDef[];
}

const brand = (opts?: string[]): CategoryAttribute => ({ key: 'brand', label: 'Brand', type: 'text', required: true, filterable: true, max: 60, ...(opts ? { type: 'enum' as const, options: opts.map((o) => ({ value: o.toLowerCase(), label: o })) } : {}) });
const condition: CategoryAttribute = { key: 'condition', label: 'Condition', type: 'enum', required: true, filterable: true, options: [{ value: 'new', label: 'New' }, { value: 'used', label: 'Used' }] };
const delivery: CategoryAttribute = { key: 'delivery_offered', label: 'Delivery offered', type: 'boolean', filterable: true };
const qtyAvail: CategoryAttribute = { key: 'quantity_available', label: 'Quantity available', type: 'number', max: 1_000_000 };
const minOrder: CategoryAttribute = { key: 'minimum_order', label: 'Minimum order', type: 'number', max: 1_000_000 };
const experience: CategoryAttribute = { key: 'years_experience', label: 'Years of experience', type: 'number', required: true, max: 70 };

const material = (slug: string, name: string, units: string[], extra: CategoryAttribute[] = [], packUnits?: string[]): CategoryDef => ({
  slug, name, parent: 'building-materials', listingType: 'product', priceUnits: units, minPhotos: 1, listingPeriodDays: 30, autoPublish: true,
  freeAllowance: { individual: 5, business: 20 },
  attributes: [...extra, ...(packUnits ? [{ key: 'pack_size', label: 'Pack size', type: 'pack_size' as const, packUnits, filterable: false }] : []), qtyAvail, minOrder, delivery],
});

export const DEMO_MARKET: MarketPack = {
  id: 'demo-2026.1',
  name: 'Demo market (illustrative values)',
  illustrative: true,
  locale: 'en-NG',
  currency: 'NGN',
  timeZone: 'Africa/Lagos',
  phone: { defaultCallingCode: '+234', allowedCallingCodes: ['+234'], nationalDigits: [10, 10] },
  regions: [
    { code: 'north', label: 'North Region', areas: [
      { code: 'hilltop', label: 'Hilltop', lat: 6.62, lng: 3.35 },
      { code: 'airport-road', label: 'Airport Road', lat: 6.58, lng: 3.32 },
      { code: 'old-town', label: 'Old Town', lat: 6.55, lng: 3.39 },
    ] },
    { code: 'south', label: 'South Region', areas: [
      { code: 'harbour', label: 'Harbour', lat: 6.44, lng: 3.40 },
      { code: 'market-square', label: 'Market Square', lat: 6.47, lng: 3.37 },
      { code: 'riverside', label: 'Riverside', lat: 6.50, lng: 3.45 },
    ] },
  ],
  tax: { code: 'VAT', label: 'VAT (demo rate)', ratePercent: 7.5 },
  limits: { revealsPerUserPerDay: 20, revealsPerDevicePerHour: 3, otpPerNumberPerHour: 3, otpPerIpPerHour: 10, chatsPerNewAccountPerDay: 20, listingsPerNewAccountPerDay: 5 },
  moderation: { materialPriceChangePct: 20, outlierMinObservations: 20, outlierFactor: 3, reportThreshold: 3, establishedSellerMinLiveDays: 30, qaSamplePct: 5 },
  policy: {
    quoteRequestExpiryDays: 14, reviewPromptDays: 3, reviewCooldownDays: 90, goneAfterDays: 90, replyWindowHours: 24,
    reputationWindowDays: 90, reputationMinThreads: 5, priceFreshDays: 30, sitemapMinListings: 5,
  },
  slots: { topPerPage: 3, promotedEveryN: 10 },
  prohibitedTerms: ['land for sale', 'plot for sale', 'plots for sale', 'c of o', 'certificate of occupancy', 'house for sale', 'property for sale', 'explosive', 'dynamite'],
  restrictedTerms: ['asbestos', 'used scaffold', 'second-hand harness'],
  scamPhrases: ['pay a deposit to reserve', 'booking fee', 'release fee', 'send the code', 'pay before inspection', 'western union', 'gift card'],
  promotionProducts: [
    { code: 'top-7', kind: 'top', name: 'Top placement · 7 days', days: 7, priceMinor: 250_000 },
    { code: 'top-30', kind: 'top', name: 'Top placement · 30 days', days: 30, priceMinor: 800_000 },
    { code: 'boost-30', kind: 'package', name: 'Visibility package · 30 days', days: 30, priceMinor: 1_500_000, extraAllowance: 30, slotWeight: 2 },
  ],
  safetyTips: [
    'Inspect goods before you pay.',
    "Meet at the seller's business premises or the delivery site.",
    'Never pay "booking" or "release" fees.',
    'Never share sign-in codes with anyone.',
    'Report anything suspicious; we review every report.',
  ],
  categories: [
    { slug: 'building-materials', name: 'Building materials', listingType: 'product', priceUnits: ['bag', 'tonne', 'trip', 'piece', 'bundle'], minPhotos: 1, listingPeriodDays: 30, autoPublish: true, freeAllowance: { individual: 5, business: 20 }, attributes: [], seoText: 'Cement, blocks, sand and granite, reinforcement bars, roofing sheets and timber from local sellers.' },
    material('cement', 'Cement', ['bag', 'tonne'], [brand(), { key: 'grade', label: 'Grade', type: 'enum', required: true, filterable: true, options: [{ value: '32.5', label: '32.5' }, { value: '42.5', label: '42.5' }, { value: '52.5', label: '52.5' }] }], ['kg']),
    material('blocks', 'Blocks', ['piece'], [{ key: 'size', label: 'Size', type: 'enum', required: true, filterable: true, options: [{ value: '6in', label: '6 inch' }, { value: '9in', label: '9 inch' }] }]),
    material('sand-granite', 'Sand and granite', ['trip', 'tonne'], [{ key: 'material', label: 'Material', type: 'enum', required: true, filterable: true, options: [{ value: 'sharp-sand', label: 'Sharp sand' }, { value: 'plaster-sand', label: 'Plaster sand' }, { value: 'granite-3-4', label: 'Granite ¾"' }, { value: 'granite-1-2', label: 'Granite ½"' }] }, { key: 'trip_size', label: 'Trip size', type: 'pack_size', packUnits: ['tonne'] }]),
    material('reinforcement', 'Reinforcement bars', ['piece', 'tonne'], [{ key: 'diameter_mm', label: 'Diameter (mm)', type: 'number', required: true, filterable: true, max: 50 }, { key: 'length_m', label: 'Length (m)', type: 'number', max: 20 }]),
    material('roofing', 'Roofing sheets', ['piece', 'm2', 'bundle'], [brand(), { key: 'gauge', label: 'Gauge', type: 'text', required: true, max: 20 }]),
    { slug: 'tools-equipment', name: 'Tools and equipment', listingType: 'product', priceUnits: ['piece', 'day', 'week'], minPhotos: 2, listingPeriodDays: 45, autoPublish: true, freeAllowance: { individual: 5, business: 20 }, attributes: [condition, brand(), { key: 'model', label: 'Model', type: 'text', max: 60 }] },
    { slug: 'plant-hire', name: 'Plant and machinery hire', listingType: 'hire', priceUnits: ['hour', 'day', 'trip'], minPhotos: 2, listingPeriodDays: 45, autoPublish: false, freeAllowance: { individual: 3, business: 15 }, attributes: [{ key: 'capacity', label: 'Capacity', type: 'text', required: true, max: 60 }, { key: 'operator_included', label: 'Operator included', type: 'boolean', filterable: true }, { key: 'mobilisation_charge', label: 'Mobilisation charge', type: 'text', max: 60 }] },
    { slug: 'trades', name: 'Trades and services', listingType: 'service', priceUnits: ['day', 'm2', 'job'], minPhotos: 0, listingPeriodDays: 60, autoPublish: false, freeAllowance: { individual: 3, business: 10 }, attributes: [{ key: 'trade', label: 'Trade', type: 'enum', required: true, filterable: true, options: ['Mason', 'Tiler', 'Carpenter', 'Electrician', 'Plumber', 'Welder', 'Painter', 'Ceiling installer'].map((x) => ({ value: x.toLowerCase().replace(/ /g, '-'), label: x })) }, experience], seoText: 'Masons, tilers, carpenters, electricians, plumbers and more, by area.' },
    { slug: 'professionals', name: 'Professionals', listingType: 'professional', priceUnits: ['engagement', 'job'], minPhotos: 0, listingPeriodDays: 90, autoPublish: false, freeAllowance: { individual: 1, business: 5 }, attributes: [{ key: 'discipline', label: 'Discipline', type: 'enum', required: true, filterable: true, options: ['Architect', 'Quantity surveyor', 'Structural engineer', 'Land surveyor', 'Project manager'].map((x) => ({ value: x.toLowerCase().replace(/ /g, '-'), label: x })) }, { key: 'registration_body', label: 'Registration body (declared)', type: 'text', max: 80 }, { key: 'registration_number', label: 'Registration number (declared)', type: 'text', max: 40 }] },
    { slug: 'logistics', name: 'Logistics', listingType: 'service', priceUnits: ['trip'], minPhotos: 1, listingPeriodDays: 60, autoPublish: false, freeAllowance: { individual: 3, business: 10 }, attributes: [{ key: 'vehicle', label: 'Vehicle type', type: 'text', required: true, max: 60 }, { key: 'capacity_tonnes', label: 'Capacity (tonnes)', type: 'number', required: true, max: 100 }] },
  ],
};

export const MARKETS: Record<string, MarketPack> = { [DEMO_MARKET.id]: DEMO_MARKET };

export function getMarket(id: string): MarketPack {
  const m = MARKETS[id];
  if (!m) throw new Error(`Unknown market pack: ${id}`);
  return m;
}

export function findArea(pack: MarketPack, code: string): (Area & { region: Region }) | null {
  for (const r of pack.regions) {
    const a = r.areas.find((x) => x.code === code);
    if (a) return { ...a, region: r };
  }
  return null;
}

export function allAreas(pack: MarketPack): (Area & { region: string })[] {
  return pack.regions.flatMap((r) => r.areas.map((a) => ({ ...a, region: r.code })));
}

/** Great-circle distance in km between two area centroids (§3.5 distance in ranking without device location). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Tax on a platform service price in minor units (promotion purchases, §3.13). Rounded half up. */
export function taxOn(netMinor: number, ratePercent: number): number {
  return Math.round((netMinor * ratePercent) / 100);
}
