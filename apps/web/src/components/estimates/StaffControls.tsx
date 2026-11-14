'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { SOURCE_CLASSES, SOURCE_LABELS } from '@bw/domain';
import { call, errorText } from '@/lib/client';
import { dateText } from '@/lib/format';

function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string>) => {
    setBusy(true); setMsg(null);
    try { setMsg({ ok: true, text: await fn() }); router.refresh(); } catch (e) { setMsg({ ok: false, text: errorText(e) }); } finally { setBusy(false); }
  };
  const status = <div role="status" aria-live="polite">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>;
  return { busy, run, status };
}

export function AssignReviewer({ versionId, kind, reviewers, selfId }: { versionId: string | null; kind: 'primary' | 'second'; reviewers: { id: string; name: string; activeAssignments: number }[]; selfId: string | null }) {
  const a = useRun();
  const idBase = `${kind}-${versionId ?? 'any'}`;
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      void a.run(async () => {
        await call('/v1/review/assignments', { body: { versionId: versionId ?? String(f.get('versionId')).trim(), reviewerUserId: String(f.get('reviewer')), kind } });
        return kind === 'primary' ? 'Assigned. The estimate is now under review.' : 'Second reviewer assigned.';
      });
    }}>
      <div className="row">
        {!versionId && <div><label htmlFor={`v-${idBase}`}>Estimate version id</label><input id={`v-${idBase}`} name="versionId" required pattern="[0-9a-f-]{36}" /></div>}
        <div>
          <label htmlFor={`r-${idBase}`}>{kind === 'primary' ? 'Reviewer' : 'Second reviewer'}</label>
          <select id={`r-${idBase}`} name="reviewer" required defaultValue={selfId ?? ''}>
            <option value="" disabled>Choose a reviewer</option>
            {reviewers.map((r) => <option key={r.id} value={r.id}>{r.name}{r.id === selfId ? ' (you)' : ''} — {r.activeAssignments} active</option>)}
          </select>
        </div>
      </div>
      <button className="btn btn-small btn-primary" type="submit" disabled={a.busy || reviewers.length === 0}>{kind === 'primary' ? 'Assign' : 'Assign second reviewer'}</button>
      {reviewers.length === 0 && <p className="small muted" style={{ margin: 0 }}>No staff reviewers yet.</p>}
      {a.status}
    </form>
  );
}

export function CreateCatalogItem({ sections }: { sections: { code: string; label: string }[] }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
      void a.run(async () => { await call('/v1/admin/catalog-items', { body: { code: f.code, name: f.name, section: f.section, unit: f.unit, rateCategory: f.rateCategory, specification: f.specification || undefined } }); return 'Catalog item created.'; });
    }}>
      <div className="row">
        <div><label htmlFor="ci-code">Code <span className="hint">Lower case, numbers and dashes</span></label><input id="ci-code" name="code" required pattern="[a-z0-9-]{2,40}" /></div>
        <div style={{ flex: '2 1 240px' }}><label htmlFor="ci-name">Name</label><input id="ci-name" name="name" required minLength={2} maxLength={160} /></div>
      </div>
      <div className="row">
        <div><label htmlFor="ci-sec">Work section</label><select id="ci-sec" name="section">{sections.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}</select></div>
        <div><label htmlFor="ci-unit">Unit</label><select id="ci-unit" name="unit">{['m2', 'm', 'm3', 'piece', 'kg', 'tonne', 'bag', 'trip', 'litre', 'day', 'hour', 'job'].map((u) => <option key={u} value={u}>{u}</option>)}</select></div>
        <div><label htmlFor="ci-cat">Rate category <span className="hint">Sets how long a rate stays fresh</span></label><select id="ci-cat" name="rateCategory"><option value="general">General materials</option><option value="volatile">Volatile (cement, steel, fuel)</option><option value="labour">Labour</option></select></div>
      </div>
      <div><label htmlFor="ci-spec">Specification <span className="hint">Optional</span></label><input id="ci-spec" name="specification" maxLength={300} /></div>
      <button className="btn btn-small btn-primary" type="submit" disabled={a.busy}>Create item</button>
      {a.status}
    </form>
  );
}

export function RecordRate({ items, regions }: { items: { id: string; name: string; unit: string }[]; regions: { code: string; label: string }[] }) {
  const a = useRun();
  const today = new Date().toISOString().slice(0, 10);
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const s = (k: string) => String(f.get(k) ?? '');
      void a.run(async () => {
        await call('/v1/admin/rate-observations', { body: { catalogItemId: s('item'), regionCode: s('region'), sourceClass: s('source'), rate: s('rate'), observedAt: s('observedAt'), validUntil: s('validUntil') || undefined, includesDelivery: f.get('delivery') === 'on', includesTax: f.get('tax') === 'on', reference: s('reference') } });
        return 'Rate recorded.';
      });
    }}>
      <div className="row">
        <div style={{ flex: '2 1 240px' }}><label htmlFor="ro-item">Catalog item</label><select id="ro-item" name="item" required>{items.map((i) => <option key={i.id} value={i.id}>{i.name} (per {i.unit})</option>)}</select></div>
        <div><label htmlFor="ro-region">Region</label><select id="ro-region" name="region">{regions.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></div>
      </div>
      <div className="row">
        <div><label htmlFor="ro-src">Source class</label><select id="ro-src" name="source" defaultValue="professional_rate_book">{SOURCE_CLASSES.map((c) => <option key={c} value={c}>{SOURCE_LABELS[c]}</option>)}</select></div>
        <div><label htmlFor="ro-rate">Rate per unit</label><input id="ro-rate" name="rate" inputMode="decimal" required /></div>
        <div><label htmlFor="ro-obs">Observed on</label><input id="ro-obs" name="observedAt" type="date" required max={today} defaultValue={today} /></div>
        <div><label htmlFor="ro-valid">Valid until <span className="hint">Optional</span></label><input id="ro-valid" name="validUntil" type="date" /></div>
      </div>
      <div className="inline">
        <label className="check"><input type="checkbox" name="delivery" /> Includes delivery</label>
        <label className="check"><input type="checkbox" name="tax" /> Includes tax</label>
      </div>
      <div><label htmlFor="ro-ref">Reference <span className="hint">Quote number, rate book page, supplier name</span></label><input id="ro-ref" name="reference" required minLength={3} maxLength={300} /></div>
      <button className="btn btn-small btn-primary" type="submit" disabled={a.busy || items.length === 0}>Record rate</button>
      {a.status}
    </form>
  );
}

