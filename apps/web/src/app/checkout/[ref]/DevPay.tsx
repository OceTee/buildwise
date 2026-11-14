'use client';
import { useState } from 'react';
import { call, errorText } from '@/lib/client';

export function DevPay({ checkoutRef }: { checkoutRef: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async (result: 'pay' | 'fail') => {
    setBusy(true); setError('');
    try { await call(`/v1/dev/checkout/${checkoutRef}/${result}`, { body: {} }); window.location.href = '/account/promotions'; }
    catch (x) { setError(errorText(x)); setBusy(false); }
  };
  return (
    <div className="stack-sm">
      <div className="inline">
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => go('pay')}>Pay (simulated)</button>
        <button type="button" className="btn" disabled={busy} onClick={() => go('fail')}>Simulate a failed payment</button>
      </div>
      <div role="alert">{error && <p className="notice notice-bad small" style={{ margin: 0 }}>{error}</p>}</div>
    </div>
  );
}
