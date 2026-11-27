import type { Metadata } from 'next';
import { dateText } from '@/lib/format';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Liquidity' };

function Cells({ id, title, cells, target }: { id: string; title: string; cells: any[]; target: number }) {
  return (
    <section className="stack-sm" aria-labelledby={id}>
      <h2 id={id} style={{ fontSize: '1.1rem', margin: 0 }}>{title}</h2>
      {cells.length === 0 ? <p className="small muted" style={{ margin: 0 }}>No published requests in this period.</p> : (
        <div className="table-wrap card" style={{ padding: 0 }}>
          <table className="small">
            <caption className="sr-only">{title}</caption>
            <thead><tr><th scope="col">{title.replace('By ', '')}</th><th scope="col" className="num">Decided</th><th scope="col" className="num">Met</th><th scope="col" className="num">Still in window</th><th scope="col" className="num">Share met</th><th scope="col" className="num">Median comparable</th></tr></thead>
            <tbody>{cells.map((c) => (
              <tr key={c.key}>
                <th scope="row" style={{ fontWeight: 'normal' }}>{c.label}</th>
                <td className="num">{c.decided}</td><td className="num">{c.met}</td><td className="num">{c.pending}</td>
                <td className="num">{c.sharePct == null ? <span className="muted">too few</span> : <span className={`pill ${c.sharePct >= target ? 'pill-good' : 'pill-warn'}`}>{c.sharePct}%</span>}</td>
                <td className="num">{c.medianComparable ?? '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** The Release 3 exit gate (§25): ≥ 3 comparable responses within 72 h in ≥ 80% of requests for quotes. */
export default async function Liquidity({ searchParams }: { searchParams: Promise<{ weeks?: string }> }) {
  const weeks = Number((await searchParams).weeks) || undefined;
  const r = await api<any>(`/v1/moderation/liquidity${weeks ? `?weeks=${weeks}` : ''}`);
  const d = r.data;
  const cfg = d.config;
  return (
    <div className="stack">
      <h1 style={{ margin: 0 }}>Liquidity</h1>
      <section className={`card stack-sm notice ${d.gate.met ? 'notice-good' : ''}`} aria-label="Exit gate">
        <strong>Release 3 exit gate: {d.gate.met ? 'met' : 'not met yet'}</strong>
        <p style={{ margin: 0 }}>{d.gate.text}</p>
        <p className="small muted" style={{ margin: 0 }}>Last {d.weeks} weeks · {d.overall.decided} decided, {d.overall.pending} still inside their {cfg.windowHours}-hour window. {d.notice}</p>
      </section>
      <Cells id="lq-cat" title="By category" cells={d.byCategory} target={cfg.targetPct} />
      <Cells id="lq-area" title="By area" cells={d.byArea} target={cfg.targetPct} />
      <Cells id="lq-week" title="By week published" cells={d.byWeek} target={cfg.targetPct} />
      <section className="stack-sm" aria-labelledby="lq-recent">
        <h2 id="lq-recent" style={{ fontSize: '1.1rem', margin: 0 }}>Recent requests</h2>
        {d.recent.length === 0 ? <p className="small muted" style={{ margin: 0 }}>None yet.</p> : (
          <div className="table-wrap card" style={{ padding: 0 }}>
            <table className="small">
              <caption className="sr-only">Recent requests for quotes and their comparable responses</caption>
              <thead><tr><th scope="col">Published</th><th scope="col">Category</th><th scope="col">Area</th><th scope="col" className="num">Responses</th><th scope="col" className="num">Comparable</th><th scope="col">Result</th></tr></thead>
              <tbody>{d.recent.map((x: any) => (
                <tr key={x.id}><td>{dateText(x.publishedAt)}</td><td>{x.category}</td><td>{x.area}</td><td className="num">{x.responses}</td><td className="num">{x.comparable}</td>
                  <td>{x.met === true ? `Met in ${x.hoursToTarget} h` : x.met === false ? 'Missed' : `Open until ${dateText(x.windowEndsAt)}`}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
