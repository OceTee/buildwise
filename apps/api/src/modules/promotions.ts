import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { formatMoney, listingPath, taxOn, uuidv7, type PromotionProductDef } from '@bw/domain';
import { iso, many, one, type Sql } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { ApiError, audit, conflict, forbidden, notFound, notify, publish, signWebhook, unprocessable, verifyWebhook } from '../platform/platform.js';

/**
 * Paid promotions, the only payments in Release 1 (spec §3.13). Payment happens on a hosted checkout; the
 * signed provider webhook is the only thing that marks a purchase paid. In development a local hosted
 * checkout stands in for the provider and posts a correctly signed webhook.
 */
const PENDING_TTL_HOURS = 24;
const fmt = (minor: unknown, currency: string, locale: string) => formatMoney({ amountMinor: String(minor), currency }, locale);

function priced(s: Services, p: PromotionProductDef) {
  const tax = taxOn(p.priceMinor, s.pack.tax.ratePercent);
  return {
    code: p.code, kind: p.kind, name: p.name, days: p.days, extraAllowance: p.extraAllowance ?? 0,
    net: { amountMinor: String(p.priceMinor), currency: s.pack.currency, display: fmt(p.priceMinor, s.pack.currency, s.pack.locale) },
    tax: { amountMinor: String(tax), label: `${s.pack.tax.label} ${s.pack.tax.ratePercent}%` },
    gross: { amountMinor: String(p.priceMinor + tax), currency: s.pack.currency, display: fmt(p.priceMinor + tax, s.pack.currency, s.pack.locale) },
  };
}

async function canPay(sql: Sql, orgId: string, userId: string) {
  const m = await one<{ role: string }>(sql, `select role from org_members where org_id = $1 and user_id = $2`, [orgId, userId]);
  return !!m && ['owner', 'admin', 'billing'].includes(m.role);
}

function purchaseView(p: Record<string, any>, s: Services) {
  return {
    id: p.id, listingId: p.listing_id, listingTitle: p.title ?? null, listingPath: p.title ? listingPath(p.title, p.listing_id) : null,
    productCode: p.product_code, productName: s.pack.promotionProducts.find((x) => x.code === p.product_code)?.name ?? p.product_code,
    kind: p.kind, status: p.status,
    gross: { amountMinor: String(p.gross_minor), currency: p.currency, display: fmt(p.gross_minor, p.currency, s.pack.locale) },
    remainingSeconds: p.remaining_seconds, endsAt: iso(p.ends_at), paidAt: iso(p.paid_at), createdAt: iso(p.created_at),
    invoiceNumber: p.invoice_number ?? null, checkoutRef: p.status === 'pending_payment' ? p.checkout_ref : null,
  };
}

/** Starts a paid promotion's clock if its listing is live; otherwise it stays paid and starts when the listing goes live. */
async function activateIfLive(sql: Sql, purchaseId: string) {
  const p = await one<{ listing_id: string; status: string }>(sql, `select p.listing_id, l.status from promotion_purchases p join listings l on l.id = p.listing_id where p.id = $1`, [purchaseId]);
  if (p?.status !== 'live') return false;
  await sql.query(`update promotion_purchases set status = 'active', active_since = now(), ends_at = now() + make_interval(secs => remaining_seconds) where id = $1`, [purchaseId]);
  await publish(sql, 'PromotionActivated', { purchaseId, listingId: p.listing_id, resumed: false });
  return true;
}

async function nextInvoiceNumber(sql: Sql) {
  const year = new Date().getUTCFullYear();
  const r = await one<{ n: number }>(sql, `select count(*)::int as n from platform_fees where invoice_number like $1`, [`INV-${year}-%`]);
  return `INV-${year}-${String((r?.n ?? 0) + 1).padStart(6, '0')}`;
}

export interface CheckoutEvent { id: string; type: 'checkout.completed' | 'checkout.failed'; data: { ref: string; amountMinor: string; currency: string } }

