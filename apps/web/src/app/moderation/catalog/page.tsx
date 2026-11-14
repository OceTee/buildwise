import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CreateCatalogItem, ImportFromListings, RatesList, RecordRate } from '@/components/estimates/StaffControls';
import { loadProjectConfig } from '@/lib/projects';
import { api, getCategories, getMarket, getMe } from '@/lib/server';

export const metadata: Metadata = { title: 'Catalog and rates' };

interface Item { id: string; code: string; name: string; section: string; unit: string; rateCategory: string; specification: string | null; observations: number }

export default async function Catalog() {
  const me = await getMe();
  if (!me || !['qs_reviewer', 'ops_admin'].includes(me.staffRole ?? '')) notFound();
  const [items, cfg, market, categories] = await Promise.all([api<{ items: Item[] }>('/v1/catalog'), loadProjectConfig(), getMarket(), getCategories()]);
  const list = items.data.items ?? [];
  const sectionLabel = (c: string) => cfg.workSections.find((w) => w.code === c)?.label ?? c;
  const regions = market.regions.map((r) => ({ code: r.code, label: r.label }));
  const leafCats = categories.filter((c) => !categories.some((x) => x.parent === c.slug)).map((c) => ({ slug: c.slug, name: c.name }));
  return (
    <>
      <h1>Catalog and rates</h1>
      <p className="small muted">Rates rank by source class: supplier-confirmed quote, recent marketplace offer, historical actual, professional rate book, published dataset, advertised listing price, modelled benchmark, manual estimate. Each rate goes stale after its category's freshness window; stale rates block issue unless a reviewer reconfirms them.</p>

      <section aria-labelledby="items-h" className="stack-sm">
        <h2 id="items-h">Items ({list.length})</h2>
        {list.length === 0 ? <p className="muted">No catalog items yet.</p> : (
          <ul className="plain stack-sm">
            {list.map((i) => (
              <li key={i.id} className="card stack-sm">
                <div><strong>{i.name}</strong> <span className="small muted">{i.code} · {sectionLabel(i.section)} · per {i.unit} · {i.rateCategory} · {i.observations} rate(s)</span></div>
                {i.specification && <div className="small">{i.specification}</div>}
                <RatesList itemId={i.id} name={i.name} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="rate-h" className="card stack-sm">
        <h2 id="rate-h" style={{ margin: 0 }}>Record a rate</h2>
        <RecordRate items={list.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))} regions={regions} />
      </section>

      <section aria-labelledby="imp-h" className="card stack-sm">
        <h2 id="imp-h" style={{ margin: 0 }}>Import advertised prices from listings</h2>
        <ImportFromListings items={list.map((i) => ({ id: i.id, name: i.name, unit: i.unit }))} categories={leafCats} />
      </section>

      {me.staffRole === 'ops_admin' && (
        <section aria-labelledby="new-h" className="card stack-sm">
          <h2 id="new-h" style={{ margin: 0 }}>New catalog item</h2>
          <CreateCatalogItem sections={cfg.workSections} />
        </section>
      )}
    </>
  );
}
