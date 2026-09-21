# AG Pro Solutions — Implementation Review

**Date:** 16 September 2026
**Version:** `0.1.0` · commit `main`
**Scope:** full comparison of what was built against the original specification, with deviations justified and alternatives assessed.

---

## 1. Executive summary

The system is **functionally complete against the original specification, with two deliberate expansions** and **one significant gap**.

| Original requirement | Status |
|---|---|
| Multi-user auth with `Sales` / `Manager` / `Admin` RBAC | ✅ Complete, deny-by-default, middleware-enforced |
| Strict route validation per role, checkwriting locked to Admin | ✅ Complete, including a test proving a lockout holds |
| Invoice ingestion from Wickman / Atticus / I & B / Channel BOL | ✅ Complete — 4 parsers, content-based detection |
| Iowa compliance: isolate BOL/CMR Number + Order Number | ✅ Complete, and gated at invoice submission |
| Unified inventory: Chemical / Seed / Drone / MISC | ✅ Complete, plus lot-level and unit-serialised tracking |
| Multi-tiered pricing engine (3 tiers) | ✅ Complete — **four** tiers, because the source data has four |
| CRM with purchase history and compliance log | ✅ Complete |
| Invoicing with auto-fill, live margins, state machine | ✅ Complete |
| Print: invoice letter + three-part check | ✅ Complete; check needs physical calibration |
| Print-optimised check output, serialised numbering | ✅ Complete; numbering proven under concurrency |
| Drizzle + D1 + Hono + Cloudflare Workers | ✅ Complete as specified |
| **Price sheet loaded so programs can be sold** | 🟡 **Imported** — 7 programs, 47 ingredients, 15 products. The sheet itself carries no figures, so prices are still missing |
| Regulated-seed invoices actually sendable | 🔴 Not yet — nothing sets `verified = true` on a compliance log, so the gate correctly refuses every one |
| User management UI | 🔴 Not built (CLI only) |
| Password reset by email | 🔴 Not built (CLI only) |

**The things blocking real use**, in order:

1. **No prices.** The import is done; the 2027 sheet's price cells are `0`. Until real figures are entered, placeholder prices (`pnpm prices:test`, reversible) let the invoicing flow be tested end to end.
2. **Regulated-seed invoices cannot be sent at all** — not because the gate is broken, but because nothing ever marks a compliance log verified. Building that step is the largest remaining functional gap, and it must be paired with the access-control fix noted in `SECURITY-TODO.md` (H3).

Everything else is usable today.

---

## 2. Stack: specified vs actual

Every specified technology was used as written. Nothing was substituted.

| Layer | Specified | Actual | Version |
|---|---|---|---|
| Frontend | React Router (Remix v3+) **or** SvelteKit | React Router framework mode, SSR | `8.4.0` |
| API router | Hono on Workers | Hono | `4.13.8` |
| Database | D1 | Cloudflare D1 | — |
| ORM | Drizzle | Drizzle ORM + Kit | `0.45.2` / `0.31.10` |
| Auth | Edge JWT **or** Lucid/session tables in D1 | D1 session tables, httpOnly cookie | — |
| Styling | Tailwind + shadcn/ui | Tailwind v4 (CSS-first) + local primitives in one module | `4.3.3` |
| Runtime | Cloudflare Workers | Workers, `nodejs_compat` | wrangler `4.133.0` |
| Language | — | TypeScript strict | `5.9.3` |

Supporting choices: `zod` 4.6.5 (validated at every boundary), `class-variance-authority` + `clsx` + `tailwind-merge` (the shadcn idiom), `isbot` (error-boundary copy), `vitest` 4.1.11 + `@cloudflare/vitest-pool-workers` 0.22.0, `@cloudflare/vite-plugin` 1.54.11, `vite` 8.3.0.

**Dependency count: 10 runtime, 14 development.** Deliberately lean — no auth framework, no UI kit, no ORM extensions.

---

## 3. Architecture

One Worker, two responsibilities:

```
                          ┌──────────────────────────────┐
   HTTPS ────────────────▶│  workers/app.ts              │
                          │                              │
                          │  /api/*  ──▶ Hono app        │
                          │  everything else ──▶ React   │
                          │              Router SSR      │
                          └──────────┬───────────────────┘
                                     │  in-isolate call, no network hop
                          ┌──────────▼───────────────────┐
                          │  src/services/*              │
                          │  pricing · invoicing ·       │
                          │  checkwriting · imports      │
                          └──────────┬───────────────────┘
                                     │
                          ┌──────────▼───────────────────┐
                          │  D1 (Drizzle)  ·  R2  ·  KV  │
                          └──────────────────────────────┘
```

