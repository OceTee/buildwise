import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CreateEstimate } from '@/components/estimates/CreateEstimate';
import { IndicativeCard } from '@/components/estimates/Display';
import { statePill, type Indicative, type Money } from '@/components/estimates/types';
import { dateText } from '@/lib/format';
import { canDo, loadProject } from '@/lib/projects';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Estimates' };

interface Item { id: string; title: string; maturity: string; label: string; versionId: string; number: number; state: string; gross: Money | null; indicative: Indicative | null; validUntil: string | null; issuedAt: string | null }

export default async function Estimates({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const p = await loadProject(id);
  if (!p) notFound();
  const r = await api<{ items: Item[] }>(`/v1/projects/${id}/estimates`);
  const items = r.data.items ?? [];
  const latestIndicative = items.find((e) => e.maturity === 'indicative' && e.state === 'generated');
  const others = items.filter((e) => e.maturity !== 'indicative');
  const write = !p.viaStaffSession;
  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Estimates</h1>
      <div className="notice small">
        <strong>Three kinds of estimate.</strong> An <em>indicative range</em> uses local benchmarks for early planning. A <em>client-specified</em> estimate holds quantities you or your own professional enter; it is labelled as not reviewed. A <em>professionally reviewed</em> estimate is measured and priced from your drawings by a named, qualified reviewer.
      </div>

      {latestIndicative?.indicative && <IndicativeCard i={latestIndicative.indicative} projectId={id} />}

      <section aria-labelledby="list-h" className="stack-sm">
        <h2 id="list-h">Your estimates</h2>
        {others.length === 0 ? <p className="muted">No estimates yet.</p> : (
          <div className="table-wrap card" style={{ padding: 0 }}>
            <table>
              <caption className="sr-only">Estimates for this project</caption>
              <thead><tr><th scope="col">Estimate</th><th scope="col">Type</th><th scope="col">Version</th><th scope="col">Status</th><th scope="col" className="num">Total (incl. tax)</th></tr></thead>
              <tbody>
                {others.map((e) => {
                  const s = statePill(e.state);
                  return (
                    <tr key={e.id}>
                      <td><Link href={`/projects/${id}/estimates/${e.id}`}>{e.title}</Link>{e.validUntil && <div className="small muted">Valid until {dateText(e.validUntil)}</div>}</td>
                      <td>{e.label}</td>
                      <td>{e.number}</td>
                      <td><span className={`pill ${s.cls}`}>{s.label}</span></td>
                      <td className="num">{e.gross?.display ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {write && (canDo(p, 'estimate.edit_client') || canDo(p, 'estimate.request_review')) && (
        <CreateEstimate projectId={id} canIndicative={canDo(p, 'estimate.edit_client')} canClient={canDo(p, 'estimate.edit_client')} canReviewed={canDo(p, 'estimate.request_review')}
          indicativeReady={p.indicative.ok} indicativeMessage={p.indicative.ok ? null : p.indicative.message} readiness={p.readiness} />
      )}
    </div>
  );
}
