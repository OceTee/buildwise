import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NOTIFICATION_TOPICS, notificationPrefs, type NotificationTopic } from '@bw/domain';
import { one } from '../db/database.js';
import { route, type Services } from '../http/route.js';

/** What each person wants copied to email or SMS (spec §16). In-app notifications are always kept. */
export function registerNotifications(app: FastifyInstance, s: Services) {
  const view = (stored: unknown, u: { email: string | null; phone_e164: string | null }) => ({
    topics: NOTIFICATION_TOPICS.map((t) => ({ ...t, ...notificationPrefs(stored)[t.topic] })),
    // Copies need somewhere to go: without an email address email copies wait; SMS needs a phone number.
    hasEmail: !!u.email, hasPhone: !!u.phone_e164,
    channels: { email: s.email.live ? 'live' : 'not_connected', sms: s.sms.live ? 'live' : 'not_connected' },
  });

  route(app, s, {
    method: 'GET', url: '/v1/me/notification-preferences', auth: 'user',
    handler: async ({ sql, user }) => {
      const u = await one<{ notification_prefs: unknown; email: string | null; phone_e164: string | null }>(sql, `select notification_prefs, email, phone_e164 from users where id = $1`, [user.id]);
      return view(u?.notification_prefs, u!);
    },
  });

  const channels = z.object({ email: z.boolean().optional(), sms: z.boolean().optional() });
  route(app, s, {
    method: 'PUT', url: '/v1/me/notification-preferences', auth: 'user', successStatus: 200,
    body: z.object(Object.fromEntries(NOTIFICATION_TOPICS.map((t) => [t.topic, channels.optional()])) as Record<NotificationTopic, z.ZodOptional<typeof channels>>),
    handler: async ({ sql, body, user }) => {
      const u = await one<{ notification_prefs: unknown; email: string | null; phone_e164: string | null }>(sql, `select notification_prefs, email, phone_e164 from users where id = $1`, [user.id]);
      const next = notificationPrefs(u?.notification_prefs);
      for (const { topic } of NOTIFICATION_TOPICS) next[topic] = { ...next[topic], ...Object.fromEntries(Object.entries(body[topic] ?? {}).filter(([, v]) => typeof v === 'boolean')) };
      await sql.query(`update users set notification_prefs = $2::jsonb where id = $1`, [user.id, JSON.stringify(next)]);
      return view(next, u!);
    },
  });
}
