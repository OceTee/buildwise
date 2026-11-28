import { describe, expect, it } from 'vitest';
import { DEMO_MARKET, feedbackContact, feedbackMachine, feedbackPagePath, screenFeedback } from '../src/index';

describe('feedback', () => {
  it('removes phone numbers and emails and flags links, payment instructions and scam phrases', () => {
    const r = screenFeedback('Seller wanted a booking fee via opay, see https://x.example. Call 0803 123 4567 or me@x.example', DEMO_MARKET);
    expect(r.message).not.toMatch(/0803|me@x/);
    expect(r.message).toContain('[number]');
    expect(r.message).toContain('[email]');
    expect(r.flags).toEqual(['contact_removed', 'link', 'payment_instructions', 'scam_signals']);
  });

  it('does not flag a plain message, and keeps prices and sizes', () => {
    const r = screenFeedback('The 50 kg cement at 9,500 per bag shows the wrong unit price.', DEMO_MARKET);
    expect(r.flags).toEqual([]);
    expect(r.message).toBe('The 50 kg cement at 9,500 per bag shows the wrong unit price.');
  });

  it('strips control characters and caps the length', () => {
    expect(screenFeedback('a\u0000b\u0007c  ', DEMO_MARKET).message).toBe('abc');
    expect(screenFeedback('x'.repeat(5000), DEMO_MARKET).message).toHaveLength(2000);
  });

  it('keeps only the path of the page', () => {
    expect(feedbackPagePath('https://buildwise.example/search?q=my+plot#top')).toBe('/search');
    expect(feedbackPagePath('/projects/abc/estimates?x=1')).toBe('/projects/abc/estimates');
    expect(feedbackPagePath(null)).toBeNull();
  });

  it('accepts an email or a phone number as the reply contact', () => {
    expect(feedbackContact(' Ada@Example.test ')).toBe('ada@example.test');
    expect(feedbackContact('+234 (803) 123-4567')).toBe('+2348031234567');
    expect(feedbackContact('')).toBeNull();
    expect(feedbackContact('call me')).toBe('invalid');
  });

  it('moves open → triaged → closed and back to open', () => {
    expect(feedbackMachine.next('open', 'triage')).toBe('triaged');
    expect(feedbackMachine.next('triaged', 'close')).toBe('closed');
    expect(feedbackMachine.next('closed', 'reopen')).toBe('open');
    expect(feedbackMachine.can('open', 'reopen')).toBe(false);
  });

  it('the pack has readable item rules and a retention schedule', () => {
    expect(DEMO_MARKET.itemRules.prohibited.length).toBeGreaterThan(0);
    expect(DEMO_MARKET.itemRules.restricted.length).toBeGreaterThan(0);
    expect(DEMO_MARKET.retention.every((r) => r.record && r.period)).toBe(true);
  });
});
