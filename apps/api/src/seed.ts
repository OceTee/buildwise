import sharp from 'sharp';
import { buildApp } from './app.js';
import { one } from './db/database.js';

/**
 * Demo data for local development, created through the real API so every rule (checks, moderation, photo
 * pipeline) runs. Safe to re-run: it does nothing if users already exist. All names and numbers are fictional.
 */
const { app, services: s } = await buildApp();
const existing = await s.db.tx({ kind: 'system' }, (sql) => one<{ n: number }>(sql, `select count(*)::int as n from users`));
if ((existing?.n ?? 0) > 0) {
  console.log('Database already has users; skipping seed. Delete ~/.buildwise/dev (or your DATA_DIR) to start over.');
  await app.close();
  process.exit(0);
}

type Json = Record<string, any>;
async function call(token: string | null, method: string, url: string, payload?: unknown, headers: Json = {}): Promise<Json> {
  const res = await app.inject({ method: method as 'GET', url, payload: payload as Json, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  if (res.statusCode >= 400) throw new Error(`${method} ${url} -> ${res.statusCode} ${res.body}`);
  return res.body ? res.json() : {};
}

async function signIn(phone: string, displayName: string) {
  const r = await call(null, 'POST', '/v1/auth/otp/request', { phone });
  const v = await call(null, 'POST', '/v1/auth/otp/verify', { phone, code: r.devCode, displayName, deviceLabel: 'seed' });
  return { token: v.token as string, userId: v.me.id as string, personalOrgId: v.me.organizations.find((o: Json) => o.kind === 'personal').id as string };
}

// Each demo photo is a different random block pattern, so the duplicate-photo check (a brightness-gradient
// hash) sees genuinely different images instead of near-identical gradients.
let hue = 0;
let rnd = 20261113;
const next = () => { rnd = (rnd * 1103515245 + 12345) % 2 ** 31; return rnd / 2 ** 31; };
async function photo(label: string) {
  hue = (hue + 47) % 360;
  const cells: string[] = [];
  for (let y = 0; y < 6; y++) for (let x = 0; x < 8; x++) {
    cells.push(`<rect x="${x * 120}" y="${y * 120}" width="120" height="120" fill="hsl(${hue},40%,${Math.round(15 + next() * 70)}%)"/>`);
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="720">
    ${cells.join('')}
    <rect x="0" y="610" width="960" height="110" fill="rgba(0,0,0,0.55)"/>
    <text x="48" y="680" font-family="sans-serif" font-size="44" fill="white">${label.replace(/[<&>]/g, '')}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

async function upload(token: string, orgId: string, label: string, n: number) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const res = await app.inject({ method: 'POST', url: `/v1/photos?orgId=${orgId}&alt=${encodeURIComponent(`${label} photo ${i + 1}`)}`, payload: await photo(`${label} ${i + 1}`), headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' } });
    if (res.statusCode >= 400) throw new Error(`photo upload -> ${res.statusCode} ${res.body}`);
    ids.push(res.json().id);
  }
  return ids;
}

const moderator = await signIn('+2348000000001', 'Ada (moderator)');
const moderator2 = await signIn('+2348000000002', 'Bayo (moderator)');
const opsAdmin = await signIn('+2348000000003', 'Chi (operations)');
await s.db.tx({ kind: 'system' }, async (sql) => {
  await sql.query(`update users set is_staff = true, staff_role = 'moderator' where id = any($1::uuid[])`, [[moderator.userId, moderator2.userId]]);
  await sql.query(`update users set is_staff = true, staff_role = 'ops_admin' where id = $1`, [opsAdmin.userId]);
});

const supplier = await signIn('+2348011111111', 'Grace Okafor');
// The demo supplier is an established business, outside the new-account posting limits.
await s.db.tx({ kind: 'system' }, (sql) => sql.query(`update users set created_at = now() - interval '400 days' where id = $1`, [supplier.userId]));
const biz = await call(supplier.token, 'POST', '/v1/businesses', { name: 'Hilltop Building Supplies', email: 'sales@hilltop.example', areaCode: 'hilltop' });
await call(moderator.token, 'POST', `/v1/moderation/sellers/${biz.id}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Demo registry lookup', reserveName: true });
const individual = await signIn('+2348022222222', 'Musa Ibrahim');
const mason = await signIn('+2348033333333', 'Tunde Adeyemi');
const plant = await signIn('+2348044444444', 'Riverside Plant Hire');
const buyer = await signIn('+2348055555555', 'Ngozi Eze');
// A design studio selling ready-made house plans (shown in the build flow when a plan fits the plot).
const architect = await signIn('+2348066666666', 'Amaka Obi (architect)');
await s.db.tx({ kind: 'system' }, (sql) => sql.query(`update users set created_at = now() - interval '400 days' where id = $1`, [architect.userId]));
const studio = await call(architect.token, 'POST', '/v1/businesses', { name: 'Demo Design Studio', email: 'plans@studio.example', areaCode: 'old-town' });
await call(moderator.token, 'POST', `/v1/moderation/sellers/${studio.id}/checks`, { checkType: 'business_registration', state: 'passed', source: 'Demo registry lookup', reserveName: true });
const plan = (title: string, description: string, bedrooms: number, storeys: '1' | '2', area: number, w: number, d: number, price: string) => ({
  who: architect, orgId: studio.id, photos: 1,
  body: { categorySlug: 'house-plans', title, description, price, unit: 'set', areaCode: 'old-town',
    attributes: { bedrooms, storeys, floor_area_m2: area, min_plot_width_m: w, min_plot_depth_m: d, drawings_included: 'Architectural plans, elevations and sections; structural drawings; bill of quantities', architect_registration: 'DEMO-ARC-0001', rights_confirmed: true } },
});

interface Demo { who: { token: string }; orgId: string; photos: number; body: Json }
const demos: Demo[] = [
  { who: supplier, orgId: biz.id, photos: 2, body: { categorySlug: 'cement', title: 'Dangote 42.5R cement, 50 kg bags', description: 'Fresh stock, delivered within the north region. Minimum order 10 bags.', attributes: { brand: 'Dangote', grade: '42.5', pack_size: { value: 50, unit: 'kg' }, quantity_available: 900, minimum_order: 10, delivery_offered: true }, price: '9500', unit: 'bag', areaCode: 'hilltop' } },
  { who: supplier, orgId: biz.id, photos: 2, body: { categorySlug: 'cement', title: 'BUA 42.5 cement, 50 kg', description: 'Pallet discount available on 100 bags or more.', attributes: { brand: 'BUA', grade: '42.5', pack_size: { value: 50, unit: 'kg' }, quantity_available: 400, delivery_offered: true }, price: '9200', unit: 'bag', areaCode: 'hilltop' } },
  { who: supplier, orgId: biz.id, photos: 1, body: { categorySlug: 'reinforcement', title: '12 mm high-yield reinforcement bars', description: '12 m lengths. Priced per tonne; cut-to-size on request.', attributes: { diameter_mm: 12, length_m: 12, delivery_offered: true }, price: '1150000', unit: 'tonne', areaCode: 'hilltop' } },
  { who: supplier, orgId: biz.id, photos: 1, body: { categorySlug: 'roofing', title: 'Aluminium long-span roofing sheets, 0.55 gauge', description: 'Stone-coated and plain finishes. Price per square metre.', attributes: { brand: 'Demo Roofing', gauge: '0.55', delivery_offered: true }, price: '6800', unit: 'm2', areaCode: 'hilltop', negotiable: true } },
  { who: individual, orgId: individual.personalOrgId, photos: 1, body: { categorySlug: 'cement', title: 'Leftover cement, 25 kg bags, 32.5 grade', description: 'About 40 bags left over from a finished project. Collect only.', attributes: { brand: 'Lafarge', grade: '32.5', pack_size: { value: 25, unit: 'kg' }, quantity_available: 40 }, price: '4600', unit: 'bag', areaCode: 'airport-road', negotiable: true } },
  { who: individual, orgId: individual.personalOrgId, photos: 1, body: { categorySlug: 'blocks', title: '9 inch hollow sandcrete blocks', description: 'Machine moulded and cured for 14 days.', attributes: { size: '9in', quantity_available: 3000, minimum_order: 200, delivery_offered: true }, price: '650', unit: 'piece', areaCode: 'airport-road' } },
  { who: individual, orgId: individual.personalOrgId, photos: 1, body: { categorySlug: 'sand-granite', title: 'Sharp sand, 20 tonne tipper', description: 'Washed sharp sand. Delivery included within the north region.', attributes: { material: 'sharp-sand', delivery_offered: true }, price: '185000', unit: 'trip', areaCode: 'old-town' } },
  { who: mason, orgId: mason.personalOrgId, photos: 0, body: { categorySlug: 'trades', title: 'Experienced mason: block work and plastering', description: 'Twelve years of block laying, plastering and screeding. Team of four available from next week.', attributes: { trade: 'mason', years_experience: 12 }, price: '25000', unit: 'day', areaCode: 'harbour', serviceAreas: ['market-square', 'riverside'] } },
  { who: plant, orgId: plant.personalOrgId, photos: 2, body: { categorySlug: 'plant-hire', title: 'Concrete mixer with operator, daily hire', description: 'One-bag diesel mixer. Mobilisation charged separately by distance.', attributes: { capacity: 'One bag', operator_included: true, mobilisation_charge: 'Quoted by distance' }, price: '45000', unit: 'day', areaCode: 'riverside', serviceAreas: ['harbour', 'market-square'] } },
  plan('3-bedroom bungalow plan with master ensuite', 'Hip-roof bungalow with a separate kitchen, guest toilet and a store. Fits a half plot and up.', 3, '1', 128, 12.5, 24, '350000'),
  plan('4-bedroom duplex plan with family lounge', 'Two-storey house: living, dining and a guest room downstairs; master suite and two bedrooms upstairs.', 4, '2', 236, 15, 30, '650000'),
  plan('2-bedroom starter home plan', 'Compact bungalow for a narrow plot, designed to extend to three bedrooms later.', 2, '1', 78, 9, 18, '180000'),
  { who: plant, orgId: plant.personalOrgId, photos: 2, body: { categorySlug: 'logistics', title: '10 tonne tipper truck for materials haulage', description: 'Sand, granite and block haulage across the south region.', attributes: { vehicle: 'Tipper truck', capacity_tonnes: 10 }, price: '60000', unit: 'trip', areaCode: 'riverside', serviceAreas: ['harbour', 'market-square'] } },
];

const created: string[] = [];
for (const d of demos) {
  const photoIds = await upload(d.who.token, d.orgId, d.body.title.split(',')[0], d.photos);
  const l = await call(d.who.token, 'POST', '/v1/listings', { ...d.body, orgId: d.orgId, photoIds });
  const sub = await call(d.who.token, 'POST', `/v1/listings/${l.id}/submit`, { expectedVersion: l.version });
  if (sub.listing.status === 'in_review') await call(moderator.token, 'POST', `/v1/moderation/listings/${l.id}/decide`, { decision: 'approve', expectedVersion: sub.listing.version });
  created.push(l.id);
}

// One listing waiting for review so the moderation queue is not empty.
const pending = await call(individual.token, 'POST', '/v1/listings', { orgId: individual.personalOrgId, categorySlug: 'blocks', title: '6 inch solid blocks, urgent sale', description: 'Solid 6 inch blocks, cured 21 days. Quick sale, buyer collects.', attributes: { size: '6in' }, price: '450', unit: 'piece', areaCode: 'old-town', photoIds: await upload(individual.token, individual.personalOrgId, '6 inch blocks', 1) });
await call(individual.token, 'POST', `/v1/listings/${pending.id}/submit`, { expectedVersion: pending.version });

// A buyer conversation and a quote request.
const thread = await call(buyer.token, 'POST', `/v1/listings/${created[0]}/threads`, { body: 'Hello, can you deliver 60 bags to Old Town on Friday?' });
await call(buyer.token, 'POST', `/v1/listings/${created[2]}/quote-requests`, { quantity: '2', unit: 'tonne', deliveryArea: 'old-town', notes: 'Need cut to 6 m lengths.' });
void thread;

// ---------------------------------------------------------------- Release 2: reviewer, catalog and rates, a demo project
const qs = await signIn('+2348000000004', 'Dayo (QS reviewer)');
await s.db.tx({ kind: 'system' }, (sql) => sql.query(`update users set is_staff = true, staff_role = 'qs_reviewer' where id = $1`, [qs.userId]));
await call(opsAdmin.token, 'POST', '/v1/admin/reviewer-qualifications', { userId: qs.userId, classCode: 'residential_lowrise', credential: 'Registered quantity surveyor (demo)', validUntil: '2030-12-31' });
const today = new Date().toISOString().slice(0, 10);
const catalog: [string, string, string, string, 'volatile' | 'general' | 'labour', [string, string, string][]][] = [
  ['cement-42-5-50kg', 'Cement 42.5, 50 kg bag', 'substructure', 'bag', 'volatile', [['supplier_confirmed_quote', '9400', 'Hilltop Building Supplies quote (demo)']]],
  ['blockwork-9in', '9 inch sandcrete blockwork, laid', 'walls', 'm2', 'general', [['professional_rate_book', '11000', 'Demo rate book, Q4'], ['modelled_benchmark', '10200', 'Demo model']]],
  ['concrete-1-2-4', 'Concrete 1:2:4 in foundations', 'substructure', 'm3', 'general', [['professional_rate_book', '98000', 'Demo rate book, Q4']]],
  ['roofing-longspan', 'Long-span aluminium roofing, fixed', 'roof', 'm2', 'general', [['recent_marketplace_offer', '9800', 'Marketplace offer (demo)']]],
  ['plaster-15mm', '15 mm cement plaster', 'finishes', 'm2', 'general', [['professional_rate_book', '3200', 'Demo rate book, Q4']]],
  ['mason-day', 'Mason, per day', 'walls', 'day', 'labour', [['historical_project_actual', '25000', 'Demo project actuals']]],
];
for (const [code, name, section, unit, cat, rates] of catalog) {
  const item = await call(opsAdmin.token, 'POST', '/v1/admin/catalog-items', { code, name, section, unit, rateCategory: cat });
  for (const region of ['north', 'south']) for (const [sourceClass, rate, reference] of rates) {
    await call(opsAdmin.token, 'POST', '/v1/admin/rate-observations', { catalogItemId: item.id, regionCode: region, sourceClass, rate, observedAt: today, reference });
  }
}

/** A one-page demo floor plan PDF (a 12 m × 10 m outline with a 1 m scale bar at 1:100 on A3). */
function demoPlan() {
  const mm = 72 / 25.4;               // points per mm on paper; 1:100 → 1 m = 10 mm
  const m = 10 * mm;
  const x0 = 100, y0 = 150;
  const ops = [
    '2 w', `${x0} ${y0} ${12 * m} ${10 * m} re S`,
    `${x0 + 5 * m} ${y0} m ${x0 + 5 * m} ${y0 + 10 * m} l S`, `${x0} ${y0 + 6 * m} m ${x0 + 5 * m} ${y0 + 6 * m} l S`,
    '1 w', `${x0} 80 m ${x0 + m} 80 l S`, `${x0} 76 m ${x0} 84 l S`, `${x0 + m} 76 m ${x0 + m} 84 l S`,
    `BT /F1 10 Tf ${x0} 60 Td (Scale bar 1 m at 1:100) Tj ET`, `BT /F1 14 Tf ${x0} ${y0 + 10 * m + 20} Td (Demo bungalow - ground floor plan) Tj ET`,
  ].join('\n');
  return Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 1191 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${ops.length}>>stream
${ops}
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`);
}

const project = await call(buyer.token, 'POST', '/v1/projects', { name: 'Demo bungalow', buildingUse: 'house', areaCode: 'hilltop', floors: 1, grossFloorAreaM2: '120', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'planning', hasSurvey: true });
const planPdf = demoPlan();
const doc = await call(buyer.token, 'POST', `/v1/projects/${project.id}/documents`, { title: 'Ground floor plan', number: 'A-101', docType: 'drawing', discipline: 'architectural', revisionLabel: 'P1', fileName: 'A-101.pdf', bytes: planPdf.length });
// Uploads go straight to storage when it supports presigned URLs (Vercel Blob), otherwise through the API.
if (/^https?:/.test(doc.upload.url)) {
  const r = await fetch(doc.upload.url, { method: 'PUT', body: planPdf, headers: { 'content-type': 'application/pdf' } });
  if (!r.ok) throw new Error(`direct upload failed: ${r.status} ${await r.text()}`);
} else {
  await app.inject({ method: 'PUT', url: doc.upload.url, payload: planPdf, headers: { 'content-type': 'application/pdf' } });
}
await call(buyer.token, 'POST', doc.upload.complete);
const { processRevision } = await import('./modules/documents.js');
await processRevision(s, doc.revisionId);
await call(buyer.token, 'POST', `/v1/projects/${project.id}/estimates/indicative`);

await app.close();
console.log(`Seeded ${created.length} live listings, 1 in review, 4 staff, 6 sellers, 1 buyer, ${catalog.length} catalog items and a demo project.`);
console.log('Sign in with any seeded number; in development the code is shown on the sign-in page.');
console.log('  moderator +2348000000001 · second moderator +2348000000002 · ops admin +2348000000003 · QS reviewer +2348000000004');
console.log('  supplier  +2348011111111 · buyer +2348055555555 · architect (house plans) +2348066666666');
