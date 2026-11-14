import type { Metadata } from 'next';
import { api } from '@/lib/server';

export const metadata: Metadata = { title: 'Audit log' };

export default async function Audit({ searchParams }: { searchParams: Promise<{ target?: string }> }) {
  const { target } = await searchParams;
  const r = await api<{ items: any[] }>(`/v1/moderation/audit${target ? `?targetId=${encodeURIComponent(target)}` : ''}`);
  return (
    <>
      <h1>Audit log</h1>
      <form className="inline" action="/moderation/audit">
        <label htmlFor="at" className="sr-only">Filter by target id</label>
        <input id="at" name="target" defaultValue={target ?? ''} placeholder="Target id" style={{ maxWidth: '24rem' }} />
        <button className="btn btn-small" type="submit">Filter</button>
      </form>
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table>
          <caption className="sr-only">Audit events, newest first</caption>
          <thead><tr><th scope="col">#</th><th scope="col">When</th><th scope="col">Who</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Reason</th></tr></thead>
          <tbody>
            {r.data.items.map((a) => (
              <tr key={a.seq}>
                <td>{a.seq}</td><td className="small">{new Date(a.at).toLocaleString('en-GB')}</td><td>{a.actor ?? 'system'}</td><td>{a.action}</td>
                <td className="small">{a.targetType} <a href={`/moderation/audit?target=${a.targetId}`}>{String(a.targetId).slice(0, 8)}…</a></td><td className="small">{a.reason ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
