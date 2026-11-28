import { API_ACCESS_HEADERS, API_URL } from '@/lib/env';

interface ServiceStatus {
  maintenance: { on: boolean; message: string | null };
  degraded: { on: boolean; message: string | null; features: string[] };
}

/** The API's /v1/status, cached for 30 s across requests, with a short timeout so a slow API never holds a page. */
async function status(): Promise<ServiceStatus | null> {
  try {
    const res = await fetch(`${API_URL}/v1/status`, { headers: API_ACCESS_HEADERS, next: { revalidate: 30 }, signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as ServiceStatus) : null;
  } catch {
    return null;
  }
}

/**
 * Site-wide service notices (docs/ops): maintenance (writes paused, from the API's MAINTENANCE_MODE, or this web
 * server's own MAINTENANCE_MESSAGE when the API itself is down) and degraded AI (designs fall back to the engine).
 */
export async function ServiceNotice() {
  const local = process.env.MAINTENANCE_MESSAGE?.trim();
  const s = await status();
  const maintenance = local || (s?.maintenance.on ? s.maintenance.message : null);
  if (maintenance) return <div role="status" className="service-note service-note-maintenance">{maintenance}</div>;
  if (s?.degraded.on && s.degraded.message) return <div role="status" className="service-note">{s.degraded.message}</div>;
  return null;
}
