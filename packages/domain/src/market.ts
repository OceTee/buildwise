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
  /** A yes/no the seller must answer yes to (a declaration). */
  mustBeTrue?: boolean;
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

import type { ProjectConfig } from './projects';
import { DEFAULT_DESIGN_CONFIG, type DesignConfig } from './design';
import { DEFAULT_PLANNING_CONFIG, type PlanningConfig } from './planning';
import { DEFAULT_PROCUREMENT_CONFIG, type ProcurementConfig } from './procurement';
import { DEFAULT_FULFILMENT_CONFIG, type FulfilmentConfig } from './fulfilment';
import { DEFAULT_CASES_CONFIG, type CasesConfig } from './cases';
import { DEFAULT_REVIEWS_CONFIG, type ReviewsConfig } from './transaction-reviews';
import { DEFAULT_PERFORMANCE_CONFIG, type PerformanceConfig } from './performance';
import { DEFAULT_LIQUIDITY_CONFIG, type LiquidityConfig } from './liquidity';
import { DEFAULT_TENDER_CONFIG, type TenderConfig } from './tenders';
import { DEFAULT_CONTRACTS_CONFIG, type ContractsConfig } from './contracts';
import { DEFAULT_SOURCING_CONFIG, type SourcingConfig } from './sourcing';

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
  /**
   * SMS spend control (§16, §21.1): the most text messages (sign-in codes and notification copies) sent in a day, in
   * total and per destination calling code. Past a cap, sign-in by SMS pauses until the next day (in `timeZone`) and
   * ops are told; ops are warned once a day when a count passes `smsWarnAtPct` of its cap.
   */
  messaging: { smsDailyCap: number; smsDailyCapByCallingCode: Record<string, number>; smsWarnAtPct: number };
  moderation: {
    materialPriceChangePct: number; outlierMinObservations: number; outlierFactor: number;
    reportThreshold: number; establishedSellerMinLiveDays: number; qaSamplePct: number;
  };
  policy: {
    quoteRequestExpiryDays: number; reviewPromptDays: number; reviewCooldownDays: number; goneAfterDays: number;
    replyWindowHours: number; reputationWindowDays: number; reputationMinThreads: number; priceFreshDays: number;
    sitemapMinListings: number;
    /** A number unused this long, signing in from an unknown device, is asked whether the account is theirs (recycled numbers). */
    dormantAccountDays: number;
  };
  slots: { topPerPage: number; promotedEveryN: number };
  prohibitedTerms: string[];
  restrictedTerms: string[];
  scamPhrases: string[];
  /** Local wallets and payment providers whose names in listing text suggest off-platform payment requests. */
  paymentTerms: string[];
  promotionProducts: PromotionProductDef[];
  safetyTips: string[];
  categories: CategoryDef[];
  /** Release 2 project workspace configuration (§10–§12). */
  projects: ProjectConfig;
  /** AI build flow: planning and building rules, room sizes and material factors ([Proposed] until confirmed). */
  design: DesignConfig;
  /** Cost, energy, water and cooling factors for the planning calculators ([Proposed] values). */
  planning: PlanningConfig;
  /** Release 3 structured procurement: matching, checks, sealing and RFQ windows ([Proposed] values). */
  procurement: ProcurementConfig;
  /** Release 3 fulfilment: delivery slots, inspection and return windows, three-way match tolerances ([Proposed] values). */
  fulfilment: FulfilmentConfig;
  /** Release 3 trust and safety cases: response targets, business hours, appeal window, emergency message ([Proposed]). */
  cases: CasesConfig;
  /** Release 3 transaction reviews: window and text limits ([Proposed]). */
  reviews: ReviewsConfig;
  /** Release 3 provider performance: window and the smallest sample shown as a score ([Proposed]). */
  performance: PerformanceConfig;
  /** Release 3 exit gate: comparable responses within the window, target share ([Proposed], validate in R0). */
  liquidity: LiquidityConfig;
  /** Release 3 sealed tenders for trade packages: windows, question cut-off, retention, response template, evaluation ([Proposed]). */
  tenders: TenderConfig;
  /** Release 3 milestones and variations against an award ([Proposed]). */
  contracts: ContractsConfig;
  /** Release 3 sourcing modes and client supplier lists, conflict-of-interest rules ([Proposed]). */
  sourcing: SourcingConfig;
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
  messaging: { smsDailyCap: 3000, smsDailyCapByCallingCode: { '+234': 2500 }, smsWarnAtPct: 80 },
  moderation: { materialPriceChangePct: 20, outlierMinObservations: 20, outlierFactor: 3, reportThreshold: 3, establishedSellerMinLiveDays: 30, qaSamplePct: 5 },
  policy: {
    quoteRequestExpiryDays: 14, reviewPromptDays: 3, reviewCooldownDays: 90, goneAfterDays: 90, replyWindowHours: 24,
    reputationWindowDays: 90, reputationMinThreads: 5, priceFreshDays: 30, sitemapMinListings: 5, dormantAccountDays: 180,
  },
  slots: { topPerPage: 3, promotedEveryN: 10 },
  prohibitedTerms: ['land for sale', 'plot for sale', 'plots for sale', 'c of o', 'certificate of occupancy', 'house for sale', 'property for sale', 'explosive', 'dynamite'],
  restrictedTerms: ['asbestos', 'used scaffold', 'second-hand harness'],
  scamPhrases: ['pay a deposit to reserve', 'booking fee', 'release fee', 'send the code', 'pay before inspection', 'western union', 'gift card'],
  paymentTerms: ['opay', 'palmpay', 'moniepoint', 'paystack.com', 'flutterwave'],
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
    {
      slug: 'house-plans', name: 'House plans', listingType: 'professional', priceUnits: ['set'], minPhotos: 1, listingPeriodDays: 90, autoPublish: false, freeAllowance: { individual: 2, business: 10 },
      attributes: [
        { key: 'bedrooms', label: 'Bedrooms', type: 'number', required: true, filterable: true, max: 12 },
        { key: 'storeys', label: 'Storeys', type: 'enum', required: true, filterable: true, options: [{ value: '1', label: 'Bungalow' }, { value: '2', label: 'Two storeys' }, { value: '3', label: 'Three storeys' }] },
        { key: 'floor_area_m2', label: 'Floor area (m²)', type: 'number', required: true, max: 5000 },
        { key: 'min_plot_width_m', label: 'Smallest plot width it fits (m)', type: 'number', required: true, max: 200 },
        { key: 'min_plot_depth_m', label: 'Smallest plot depth it fits (m)', type: 'number', required: true, max: 400 },
        { key: 'drawings_included', label: 'Drawings included', type: 'text', required: true, max: 160 },
        { key: 'architect_registration', label: 'Architect registration number (declared)', type: 'text', required: true, max: 40 },
        { key: 'rights_confirmed', label: 'I designed these plans or hold the right to sell them', type: 'boolean', required: true, mustBeTrue: true },
      ],
      seoText: 'Ready-made house plans from architects, each with the smallest plot it fits, so you can find one for your land.',
    },
    { slug: 'landscaping', name: 'Landscaping and garden', listingType: 'product', priceUnits: ['piece', 'm2', 'trip', 'job'], minPhotos: 1, listingPeriodDays: 45, autoPublish: true, freeAllowance: { individual: 5, business: 20 }, attributes: [{ key: 'item', label: 'What it is', type: 'enum', required: true, filterable: true, options: ['Plants and trees', 'Grass and turf', 'Paving and kerbs', 'Gates and railings', 'Outdoor lighting', 'Garden structures', 'Landscaping service'].map((x) => ({ value: x.toLowerCase().replace(/ /g, '-'), label: x })) }, { key: 'delivery_offered', label: 'Delivery offered', type: 'boolean', filterable: true }], seoText: 'Plants, trees, grass, interlocking stones, gates, garden lights and landscapers near you.' },
    { slug: 'logistics', name: 'Logistics', listingType: 'service', priceUnits: ['trip'], minPhotos: 1, listingPeriodDays: 60, autoPublish: false, freeAllowance: { individual: 3, business: 10 }, attributes: [{ key: 'vehicle', label: 'Vehicle type', type: 'text', required: true, max: 60 }, { key: 'capacity_tonnes', label: 'Capacity (tonnes)', type: 'number', required: true, max: 100 }] },
  ],
  // Release 2 workspace configuration. Every value is [Proposed] and illustrative until validated in R0.
  projects: {
    classes: [
      { code: 'residential_lowrise', label: 'Low-rise house or duplex (up to 3 floors)', maxFloors: 3, enabled: true, requiresStructuralBeyondFloors: 1 },
      { code: 'small_commercial', label: 'Small shop or office (up to 2 floors)', maxFloors: 2, enabled: true, requiresStructuralBeyondFloors: 1 },
    ],
    buildingUses: [
      { code: 'house', label: 'House or bungalow', classCodes: ['residential_lowrise'] },
      { code: 'duplex', label: 'Duplex or terrace', classCodes: ['residential_lowrise'] },
      { code: 'shop_office', label: 'Shop or small office', classCodes: ['small_commercial'] },
      { code: 'other', label: 'Something else', classCodes: [] },
    ],
    finishBands: [{ code: 'basic', label: 'Basic' }, { code: 'standard', label: 'Standard' }, { code: 'premium', label: 'Premium' }],
    designStages: [
      { code: 'idea', label: 'Idea only, no drawings', measurable: false },
      { code: 'concept', label: 'Concept sketches', measurable: false },
      { code: 'planning', label: 'Planning/permit drawings', measurable: true },
      { code: 'construction', label: 'Construction drawings', measurable: true },
      { code: 'unknown', label: "I'm not sure", measurable: false },
    ],
    siteStatuses: [
      { code: 'owned_clear', label: 'Site owned and clear' }, { code: 'owned_existing', label: 'Site owned, existing structure' },
      { code: 'acquiring', label: 'Still acquiring the site' }, { code: 'unknown', label: "I'm not sure" },
    ],
    disciplines: [
      { code: 'architectural', label: 'Architectural' }, { code: 'structural', label: 'Structural' }, { code: 'mep', label: 'Mechanical, electrical and plumbing' },
      { code: 'site', label: 'Site and external works' }, { code: 'specification', label: 'Specification' }, { code: 'other', label: 'Other' },
    ],
    documentTypes: [
      { code: 'drawing', label: 'Drawing' }, { code: 'specification', label: 'Specification' }, { code: 'schedule', label: 'Schedule or quantity list' },
      { code: 'report', label: 'Report or survey' }, { code: 'photo', label: 'Site photo' },
      { code: 'delivery_proof', label: 'Proof of delivery (from a supplier)' }, { code: 'supplier_invoice', label: 'Supplier invoice' }, { code: 'other', label: 'Other' },
    ],
    documentStatuses: [
      { code: 'concept', label: 'Concept' }, { code: 'coordination', label: 'Coordination' }, { code: 'tender', label: 'Tender' },
      { code: 'construction', label: 'For construction' }, { code: 'as_built', label: 'As built' },
    ],
    benchmarks: [
      { classCode: 'residential_lowrise', regionCode: 'north', finishBand: 'basic', lowPerM2Minor: 14_000_000, highPerM2Minor: 19_000_000, observedAt: '2026-09-15', source: 'Demo benchmark set (illustrative)', includes: ['substructure', 'frame and walls', 'roof', 'finishes', 'basic services'], excludes: ['land', 'external works', 'professional fees', 'furniture'] },
      { classCode: 'residential_lowrise', regionCode: 'north', finishBand: 'standard', lowPerM2Minor: 18_000_000, highPerM2Minor: 26_000_000, observedAt: '2026-09-15', source: 'Demo benchmark set (illustrative)', includes: ['substructure', 'frame and walls', 'roof', 'finishes', 'services'], excludes: ['land', 'external works', 'professional fees', 'furniture'] },
      { classCode: 'residential_lowrise', regionCode: 'south', finishBand: 'standard', lowPerM2Minor: 20_000_000, highPerM2Minor: 29_000_000, observedAt: '2026-09-15', source: 'Demo benchmark set (illustrative)', includes: ['substructure', 'frame and walls', 'roof', 'finishes', 'services'], excludes: ['land', 'external works', 'professional fees', 'furniture'] },
    ],
    benchmarkMaxAgeDays: 365,
    indicativeContingencyPct: 10,
    workSections: [
      { code: 'preliminaries', label: 'Preliminaries' }, { code: 'substructure', label: 'Substructure' }, { code: 'frame', label: 'Frame and upper floors' },
      { code: 'walls', label: 'Walls' }, { code: 'roof', label: 'Roof' }, { code: 'openings', label: 'Windows and doors' }, { code: 'finishes', label: 'Finishes' },
      { code: 'services', label: 'Services' }, { code: 'external', label: 'External works' }, { code: 'other', label: 'Other' },
    ],
    rateFreshnessDays: { volatile: 14, general: 45, labour: 90 },
    estimateValidityDays: 30,
    review: { secondReviewAboveMinor: 15_000_000_000, largeDeltaPct: 10, minContingencyPct: 5 },
    calibrationTolerancePct: 2,
    maxUploadBytes: 250 * 1024 * 1024,
    maxPdfPages: 500,
    staffAccessHours: 4,
  },
  design: DEFAULT_DESIGN_CONFIG,
  planning: DEFAULT_PLANNING_CONFIG,
  procurement: DEFAULT_PROCUREMENT_CONFIG,
  fulfilment: DEFAULT_FULFILMENT_CONFIG,
  cases: DEFAULT_CASES_CONFIG,
  reviews: DEFAULT_REVIEWS_CONFIG,
  performance: DEFAULT_PERFORMANCE_CONFIG,
  liquidity: DEFAULT_LIQUIDITY_CONFIG,
  tenders: DEFAULT_TENDER_CONFIG,
  contracts: DEFAULT_CONTRACTS_CONFIG,
  sourcing: DEFAULT_SOURCING_CONFIG,
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
