import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { calibrate, can, formatDec, measure, TakeoffError, uuidv7, type Calibration } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { ApiError, audit, badRequest, conflict, devScanner, forbidden, notFound, notify, publish, signFileToken, sniffType, unprocessable, verifyFileToken } from '../platform/platform.js';
import { projectAccess } from './projects.js';

/** Documents, revisions, the processing pipeline, takeoff geometry and RFIs (spec §10.2, §11.2, §12). */

const ALLOWED_TYPES: Record<string, { label: string; preview: 'pdf' | 'image' | 'none' }> = {
  'application/pdf': { label: 'PDF', preview: 'pdf' },
  'image/jpeg': { label: 'JPEG image', preview: 'image' },
  'image/png': { label: 'PNG image', preview: 'image' },
  'image/webp': { label: 'WebP image', preview: 'image' },
  'text/csv': { label: 'CSV', preview: 'none' },
  'application/zip': { label: 'Office document (XLSX/DOCX)', preview: 'none' },
  'image/vnd.dwg': { label: 'DWG drawing', preview: 'none' },
  'image/vnd.dxf': { label: 'DXF drawing', preview: 'none' },
  'application/x-step': { label: 'IFC model', preview: 'none' },
};
const UPLOAD_TTL = 30 * 60;

// Background processing started by requests; drained before the database closes.
const running = new Set<Promise<unknown>>();
function inBackground(fn: () => Promise<unknown>) {
  const p = new Promise((res) => setImmediate(res)).then(fn).catch(() => undefined).finally(() => running.delete(p));
  running.add(p);
  // On Vercel, keep the function alive until the work finishes (Fluid compute); the cron job retries anything missed.
  if (process.env.VERCEL) void import('@vercel/functions').then((m) => m.waitUntil(p)).catch(() => undefined);
}
export async function drainBackground() { while (running.size) await Promise.allSettled([...running]); }
const DOWNLOAD_TTL = 5 * 60;

function revisionView(r: Record<string, any>) {
  return {
    id: r.id, documentId: r.document_id, revision: r.revision_label, issuedDate: r.issued_date ? iso(r.issued_date)!.slice(0, 10) : null,
    status: r.status_label ? { code: r.status_label, setBy: r.status_by_name ?? null, basis: r.status_basis } : null,
    fileName: r.original_name, type: r.detected_type, typeLabel: r.detected_type ? ALLOWED_TYPES[r.detected_type]?.label ?? r.detected_type : null,
    preview: r.detected_type ? ALLOWED_TYPES[r.detected_type]?.preview ?? 'none' : 'none',
    bytes: r.bytes == null ? null : Number(r.bytes), pages: r.pages, pageSizes: r.page_sizes, sha256: r.sha256,
    state: r.state, stateDetail: r.state_detail, superseded: !!r.superseded_by_revision_id, supersedesRevisionId: r.supersedes_revision_id,
    uploadedBy: r.uploader_name ?? null, createdAt: iso(r.created_at), availableAt: iso(r.available_at),
  };
}

async function docForRevision(sql: Sql, revisionId: string) {
  const r = await one<Record<string, any>>(sql, `select r.*, d.restricted, d.title, d.project_id as doc_project from document_revisions r join documents d on d.id = r.document_id where r.id = $1`, [revisionId]);
  if (!r) throw notFound('Document');
  return r;
}

/** Restricted documents are visible to owners and managers only (DocumentAccessPolicy, §7.2). */
function checkRestricted(role: string, restricted: boolean) {
  if (restricted && !['owner', 'manager'].includes(role)) throw notFound('Document');
}

/**
 * Where the browser sends the file: a presigned storage URL when the store supports it (the file never passes
 * through a function), otherwise the API's own signed upload endpoint. Either way the client then calls `complete`.
 */
async function uploadTarget(s: Services, revisionId: string) {
  const key = `quarantine/${revisionId}`;
  const max = s.pack.projects.maxUploadBytes;
  const direct = await s.storage.directUploadUrl(key, max, UPLOAD_TTL);
  const url = direct ?? `/v1/uploads/${signFileToken(s.config.authSecret, { op: 'upload', key, maxBytes: max, ref: revisionId }, UPLOAD_TTL)}`;
  return { method: 'PUT' as const, url, maxBytes: max, expiresInSeconds: UPLOAD_TTL, complete: `/v1/revisions/${revisionId}/complete` };
}

