'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ApiFailure, call, errorText } from '@/lib/client';
import type { ProjectConfig } from '@/lib/projects';

interface Region { code: string; label: string; areas: { code: string; label: string }[] }
type Brief = Record<string, any>;

const NOT_SURE = '__unsure__';

/**
 * Project intake (MVP spec §4.1): progressive, every question optional except a name, "I'm not sure" allowed,
 * saved as you go. Explains why each answer matters instead of asking for professional knowledge.
 */
export function BriefForm({ cfg, regions, initial, projectId, version }: { cfg: ProjectConfig; regions: Region[]; initial?: Brief; projectId?: string; version?: number }) {
  const router = useRouter();
  const [b, setB] = useState<Brief>(initial ?? {});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const set = (k: string, v: unknown) => setB((x) => ({ ...x, [k]: v === NOT_SURE || v === '' ? null : v }));
  const err = (k: string) => (errors[k] ? <div id={`${k}-err`} className="field-error">{errors[k]}</div> : null);
  const aria = (k: string) => ({ 'aria-invalid': !!errors[k] || undefined, 'aria-describedby': errors[k] ? `${k}-err` : `${k}-hint` });

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErrors({}); setMsg(null);
    const body = {
      name: b.name, buildingUse: b.buildingUse ?? null, areaCode: b.areaCode ?? null, floors: b.floors ? Number(b.floors) : null,
      grossFloorAreaM2: b.grossFloorAreaM2 ? String(b.grossFloorAreaM2) : null, finishBand: b.finishBand ?? null, siteStatus: b.siteStatus ?? null,
      designStage: b.designStage ?? null, hasSurvey: b.hasSurvey ?? null, hasGeotechnical: b.hasGeotechnical ?? null, targetStart: b.targetStart || null, constraints: b.constraints || null,
    };
    try {
      if (projectId) {
        await call(`/v1/projects/${projectId}`, { method: 'PATCH', body: { ...body, expectedVersion: version } });
        setMsg({ ok: true, text: 'Saved.' });
        router.push(`/projects/${projectId}`); router.refresh();
      } else {
        const r = await call<{ id: string }>('/v1/projects', { body });
        router.push(`/projects/${r.id}`);
      }
    } catch (x) {
      if (x instanceof ApiFailure && x.fieldErrors.length) setErrors(Object.fromEntries(x.fieldErrors.map((f) => [f.path, f.message])));
      setMsg({ ok: false, text: x instanceof ApiFailure && x.code === 'STALE_VERSION' ? 'Someone else changed this project. Reload the page to see their changes, then try again.' : errorText(x) });
    } finally { setBusy(false); }
  }

  const sel = (k: string, label: string, opts: { code: string; label: string }[], hint: string, unsure = true) => (
    <div className="field">
      <label htmlFor={k}>{label} <span id={`${k}-hint`} className="hint">{hint}</span></label>
      <select id={k} value={b[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...aria(k)}>
        <option value="">Choose</option>
        {opts.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
        {unsure && <option value={NOT_SURE}>I'm not sure</option>}
      </select>
      {err(k)}
    </div>
  );

  return (
    <form onSubmit={save} className="stack" noValidate>
      <fieldset>
        <legend>The project</legend>
        <div className="field">
          <label htmlFor="name">Project name <span id="name-hint" className="hint">Only you and people you invite see this.</span></label>
          <input id="name" required minLength={2} maxLength={120} value={b.name ?? ''} onChange={(e) => set('name', e.target.value)} {...aria('name')} />
          {err('name')}
        </div>
        <div className="row">
          {sel('buildingUse', 'What are you building?', cfg.buildingUses, 'Decides which estimates we can offer.', false)}
          <div className="field">
            <label htmlFor="areaCode">Where? <span id="areaCode-hint" className="hint">Area only; we never need the exact address yet.</span></label>
            <select id="areaCode" value={b.areaCode ?? ''} onChange={(e) => set('areaCode', e.target.value)} {...aria('areaCode')}>
              <option value="">Choose</option>
              {regions.map((r) => <optgroup key={r.code} label={r.label}>{r.areas.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}</optgroup>)}
            </select>
            {err('areaCode')}
          </div>
        </div>
      </fieldset>

      <fieldset>
        <legend>Size and finish <span className="hint">Needed for an indicative range</span></legend>
        <div className="row">
          <div className="field">
            <label htmlFor="floors">Floors <span id="floors-hint" className="hint">Including the ground floor</span></label>
            <input id="floors" type="number" inputMode="numeric" min={1} max={60} value={b.floors ?? ''} onChange={(e) => set('floors', e.target.value)} {...aria('floors')} />
            {err('floors')}
          </div>
          <div className="field">
            <label htmlFor="grossFloorAreaM2">Total floor area (m²) <span id="grossFloorAreaM2-hint" className="hint">All floors together; a rough figure is fine</span></label>
            <input id="grossFloorAreaM2" inputMode="decimal" value={b.grossFloorAreaM2 ?? ''} onChange={(e) => set('grossFloorAreaM2', e.target.value.replace(/[^\d.]/g, ''))} {...aria('grossFloorAreaM2')} />
            {err('grossFloorAreaM2')}
          </div>
          {sel('finishBand', 'Finish level', cfg.finishBands, 'Materials and fittings change the cost the most')}
        </div>
      </fieldset>

      <fieldset>
        <legend>Site and design <span className="hint">Needed for a reviewed estimate</span></legend>
        <div className="row">
          {sel('siteStatus', 'Site', cfg.siteStatuses, 'Existing structures and access affect cost')}
          {sel('designStage', 'Drawings', cfg.designStages, 'Reviewers can only measure detailed drawings')}
        </div>
        <div className="stack-sm">
          <label className="check"><input type="checkbox" checked={!!b.hasSurvey} onChange={(e) => set('hasSurvey', e.target.checked)} /> I have a land survey</label>
          <label className="check"><input type="checkbox" checked={!!b.hasGeotechnical} onChange={(e) => set('hasGeotechnical', e.target.checked)} /> I have a soil (ground) investigation</label>
        </div>
        <div className="row" style={{ marginTop: '1rem' }}>
          <div className="field">
            <label htmlFor="targetStart">Hoped-for start <span id="targetStart-hint" className="hint">Optional</span></label>
            <input id="targetStart" type="date" value={b.targetStart ?? ''} onChange={(e) => set('targetStart', e.target.value)} {...aria('targetStart')} />
          </div>
        </div>
        <div className="field">
          <label htmlFor="constraints">Anything else we should know? <span id="constraints-hint" className="hint">Optional: access, neighbours, deadlines</span></label>
          <textarea id="constraints" maxLength={2000} value={b.constraints ?? ''} onChange={(e) => set('constraints', e.target.value)} {...aria('constraints')} />
        </div>
      </fieldset>

      <div className="inline">
        <button className="btn btn-primary" type="submit" disabled={busy || !b.name}>{projectId ? 'Save changes' : 'Create project'}</button>
        <span className="small muted">You can leave questions blank and come back later.</span>
      </div>
      <div role="status" aria-live="polite">{msg && <p className={`notice small ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>
    </form>
  );
}
