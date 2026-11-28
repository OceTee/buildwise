import type { NextConfig } from 'next';

// Pages get their full Content-Security-Policy (with a per-response nonce) from src/proxy.ts.
const common = [
  { key: 'x-content-type-options', value: 'nosniff' },
  { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
  { key: 'x-frame-options', value: 'DENY' },
  { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()' },
  { key: 'cross-origin-opener-policy', value: 'same-origin' },
  // HTTPS only from now on, for a year, subdomains included. Not preloaded: that is hard to undo.
  ...(process.env.NODE_ENV === 'production' ? [{ key: 'strict-transport-security', value: 'max-age=31536000; includeSubDomains' }] : []),
];

const config: NextConfig = {
  transpilePackages: ['@bw/domain'],
  poweredByHeader: false,
  agentRules: false,
  output: 'standalone',
  images: { unoptimized: true }, // photos are already resized and re-encoded by the API pipeline
  async headers() {
    return [
      { source: '/:path*', headers: common },
      // Routes the proxy does not see (JSON, photos, static files) still refuse to be framed or run as pages.
      { source: '/api/:path*', headers: [{ key: 'content-security-policy', value: "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }] },
      { source: '/media/:path*', headers: [{ key: 'content-security-policy', value: "default-src 'none'; frame-ancestors 'none'; sandbox" }] },
    ];
  },
};
export default config;
