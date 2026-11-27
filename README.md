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

## Builder AI

The front page asks what you want to build. Choose a building type and taste, then select **Find plans** to browse published design previews. Plot dimensions are optional and help narrow the search. The library links to each publisher and flags known build-licence requirements with an asterisk. It does not import a third-party design into Studio. Saved BuildWise designs still open in the existing model, drawing and project tools.

- **Building types** (`packages/domain/src/building.ts`): storey ranges, what sizes each type (flats or guest rooms per floor, seats, m² of storage), extras, lifts from five storeys (sooner for hotels and clinics), a second escape stair from five storeys, suggested parking. Every type uses the same checked layout engine.
- **Questions only** (`POST /v1/build/chat`, `apps/api/src/modules/builder-ai.ts`): the chat answers questions about the design and building; it never changes the design. With `BUILDER_AI_PROVIDER=anthropic` every message goes to Claude with the versioned master system prompt (`apps/api/src/ai/builder-prompt.ts`, `builder-ai.v2`) and a compact project context the server rebuilds itself; Claude uses BuildWise's calculators and design engine as read-only tools (`calculate`, `generate_designs`). Messages are redacted before they are sent. Without a key, over `BUILDER_AI_PER_MINUTE` / `BUILDER_AI_DAILY_LIMIT`, or on any failure, BuildWise's local assistant answers instead.
- **Calculators** (`packages/domain/src/planning.ts`, factors in the market pack's `planning` section, [Proposed]): room-by-room cooling loads and AC sizes; water demand, tanks, borehole pump, heaters and septic; an editable load schedule with daily kWh, peak kW, surge and generator size, plus solar array, battery (usable vs nominal kWh) and inverter when solar is chosen; a budget plan with fees, permits, contingency, a ± range, the gap to the budget and value-engineering options. Every result carries its working, assumptions and warnings.
- **Project record** (`packages/domain/src/project.ts`, kept with the build in the browser): facts marked confirmed, assumed, estimated or needs verification; decisions (suggested, proposed, confirmed, rejected, superseded) with what each change affects; open questions; coordination checks across design, systems and budget; and the register of what professionals must verify. Export as JSON or print.

## The build assistant

| Step | What happens |
|---|---|
| Welcome (`/`) | Describe what you want in your own words. The BuildWise assistant reads it into a plot size and a design brief, answers building questions, and politely declines anything else (`/v1/build/interpret`). "Just shopping?" goes to the marketplace (`/market`). |
| Land | Width and depth in feet or metres, or a common plot size. The plot appears in 3D straight away: one scene unit is one metre, with the boundary, corner beacons, the road, a 1 m grid and the setback line. |
| Plan | Have drawings already? Reading uploaded plans is the next slice; for now the person describes the rooms. |
| Make it yours | Pick a taste and optional priorities. Add room counts, extras or budget when you know them. The floating plot stays empty while you make these choices. |
| Designs | Compare up to three checked concepts (`conceptSet` in `packages/domain/src/concepts.ts`). Each differs in layout or massing and includes a 3D street view, a ground-floor preview and a trade-off. House plans use compact circulation, with options including living or bedroom wings and narrow-plot layouts. A detached boys' quarters can be added at the back. Every layout is sized to the programme rather than stretched to the land, and checked for setbacks, site coverage, ceiling height, room sizes, daylight and ventilation, wet-room ventilation, corridor and door widths, bedroom access, entrance, a ground-floor toilet, the stair, parking and the boys' quarters' separation. Rooms are arranged by planning logic, not just checked (`packages/domain/src/adjacency.ts`): kitchen beside dining beside living, the master suite with its ensuite, a bathroom between bedrooms, and never a toilet against a kitchen or dining room or a kitchen or cinema against a bedroom. Each design gets architect's notes (how the rooms relate, zoning, cross-ventilation, circulation, cost of the outline, open ground) and a score that ranks the options; AI architects write their plan first (zones, arrival, relationships, daily flow), shown as *How it's planned*, and BuildWise sends back any layout that breaks the planning logic; with an AI architect connected, it reviews and re-ranks them (`/v1/build/architect`). Outside view or a floor-by-floor plan with room labels, plus **concept drawings** at `/build/drawings`: site plan, dimensioned floor plans with door swings and furniture, elevations and a section on A3 sheets, printable to PDF. Ready-made plans that architects list in the marketplace (category *House plans*) are shown when they fit the plot (`/v1/build/plans`). Always labelled as concept designs, not stamped drawings. |
| Adjust | The person edits the chosen design as much as they like: drag any wall on the floor plan (an outside wall moves the whole wing, within the building line), nudge walls from the keyboard, rename rooms, change a room's use, divide a room or join two. Undo, redo and start again. Edits are replayed on the generated design (`applyEdits` in `packages/domain/src/design-edit.ts`), so walls, doors, windows, the checklist, the drawings and the materials always follow. The roof is chosen here too: hip, gable, Dutch gable, mansard, shed (mono-pitch), butterfly, concealed (parapet) or flat; long-span aluminium, stone-coated tiles, concrete tiles or standing-seam; colour and pitch. |
| Outdoors | Landscaping planned round the house (`planLandscape` in `packages/domain/src/landscape.ts`): block fence with a sliding or swing gate and a pedestrian gate, driveway (interlocking stones, concrete or gravel), walkway to the front door, paved apron, lawn, trees and palms, hedge, flower beds, swimming pool, gazebo and lights. Place or remove trees, shrubs, beds and lights on the site plan. It shows in 3D, on the site plan drawing, and in the materials list as external works. |
| Design Studio | **Open in Design Studio** (`/studio`) opens the design in a full editor in the style of Planner 5D: drag rooms, resize them by their handles, add rooms, stairs, porches, verandas, balconies, pergolas and planters from the catalogue, set materials and glazing, switch between the 2D plan and 3D, with the checklist live. A consumer saves back to their build. A certified architect (verified professional credential) can also **Publish design**: it becomes a *House plans* listing priced in naira, reviewed by moderators like any listing, and buyers can try it on their own plot (`/build?plan=…`). |
| Materials | A bill of materials from the same geometry (`billOfMaterials`): excavation, filling, DPM and mesh, 9" and 6" blocks with waste, cement bags for concrete, mortar and plaster, sharp and plaster sand, granite, 12 mm and 8 mm bars, roofing sheets and timber (or waterproofing for flat roofs), doors, windows, tiles, ceilings, paint and provisional services. Every line says how it was worked out. |
| Where to buy | Each line searched in the live marketplace (`/v1/build/sourcing`): cheapest comparable offer first, a line total when the units match, and the total for everything priced. |

Taste intake keeps the 3D plot empty until submission. Choose a building purpose, a taste and optional priorities, then compare up to three geometrically distinct designs. The selected design feeds the 3D views, concept drawings, Studio, material quantities and project estimates. The assistant can propose a smaller plot or scope and explain what it would retain. The user reviews and applies the proposal. If the plot size is unknown, BuildWise uses an explicitly labelled example plot.

For the Gemini/local setup, use `BUILDER_AI_PROVIDER=gemini`, optionally `ASSISTANT_PROVIDER=gemini`, and `PAID_AI=off`. Use a Gemini API key from an AI Studio Free Tier project. BuildWise's guard rejects configured paid providers and does not control Google's project billing tier. The Gemini chat uses read-only tools and falls back to BuildWise's local assistant on provider errors. The deterministic design reveal works with every external provider disabled.

**Published plan library.** Set `EXA_API_KEY` on the API server. The library requests publisher image metadata and uses public publisher-hosted floor-plan or exterior previews when available. The AI filter requires explicit attribution in the source. The homepage search does not request design generation.

**Gemini-guided homes.** With `DESIGNER_PROVIDER=gemini`, Gemini proposes distinct planning directions for houses. BuildWise sizes and places the rooms, assembles each direction into geometry, and checks the resulting layout before returning it. This path requires the requested study and leisure rooms, direct access from the master bedroom to its ensuite when requested, and daylight checks. An unavailable direction is skipped. The app can still show checked local concepts if Gemini is unavailable. Other building categories use the existing layout validation path.

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

## What's in Release 3

Structured procurement, fulfilment, trust and marketplace quality, then sealed tenders, milestones and variations, sourcing modes and client supplier lists (spec §9.2–§9.6, §9.10, §10.4, §10.5, §13.1, §13.3, §13.4, §14.1, §19.2, §25).

| Area | Included |
|---|---|
| Requests for quotes | Provider profiles derived from storefronts; RFQs only from shared client-specified or issued reviewed estimate lines (or a website quote request), with provenance; explainable matching (hard eligibility, then ranking that never reads fees or promotion); open or sealed quotes; RFQ versions that mark quotes for revision; immutable quote versions; normalised comparison with a lowest total only across like-for-like quotes; award by the owner to a record-only order holding the exact quote terms |
| Fulfilment | The client books deliveries into slots; the supplier dispatches consignments (waybill, vehicle, loaded quantities) and marks arrival; proof of delivery (who, when, quantities, SHA-256 fingerprint) is fixed once recorded and is a receipt, not an acceptance; inspection splits received goods into accepted and rejected and raises shortages on its own; the supplier acknowledges or contests each discrepancy and the client resolves it (replace, credit or accept as is); returns of rejected or kept goods, approved and collected by the supplier; the order moves to partly delivered and delivered from inspections, not receipts |
| Invoices | Supplier invoices are immutable and checked in a three-way match against the order (prices, units, tax, delivery charge) and proof of delivery and inspection (cumulative quantities kept, net of returns); variances go to the project owner for approval; matches are re-run when receipts, inspections or returns change; record-only payments against an order, confirmed by the supplier; the client closes the order when nothing is open |
| Cases | A contested discrepancy or a disputed order becomes a supplier case (either party can also raise one): type and severity S1–S4 with initial response targets (S1 1 hour 24/7; S2–S4 in business hours), triage, requests for information, investigation, a proposed resolution, a decision, and one appeal per case decided by a different staff member; safety (S1) cases skip triage, page the on-call safety owner and show the local emergency message; evidence from the project's documents; a communication log with staff-only notes; every step in the hash-chained audit log. Staff work cases at `/moderation/cases` |
| Reviews | After a completed or terminated order each side reviews the other once within 30 days (quality, timeliness, communication and accuracy against the quote; the supplier rates the client on its own three), with the listing content checks (held for a moderator on contact or payment details); each side's review is hidden from the other until both have reviewed or the window closes; one public reply; removal only for a stated policy reason, audited. Order reviews lead the provider profile; website reviews stay, labelled |
| Performance | On-time delivery, deliveries with a discrepancy, invoices matching order and receipt, quote response time and quotes kept to the deadline, from the order records; fewer than 5 records show as a count, never a score; shown on the provider profile and used by RFQ matching (a delivery-record factor, quote reliability in response reliability), neutral until there is enough history |
| Liquidity | Staff dashboard for the Release 3 exit gate (`/moderation/liquidity`): share of RFQs with 3 or more like-for-like responses within 72 hours, against an 80% target, by category, area and week |
| Tenders | Sealed tenders for trade packages (an RFQ of kind `tender`, references `TND-…`): the package (scope, scope documents from the project, site visit, programme, conditions, extra required checks, retention, the response template) issued to invited bidders; questions answered once for every bidder without saying who asked; bids are priced lines plus a structured response (programme, staffing, method, inclusions, qualifications, defects terms, exceptions, a conflict-of-interest declaration), withdrawn or replaced only before the deadline; nobody on the client side, staff with an access session included, can read a bid until the bids are opened together at or after the deadline (enforced by row-level security and triggers), which writes a hashed opening register; comparison on normalised terms plus weighted quality scores from evaluators who declared their interests first; the award is a contract (`CT-…`) that keeps the package's retention |
| Milestones and variations | Payment milestones on any award, within the contract value; the supplier starts and asks for sign-off, the client signs off, rejects or disputes, with a history; record-only payments against a signed-off milestone, less retention; a tender contract is fulfilled by its milestones. Priced variations proposed by either side (the supplier always prices), sent back for a new price, approved or rejected by the project owner; an approved one writes an immutable, hash-linked award revision (value, programme, completion date) |
| Sourcing and lists | Sourcing modes: open to every eligible provider, invited, approved (framework) suppliers only, or suppliers the client names (coverage becomes a warning, checks still apply). The client organization's preferred, blocked, approved and conflict-of-interest lists (`/projects/{id}/suppliers`), never edited, only removed with a reason; conflict checks beyond "your own organization": a project team member who belongs to the provider, a provider member who reviewed the source estimate (both block), providers that share a member (a warning) |
| Supplier uploads | The awarded supplier uploads a proof-of-delivery photo on a dispatched delivery and an invoice PDF through the project document pipeline (quarantine, malware scan, content sniff, sharp re-encode without metadata); a file that is not what it claims is rejected |

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
| Second cement supplier (Old Town Cement Depot, answers requests for quotes) | `08077777777` |
| Buyer (owns the "Demo bungalow" project) | `08055555555` |
| Architect (Demo Design Studio, sells house plans) | `08066666666` |
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
| AI designer | `DESIGNER_PROVIDER` | `anthropic`, `gemini`, a provider chain, or `none` (default: BuildWise's own engine) | `GEMINI_API_KEY` from a Google AI Studio Free Tier project. The designer receives the brief, dimensions or example envelope, and worldwide references. Optional `DESIGNER_MODEL` defaults to `gemini-3.6-flash,gemini-3.8-flash`. `DESIGNER_PER_MINUTE` (3) and `DESIGNER_DAILY_LIMIT` (200) limit requests. BuildWise checks and deduplicates generated layouts and falls back to its own concepts when Gemini cannot return a passing layout. |
| 3D critique | `CRITIQUE_PROVIDER` | `designer` (default: the designer chain's first model that can see), `gemini` | `GEMINI_API_KEY`; optional `CRITIQUE_MODEL` (defaults to `DESIGNER_MODEL`). Looks at a snapshot of the 3D design and proposes an improved layout, which BuildWise checks |
| Dream renders | `DREAM_PROVIDER` | `gemini`, `openai`, `none` (default: no gallery) | `GEMINI_API_KEY` (paid: Gemini image models have no free tier) or `OPENAI_API_KEY`; optional `DREAM_MODEL`, `DREAM_PER_MINUTE` (4), `DREAM_DAILY_LIMIT` (200). Paints street, aerial, garden and interior impressions of the design from its 3D snapshot; with `ARCHITECT_PROVIDER=anthropic`, Claude checks each exterior painting against the 3D model and a misleading one is redone once. Always labelled as an AI impression |
| Photoreal render | `RENDER_PROVIDER` | `openai`, `none` (default: no render button) | `OPENAI_API_KEY`; optional `RENDER_MODEL` (default `gpt-image-1.5`), `RENDER_PER_MINUTE` (2), `RENDER_DAILY_LIMIT` (100). `POST /v1/build/render` sends a PNG snapshot of the 3D model to OpenAI's image edits endpoint and returns an AI impression, always labelled as such; the prompt is built server-side |
| Builder AI (the chat) | `BUILDER_AI_PROVIDER` | `anthropic`, `gemini`, `none` (default: the local assistant) | `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`; optional `BUILDER_AI_MODEL` (default `claude-opus-5-5`, or for Gemini the free-tier chain `gemini-3.8-flash,gemini-3.6-flash`), `BUILDER_AI_PER_MINUTE` (per IP, default 8), `BUILDER_AI_DAILY_LIMIT` (all visitors, default 2000). Claude calls are paid; Gemini runs the same tool loop on the free tier |
| Live brain (the assistant) | `ASSISTANT_PROVIDER` | `gemini`, `none` (default: BuildWise's local model alone) | `GEMINI_API_KEY`; optional `ASSISTANT_MODEL` (default `gemini-3.8-flash,gemini-3.6-flash`), `ASSISTANT_DAILY_LIMIT` (default 1000). Gemini reads each build-flow message and answers; the local model answers at once as the fallback and retrains on Gemini's labels |
| AI architect (optional) | `ARCHITECT_PROVIDER` | `anthropic`, `gemini`, `none` (default: the design engine's own notes and ranking) | `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`; optional `ARCHITECT_MODEL` (default `claude-opus-5-5`, or for Gemini `gemini-4-hydrogen,gemini-3.8-flash,gemini-3.6-flash`), `ARCHITECT_PER_MINUTE` (fresh reviews per IP, default 3), `ARCHITECT_DAILY_LIMIT` (fresh reviews per day, default 300). Reviews are cached for 30 days per plot and brief, so each costs one call |
| Rate limits | `RATE_LIMIT_STORE` | `postgres` (default when deployed), `memory` | none |

With Paystack, register `https://<api host>/v1/webhooks/paystack` as the webhook URL in the Paystack dashboard. Buyers return to `/checkout/<ref>`, which also asks Paystack for the result, so a late webhook never leaves a paid promotion waiting. Sign-in codes stop being shown on screen as soon as an SMS provider is set, staging included.

Still to connect:

- **Malware scanning**: the development scanner only recognises the EICAR test file. Plug a real scanner into the `Scanner` interface.

## Deploy

### Vercel preview

- Use separate projects for `apps/api` and `apps/web`, with access to the monorepo workspace. Deploy the API preview first and set the web preview's server-side `API_URL` to it. Use the same `INTERNAL_API_SECRET` on both projects.
- For a protected API preview, store its Vercel automation credential as the web project's Preview-only `API_PREVIEW_AUTH_SECRET`. The web server adds it to API requests.
- Keep `APP_ENV=staging` and the preview database and secrets on the API project. Add `GEMINI_API_KEY` and `EXA_API_KEY` there. Set `PAID_AI=off` and use `gemini` for `ASSISTANT_PROVIDER`, `BUILDER_AI_PROVIDER`, `DESIGNER_PROVIDER`, `ARCHITECT_PROVIDER` and `CRITIQUE_PROVIDER` to exercise the Gemini path. Leave `RENDER_PROVIDER` and `DREAM_PROVIDER` off for this configuration.
- Check the function duration on both projects. Generation can include multiple model attempts and a repair, and Vercel can end the request before the API sends its fallback. Verify the API's `/health`, the web proxy's `/api/v1/build/config`, and the location-free generate, compare and drawings flow in the preview.

### Single host

[`deploy/docker-compose.yml`](deploy/docker-compose.yml) runs Postgres, the API, the worker and the website on one host. Put TLS in front of it with your reverse proxy.

```bash
cp deploy/.env.production.example deploy/.env.production   # fill in secrets
docker compose -f deploy/docker-compose.yml --env-file deploy/.env.production up -d --build
```

Database migrations run automatically when the API starts.
