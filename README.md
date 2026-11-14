# BuildWise

A construction marketplace website: building materials, tools, plant hire, trades, professionals and logistics, listed by area. This is **Release 1** of the platform described in [`docs/spec`](docs/spec/construction-platform-full-build-technical-specification-v3.md) (§3).

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
pnpm seed      # creates demo staff, sellers and listings in .data/ (embedded database)
pnpm dev       # API on :4000, website on :3000
```

Open http://localhost:3000. In development the sign-in code is shown on the sign-in page; nothing is sent by SMS. Outgoing SMS and email go to `.data/outbox/*.jsonl`.

Seeded numbers (all fictional):

| Role | Number |
|---|---|
| Moderator | `08000000001` |
| Second moderator (for appeals and two-person restrictions) | `08000000002` |
| Operations admin (category configuration) | `08000000003` |
| Supplier (Hilltop Building Supplies) | `08011111111` |
| Buyer | `08055555555` |

Promotions use a development checkout page at `/checkout/…`; its "Pay" button sends the same signed webhook a real provider would.

To start again with fresh data, stop the servers, delete `.data/` and run `pnpm seed`.

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

### Not yet connected

These are adapters with development stand-ins. Each needs a real provider before launch:

- **SMS and email**: `createFileChannel` writes to files. Replace it with your SMS and email providers.
- **Payments**: the development checkout page stands in for the provider's hosted checkout. Point the checkout URL at the provider and register `/v1/webhooks/checkout` with them (the signature format is `t=…,v1=HMAC-SHA256(t.body)`).
- **Photo storage**: the local disk adapter. Use S3-compatible storage behind the same `Storage` interface.

## Deploy

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) runs Postgres, the API, the worker and the website on one host. Put TLS in front of it with your reverse proxy.

```bash
cp deploy/.env.production.example deploy/.env.production   # fill in secrets
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production up -d --build
```

Database migrations run automatically when the API starts.
