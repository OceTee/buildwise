import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db/migrations.generated.js';

describe('embedded migrations', () => {
  it('match src/db/migrations (run `node scripts/embed-migrations.mjs` after editing SQL)', () => {
    const dir = join(import.meta.dirname, '../src/db/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    expect(MIGRATIONS.map((m) => m.name)).toEqual(files);
    for (const m of MIGRATIONS) expect(m.sql).toBe(readFileSync(join(dir, m.name), 'utf8').replace(/\r\n/g, '\n'));
  });
});
