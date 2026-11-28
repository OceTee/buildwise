import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  FEEDBACK_CATEGORIES, FEEDBACK_CATEGORY_LABELS, STAFF_ACCESS, FEEDBACK_MAX_CHARS, FEEDBACK_MIN_CHARS, FEEDBACK_STATES,
  feedbackContact, feedbackMachine, feedbackPagePath, screenFeedback, uuidv7, type FeedbackCommand, type FeedbackState,
} from '@bw/domain';
import { iso, many, one } from '../db/database.js';
import { route, type Services } from '../http/route.js';
import { audit, badRequest, conflict, notFound, sha256, tooMany } from '../platform/platform.js';

/**
 * Public-beta feedback and bug reports (`POST /v1/feedback`, anyone) and the staff triage list
 * (`/v1/moderation/feedback`). The public form runs in system context (it writes one row and counts recent rows from
 * the same IP and device); staff routes run as app_user, where RLS (019) lets staff read every row and change only
 * the triage columns. Status changes go into the audit log.
 */

type Row = Record<string, any>;

const hashOf = (s: Services, kind: string, value: string) => sha256(`${s.config.authSecret}:feedback:${kind}:${value}`);

function view(r: Row) {
  return {
    id: r.id, category: r.category, categoryLabel: FEEDBACK_CATEGORY_LABELS[r.category as keyof typeof FEEDBACK_CATEGORY_LABELS],
    message: r.message, pagePath: r.page_path, flags: r.flags ?? [], status: r.status as FeedbackState,
    commands: feedbackMachine.commandsFrom(r.status), signedIn: !!r.user_id, sender: r.display_name ?? null,
    contactOk: r.contact_ok, contact: r.contact_ok ? (r.contact ?? r.phone_e164 ?? null) : null,
    staffNote: r.staff_note, updatedBy: r.updated_by_name ?? null, updatedAt: iso(r.updated_at), createdAt: iso(r.created_at),
  };
}

