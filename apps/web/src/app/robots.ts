import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/env';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', allow: '/', disallow: ['/api/', '/search', '/my-ads', '/messages', '/saved', '/account', '/post', '/moderation', '/admin', '/checkout', '/promote', '/sign-in'] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
