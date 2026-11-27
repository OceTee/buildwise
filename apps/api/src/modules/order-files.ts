import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { uuidv7 } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, conflict, forbidden, notFound, signFileToken, unprocessable } from '../platform/platform.js';
import { markUploaded, uploadTarget } from './documents.js';
import { orderSide, type OrderSide } from './parties.js';

/**
 * Supplier uploads (R3 last slice): a proof-of-delivery photo against a delivery and a PDF of an invoice it sent.
 * The awarded supplier is not a project member, so `supplier_file_create` (a narrow security-definer function)
 * creates the project document and revision; the bytes then go through the same quarantine, malware scan, content
 * sniff and sharp pipeline as every project document (documents.ts). A photo must turn out to be an image and an
 * invoice a PDF, or the file is marked wrong-type and never shown as evidence.
 */

type Row = Record<string, any>;
const PURPOSE = {
  pod_photo: { label: 'Proof-of-delivery photo', accept: (t: string | null) => !!t && t.startsWith('image/'), wrong: 'This is not a photo. Upload a JPEG, PNG or WebP image.' },
  invoice_pdf: { label: 'Invoice PDF', accept: (t: string | null) => t === 'application/pdf', wrong: 'This is not a PDF. Upload the invoice as a PDF.' },
} as const;
type Purpose = keyof typeof PURPOSE;

export async function orderFilesOf(sql: Sql, side: OrderSide) {
  const rows = await many<Row>(sql, `select f.*, r.state, r.state_detail, r.detected_type, r.original_name, r.bytes, r.sha256, u.display_name from order_files f
    join document_revisions r on r.id = f.revision_id join users u on u.id = f.uploaded_by where f.order_id = $1 order by f.created_at`, [side.o.id]);
  return {
    canUpload: side.side === 'provider' && !['cancelled', 'closed'].includes(side.o.state),
    items: rows.map((f) => {
      const p = PURPOSE[f.purpose as Purpose];
      const wrongType = f.state === 'available' && !p.accept(f.detected_type);
      return {
        id: f.id, purpose: f.purpose, label: p.label, deliveryId: f.delivery_id, invoiceId: f.invoice_id, fileName: f.original_name, bytes: f.bytes == null ? null : Number(f.bytes),
        state: wrongType ? 'rejected' : f.state, stateDetail: wrongType ? p.wrong : f.state_detail, type: f.detected_type, sha256: f.sha256, uploadedBy: f.display_name, at: iso(f.created_at),
        available: f.state === 'available' && !wrongType,
      };
    }),
  };
}

