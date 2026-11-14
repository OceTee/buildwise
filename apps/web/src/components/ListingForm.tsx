'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ApiFailure, call, errorText, newKey } from '@/lib/client';

interface Attr { key: string; label: string; type: 'text' | 'enum' | 'number' | 'boolean' | 'pack_size'; required?: boolean; options?: { value: string; label: string }[]; max?: number; packUnits?: string[] }
interface Cat { slug: string; parent: string | null; name: string; listingType: string; priceUnits: string[]; minPhotos: number; attributes: Attr[] }
interface Photo { id: string; alt: string; url: string }
interface Org { id: string; name: string; kind: string; role: string }
interface Area { code: string; label: string }

export interface ListingInitial {
  id: string; version: number; status: string; categorySlug: string; title: string; description: string; attributes: Record<string, any>;
  price: { amountMinor: string } | null; unit: string; negotiable: boolean; quoteOnRequest: boolean; areaCode: string; serviceAreas: string[];
  photos: { id: string; alt: string | null; urls: { thumb: string } }[];
}

const UNIT_LABELS: Record<string, string> = { m2: 'm²', m3: 'm³' };
const DRAFT_KEY = 'bw:draft:new-listing';

function majorFromMinor(minor: string | undefined) {
  if (!minor) return '';
  const n = BigInt(minor);
  return (n % 100n === 0n) ? String(n / 100n) : `${n / 100n}.${String(n % 100n).padStart(2, '0')}`;
}

