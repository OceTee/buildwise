'use client';
import { useState } from 'react';
import { Check, Plus, RotateCcw, Snowflake, Sun, Trash2, Zap, Droplets } from 'lucide-react';
import type { Load, LoadCategory, ProjectPlans, ProjectRecord } from '@bw/domain';
import { Working, fmtNum } from './planning-ui';
import { Nav, StepHead, type StepRef } from './ui';

type Tab = 'cooling' | 'water' | 'power';
const CATS: Record<LoadCategory, string> = { essential: 'Essential', comfort: 'Comfort', heavy: 'Heavy', scheduled: 'Scheduled', future: 'Future' };

/** Stage 04: cooling, water and power (solar optional), coordinated with the rooms of the design. */
export function SystemsStep({ stepRef, kicker, project, setProject, plans, confirmed, onConfirm, onBack, onNext }: {
  stepRef: StepRef; kicker: string; project: ProjectRecord; setProject: (f: (p: ProjectRecord) => ProjectRecord) => void; plans: ProjectPlans;
  confirmed: boolean; onConfirm: () => void; onBack: () => void; onNext: () => void;
}) {
  const [tab, setTab] = useState<Tab>('cooling');
  const sys = project.systems;
  const setSys = <K extends keyof ProjectRecord['systems']>(k: K, v: ProjectRecord['systems'][K]) => setProject((p) => ({ ...p, systems: { ...p.systems, [k]: v } }));
  const c = plans.cooling.result; const w = plans.water.result; const e = plans.energy.result;
  const loads = plans.loads;
  const setLoads = (ls: Load[]) => setSys('loads', ls);
  const editLoad = (i: number, patch: Partial<Load>) => setLoads(loads.map((l, k) => (k === i ? { ...l, ...patch } : l)));

  return (
    <div className="stack">
      <StepHead stepRef={stepRef} kicker={kicker} title="Cooling, water and power">Sized from the actual rooms of your design. Every number shows how it was worked out; installers and engineers confirm the final sizes.</StepHead>

      <div className="segs" role="tablist" aria-label="Systems">
        {([['cooling', 'Cooling', Snowflake], ['water', 'Water', Droplets], ['power', 'Power and solar', Zap]] as const).map(([k, label, Icon]) => (
          <button key={k} type="button" role="tab" id={`tab-${k}`} aria-selected={tab === k} aria-controls={`panel-${k}`} className={`seg${tab === k ? ' on' : ''}`} onClick={() => setTab(k)}><Icon size={14} aria-hidden="true" /> {label}</button>
        ))}
      </div>

      {tab === 'cooling' && (
        <section id="panel-cooling" role="tabpanel" aria-labelledby="tab-cooling" className="stack-sm">
          <div className="row wrap">
            <label className="check"><input type="checkbox" checked={sys.airConditioning} onChange={(ev) => setSys('airConditioning', ev.target.checked)} /> Air conditioning (otherwise ceiling fans only)</label>
            {sys.airConditioning && <label className="check"><input type="checkbox" checked={sys.kitchenAc} onChange={(ev) => setSys('kitchenAc', ev.target.checked)} /> Air-condition the kitchen too</label>}
          </div>
          <p className="stat-row"><span><strong>{c.acUnits}</strong> AC units</span><span><strong>{fmtNum(c.inputKw)}</strong> kW together</span><span><strong>{fmtNum(c.kwhPerDay)}</strong> kWh a day</span><span><strong>{c.fans}</strong> ceiling fans</span></p>
          <div className="table-wrap">
            <table className="table small">
              <caption className="sr-only">Cooling by room</caption>
              <thead><tr><th scope="col">Room</th><th scope="col">Area</th><th scope="col">Cooling load</th><th scope="col">Air conditioner</th><th scope="col">Energy</th></tr></thead>
              <tbody>{c.rooms.map((r) => (
                <tr key={r.roomId}><th scope="row">{r.name}</th><td>{r.areaM2} m²</td><td>{fmtNum(r.btu, 0)} BTU/h</td><td>{r.ac ? `${r.ac.units > 1 ? `${r.ac.units} × ` : ''}${r.ac.btu / 1000}k BTU (${r.ac.inputKw} kW)` : 'Fan'}</td><td>{r.kwhPerDay} kWh/day</td></tr>
              ))}</tbody>
            </table>
          </div>
          <Working calc={plans.cooling} />
        </section>
      )}

      {tab === 'water' && (
        <section id="panel-water" role="tabpanel" aria-labelledby="tab-water" className="stack-sm">
          <div className="row wrap">
            <label className="check"><input type="checkbox" checked={sys.borehole} onChange={(ev) => setSys('borehole', ev.target.checked)} /> Borehole with a pump</label>
            <label className="check"><input type="checkbox" checked={sys.hotWater} onChange={(ev) => setSys('hotWater', ev.target.checked)} /> Hot water heaters</label>
          </div>
          <p className="stat-row"><span><strong>{fmtNum(w.demandLPerDay, 0)}</strong> L a day for {w.people} people</span><span><strong>{fmtNum(w.storageL, 0)}</strong> L storage ({w.tanks.map((t) => `${t / 1000}k`).join(' + ')} L tanks)</span>{w.pump && <span><strong>{w.pump.hp} hp</strong> pump, {w.pump.headM} m head</span>}{w.heaters > 0 && <span><strong>{w.heaters}</strong> heaters</span>}</p>
          <p className="small">Fixtures: {w.fixtures.wcs} WCs, {w.fixtures.basins} basins, {w.fixtures.showers} showers. Septic tank about {fmtNum(w.septicL, 0)} L.</p>
          <Working calc={plans.water} />
        </section>
      )}

      {tab === 'power' && (
        <section id="panel-power" role="tabpanel" aria-labelledby="tab-power" className="stack-sm">
          <fieldset className="card-inset stack-sm">
            <legend className="label"><Sun size={14} aria-hidden="true" /> Solar (optional)</legend>
            <label className="check"><input type="checkbox" checked={sys.solar.enabled} onChange={(ev) => setSys('solar', { ...sys.solar, enabled: ev.target.checked })} /> Plan for solar power with a battery</label>
            {sys.solar.enabled && (
              <div className="row wrap">
                <div className="field">
                  <label htmlFor="solar-cover" className="small">What solar should run</label>
                  <select id="solar-cover" value={sys.solar.cover} onChange={(ev) => setSys('solar', { ...sys.solar, cover: ev.target.value as 'essential' | 'most' | 'all' })}>
                    <option value="essential">Essentials only (lights, fridge, network, security)</option>
                    <option value="most">Most things except heavy appliances</option>
                    <option value="all">Everything, including air conditioning</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="solar-days" className="small">Battery backup (nights)</label>
                  <select id="solar-days" value={sys.solar.autonomyDays} onChange={(ev) => setSys('solar', { ...sys.solar, autonomyDays: Number(ev.target.value) })}>
                    <option value={0.5}>Half a night</option><option value={1}>One night</option><option value={2}>Two nights</option>
                  </select>
                </div>
              </div>
            )}
          </fieldset>

          <p className="stat-row"><span><strong>{fmtNum(e.dailyKwh)}</strong> kWh a day</span><span><strong>{fmtNum(e.peakKw)}</strong> kW peak</span><span><strong>{fmtNum(e.surgeKw)}</strong> kW largest surge</span><span><strong>{e.generatorKva}</strong> kVA generator for backup</span></p>
          {e.solar && (
            <div className="solar-card card-inset">
              <p className="stat-row"><span><strong>{e.solar.arrayKwp} kWp</strong> array ({e.solar.panels} panels)</span><span><strong>{e.solar.batteryUsableKwh} kWh</strong> usable battery ({e.solar.batteryNominalKwh} kWh nominal, {e.solar.batteryAh} Ah at 48 V)</span><span><strong>{e.solar.inverterKw} kW</strong> inverter</span></p>
              <p className="small muted">The array makes about {e.solar.dailyYieldKwh} kWh on an average day for the {e.solar.coveredKwh} kWh it covers.</p>
            </div>
          )}
          <details className="checklist">
            <summary><strong>Load schedule</strong> <span className="small muted">{loads.length} items{sys.loads ? ' · edited by you' : ' · suggested from your design'}</span></summary>
            <div className="table-wrap">
              <table className="table small loads">
                <caption className="sr-only">Appliances and how long they run</caption>
                <thead><tr><th scope="col">Appliance</th><th scope="col">Type</th><th scope="col">Watts</th><th scope="col">Qty</th><th scope="col">Hours/day</th><th scope="col"><span className="sr-only">Remove</span></th></tr></thead>
                <tbody>{loads.map((l, i) => (
                  <tr key={l.id}>
                    <td><input aria-label="Appliance" value={l.name} onChange={(ev) => editLoad(i, { name: ev.target.value })} /></td>
                    <td><select aria-label={`Type of ${l.name}`} value={l.category} onChange={(ev) => editLoad(i, { category: ev.target.value as LoadCategory })}>{(Object.keys(CATS) as LoadCategory[]).map((k) => <option key={k} value={k}>{CATS[k]}</option>)}</select></td>
                    <td><input aria-label={`Watts of ${l.name}`} className="num" type="number" min={0} value={l.watts} onChange={(ev) => editLoad(i, { watts: Math.max(0, Number(ev.target.value)) })} /></td>
                    <td><input aria-label={`Quantity of ${l.name}`} className="num" type="number" min={0} value={l.qty} onChange={(ev) => editLoad(i, { qty: Math.max(0, Number(ev.target.value)) })} /></td>
                    <td><input aria-label={`Hours a day for ${l.name}`} className="num" type="number" min={0} max={24} step={0.5} value={l.hoursPerDay} onChange={(ev) => editLoad(i, { hoursPerDay: Math.min(24, Math.max(0, Number(ev.target.value))) })} /></td>
                    <td><button type="button" className="btn btn-small btn-ghost" aria-label={`Remove ${l.name}`} onClick={() => setLoads(loads.filter((_, k) => k !== i))}><Trash2 size={14} aria-hidden="true" /></button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="row wrap">
              <button type="button" className="btn btn-small" onClick={() => setLoads([...loads, { id: `custom-${Date.now().toString(36)}`, name: 'New appliance', category: 'comfort', watts: 100, qty: 1, hoursPerDay: 2, surgeFactor: 1 }])}><Plus size={14} aria-hidden="true" /> Add an appliance</button>
              {sys.loads && <button type="button" className="btn btn-small btn-ghost" onClick={() => setSys('loads', null)}><RotateCcw size={14} aria-hidden="true" /> Back to the suggested list</button>}
            </div>
          </details>
          <details className="checklist">
            <summary><strong>Load management</strong></summary>
            <ul className="small">{e.management.map((m) => <li key={m}>{m}</li>)}</ul>
          </details>
          <Working calc={plans.energy} />
        </section>
      )}

      <div className="row wrap">
        <button type="button" className={`btn${confirmed ? '' : ' btn-primary'}`} onClick={onConfirm}><Check size={16} aria-hidden="true" /> {confirmed ? 'Systems confirmed (confirm again after changes)' : 'Confirm these systems'}</button>
      </div>
      <Nav onBack={onBack} onNext={onNext} next="Plan the budget" />
    </div>
  );
}