/** Records that the bytes arrived (hash, size, duplicate check) and queues processing. Safe to call twice. */
async function markUploaded(s: Services, sql: Sql, rev: Record<string, any>, data: Buffer) {
  const sha = createHash('sha256').update(data).digest('hex');
  await sql.query(`update document_revisions set state = 'quarantined', bytes = $2, sha256 = $3 where id = $1 and state = 'awaiting_upload'`, [rev.id, data.length, sha]);
  const dup = await one<{ title: string; revision_label: string }>(sql, `select d.title, r.revision_label from document_revisions r join documents d on d.id = r.document_id where r.project_id = $1 and r.sha256 = $2 and r.id <> $3 limit 1`, [rev.project_id, sha, rev.id]);
  inBackground(() => processRevision(s, rev.id));
  return dup ? `${dup.title}, revision ${dup.revision_label}` : null;
}

/**
 * The processing pipeline: scan → sniff → sanitise/inspect → available (§12.2). Each step records its state;
 * a failure keeps the original and can be retried. Safe to run twice.
 */
export async function processRevision(s: Services, revisionId: string): Promise<string> {
  // Claim the revision atomically so a background run and a retry never process it twice.
  const claimed = await s.db.tx({ kind: 'system' }, (sql) => one<{ id: string }>(sql,
    `update document_revisions set state = 'scanning', state_detail = null where id = $1 and (state in ('quarantined', 'failed') or (state in ('scanning', 'processing') and created_at < now() - interval '2 minutes')) returning id`, [revisionId]));
  if (!claimed) return (await s.db.tx({ kind: 'system' }, (sql) => one<{ state: string }>(sql, `select state from document_revisions where id = $1`, [revisionId])))?.state ?? 'missing';
  const set = (state: string, detail: string | null = null, extra = '', params: unknown[] = []) =>
    s.db.tx({ kind: 'system' }, (sql) => sql.query(`update document_revisions set state = $2, state_detail = $3${extra} where id = $1`, [revisionId, state, detail, ...params]));
  try {
    const key = `quarantine/${revisionId}`;
    const data = await s.storage.read(key);
    if (!data) { await set('failed', 'The upload did not arrive. Upload the file again.'); return 'failed'; }
    const scan = await devScanner.scan(data);
    if (!scan.clean) { await set('rejected', `The file was blocked by the malware scan (${scan.signature}).`); return 'rejected'; }
    await set('processing');
    const type = sniffType(data.subarray(0, 4096));
    if (!type || !ALLOWED_TYPES[type]) { await set('rejected', 'This file type is not supported. Upload a PDF, image, CSV, XLSX, DOCX, DWG, DXF or IFC file.'); return 'rejected'; }
    let pages: number | null = null; let sizes: { w: number; h: number }[] | null = null;
    let active = data;
    if (type === 'application/pdf') {
      const { getDocument, PasswordException } = await import('pdfjs-dist/legacy/build/pdf.mjs');
      // Load the worker module up front so bundled deployments (where pdf.js cannot find it by path) use it directly.
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
      try {
        const task = getDocument({ data: new Uint8Array(data), disableFontFace: true, verbosity: 0 });
        const doc = await task.promise;
        pages = doc.numPages;
        if (pages > s.pack.projects.maxPdfPages) { await set('rejected', `This PDF has ${pages} pages; the limit is ${s.pack.projects.maxPdfPages}. Split it into smaller files.`); return 'rejected'; }
        sizes = [];
        for (let i = 1; i <= pages; i++) { const v = (await doc.getPage(i)).getViewport({ scale: 1 }); sizes.push({ w: Math.round(v.width), h: Math.round(v.height) }); }
        await task.destroy();
      } catch (e) {
        const msg = e instanceof PasswordException || /password/i.test(String(e)) ? 'This PDF is password-protected. Remove the password and upload it again.' : 'This PDF could not be read. It may be damaged; export it again and upload the new file.';
        await set('rejected', msg); return 'rejected';
      }
    } else if (type.startsWith('image/') && ALLOWED_TYPES[type]!.preview === 'image') {
      // Shared copies drop location and other metadata; the original stays in quarantine storage (§12.1).
      const img = sharp(data, { failOn: 'error' }).rotate();
      const meta = await img.metadata();
      active = await img.jpeg({ quality: 88 }).toBuffer();
      pages = 1; sizes = [{ w: meta.width ?? 0, h: meta.height ?? 0 }];
    }
    await s.storage.put(`active/${revisionId}`, active, type.startsWith('image/') ? 'image/jpeg' : type);
    await s.db.tx({ kind: 'system' }, async (sql) => {
      await sql.query(`update document_revisions set state = 'available', state_detail = null, detected_type = $2, pages = $3, page_sizes = $4::jsonb, available_at = now() where id = $1`,
        [revisionId, type, pages, sizes ? JSON.stringify(sizes) : null]);
      await finishRevision(sql, revisionId);
    });
    return 'available';
  } catch (e) {
    await set('failed', 'Processing failed. Your file is kept; try again.', ', attempts = attempts + 1');
    void e;
    return 'failed';
  }
}