**Key property:** UI loaders call the Hono app *in the same isolate* rather than over HTTP. There is exactly one implementation of every business rule and no second authorisation path. The API remains the authority; hiding a control is a convenience, not a control.

### Data model — 33 tables

| Group | Tables |
|---|---|
| Auth & access | `users`, `sessions`, `login_attempts`, `audit_logs`, `company_settings` |
| CRM | `customers`, `customer_sequences` |
| Vendors & ingestion | `vendors`, `documents`, `import_batches`, `import_drafts` |
| Catalogue & inventory | `products`, `product_costs`, `units`, `warehouses`, `inventory_lots`, `inventory_movements`, `drone_units` |
| Pricing engine | `price_tiers`, `application_programs`, `program_ingredients`, `program_prices`, `application_fees` |
| Accounts payable | `vendor_bills`, `vendor_bill_items` |
| Invoicing | `invoices`, `invoice_items`, `invoice_sequences`, `invoice_deliveries` |
| Seed compliance | `iowa_compliance_logs` |
| Banking | `bank_accounts`, `checks`, `check_allocations` |

**Conventions that prevent whole classes of bug:** money is always integer cents, never a float; timestamps are integer unix milliseconds; primary keys are application-generated UUIDs; enum columns derive from one tuple source in `src/shared/enums.ts`; stock is an append-only ledger (`inventory_movements`) that is *never* pruned, so a running total is a sum rather than a stored number that can drift.

### Verification

199 unit and integration tests, executed **inside workerd against a real D1**, not against mocks — plus a 38-check smoke run that builds the Worker, boots a preview, signs in and walks every screen.

Weighted towards what loses money or breaks a law: check-number and account-number uniqueness under concurrency, the Iowa compliance gate, monetary arithmetic, RBAC lockdown, brute-force lockout, parser extraction against fixtures mirroring the real scanned documents.

The smoke run covers the layer the unit suite structurally cannot reach — React Router SSR. Three production bugs came from that gap (an unrelayed session cookie, a sign-out action on a pathless layout, and invoice creation failing validation), so form and route changes get a smoke check, not only a unit test.

---

## 4. Deviations from the specification

Six deviations. Each is a case where the specification and the source data disagreed, or where the platform imposed a constraint that had to be designed around.

### 4.1 Three pricing tiers → four

**Spec said three** (Financed Application, Cash Application, Cash/Finance & Carry). **Both source worksheets price four:** `Finance App`, `Cash App`, `Cash & Carry`, `Finance & Carry`.

**Why:** merging the two carry tiers would have made the data unrepresentable — a cash-carry sale and a financed-carry sale have different multipliers (1.05 vs ~1.24) and different payment terms. The engine is now driven by a `price_tiers` table, so the count is configuration, not code. Four rows are seeded.

### 4.2 Products → products *and* programs

**Spec modelled `products` with three markup columns.** The sheets do not price bottles; they price **named blends billed per acre** ("CORN (1 PASS)"), each a set of ingredients with a rate/acre and cost/acre, with the tier prices applying to the program total.

**Why:** a per-product price cannot express a per-acre blend. `products` retains the specified `financed_app_price` / `cash_app_price` / `carry_price` columns for flat items (misc, drones, carry-only), and `application_programs` + `program_ingredients` + `program_prices` carry the blends. The multipliers are real — verified from the sheet arithmetic: `Finance App = 1.20 × cost`, `Cash App = 1.10`, `Cash & Carry = 1.05`.

### 4.3 Automatic OCR extraction → review queue

**Spec asked for an upload endpoint that parses vendor invoices.** The supplied documents are 2992×2992 phone photographs, rotated, with handwritten ink.

**Why:** end-to-end OCR of those images cannot be trusted to write to inventory unattended — a misread quantity becomes a wrong invoice and a wrong stock count. The engine therefore parses *extracted text* into staged `import_drafts` that a human accepts, edits, or rejects, with the source document retained in R2 and every commit audited. The parsers are pure functions of text, so whichever extraction method is used (Workers AI, a vendor API, or a paste) is an interchangeable upstream concern.

### 4.4 Added: application service fees

Not in the spec. The Fungicide sheet carries a per-method application-fee table: **Drone $13.50/acre, Ground (beans) $11.50, Helicopter $13.50.**

**Why:** the specification's tiers all describe *the company performing the application*, and the business bills a drone service. Without a fee entity the service revenue had nowhere to live.

### 4.5 Added: lot-level and serialised tracking

Not in the spec. The Channel BOL carries a **lot number and a `Seed NO.` on every line**; drones are individually serialised.

