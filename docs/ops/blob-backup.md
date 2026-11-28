# Blob backup and restore

Uploaded files (listing photos, project documents and their previews, proof-of-delivery photos, invoices) live in a
**private** Vercel Blob store under keys such as `photos/<id>/card.webp`, `active/<revision id>` (the shared copy of a
document) and `quarantine/<revision id>` (the original as uploaded). `document_revisions.storage_key` and `sha256`
hold each document's key and the hash of the original.

Vercel Blob has **no versioning and no point-in-time restore**: a deleted or overwritten object is gone. Our only
copy is the backup below, so the Blob RPO is the age of the last backup.

## Back up

Run from the API package on a trusted machine with an encrypted disk. The token is the store's read-write token
(Vercel → Storage → the Blob store → `.env.local` tab, or `vercel env pull`). Keep it out of shell history.

```bash
cd apps/api
read -rs BLOB_READ_WRITE_TOKEN && export BLOB_READ_WRITE_TOKEN
node scripts/blob-backup.mjs backup /secure/backups/buildwise-blob
```

- Incremental: objects already copied with the same etag and size are skipped. `manifest.json` in the folder records pathname, size, etag, upload time, sha256 and content type.
- Exit code 1 if any object failed. Re-run until it is 0.
- Schedule: **weekly**, and before any deploy that changes storage code, deletes files, or runs a data clean-up. Keep 4 weekly copies (snapshot the folder, e.g. `restic` or `tar` + `age`, to a second place).
- The backup holds people's documents and photos: treat it as production data (encrypted at rest, only the owner can read it, delete old copies after 90 days).

**Owner, outside the repo:** choose the machine or bucket for this, and put the weekly run in a calendar or a cron on that machine. A GitHub Actions job is **not** suitable: artifacts would put private documents in GitHub.

## Restore

```bash
node scripts/blob-backup.mjs restore /secure/backups/buildwise-blob            # everything missing from the store
node scripts/blob-backup.mjs restore /secure/backups/buildwise-blob documents/ # one prefix
```

- Uploads only objects that are **missing** from the store (it never overwrites), after checking each file's sha256 against the manifest.
- To check one document against its row: `select storage_key, sha256 from document_revisions where id = '<revision id>'` and compare with the manifest entry.
- After a database restore ([database-restore.md](database-restore.md)), restore the Blob backup too, so rows that point at objects deleted since have their files again.
- Restoring into a different store (a drill): use that store's token. To run the API against a local copy instead, set `STORAGE=local STORAGE_DIR=/secure/backups/buildwise-blob`: the local adapter reads the same keys.

The script was written against `@vercel/blob` 2.9 (`list`, `get`, `head`, `put`) and checked locally only. Do the
first backup with the owner watching, and test a restore into a scratch store before you rely on it.