/** Makes a newly available revision current and flags measurements on the revision it supersedes (§10.2 step 4). */
async function finishRevision(sql: Sql, revisionId: string) {
  const r = (await one<Record<string, any>>(sql, `select * from document_revisions where id = $1`, [revisionId]))!;
  await sql.query(`update documents set current_revision_id = $2 where id = $1`, [r.document_id, revisionId]);
  if (r.supersedes_revision_id) {
    await sql.query(`update document_revisions set superseded_by_revision_id = $2 where id = $1`, [r.supersedes_revision_id, revisionId]);
    const n = (await sql.query(`update measurements set potentially_affected = true where revision_id = $1 and deleted_at is null returning id`, [r.supersedes_revision_id])).rows.length;
    await publish(sql, 'DocumentRevisionSuperseded', { projectId: r.project_id, documentId: r.document_id, oldRevisionId: r.supersedes_revision_id, newRevisionId: revisionId, affectedMeasurements: n });
    if (n) {
      const reviewers = await many<{ user_id: string }>(sql, `select user_id from project_members where project_id = $1 and role in ('owner', 'manager', 'reviewer')`, [r.project_id]);
      await notify(sql, reviewers.map((x) => x.user_id), { kind: 'revision_superseded', title: 'A drawing was revised', body: `${n} measurement(s) on the previous revision may be affected.`, link: `/projects/${r.project_id}/documents/${r.document_id}` });
    }
  }
  await publish(sql, 'DocumentRevisionIssued', { projectId: r.project_id, documentId: r.document_id, revisionId });
}

const newRevisionFields = z.object({
  revisionLabel: z.string().trim().min(1).max(20),
  issuedDate: z.iso.date().optional(),
  fileName: z.string().trim().min(1).max(200),
  bytes: z.number().int().positive(),
});

