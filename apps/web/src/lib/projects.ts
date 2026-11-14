import { cache } from 'react';
import { api } from './server';

export interface ProjectSummary {
  id: string; name: string; status: string; currency: string; version: number; createdAt: string; updatedAt: string;
  brief: Record<string, any>; area: { code: string; label: string; region: string } | null;
  role: 'owner' | 'manager' | 'collaborator' | 'viewer' | 'reviewer'; viaStaffSession: boolean; allowed: string[];
  missing: { field: string; label: string; requiredFor: 'project' | 'indicative' | 'review' }[];
  readiness: { outcome: 'can_proceed' | 'needs_professional' | 'cannot_estimate'; explanation: string; items: { code: string; label: string; status: 'ok' | 'missing' | 'attention'; detail: string }[] };
  indicative: { ok: true; lowMinor: string; highMinor: string; contingencyPct: number; areaM2: string; classLabel: string; benchmark: { source: string; observedAt: string; includes: string[]; excludes: string[] } } | { ok: false; reason: string; message: string; missing?: string[] };
  counts: { documents: number; open_rfis: number; estimates: number; members: number };
}

export interface ProjectConfig {
  classes: { code: string; label: string }[];
  buildingUses: { code: string; label: string }[]; finishBands: { code: string; label: string }[];
  designStages: { code: string; label: string; measurable: boolean }[]; siteStatuses: { code: string; label: string }[];
  disciplines: { code: string; label: string }[]; documentTypes: { code: string; label: string }[]; documentStatuses: { code: string; label: string }[];
  workSections: { code: string; label: string }[]; maxUploadBytes: number; maxPdfPages: number; currency: string; illustrative: boolean;
}

/** The project for this request, or null if it does not exist or the viewer has no access (both look the same). */
export const loadProject = cache(async (id: string): Promise<ProjectSummary | null> => {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const r = await api<ProjectSummary>(`/v1/projects/${id}`);
  return r.status === 200 ? r.data : null;
});

export const loadProjectConfig = cache(async () => (await api<ProjectConfig>('/v1/project-config')).data);

export const canDo = (p: Pick<ProjectSummary, 'allowed'>, action: string) => p.allowed.includes(action);

export const ROLE_LABELS: Record<string, string> = { owner: 'Owner', manager: 'Manager', collaborator: 'Collaborator', viewer: 'Viewer', reviewer: 'Reviewer' };
