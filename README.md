# AG Pro Solutions — Business Management Platform

Edge-native, multi-user business management for **AG Pro Solutions LLC** (1200 E Howard St, Creston, IA 50801) — agricultural drone fertilization, seed sales, and drone sales.

Built to serve two very different working environments from one codebase: field sales reps on phones and tablets in the field, and office managers on high-density desktop browsers.

---

## Overview

A single Cloudflare Worker serves both the API and (from Phase 3) the server-rendered UI. There is no origin server, no cold-start penalty under concurrent multi-user load, and no server to patch.

| Capability | Description |
|---|---|
| **CRM** | Customer profiles, billing/shipping addresses, purchase history, Iowa pesticide licence tracking |
| **Unified inventory** | Chemical, seed, drone, and misc inventory in one catalogue, partitioned by type |
| **Program pricing engine** | Per-acre blend pricing across four configurable margin tiers |
| **Invoicing** | Auto-filled line items, live margin math, lifecycle state machine, print + electronic delivery |
| **Seed compliance** | Channel straight-BOL audit tokens captured and gated at invoice submission |
| **Document ingestion** | Upload scanned vendor invoices/BOLs, parse to a draft, review, commit |
| **Checkwriting** | Admin-only vendor payments on three-part check stock, serialized numbering |

### Roles

Access is deny-by-default. See [`src/shared/rbac.ts`](src/shared/rbac.ts) for the authoritative matrix.

| Role | CRM | Invoicing | Inventory | Reporting | Checkwriting |
|---|---|---|---|---|---|
| `sales` | read/write | create + send | read-only | — | **no access** |
| `manager` | read/write/delete | create + send + cancel | write + import | yes | **no access** |
| `admin` | full | full | full | yes | **full** |

Attempted access to the checkwriting module by `sales` or `manager` is blocked in middleware, not merely hidden in the UI.

---

## Status

| Phase | Scope | State |
|---|---|---|
| **1** | D1 schema (29 tables), RBAC, pricing engine, worker/config scaffold, migrations + reference seed | ✅ Complete |
| **2** | Hono gateway: auth, RBAC middleware, CRM/catalog/inventory/invoice/check routes, document parse engine + review queue | ✅ Complete |
| **3** | Cross-platform UI: React Router SSR + Tailwind, login, role-aware shell, and screens for CRM, inventory, invoicing, checkwriting and imports | ✅ Complete |
| **4** | Print output (invoice letter format, positioned three-part cheque) + electronic invoice delivery | ✅ Complete |

**Deferred work.** `docs/SECURITY-TODO.md` holds the security review findings and the
known functional gaps. Read its "already handled" section before re-auditing — most of
the obvious surface is covered, and the remaining risk is concentrated in business
logic on the money paths.

---

## Tech stack