export function registerFeedback(app: FastifyInstance, s: Services) {
  route(app, s, {
    method: 'POST', url: '/v1/feedback', auth: 'public', systemContext: true,
    body: z.object({
      category: z.enum(FEEDBACK_CATEGORIES),
      message: z.string().trim().min(FEEDBACK_MIN_CHARS, `Tell us a little more (at least ${FEEDBACK_MIN_CHARS} characters).`).max(FEEDBACK_MAX_CHARS),
      pageUrl: z.string().max(2000).optional(),
      contactOk: z.boolean().default(false),
      contact: z.string().max(120).optional(),
    }),
    handler: async ({ sql, body, user, client }) => {
      const lim = s.pack.limits;
      const ipHash = hashOf(s, 'ip', client.ip);
      const deviceHash = client.deviceId ? hashOf(s, 'device', client.deviceId) : null;
      const perIp = await one<{ n: number }>(sql, `select count(*)::int as n from feedback where ip_hash = $1 and created_at > now() - interval '1 hour'`, [ipHash]);
      if ((perIp?.n ?? 0) >= lim.feedbackPerIpPerHour) throw tooMany('Thanks, we have had a lot of feedback from this connection. Try again in an hour.', 3600);
      if (deviceHash) {
        const perDevice = await one<{ n: number }>(sql, `select count(*)::int as n from feedback where device_hash = $1 and created_at > now() - interval '1 hour'`, [deviceHash]);
        if ((perDevice?.n ?? 0) >= lim.feedbackPerDevicePerHour) throw tooMany('Thanks, we have had a lot of feedback from this device. Try again in an hour.', 3600);
      }
      if (user) {
        const perUser = await one<{ n: number }>(sql, `select count(*)::int as n from feedback where user_id = $1 and created_at > now() - interval '1 hour'`, [user.id]);
        if ((perUser?.n ?? 0) >= lim.feedbackPerDevicePerHour) throw tooMany('Thanks, we have had a lot of feedback from you this hour. Try again later.', 3600);
      }
      const contact = feedbackContact(body.contact);
      if (contact === 'invalid') throw badRequest('VALIDATION_FAILED', 'Check the form.', [{ path: 'contact', message: 'Enter an email address or a phone number, or leave it empty.' }]);
      if (contact && !body.contactOk) throw badRequest('VALIDATION_FAILED', 'Check the form.', [{ path: 'contactOk', message: 'Tick "you may contact me" if you want a reply at this address.' }]);
      const screened = screenFeedback(body.message, s.pack);
      if (screened.message.replace(/\[(email|number)\]/g, '').trim().length < FEEDBACK_MIN_CHARS) {
        throw badRequest('VALIDATION_FAILED', 'Check the form.', [{ path: 'message', message: 'Describe what happened in words. Put contact details in the contact box instead.' }]);
      }
      const id = uuidv7();
      await sql.query(
        `insert into feedback (id, category, message, page_path, flags, user_id, contact_ok, contact, ip_hash, device_hash) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, body.category, screened.message, feedbackPagePath(body.pageUrl), screened.flags, user?.id ?? null, body.contactOk, body.contactOk ? contact : null, ipHash, deviceHash],
      );
      return { id, status: 'open', contactRemoved: screened.flags.includes('contact_removed') };
    },
  });

  route(app, s, {
    method: 'GET', url: '/v1/moderation/feedback', auth: 'staff', staffRoles: STAFF_ACCESS.feedback,
    query: z.object({ status: z.enum(FEEDBACK_STATES).optional(), category: z.enum(FEEDBACK_CATEGORIES).optional() }),
    handler: async ({ sql, query }) => {
      const rows = await many<Row>(sql, `select f.*, u.display_name, u.phone_e164, ub.display_name as updated_by_name from feedback f
          left join users u on u.id = f.user_id left join users ub on ub.id = f.updated_by
          where ($1::text is null or f.status = $1) and ($2::text is null or f.category = $2)
          order by case f.status when 'open' then 0 when 'triaged' then 1 else 2 end, f.created_at desc limit 200`,
        [query.status ?? null, query.category ?? null]);
      const counts = await many<{ status: string; n: number }>(sql, `select status, count(*)::int as n from feedback group by status`);
      return {
        items: rows.map(view),
        counts: Object.fromEntries(FEEDBACK_STATES.map((st) => [st, counts.find((c) => c.status === st)?.n ?? 0])),
        categories: FEEDBACK_CATEGORIES.map((c) => ({ value: c, label: FEEDBACK_CATEGORY_LABELS[c] })),
      };
    },
  });

  route(app, s, {
    method: 'POST', url: '/v1/moderation/feedback/:id/commands/:command', auth: 'staff', staffRoles: STAFF_ACCESS.feedback, successStatus: 200,
    params: z.object({ id: z.uuid(), command: z.enum(['triage', 'close', 'reopen']) }),
    body: z.object({ note: z.string().trim().max(1000).optional() }),
    handler: async ({ sql, params, body, user }) => {
      const f = await one<Row>(sql, `select * from feedback where id = $1 for update`, [params.id]);
      if (!f) throw notFound('Feedback');
      const command = params.command as FeedbackCommand;
      if (!feedbackMachine.can(f.status, command)) throw conflict('INVALID_TRANSITION', `Feedback that is ${f.status} cannot be moved with "${command}".`);
      const next = feedbackMachine.next(f.status, command);
      const note = body.note || null;
      await sql.query(`update feedback set status = $2, staff_note = coalesce($3, staff_note), updated_by = $4, updated_at = now() where id = $1`, [f.id, next, note, user.id]);
      await audit(sql, { actorUserId: user.id, action: `feedback.${command}`, targetType: 'feedback', targetId: f.id, reason: note, metadata: { from: f.status, to: next, category: f.category } });
      const r = await one<Row>(sql, `select f.*, u.display_name, u.phone_e164, ub.display_name as updated_by_name from feedback f
          left join users u on u.id = f.user_id left join users ub on ub.id = f.updated_by where f.id = $1`, [f.id]);
      return view(r!);
    },
  });
}
