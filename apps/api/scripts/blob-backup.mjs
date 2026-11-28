// Backs up the private Vercel Blob store to a folder, or restores a folder into a store (docs/ops/blob-backup.md).
//
//   BLOB_READ_WRITE_TOKEN=... node scripts/blob-backup.mjs backup  <dir>            # incremental: skips files already copied
//   BLOB_READ_WRITE_TOKEN=... node scripts/blob-backup.mjs restore <dir> [prefix]   # uploads files missing from the store
//
// Files keep their pathname as the relative path; <dir>/manifest.json lists pathname, size, etag, uploadedAt, sha256 and
// content type. Restore never overwrites an object that is already in the store.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { get, head, list, put } from '@vercel/blob';

const [mode, dirArg, prefix = ''] = process.argv.slice(2);
if (!['backup', 'restore'].includes(mode) || !dirArg) {
  console.error('usage: node scripts/blob-backup.mjs backup|restore <dir> [prefix]');
  process.exit(2);
}
if (!process.env.BLOB_READ_WRITE_TOKEN) { console.error('Set BLOB_READ_WRITE_TOKEN for the store.'); process.exit(2); }
const dir = resolve(dirArg);
const manifestPath = join(dir, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { files: {} };
const safePath = (pathname) => {
  const p = resolve(dir, pathname);
  if (!p.startsWith(dir + sep)) throw new Error(`Unsafe pathname ${pathname}`);
  return p;
};
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

if (mode === 'backup') {
  mkdirSync(dir, { recursive: true });
  let cursor, copied = 0, skipped = 0, failed = 0;
  do {
    const page = await list({ cursor, limit: 1000, prefix: prefix || undefined });
    for (const b of page.blobs) {
      const known = manifest.files[b.pathname];
      const target = safePath(b.pathname);
      if (known && known.etag === b.etag && existsSync(target) && statSync(target).size === b.size) { skipped++; continue; }
      try {
        const r = await get(b.pathname, { access: 'private', useCache: false });
        if (!r || r.statusCode !== 200 || !r.stream) throw new Error(`status ${r?.statusCode}`);
        const data = Buffer.from(await new Response(r.stream).arrayBuffer());
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, data);
        manifest.files[b.pathname] = { size: b.size, etag: b.etag, uploadedAt: b.uploadedAt, sha256: sha256(data), contentType: r.blob?.contentType ?? null };
        copied++;
      } catch (e) {
        failed++;
        console.error(`failed ${b.pathname}: ${e?.message ?? e}`);
      }
    }
    cursor = page.hasMore ? page.cursor : undefined;
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, finishedAt: new Date().toISOString() }, null, 1));
  } while (cursor);
  console.log(JSON.stringify({ copied, skipped, failed, total: Object.keys(manifest.files).length, dir }));
  process.exit(failed ? 1 : 0);
}

// restore
let uploaded = 0, present = 0, failed = 0;
for (const [pathname, meta] of Object.entries(manifest.files)) {
  if (prefix && !pathname.startsWith(prefix)) continue;
  try {
    const exists = await head(pathname).then(() => true, () => false);
    if (exists) { present++; continue; }
    const data = readFileSync(safePath(pathname));
    if (meta.sha256 && sha256(data) !== meta.sha256) throw new Error('checksum does not match the manifest');
    await put(pathname, data, { access: 'private', addRandomSuffix: false, allowOverwrite: false, contentType: meta.contentType ?? undefined });
    uploaded++;
  } catch (e) {
    failed++;
    console.error(`failed ${pathname}: ${e?.message ?? e}`);
  }
}
console.log(JSON.stringify({ uploaded, present, failed, from: relative(process.cwd(), dir) || '.' }));
process.exit(failed ? 1 : 0);
