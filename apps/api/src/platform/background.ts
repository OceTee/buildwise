import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Work that runs after a response: document processing, dispatching a request's outbox events once its transaction
 * has committed, and the opportunistic catch-up of time-based state. On Vercel `waitUntil` keeps the function alive
 * until it finishes (Fluid compute); on a long-running server it simply runs in-process. Anything missed is picked
 * up by the scheduled worker, so this is about promptness, never about correctness.
 */
const running = new Set<Promise<unknown>>();

export function inBackground(fn: () => Promise<unknown>, onError: (e: unknown) => void = () => undefined) {
  const p = new Promise((res) => setImmediate(res)).then(fn).catch(onError).finally(() => running.delete(p));
  running.add(p);
  if (process.env.VERCEL) void import('@vercel/functions').then((m) => m.waitUntil(p)).catch(() => undefined);
}

/** Waits for every background job, including ones started by jobs that were running (used on close and in tests). */
export async function drainBackground() { while (running.size) await Promise.allSettled([...running]); }

// ---------------------------------------------------------------- events written by the current request
const requestEvents = new AsyncLocalStorage<string[]>();

/** Runs `fn` collecting the ids of the outbox events it publishes. */
export function collectEvents<T>(fn: () => Promise<T>): { run: Promise<T>; events: string[] } {
  const events: string[] = [];
  return { run: requestEvents.run(events, fn), events };
}

/** Called by `publish`: remembers the event so it can be dispatched as soon as the transaction commits. */
export function eventPublished(eventId: string) { requestEvents.getStore()?.push(eventId); }
