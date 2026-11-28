# Document-processing outage

An upload goes `awaiting_upload` → `quarantined` (file stored under `quarantine/<revision>`) → `scanning` →
`processing` → `available` (shared copy at `active/<revision>`), or `rejected` (a problem with the file: type, size,
password, malware, too many pages) or `failed` (our problem; the original is kept). Processing starts in the
background of the upload request (`waitUntil` on Vercel). The worker retries anything left in `quarantined`,
`scanning` or `processing` for over 2 minutes, and `failed` up to 3 attempts. On Vercel that timed work runs in the
background after ordinary requests (at most once a minute per instance, `catchUp` in `/health/details`) and in the daily
cron, so on a quiet site a failed upload waits for the next visitor or the cron, unless you run the cron by hand.

Signs: people report files stuck at "processing" or "failed"; Sentry issues tagged `job:document-processing` (each has
the `revision` tag); the weekly query in [slos.md](slos.md).

## 1. See what is stuck

```sql
select state, count(*), min(created_at) as oldest, max(attempts) as max_attempts
  from document_revisions where state in ('quarantined', 'scanning', 'processing', 'failed') group by 1;

select id, project_id, original_name, detected_type, bytes, state, state_detail, attempts, created_at
  from document_revisions where state in ('scanning', 'processing', 'failed') order by created_at desc limit 20;
```

## 2. Find the cause

| What you see | Likely cause | Fix |
|---|---|---|
| Every new upload fails, Sentry shows a storage error | Blob store down, token expired or store suspended | Vercel status, Storage → the store. Rotate `BLOB_READ_WRITE_TOKEN` if needed, redeploy. |
| `state_detail` "The upload did not arrive" | The browser's direct upload to Blob did not finish | The person uploads again. If many: check the presigned upload in the browser's network tab. |
| PDFs fail, images pass | `pdfjs-dist` failed to load in the bundle (a deploy changed it) | Sentry stack trace; roll back ([deploy-and-rollback.md](deploy-and-rollback.md)) |
| Images fail with sharp errors | `sharp` binary missing for the runtime | Roll back; check `pnpm install --frozen-lockfile` in the build log |
| Stuck in `scanning`/`processing`, no errors | Function timed out mid-run | Retries pick them up after 2 min; very large files may need the limits in the market pack (`projects.maxUploadBytes`, `maxPdfPages`) lowered |

## 3. Retry

After the cause is fixed, run one worker cycle (it retries up to 20 revisions per cycle; run it again until the queue is empty):

```bash
curl -s -H "Authorization: Bearer $CRON_SECRET" https://<api host>/v1/internal/cron | jq .
```

Revisions that used up their 3 attempts stay `failed`. To give them another go:

```sql
update document_revisions set attempts = 0 where state = 'failed' and created_at > now() - interval '7 days' returning id;
```

Then run the cron again. Never move a `rejected` revision back: the file itself was refused, and the person was told why.

## 4. Tell people

If uploads are down for more than 30 minutes, set `DEGRADED_MESSAGE="Uploaded drawings are taking longer than usual to process. Your files are safe and will appear when processing resumes."`
and redeploy; clear it afterwards.
