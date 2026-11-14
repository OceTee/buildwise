import { formatMoney } from '@bw/domain';

export interface PriceLike { price: { amountMinor: string; currency: string } | null; unitLabel?: string; unit: string; negotiable?: boolean; quoteOnRequest?: boolean; perBaseUnit?: { amountMinor: string; currency: string; unit: string } | null }

export const money = (m: { amountMinor: string; currency: string }, locale = 'en-NG') => formatMoney(m, locale);

export function priceText(l: PriceLike, locale = 'en-NG') {
  if (!l.price || l.quoteOnRequest) return 'Quote on request';
  return `${money(l.price, locale)} / ${l.unitLabel ?? l.unit}`;
}

export function perBaseText(l: PriceLike, locale = 'en-NG') {
  return l.perBaseUnit ? `${money(l.perBaseUnit, locale)} per ${l.perBaseUnit.unit}` : null;
}

export function ago(iso: string | null) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86_400);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export const dateText = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
