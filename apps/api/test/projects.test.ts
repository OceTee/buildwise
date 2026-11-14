import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harness, type Json } from './helpers.js';

let h: Awaited<ReturnType<typeof harness>>;
type User = Awaited<ReturnType<typeof h.signIn>>;
let owner: User, collab: User, outsider: User, staff: User;

/** A minimal PDF with `pages` A3-landscape pages. */
export function pdf(pages = 1, extra = '') {
  const kids = Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ');
  const objs = Array.from({ length: pages }, (_, i) => `${3 + i} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 1191 842]>>endobj`).join('\n');
  return Buffer.from(`%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj\n${objs}\n${extra}trailer<</Root 1 0 R>>\n%%EOF`);
}

async function upload(user: User, target: { url: string }, data: Buffer, type = 'application/pdf') {
  const res = await h.app.inject({ method: 'PUT', url: target.url, payload: data, headers: { authorization: `Bearer ${user.token}`, 'content-type': type } });
  expect(res.statusCode).toBe(200);
  return res.json();
}

async function waitState(user: User, docId: string, revisionId: string, want = 'available') {
  for (let i = 0; i < 100; i++) {
    const d = await h.ok(user.token, 'GET', `/v1/documents/${docId}`);
    const r = d.revisions.find((x: Json) => x.id === revisionId);
    if (r && !['awaiting_upload', 'quarantined', 'scanning', 'processing'].includes(r.state)) { expect(r.state).toBe(want); return r; }
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('processing did not finish');
}

beforeAll(async () => {
  h = await harness();
  owner = await h.signIn('Olu Owner');
  collab = await h.signIn('Cara Collaborator');
  outsider = await h.signIn('Oscar Outsider');
  staff = await h.signIn('Sam Support', { staff: 'moderator' });
});
afterAll(async () => { await h?.close(); });

let projectId: string;

describe('projects and access', () => {
  it('creates a project with partial intake and reports what is missing', async () => {
    const r = await h.ok(owner.token, 'POST', '/v1/projects', { name: 'Family house', buildingUse: 'house', areaCode: 'hilltop' });
    projectId = r.id;
    const p = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}`);
    expect(p.role).toBe('owner');
    expect(p.missing.map((m: Json) => m.field)).toEqual(expect.arrayContaining(['floors', 'grossFloorAreaM2']));
    expect(p.indicative.ok).toBe(false);
    expect(p.currency).toBe('NGN');
  });

  it('gives an indicative range once the inputs are there, with stale-version protection', async () => {
    const p0 = await h.ok(owner.token, 'GET', `/v1/projects/${projectId}`);
    const p = await h.ok(owner.token, 'PATCH', `/v1/projects/${projectId}`, { floors: 2, grossFloorAreaM2: '180', finishBand: 'standard', siteStatus: 'owned_clear', designStage: 'planning', expectedVersion: p0.version });
    expect(p.indicative.ok).toBe(true);
    expect(BigInt(p.indicative.highMinor)).toBeGreaterThan(BigInt(p.indicative.lowMinor));
    expect(p.readiness.outcome).toBe('needs_professional');
    expect((await h.call(owner.token, 'PATCH', `/v1/projects/${projectId}`, { floors: 3, expectedVersion: p0.version })).status).toBe(409);
  });

  it('hides projects from non-members (404, never 403)', async () => {
    expect((await h.call(outsider.token, 'GET', `/v1/projects/${projectId}`)).status).toBe(404);
    expect((await h.ok(outsider.token, 'GET', '/v1/projects')).items).toHaveLength(0);
    expect((await h.call(outsider.token, 'GET', `/v1/projects/${projectId}/documents`)).status).toBe(404);
  });

  it('invites by phone; the invitee accepts and gets only their role', async () => {
    await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/invitations`, { phone: collab.phone, role: 'collaborator' });
    expect((await h.ok(outsider.token, 'GET', '/v1/me/project-invitations')).items).toHaveLength(0);
    const inv = (await h.ok(collab.token, 'GET', '/v1/me/project-invitations')).items[0];
    expect(inv.projectName).toBe('Family house');
    expect((await h.call(outsider.token, 'POST', `/v1/project-invitations/${inv.id}/respond`, { accept: true })).status).toBe(404);
    await h.ok(collab.token, 'POST', `/v1/project-invitations/${inv.id}/respond`, { accept: true });
    const p = await h.ok(collab.token, 'GET', `/v1/projects/${projectId}`);
    expect(p.role).toBe('collaborator');
    expect(p.allowed).not.toContain('members.manage');
    expect((await h.call(collab.token, 'POST', `/v1/projects/${projectId}/invitations`, { phone: outsider.phone, role: 'viewer' })).status).toBe(404);
  });

  it('staff need a reason-coded session to see a project, and the owner is told', async () => {
    expect((await h.call(staff.token, 'GET', `/v1/projects/${projectId}`)).status).toBe(404);
    await h.ok(staff.token, 'POST', '/v1/staff/access-sessions', { projectId, reasonCode: 'support_request', ticket: 'SUP-1001' });
    const p = await h.ok(staff.token, 'GET', `/v1/projects/${projectId}`);
    expect(p.viaStaffSession).toBe(true);
    expect(p.allowed.every((a: string) => a.endsWith('.read'))).toBe(true);
    const n = await h.ok(owner.token, 'GET', '/v1/notifications');
    expect(n.items.some((x: Json) => x.kind === 'staff_access')).toBe(true);
  });
});

