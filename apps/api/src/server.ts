import { buildApp } from './app.js';
import { startWorker } from './worker.js';

const { app, services } = await buildApp();
if (services.config.runWorkerInProcess) startWorker(services, 30_000, (m, e) => app.log.error({ err: e }, m));
await app.listen({ port: services.config.port, host: '0.0.0.0' });
console.log(`API listening on ${services.config.publicApiUrl} (market ${services.pack.id}, ${services.db.driver})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void app.close().then(() => process.exit(0)); });
