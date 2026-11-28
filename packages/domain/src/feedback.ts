import { defineMachine } from './core';
import { scanText } from './listings';
import type { MarketPack } from './market';

/**
 * Feedback and bug reports from the public beta. Anyone can send one (signed in or not); staff triage them in
 * `/moderation/feedback`. The message is kept with contact details removed: a person who wants a reply says so
 * (`contactOk`), and staff reply through the account's own channels or the contact the person typed for that purpose.
 */
export const FEEDBACK_CATEGORIES = ['bug', 'idea', 'other'] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];
export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = { bug: 'Something is not working', idea: 'An idea or suggestion', other: 'Something else' };

export const FEEDBACK_STATES = ['open', 'triaged', 'closed'] as const;
export type FeedbackState = (typeof FEEDBACK_STATES)[number];
export type FeedbackCommand = 'triage' | 'close' | 'reopen';
export const feedbackMachine = defineMachine<FeedbackState, FeedbackCommand>('Feedback', FEEDBACK_STATES, [
  { from: ['open'], command: 'triage', to: 'triaged' },
  { from: ['open', 'triaged'], command: 'close', to: 'closed' },
  { from: ['triaged', 'closed'], command: 'reopen', to: 'open' },
]);

export const FEEDBACK_MIN_CHARS = 10;
export const FEEDBACK_MAX_CHARS = 2000;

/** Keeps only the path of the page the person was on: no host, no query string (searches can hold personal text). */
export function feedbackPagePath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, 'https://buildwise.invalid');
    const path = u.pathname.replace(/[^\w\-/.~%[\]]/g, '').slice(0, 300);
    return path.startsWith('/') ? path : null;
  } catch {
    return null;
  }
}

export interface FeedbackScreen { message: string; flags: string[] }

/**
 * Content checks on a feedback message: phone numbers and emails are removed from the stored text (the contact
 * field is for that), and links, payment instructions and scam phrases are flagged for staff. Nothing is refused for
 * mentioning a prohibited item: people report those to us.
 */
export function screenFeedback(text: string, pack: Pick<MarketPack, 'scamPhrases' | 'prohibitedTerms' | 'restrictedTerms' | 'paymentTerms'>): FeedbackScreen {
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const findings = scanText(clean, pack);
  const flags = new Set<string>();
  for (const f of findings) {
    if (f.code === 'contact_details_in_text' && f.detail === 'link') flags.add('link');
    else if (f.code === 'payment_instructions') flags.add('payment_instructions');
    else if (f.code === 'scam_signals') flags.add('scam_signals');
  }
  const redacted = removeContacts(clean);
  if (redacted !== clean) flags.add('contact_removed');
  const message = redacted.slice(0, FEEDBACK_MAX_CHARS);
  return { message, flags: [...flags].sort() };
}

/** The same patterns as the assistant's `redact`, without its 1000-character cap. */
function removeContacts(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\+?\d[\d\s-]{8,}\d/g, '[number]');
}

/** A contact the person typed so we can reply: an email address or a phone number, nothing else. */
export function feedbackContact(value: string | null | undefined): string | null | 'invalid' {
  const v = (value ?? '').trim();
  if (!v) return null;
  if (/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(v) && v.length <= 120) return v.toLowerCase();
  const digits = v.replace(/[\s()-]/g, '');
  if (/^\+?\d{7,15}$/.test(digits)) return digits;
  return 'invalid';
}