export function registerOrderFiles(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'POST', url: '/v1/orders/:id/files', auth: 'user', params: z.object({ id: z.uuid() }),
    body: z.object({
      purpose: z.enum(['pod_photo', 'invoice_pdf']), deliveryId: z.uuid().optional(), invoiceId: z.uuid().optional(),
      fileName: z.string().trim().min(1).max(200), bytes: z.number().int().positive(),
    }),
    handler: async ({ sql, params, body, user }) => {
      const side = await orderSide(sql, user, params.id);
      if (side.side !== 'provider') throw forbidden('The supplier uploads its proof of delivery and invoices.');
      if (body.bytes > s.pack.projects.maxUploadBytes) throw unprocessable('FILE_TOO_LARGE', `Files can be up to ${Math.round(s.pack.projects.maxUploadBytes / 1024 / 1024)} MB.`);
      if (body.purpose === 'pod_photo' && !body.deliveryId) throw unprocessable('DELIVERY_REQUIRED', 'Choose the delivery this photo proves.');
      if (body.purpose === 'invoice_pdf' && !body.invoiceId) throw unprocessable('INVOICE_REQUIRED', 'Choose the invoice this PDF belongs to.');
      if (body.purpose === 'invoice_pdf' && (await one(sql, `select 1 from order_files f join document_revisions r on r.id = f.revision_id where f.invoice_id = $1 and r.state not in ('rejected', 'failed')`, [body.invoiceId]))) {
        throw conflict('ALREADY_ATTACHED', 'This invoice already has its PDF. Withdraw the invoice and send a new one to change it.');
      }
      const o = side.o;
      const fid = uuidv7(); const did = uuidv7(); const rid = uuidv7();
      const title = body.purpose === 'pod_photo'
        ? `Delivery photo, DEL-${String((await one<{ number: number }>(sql, `select number from deliveries where id = $1 and order_id = $2`, [body.deliveryId, o.id]))?.number ?? 0).padStart(2, '0')}`
        : `Invoice ${(await one<{ invoice_number: string }>(sql, `select invoice_number from supplier_invoices where id = $1 and order_id = $2`, [body.invoiceId, o.id]))?.invoice_number ?? ''}`;
      const ok = (await one<{ ok: boolean }>(sql, `select supplier_file_create($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) as ok`,
        [fid, did, rid, o.id, body.purpose, body.deliveryId ?? null, body.invoiceId ?? null, body.fileName, body.bytes, title]))!.ok;
      if (!ok) throw conflict('CANNOT_ATTACH', body.purpose === 'pod_photo' ? 'Photos go on a delivery that has been dispatched.' : 'That invoice is not open on this order.');
      await audit(sql, { actorUserId: user.id, action: 'order_file.created', targetType: 'Order', targetId: o.id, metadata: { fileId: fid, purpose: body.purpose, revisionId: rid } });
      return { fileId: fid, revisionId: rid, upload: { ...(await uploadTarget(s, rid)), complete: `/v1/order-files/${fid}/complete` } };
    },
  });

  // After the bytes arrive: record hash and size and queue the scan → sniff → sharp pipeline.
  route(app, s, {
    method: 'POST', url: '/v1/order-files/:id/complete', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    handler: async ({ sql, params, user }) => {
      const f = await one<Row>(sql, `select * from order_files where id = $1`, [params.id]);
      if (!f) throw notFound('File');
      const side = await orderSide(sql, user, f.order_id);
      if (side.side !== 'provider') throw forbidden();
      const rev = (await one<Row>(sql, `select * from document_revisions where id = $1`, [f.revision_id]))!;
      if (rev.state !== 'awaiting_upload') return { state: rev.state };
      const data = await s.storage.read(`quarantine/${rev.id}`);
      if (!data) throw conflict('UPLOAD_MISSING', 'The file has not arrived yet. Upload it again.');
      if (data.length > s.pack.projects.maxUploadBytes) throw unprocessable('FILE_TOO_LARGE', 'The file is too large.');
      // The supplier cannot write project documents; the pipeline records the upload in the system context.
      await s.db.tx({ kind: 'system' }, (sys) => markUploaded(s, sys, rev, data));
      return { state: 'quarantined' };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/order-files/:id/link', auth: 'user', params: z.object({ id: z.uuid() }), successStatus: 200,
    handler: async ({ sql, params, user }) => {
      const f = await one<Row>(sql, `select f.*, r.state, r.detected_type, r.original_name from order_files f join document_revisions r on r.id = f.revision_id where f.id = $1`, [params.id]);
      if (!f) throw notFound('File');
      const side = await orderSide(sql, user, f.order_id);
      if (f.state !== 'available' || !PURPOSE[f.purpose as Purpose].accept(f.detected_type)) throw conflict('NOT_AVAILABLE', 'This file is not available.');
      const mime = f.detected_type.startsWith('image/') ? 'image/jpeg' : f.detected_type;
      const token = signFileToken(s.config.authSecret, { op: 'download', key: `active/${f.revision_id}`, mime }, 300);
      if (side.side === 'client' && side.access.viaStaffSession) await audit(sql, { actorUserId: user.id, action: 'staff.document_viewed', targetType: 'DocumentRevision', targetId: f.revision_id });
      return { url: `/v1/files/${token}`, expiresInSeconds: 300 };
    },
  });

}
