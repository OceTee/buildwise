// Enforces the dependency rules between packages and API modules (spec §7.2).
//  - packages/domain is pure: no framework, database, filesystem or app imports.
//  - apps/web talks to the API over HTTP only; it may import @bw/domain but never apps/api source.
//  - API platform/http/db layers never import feature modules.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const files = (dir) => {
  try { statSync(dir); } catch { return []; }
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (d.isDirectory()) return ['node_modules', '.next', 'dist'].includes(d.name) ? [] : files(p);
    return /\.(ts|tsx|mts)$/.test(d.name) ? [p] : [];
  });
};
const imports = (f) => [...readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);

const rules = [
  { dir: 'packages/domain/src', deny: [/^fastify/, /^pg$/, /^@electric-sql/, /^node:fs/, /^next/, /^react/, /apps\//, /^sharp$/], why: 'domain must stay pure' },
  { dir: 'apps/web', deny: [/apps\/api/, /^@bw\/api/, /^pg$/, /^@electric-sql/, /^fastify/], why: 'the web app reaches the API over HTTP only' },
  { dir: 'apps/api/src/platform', deny: [/\/modules\//], why: 'platform must not depend on feature modules' },
  { dir: 'apps/api/src/http', deny: [/\/modules\//], why: 'http layer must not depend on feature modules' },
  { dir: 'apps/api/src/db', deny: [/\/modules\//, /\/http\//], why: 'db layer must not depend on modules or http' },
];

const violations = [];
for (const r of rules) {
  for (const f of files(join(root, r.dir))) {
    for (const spec of imports(f)) if (r.deny.some((d) => d.test(spec))) violations.push(`${relative(root, f).split(sep).join('/')}: imports "${spec}" (${r.why})`);
  }
}
if (violations.length) { console.error(`Module boundary violations:\n  ${violations.join('\n  ')}`); process.exit(1); }
console.log('Module boundaries OK');