/** Applies one verified provider event. Idempotent on the event id; never trusts the amount without comparing it. */
export async function applyCheckoutEvent(sql: Sql, s: Services, evt: CheckoutEvent): Promise<string> {
  const ins = await sql.query(`insert into payment_webhook_events (event_id, provider, payload) values ($1, 'hosted-checkout', $2::jsonb) on conflict (event_id) do nothing returning event_id`, [evt.id, JSON.stringify(evt)]);
  if (!ins.rows.length) return 'duplicate';
  const done = async (outcome: string) => { await sql.query(`update payment_webhook_events set processed_at = now(), outcome = $2 where event_id = $1`, [evt.id, outcome]); return outcome; };

  const p = await one<Record<string, any>>(sql, `select * from promotion_purchases where checkout_ref = $1 for update`, [evt.data.ref]);
  if (!p) return done('unknown_ref');
  if (p.status !== 'pending_payment') return done('not_pending');
  if (evt.type === 'checkout.failed') {
    await sql.query(`update promotion_purchases set status = 'cancelled' where id = $1`, [p.id]);
    return done('failed');
  }
  if (String(evt.data.amountMinor) !== String(p.gross_minor) || evt.data.currency !== p.currency) {
    await audit(sql, { actorUserId: null, action: 'payment.amount_mismatch', targetType: 'PromotionPurchase', targetId: p.id, metadata: { expected: String(p.gross_minor), got: evt.data.amountMinor, currency: evt.data.currency } });
    return done('amount_mismatch');
  }
  await sql.query(`update promotion_purchases set status = 'paid', paid_at = now() where id = $1`, [p.id]);
  const invoice = await nextInvoiceNumber(sql);
  await sql.query(`insert into platform_fees (id, purchase_id, org_id, invoice_number, net_minor, tax_minor, gross_minor, currency, tax_code, tax_rate_percent) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [uuidv7(), p.id, p.org_id, invoice, p.net_minor, p.tax_minor, p.gross_minor, p.currency, s.pack.tax.code, s.pack.tax.ratePercent]);
  await publish(sql, 'PromotionPurchased', { purchaseId: p.id, listingId: p.listing_id, orgId: p.org_id, invoice });
  const active = await activateIfLive(sql, p.id);
  await notify(sql, [p.created_by], {
    kind: 'promotion', title: 'Payment received',
    body: active ? `Your promotion is running. Invoice ${invoice}.` : `Your promotion starts when the listing is live. Invoice ${invoice}.`, link: '/account/promotions',
  });
  await audit(sql, { actorUserId: null, action: 'promotion.paid', targetType: 'PromotionPurchase', targetId: p.id, metadata: { invoice, eventId: evt.id } });
  return done(active ? 'activated' : 'paid');
}

export function registerPromotions(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'GET', url: '/v1/promotions/products', auth: 'public',
    handler: async () => ({ items: s.pack.promotionProducts.map((p) => priced(s, p)), illustrative: s.pack.illustrative }),
  });

  route(app, s, {
    method: 'POST', url: '/v1/promotions', auth: 'user',
    body: z.object({ listingId: z.uuid(), productCode: z.string().max(40) }),
    handler: async ({ sql, body, user }) => {
      const product = s.pack.promotionProducts.find((p) => p.code === body.productCode);
      if (!product) throw notFound('Product');
      const l = await one<{ seller_org_id: string; status: string; title: string }>(sql, `select seller_org_id, status, title from listings where id = $1`, [body.listingId]);
      if (!l || !(await canPay(sql, l.seller_org_id, user.id))) throw notFound('Listing');
      if (!['live', 'in_review'].includes(l.status)) throw unprocessable('LISTING_NOT_PROMOTABLE', 'Only live listings, or listings waiting for review, can be promoted.');
      const dup = await one(sql, `select 1 from promotion_purchases where listing_id = $1 and product_code = $2 and status in ('pending_payment', 'paid', 'active', 'paused')`, [body.listingId, product.code]);
      if (dup) throw conflict('ALREADY_PROMOTED', 'This listing already has this promotion pending or running.');
      const net = product.priceMinor;
      const tax = taxOn(net, s.pack.tax.ratePercent);
      const id = uuidv7();
      const ref = `chk_${randomBytes(12).toString('hex')}`;
      await sql.query(`insert into promotion_purchases (id, org_id, listing_id, product_code, kind, net_minor, tax_minor, gross_minor, currency, status, remaining_seconds, slot_weight, checkout_ref, created_by)
                       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending_payment', $10, $11, $12, $13)`,
        [id, l.seller_org_id, body.listingId, product.code, product.kind, net, tax, net + tax, s.pack.currency, product.days * 86_400, product.slotWeight ?? 1, ref, user.id]);
      await audit(sql, { actorUserId: user.id, action: 'promotion.checkout_started', targetType: 'PromotionPurchase', targetId: id, metadata: { product: product.code } });
      return { id, checkoutRef: ref, checkoutUrl: `${s.config.publicWebUrl}/checkout/${ref}`, ...priced(s, product) };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/promotions/:id/cancel', auth: 'user', successStatus: 200,
    params: z.object({ id: z.uuid() }),
    handler: async ({ sql, params, user }) => {
      const p = await one<{ org_id: string; status: string }>(sql, `select org_id, status from promotion_purchases where id = $1`, [params.id]);
      if (!p || !(await canPay(sql, p.org_id, user.id))) throw notFound('Promotion');
      if (p.status !== 'pending_payment') throw conflict('NOT_CANCELLABLE', 'Only unpaid promotions can be cancelled.');
      await sql.query(`update promotion_purchases set status = 'cancelled' where id = $1`, [params.id]);
      return { status: 'cancelled' };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/my/promotions', auth: 'user',
    handler: async ({ sql, user }) => {
      const rows = await many<Record<string, any>>(sql,
        `select p.*, l.title, f.invoice_number from promotion_purchases p join listings l on l.id = p.listing_id left join platform_fees f on f.purchase_id = p.id
          where p.org_id in (select org_id from org_members where user_id = $1) and p.status <> 'cancelled' order by p.created_at desc limit 200`, [user.id]);
      const credits = await many<Record<string, any>>(sql,
        `select * from promotion_credits where org_id in (select org_id from org_members where user_id = $1) and used_by_purchase_id is null order by created_at desc`, [user.id]);
      return {
        items: rows.map((p) => purchaseView(p, s)),
        credits: credits.map((c) => ({ id: c.id, kind: c.kind, days: Math.round((c.seconds / 86_400) * 10) / 10, seconds: c.seconds, createdAt: iso(c.created_at) })),
      };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/my/invoices/:number', auth: 'user',
    params: z.object({ number: z.string().regex(/^INV-\d{4}-\d{6}$/) }),
    handler: async ({ sql, params, user }) => {
      const f = await one<Record<string, any>>(sql,
        `select f.*, p.product_code, p.listing_id, l.title, o.name as org_name from platform_fees f join promotion_purchases p on p.id = f.purchase_id join listings l on l.id = p.listing_id join organizations o on o.id = f.org_id where f.invoice_number = $1`, [params.number]);
      if (!f || !(await canPay(sql, f.org_id, user.id))) throw notFound('Invoice');
      const money = (v: unknown) => ({ amountMinor: String(v), display: fmt(String(v), f.currency, s.pack.locale) });
      return {
        number: f.invoice_number, issuedAt: iso(f.issued_at), billedTo: f.org_name, currency: f.currency,
        line: { description: `${s.pack.promotionProducts.find((x) => x.code === f.product_code)?.name ?? f.product_code} — ${f.title}`, net: money(f.net_minor) },
        tax: { code: f.tax_code, ratePercent: Number(f.tax_rate_percent), ...money(f.tax_minor) }, total: money(f.gross_minor),
        illustrative: s.pack.illustrative,
      };
    },
  });

  // Credits come from promotions interrupted through no fault of the seller; they restart on another listing.
  route(app, s, {
    method: 'POST', url: '/v1/promotion-credits/:id/apply', auth: 'user',
    params: z.object({ id: z.uuid() }),
    body: z.object({ listingId: z.uuid() }),
    handler: async ({ sql, params, body, user }) => {
      const c = await one<Record<string, any>>(sql, `select c.*, p.product_code, p.slot_weight, p.currency from promotion_credits c join promotion_purchases p on p.id = c.source_purchase_id where c.id = $1 for update of c`, [params.id]);
      if (!c || c.used_by_purchase_id || !(await canPay(sql, c.org_id, user.id))) throw notFound('Credit');
      const l = await one<{ seller_org_id: string; status: string }>(sql, `select seller_org_id, status from listings where id = $1`, [body.listingId]);
      if (!l || l.seller_org_id !== c.org_id) throw forbidden('Credits can only be used on your own listings.');
      if (!['live', 'in_review'].includes(l.status)) throw unprocessable('LISTING_NOT_PROMOTABLE', 'Only live listings, or listings waiting for review, can be promoted.');
      const id = uuidv7();
      await sql.query(`insert into promotion_purchases (id, org_id, listing_id, product_code, kind, net_minor, tax_minor, gross_minor, currency, status, remaining_seconds, slot_weight, created_by, paid_at)
                       values ($1, $2, $3, $4, $5, 0, 0, 0, $6, 'paid', $7, $8, $9, now())`, [id, c.org_id, body.listingId, c.product_code, c.kind, c.currency, c.seconds, c.slot_weight, user.id]);
      await sql.query(`update promotion_credits set used_by_purchase_id = $2 where id = $1`, [c.id, id]);
      const active = await activateIfLive(sql, id);
      await audit(sql, { actorUserId: user.id, action: 'promotion.credit_applied', targetType: 'PromotionPurchase', targetId: id, metadata: { creditId: c.id } });
      return { id, status: active ? 'active' : 'paid' };
    },
  });

  // ---------------------------------------------------------------- hosted checkout (provider side)
  route(app, s, {
    method: 'GET', url: '/v1/checkout/:ref', auth: 'public',
    params: z.object({ ref: z.string().regex(/^chk_[0-9a-f]{24}$/) }),
    handler: async ({ sql, params }) => {
      const p = await one<Record<string, any>>(sql, `select p.*, l.title from promotion_purchases p join listings l on l.id = p.listing_id where p.checkout_ref = $1`, [params.ref]);
      if (!p) throw notFound('Checkout');
      const product = s.pack.promotionProducts.find((x) => x.code === p.product_code);
      return {
        ref: params.ref, status: p.status, productName: product?.name ?? p.product_code, listingTitle: p.title,
        total: { amountMinor: String(p.gross_minor), currency: p.currency, display: fmt(p.gross_minor, p.currency, s.pack.locale) },
        devProvider: s.config.env !== 'production',
        expiresAt: new Date(new Date(String(p.created_at)).getTime() + PENDING_TTL_HOURS * 3_600_000).toISOString(),
      };
    },
  });

  // Signed provider webhook. Registered without route(): it is called by the provider, not a user, and the
  // signature covers the exact raw bytes.
  app.post('/v1/webhooks/checkout', async (req, reply) => {
    const raw = (req as unknown as { rawBody?: string }).rawBody ?? '';
    const sig = req.headers['x-checkout-signature'];
    if (!verifyWebhook(s.config.checkoutWebhookSecret, typeof sig === 'string' ? sig : undefined, raw)) throw new ApiError(401, 'INVALID_SIGNATURE', 'Signature check failed.');
    const parsed = z.object({ id: z.string().min(6).max(100), type: z.enum(['checkout.completed', 'checkout.failed']), data: z.object({ ref: z.string().max(100), amountMinor: z.string().regex(/^\d+$/), currency: z.string().length(3) }) }).safeParse(req.body);
    if (!parsed.success) throw new ApiError(400, 'VALIDATION_FAILED', 'Unrecognised event.');
    const outcome = await s.db.tx({ kind: 'system' }, (sql) => applyCheckoutEvent(sql, s, parsed.data));
    return reply.code(200).send({ received: true, outcome });
  });

  // Development stand-in for the provider: the "Pay" button on the local hosted checkout page.
  if (s.config.env !== 'production') {
    app.post('/v1/dev/checkout/:ref/:result', async (req, reply) => {
      const { ref, result } = req.params as { ref: string; result: string };
      const p = await s.db.tx({ kind: 'system' }, (sql) => one<{ gross_minor: string; currency: string }>(sql, `select gross_minor, currency from promotion_purchases where checkout_ref = $1`, [ref]));
      if (!p) throw notFound('Checkout');
      const payload = JSON.stringify({ id: `evt_${randomBytes(10).toString('hex')}`, type: result === 'fail' ? 'checkout.failed' : 'checkout.completed', data: { ref, amountMinor: String(p.gross_minor), currency: p.currency } });
      const res = await app.inject({ method: 'POST', url: '/v1/webhooks/checkout', payload, headers: { 'content-type': 'application/json', 'x-checkout-signature': signWebhook(s.config.checkoutWebhookSecret, payload) } });
      return reply.code(res.statusCode).send(res.json());
    });
  }
}

export { PENDING_TTL_HOURS };
