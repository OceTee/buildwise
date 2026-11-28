# Operations

How BuildWise is run during the public beta (spec §21, §28). One live deployment: the API as one Vercel Function
(project `buildwise-api`, region `fra1`, `APP_ENV=staging`) on Neon Postgres and a private Vercel Blob store, and
the website as a separate Vercel project.

| Page | When |
|---|---|
| [monitoring.md](monitoring.md) | Setting up probes and alerts; what each health endpoint says |
| [slos.md](slos.md) | Beta service targets and how each is measured today |
| [incident-response.md](incident-response.md) | Anything is broken: start here |
| [deploy-and-rollback.md](deploy-and-rollback.md) | Shipping a commit, undoing a bad deploy |
| [database-restore.md](database-restore.md) | Data lost or corrupted; the quarterly restore drill |
| [blob-backup.md](blob-backup.md) | Backing up and restoring uploaded files |
| [account-takeover.md](account-takeover.md) | Someone else is using an account, or a staff account is compromised |
| [sms-pumping.md](sms-pumping.md) | Sign-in code requests or SMS spend spike |
| [document-processing.md](document-processing.md) | Uploaded drawings stay "processing" or fail |
| [ai-provider-outage.md](ai-provider-outage.md) | Claude, Gemini or OpenAI down, slow or out of quota |
| [data-deletion.md](data-deletion.md) | Someone asks for their data to be deleted |

## Switches

| Variable (API project unless noted) | Effect |
|---|---|
| `MAINTENANCE_MODE=on` | Every write (POST/PUT/PATCH/DELETE) answers `503 MAINTENANCE` with `retry-after: 300`; reads keep working. The website shows the message in a banner. Payment webhooks are writes too: Paystack retries them, so nothing is lost while it is on. The design tool (`/v1/build/*`) keeps working: it writes only caches and anonymous assistant rows. |
| `MAINTENANCE_MESSAGE` | The text of that banner and error. On the **web** project it shows the banner even when the API is unreachable. |
| `DEGRADED_MESSAGE` | A notice shown site-wide while an outside service is down (set by hand). Without it, the banner appears by itself when an AI job is failing or at its daily ceiling. |
| `LOG_LEVEL` | `info` by default when deployed, `warn` locally. `debug` for a short investigation only. |
| `SENTRY_DSN` / `NEXT_PUBLIC_SENTRY_DSN` (web) | Error tracking. Unset: nothing loads, nothing is sent. |

Env changes on Vercel apply to new deployments only: after `vercel env add`, run `vercel redeploy <current production url>`
(see [deploy-and-rollback.md](deploy-and-rollback.md)).

## Finding one request

Every API response has an `x-correlation-id` header, and every error body has `error.correlationId`. The same id is
on the request's log line (`correlationId`), on any outbox event it wrote (`outbox.correlation_id`) and on the
error report (Sentry tag `correlation_id`). Worker cycles use `worker-<uuid>`.

```bash
vercel logs <deployment-url> --json | grep '<correlation id>'
```

```sql
select event_type, occurred_at, dispatched_at, attempts, last_error from outbox where correlation_id = '<id>';
```

Log lines name users by `userHash` (an HMAC of the user id with `AUTH_SECRET`), never by phone or email. To find the
hash for a user you are investigating, run in the API directory:
`node -e "console.log(require('crypto').createHmac('sha256', process.env.AUTH_SECRET).update('user:<user id>').digest('hex').slice(0,16))"`.
