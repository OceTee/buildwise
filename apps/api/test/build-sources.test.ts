import { describe, expect, it } from 'vitest';
import { discoverPlanningSources } from '../src/modules/build-sources.js';

describe('global planning source discovery', () => {
  it('searches worldwide architectural precedents with no location', async () => {
    await discoverPlanningSources(undefined, 'test-token', async (_, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({
        query: expect.stringMatching(/International.*tropical.*two-storey single-family house/i),
        objective: expect.stringContaining('several countries'),
      });
      return Response.json({ results: [] });
    }, { type: 'duplex', taste: 'tropical' });
  });
  it('searches by city, region and country and returns valid candidate links with retrieved passages', async () => {
    const candidates = await discoverPlanningSources({ city: 'São Paulo', state: '', country: 'Brazil' }, 'test-token', async (input, init) => {
      const url = new URL(String(input));
      expect(url.href).toBe('https://api.exa.ai/search');
      expect(init?.method).toBe('POST');
      expect(JSON.parse(String(init?.body))).toEqual({
        query: expect.stringMatching(/^Prefer a specific primary or official answer page\..*São Paulo, Brazil\.$/),
        contents: { highlights: true },
        objective: expect.stringContaining('jurisdiction, applicable edition'),
      });
      expect(new Headers(init?.headers).get('x-api-key')).toBe('test-token');
      return Response.json({ results: [
        { title: 'Planning department', url: 'https://example.gov.br/planning#introduction' },
        { title: 'Planning department', url: 'https://example.gov.br/planning', highlights: ['Read the zoning rules for this district.'] },
        { title: 'Invalid link', url: 'javascript:alert(1)' },
      ] });
    });
    expect(candidates).toEqual([{ title: 'Planning department', url: 'https://example.gov.br/planning', host: 'example.gov.br', excerpt: 'Read the zoning rules for this district.' }]);
  });

  it('reports provider rate limits as unavailable', async () => {
    await expect(discoverPlanningSources({ city: 'Toronto', state: 'Ontario', country: 'Canada' }, 'test-token',
      async () => new Response(null, { status: 429 }))).rejects.toMatchObject({ statusCode: 429 });
  });
});