**Why:** Iowa seed audits are lot-based. Product-level stock would make the required traceability impossible. `inventory_lots` holds lot + Seed NO; `drone_units` holds one row per physical machine.

### 4.6 Compliance gate applies to delivery, not just submission

**Spec said the UI must block submission** for regulated seed without verified compliance numbers. Implemented as specified — and extended.

**Why:** emailing an invoice puts the same document in front of a customer, so `POST /api/invoices/:id/deliveries` runs the same Draft → Sent gate first. A regulation that can be sidestepped by a different button is not a control.

### 4.7 Platform constraints that shaped the design

- **PBKDF2 is capped at 100,000 iterations** by Cloudflare's WebCrypto — confirmed as a deliberate DoS guard, with the request to raise it open since October 2023. A value above the cap passes locally (workerd in tests does not enforce it) and fails in production. This caused a real outage. The cap is now both a validated guard and a tested limit on the legacy verification path.
- **CPU budget forced a plan check.** PBKDF2 at 100k measures **~85 ms** in workerd; its Argon2id replacement at 19 MiB / t=2 measures **~341 ms**. Free is 10 ms, Bundled 50 ms, Paid 30 s. Any real password hash requires a paid plan, and Argon2id more firmly so.
- **Cloudflare does not recommend a password hashing algorithm.** Web Crypto lists PBKDF2 as its only KDF and explicitly warns that MD5 is weak; it says nothing about what to use for passwords. Argon2id is the OWASP/NIST recommendation, and is implemented here in pure JavaScript via `@noble/hashes` rather than WASM — no binary to ship, and one implementation shared by the Worker, the tests and the CLI, which removes the format-drift risk that previously let the CLI mint digests the Worker could not verify.
- **KV serialises single-key writes to ~1/second**, which is exactly the access pattern credential stuffing produces — so rate-limit counters live in D1, not KV.

---

## 5. What was added beyond the specification

| Addition | Why it was necessary |
|---|---|
| Rate limiting / lockout | Nothing in the spec stopped unlimited password guesses; this protects more than hash strength does |
| Account-level audit trail | Requested later, and already underpins the compliance and checkwriting guarantees |
| Document import review queue | Safety, per §4.3 |
| Seed audit reference printed on invoices | The tokens only satisfy an auditor if they travel with the sold document |
| Electronic delivery with honest three-state outcome | `sent` / `skipped` / `failed` — conflating "no provider configured" with success would hide a misconfiguration |
| Company settings / letterhead | Invoices and cheques need an issuer |
| `pnpm user:create` CLI | A fresh database had no users and therefore no way in |

---

## 6. The gap: prices, not the import

**The importer is built and has run.** `pnpm import:prices` parses `2027_chemical_prices.xlsx` and populated **7 programs, 47 program ingredients and 15 products**, with the application-fee table beside the blocks. The block-structure parser, product reconciliation by name, effective dating for coexisting seasons and idempotent re-running all work. Name-spelling reconciliation (`XSAte` vs `Xsate`, `Fulltec` vs `FullTec`) was solved in the importer rather than deferred to a human.

The originally-estimated work — a Node XLSX reader, a block parser, product matching, effective dating, idempotency — is therefore **done**.

**What remains is that the sheet carries no prices.** The 2027 cells are `0`, which reads as "not yet priced" rather than "free", so `program_prices` is empty and the composer correctly refuses every program line. Product lines are refused as well, because no product carries a cost or a tier price.

Until the real figures arrive, `pnpm prices:test` seeds clearly-tagged placeholders so the whole invoicing flow — draft, compliance gate, send, payment, print — can be exercised. They are dated in the past so they resolve against an invoice raised today, and removed with `pnpm prices:test -- --clear`. **They must be cleared before real prices are loaded**, or a placeholder reads as a quote someone entered.

**Still to decide when the real sheet is priced:**

- Should a `0` cell be skipped as "not yet priced", or imported as a genuine zero?
- What is the Fungicide `Package` list (`Veltyma 326.70`, `Traro Pro 148.50`) — a flat price for a whole package, sold as one unit?
- The 2027 arithmetic is `cost × multiplier`; the Fungicide sheet uses different, slightly inconsistent multipliers (~1.10/1.12/1.24). Should fungicide prices be imported as absolute figures rather than recomputed?
- Which sheet is authoritative for the coming season — `AG Pro 2027` only, with the Nov 2024 sheet kept as history?

---

## 7. Where a better way exists

Honest assessment, ordered by value.