export function registerDocuments(app: FastifyInstance, s: Services) {
  // ---------------------------------------------------------------- register
  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/documents', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const a = await projectAccess(sql, user, params.id, 'documents.read');
      const rows = await many<Record<string, any>>(sql,
        `select d.*, r.id as rev_id, r.revision_label, r.state, r.state_detail, r.status_label, r.pages, r.detected_type, r.created_at as rev_at,
                (select count(*)::int from document_revisions x where x.document_id = d.id) as revision_count,
                (select x.id from document_revisions x where x.document_id = d.id and x.state <> 'available' and x.created_at > coalesce(r.created_at, 'epoch') order by x.created_at desc limit 1) as pending_revision_id
           from documents d left join document_revisions r on r.id = coalesce(d.current_revision_id, (select id from document_revisions y where y.document_id = d.id order by y.created_at desc limit 1))
          where d.project_id = $1 order by d.discipline, d.number nulls last, d.title`, [params.id]);
      const visible = rows.filter((d) => !d.restricted || ['owner', 'manager'].includes(a.role));
      return {
        items: visible.map((d) => ({
          id: d.id, title: d.title, number: d.number, type: d.doc_type, discipline: d.discipline, restricted: d.restricted,
          current: d.rev_id ? { id: d.rev_id, revision: d.revision_label, state: d.state, stateDetail: d.state_detail, status: d.status_label, pages: d.pages, type: d.detected_type, at: iso(d.rev_at) } : null,
          revisionCount: d.revision_count, pendingRevisionId: d.pending_revision_id,
        })),
        canUpload: can(a.role, 'documents.upload') && !a.viaStaffSession,
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/documents', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: newRevisionFields.extend({
      title: z.string().trim().min(2).max(200), number: z.string().trim().max(40).optional(),
      docType: z.string().max(30), discipline: z.string().max(30), restricted: z.boolean().default(false),
    }),
    handler: async ({ sql, params, body, user }) => {
      const a = await projectAccess(sql, user, params.id, 'documents.upload');
      const cfg = s.pack.projects;
      if (!cfg.documentTypes.some((t) => t.code === body.docType)) throw badRequest('VALIDATION_FAILED', 'Check the form.', [{ path: 'docType', message: 'Choose a document type.' }]);
      if (!cfg.disciplines.some((t) => t.code === body.discipline)) throw badRequest('VALIDATION_FAILED', 'Check the form.', [{ path: 'discipline', message: 'Choose a discipline.' }]);
      if (body.bytes > cfg.maxUploadBytes) throw unprocessable('FILE_TOO_LARGE', `Files can be up to ${Math.round(cfg.maxUploadBytes / 1024 / 1024)} MB.`);
      if (body.restricted && !['owner', 'manager'].includes(a.role)) throw forbidden('Only owners and managers can restrict a document.');
      if (body.number) {
        const dup = await one<{ id: string; title: string }>(sql, `select id, title from documents where project_id = $1 and lower(number) = lower($2)`, [params.id, body.number]);
        if (dup) throw conflict('DOCUMENT_EXISTS', `Document ${body.number} already exists (“${dup.title}”). Upload this file as a new revision of it instead.`, { documentId: dup.id });
      }
      const docId = uuidv7(); const revId = uuidv7();
      await sql.query(`insert into documents (id, project_id, doc_type, discipline, number, title, restricted, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [docId, params.id, body.docType, body.discipline, body.number ?? null, body.title, body.restricted, user.id]);
      await sql.query(`insert into document_revisions (id, document_id, project_id, revision_label, issued_date, storage_key, original_name, bytes, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [revId, docId, params.id, body.revisionLabel, body.issuedDate ?? null, `active/${revId}`, body.fileName, body.bytes, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'document.created', targetType: 'Document', targetId: docId, metadata: { projectId: params.id } });
      return { documentId: docId, revisionId: revId, upload: await uploadTarget(s, revId) };
    },
  });

  // A new upload never silently replaces a document: the caller confirms which revision it supersedes (§10.2 step 2).
  route(app, s, {
    method: 'POST', url: '/v1/documents/:docId/revisions', auth: 'user',
    params: z.object({ docId: z.uuid() }),
    body: newRevisionFields.extend({ supersedesRevisionId: z.uuid() }),
    handler: async ({ sql, params, body, user }) => {
      const d = await one<Record<string, any>>(sql, `select * from documents where id = $1`, [params.docId]);
      if (!d) throw notFound('Document');
      const a = await projectAccess(sql, user, d.project_id, 'documents.upload');
      checkRestricted(a.role, d.restricted);
      if (d.current_revision_id !== body.supersedesRevisionId) throw conflict('NOT_CURRENT_REVISION', 'Another revision was added since you opened this document. Reload and confirm which revision this replaces.');
      const dupLabel = await one(sql, `select 1 from document_revisions where document_id = $1 and lower(revision_label) = lower($2)`, [d.id, body.revisionLabel]);
      if (dupLabel) throw conflict('REVISION_EXISTS', `Revision ${body.revisionLabel} already exists. Use the next revision label.`);
      const revId = uuidv7();
      await sql.query(`insert into document_revisions (id, document_id, project_id, revision_label, issued_date, storage_key, original_name, bytes, uploaded_by, supersedes_revision_id) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [revId, d.id, d.project_id, body.revisionLabel, body.issuedDate ?? null, `active/${revId}`, body.fileName, body.bytes, user.id, body.supersedesRevisionId]);
      return { documentId: d.id, revisionId: revId, upload: await uploadTarget(s, revId) };
    },
  });

  // Development upload target (production: a presigned URL straight to the quarantine bucket).
  app.put('/v1/uploads/:token', { bodyLimit: s.pack.projects.maxUploadBytes + 1024 }, async (req, reply) => {
    const t = verifyFileToken(s.config.authSecret, (req.params as { token: string }).token, 'upload');
    if (!t?.ref) throw new ApiError(403, 'UPLOAD_EXPIRED', 'This upload link has expired. Start the upload again.');
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest('EMPTY_UPLOAD', 'The file is empty.');
    if (t.maxBytes && body.length > t.maxBytes) throw unprocessable('FILE_TOO_LARGE', 'The file is too large.');
    const rev = await s.db.tx({ kind: 'system' }, (sql) => one<Record<string, any>>(sql, `select * from document_revisions where id = $1`, [t.ref]));
    if (!rev || rev.state !== 'awaiting_upload') throw conflict('ALREADY_UPLOADED', 'This file has already been uploaded.');
    await s.storage.put(t.key, body, 'application/octet-stream');
    const dup = await s.db.tx({ kind: 'system' }, (sql) => markUploaded(s, sql, rev, body));
    return reply.code(200).send({ received: true, duplicateOf: dup });
  });

  route(app, s, {
    method: 'GET', url: '/v1/documents/:docId', auth: 'user',
    params: z.object({ docId: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const d = await one<Record<string, any>>(sql, `select * from documents where id = $1`, [params.docId]);
      if (!d) throw notFound('Document');
      const a = await projectAccess(sql, user, d.project_id, 'documents.read');
      checkRestricted(a.role, d.restricted);
      const revs = await many<Record<string, any>>(sql,
        `select r.*, u.display_name as uploader_name, sb.display_name as status_by_name from document_revisions r join users u on u.id = r.uploaded_by left join users sb on sb.id = r.status_set_by where r.document_id = $1 order by r.created_at desc`, [d.id]);
      const affected = await one<{ n: number }>(sql, `select count(*)::int as n from measurements m join document_revisions r on r.id = m.revision_id where r.document_id = $1 and m.potentially_affected and m.deleted_at is null`, [d.id]);
      return {
        id: d.id, projectId: d.project_id, title: d.title, number: d.number, type: d.doc_type, discipline: d.discipline, restricted: d.restricted, currentRevisionId: d.current_revision_id,
        revisions: revs.map(revisionView), affectedMeasurements: affected?.n ?? 0,
        can: { upload: can(a.role, 'documents.upload') && !a.viaStaffSession, setStatus: can(a.role, 'documents.set_status') && !a.viaStaffSession, measure: (can(a.role, 'estimate.edit_client') || can(a.role, 'estimate.review')) && !a.viaStaffSession },
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/revisions/:id/upload-target', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await docForRevision(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'documents.upload');
      if (r.state !== 'awaiting_upload') throw conflict('ALREADY_UPLOADED', 'This file has already been uploaded.');
      return await uploadTarget(s, r.id);
    },
  });

  // Called by the browser after uploading. After a direct upload to storage it records the file and queues
  // processing; after an upload through the API it simply reports the state.
  route(app, s, {
    method: 'POST', url: '/v1/revisions/:id/complete', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await docForRevision(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'documents.upload');
      if (r.state !== 'awaiting_upload') return { state: r.state, duplicateOf: null };
      const data = await s.storage.read(`quarantine/${r.id}`);
      if (!data) throw conflict('UPLOAD_MISSING', 'The file has not arrived yet. Upload it again.');
      if (data.length > s.pack.projects.maxUploadBytes) throw unprocessable('FILE_TOO_LARGE', 'The file is too large.');
      const duplicateOf = await markUploaded(s, sql, r, data);
      return { state: 'quarantined', duplicateOf };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/revisions/:id/retry', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await docForRevision(sql, params.id);
      await projectAccess(sql, user, r.project_id, 'documents.upload');
      if (r.state !== 'failed') throw conflict('NOT_RETRYABLE', 'Only failed processing can be retried.');
      inBackground(() => processRevision(s, r.id));
      return { state: 'queued' };
    },
  });

  // Downloads: policy check first, then a short-lived signed link (§7.5).
  route(app, s, {
    method: 'POST', url: '/v1/revisions/:id/file-link', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }),
    handler: async ({ sql, params, body, user }) => {
      const r = await docForRevision(sql, params.id);
      const a = await projectAccess(sql, user, r.project_id, 'documents.read');
      checkRestricted(a.role, r.restricted);
      if (r.state !== 'available') throw conflict('NOT_AVAILABLE', 'This file is not available yet.');
      const mime = r.detected_type?.startsWith('image/') ? 'image/jpeg' : r.detected_type ?? 'application/octet-stream';
      const token = signFileToken(s.config.authSecret, { op: 'download', key: `active/${r.id}`, mime, name: body.disposition === 'attachment' ? r.original_name : undefined }, DOWNLOAD_TTL);
      if (a.viaStaffSession) await audit(sql, { actorUserId: user.id, action: 'staff.document_viewed', targetType: 'DocumentRevision', targetId: r.id });
      return { url: `/v1/files/${token}`, expiresInSeconds: DOWNLOAD_TTL };
    },
  });

  app.get('/v1/files/:token', async (req, reply) => {
    const t = verifyFileToken(s.config.authSecret, (req.params as { token: string }).token, 'download');
    const file = t ? await s.storage.stream(t.key) : null;
    if (!t || !file) throw new ApiError(404, 'NOT_FOUND', 'This link has expired.');
    reply.header('content-type', t.mime ?? 'application/octet-stream');
    reply.header('cache-control', 'private, max-age=300');
    reply.header('content-disposition', t.name ? `attachment; filename="${t.name.replace(/[^\w.\- ]/g, '_')}"` : 'inline');
    return reply.send(file.body);
  });

  // Status labels are attributed to whoever set them, with their basis (§10.2 step 3).
  route(app, s, {
    method: 'POST', url: '/v1/revisions/:id/status', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    body: z.object({ status: z.string().max(30), basis: z.string().trim().min(3).max(500) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await docForRevision(sql, params.id);
      const a = await projectAccess(sql, user, r.project_id, 'documents.set_status');
      checkRestricted(a.role, r.restricted);
      if (!s.pack.projects.documentStatuses.some((x) => x.code === body.status)) throw badRequest('VALIDATION_FAILED', 'Choose a status.');
      await sql.query(`update document_revisions set status_label = $2, status_set_by = $3, status_basis = $4 where id = $1`, [r.id, body.status, user.id, body.basis]);
      await audit(sql, { actorUserId: user.id, action: 'document.status_set', targetType: 'DocumentRevision', targetId: r.id, reason: body.basis, metadata: { status: body.status } });
      return { status: body.status };
    },
  });

  // ---------------------------------------------------------------- takeoff (§11.2)
  route(app, s, {
    method: 'GET', url: '/v1/revisions/:id/takeoff', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await docForRevision(sql, params.id);
      const a = await projectAccess(sql, user, r.project_id, 'documents.read');
      checkRestricted(a.role, r.restricted);
      const cals = await many<Record<string, any>>(sql, `select * from calibrations where revision_id = $1 and current`, [r.id]);
      const ms = await many<Record<string, any>>(sql, `select m.*, u.display_name from measurements m join users u on u.id = m.author where m.revision_id = $1 and m.deleted_at is null order by m.created_at`, [r.id]);
      return {
        revision: revisionView(r), superseded: !!r.superseded_by_revision_id,
        calibrations: cals.map((c) => ({ id: c.id, page: c.page, ...(typeof c.data === 'string' ? JSON.parse(c.data) : c.data), at: iso(c.created_at) })),
        measurements: ms.map(measurementView),
        canMeasure: (can(a.role, 'estimate.edit_client') || can(a.role, 'estimate.review')) && !a.viaStaffSession && !r.superseded_by_revision_id,
      };
    },
  });

  const pt = z.object({ x: z.number().finite(), y: z.number().finite() });
  route(app, s, {
    method: 'POST', url: '/v1/revisions/:id/calibrations', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ page: z.number().int().min(1), a: pt, b: pt, knownLength: z.string().max(20), knownUnit: z.enum(['m', 'mm']), check: z.object({ a: pt, b: pt, knownLength: z.string().max(20), knownUnit: z.enum(['m', 'mm']) }).nullable().optional() }),
    handler: async ({ sql, params, body, user }) => {
      const r = await measurable(sql, user, params.id);
      if (r.detected_type !== 'application/pdf' || body.page > (r.pages ?? 0)) throw badRequest('INVALID_PAGE', 'Choose a page of this PDF.');
      let cal: Calibration;
      try { cal = calibrate(body, s.pack.projects.calibrationTolerancePct); } catch (e) { if (e instanceof TakeoffError) throw unprocessable(e.code, e.message); throw e; }
      await sql.query(`update calibrations set current = false where revision_id = $1 and page = $2`, [r.id, body.page]);
      const id = uuidv7();
      await sql.query(`insert into calibrations (id, revision_id, project_id, page, data, created_by) values ($1, $2, $3, $4, $5::jsonb, $6)`, [id, r.id, r.project_id, body.page, JSON.stringify(cal), user.id]);
      return { id, page: body.page, ...cal };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/revisions/:id/measurements', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({
      page: z.number().int().min(1), kind: z.enum(['count', 'linear', 'perimeter', 'area', 'volume', 'manual']), label: z.string().trim().min(1).max(120),
      layer: z.string().max(30).default('architectural'), points: z.array(pt).max(2000).default([]), count: z.number().int().min(1).max(100000).optional(),
      depth: z.string().max(20).nullable().optional(), manualValue: z.string().max(30).nullable().optional(), manualUnit: z.string().max(20).nullable().optional(), formula: z.string().max(300).nullable().optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const r = await measurable(sql, user, params.id);
      if (body.page > (r.pages ?? 1)) throw badRequest('INVALID_PAGE', 'Choose a page of this document.');
      const c = await one<{ id: string; data: any }>(sql, `select id, data from calibrations where revision_id = $1 and page = $2 and current`, [r.id, body.page]);
      let res;
      try { res = measure(body, c ? (typeof c.data === 'string' ? JSON.parse(c.data) : c.data) : null); } catch (e) { if (e instanceof TakeoffError) throw unprocessable(e.code, e.message); throw e; }
      const id = uuidv7();
      await sql.query(`insert into measurements (id, project_id, revision_id, page, kind, label, layer, geometry, value, unit, derivation, calibration_id, author) values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)`,
        [id, r.project_id, r.id, body.page, body.kind, body.label, body.layer, JSON.stringify({ points: body.points, count: body.count ?? null, depth: body.depth ?? null }), formatDec(res.value), res.unit, res.derivation, c?.id ?? null, user.id]);
      const m = (await one<Record<string, any>>(sql, `select m.*, u.display_name from measurements m join users u on u.id = m.author where m.id = $1`, [id]))!;
      return measurementView(m);
    },
  });

  route(app, s, {
    method: 'DELETE', url: '/v1/measurements/:id', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const m = await one<Record<string, any>>(sql, `select * from measurements where id = $1 and deleted_at is null`, [params.id]);
      if (!m) throw notFound('Measurement');
      await measurable(sql, user, m.revision_id);
      const used = await one(sql, `select 1 from estimate_lines l join estimate_versions v on v.id = l.version_id where $1 = any(l.measurement_ids) and v.state not in ('draft', 'under_review', 'information_required', 'changes_requested')`, [m.id]);
      if (used) throw conflict('MEASUREMENT_IN_USE', 'This measurement is part of a submitted or issued estimate and cannot be removed.');
      await sql.query(`update measurements set deleted_at = now() where id = $1`, [m.id]);
      return { deleted: true };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/measurements/:id/confirm', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const m = await one<Record<string, any>>(sql, `select * from measurements where id = $1 and deleted_at is null`, [params.id]);
      if (!m) throw notFound('Measurement');
      const a = await projectAccess(sql, user, m.project_id, 'estimate.review');
      void a;
      await sql.query(`update measurements set confirmed = true, potentially_affected = false where id = $1`, [m.id]);
      await audit(sql, { actorUserId: user.id, action: 'measurement.confirmed', targetType: 'Measurement', targetId: m.id });
      return { confirmed: true };
    },
  });

  // ---------------------------------------------------------------- RFIs (§10.2 step 5)
  route(app, s, {
    method: 'GET', url: '/v1/projects/:id/rfis', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      await projectAccess(sql, user, params.id, 'rfi.read');
      const rows = await many<Record<string, any>>(sql,
        `select r.*, u.display_name as author_name, a.display_name as assignee_name, d.title as doc_title, rv.revision_label,
                (select count(*)::int from rfi_entries e where e.rfi_id = r.id) as entries
           from rfis r join users u on u.id = r.created_by left join users a on a.id = r.assignee_user_id
           left join document_revisions rv on rv.id = r.revision_id left join documents d on d.id = rv.document_id
          where r.project_id = $1 order by r.status = 'closed', r.number desc`, [params.id]);
      return { items: rows.map(rfiView) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/projects/:id/rfis', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({
      subject: z.string().trim().min(3).max(200), question: z.string().trim().min(5).max(4000),
      revisionId: z.uuid().optional(), page: z.number().int().min(1).optional(), measurementId: z.uuid().optional(), estimateLineId: z.uuid().optional(),
      assigneeUserId: z.uuid().optional(), dueDate: z.iso.date().optional(),
    }),
    handler: async ({ sql, params, body, user }) => {
      await projectAccess(sql, user, params.id, 'rfi.create');
      if (body.revisionId && !(await one(sql, `select 1 from document_revisions where id = $1 and project_id = $2`, [body.revisionId, params.id]))) throw badRequest('INVALID_REFERENCE', 'That document is not in this project.');
      if (body.assigneeUserId && !(await one(sql, `select 1 from project_members where project_id = $1 and user_id = $2`, [params.id, body.assigneeUserId]))) throw badRequest('INVALID_ASSIGNEE', 'Assign the RFI to a project member.');
      const n = (await one<{ n: number }>(sql, `select coalesce(max(number), 0)::int + 1 as n from rfis where project_id = $1`, [params.id]))!.n;
      const id = uuidv7();
      await sql.query(`insert into rfis (id, project_id, number, subject, revision_id, page, measurement_id, estimate_line_id, assignee_user_id, due_date, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [id, params.id, n, body.subject, body.revisionId ?? null, body.page ?? null, body.measurementId ?? null, body.estimateLineId ?? null, body.assigneeUserId ?? null, body.dueDate ?? null, user.id]);
      await sql.query(`insert into rfi_entries (id, rfi_id, project_id, kind, body, author) values ($1, $2, $3, 'question', $4, $5)`, [uuidv7(), id, params.id, body.question, user.id]);
      const notifyIds = body.assigneeUserId ? [body.assigneeUserId] : (await many<{ user_id: string }>(sql, `select user_id from project_members where project_id = $1 and role in ('owner', 'manager') and user_id <> $2`, [params.id, user.id])).map((x) => x.user_id);
      await notify(sql, notifyIds, { kind: 'rfi', title: `RFI ${n}: ${body.subject}`, body: body.question.slice(0, 160), link: `/projects/${params.id}/rfis/${id}` });
      await publish(sql, 'RfiRaised', { projectId: params.id, rfiId: id });
      return { id, number: n };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/rfis/:id', auth: 'user',
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const r = await one<Record<string, any>>(sql,
        `select r.*, u.display_name as author_name, a.display_name as assignee_name, d.title as doc_title, d.id as doc_id, rv.revision_label
           from rfis r join users u on u.id = r.created_by left join users a on a.id = r.assignee_user_id
           left join document_revisions rv on rv.id = r.revision_id left join documents d on d.id = rv.document_id where r.id = $1`, [params.id]);
      if (!r) throw notFound('RFI');
      const a = await projectAccess(sql, user, r.project_id, 'rfi.read');
      const entries = await many<Record<string, any>>(sql, `select e.*, u.display_name from rfi_entries e join users u on u.id = e.author where e.rfi_id = $1 order by e.created_at`, [r.id]);
      return { ...rfiView(r), documentId: r.doc_id, entries: entries.map((e) => ({ id: e.id, kind: e.kind, body: e.body, author: e.display_name, at: iso(e.created_at) })), canRespond: can(a.role, 'rfi.respond') && !a.viaStaffSession };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/rfis/:id/entries', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ kind: z.enum(['response', 'decision', 'note', 'question']), body: z.string().trim().min(2).max(4000), close: z.boolean().default(false) }),
    handler: async ({ sql, params, body, user }) => {
      const r = await one<Record<string, any>>(sql, `select * from rfis where id = $1`, [params.id]);
      if (!r) throw notFound('RFI');
      await projectAccess(sql, user, r.project_id, 'rfi.respond');
      if (r.status === 'closed') throw conflict('RFI_CLOSED', 'This RFI is closed.');
      await sql.query(`insert into rfi_entries (id, rfi_id, project_id, kind, body, author) values ($1, $2, $3, $4, $5, $6)`, [uuidv7(), r.id, r.project_id, body.kind, body.body, user.id]);
      const status = body.close ? 'closed' : body.kind === 'response' || body.kind === 'decision' ? 'answered' : body.kind === 'question' ? 'open' : r.status;
      await sql.query(`update rfis set status = $2 where id = $1`, [r.id, status]);
      if (body.kind === 'response' || body.kind === 'decision') {
        await publish(sql, 'RfiAnswered', { projectId: r.project_id, rfiId: r.id });
        if (r.created_by !== user.id) await notify(sql, [r.created_by], { kind: 'rfi', title: `RFI ${r.number} answered`, body: body.body.slice(0, 160), link: `/projects/${r.project_id}/rfis/${r.id}` });
      }
      return { status };
    },
  });
}

