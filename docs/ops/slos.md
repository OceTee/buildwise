# Service objectives for the public beta

The targets are the spec's §21.1 starting targets for the website launch (R1) and the project pilot (R2). They are
*proposed* until ratified (D-10). During the beta they are what we measure against and how we decide whether to
stop shipping features, not a promise to users. Marketing must not quote uptime we have not measured.

Error budget: when an objective is missed for a calendar month, feature releases on that path stop until the fix
ships. The weekly ops check (Monday) records each number below in the incident log.

| Path | Objective (beta) | How it is measured today | Gap |
|---|---|---|---|
| API availability | 99.5% of requests succeed each month (4xx excluded) | Vercel Observability on `buildwise-api`: 5xx ÷ all requests. Each 5xx is also logged as `msg: "request failed"`. The uptime monitor on `/health/ready` gives a second, outside view (minutes up ÷ minutes in the month). | No SLO dashboard yet. Read the two numbers weekly. |
| API latency | P95 under 500 ms for reads, under 1 s for writes | Every request logs `durationMs`, `method` and `route` (the route template). Vercel Observability shows function duration percentiles per path. | The AI routes (`/v1/build/design`, `critique`, `architect`, `chat`, `render`, `dream`) take minutes by design. Exclude them. |
| Search | P95 under 400 ms server time | `durationMs` on `GET /v1/search` log lines | Same as above |
| Public pages | Core Web Vitals "good" at P75 (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1) | Vercel Speed Insights on the web project, if enabled; otherwise PageSpeed Insights on `/`, `/market`, `/build` weekly | Field data needs traffic. Lab data until then. |
| Phone verification | P95 under 60 s from request to delivery | Termii/Twilio dashboard delivery times. In the database: `otp_codes.created_at` → `consumed_at` for codes that were used. | Delivery receipts are not stored. |
| Chat and quote notifications | P95 under 60 s from send to first channel | `outbox.occurred_at` → `dispatched_at` for `MessageSent` and `QuoteRequested` | Events go out right after the request commits. SMS delivery time is not stored. |
| Moderation | P90 first decision within 4 business hours of a held listing | `listings` submitted → first `moderation_decisions` row; staff queue at `/moderation` | Weekly query by hand |
| Promotion activation | P99 under 60 s from webhook to live | The payment webhook marks the purchase paid and starts it in the same request: request `durationMs` on the webhook (`POST /v1/webhooks/paystack`, or `/v1/webhooks/checkout` for the simulated checkout) | Simulated payments in the beta |
| Document processing | P95 under 5 min to previews for ≤ 50 pages | `document_revisions.created_at` → `available_at` | Retries run with the timed work after requests and the daily cron. See [document-processing.md](document-processing.md). |
| Estimate issue | P95 under 2 min from issue to report | Request `durationMs` on the issue command | Report is generated in the request |
| Recovery | RPO ≤ 5 min, RTO ≤ 4 h for the database | Neon point-in-time restore. See [database-restore.md](database-restore.md). The quarterly drill records the real RTO. | Blob has no point-in-time copy: RPO is the age of the last backup ([blob-backup.md](blob-backup.md)) |

## Weekly queries

```sql
-- Outbox delay by event type, last 7 days (notification objective).
select event_type, count(*),
       percentile_cont(0.95) within group (order by extract(epoch from dispatched_at - occurred_at)) as p95_seconds
  from outbox where occurred_at > now() - interval '7 days' and dispatched_at is not null
 group by 1 order by 3 desc;

-- Document processing time, last 7 days.
select count(*) filter (where state = 'available') as done, count(*) filter (where state = 'failed') as failed,
       percentile_cont(0.95) within group (order by extract(epoch from available_at - created_at)) as p95_seconds
  from document_revisions where created_at > now() - interval '7 days';

-- AI calls against the daily ceilings (an AI job at its ceiling falls back to the engine).
select day, kind, n from ai_usage where day > current_date - 7 order by day desc, kind;
```
