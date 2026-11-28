# Data deletion request

Under the Nigeria Data Protection Act 2023 a person can ask us to delete their personal data. Answer within
**30 days** (sooner is better), and keep a record of the request and what was done.

## 1. Check who is asking

Only delete for the account holder. Ask them to send the request **while signed in** (Account page or the help
contact) or from the email on the account. Never accept a phone number alone over chat: that is how takeovers
start ([account-takeover.md](account-takeover.md)).

## 2. The account holder does it themselves

Account → *Delete account* (`DELETE /v1/me` with `{"confirm":"DELETE"}`, `deleteAccount` in `apps/api/src/modules/privacy.ts`).
The page shows the plan first (`GET /v1/me/deletion`). In one transaction it:

- closes their listings and those of businesses they own alone (those businesses stop trading);
- leaves shared businesses and projects, and archives projects they own alone;
- removes their reviews, saved searches, favourites and notifications, and signs out every session;
- clears their name, phone number and email at once. They are held 30 days, then erased by the worker's retention job.

They can download their data first (Account → *Download my data*, `POST /v1/me/export`). Point them to it.

## 3. When they cannot sign in

There is no staff tool yet to delete someone else's account. **Do not hand-edit rows:** deletion does far more than
any short SQL (see the list above, plus the retention clock), and a partial deletion is worse than none.

1. Confirm who they are by another route (the business email on file, ID shown to staff) and note how.
2. Help them back in. If the number was lost or recycled, they get the SIM replaced by their network and sign in again.
   If they have a new number, they can change it while signed in on any device (`/v1/me/phone/request`).
3. They delete the account themselves, with you on the phone if needed.
4. If that is impossible, record the request and the reason, and raise a ticket for a staff-assisted deletion tool. It
   must call the same `deleteAccount`, be audited, and need an operations admin with a fresh MFA step-up. The legal
   deadline still runs, so escalate to the owner within a week.

## 4. What is kept, and why

Tell the person what stays and for how long (the Account page and the privacy notice say the same):

- **Records others rely on:** the audit log, issued estimates, awards, orders, invoices, payment records and cases. They keep user ids only; the name shows as "Deleted user".
- **Chats:** they stay for the other party, and are redacted 2 years after the last message unless a report holds them.
- **Contact-reveal logs:** 12 months, with device ids removed after 30 days.
- **Backups:** Neon history and Blob backups age out on their own schedule (the restore window, and 90 days for Blob copies). Say so in the reply.
- **Logs and error reports:** no phone numbers or emails (scrubbed); users appear as a hash. Vercel and Sentry retention is short (check the plans).

The windows are in the market pack (`privacy`); README → *Data rights and staff access* has the full list.

## 5. Reply

Confirm what was deleted, what was kept and why, and when backups expire. Record the date of request, the date done,
and who did it.
