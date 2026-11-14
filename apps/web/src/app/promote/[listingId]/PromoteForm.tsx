'use client';
import { useState } from 'react';
import { call, errorText, newKey } from '@/lib/client';

export function PromoteForm({ listingId, products, credits }: { listingId: string; products: any[]; credits: { id: string; kind: string; days: number }[] }) {
  const [code, setCode] = useState(products[0]?.code ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const chosen = products.find((p) => p.code === code);
  return (
    <div className="stack">
      <form className="card stack-sm" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError('');
        try {
          const r = await call<{ checkoutUrl: string; checkoutRef: string }>('/v1/promotions', { body: { listingId, productCode: code }, idempotencyKey: newKey() });
          // The provider's hosted page in production; our own test checkout page in development.
          window.location.href = r.checkoutUrl;
        } catch (x) { setError(errorText(x)); setBusy(false); }
      }}>
        <fieldset style={{ margin: 0 }}>
          <legend>Choose a promotion</legend>
          <div className="stack-sm">
            {products.map((p) => (
              <label key={p.code} className="check card" style={{ padding: '.75rem' }}>
                <input type="radio" name="product" value={p.code} checked={code === p.code} onChange={() => setCode(p.code)} />
                <span><strong>{p.name}</strong> — {p.gross.display} <span className="small muted">({p.net.display} + {p.tax.label})</span>{p.extraAllowance ? <span className="small" style={{ display: 'block' }}>Includes {p.extraAllowance} extra free listings while active</span> : null}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button className="btn btn-primary" type="submit" disabled={busy || !chosen}>Continue to payment ({chosen?.gross.display})</button>
        <p className="small muted" style={{ margin: 0 }}>You pay on a secure checkout page. Your promotion starts once the payment is confirmed and your ad is live.</p>
        <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
      </form>
      {credits.length > 0 && (
        <section className="card stack-sm" aria-label="Use a credit">
          <h2 style={{ fontSize: '1rem', margin: 0 }}>Or use a credit</h2>
          {credits.map((c) => (
            <button key={c.id} type="button" className="btn" disabled={busy} onClick={async () => {
              setBusy(true); setError('');
              try { await call(`/v1/promotion-credits/${c.id}/apply`, { body: { listingId } }); window.location.href = '/account/promotions'; }
              catch (x) { setError(errorText(x)); setBusy(false); }
            }}>Use {c.days}-day {c.kind === 'package' ? 'package' : 'top placement'} credit</button>
          ))}
        </section>
      )}
    </div>
  );
}
