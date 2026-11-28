# SMS-pumping spike

SMS pumping ("toll fraud"): bots request sign-in codes for many numbers, often premium or foreign ranges, so a
carrier is paid per message. Signs: the SMS bill or provider balance drops fast; `otp_codes` grows far faster than
new users; codes requested and never used; numbers outside Nigeria.

Limits already in place: per number and per IP per hour, and per device (market pack `limits.otpPerNumberPerHour` 3,
`otpPerIpPerHour` 10, in `packages/domain/src/market.ts`), the global per-IP request limit, and numbers must parse as
the market's phone format. Pumping gets round per-IP limits with many IPs.

## 1. Confirm (Neon SQL editor)

Codes are kept 2 days (the worker deletes older rows).

```sql
-- Requests per hour, distinct numbers and IPs, and how many codes were used.
select date_trunc('hour', created_at) as hour, count(*) as codes, count(distinct phone_e164) as numbers,
       count(distinct ip) as ips, count(*) filter (where consumed_at is not null) as used
  from otp_codes where created_at > now() - interval '48 hours' group by 1 order by 1 desc;

-- Number ranges being hit.
select left(phone_e164, 7) as range, count(*), count(*) filter (where consumed_at is not null) as used
  from otp_codes where created_at > now() - interval '6 hours' group by 1 order by 2 desc limit 20;

-- Sources.
select ip, device_id, count(*), count(distinct phone_e164) as numbers
  from otp_codes where created_at > now() - interval '6 hours' group by 1, 2 order by 3 desc limit 20;
```

A normal hour has most codes used. Pumping shows many numbers, few or no codes used, and clustered ranges.

## 2. Stop the spend (in this order, smallest first)

1. **Provider controls** (fastest, no deploy). Twilio: Console → Messaging → *Geo permissions*: allow Nigeria only; turn on *SMS Pumping Protection* (Verify Fraud Guard if Verify is used). Termii: restrict to Nigerian routes and set a low balance alert / auto top-up off.
2. **Block at the edge.** Vercel Firewall on the **web** project (people reach the API through `/api/v1/...`): a custom rule *rate limit* on path `/api/v1/auth/otp/request`, e.g. 5 per IP per 10 min, and *deny* the worst IPs/ASNs from the queries above. Turn on Attack Challenge Mode while the attack lasts.
3. **Lower the limits** in the market pack (`otpPerIpPerHour`, `otpPerNumberPerHour`) and deploy. This is a code change: go through `main`.
4. **Last resort: stop sending codes.** `SMS_PROVIDER=none` on the API and redeploy. In production nobody can sign in (codes are not shown), so pair it with `DEGRADED_MESSAGE="Sign-in is paused for a short while. If you are signed in you can carry on."` On the staging-mode beta codes are shown on screen, so sign-in still works, and that is safe only while `EXPOSE_OTP` is meant to be on.

## 3. After

- Ask the provider for a credit for fraudulent traffic (Twilio and Termii both review pumping cases). Send them the ranges and times.
- Keep the firewall rule if it did not block real people. Record the cost and the time to stop it in the incident log.
- Consider: a challenge (Vercel BotID) on the sign-in form, and an allow-list of mobile number prefixes in the market pack.