| Layer | Choice |
|---|---|
| Runtime | Cloudflare Workers |
| API router | [Hono](https://hono.dev) |
| Database | Cloudflare D1 (SQLite) |
| ORM / migrations | [Drizzle ORM](https://orm.drizzle.team) + Drizzle Kit |
| Auth | D1-backed sessions with httpOnly cookies |
| Object storage | Cloudflare R2 (source documents) |
| Cache / rate limiting | Cloudflare KV |
| Language | TypeScript (strict) |
| UI | React Router v7+ (framework mode, SSR) + Tailwind CSS v4; shadcn/ui-idiom primitives |
| Tests | Vitest + `@cloudflare/vitest-pool-workers` |

---

## Getting started

**Prerequisites:** Node.js 20+, pnpm 10+, a Cloudflare account.

```bash
pnpm dev            # vite dev — Worker + SSR on http://localhost:5173
pnpm build          # react-router build
pnpm preview        # serve the production build locally
```

Verify the Worker and its D1 binding:

```bash
curl http://localhost:5173/api/health
```

A healthy response reports `"status": "ok"` and `"checks": { "database": "ok" }`. If D1 is unreachable you get a `503` with the underlying error instead of a false positive.

### Environment model

There is one deployment target. Locally you run against a local D1; the top-level configuration in `wrangler.toml` is what ships to Cloudflare. `.dev.vars` overrides `ENVIRONMENT` to `development` so session cookies are not marked `Secure` over plain HTTP.

> `.dev.vars` is read by `pnpm dev` (`vite dev`) but **not** by `pnpm preview`, which serves the built Worker from `wrangler.toml` — so a preview build runs with `ENVIRONMENT=production` and `Secure` cookies. Browsers permit `Secure` cookies on `http://localhost`, so this only bites tooling with a stricter cookie jar.

### Configuration

`wrangler.toml` declares three bindings, mirrored across `staging` and `production` environments:

| Binding | Type | Purpose |
|---|---|---|
| `DB` | D1 | Application database |
| `DOCUMENTS` | R2 | Scanned BOLs, vendor invoices, price sheets |
| `KV` | KV | Session and rate-limit caching |

Local secrets live in `.dev.vars` (gitignored). Copy the template:

```bash
cp .dev.vars.example .dev.vars
```

Remote secrets are set with `wrangler secret put SESSION_SECRET --env production`.

---

## Database

Migrations are generated by Drizzle Kit into `migrations/` and applied by Wrangler, which tracks applied migrations in a `d1_migrations` table.

```bash
pnpm db:generate            # schema change -> new SQL migration
pnpm db:migrate:local       # apply to the local sqlite instance
pnpm db:seed:local          # load idempotent reference data

pnpm db:migrate:staging     # or :production, against remote D1
pnpm db:seed:staging
pnpm db:studio              # Drizzle Studio (needs CLOUDFLARE_* env vars)
```

Reference data lives in [`seed/0001_reference.sql`](seed/0001_reference.sql) rather than in `migrations/`, so Drizzle's generated migration sequence stays untouched. Every statement is `INSERT OR IGNORE`, so re-running is safe.

### Creating the first user

A freshly migrated database has no users, so there is nothing to log in with yet. Create the founding Admin with the bundled CLI — it hashes the password with `@noble/hashes` using the same parameters and encoding the Worker verifies against, so the two cannot drift, and it never routes the password through a shell:

```bash
pnpm user:create                        # interactive; local D1
pnpm user:create -- --remote            # the deployed D1 (top-level environment)
pnpm user:create -- --remote --env production
```

It prompts for the email address, full name and a hidden password (minimum 12 characters). Flags are available for scripted use: `--email`, `--name`, `--role`, `--password`, `--remote`, `--env`, `--db`.

Locked out, or need to change a password? Reset it in place:

```bash
pnpm user:create -- --update --email you@agpro.com
```

> Changing `database_id` in `wrangler.toml` points Wrangler at a different local D1 store, because local state is keyed by database id. Re-run `pnpm db:migrate:local` after switching.

### Money and units

Two conventions hold everywhere; violating them is a bug:

- **Money is an integer number of USD cents.** Every `*_cents` column is an integer minor unit. Floating-point money is never stored or settled.
- **Timestamps are integer unix milliseconds** (`timestamp_ms`), exposed to TypeScript as `Date`.

Per-unit *rates* that are genuinely fractional in vendor data (e.g. `$34.632/oz` on an I&B Ag Supply order) are stored as `REAL`, and are rounded to cents the moment they become an amount. See [`src/shared/pricing.ts`](src/shared/pricing.ts).

---

## Domain model

The schema is in [`src/db/schema.ts`](src/db/schema.ts) — 29 tables grouped as auth/access, CRM, vendors & ingestion, catalogue & inventory, pricing engine, accounts payable, invoicing, seed compliance, and banking.

Three modelling decisions are worth knowing before reading the code.

### Programs are the sellable unit, not products

The source price sheets price a **blend**, not a bottle. A *program* (`CORN (1 PASS)`, `BEAN POST / FLEX`) is a named set of ingredients, each with a rate/acre and cost/acre, and the margin tiers are priced on the program total — billed per acre. `products` therefore carries flat `financed_app_price_cents` / `cash_app_price_cents` / `carry_price_cents` only as a fallback for misc, carry-only, and drone items that are not blends.

### Four margin tiers, configured in the database

The original specification described three tiers; both source worksheets price four. Multipliers are seeded from `DEFAULT_TIER_MULTIPLIERS` and verified against the worksheet arithmetic (`Finance App = 1.20 × cost`, `Cash App = 1.10 × cost`, `Cash & Carry = 1.05 × cost`):

| Tier | Meaning | Multiplier |
|---|---|---|
| `financed_app` | Financed terms; company performs application | 1.20 |
| `cash_app` | Paid in cash; company performs application | 1.10 |
| `cash_carry` | Direct sale; customer applies independently | 1.05 |
| `finance_carry` | Financed direct sale; no application | ~1.24 |

Once seeded, the `price_tiers` table is the source of truth — an Admin can adjust multipliers or add tiers without a code change, so application code must read multipliers from the table and treat the constants as seed data only.

### Seed compliance is a gate, not a field

`iowa_compliance_logs` captures the two tokens the State of Iowa requires from a Channel straight bill of lading — `bol_cmr_number` and `order_number` — alongside seed number, shipper number, PO number, and lot. A unique index over `(bol_cmr_number, order_number, lot_number)` prevents duplicate audit records while still tolerating partially-completed drafts. An invoice covering regulated seed cannot be submitted until its compliance tokens are verified.

### Check numbering is structurally safe

`checks` carries a unique index over `(bank_account_id, check_number)`. Numbers are handed out by an atomic `UPDATE bank_accounts SET next_check_number = next_check_number + 1 … RETURNING` inside the same batch as the insert. Combined with D1's single-primary write serialization, a duplicate check number cannot be issued even under concurrent requests — verified by test.

---

## API

All routes other than health require a session cookie. Permission shown is the minimum required; the matrix in `src/shared/rbac.ts` is authoritative.

| Method & path | Permission | Description |
|---|---|---|
| `GET /api/health` · `/healthz` | — | Liveness plus a live D1 round-trip; `503` when the database is unreachable |
| `POST /api/auth/login` | — | Email + password; issues the httpOnly session cookie. Returns `429` with `Retry-After` when rate limited |
| `POST /api/auth/logout` | session | Revokes the session server-side |
| `GET /api/auth/me` | session | Current user, without the password digest |
| `POST /api/auth/change-password` | session | Revokes every other session for the account |
| `GET/POST /api/customers`, `GET/PATCH/DELETE /api/customers/:id` | `crm:read` / `crm:write` / `crm:delete` | CRM; delete is a deactivation |
| `GET /api/pricing/tiers` | `pricing:read` | Active margin tiers for the composer |
| `GET/POST /api/products`, `GET/PATCH /api/products/:id` | `inventory:read` / `inventory:write` | Catalogue, searchable by name, SKU, brand or EPA number |
| `GET/POST /api/inventory/lots` | `inventory:read` / `inventory:write` | Lot-level stock |
| `POST /api/inventory/lots/:id/adjust` | `inventory:write` | Relative adjustment, applied atomically |
| `GET/POST /api/drone-units` | `inventory:read` / `inventory:write` | Serialized drone inventory |
| `GET/POST /api/invoices`, `GET /api/invoices/:id` | `invoices:read` / `invoices:write` | Draft creation with server-resolved pricing and totals |
| `GET /api/invoices/:id/compliance` | `invoices:read` | Live verdict on the Iowa seed gate |
| `POST /api/invoices/:id/send` | `invoices:send` | **Draft → Sent. Fails 422 listing any unverified regulated seed line.** |
| `POST /api/invoices/:id/cancel` | `invoices:cancel` | Sent/Draft → Canceled |
| `POST /api/invoices/:id/payments` | `invoices:write` | Applies a payment; flips to Paid at zero balance |
| `GET /api/invoices/:id/deliveries` | `invoices:read` | Delivery history |
| `POST /api/invoices/:id/deliveries` | `invoices:send` | Deliver by `email`, `print` or `download`. Email is gated on seed compliance |
| `GET/PATCH /api/company` | session / `admin:settings` | Letterhead and cheque template configuration |
| `GET /api/audit`, `GET /api/audit/facets` | `admin:audit` | **Admin only, read-only.** Append-only trail; there is deliberately no write or delete endpoint |
| `GET /api/checks`, `GET /api/checks/:id` | `checks:read` | **Admin only** |
| `POST /api/checks` | `checks:write` | **Admin only.** Allocates the next check number atomically |
| `POST /api/checks/:id/print` · `/clear` · `/void` | `checks:print` / `checks:write` / `checks:void` | **Admin only.** Void reverses allocations and restores bill balances |
| `GET/POST /api/checks/bank-accounts`, `GET /api/checks/bank-accounts/:id` | `checks:read` / `admin:settings` | **Admin only.** The full account number is returned only by the single-account lookup the print view uses |
| `GET /api/imports/parsers` | `inventory:import` | Available document parsers |
| `POST /api/imports/batches` | `inventory:import` | Parse a document's extracted text into a review batch |
| `GET /api/imports/batches`, `GET /api/imports/batches/:id` | `inventory:read` | Review queue |
| `PATCH /api/imports/drafts/:id` | `inventory:import` | Correct a staged row |
| `POST /api/imports/batches/:id/commit` · `/reject` | `inventory:import` | Commit reviewed rows to their target tables |

Unrouted paths return a structured JSON `404`, never an HTML error page.

### Printed output

Both documents render at `/invoices/:id/print` and `/checks/:id/print`, outside the application shell so no navigation reaches paper.

- **Invoice** — standard letter format: letterhead, bill-to and ship-to, line items, totals, payment terms, and a **Seed audit reference** block carrying the BOL/CMR Number and Order Number for every regulated line, so the tokens travel with the document that was actually sold.
- **Cheque** — every coordinate is a CSS custom property sourced from `company_settings.check_template_config`, so calibrating the layout is a data change and the component never needs editing. The Checkwriting screen exposes the offsets; print a cheque, measure the error, adjust, reprint. A dashed outline marks the cheque area on screen only.

`@page` margin is zero on purpose: cheque offsets are measured from the physical edge of the sheet, so anything the browser adds would shift every field. Print at 100% scale with margins set to None.

**MICR is off by default.** A MICR line is only readable by a bank's sorter when printed in E-13B font with magnetic toner on encoded stock; printed otherwise it looks authoritative and scans as nothing. Enable it only if your stock and printer qualify — and note that a partial line is refused rather than emitted, because encoding half the information is worse than encoding none.

Two conventions worth knowing:

- **Updates record a diff, not a field list.** `recordChange` stores only the fields that actually changed, with their previous values, so "who switched this product from gallons to ounces" is answerable. A save that changes nothing writes nothing, and credential-shaped keys are redacted so the trail never carries password hashes.
- **Refused actions are audited too.** A blocked destructive attempt is worth knowing about.

### Electronic delivery
`POST /api/invoices/:id/deliveries` transmits by email, or records a `print`/`download` for the paper trail. Email delivery runs the Draft → Sent transition first, so a regulated seed sale cannot reach a customer's inbox before its BOL/CMR and Order Number tokens are verified.

Outcome is recorded honestly in three states:

| Status | Meaning |
|---|---|
| `sent` | Handed to the provider (or recorded, for print/download) |
| `skipped` | No `MAIL_PROVIDER_API_KEY` configured — recorded but **not transmitted** |
| `failed` | A configured provider refused it; the reason is stored and surfaced |

Configure delivery with `wrangler secret put MAIL_PROVIDER_API_KEY` and the `MAIL_FROM` var. Provider selection is one function in `src/services/mailer.ts`, so swapping Resend for something else is a contained change.

The email body is a summary with a link rather than a reproduction of the invoice markup — the print view is the document of record, and duplicating its HTML would guarantee the two drift apart.

### Document ingestion

`POST /api/imports/batches` accepts the **extracted text** of a document, not the binary. OCR, a vendor API, or a pasted body are interchangeable upstream concerns, which keeps the parsers pure and unit-testable.

| Parser key | Recognises | Extracts |
|---|---|---|
| `channel_bol_v1` | Channel / Product Supply Seeds straight BOL | **BOL/CMR Number**, **Order Number**, shipper no., Seed NO., PO, lot, material codes, quantities |
| `wickman_invoice_v1` | Wickman Chemical | Invoice #, dates, PO, line items with EPA numbers lifted from descriptions |
| `atticus_invoice_v1` | Atticus LLC | Invoice #, terms, PO reference, item #, qty, unit price, amount |
| `ib_ag_supply_order_v1` | I & B Ag Supply | Sales order #, totals, line items with unit price and amount |

Detection is content-based, not filename-based, and a document no parser recognises is refused with a `422` rather than guessed at. Parser output is staged as `import_drafts`; nothing reaches live inventory until a human commits it.

---

## Testing

```bash
pnpm test           # vitest run — 99 tests
pnpm test:watch     # watch mode
pnpm typecheck      # react-router typegen + tsc, app + config projects
pnpm typegen        # regenerate .react-router/types
```

Tests run **inside workerd** via `@cloudflare/vitest-pool-workers`, so they exercise the real runtime, the real Hono app and a real per-run D1 with the migrations applied. There is no mocking layer between the tests and production behaviour.

Coverage is deliberately weighted towards the things that lose money or break the law if they are wrong:

- **Parser extraction** against fixtures mirroring the real scanned documents, including their quirks (unassigned-lot slash runs, densities embedded in item descriptions, an invoice whose printed total disagrees with its own lines).
- **Money arithmetic** — integer-cent multipliers, acreage totals, discount apportionment, tax.
- **Auth** — wrong password and unknown account produce an identical response; logout genuinely revokes.
- **Brute-force protection** — repeated failures lock the account, the lock holds even against the correct password, unrelated accounts are unaffected, and a successful sign-in clears the failure count.
- **Cheque layout** — the template resolver falls back rather than blanking a cheque when hand-edited values are nonsense, amount-in-words handles the group boundaries, and a partial MICR line is refused.
- **Delivery** — a regulated seed invoice cannot be emailed before its tokens are verified, and a missing mail provider is reported as `skipped`, never as success.
- **RBAC** — sales blocked from inventory writes and from importing; managers allowed; checkwriting denied to both sales and managers.
- **Check numbering** — strictly increasing, and five concurrent requests produce five distinct numbers.
- **The Iowa seed gate** — a regulated seed invoice cannot leave Draft until its BOL/CMR and Order Number tokens are recorded *and* verified.

---

## Project layout

```
workers/
└── app.ts               Worker entry: /api/* -> Hono, everything else -> React Router SSR
app/                     React Router UI
├── root.tsx             Document shell + error boundary
├── routes.ts            Route table
├── app.css              Tailwind v4 entry and design tokens
├── components/ui.tsx    Shared primitives (button, field, card, table, badge…)
├── lib/
│   ├── api.server.ts    Calls the Hono app in-isolate; session and RBAC helpers
│   └── utils.ts         Class merging and money/date formatting
└── routes/              login, shell, dashboard, customers, inventory,
                         invoices, invoice-detail, checks, imports,
                         invoice-print, check-print
src/                     API and domain layer
├── worker.ts            API-only entry, used by the test harness
├── env.ts               Bindings (generated) + Hono environment
├── shared/              Domain enums, RBAC matrix, pricing helpers, cheque template
├── db/                  Drizzle schema, client factory, driver-error classification
├── api/                 Hono app, middleware, request schemas, routes
└── services/            Pricing, invoicing, checkwriting, imports, parsers,
                         mailer, invoice email
scripts/create-user.mjs  Bootstrap CLI for the founding Admin
migrations/              Drizzle-generated SQL migrations
seed/                    Idempotent reference data
test/                    Runtime integration tests (workerd + D1)
worker-configuration.d.ts  Generated by `pnpm types` — do not edit by hand
docs/                    Local source documents (images/XLSX are gitignored)
```

### How the UI talks to the API

Loaders and actions call the Hono app **in the same isolate** (`app/lib/api.server.ts`) rather than over HTTP, forwarding the caller's session cookie. There is therefore one implementation of every business rule and no duplicated authorisation logic — the UI can only do what the API already permits. The API remains the authority; hiding a control is a convenience, not a control.

---

## Deployment

There are two paths, and the difference is deliberate.

```bash
pnpm ship                 # build -> apply remote migrations -> deploy
```

`ship` is the **local** path: full credentials, so it can touch D1. Use it whenever a migration is involved, because it applies migrations *before* the code that needs them — the schema can never lag the code.

```bash
pnpm deploy               # build -> deploy only
```

`deploy` is the **CI** path, and it is what Cloudflare's Workers Builds runs (`pnpm run deploy`, the convention its framework guides expect). It deliberately omits migrations, because the API token Workers Builds generates is scoped:

> **Account:** Account Settings (read), Workers Scripts (edit), Workers KV Storage (edit), Workers R2 Storage (edit)

There is **no D1 permission** in that list, so `wrangler d1 migrations apply --remote` fails inside a build with an authentication error, while `wrangler deploy` succeeds. A deploy script that included migrations would break every CI build.

**The consequence, and the discipline it requires:** CI cannot apply migrations, so it also cannot verify they are applied. If you push a schema change and let CI deploy, the new code can reach a database that has not been migrated. Run `pnpm db:migrate:remote` (or `pnpm ship`) from a machine with full credentials before pushing anything that depends on a migration. This is the one ordering the build system cannot enforce for you.

To connect the repository: leave the root directory empty (`wrangler.toml` is at the repo root) and set the deploy command to `pnpm run deploy`.

Migrations run inside `ship`, but **seeds do not**. Reference data and the units registry are applied separately and deliberately:

Two things to know:

- Run `pnpm types` after editing `wrangler.toml`. It regenerates `worker-configuration.d.ts`, which is where the binding types come from — bindings therefore cannot drift from the configuration.
- `compatibility_date` is pinned to the newest date supported by the `workerd` binary shipped with `@cloudflare/vitest-pool-workers`, so dev, test and production all execute identical runtime behaviour. Raise it deliberately, in step with a dependency update.

---

## Conventions

- **Deny-by-default access control.** A permission not explicitly granted to a role is forbidden. Middleware and UI both read one matrix so they cannot drift.
- **Passwords are Argon2id.** Digests are Argon2id at **19 MiB, 2 iterations, 1 lane** — OWASP's recommended floor. Memory-hardness is the point: PBKDF2's cost is arithmetic, so a GPU tests thousands of guesses in parallel at almost no memory cost, whereas Argon2id forces every guess to occupy 19 MiB. Measured at **~341 ms** per hash in `workerd`, against ~85 ms for the PBKDF2 it replaced. That is comfortably inside the Paid plan's 30-second CPU budget but well above Free (10 ms) and Bundled (50 ms), so authentication requires a paid plan.
- **The digest carries its own algorithm, so migrating accounts needed no reset.** Two formats are accepted: `$argon2id$v=19$m=19456,t=2,p=1$…` and the legacy `pbkdf2$sha256$100000$…`. A successful sign-in checks `needsRehash` and, if the stored digest predates the current algorithm or parameters, replaces it using the password just proven correct — recording `auth.password_rehashed` in the audit trail. Accounts converge on Argon2id as people sign in, and nobody is forced to change a password. Parameters are stored per-digest, so they can be raised later without invalidating anything.
- **Password hashing is still capped by the platform.** The legacy PBKDF2 path validates its iteration count against `MAX_PBKDF2_ITERATIONS` (100,000, Cloudflare's WebCrypto ceiling) and the Argon2id path refuses any digest demanding more than `MAX_ARGON2_MEMORY_KIB` (64 MiB, since the isolate has 128 MB). Both guards exist for the same reason: a digest the runtime cannot compute must fail as a failed sign-in, never as an unhandled error. Raising a count above the platform ceiling passes every local test and fails in production only — that was a real outage, so both are covered by tests.
- **Sign-in is rate limited.** Failures are counted over a rolling 15-minute window, per account (10) and per source IP (50), and lockouts are written to the audit trail. Two consequences worth knowing: a successful sign-in clears the account's recent failures, and a limit response is returned *before* the account lookup so it cannot be used to discover which addresses exist. The unknown-account path verifies against `DUMMY_PASSWORD_HASH`, whose parameters are derived from the Argon2id constants — if it were cheaper, login would leak account existence through timing.
- **Documented deviations.** Where source data contradicted the original specification, the data won.
- **No secrets in the repository.** Real credentials live in `.dev.vars` locally and `wrangler secret` remotely.

---

*Owner: AG Pro Solutions LLC · Creston, Iowa*