| Area | Current | Better | Trade-off |
|---|---|---|---|
| **Password hashing** | **Argon2id**, 19 MiB / t=2 / p=1 | Raise the memory cost when CPU budget allows — memory is the parameter that costs an attacker most | Each +1 MiB is roughly linear in login latency at ~341 ms today. Pure-JS `@noble/hashes` is ~4× slower than a WASM build would be, so the same parameters in WASM would buy back headroom |
| **Auth ownership** | Hand-built sessions | **Better Auth 1.5** — natively supports D1 + Hono, and brings password reset, 2FA, passkeys, OAuth | It takes over the `user`/`session` tables, and our RBAC (and the checkwriting lockdown) hangs off `users.role`, so bridging is real work |
| **PDF invoices** | HTML + browser print | Server-side PDF generation | HTML print is genuinely simpler and produces a fine document; PDFs only pay off for archival or automated attachment |
| **Audit surfacing** | Field-level before/after of changed fields only, with an Admin viewer at `/audit` | Per-record history on the entity's own page | The data is already captured and queryable and the viewer filters it, so this is convenience rather than capability |
| **Price import format** | XLSX parsing | Ask the vendors for CSV/API | Bayer/CropScience exposes APIs; the README already flags `cropcience.bayer.com`. Removes the fragile sheet parser entirely for the Channel seed flow |
| **OCR** | Manual paste of text | Workers AI vision, or a vendor API | Would remove the paste step. Still requires the human review queue behind it |
| **shadcn/ui** | Primitives in one module | `npx shadcn` per-component files | Cosmetic. The current API surface is already compatible; splitting costs nothing but churn |

### Things deliberately *not* done

- **No multi-tenancy.** Single company, as scoped. `company_settings` is a singleton.
- **No offline mode.** Field agents on poor connections would benefit from a service worker and request queue; not scoped, and the SPA-in-a-Worker shape makes it straightforward later.
- **No soft-delete framework.** Only customers are deactivated; invoices and checks are cancelled/voided, which preserves the paper trail where it matters.

---

## 8. Recommended next sequence

1. **The real 2027 prices** — unblocks the core selling flow. The importer has run; the sheet simply has no figures in it yet. Placeholder prices (`pnpm prices:test`) unblock *testing* meanwhile and must be cleared before the real ones load. Needs the §6 answers.
2. **Compliance-log verification** — nothing in the codebase ever sets `verified = true`, so **regulated-seed invoices cannot be sent at all**, however correctly the gate is working. This is the largest functional blocker. The dependent access-control finding (H3 in `SECURITY-TODO.md`) must be fixed in the same change, or the verification step inherits a gate that can be satisfied by any verified log rather than the right one.
3. **User management screen** — `GET/POST/PATCH /api/users` behind `admin:users`, plus a UI. The RBAC and audit foundations are already there, and `pnpm user:create` covers the CLI path meanwhile.
4. **Password reset by email** — token table, request/confirm endpoints, reset page. The mailer exists, including its honest "not configured" state. The Argon2id migration means this is now a convenience rather than a prerequisite for changing algorithms.
5. **Security hardening** — `docs/SECURITY-TODO.md`, in the order given there. M2 (security headers) is mechanical and protects the money screens today, so it is the sensible first item.

### Done since this review was written

- ~~**Price sheet import**~~ — built and run: 7 programs, 47 ingredients, 15 products.
- ~~**Audit: field-level diffs + viewer**~~ — `recordChange` stores before/after of changed fields only, redacts credential-shaped keys, and writes nothing when nothing changed; the Admin-only viewer at `/audit` filters and renders the diffs.
- ~~**Argon2id migration**~~ — done, with no forced reset. The digest records its own algorithm, so a successful sign-in silently rehashes legacy PBKDF2 accounts using the password just verified. ~341 ms/hash in `workerd`.
- ~~**Deployment path**~~ — CI (`pnpm deploy`) and local (`pnpm ship`) are now distinct, because the Workers Builds token has no D1 permission and cannot apply migrations.
- ~~**Customer account numbers**~~ — now allocated from a sequence rather than typed.
- ~~**Interface pass**~~ — browse separated from edit, status reduced to a dot and a word, then re-themed to GitHub's structure: neutral surfaces and 1px rules, 6px corners, the system font stack, and a per-browser light/dark/auto mode resolved before first paint. The brand palette now survives only on the printed documents.
- ~~**Invoice editing**~~ — a Draft or Sent invoice can be edited from `/invoices/:id/edit`: header fields, and the whole line set. Lines are re-priced server-side; a Sent edit re-checks the seed-compliance gate against the proposed lines *before* writing and reconciles the stock ledger (reverse outstanding, then consume). `paid` and `canceled` are refused. This needed `reverseForInvoice` reworked from an "already reversed" flag to net-outstanding, so a reconcile followed by a cancel still reverses correctly.