async function measurable(sql: Sql, user: { id: string; isStaff: boolean; sessionId: string; staffRole: string | null }, revisionId: string) {
  const r = await docForRevision(sql, revisionId);
  let a;
  try { a = await projectAccess(sql, user, r.project_id, 'estimate.review'); } catch { a = await projectAccess(sql, user, r.project_id, 'estimate.edit_client'); }
  checkRestricted(a.role, r.restricted);
  if (a.viaStaffSession) throw forbidden('Staff access is read-only.');
  if (r.state !== 'available') throw conflict('NOT_AVAILABLE', 'This file is not available yet.');
  if (r.superseded_by_revision_id) throw conflict('REVISION_SUPERSEDED', 'This revision has been superseded. Measure on the current revision.');
  return r;
}

function measurementView(m: Record<string, any>) {
  const g = typeof m.geometry === 'string' ? JSON.parse(m.geometry) : m.geometry;
  return {
    id: m.id, revisionId: m.revision_id, page: m.page, kind: m.kind, label: m.label, layer: m.layer, points: g.points ?? [], count: g.count, depth: g.depth,
    value: formatDecString(m.value), unit: m.unit, derivation: m.derivation, potentiallyAffected: m.potentially_affected, confirmed: m.confirmed,
    author: m.display_name ?? null, at: iso(m.created_at),
  };
}
const formatDecString = (v: unknown) => { const s = String(v); return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s; };

function rfiView(r: Record<string, any>) {
  return {
    id: r.id, number: r.number, subject: r.subject, status: r.status, author: r.author_name, assignee: r.assignee_name ?? null,
    dueDate: r.due_date ? iso(r.due_date)!.slice(0, 10) : null, overdue: !!r.due_date && r.status === 'open' && new Date(r.due_date) < new Date(),
    reference: r.revision_id ? { revisionId: r.revision_id, document: r.doc_title, revision: r.revision_label, page: r.page } : null,
    measurementId: r.measurement_id, estimateLineId: r.estimate_line_id, entries: r.entries, createdAt: iso(r.created_at),
  };
}
