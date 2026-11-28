/**
 * What request logs may say about a URL. Signed file and upload links are bearer credentials until they expire,
 * checkout references open a payment page, and phone numbers and emails are personal data: none of them belong
 * in logs (spec §19, §28). The path's shape stays so a log line still says which route was hit.
 */
const SECRET_PATHS: [RegExp, string][] = [
  [/^\/v1\/(files|uploads)\/[^/?#]+/, '/v1/$1/[token]'],
  [/^\/v1\/(dev\/)?checkout\/[^/?#]+/, '/v1/$1checkout/[ref]'],
  [/^\/checkout\/[^/?#]+/, '/checkout/[ref]'],
];
const SECRET_PARAMS = /^(token|ref|reference|trxref|code|otp|phone|email|signature|key)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+(@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A standalone run of 7 to 15 digits, optionally after + or its encoding: a phone number (ids inside UUIDs are not standalone).
const PHONE = /(?<![\w-])(\+|%2B)?\d{7,15}(?![\w-])/g;

export function redactUrl(url: string | undefined): string {
  if (!url) return '';
  const q = url.indexOf('?');
  let path = q === -1 ? url : url.slice(0, q);
  const query = q === -1 ? '' : url.slice(q + 1);
  for (const [re, to] of SECRET_PATHS) path = path.replace(re, to);
  path = redactText(path);
  if (!query) return path;
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const name = eq === -1 ? pair : pair.slice(0, eq);
    if (eq === -1) return redactText(pair);
    return SECRET_PARAMS.test(decodeSafe(name)) ? `${name}=[redacted]` : `${name}=${redactText(pair.slice(eq + 1))}`;
  });
  return `${path}?${parts.join('&')}`;
}

/** Emails and phone numbers in free text (a path segment, a query value, a log message). */
export function redactText(text: string): string {
  return text.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
}

function decodeSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}