export function ImportFromListings({ items, categories }: { items: { id: string; name: string; unit: string }[]; categories: { slug: string; name: string }[] }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      void a.run(async () => {
        const r = await call<{ considered: number; added: number }>('/v1/admin/rate-observations/from-listings', { body: { catalogItemId: String(f.get('item')), categorySlug: String(f.get('category')) } });
        return `Checked ${r.considered} live listing(s); added ${r.added} advertised price observation(s).`;
      });
    }}>
      <p className="small muted" style={{ margin: 0 }}>Uses live listings with a recently confirmed price whose unit matches the item (or converts by pack size). Recorded as “advertised listing price”, the lowest-but-one source class.</p>
      <div className="row">
        <div><label htmlFor="il-item">Catalog item</label><select id="il-item" name="item">{items.map((i) => <option key={i.id} value={i.id}>{i.name} (per {i.unit})</option>)}</select></div>
        <div><label htmlFor="il-cat">Listing category</label><select id="il-cat" name="category">{categories.map((c) => <option key={c.slug} value={c.slug}>{c.name}</option>)}</select></div>
      </div>
      <button className="btn btn-small" type="submit" disabled={a.busy || items.length === 0}>Import prices</button>
      {a.status}
    </form>
  );
}

interface Obs { id: string; region: string; unit: string; sourceClass: string; sourceLabel: string; rate: { display: string }; observedAt: string; validUntil: string | null; fresh: boolean; includesDelivery: boolean; includesTax: boolean; reference: string }

export function RatesList({ itemId, name }: { itemId: string; name: string }) {
  const [obs, setObs] = useState<Obs[] | null>(null);
  const [err, setErr] = useState('');
  return (
    <details onToggle={async (e) => {
      if (!(e.target as HTMLDetailsElement).open || obs) return;
      try { setObs((await call<{ observations: Obs[] }>(`/v1/catalog/${itemId}/rates`)).observations); } catch (x) { setErr(errorText(x)); }
    }}>
      <summary>Rates for {name}</summary>
      {err && <p role="alert" className="small">{err}</p>}
      {!obs ? !err && <p className="small muted" role="status">Loading…</p> : obs.length === 0 ? <p className="small muted">No rates recorded.</p> : (
        <div className="table-wrap">
          <table className="small">
            <caption className="sr-only">Rate observations for {name}</caption>
            <thead><tr><th scope="col">Source</th><th scope="col">Region</th><th scope="col" className="num">Rate</th><th scope="col">Observed</th><th scope="col">Freshness</th><th scope="col">Reference</th></tr></thead>
            <tbody>{obs.map((o) => (
              <tr key={o.id}>
                <td>{o.sourceLabel}</td><td>{o.region}</td>
                <td className="num">{o.rate.display}<div className="muted">{o.includesDelivery ? 'incl. delivery' : 'excl. delivery'}, {o.includesTax ? 'incl. tax' : 'excl. tax'}</div></td>
                <td>{dateText(o.observedAt)}{o.validUntil ? <div className="muted">valid to {dateText(o.validUntil)}</div> : null}</td>
                <td><span className={`pill ${o.fresh ? 'pill-good' : 'pill-bad'}`}>{o.fresh ? 'Current' : 'Stale'}</span></td>
                <td>{o.reference}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </details>
  );
}

export function RecordQualification({ reviewers, classes }: { reviewers: { id: string; name: string }[]; classes: { code: string; label: string }[] }) {
  const a = useRun();
  return (
    <form className="stack-sm" onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      const s = (k: string) => String(f.get(k) ?? '');
      void a.run(async () => { await call('/v1/admin/reviewer-qualifications', { body: { userId: s('user'), classCode: s('class'), credential: s('credential'), validUntil: s('validUntil') || undefined } }); return 'Qualification recorded.'; });
    }}>
      <div className="row">
        <div><label htmlFor="rq-user">Reviewer</label><select id="rq-user" name="user" required>{reviewers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
        <div><label htmlFor="rq-class">Project class</label><select id="rq-class" name="class">{classes.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}</select></div>
        <div><label htmlFor="rq-valid">Valid until <span className="hint">Optional</span></label><input id="rq-valid" name="validUntil" type="date" /></div>
      </div>
      <div><label htmlFor="rq-cred">Credential and how it was checked</label><input id="rq-cred" name="credential" required minLength={3} maxLength={200} placeholder="e.g. Registered QS no. …, checked against the register on …" /></div>
      <button className="btn btn-small btn-primary" type="submit" disabled={a.busy || reviewers.length === 0}>Record qualification</button>
      {a.status}
    </form>
  );
}
