# BuildWise

An AI building assistant and a construction marketplace. Opening the site asks **"What would you like to build today?"**: you give your land size and the home you want, see the plot and the house in 3D at true scale, pick a design checked against architects' rules, get every material counted, and see where to buy each one and what it costs. People who only want to shop go straight to the marketplace: building materials, tools, plant hire, trades, professionals and logistics, listed by area. This is **Releases 1 and 2** of the platform described in [`docs/spec`](docs/spec/construction-platform-full-build-technical-specification-v3.md) (§3).

Buyers search by category and area, compare prices per unit (cement per kilogram across 25 kg and 50 kg bags, for example), chat with sellers, see a seller's phone number, and send quote requests. Sellers post free listings up to each category's allowance and can pay for labelled promotions. Every listing goes through automated checks, and new sellers are reviewed by a person. BuildWise does not hold payments for goods or services.

> **Demo market.** The bundled market pack (`demo-2026.1`) is illustrative. Its places, prices, tax rate, limits and fees are configuration values marked *proposed* in the spec, not decisions. Change them in the market pack, not in code.

## What's in Release 1

| Area | Included |
|---|---|
| Accounts | Phone sign-in with one-time codes and limits per number, IP address and device; checks for recycled numbers; businesses with reserved names; signed-in device list and sign-out everywhere; account deletion |
| Listings | Versioned category configuration; required attributes; pack sizes for per-unit comparison; listing states (draft → review → live → expired/closed); renewing a listing requires confirming the price; offline draft in the browser |
| Checks | Contact details, payment instructions and scam phrases in text; reused photos (perceptual hash); price outliers; new-account limits; a risk score; auto-publish only for established sellers |
| Moderation | Review queue ordered by risk; reason codes the seller sees; QA sampling; reports, where enough reports send a listing back to review; restrictions that need a second moderator for verified businesses or impersonation; one appeal per decision, decided by a different moderator; hash-chained audit log |
| Contact | Chat with safety warnings and held messages; phone reveal with limits; quote requests; reviews only after a real interaction; favourites; saved searches with alerts |
| Promotions | Top placement and visibility packages, always labelled; hosted checkout confirmed only by a signed webhook; invoices; paused promotions resume, and time is credited or forfeited when a listing leaves live |
| Web | Pages rendered on the server with canonical URLs, JSON-LD, a sitemap, `noindex` on thin pages and 410 for long-gone listings; light and dark themes; WCAG 2.2 AA tested |

## The build assistant

| Step | What happens |
|---|---|
| Welcome (`/`) | Describe what you want in your own words. The BuildWise assistant reads it into a plot size and a design brief, answers building questions, and politely declines anything else (`/v1/build/interpret`). "Just shopping?" goes to the marketplace (`/market`). |
| Land | Width and depth in feet or metres, or a common plot size. The plot appears in 3D straight away: one scene unit is one metre, with the boundary, corner beacons, the road, a 1 m grid and the setback line. |
| Plan | Have drawings already? Reading uploaded plans is the next slice; for now the person describes the rooms. |
| Your home | Bedrooms, bathrooms, storeys, kitchen, study, guest WC, store, parking, roof and style, by chat or controls. The house updates live on the plot. |
| Designs | Up to three layouts generated for the plot (`generateDesigns` in `packages/domain/src/design.ts`): room bands around a hallway, run across or along the plot, sized to the programme rather than stretched to the land. Each is checked for setbacks, site coverage, ceiling height, room sizes, daylight and ventilation, wet-room ventilation, corridor and door widths, bedroom access, entrance, a ground-floor toilet, the stair, and parking. Outside view or a floor-by-floor plan with room labels. Always labelled as concept designs, not stamped drawings. |
| Materials | A bill of materials from the same geometry (`billOfMaterials`): excavation, filling, DPM and mesh, 9" and 6" blocks with waste, cement bags for concrete, mortar and plaster, sharp and plaster sand, granite, 12 mm and 8 mm bars, roofing sheets and timber (or waterproofing for flat roofs), doors, windows, tiles, ceilings, paint and provisional services. Every line says how it was worked out. |
| Where to buy | Each line searched in the live marketplace (`/v1/build/sourcing`): cheapest comparable offer first, a line total when the units match, and the total for everything priced. |

### The BuildWise assistant

A small model of our own that runs inside the API: no external AI service, no per-message cost. It does the build flow's jobs and nothing else.

