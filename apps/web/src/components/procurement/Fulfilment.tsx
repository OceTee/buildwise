'use client';
import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoiceTotals, minorDigits, parseDec, parseMajor } from '@bw/domain';
import { call, errorText, newKey } from '@/lib/client';

/**
 * Fulfilment (R3 slice 2) on an order page, for both sides: delivery progress, booking, dispatch (consignments),
 * proof of delivery, inspection and discrepancies, returns, supplier invoices with the three-way match, and
 * record-only payments. What each side may do comes from the API (`commands`, `canManage`, ...).
 */

type F = any;

const DELIVERY_STATE: Record<string, { label: string; cls: string }> = {
  scheduled: { label: 'Booked', cls: '' }, dispatched: { label: 'On the way', cls: 'pill-warn' }, arrived: { label: 'Arrived on site', cls: 'pill-warn' },
  received: { label: 'Received, not inspected', cls: 'pill-warn' }, inspected_ok: { label: 'Inspected, accepted', cls: 'pill-good' },
  discrepancy_raised: { label: 'Discrepancy raised', cls: 'pill-bad' }, resolved: { label: 'Discrepancies resolved', cls: 'pill-good' }, cancelled: { label: 'Cancelled', cls: '' },
};
const DISC_STATE: Record<string, { label: string; cls: string }> = {
  open: { label: 'Open', cls: 'pill-bad' }, acknowledged: { label: 'Acknowledged by supplier', cls: 'pill-warn' }, contested: { label: 'Contested by supplier', cls: 'pill-bad' }, resolved: { label: 'Resolved', cls: 'pill-good' },
};
const RETURN_STATE: Record<string, { label: string; cls: string }> = {
  requested: { label: 'Requested', cls: 'pill-warn' }, approved: { label: 'Approved, awaiting collection', cls: 'pill-warn' }, collected: { label: 'Collected', cls: 'pill-good' },
  rejected: { label: 'Rejected by supplier', cls: 'pill-bad' }, cancelled: { label: 'Cancelled', cls: '' },
};
const INVOICE_STATE: Record<string, { label: string; cls: string }> = {
  submitted: { label: 'Submitted', cls: '' }, matched: { label: 'Matched', cls: 'pill-good' }, awaiting_approval: { label: 'Variance: needs approval', cls: 'pill-warn' },
  approved: { label: 'Variance approved', cls: 'pill-good' }, rejected: { label: 'Rejected', cls: 'pill-bad' }, withdrawn: { label: 'Withdrawn', cls: '' },
};
const KINDS = [['damaged', 'Damaged'], ['wrong_item', 'Wrong item'], ['wrong_spec', 'Wrong specification'], ['quality', 'Quality not acceptable'], ['excess', 'More than ordered']];
const RESOLUTIONS = [['replace', 'Supplier replaces it'], ['credit', 'Supplier credits it (not resupplied)'], ['accept_as_is', 'Accept as is']];
const METHODS = [['bank_transfer', 'Bank transfer'], ['cash', 'Cash'], ['card', 'Card'], ['mobile_money', 'Mobile money'], ['cheque', 'Cheque'], ['other', 'Other']];

const Pill = ({ map, k }: { map: Record<string, { label: string; cls: string }>; k: string }) => <span className={`pill ${map[k]?.cls ?? ''}`}>{map[k]?.label ?? k}</span>;
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Lagos' }) : '');
const dateOnly = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const localNow = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16); };
const localDay = (plus = 0) => { const d = new Date(Date.now() + plus * 86_400_000); return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10); };
const H = ({ children }: { children: React.ReactNode }) => <h2 style={{ fontSize: '1.1rem', margin: 0 }}>{children}</h2>;

function useRun() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const t = await fn(); if (t) setMsg({ ok: true, text: t }); router.refresh(); return true; }
    catch (e) { setMsg({ ok: false, text: errorText(e) }); return false; } finally { setBusy(false); }
  };
  const status = <div role="status" aria-live="polite">{msg && <p className={`small notice ${msg.ok ? 'notice-good' : 'notice-bad'}`} style={{ margin: 0 }}>{msg.text}</p>}</div>;
  return { busy, run, status };
}

