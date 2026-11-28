# Monitoring and alerts

## Health endpoints (API)

| Endpoint | Auth | Answers | Use it for |
|---|---|---|---|
| `GET /health/live` | none | `200 {ok:true}` when the process answers. Touches nothing. | Is the function up at all |
| `GET /health/ready` | none (per-IP limit `HEALTH_PER_MINUTE`, 60) | `200` when the database answers within 2 s and every migration is applied; otherwise `503` with `db: down \| timeout` or `migrations: pending`. No provider details. | **The uptime probe** |
| `GET /health/details` | `Authorization: Bearer $CRON_SECRET` | Outbox backlog (pending count, oldest pending age, retrying, gave up after 10 attempts, last five errors with correlation ids), the last worker cycle (time, age, duration, ok), each AI job (connected, used today vs. daily ceiling, last success/failure), paid AI jobs, maintenance, and an `alerts` list. `?strict=1` answers `503` while any alert fires. | Alerting on backlog and the worker |
| `GET /health` | none for `{ok:true}`; `Bearer $CRON_SECRET` for driver, env, providers, `paidAi` | Kept for anything already probing it. | Checking provider settings |
| `GET /v1/status` | none | What the website shows: `maintenance` and `degraded` (AI features falling back). Cached 30 s. | The banner |

`/health/details` raises these alerts (thresholds in `apps/api/src/modules/ops.ts`):

- database not ready or migrations pending;
- outbox oldest pending event older than **10 min**;
- any outbox event that gave up after 10 attempts;
- no worker cycle for **26 h** (the Vercel cron runs once a day at 05:00 UTC), or the last cycle failed;
- an AI job that is connected but failing (latest failure in the last 15 min with no success since) or at its daily ceiling.

Both thresholds are settings: `OUTBOX_ALERT_MINUTES` (default 10) and `WORKER_ALERT_HOURS` (default 26).

A request's outbox events are dispatched right after its transaction commits; anything left over is picked up by the
timed work that ordinary requests start in the background (at most once a minute per instance; `catchUp` in
`/health/details` shows its last run) and by the daily cron. An event older than 10 minutes therefore means dispatch is
failing (see `outbox.recentErrors`), or the site has had no traffic since a dispatch failed.

## External probes to set up (owner, outside the repo)

1. **Uptime monitor**. A free plan is enough (Better Stack, UptimeRobot or similar), checking every minute from at least two regions:
   - `GET https://<api host>/health/ready`: alert when it is not `200` for 2 checks in a row.
   - `GET https://<web host>/`: alert when it is not `200` or takes over 10 s. Add a keyword check for `BuildWise`.
   - Send alerts to email and a phone push (the monitor's app). Add a public status page if the plan offers one, and link it from the help page.
2. **Backlog and worker check**. Use a monitor that can send a header (Better Stack, Checkly, or the GitHub Actions
   workflow in [`ops-probe.workflow.yml`](ops-probe.workflow.yml): copy it to `.github/workflows/ops-probe.yml`, then set the
   repository variable `OPS_API_URL` and the secret `OPS_CRON_SECRET`):
   - `GET https://<api host>/health/details?strict=1` with `Authorization: Bearer <CRON_SECRET>`, every 15 min. Alert on `503`.
   - Never put the secret in a URL.
3. **Error tracking (Sentry)**. Create one Sentry organization with two projects, `buildwise-api` (Node) and `buildwise-web` (Next.js). Set:
   - API project: `SENTRY_DSN` (and optionally `SENTRY_ENVIRONMENT`, default `APP_ENV`; `SENTRY_SAMPLE_RATE`, default 1).
   - Web project: `NEXT_PUBLIC_SENTRY_DSN` (inlined at build time, so redeploy after setting it) and optionally `NEXT_PUBLIC_SENTRY_ENVIRONMENT`.
   - Deploys pass `SENTRY_RELEASE=<commit sha>` (see [deploy-and-rollback.md](deploy-and-rollback.md)) so errors are grouped by release.
   - In Sentry, turn on **Data Scrubbing** and **Scrub IP addresses** in both projects as a second layer (BuildWise already scrubs phone numbers, emails, tokens, cookies and auth/chat request bodies in `beforeSend`).
   - Alert rules: a new issue in production; **more than 20 events in 5 min** in either project (a spike); any event tagged `job:worker-cycle`.
4. **5xx rate**. Vercel Observability on the `buildwise-api` project: alert when 5xx responses exceed **2% of requests over 10 min** (or more than 20 5xx in 10 min while traffic is low). The API also logs every 5xx as `level: 50` with `msg: "request failed"`, so a log drain (Better Stack Logs, Axiom) can alert on it instead.

## What each alert means

| Alert | First look | Runbook |
|---|---|---|
| `/health/ready` down, `db: down` or `timeout` | Neon console: compute suspended, over quota, or an incident | [incident-response.md](incident-response.md), [database-restore.md](database-restore.md) |
| `/health/ready` `migrations: pending` | A deploy's migration failed part way: `vercel logs` for the cold start | [deploy-and-rollback.md](deploy-and-rollback.md) |
| `/health/live` down | Vercel status, the last deployment | [deploy-and-rollback.md](deploy-and-rollback.md) |
| Outbox old / gave up | `/health/details` `outbox.recentErrors` (`lastError`, `correlationId`) | [sms-pumping.md](sms-pumping.md) if SMS, else the provider in the error |
| Worker stale | Vercel → Cron Jobs on `buildwise-api`; run it by hand: `curl -H "Authorization: Bearer $CRON_SECRET" https://<api host>/v1/internal/cron` | [incident-response.md](incident-response.md) |
| AI job failing / at ceiling | `/health/details` `ai.jobs` | [ai-provider-outage.md](ai-provider-outage.md) |
| Error spike | Sentry issue, its `correlation_id` tag → logs | [incident-response.md](incident-response.md) |
| Document failures | `document_revisions` in `failed` | [document-processing.md](document-processing.md) |