- **Intent**: a naive Bayes classifier over words and word pairs decides whether a message is a home brief, shopping, another kind of project, a building question, a greeting or thanks, or off-topic. It is trained on labelled seed examples (`packages/domain/src/assistant-seed.ts`) plus examples confirmed on the platform.
- **Brief**: explicit rules read plot sizes and rooms; a learned phrase list adds local wording (for example, a word people use for a two-storey house).
- **Answers**: BM25 search over a knowledge base of starter answers, staff answers, and facts built from the platform's own data (typical live prices per material and unit, reference rates). An answer must actually be about the question, or the assistant says it does not know and logs the question for staff.
- **Scope**: messages with no building words get "I can only help with building". Replies come from fixed templates, never free text.

How it learns from the platform (`apps/api/src/modules/assistant.ts`, run by the worker and the daily cron, at most every 6 hours):

| Signal | What it teaches |
|---|---|
| Someone continues from a message to the designs | That message was a home brief |
| Someone is sent to the marketplace | That message was shopping |
| Brief values changed by hand after the assistant read a message | Phrases: a phrase is learned only when at least 3 different sessions confirm the same meaning with 75% agreement |
| Thumbs up or down on a reply | Unhelpful exchanges are excluded from training |
| Live listings and rate observations | Price facts in the knowledge base, refreshed each run |
| Live listing titles | Building vocabulary for the scope check |
| Staff labels and answers (Staff, then Assistant) | Labels count three times; answers are used immediately |

Safeguards: messages are stored with phone numbers and emails removed, against an anonymous session hash, for 180 days; one session contributes at most 20 examples; only the session that sent a message can report what happened next; and a retrained model replaces the current one only if it scores at least 90% on held-out tests and no more than 2 points below the current model.

All rule values (setbacks, coverage, minimum room sizes and widths, daylight ratio, stair and door sizes, mix ratios, block size, waste) are in the market pack's `design` section and are *proposed* until a registered architect confirms them for a market. The engine is pure TypeScript, so the browser and the API compute identical designs.

## What's in Release 2

A private project workspace beside the marketplace (spec §7–§12, §14.1).