export function FulfilmentPanel({ f }: { f: F }) {
  return (
    <div className="stack">
      <Progress f={f} />
      {f.canSchedule && f.progress.lines.some((l: any) => l.priced && l.outstanding !== '0') && <BookDelivery f={f} />}
      <section className="stack-sm" aria-labelledby="deliveries-h">
        <h2 id="deliveries-h" style={{ fontSize: '1.1rem', margin: 0 }}>Deliveries</h2>
        {!f.deliveries.length && <p className="small muted" style={{ margin: 0 }}>{f.side === 'client' ? 'No deliveries booked yet.' : 'The client has not booked a delivery yet.'}</p>}
        {f.deliveries.map((d: any) => <Delivery key={d.id} f={f} d={d} />)}
      </section>
      <Returns f={f} />
      <Invoices f={f} />
      <Payments f={f} />
      {f.side === 'client' && (f.close.blockers.length > 0 || f.close.warnings.length > 0) && f.state !== 'closed' && f.state !== 'cancelled' && (
        <div className="notice small" style={{ margin: 0 }}>
          <strong>Before this order can be closed:</strong>
          <ul style={{ margin: '.25rem 0 0' }}>{[...f.close.blockers, ...f.close.warnings].map((b: string) => <li key={b}>{b}</li>)}</ul>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- progress
function Progress({ f }: { f: F }) {
  return (
    <section className="stack-sm" aria-labelledby="progress-h">
      <h2 id="progress-h" style={{ fontSize: '1.1rem', margin: 0 }}>Delivery progress</h2>
      <div className="table-wrap card" style={{ padding: 0 }}>
        <table>
          <caption className="sr-only">What has been booked, received, accepted and returned for each order line</caption>
          <thead><tr><th scope="col">Item</th><th scope="col" className="num">Ordered</th><th scope="col" className="num">Booked or on the way</th><th scope="col" className="num">Received</th><th scope="col" className="num">Accepted and kept</th><th scope="col" className="num">Rejected</th><th scope="col" className="num">Not needed</th><th scope="col" className="num">Still to book</th></tr></thead>
          <tbody>
            {f.progress.lines.filter((l: any) => l.priced).map((l: any) => (
              <tr key={l.lineKey}>
                <th scope="row" style={{ fontWeight: 'normal' }}>{l.description} <span className="small muted">({l.unitLabel})</span>{l.complete && <> <span className="pill pill-good">Complete</span></>}</th>
                <td className="num">{l.ordered}</td><td className="num">{l.inTransit}</td>
                <td className="num">{l.received}{l.awaitingInspection !== '0' && <div className="small muted">{l.awaitingInspection} to inspect</div>}</td>
                <td className="num">{l.netAccepted}{l.returned !== '0' && <div className="small muted">{l.returned} returned</div>}</td>
                <td className="num">{l.rejected}</td><td className="num">{l.waived}</td><td className="num"><strong>{l.outstanding}</strong></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="small muted" style={{ margin: 0 }}>{f.receiptNotice}</p>
    </section>
  );
}

// ---------------------------------------------------------------- booking
function BookDelivery({ f }: { f: F }) {
  const a = useRun();
  const open = f.progress.lines.filter((l: any) => l.priced && l.outstanding !== '0');
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const fd = new FormData(form); void a.run(async () => {
      const r = await call<{ reference: string }>(`/v1/orders/${f.orderId}/deliveries`, { idempotencyKey: newKey(), body: {
        date: String(fd.get('date')), slot: String(fd.get('slot')), instructions: String(fd.get('instructions') || '') || undefined,
        lines: open.map((l: any) => ({ lineKey: l.lineKey, quantity: String(fd.get(`book-${l.lineKey}`) || '0') })).filter((l: any) => Number(l.quantity) > 0),
      } });
      return `Delivery ${r.reference} booked. The supplier has been told.`;
    }); }}>
      <H>Book a delivery</H>
      <div className="row">
        <div><label htmlFor="book-date">Delivery date</label><input id="book-date" name="date" type="date" required min={localDay()} defaultValue={localDay(1)} /></div>
        <div><label htmlFor="book-slot">Delivery slot</label><select id="book-slot" name="slot" defaultValue={f.slots[0]?.code}>{f.slots.map((s: any) => <option key={s.code} value={s.code}>{s.label}</option>)}</select></div>
      </div>
      {open.map((l: any) => (
        <div key={l.lineKey}><label htmlFor={`book-${l.lineKey}`}>Quantity to deliver <span className="sr-only">for {l.description}</span><span className="hint">{l.description}: {l.outstanding} {l.unitLabel} still to book</span></label>
          <input id={`book-${l.lineKey}`} name={`book-${l.lineKey}`} inputMode="decimal" defaultValue={l.outstanding} /></div>
      ))}
      <div><label htmlFor="book-instr">Site instructions <span className="hint">Optional. Access, offloading. No phone numbers.</span></label><textarea id="book-instr" name="instructions" rows={2} maxLength={1000} /></div>
      <div><button type="submit" className="btn btn-primary" disabled={a.busy}>Book delivery</button></div>
      {a.status}
    </form>
  );
}

// ---------------------------------------------------------------- one delivery
function Delivery({ f, d }: { f: F; d: any }) {
  const has = (c: string) => d.commands.includes(c);
  return (
    <article className="card stack-sm" aria-labelledby={`del-${d.id}`}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h3 id={`del-${d.id}`} style={{ fontSize: '1rem', margin: 0 }}>{d.reference}: {dateOnly(d.scheduledDate)}, {d.slot.label}</h3>
        <Pill map={DELIVERY_STATE} k={d.state} />
      </div>
      {d.inspectionOverdue && <p className="notice notice-warn small" style={{ margin: 0 }}>Received over {f.inspectionWindowHours} hours ago and not inspected yet. Receipt is not acceptance: inspect the goods.</p>}
      <dl className="facts small">
        {d.instructions && (<><dt>Site instructions</dt><dd>{d.instructions}</dd></>)}
        {d.rescheduleCount > 0 && (<><dt>Moved</dt><dd>{d.rescheduleCount} time{d.rescheduleCount === 1 ? '' : 's'}</dd></>)}
        {d.consignment && (<><dt>Consignment</dt><dd>{d.consignment.reference}{d.consignment.vehicle ? `, vehicle ${d.consignment.vehicle}` : ''}{d.consignment.driverName ? `, driver ${d.consignment.driverName}` : ''} · left {when(d.consignment.dispatchedAt)}</dd></>)}
        {d.arrivedAt && (<><dt>Arrived</dt><dd>{when(d.arrivedAt)}</dd></>)}
        {d.pod && (<><dt>Proof of delivery</dt><dd>Received by {d.pod.receivedBy}, {when(d.pod.receivedAt)}{d.pod.notes ? `. ${d.pod.notes}` : ''}<div className="muted">Fingerprint <code style={{ wordBreak: 'break-all' }}>{d.pod.hash}</code></div></dd></>)}
        {d.inspection && (<><dt>Inspected</dt><dd>{when(d.inspection.at)}{d.inspection.notes ? `. ${d.inspection.notes}` : ''}</dd></>)}
        {d.cancelReason && (<><dt>Cancelled</dt><dd>{d.cancelReason}</dd></>)}
      </dl>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">{d.reference} lines</caption>
          <thead><tr><th scope="col">Item</th><th scope="col" className="num">Booked</th><th scope="col" className="num">Loaded</th><th scope="col" className="num">Received</th><th scope="col" className="num">Accepted</th><th scope="col" className="num">Rejected</th></tr></thead>
          <tbody>{d.lines.map((l: any) => (
            <tr key={l.lineKey}><th scope="row" style={{ fontWeight: 'normal' }}>{l.description} <span className="small muted">({l.unitLabel})</span></th><td className="num">{l.scheduled}</td><td className="num">{l.dispatched ?? '—'}</td><td className="num">{l.received ?? '—'}</td><td className="num">{l.accepted ?? '—'}</td><td className="num">{l.rejected ?? '—'}</td></tr>
          ))}</tbody>
        </table>
      </div>
      {d.discrepancies.length > 0 && (
        <div className="stack-sm">
          <h4 style={{ fontSize: '.95rem', margin: 0 }}>Discrepancies</h4>
          {d.discrepancies.map((x: any) => <Discrepancy key={x.id} f={f} d={d} x={x} />)}
        </div>
      )}
      {has('dispatch') && <DispatchForm d={d} />}
      {has('arrive') && <SimpleAction label="Mark arrived" path={`/v1/deliveries/${d.id}/arrive`} body={{ expectedVersion: d.version }} done="Marked as arrived." />}
      {has('receive') && <ReceiveForm f={f} d={d} />}
      {has('accept') && <InspectForm d={d} />}
      {(has('reschedule') || has('cancel')) && <ChangeDelivery f={f} d={d} canMove={has('reschedule')} canCancel={has('cancel')} />}
    </article>
  );
}

function SimpleAction({ label, path, body, done, primary = true }: { label: string; path: string; body: unknown; done: string; primary?: boolean }) {
  const a = useRun();
  return <div className="stack-sm"><div><button type="button" className={`btn ${primary ? 'btn-primary' : ''}`} disabled={a.busy} onClick={() => a.run(async () => { await call(path, { idempotencyKey: newKey(), body }); return done; })}>{label}</button></div>{a.status}</div>;
}

function DispatchForm({ d }: { d: any }) {
  const a = useRun();
  return (
    <form className="card-inset stack-sm" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/deliveries/${d.id}/dispatch`, { idempotencyKey: newKey(), body: {
        expectedVersion: d.version, consignmentRef: String(fd.get('ref')), vehicle: String(fd.get('vehicle') || '') || undefined, driverName: String(fd.get('driver') || '') || undefined,
        notes: String(fd.get('notes') || '') || undefined, lines: d.lines.map((l: any) => ({ lineKey: l.lineKey, quantity: String(fd.get(`load-${l.lineKey}`) || '0') })),
      } });
      return 'Consignment dispatched. The client has been told it is on the way.';
    }); }}>
      <h4 style={{ fontSize: '.95rem', margin: 0 }}>Dispatch this delivery</h4>
      <div className="row">
        <div><label htmlFor={`ref-${d.id}`}>Waybill or consignment number</label><input id={`ref-${d.id}`} name="ref" required maxLength={80} /></div>
        <div><label htmlFor={`veh-${d.id}`}>Vehicle <span className="hint">Optional</span></label><input id={`veh-${d.id}`} name="vehicle" maxLength={80} /></div>
        <div><label htmlFor={`drv-${d.id}`}>Driver&apos;s name <span className="hint">Optional</span></label><input id={`drv-${d.id}`} name="driver" maxLength={80} /></div>
      </div>
      {d.lines.map((l: any) => (
        <div key={l.lineKey}><label htmlFor={`load-${d.id}-${l.lineKey}`}>Quantity loaded <span className="sr-only">for {l.description}</span><span className="hint">{l.description}: {l.scheduled} {l.unitLabel} booked</span></label>
          <input id={`load-${d.id}-${l.lineKey}`} name={`load-${l.lineKey}`} inputMode="decimal" defaultValue={l.scheduled} /></div>
      ))}
      <div><label htmlFor={`dn-${d.id}`}>Notes <span className="hint">Optional</span></label><input id={`dn-${d.id}`} name="notes" maxLength={1000} /></div>
      <div><button type="submit" className="btn btn-primary" disabled={a.busy}>Dispatch consignment</button></div>
      {a.status}
    </form>
  );
}

function ReceiveForm({ f, d }: { f: F; d: any }) {
  const a = useRun();
  return (
    <form className="card-inset stack-sm" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
      await call(`/v1/deliveries/${d.id}/receive`, { idempotencyKey: newKey(), body: {
        expectedVersion: d.version, receivedBy: String(fd.get('by')), receivedAt: new Date(String(fd.get('at'))).toISOString(), notes: String(fd.get('notes') || '') || undefined,
        lines: d.lines.map((l: any) => ({ lineKey: l.lineKey, quantity: String(fd.get(`rec-${l.lineKey}`) || '0') })),
      } });
      return 'Proof of delivery recorded. Now inspect the goods to accept them or raise a discrepancy.';
    }); }}>
      <h4 style={{ fontSize: '.95rem', margin: 0 }}>Record proof of delivery</h4>
      <p className="small muted" style={{ margin: 0 }}>{f.receiptNotice}</p>
      <div className="row">
        <div><label htmlFor={`by-${d.id}`}>Received by</label><input id={`by-${d.id}`} name="by" required minLength={2} maxLength={120} placeholder="Name of the person who signed" /></div>
        <div><label htmlFor={`at-${d.id}`}>Received at</label><input id={`at-${d.id}`} name="at" type="datetime-local" required defaultValue={localNow()} /></div>
      </div>
      {d.lines.map((l: any) => (
        <div key={l.lineKey}><label htmlFor={`rec-${d.id}-${l.lineKey}`}>Received quantity <span className="sr-only">for {l.description}</span><span className="hint">{l.description}: {l.dispatched ?? l.scheduled} {l.unitLabel} loaded. Count what came off the vehicle (0 if refused).</span></label>
          <input id={`rec-${d.id}-${l.lineKey}`} name={`rec-${l.lineKey}`} inputMode="decimal" defaultValue={l.dispatched ?? l.scheduled} /></div>
      ))}
      <div><label htmlFor={`rn-${d.id}`}>Notes <span className="hint">Optional</span></label><input id={`rn-${d.id}`} name="notes" maxLength={1000} /></div>
      <div><button type="submit" className="btn btn-primary" disabled={a.busy}>Record proof of delivery</button></div>
      {a.status}
    </form>
  );
}

function InspectForm({ d }: { d: any }) {
  const a = useRun();
  return (
    <form className="card-inset stack-sm" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
      const r = await call<{ discrepancies: number }>(`/v1/deliveries/${d.id}/inspect`, { idempotencyKey: newKey(), body: {
        expectedVersion: d.version, notes: String(fd.get('notes') || '') || undefined,
        lines: d.lines.map((l: any) => {
          const rejected = String(fd.get(`rej-${l.lineKey}`) || '0');
          return { lineKey: l.lineKey, accepted: String(fd.get(`acc-${l.lineKey}`) || '0'), rejected, kind: Number(rejected) > 0 ? String(fd.get(`kind-${l.lineKey}`)) : null, note: String(fd.get(`why-${l.lineKey}`) || '') || null };
        }),
      } });
      return r.discrepancies ? `Inspection recorded with ${r.discrepancies} discrepanc${r.discrepancies === 1 ? 'y' : 'ies'}. The supplier has been told.` : 'Inspection recorded: everything accepted.';
    }); }}>
      <h4 style={{ fontSize: '.95rem', margin: 0 }}>Inspect the goods</h4>
      <p className="small muted" style={{ margin: 0 }}>Split what was received into accepted and rejected. A line that arrived short of what was loaded is raised as a shortage automatically.</p>
      {d.lines.map((l: any) => (
        <fieldset key={l.lineKey} className="stack-sm" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small"><strong>{l.description}</strong>: {l.received} {l.unitLabel} received</legend>
          <div className="row">
            <div><label htmlFor={`acc-${d.id}-${l.lineKey}`}>Accepted quantity <span className="sr-only">for {l.description}</span></label><input id={`acc-${d.id}-${l.lineKey}`} name={`acc-${l.lineKey}`} inputMode="decimal" defaultValue={l.received} /></div>
            <div><label htmlFor={`rej-${d.id}-${l.lineKey}`}>Rejected quantity <span className="sr-only">for {l.description}</span></label><input id={`rej-${d.id}-${l.lineKey}`} name={`rej-${l.lineKey}`} inputMode="decimal" defaultValue="0" /></div>
            <div><label htmlFor={`kind-${d.id}-${l.lineKey}`}>Why rejected <span className="sr-only">for {l.description}</span></label><select id={`kind-${d.id}-${l.lineKey}`} name={`kind-${l.lineKey}`} defaultValue="damaged">{KINDS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></div>
          </div>
          <div><label htmlFor={`why-${d.id}-${l.lineKey}`}>What was wrong <span className="sr-only">with {l.description}</span><span className="hint">Optional</span></label><input id={`why-${d.id}-${l.lineKey}`} name={`why-${l.lineKey}`} maxLength={500} /></div>
        </fieldset>
      ))}
      <div><label htmlFor={`in-${d.id}`}>Inspection notes <span className="hint">Optional</span></label><input id={`in-${d.id}`} name="notes" maxLength={1000} /></div>
      <div><button type="submit" className="btn btn-primary" disabled={a.busy}>Record inspection</button></div>
      {a.status}
    </form>
  );
}

function ChangeDelivery({ f, d, canMove, canCancel }: { f: F; d: any; canMove: boolean; canCancel: boolean }) {
  const a = useRun();
  const [reason, setReason] = useState('');
  const [date, setDate] = useState(d.scheduledDate);
  const [slot, setSlot] = useState(d.slot.code);
  return (
    <details><summary className="small">{canMove ? 'Move or cancel this delivery' : 'Cancel this delivery'}</summary>
      <div className="stack-sm" style={{ marginTop: '.5rem' }}>
        {canMove && (
          <div className="row">
            <div><label htmlFor={`mv-date-${d.id}`}>New date</label><input id={`mv-date-${d.id}`} type="date" min={localDay()} value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div><label htmlFor={`mv-slot-${d.id}`}>New slot</label><select id={`mv-slot-${d.id}`} value={slot} onChange={(e) => setSlot(e.target.value)}>{f.slots.map((s: any) => <option key={s.code} value={s.code}>{s.label}</option>)}</select></div>
          </div>
        )}
        <div><label htmlFor={`mv-why-${d.id}`}>Reason</label><input id={`mv-why-${d.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} /></div>
        <div className="inline">
          {canMove && <button type="button" className="btn btn-small" disabled={a.busy || reason.trim().length < 3} onClick={() => a.run(async () => { await call(`/v1/deliveries/${d.id}/reschedule`, { body: { expectedVersion: d.version, date, slot, reason } }); return 'Delivery moved.'; })}>Move delivery</button>}
          {canCancel && <button type="button" className="btn btn-small btn-danger" disabled={a.busy || reason.trim().length < 3} onClick={() => a.run(async () => { await call(`/v1/deliveries/${d.id}/cancel`, { body: { expectedVersion: d.version, reason } }); return 'Delivery cancelled.'; })}>Cancel delivery</button>}
        </div>
        {a.status}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------- discrepancies
function Discrepancy({ f, d, x }: { f: F; d: any; x: any }) {
  const a = useRun();
  const [note, setNote] = useState('');
  const [resolution, setResolution] = useState(x.kind === 'shortage' ? 'replace' : 'credit');
  const [returnQty, setReturnQty] = useState(x.quantity);
  const has = (c: string) => x.commands.includes(c);
  return (
    <div className="card-inset stack-sm small">
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <span><strong>{x.kindLabel}</strong>: {x.description}, {x.quantity} {x.unitLabel}{x.note ? `. ${x.note}` : ''}</span>
        <Pill map={DISC_STATE} k={x.state} />
      </div>
      {x.supplierResponse && <p style={{ margin: 0 }}><strong>Supplier:</strong> {x.supplierResponse}</p>}
      {x.resolution && <p style={{ margin: 0 }}><strong>Resolution:</strong> {x.resolutionLabel}{x.resolutionNote ? `. ${x.resolutionNote}` : ''}</p>}
      {(has('acknowledge') || has('contest')) && (
        <div className="stack-sm">
          <label htmlFor={`dr-${x.id}`}>Your answer <span className="sr-only">to the {x.kindLabel.toLowerCase()} discrepancy on {x.description}</span></label>
          <input id={`dr-${x.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          <div className="inline">
            {has('acknowledge') && <button type="button" className="btn btn-small btn-primary" disabled={a.busy || note.trim().length < 3} onClick={() => a.run(async () => { await call(`/v1/discrepancies/${x.id}/respond`, { body: { action: 'acknowledge', note } }); return 'Acknowledged.'; })}>Acknowledge</button>}
            {has('contest') && <button type="button" className="btn btn-small" disabled={a.busy || note.trim().length < 3} onClick={() => a.run(async () => { const r = await call<{ caseReference: string | null }>(`/v1/discrepancies/${x.id}/respond`, { body: { action: 'contest', note } }); return r.caseReference ? `Contested. Case ${r.caseReference} is open: BuildWise staff will review both sides.` : 'Contested.'; })}>Contest</button>}
          </div>
        </div>
      )}
      {has('resolve') && (
        <div className="stack-sm">
          <div className="row">
            <div><label htmlFor={`res-${x.id}`}>Resolution <span className="sr-only">for the {x.kindLabel.toLowerCase()} discrepancy on {x.description}</span></label>
              <select id={`res-${x.id}`} value={resolution} onChange={(e) => setResolution(e.target.value)}>{RESOLUTIONS.filter(([k]) => !(x.kind === 'excess' && k === 'credit')).map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></div>
            <div><label htmlFor={`resn-${x.id}`}>Note <span className="hint">Optional</span></label><input id={`resn-${x.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></div>
          </div>
          <div><button type="button" className="btn btn-small btn-primary" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/discrepancies/${x.id}/resolve`, { body: { resolution, note: note || undefined } }); return 'Discrepancy resolved.'; })}>Resolve discrepancy</button></div>
        </div>
      )}
      {f.canManage && x.returnable && f.state !== 'closed' && f.state !== 'cancelled' && (
        <details><summary>Return these goods to the supplier</summary>
          <div className="row" style={{ marginTop: '.5rem' }}>
            <div><label htmlFor={`rq-${x.id}`}>Rejected quantity to return <span className="sr-only">of {x.description}</span></label><input id={`rq-${x.id}`} inputMode="decimal" value={returnQty} onChange={(e) => setReturnQty(e.target.value)} /></div>
          </div>
          <div style={{ marginTop: '.5rem' }}><button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => {
            const r = await call<{ reference: string }>(`/v1/orders/${f.orderId}/returns`, { idempotencyKey: newKey(), body: { reason: `${x.kindLabel}: ${x.description}${x.note ? ` (${x.note})` : ''}`, discrepancyId: x.id, lines: [{ lineKey: x.lineKey, quantity: returnQty }] } });
            return `Return ${r.reference} requested from ${d.reference}.`;
          })}>Request return</button></div>
        </details>
      )}
      {a.status}
    </div>
  );
}

// ---------------------------------------------------------------- returns
function Returns({ f }: { f: F }) {
  if (!f.returns.length && !f.canRequestReturn) return null;
  return (
    <section className="stack-sm" aria-labelledby="returns-h">
      <h2 id="returns-h" style={{ fontSize: '1.1rem', margin: 0 }}>Returns</h2>
      {!f.returns.length && <p className="small muted" style={{ margin: 0 }}>No returns.</p>}
      {f.returns.map((r: any) => <ReturnCard key={r.id} r={r} />)}
      {f.canRequestReturn && <ReturnKept f={f} />}
    </section>
  );
}

function ReturnCard({ r }: { r: any }) {
  const a = useRun();
  const [note, setNote] = useState('');
  const has = (c: string) => r.commands.includes(c);
  const go = (c: string, done: string) => a.run(async () => { await call(`/v1/returns/${r.id}/${c}`, { body: { expectedVersion: r.version, note: note || undefined } }); return done; });
  return (
    <div className="card stack-sm small">
      <div className="inline" style={{ justifyContent: 'space-between' }}><strong>{r.reference}{r.delivery ? ` (from ${r.delivery})` : ''}</strong><Pill map={RETURN_STATE} k={r.state} /></div>
      <p style={{ margin: 0 }}>{r.lines.map((l: any) => `${l.quantity} ${l.unitLabel} ${l.description}`).join('; ')}. {r.reason}</p>
      {r.supplierNote && <p style={{ margin: 0 }}><strong>Supplier:</strong> {r.supplierNote}</p>}
      {(has('approve') || has('reject') || has('cancel')) && (
        <div><label htmlFor={`rn-${r.id}`}>Note <span className="hint">{has('reject') || has('cancel') ? 'Needed to reject or cancel' : 'Optional'}</span></label><input id={`rn-${r.id}`} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} /></div>
      )}
      <div className="inline">
        {has('approve') && <button type="button" className="btn btn-small btn-primary" disabled={a.busy} onClick={() => go('approve', 'Return approved.')}>Approve return</button>}
        {has('reject') && <button type="button" className="btn btn-small" disabled={a.busy || note.trim().length < 3} onClick={() => go('reject', 'Return rejected.')}>Reject return</button>}
        {has('collect') && <button type="button" className="btn btn-small btn-primary" disabled={a.busy} onClick={() => go('collect', 'Marked as collected.')}>Mark collected</button>}
        {has('cancel') && <button type="button" className="btn btn-small btn-danger" disabled={a.busy || note.trim().length < 3} onClick={() => go('cancel', 'Return cancelled.')}>Cancel return</button>}
      </div>
      {a.status}
    </div>
  );
}

function ReturnKept({ f }: { f: F }) {
  const a = useRun();
  const kept = f.progress.lines.filter((l: any) => l.priced && Number(l.netAccepted) > Number(l.returnPending));
  return (
    <details><summary className="small">Return goods you accepted</summary>
      <form className="card-inset stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
        const r = await call<{ reference: string }>(`/v1/orders/${f.orderId}/returns`, { idempotencyKey: newKey(), body: {
          reason: String(fd.get('reason')), lines: kept.map((l: any) => ({ lineKey: l.lineKey, quantity: String(fd.get(`ret-${l.lineKey}`) || '0') })).filter((l: any) => Number(l.quantity) > 0),
        } });
        return `Return ${r.reference} requested.`;
      }); }}>
        {kept.map((l: any) => <div key={l.lineKey}><label htmlFor={`ret-${l.lineKey}`}>Kept quantity to send back <span className="sr-only">of {l.description}</span><span className="hint">{l.netAccepted} {l.unitLabel} kept</span></label><input id={`ret-${l.lineKey}`} name={`ret-${l.lineKey}`} inputMode="decimal" defaultValue="0" /></div>)}
        <div><label htmlFor="ret-reason">Reason</label><input id="ret-reason" name="reason" required minLength={3} maxLength={1000} placeholder="e.g. surplus after the slab was poured" /></div>
        <div><button type="submit" className="btn btn-small" disabled={a.busy}>Request return</button></div>
        {a.status}
      </form>
    </details>
  );
}

// ---------------------------------------------------------------- invoices and the three-way match
function Invoices({ f }: { f: F }) {
  if (!f.invoices.length && !f.canInvoice) return null;
  return (
    <section className="stack-sm" aria-labelledby="invoices-h">
      <h2 id="invoices-h" style={{ fontSize: '1.1rem', margin: 0 }}>Invoices and three-way match</h2>
      <p className="small muted" style={{ margin: 0 }}>Each supplier invoice is checked against the order (prices, units, tax, delivery charge) and against proof of delivery and inspection (quantities received and kept). Differences need the project owner&apos;s approval.</p>
      {!f.invoices.length && <p className="small muted" style={{ margin: 0 }}>No invoices yet.</p>}
      {f.invoices.map((i: any) => <InvoiceCard key={i.id} i={i} />)}
      {f.canInvoice && <InvoiceForm f={f} />}
    </section>
  );
}

function InvoiceCard({ i }: { i: any }) {
  const a = useRun();
  const [reason, setReason] = useState('');
  const m = i.match;
  const has = (c: string) => i.commands.includes(c);
  const go = (c: string, done: string) => a.run(async () => { await call(`/v1/invoices/${i.id}/${c}`, { body: { expectedVersion: i.version, reason } }); return done; });
  return (
    <article className="card stack-sm" aria-labelledby={`inv-${i.id}`}>
      <div className="inline" style={{ justifyContent: 'space-between' }}>
        <h3 id={`inv-${i.id}`} style={{ fontSize: '1rem', margin: 0 }}>Invoice {i.invoiceNumber}: {i.total.display}</h3>
        <Pill map={INVOICE_STATE} k={i.state} />
      </div>
      <p className="small muted" style={{ margin: 0 }}>Issued {i.issuedOn}{i.dueOn ? `, due ${i.dueOn}` : ''} · checked {when(m.matchedAt)}{i.decisionReason ? ` · ${i.decisionReason}` : ''}</p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Three-way match for invoice {i.invoiceNumber}</caption>
          <thead><tr><th scope="col">Item</th><th scope="col" className="num">Ordered</th><th scope="col" className="num">Received</th><th scope="col" className="num">Kept</th><th scope="col" className="num">Billed before</th><th scope="col" className="num">Billed now</th><th scope="col" className="num">Order price</th><th scope="col" className="num">Invoice price</th><th scope="col">Check</th></tr></thead>
          <tbody>{m.lines.map((l: any, n: number) => (
            <tr key={`${l.lineKey}-${n}`}>
              <th scope="row" style={{ fontWeight: 'normal' }}>{l.description} <span className="small muted">({l.unitLabel})</span></th>
              <td className="num">{l.ordered}</td><td className="num">{l.received}</td><td className="num">{l.accepted}</td><td className="num">{l.previouslyInvoiced}</td><td className="num">{l.invoiced}</td>
              <td className="num">{l.orderUnitPrice ?? '—'}</td><td className="num">{l.invoiceUnitPrice}</td>
              <td>{l.variances.length ? <span className="pill pill-warn">Variance</span> : <span className="pill pill-good">Matches</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="small" style={{ margin: 0 }}>Invoice total {m.stated.display} · lines, delivery and tax add up to {m.computed.display} · at the order&apos;s prices {m.expected.display}</p>
      {m.variances.length > 0 && (
        <ul className="small notice notice-warn" style={{ margin: 0, paddingLeft: '1.5rem' }}>{m.variances.map((v: any, n: number) => <li key={n}><strong>{v.label}.</strong> {v.message}{v.impactMinor !== '0' ? ` Difference: ${v.impact}.` : ''}</li>)}</ul>
      )}
      {m.notes.length > 0 && <ul className="small muted" style={{ margin: 0 }}>{m.notes.map((n: string) => <li key={n}>{n}</li>)}</ul>}
      {i.commands.length > 0 && (
        <div className="stack-sm">
          <label htmlFor={`ir-${i.id}`}>{has('withdraw') ? 'Reason for withdrawing' : has('approve') ? 'Reason for your decision' : 'Reason for rejecting'}</label>
          <input id={`ir-${i.id}`} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} />
          <div className="inline">
            {has('approve') && <button type="button" className="btn btn-small btn-primary" disabled={a.busy || reason.trim().length < 3} onClick={() => go('approve', 'Variance approved.')}>Approve variance</button>}
            {has('reject') && <button type="button" className="btn btn-small" disabled={a.busy || reason.trim().length < 3} onClick={() => go('reject', 'Invoice rejected. The supplier has been told.')}>Reject invoice</button>}
            {has('withdraw') && <button type="button" className="btn btn-small btn-danger" disabled={a.busy || reason.trim().length < 3} onClick={() => go('withdraw', 'Invoice withdrawn.')}>Withdraw invoice</button>}
          </div>
        </div>
      )}
      <p className="small muted" style={{ margin: 0 }}>Fingerprint <code style={{ wordBreak: 'break-all' }}>{i.snapshotHash}</code></p>
      {a.status}
    </article>
  );
}

function InvoiceForm({ f }: { f: F }) {
  const a = useRun();
  const billedBefore = (key: string) => f.invoices.filter((i: any) => ['submitted', 'matched', 'awaiting_approval', 'approved'].includes(i.state))
    .reduce((s: number, i: any) => s + i.match.lines.filter((l: any) => l.lineKey === key).reduce((x: number, l: any) => x + Number(l.invoiced), 0), 0);
  const kept = (key: string) => Number(f.progress.lines.find((l: any) => l.lineKey === key)?.netAccepted ?? 0);
  const digits = minorDigits(f.currency);
  const major = (minor: string) => String(Number(minor) / 10 ** digits);
  const anyBilledDelivery = f.invoices.some((i: any) => ['submitted', 'matched', 'awaiting_approval', 'approved'].includes(i.state) && i.match.totals.deliveryMinor !== '0');
  const [vals, setVals] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = { delivery: anyBilledDelivery ? '0' : major(f.deliveryCharge.minor), deliveryTax: String(f.deliveryCharge.taxRatePct) };
    for (const l of f.orderLines) { v[`q-${l.lineKey}`] = String(Math.max(0, kept(l.lineKey) - billedBefore(l.lineKey))); v[`p-${l.lineKey}`] = major(l.unitPriceMinor); v[`t-${l.lineKey}`] = String(l.taxRatePct); }
    return v;
  });
  const [stated, setStated] = useState<string | null>(null);
  const computed = useMemo(() => {
    try {
      const t = invoiceTotals({
        lines: f.orderLines.map((l: any) => ({ lineKey: l.lineKey, description: '', unit: '', quantity: parseDec(vals[`q-${l.lineKey}`] || '0') ?? 0n, unitPriceMinor: parseMajor(vals[`p-${l.lineKey}`] || '0', f.currency) ?? 0n, taxRatePct: Number(vals[`t-${l.lineKey}`] || 0) })),
        deliveryMinor: parseMajor(vals.delivery || '0', f.currency) ?? 0n, deliveryTaxRatePct: Number(vals.deliveryTax || 0),
      });
      const g = t.grossMinor;
      if (!digits) return String(g);
      const base = 10n ** BigInt(digits);
      return `${g / base}.${String(g % base).padStart(digits, '0')}`.replace(/\.0+$/, '');
    } catch { return ''; }
  }, [vals, f.orderLines, f.currency, digits]);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setVals({ ...vals, [k]: e.target.value });
  return (
    <form className="card stack-sm" onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); void a.run(async () => {
      const r = await call<{ state: string; match: { status: string; variances: { message: string }[] } }>(`/v1/orders/${f.orderId}/invoices`, { idempotencyKey: newKey(), body: {
        invoiceNumber: String(fd.get('number')), issuedOn: String(fd.get('issued')), dueOn: String(fd.get('due') || '') || undefined, notes: String(fd.get('notes') || '') || undefined,
        deliveryCharge: vals.delivery || '0', deliveryTaxRatePct: Number(vals.deliveryTax || 0), statedTotal: stated ?? computed,
        lines: f.orderLines.map((l: any) => ({ lineKey: l.lineKey, quantity: vals[`q-${l.lineKey}`] || '0', unitPrice: vals[`p-${l.lineKey}`] || '0', taxRatePct: Number(vals[`t-${l.lineKey}`] || 0) })).filter((l: any) => Number(l.quantity) > 0),
      } });
      return r.match.status === 'matched' ? 'Invoice sent. It matches the order and what the client received.' : `Invoice sent with a variance the client must approve: ${r.match.variances.map((v) => v.message).join(' ')}`;
    }); }}>
      <H>Send an invoice</H>
      <p className="small muted" style={{ margin: 0 }}>Bill what the client received, inspected and kept. Quantities start at what is kept and not yet billed.</p>
      <div className="row">
        <div><label htmlFor="inv-number">Invoice number</label><input id="inv-number" name="number" required maxLength={60} /></div>
        <div><label htmlFor="inv-issued">Invoice date</label><input id="inv-issued" name="issued" type="date" required max={localDay()} defaultValue={localDay()} /></div>
        <div><label htmlFor="inv-due">Due date <span className="hint">Optional</span></label><input id="inv-due" name="due" type="date" /></div>
      </div>
      {f.orderLines.map((l: any) => (
        <fieldset key={l.lineKey} className="row" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="small"><strong>{l.description}</strong>: order price {l.unitPrice} per {l.unitLabel}, {kept(l.lineKey)} kept, {billedBefore(l.lineKey)} billed before</legend>
          <div><label htmlFor={`iq-${l.lineKey}`}>Quantity billed <span className="sr-only">for {l.description}</span></label><input id={`iq-${l.lineKey}`} inputMode="decimal" value={vals[`q-${l.lineKey}`]} onChange={set(`q-${l.lineKey}`)} /></div>
          <div><label htmlFor={`ip-${l.lineKey}`}>Unit price <span className="sr-only">for {l.description}</span></label><input id={`ip-${l.lineKey}`} inputMode="decimal" value={vals[`p-${l.lineKey}`]} onChange={set(`p-${l.lineKey}`)} /></div>
          <div><label htmlFor={`it-${l.lineKey}`}>Tax % <span className="sr-only">for {l.description}</span></label><input id={`it-${l.lineKey}`} inputMode="decimal" value={vals[`t-${l.lineKey}`]} onChange={set(`t-${l.lineKey}`)} /></div>
        </fieldset>
      ))}
      <div className="row">
        <div><label htmlFor="inv-del">Delivery charge</label><input id="inv-del" inputMode="decimal" value={vals.delivery} onChange={set('delivery')} /></div>
        <div><label htmlFor="inv-dtax">Tax on delivery %</label><input id="inv-dtax" inputMode="decimal" value={vals.deliveryTax} onChange={set('deliveryTax')} /></div>
        <div><label htmlFor="inv-total">Invoice total <span className="hint">Lines, delivery and tax add up to {computed}</span></label><input id="inv-total" inputMode="decimal" value={stated ?? computed} onChange={(e) => setStated(e.target.value)} /></div>
      </div>
      <div><label htmlFor="inv-notes">Notes <span className="hint">Optional. No bank details: payment is arranged directly.</span></label><input id="inv-notes" name="notes" maxLength={1000} /></div>
      <div><button type="submit" className="btn btn-primary" disabled={a.busy}>Send invoice</button></div>
      {a.status}
    </form>
  );
}

// ---------------------------------------------------------------- record-only payments
function Payments({ f }: { f: F }) {
  const p = f.payments;
  if (!p.items.length && !p.canRecord && !f.invoices.length) return null;
  return (
    <section className="stack-sm" aria-labelledby="payments-h">
      <h2 id="payments-h" style={{ fontSize: '1.1rem', margin: 0 }}>Payments (record only)</h2>
      <p className="small muted" style={{ margin: 0 }}>Payments are arranged directly with the supplier; these are your records of them.</p>
      <dl className="facts small">
        <dt>Invoiced and payable</dt><dd>{p.position.payable.display}</dd>
        {p.position.pendingApproval.amountMinor !== '0' && (<><dt>Waiting for approval</dt><dd>{p.position.pendingApproval.display}</dd></>)}
        <dt>Recorded as paid</dt><dd>{p.position.recordedPaid.display}</dd>
        <dt>Balance</dt><dd>{p.position.balance.display}</dd>
      </dl>
      {p.items.length > 0 && (
        <ul className="plain stack-sm">{p.items.map((x: any) => <PaymentRow key={x.id} x={x} f={f} />)}</ul>
      )}
      {p.canRecord && <RecordPayment f={f} />}
    </section>
  );
}

function PaymentRow({ x, f }: { x: any; f: F }) {
  const a = useRun();
  const inv = f.invoices.find((i: any) => i.id === x.invoiceId);
  return (
    <li className="card-inset small stack-sm">
      <span>{x.amount.display} on {x.paidOn} by {METHODS.find(([k]) => k === x.method)?.[1] ?? x.method}{x.reference ? `, ref ${x.reference}` : ''}{inv ? `, for invoice ${inv.invoiceNumber}` : ''}{x.voided ? ' (voided)' : ''}
        {' · '}{x.supplierAcknowledgedAt ? <span className="pill pill-good">Supplier confirmed receipt</span> : <span className="pill">Not confirmed by supplier</span>}</span>
      {x.canAcknowledge && <div><button type="button" className="btn btn-small" disabled={a.busy} onClick={() => a.run(async () => { await call(`/v1/payment-records/${x.id}/supplier-acknowledge`, { body: {} }); return 'Thanks: receipt confirmed.'; })}>Confirm I received this payment</button></div>}
      {a.status}
    </li>
  );
}

function RecordPayment({ f }: { f: F }) {
  const a = useRun();
  const payable = f.invoices.filter((i: any) => ['matched', 'approved'].includes(i.state));
  return (
    <details><summary className="small">Record a payment you made to the supplier</summary>
      <form className="card-inset stack-sm" style={{ marginTop: '.5rem' }} onSubmit={(e) => { e.preventDefault(); const form = e.currentTarget; const fd = new FormData(form); void a.run(async () => {
        await call(`/v1/orders/${f.orderId}/payments`, { idempotencyKey: newKey(), body: {
          amount: String(fd.get('amount')), paidOn: String(fd.get('paidOn')), method: String(fd.get('method')), reference: String(fd.get('reference') || '') || undefined, invoiceId: String(fd.get('invoice') || '') || undefined,
        } });
        form.reset();
        return 'Payment recorded. The supplier can confirm they received it.';
      }); }}>
        <div className="row">
          <div><label htmlFor="pay-amount">Amount paid</label><input id="pay-amount" name="amount" required inputMode="decimal" /></div>
          <div><label htmlFor="pay-date">Paid on</label><input id="pay-date" name="paidOn" type="date" required max={localDay()} defaultValue={localDay()} /></div>
          <div><label htmlFor="pay-method">Method</label><select id="pay-method" name="method" defaultValue="bank_transfer">{METHODS.map(([k, t]) => <option key={k} value={k}>{t}</option>)}</select></div>
        </div>
        <div className="row">
          <div><label htmlFor="pay-ref">Reference <span className="hint">Optional</span></label><input id="pay-ref" name="reference" maxLength={120} /></div>
          <div><label htmlFor="pay-inv">For invoice <span className="hint">Optional</span></label><select id="pay-inv" name="invoice" defaultValue=""><option value="">Not linked to an invoice</option>{payable.map((i: any) => <option key={i.id} value={i.id}>{i.invoiceNumber} ({i.total.display})</option>)}</select></div>
        </div>
        <div><button type="submit" className="btn btn-small" disabled={a.busy}>Record payment</button></div>
        {a.status}
      </form>
    </details>
  );
}
