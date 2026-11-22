// Bundles the API for Vercel: our code and @bw/domain go into one ESM file at apps/api/dist/server.mjs.
// The committed function entry apps/api/api/index.mjs re-exports it; Vercel traces third-party packages from there.
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url)); // decodes %20 and Windows drive letters
const api = join(root, 'apps/api');

await build({
  entryPoints: [join(api, 'src/vercel.ts')],
  outfile: join(api, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: 'inline',
  external: ['fastify', 'zod', 'jose', 'pg', 'sharp', 'pdfjs-dist', '@electric-sql/pglite', '@vercel/blob', '@vercel/functions', '@anthropic-ai/sdk'],
  // Some dependencies still use require(); give the ESM bundle one.
  banner: { js: "import { createRequire as __bwCreateRequire } from 'node:module'; const require = __bwCreateRequire(import.meta.url);" },
  logLevel: 'info',
});

// Vercel expects an output directory for non-framework projects; the API serves everything from the function.
mkdirSync(join(api, 'public'), { recursive: true });
writeFileSync(join(api, 'public/index.html'), '<!doctype html><title>BuildWise API</title><p>BuildWise API. See /health.</p>');
console.log('API bundle written to apps/api/dist/server.mjs');
