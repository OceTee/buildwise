import { buildApp } from './app.js';
import { startWorker } from './worker.js';

// Stand-alone worker for production, where the API runs with RUN_WORKER_IN_PROCESS=false.
const { app, services } = await buildApp({ runWorkerInProcess: false });
const stop = startWorker(services, 15_000, app.log);
console.log('Worker running');
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stop(); void app.close().then(() => process.exit(0)); });
setInterval(() => undefined, 1 << 30);
