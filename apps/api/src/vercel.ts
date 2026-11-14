import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';

/**
 * Vercel Function entry: one Fastify instance per warm function, built (and migrated) on first request.
 * Bundled by scripts/build-vercel-api.mjs into apps/api/api/index.mjs.
 */
let ready: Promise<FastifyInstance> | null = null;

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= buildApp({ runWorkerInProcess: false }).then(async ({ app }) => { await app.ready(); return app; }).catch((e) => { ready = null; throw e; });
  const app = await ready;
  app.server.emit('request', req, res);
}