describe('documents', () => {
  let docId: string, rev1: string;

  it('uploads a drawing through a signed link and processes it', async () => {
    const data = pdf(2);
    const r = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/documents`, { title: 'Ground floor plan', number: 'A-101', docType: 'drawing', discipline: 'architectural', revisionLabel: 'P1', fileName: 'A-101.pdf', bytes: data.length });
    docId = r.documentId; rev1 = r.revisionId;
    expect(r.upload.url).toMatch(/^\/v1\/uploads\//);
    await upload(owner, r.upload, data);
    const rev = await waitState(owner, docId, rev1);
    expect(rev.pages).toBe(2);
    expect(rev.pageSizes[0]).toEqual({ w: 1191, h: 842 });
    expect((await h.call(owner.token, 'PUT', r.upload.url.replace('/v1', '/v1'), undefined)).status).toBeGreaterThanOrEqual(400);
  });

  it('rejects files by content, not extension, and keeps a clear message', async () => {
    const bad = Buffer.from('MZ this is not a pdf');
    const r = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/documents`, { title: 'Spec', docType: 'specification', discipline: 'specification', revisionLabel: '1', fileName: 'spec.pdf', bytes: bad.length });
    await upload(owner, r.upload, bad);
    const rev = await waitState(owner, r.documentId, r.revisionId, 'rejected');
    expect(rev.stateDetail).toMatch(/not supported/);
    const enc = pdf(1, '4 0 obj<</Filter/Standard/V 1/R 2/O(x)/U(y)/P -4>>endobj\n').toString().replace('trailer<</Root 1 0 R>>', 'trailer<</Root 1 0 R/Encrypt 4 0 R/ID[<01><01>]>>');
    const r2 = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/documents`, { title: 'Locked', docType: 'drawing', discipline: 'structural', revisionLabel: '1', fileName: 'locked.pdf', bytes: enc.length });
    await upload(owner, r2.upload, Buffer.from(enc));
    const rev2 = await waitState(owner, r2.documentId, r2.revisionId, 'rejected');
    expect(rev2.stateDetail).toMatch(/password|could not be read/);
  });

  it('serves files only through short-lived links issued after a policy check', async () => {
    const link = await h.ok(owner.token, 'POST', `/v1/revisions/${rev1}/file-link`, { disposition: 'inline' });
    const res = await h.app.inject({ method: 'GET', url: link.url });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect((await h.call(outsider.token, 'POST', `/v1/revisions/${rev1}/file-link`, {})).status).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: `${link.url}x` })).statusCode).toBe(404);
  });

  it('calibrates a page, measures, and flags measurements when a new revision supersedes the drawing', async () => {
    expect((await h.call(owner.token, 'POST', `/v1/revisions/${rev1}/measurements`, { page: 1, kind: 'area', label: 'Slab', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }] })).status).toBe(422);
    await h.ok(owner.token, 'POST', `/v1/revisions/${rev1}/calibrations`, { page: 1, a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, knownLength: '10', knownUnit: 'm' });
    const m = await h.ok(owner.token, 'POST', `/v1/revisions/${rev1}/measurements`, { page: 1, kind: 'area', label: 'Ground slab', points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 100 }, { x: 0, y: 100 }] });
    expect(m.value).toBe('50');
    expect(m.unit).toBe('m2');
    expect((await h.call(owner.token, 'POST', `/v1/revisions/${rev1}/calibrations`, { page: 1, a: { x: 0, y: 0 }, b: { x: 200, y: 0 }, knownLength: '10', knownUnit: 'm', check: { a: { x: 0, y: 0 }, b: { x: 0, y: 100 }, knownLength: '7', knownUnit: 'm' } })).status).toBe(422);

    // A second upload has to name the revision it replaces.
    const data = pdf(2);
    expect((await h.call(owner.token, 'POST', `/v1/documents/${docId}/revisions`, { revisionLabel: 'P1', fileName: 'A-101.pdf', bytes: data.length, supersedesRevisionId: rev1 })).status).toBe(409);
    const r2 = await h.ok(owner.token, 'POST', `/v1/documents/${docId}/revisions`, { revisionLabel: 'P2', fileName: 'A-101-P2.pdf', bytes: data.length, supersedesRevisionId: rev1 });
    await upload(owner, r2.upload, data);
    await waitState(owner, docId, r2.revisionId);
    const d = await h.ok(owner.token, 'GET', `/v1/documents/${docId}`);
    expect(d.currentRevisionId).toBe(r2.revisionId);
    expect(d.affectedMeasurements).toBe(1);
    const t = await h.ok(owner.token, 'GET', `/v1/revisions/${rev1}/takeoff`);
    expect(t.measurements[0].potentiallyAffected).toBe(true);
    expect(t.canMeasure).toBe(false);
  });

  it('attributes status labels and keeps RFIs as history', async () => {
    const d = await h.ok(owner.token, 'GET', `/v1/documents/${docId}`);
    await h.ok(owner.token, 'POST', `/v1/revisions/${d.currentRevisionId}/status`, { status: 'tender', basis: 'Issued by the architect on 10 Nov' });
    const d2 = await h.ok(owner.token, 'GET', `/v1/documents/${docId}`);
    expect(d2.revisions[0].status).toEqual({ code: 'tender', setBy: 'Olu Owner', basis: 'Issued by the architect on 10 Nov' });

    const rfi = await h.ok(collab.token, 'POST', `/v1/projects/${projectId}/rfis`, { subject: 'Lintel size', question: 'What lintel goes over the 2.4 m opening?', revisionId: d.currentRevisionId, page: 1 });
    expect(rfi.number).toBe(1);
    await h.ok(owner.token, 'POST', `/v1/rfis/${rfi.id}/entries`, { kind: 'response', body: 'Precast 225 mm lintel, see S-201.' });
    const full = await h.ok(collab.token, 'GET', `/v1/rfis/${rfi.id}`);
    expect(full.status).toBe('answered');
    expect(full.entries.map((e: Json) => e.kind)).toEqual(['question', 'response']);
    expect(full.reference.document).toBe('Ground floor plan');
    expect((await h.call(outsider.token, 'GET', `/v1/rfis/${rfi.id}`)).status).toBe(404);
  });

  it('keeps restricted documents to owners and managers', async () => {
    const data = pdf(1);
    const r = await h.ok(owner.token, 'POST', `/v1/projects/${projectId}/documents`, { title: 'Site title documents', docType: 'report', discipline: 'other', revisionLabel: '1', fileName: 'title.pdf', bytes: data.length, restricted: true });
    await upload(owner, r.upload, data);
    await waitState(owner, r.documentId, r.revisionId);
    const list = await h.ok(collab.token, 'GET', `/v1/projects/${projectId}/documents`);
    expect(list.items.some((x: Json) => x.id === r.documentId)).toBe(false);
    expect((await h.call(collab.token, 'GET', `/v1/documents/${r.documentId}`)).status).toBe(404);
  });
});