export function ListingForm({ categories, orgs, regions, initial }: { categories: Cat[]; orgs: Org[]; regions: { code: string; label: string; areas: Area[] }[]; initial?: ListingInitial }) {
  const leaves = useMemo(() => categories.filter((c) => !categories.some((x) => x.parent === c.slug)), [categories]);
  const editing = !!initial;
  const [orgId, setOrgId] = useState(orgs.find((o) => o.kind === 'business')?.id ?? orgs[0]?.id ?? '');
  const [categorySlug, setCategory] = useState(initial?.categorySlug ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [attrs, setAttrs] = useState<Record<string, any>>(initial?.attributes ?? {});
  const [price, setPrice] = useState(majorFromMinor(initial?.price?.amountMinor));
  const [unit, setUnit] = useState(initial?.unit ?? '');
  const [negotiable, setNegotiable] = useState(initial?.negotiable ?? false);
  const [quote, setQuote] = useState(initial?.quoteOnRequest ?? false);
  const [areaCode, setArea] = useState(initial?.areaCode ?? '');
  const [serviceAreas, setServiceAreas] = useState<string[]>(initial?.serviceAreas ?? []);
  const [photos, setPhotos] = useState<Photo[]>(initial?.photos.map((p) => ({ id: p.id, alt: p.alt ?? '', url: p.urls.thumb })) ?? []);
  const [uploading, setUploading] = useState(0);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [problem, setProblem] = useState<{ title: string; items: string[] } | null>(null);
  const [result, setResult] = useState<{ status: string; id: string } | null>(null);
  const [draftNote, setDraftNote] = useState('');

  const cat = leaves.find((c) => c.slug === categorySlug);
  const isService = !!cat && cat.listingType !== 'product';

  // Offline-friendly draft: the form is kept in this browser until the listing is created (spec §3.4).
  useEffect(() => {
    if (editing) return;
    try {
      const raw = localStorage.getItem(DRAFT_KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      setCategory(d.categorySlug ?? ''); setTitle(d.title ?? ''); setDescription(d.description ?? ''); setAttrs(d.attrs ?? {}); setPrice(d.price ?? '');
      setUnit(d.unit ?? ''); setNegotiable(!!d.negotiable); setQuote(!!d.quote); setArea(d.areaCode ?? ''); setServiceAreas(d.serviceAreas ?? []); setPhotos(d.photos ?? []);
      setDraftNote('We restored the ad you started earlier on this device.');
    } catch { /* storage unavailable */ }
  }, [editing]);
  useEffect(() => {
    if (editing || result) return;
    const t = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ categorySlug, title, description, attrs, price, unit, negotiable, quote, areaCode, serviceAreas, photos })); } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [editing, result, categorySlug, title, description, attrs, price, unit, negotiable, quote, areaCode, serviceAreas, photos]);

  useEffect(() => { if (cat && !cat.priceUnits.includes(unit)) setUnit(cat.priceUnits[0] ?? ''); }, [cat, unit]);

  async function upload(files: FileList | null) {
    if (!files) return;
    for (const f of Array.from(files).slice(0, 10 - photos.length)) {
      setUploading((n) => n + 1);
      try {
        const r = await call<{ id: string; urls: { thumb: string } }>(`/v1/photos?orgId=${orgId}`, { raw: f });
        setPhotos((p) => [...p, { id: r.id, alt: '', url: r.urls.thumb }]);
      } catch (e) { setErrors((x) => ({ ...x, photos: `${f.name}: ${errorText(e)}` })); }
      finally { setUploading((n) => n - 1); }
    }
  }

  function body() {
    const attributes: Record<string, unknown> = {};
    for (const a of cat?.attributes ?? []) {
      const v = attrs[a.key];
      if (v === undefined || v === '' || v === null) continue;
      if (a.type === 'number') attributes[a.key] = Number(v);
      else if (a.type === 'boolean') attributes[a.key] = !!v;
      else if (a.type === 'pack_size') { if (v.value) attributes[a.key] = { value: Number(v.value), unit: v.unit ?? a.packUnits?.[0] }; }
      else attributes[a.key] = v;
    }
    return {
      categorySlug, title, description, attributes, price: quote ? null : price, unit, negotiable, quoteOnRequest: quote, areaCode,
      serviceAreas: isService ? serviceAreas : [], photoIds: photos.map((p) => p.id), photoAlts: Object.fromEntries(photos.filter((p) => p.alt).map((p) => [p.id, p.alt])),
    };
  }

  function showFailure(e: unknown) {
    if (e instanceof ApiFailure) {
      if (e.fieldErrors.length) {
        setErrors(Object.fromEntries(e.fieldErrors.map((f) => [f.path.replace(/^attributes\./, 'attr.'), f.message])));
        setProblem({ title: 'Check the highlighted fields.', items: e.fieldErrors.map((f) => f.message) });
      } else if (e.code === 'SUBMISSION_BLOCKED') {
        setProblem({ title: e.message, items: (e.details?.blocking ?? []).map((b: { message: string }) => b.message) });
      } else setProblem({ title: e.message, items: [] });
    } else {
      setProblem({ title: navigator.onLine ? 'Something went wrong. Try again.' : 'You are offline. Your ad is saved on this device; submit it when you are back online.', items: [] });
    }
    setTimeout(() => document.getElementById('form-problem')?.focus(), 0);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErrors({}); setProblem(null);
    try {
      let id = initial?.id; let version = initial?.version ?? 1; let status = initial?.status ?? 'draft';
      if (editing) {
        const r = await call(`/v1/listings/${id}`, { method: 'PATCH', body: { ...body(), expectedVersion: version } });
        version = r.listing.version; status = r.listing.status;
      } else {
        const r = await call('/v1/listings', { body: { ...body(), orgId }, idempotencyKey: newKey() });
        id = r.id; version = r.version; status = r.status;
      }
      const cmd = status === 'draft' ? 'submit' : status === 'rejected' ? 'resubmit' : null;
      if (cmd) {
        try {
          const s = await call(`/v1/listings/${id}/${cmd}`, { body: { expectedVersion: version } });
          status = s.listing.status;
        } catch (err) { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } setResult({ status: 'draft', id: id! }); showFailure(err); return; }
      }
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      setResult({ status, id: id! });
      setTimeout(() => document.getElementById('form-result')?.focus(), 0);
    } catch (err) { showFailure(err); } finally { setBusy(false); }
  }

  const fieldProps = (name: string) => ({ 'aria-invalid': !!errors[name] || undefined, 'aria-describedby': errors[name] ? `${name}-err` : undefined });
  const err = (name: string) => errors[name] ? <div id={`${name}-err`} className="field-error">{errors[name]}</div> : null;

  if (result && !problem) {
    return (
      <div id="form-result" tabIndex={-1} className={`notice ${result.status === 'live' ? 'notice-good' : ''}`} role="status">
        {result.status === 'live' && <p><strong>Your ad is live.</strong></p>}
        {result.status === 'in_review' && <p><strong>Your ad is with our reviewers.</strong> New sellers' ads are checked by a person, usually within a working day. We will notify you.</p>}
        {result.status !== 'live' && result.status !== 'in_review' && <p><strong>Saved.</strong></p>}
        <div className="inline"><Link className="btn" href="/my-ads">Go to My ads</Link>{!editing && <a className="btn" href="/post">Post another</a>}</div>
      </div>
    );
  }

  return (
    <form onSubmit={save} noValidate className="stack" aria-describedby={draftNote ? 'draft-note' : undefined}>
      {draftNote && <p id="draft-note" className="notice small">{draftNote} <button type="button" className="linkish" onClick={() => { try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ } window.location.reload(); }}>Start again</button></p>}
      {problem && (
        <div id="form-problem" tabIndex={-1} role="alert" className="notice notice-bad">
          <strong>{problem.title}</strong>
          {problem.items.length > 0 && <ul style={{ margin: '.5rem 0 0' }}>{problem.items.map((i) => <li key={i}>{i}</li>)}</ul>}
          {result && <p className="small" style={{ margin: '.5rem 0 0' }}>Your ad was saved as a draft. Fix the above, then submit it from <Link href="/my-ads">My ads</Link>.</p>}
        </div>
      )}

      <fieldset>
        <legend>What are you listing?</legend>
        {!editing && orgs.length > 1 && (
          <div className="field">
            <label htmlFor="org">Post as</label>
            <select id="org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}{o.kind === 'personal' ? ' (personal)' : ''}</option>)}</select>
          </div>
        )}
        <div className="field">
          <label htmlFor="cat">Category</label>
          <select id="cat" required value={categorySlug} onChange={(e) => { setCategory(e.target.value); setAttrs({}); }} {...fieldProps('categorySlug')}>
            <option value="" disabled>Choose a category</option>
            {leaves.map((c) => <option key={c.slug} value={c.slug}>{c.parent ? `${categories.find((p) => p.slug === c.parent)?.name} › ` : ''}{c.name}</option>)}
          </select>
          {err('categorySlug')}
        </div>
        <div className="field">
          <label htmlFor="title">Title <span className="hint">Say exactly what it is, e.g. “Portland cement 42.5, 50 kg bags”</span></label>
          <input id="title" required minLength={5} maxLength={90} value={title} onChange={(e) => setTitle(e.target.value)} {...fieldProps('title')} />
          {err('title')}
        </div>
        <div className="field">
          <label htmlFor="desc">Description <span className="hint">Condition, quantities, delivery, what is included. Don't put phone numbers or payment details here.</span></label>
          <textarea id="desc" maxLength={4000} value={description} onChange={(e) => setDescription(e.target.value)} {...fieldProps('description')} />
          {err('description')}
        </div>
      </fieldset>

      {cat && cat.attributes.length > 0 && (
        <fieldset>
          <legend>Details</legend>
          <div className="row">
            {cat.attributes.map((a) => {
              const id = `attr-${a.key}`; const name = `attr.${a.key}`;
              const label = <label htmlFor={id}>{a.label}{!a.required && <span className="hint">Optional</span>}</label>;
              if (a.type === 'boolean') return <div key={a.key} className="field"><label className="check"><input id={id} type="checkbox" checked={!!attrs[a.key]} onChange={(e) => setAttrs({ ...attrs, [a.key]: e.target.checked })} /> {a.label}</label>{err(name)}</div>;
              if (a.type === 'enum') return <div key={a.key} className="field">{label}<select id={id} value={attrs[a.key] ?? ''} onChange={(e) => setAttrs({ ...attrs, [a.key]: e.target.value })} {...fieldProps(name)}><option value="">Choose</option>{a.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>{err(name)}</div>;
              if (a.type === 'pack_size') {
                const v = attrs[a.key] ?? {};
                return (
                  <div key={a.key} className="field">
                    <label htmlFor={id}>{a.label} <span className="hint">Lets buyers compare per {a.packUnits?.[0]}</span></label>
                    <div className="inline">
                      <input id={id} inputMode="decimal" style={{ flex: 1 }} value={v.value ?? ''} onChange={(e) => setAttrs({ ...attrs, [a.key]: { ...v, value: e.target.value } })} {...fieldProps(name)} />
                      <label htmlFor={`${id}-u`} className="sr-only">Pack unit</label>
                      <select id={`${id}-u`} style={{ width: '6rem' }} value={v.unit ?? a.packUnits?.[0]} onChange={(e) => setAttrs({ ...attrs, [a.key]: { ...v, unit: e.target.value } })}>{a.packUnits?.map((u) => <option key={u} value={u}>{u}</option>)}</select>
                    </div>
                    {err(name)}
                  </div>
                );
              }
              return <div key={a.key} className="field">{label}<input id={id} inputMode={a.type === 'number' ? 'decimal' : undefined} maxLength={a.type === 'text' ? a.max : undefined} value={attrs[a.key] ?? ''} onChange={(e) => setAttrs({ ...attrs, [a.key]: e.target.value })} {...fieldProps(name)} />{err(name)}</div>;
            })}
          </div>
        </fieldset>
      )}

      <fieldset>
        <legend>Price</legend>
        <label className="check field"><input type="checkbox" checked={quote} onChange={(e) => setQuote(e.target.checked)} /> Price on request (buyers ask for a quote)</label>
        <div className="row">
          {!quote && (
            <div className="field">
              <label htmlFor="price">Price</label>
              <input id="price" inputMode="decimal" required value={price} onChange={(e) => setPrice(e.target.value)} {...fieldProps('price')} />
              {err('price')}
            </div>
          )}
          <div className="field">
            <label htmlFor="unit">{quote ? 'Sold per' : 'Per'}</label>
            <select id="unit" value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!cat} {...fieldProps('unit')}>{cat?.priceUnits.map((u) => <option key={u} value={u}>{UNIT_LABELS[u] ?? u}</option>)}</select>
            {err('unit')}
          </div>
        </div>
        {!quote && <label className="check"><input type="checkbox" checked={negotiable} onChange={(e) => setNegotiable(e.target.checked)} /> Negotiable</label>}
      </fieldset>

      <fieldset>
        <legend>Location</legend>
        <div className="field">
          <label htmlFor="area">{isService ? 'Where you are based' : 'Where the item is'}</label>
          <select id="area" required value={areaCode} onChange={(e) => setArea(e.target.value)} {...fieldProps('areaCode')}>
            <option value="" disabled>Choose an area</option>
            {regions.map((r) => <optgroup key={r.code} label={r.label}>{r.areas.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}</optgroup>)}
          </select>
          {err('areaCode')}
        </div>
        {isService && (
          <fieldset style={{ marginBottom: 0 }}>
            <legend>Other areas you serve</legend>
            <div className="row">
              {regions.flatMap((r) => r.areas).filter((a) => a.code !== areaCode).map((a) => (
                <label key={a.code} className="check"><input type="checkbox" checked={serviceAreas.includes(a.code)} onChange={(e) => setServiceAreas(e.target.checked ? [...serviceAreas, a.code] : serviceAreas.filter((x) => x !== a.code))} /> {a.label}</label>
              ))}
            </div>
          </fieldset>
        )}
      </fieldset>

      <fieldset>
        <legend>Photos {cat ? <span className="hint">{cat.minPhotos > 0 ? `At least ${cat.minPhotos} required` : 'Optional'}, up to 10. Use your own photos.</span> : null}</legend>
        <ul className="plain row" style={{ marginBottom: '.75rem' }}>
          {photos.map((p, i) => (
            <li key={p.id} className="card" style={{ flex: '0 1 200px', padding: '.5rem' }}>
              <img src={p.url} alt="" width={180} height={135} style={{ width: '100%', height: 'auto', borderRadius: 6 }} />
              <label htmlFor={`alt-${p.id}`} className="small" style={{ marginTop: '.4rem' }}>Describe photo {i + 1}</label>
              <input id={`alt-${p.id}`} value={p.alt} maxLength={150} onChange={(e) => setPhotos(photos.map((x) => x.id === p.id ? { ...x, alt: e.target.value } : x))} />
              <div className="inline" style={{ marginTop: '.4rem' }}>
                {i > 0 && <button type="button" className="btn btn-small" onClick={() => { const n = [...photos]; [n[i - 1], n[i]] = [n[i]!, n[i - 1]!]; setPhotos(n); }}>Move first</button>}
                <button type="button" className="btn btn-small" onClick={() => setPhotos(photos.filter((x) => x.id !== p.id))} aria-label={`Remove photo ${i + 1}`}>Remove</button>
              </div>
            </li>
          ))}
        </ul>
        {photos.length < 10 && (
          <div className="field">
            <label htmlFor="photos">Add photos <span className="hint">JPEG, PNG or WebP, up to 10 MB each. Location data is removed.</span></label>
            <input id="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} {...fieldProps('photos')} />
          </div>
        )}
        <div role="status" className="small muted">{uploading > 0 ? `Uploading ${uploading} photo(s)…` : ''}</div>
        {err('photos')}
      </fieldset>

      <div className="inline">
        <button type="submit" className="btn btn-primary" disabled={busy || uploading > 0}>{editing ? (initial!.status === 'rejected' ? 'Save and resubmit' : 'Save changes') : 'Post ad'}</button>
        <span className="small muted">By posting you confirm you are allowed to sell this and that the photos are yours.</span>
      </div>
    </form>
  );
}
