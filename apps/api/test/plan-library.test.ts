import { expect, it } from 'vitest';
import { findPublishedPlans } from '../src/modules/plan-library.js';

it('returns publisher-hosted previews, marks a known build licence, and keeps unsupported AI attributions out', async () => {
  const brief = { type: 'bungalow', taste: 'tropical', bedrooms: 4, storeys: 1, priorities: ['garden'], features: ['gym'],
    aiOnly: false, study: false, openKitchen: false } as const;
  const fetch: typeof globalThis.fetch = async (url, init) => {
    expect(String(url)).toBe('https://api.exa.ai/search');
    const search = JSON.parse(String(init?.body));
    expect(search.query).toMatch(/tropical.*4 bedrooms.*gym/i);
    expect(search.contents.extras.imageLinks).toBeGreaterThan(0);
    return Response.json({ results: [
      { title: 'Bungalow with a court', url: 'https://www.maramani.com/products/court',
        image: 'https://www.maramani.com/court-exterior.jpg',
        extras: { imageLinks: ['https://www.maramani.com/court-floor-plan.png', 'https://unrelated.example/photo.png'] } },
      { title: 'Plan concept', url: 'https://studio.example/project/ai', image: 'https://studio.example/exterior.jpg',
        highlights: ['This floor plan was generated using Gemini.'] },
      { title: 'Unrelated preview', url: 'https://other.example/page', image: 'https://unrelated.example/photo.png' },
    ] });
  };
  const query = { ...brief, priorities: [...brief.priorities], features: [...brief.features] };
  const results = await findPublishedPlans(query, 'test-token', fetch);
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ licence: 'required', planPreview: 'https://www.maramani.com/court-floor-plan.png', disclosedAi: false });
  expect((await findPublishedPlans({ ...query, aiOnly: true }, 'test-token', fetch)).map((item) => item.title)).toEqual(['Plan concept']);
});
