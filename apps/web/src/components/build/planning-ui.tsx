'use client';
import { CircleAlert, Info } from 'lucide-react';
import type { Calc } from '@bw/domain';
import { money } from '@/lib/format';

/** Money in minor units, in the market's currency. */
export const fmtMinor = (minor: number, currency: string) => money({ amountMinor: String(Math.round(minor)), currency });
/** Large sums at a glance: ₦85.2m, ₦1.14bn (whole units under a million). */
export const fmtCompact = (minor: number, currency: string) => {
  const whole = minor / 100;
  const sym = fmtMinor(0, currency).replace(/[\d.,\s]/g, '');
  if (Math.abs(whole) >= 1e9) return `${sym}${(whole / 1e9).toLocaleString('en', { maximumFractionDigits: 2 })}bn`;
  if (Math.abs(whole) >= 1e6) return `${sym}${(whole / 1e6).toLocaleString('en', { maximumFractionDigits: 1 })}m`;
  return `${sym}${Math.round(whole).toLocaleString('en')}`;
};
export const fmtNum = (n: number, dp = 1) => n.toLocaleString('en', { maximumFractionDigits: dp });

/** How a calculator reached its result: steps, assumptions and warnings, always shown with the numbers. */
export function Working({ calc, open = false }: { calc: Pick<Calc<unknown>, 'steps' | 'assumptions' | 'warnings'>; open?: boolean }) {
  return (
    <>
      {calc.warnings.map((w) => <p key={w} className="notice notice-warn small" role="status"><CircleAlert size={14} aria-hidden="true" /> {w}</p>)}
      <details className="checklist" open={open}>
        <summary><strong>How this was worked out</strong> <span className="small muted">{calc.steps.length} steps · {calc.assumptions.length} assumptions</span></summary>
        <ol className="working small">
          {calc.steps.map((s) => (
            <li key={s.label}><strong>{s.label}:</strong> {s.unit === 'currency' ? fmtNum(s.value, 0) : `${fmtNum(s.value, 2)} ${s.unit}`} <span className="muted">({s.how})</span></li>
          ))}
        </ol>
        <ul className="plain stack-sm small">
          {calc.assumptions.map((a) => <li key={a} className="assumption"><Info size={14} aria-hidden="true" /> <span><span className="sr-only">Assumption: </span>{a}</span></li>)}
        </ul>
      </details>
    </>
  );
}
