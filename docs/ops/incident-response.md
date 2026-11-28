# Incident response and comms

For anything that stops people using BuildWise, risks their data or money, or costs us money fast (SMS, AI).

## 1. Declare (first 5 minutes)

- One person is **incident lead** until they hand over in writing. During the beta that is the owner unless they name someone else.
- Open an entry in the incident log (a shared doc: time, lead, what is seen, severity). Write everything there as you go: times in WAT, what you ran, what you saw.
- Severity:
  - **S1**: site or sign-in down for everyone, data exposed, money moving wrongly, account takeover of a staff account. Work on it now, all hands.
  - **S2**: a main path broken for many (posting, search, projects, design), or SMS/AI spend out of control. Work on it now.
  - **S3**: one feature degraded with a fallback (AI designs simpler, slow previews). Fix the same day.

## 2. Stabilise

Pick the smallest switch that stops the harm (env changes need a redeploy: see [deploy-and-rollback.md](deploy-and-rollback.md)):

| Harm | Switch |
|---|---|
| Bad deploy | `vercel rollback` to the last good deployment |
| Writes corrupting data, or a restore in progress | `MAINTENANCE_MODE=on` (+ `MAINTENANCE_MESSAGE`) on the API: writes get 503, reads work, banner shows |
| API unreachable | `MAINTENANCE_MESSAGE` on the **web** project: the banner shows without the API |
| AI provider down or burning money | Set that job's `*_PROVIDER=none` ([ai-provider-outage.md](ai-provider-outage.md)) |
| SMS pumping | [sms-pumping.md](sms-pumping.md) |
| Compromised account | [account-takeover.md](account-takeover.md) |
| Secret leaked | Rotate it in the provider and in Vercel env, redeploy. Rotating `AUTH_SECRET` signs everyone out and voids every file link. |

## 3. Diagnose

1. `/health/ready` and `/health/details` (with `CRON_SECRET`): database, migrations, outbox, worker, AI.
2. Sentry: the newest issues on both projects, filtered by release. Each event has the `correlation_id` tag.
3. Logs: `vercel logs <deployment-url> --json`, filter on `correlationId`, `route` or `status` ≥ 500.
4. Status pages: Vercel, Neon, Termii/Twilio, Anthropic, Google AI, OpenAI.
5. What changed: `vercel ls buildwise-api` (last deploys), `git log origin/main`, env changes in the Vercel dashboard.

## 4. Communicate

- **S1/S2**: within 30 minutes, set `MAINTENANCE_MESSAGE` or `DEGRADED_MESSAGE` with plain words. Update it when the situation changes. If the uptime monitor has a status page, post there too.
- Message pattern: what is affected, what still works, what to do, when we next update. For example: "Posting ads is paused while we fix a problem. Browsing and messages work. Next update by 15:00 WAT."
- No blame, no guesses about cause in public. Never ask people for codes or passwords.
- **Personal data exposed or likely exposed**: the owner decides within 24 h whether the Nigeria Data Protection Commission must be told (NDPA 2023: within 72 h of becoming aware) and whether affected people must be told. Keep the evidence (logs, queries, Sentry events) and do not delete rows that prove what happened.
- Tell the affected users directly (email, or SMS for sign-in problems) only once you know who they are.

## 5. Recover and close

- Turn the switches back off (and redeploy), check `/health/details` shows no alerts, and watch Sentry for 30 minutes.
- Within 5 working days write a short review in the incident log: timeline, impact (who, how many, how long), cause, what worked, actions with owners. Add a test or an alert for anything we found out about by luck.
- Update the runbook you used if a step was wrong or missing.