| Area | Included |
|---|---|
| Projects | Progressive intake with "I'm not sure" answers and a missing-information list; readiness checklist with one of three outcomes; project roles (owner, manager, collaborator, viewer, reviewer) behind one policy check, with row-level security as a second layer; invitations by phone number; reason-coded, time-boxed, audited staff access that notifies the owner |
| Documents | Upload through short-lived signed links; malware scan, file-type detection from content, PDF page count and size, rejection of encrypted PDFs, image metadata stripping; revision register by discipline; a new upload must name the revision it supersedes, and measurements on the old revision are flagged; attributed status labels; restricted documents; signed, expiring downloads |
| Takeoff | PDF viewer with page navigation and zoom; scale calibration with an optional second-dimension check; count, length, perimeter, area and volume; a manual-measurement form with a required formula as the keyboard alternative |
| RFIs | Linked to a drawing page or estimate line; immutable question, response and decision history |
| Estimates | Indicative range from configured benchmarks ("not enough local data" when there isn't any); client-specified estimates with CSV quantity-list import, labelled as not reviewed; professionally reviewed estimates with a reviewer queue, assignment, information requests, QA (blocking checks and warnings that need reasons), a reviewer-qualification check, a second reviewer above a value threshold, and issue as an immutable SHA-256-hashed snapshot; acceptance as the budget baseline; versions with line-by-line change summaries; printable customer report |
| Rates | Catalog items and dated rate observations by source class, with precedence (a lower class never silently outranks a valid higher one), freshness windows by category, reconfirmation, and import of fresh website listing prices as evidence |
| Payments | Record-only payment records, acknowledged by someone other than the recorder; always labelled as not processed or protected by BuildWise |

## Layout

```
packages/domain   Pure rules: units and price comparison, category validation, listing/promotion state machines,
                  content checks, reputation, slot placement, the market pack. No I/O.
apps/api          Fastify API. Postgres (embedded PGlite in development), row-level security on private data,
                  transactional outbox, audit chain, photo pipeline, background worker, seed data.
apps/web          Next.js App Router site. Server-rendered public pages; a backend-for-frontend proxy keeps the
                  session in an httpOnly cookie and forwards client IP/device to the API with a shared secret.
apps/e2e          Playwright end-to-end tests with axe accessibility scans (light, dark, mobile).
docs/spec         Product strategy, design spec and the v3 technical specification.
deploy            Dockerfiles and a Compose file for a single-host deployment.
```

## Run it locally

Requires Node 22+ and pnpm 10.

```bash
pnpm install
pnpm seed      # creates demo staff, sellers, listings and a demo project in ~/.buildwise/dev
pnpm dev       # API on :4000, website on :3000
```

Open http://localhost:3000. In development the sign-in code is shown on the sign-in page; nothing is sent by SMS. Outgoing SMS and email go to `~/.buildwise/dev/outbox/*.jsonl`. Development data lives outside the repository because the Next.js dev server watches the whole monorepo; set `DATA_DIR` to put it elsewhere.

Seeded numbers (all fictional):

| Role | Number |
|---|---|
| Moderator | `08000000001` |
| Second moderator (for appeals and two-person restrictions) | `08000000002` |
| Operations admin (category configuration) | `08000000003` |
| Supplier (Hilltop Building Supplies) | `08011111111` |
| Buyer (owns the "Demo bungalow" project) | `08055555555` |
| QS reviewer (qualified for low-rise residential) | `08000000004` |

Promotions use a development checkout page at `/checkout/…`; its "Pay" button sends the same signed webhook a real provider would.

To start again with fresh data, stop the servers, delete `~/.buildwise/dev` and run `pnpm seed`.

## Checks

```bash
pnpm typecheck           # all packages
pnpm test                # domain unit tests and API integration tests
pnpm check:boundaries    # dependency rules between packages and API layers
pnpm e2e                 # browser tests and accessibility scans
```

Before the first `pnpm e2e`, install the test browser once with `pnpm --filter @bw/e2e exec playwright install chromium`. The end-to-end tests reuse running dev servers when they find them. The API must allow repeated sign-ins for this: start it with `OTP_LIMIT_PER_HOUR=1000` (refused in production), or let Playwright start the servers itself.

## Configuration

Copy [`.env.example`](.env.example) to `.env` for local overrides. In production these must be set:

| Variable | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | API | Postgres 15+ with `pg_trgm` available. Without `pg_trgm` a SQL fallback is used and fuzzy title search has no index |
| `AUTH_SECRET` | API | 32+ random bytes; signs session tokens |
| `INTERNAL_API_SECRET` | API, web | Shared secret so the API trusts the web server's forwarded client IP and device id |
| `CHECKOUT_WEBHOOK_SECRET` | API | Signing secret from the payment provider |
| `PUBLIC_WEB_URL` | API, web | Public site address, used in links, canonical URLs and the sitemap |
| `API_URL` | web | Internal address of the API |
| `MARKET_PACK` | API | Market configuration id (default `demo-2026.1`) |
| `RUN_WORKER_IN_PROCESS` | API | `false` when running the separate worker process |

The API refuses to start in production with development secrets, without `DATABASE_URL`, with `EXPOSE_OTP=true`, or with `OTP_LIMIT_PER_HOUR` set.

### Providers

Each external service sits behind an adapter. Choose a provider with an environment variable and add its keys; nothing else changes. Production refuses to start without an SMS provider and a live payment key.

| Service | Variable | Options | Keys |
|---|---|---|---|
| SMS (sign-in codes, notices) | `SMS_PROVIDER` | `termii`, `twilio`, `none` (outbox file locally, log line on Vercel) | Termii: `TERMII_API_KEY`, `TERMII_SENDER_ID`, optional `TERMII_BASE_URL`. Twilio: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` (number or `MG…` messaging service) |
| Email (notices) | `EMAIL_PROVIDER` | `resend`, `none` (notices go by SMS when SMS is real) | `RESEND_API_KEY`, `EMAIL_FROM` |
| Payments (promotions) | `PAYMENT_PROVIDER` | `paystack`, `dev` (test checkout page) | `PAYSTACK_SECRET_KEY`, optional `RECEIPT_EMAIL_DOMAIN` for buyers without an email |
| Assistant flood limit | `ASSISTANT_PER_MINUTE` | messages per IP per minute (default 30) | none: the assistant runs inside the API |
| Rate limits | `RATE_LIMIT_STORE` | `postgres` (default when deployed), `memory` | none |

With Paystack, register `https://<api host>/v1/webhooks/paystack` as the webhook URL in the Paystack dashboard. Buyers return to `/checkout/<ref>`, which also asks Paystack for the result, so a late webhook never leaves a paid promotion waiting. Sign-in codes stop being shown on screen as soon as an SMS provider is set, staging included.

Still to connect:

- **Malware scanning**: the development scanner only recognises the EICAR test file. Plug a real scanner into the `Scanner` interface.

## Deploy

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) runs Postgres, the API, the worker and the website on one host. Put TLS in front of it with your reverse proxy.

```bash
cp deploy/.env.production.example deploy/.env.production   # fill in secrets
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production up -d --build
```

Database migrations run automatically when the API starts.
