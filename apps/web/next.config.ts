import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@bw/domain'],
  poweredByHeader: false,
  agentRules: false,
  output: 'standalone',
  images: { unoptimized: true }, // photos are already resized and re-encoded by the API pipeline
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'x-content-type-options', value: 'nosniff' },
        { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
        { key: 'x-frame-options', value: 'DENY' },
        { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};
export default config;
