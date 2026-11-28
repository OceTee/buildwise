# Database restore (Neon point-in-time) and the restore drill

The API's `DATABASE_URL` points at a Neon Postgres project. Neon keeps a history of every change for the project's
**restore window**, and any moment inside it can be restored. Objectives (§21.2): RPO ≤ 5 min, RTO ≤ 4 h.

**Set up once (owner):** Neon console → project → Settings → Storage → *History retention*: at least 7 days (the
Free plan keeps a much shorter window; 7 days or more needs a paid plan). Write the window into the incident log
template, so whoever restores knows how far back they can go.

## When to restore

Rows deleted or overwritten by a bug, a bad migration, or someone with database access. Not for an outage (Neon
down): wait for Neon, keep `MAINTENANCE_MODE=on` if writes fail half way.

## Restore

1. **Stop writes.** Set `MAINTENANCE_MODE=on` and a `MAINTENANCE_MESSAGE` on the API project and redeploy
   ([deploy-and-rollback.md](deploy-and-rollback.md)). Reads keep working against the damaged data until the switch.
2. **Find the moment.** Pick a time just before the damage, in UTC. Use the audit log (`select at, action, target_type, target_id from audit_events order by seq desc limit 50`), the API logs and Sentry for the first bad request.
3. **Restore into a new branch first** and check it there. In the Neon console: Branches → *Create branch* → from `main` *at a point in time*. With the CLI:

   ```bash
   neonctl branches create --project-id <project id> --name restore-<yyyymmdd-hhmm> --parent main@2026-11-27T10:15:00Z
   neonctl connection-string restore-<yyyymmdd-hhmm> --project-id <project id> --pooled
   ```

4. **Check the branch.** Connect with `psql "<branch url>"` and confirm the lost rows are there and nothing newer you need is missing. Then run the API against it locally, read-only checks only:

   ```bash
   DATABASE_URL="<branch url>" APP_ENV=staging pnpm --filter @bw/api start   # needs the deployed secrets; or just query with psql
   curl -s localhost:4000/health/ready
   ```

5. **Put it live.** Either:
   - **Restore `main` in place** (keeps the same connection string): Neon console → Branches → `main` → *Restore* to the same time, or
     `neonctl branches restore main ^self@2026-11-27T10:15:00Z --preserve-under-name main-before-restore-<yyyymmdd>`.
     Neon keeps the damaged state as a backup branch.
   - **Or point the API at the checked branch**: set `DATABASE_URL` (pooled string) on `buildwise-api` to the branch, redeploy. Use this when you need part of the newer data too and will copy it across by hand.
6. **Changes after the restore point are gone.** List what happened in between (logs, outbox rows in the backup branch: `select event_type, occurred_at, payload from outbox where occurred_at > '<restore time>'`) and tell the people affected.
7. **Uploaded files are not rolled back.** Blob objects uploaded after the restore point have no rows any more, which is harmless. Rows that point at objects deleted after the point need the Blob backup ([blob-backup.md](blob-backup.md)).
8. Check the audit chain still verifies (staff audit page `/moderation/audit`). Turn `MAINTENANCE_MODE` off, redeploy, watch `/health/details`.

## Quarterly restore drill (§21.3)

Restore a full sample project, not just a database that starts. Record each step's time in the incident log; the total is the measured RTO.

- [ ] Pick a project with documents, an estimate and an RFQ. Note its id and a recent change time.
- [ ] Create a branch at a point 1 h back (step 3). Time it.
- [ ] Connect: the project, its documents, revisions, estimate versions and orders are there, with the counts you expected.
- [ ] Audit chain: `select count(*) from audit_events` matches the source branch at that time, and the hashes chain (every `prev_hash` equals the previous row's `hash`, in `seq` order).
- [ ] Files: for 5 document revisions, the `storage_key` exists in the Blob backup and its `sha256` matches the row.
- [ ] Run the API locally against the branch with `STORAGE=local` pointed at a restored Blob backup folder (`STORAGE_DIR`), sign in as the project owner and download a document. Export works.
- [ ] Delete the drill branch: `neonctl branches delete restore-<…> --project-id <project id>`.
- [ ] Write down the RTO and anything that was hard.
