# Suspected account takeover

Signs: a user reports listings, messages or quotes they did not make; sign-ins from new devices (`/v1/me/sessions`);
a seller's phone number changed; a staff account doing things its owner did not do (`/moderation/audit`).

Accounts sign in with a phone code only, so a takeover usually means the attacker received the code: a SIM swap,
a code read out to a scammer, or someone with the phone. Treat a **staff** account as S1 ([incident-response.md](incident-response.md)).

## 1. Cut access (within minutes)

If the real owner can still sign in, they can sign out every session themselves: Account → *Sign out everywhere*
(`POST /v1/me/sessions/revoke {"everywhere": true}`). Otherwise use SQL in the Neon console (SQL editor on `main`),
in one transaction. Every API request checks the session row, so revoked sessions stop at once.

```sql
begin;
-- Who: by user id, or find it from the phone number the owner gives you.
select id, display_name, status, is_staff, staff_role, created_at from users where phone_e164 = '+234…';

-- Sign out every session.
update sessions set revoked_at = now() where user_id = '<user id>' and revoked_at is null;

-- Stop new sign-ins until the owner is verified (sign-in refuses accounts that are not active).
update users set status = 'suspended' where id = '<user id>';

commit;
```

Then write what you did, why, and the time in the incident log. These statements bypass the API, so they are **not**
in the hash-chained audit log; the incident log is the record.

**A staff account:** take the role away on the staff screen, not in SQL. An operations admin opens `/moderation/staff`
→ the person → *Revoke* with a reason (`POST /v1/moderation/staff/:userId/revoke`). It needs a fresh two-step code,
and it records the change in `staff_role_changes` and the audit log. If the attacker may have the authenticator, also
*Reset two-step verification* (`/mfa-reset`), so the real owner enrols a new one. If the compromised account is the
**only** operations admin, the screen refuses. Grant a second one first with
`DATABASE_URL=<postgres url> pnpm --filter @bw/api staff:grant --phone <number> --reason "<why>"` (README → *Data rights
and staff access*), then revoke.

If you suspect the signing key itself (`AUTH_SECRET`) leaked: rotate it in the API project and redeploy. Every session
and every signed file link stops working at once, for everyone.

## 2. Contain the damage

- Listings the attacker created or edited: `select id, title, status, updated_at from listings where seller_org_id in (select org_id from org_members where user_id = '<user id>') order by updated_at desc;` Close or send back to review from `/moderation`.
- Messages sent: check threads of the account's organizations in `/moderation`; warn the people they wrote to if money was asked for.
- Staff account: read `/moderation/audit` for the actor since the first suspicious time; reverse decisions (restrictions, appeals, verifications) with a second moderator.
- Organization members added by the attacker: `select * from org_members where org_id in (…) order by created_at desc;`

## 3. Give the account back

1. Confirm the owner by a channel the attacker cannot use: the business email on file, a call to the phone after the SIM is replaced, or ID shown to staff. Note how you checked.
2. If the number itself was taken (SIM swap), wait until the owner has the SIM back from the network.
3. `update users set status = 'active' where id = '<user id>';` Staff access goes back only through a new grant on `/moderation/staff` (an operations-admin grant waits for a second operations admin), after the owner of BuildWise approves.
4. Tell the owner what happened, what was changed, and to never read a code out to anyone.
