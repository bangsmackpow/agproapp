# Security TODO

Deferred work from the security and production-readiness review of **2026-09-17**.

Reviewed against OWASP Top 10 and general production hardening, at commit `8a9d9b7c`.
Nothing here is blocking accurate day-to-day use; the items are ordered by how much
they matter if something goes wrong. **No Critical findings.**

> Read the "Already handled" section before re-auditing. Much of the obvious surface
> is genuinely covered, and re-deriving that wastes time. The findings that remain are
> concentrated in **business logic on the money paths**, not in classic web auth.

---

## 1. Fixed already — do not re-report

| | Finding | Fix |
|---|---|---|
| **H1** | `recordInvoicePayment` only rejected `canceled`, so paying a draft in full set it straight to `paid`, bypassing **both** safeguards that live on the `draft → sent` transition: the Iowa seed-compliance gate (`src/services/invoicing.ts:488`) and stock consumption (`:520`). An invoice could report as settled with its BOL/CMR numbers never verified and its inventory never drawn down. | Guard added in `recordInvoicePayment`; only `sent`/`paid` are payable. Regression test at `src/services/invoicing-lines.test.ts`. |
| **L1** | Open redirect on the login `next` parameter. `startsWith('/')` permits `//evil.com`, which browsers read as protocol-relative, sending someone off-origin immediately after authenticating. | `safeNext()` in `app/routes/login.tsx` requires a single leading slash. |

---

## 2. Open — High

### H2. Line prices are client-supplied with no guardrail

**Location:** `src/api/schemas.ts:360` (`unitPriceCents: cents().optional()`), consumed as an override at `src/services/invoicing.ts:244`.

For `product`, `package` and `misc` lines a client-supplied `unitPriceCents` wins over the tier price, and `discountCents` is likewise client-set (`schemas.ts:397`). `quantity` has no maximum (`:357`). A `misc` line references no product, so it is **entirely** price-set by the caller. Any `sales` user can create and send an invoice at any price, including below cost, with no floor, no ceiling, and no alert.

The in-code comment calls this "an explicit override", so the *feature* is deliberate. **This is a policy gap, not a bug.**

**Decision needed:** require a manager role (or a separate permission) to pass an override at all, **or** clamp overrides to a band around the tier price and always audit the divergence. At minimum reject `unitPriceCents <= 0` and surface negative margin at send time.

### H3. A compliance log can be attached to a line it does not belong to

**Location:** `src/services/invoicing.ts:392-450`; client-supplied id accepted at `src/api/schemas.ts:363`.

`findComplianceViolations` checks only `verified` and never confirms the log's `productId`/`customerId` match the line and invoice, though `iowa_compliance_logs` carries both (`src/db/schema.ts:972-973`). A user picks any verified log id and the gate reports satisfied.

**Latent today — nothing in the codebase ever sets `verified = true`** (imports insert `verified: false`). The gate is currently unbypassable only because it is also unsatisfiable. **This becomes live the moment a verification step is built, so fix it in the same change as that step.**

**Remediation:** load the log and require its product to match the line's product and its customer to match the invoice's customer before counting it verified.

---

## 3. Open — Medium

### M1. No Origin / Sec-Fetch-Site check; `SameSite=Lax` is the only CSRF defence

Cross-*site* POSTs are blocked today by Lax. That does **not** cover same-site subdomains (an attacker-controlled or compromised sibling host), which is the threat model of interest. `parseJson` also ignores `Content-Type` (`src/api/lib/http.ts:72`), so a `text/plain` body — a CORS-safelisted simple request needing no preflight — is accepted.

**Remediation:** Hono middleware rejecting state-changing requests whose `Origin`/`Sec-Fetch-Site` is not the app's own origin, and/or require `Content-Type: application/json`. Cheap; removes reliance on a single cookie attribute.

### M2. No security headers at all

Repo-wide, there is no CSP, `X-Frame-Options`, `frame-ancestors`, `X-Content-Type-Options`, `Strict-Transport-Security`, or `Referrer-Policy`. `workers/app.ts` hands SSR responses straight to React Router, so nothing attaches them.

**Clickjacking is live on the money screens.** `/checks` and the print routes (`app/routes/check-print.tsx`, `invoice-print.tsx`) render framable HTML, and Void / Issue draft check / Cancel / Submit are ordinary POST forms — an attacker page can iframe the app and overlay a decoy. There is also no CSP, so any future XSS has no second line of defence.

**Remediation:** a header block on every response (a small wrapper in `workers/app.ts`, or a Hono middleware plus a `headers` export in `root.tsx`): `X-Frame-Options: DENY`, `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; …`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, HSTS at the edge. Add `Cache-Control: no-store` to authenticated HTML and print pages.

**One interaction to plan for:** the theme is resolved by an inline `<script>` in `app/root.tsx` (see `app/components/theme.tsx`) so the page never flashes the wrong colours. A `script-src 'self'` policy blocks it, so the CSP needs a nonce/hash for that one script — or move the identical logic to a same-origin `/theme.js`, which needs no exemption.

**Suggested first task** — mechanical, and it protects the money screens immediately.

### M3. Invoice email: any recipient, unlimited sends

**Location:** `src/api/routes/invoices.ts:192-299`; `to` accepted at `src/api/schemas.ts:430`. Any `sales` user (`invoices:send`) supplies an arbitrary address, and the API mails an invoice summary — customer name, amounts, seed-audit tokens — through the company's mail provider, from the company's `MAIL_FROM`. No rate limit on the endpoint, on batch creation, or on invoice creation; only login is limited. A departing account can spam from the company domain or exfiltrate customer names and amounts.

The print link itself is auth-gated, so the recipient cannot actually read the document without a login — that part is fine.

**Remediation:** rate-limit `/deliveries` per user and per invoice; restrict `to` to the customer's on-file address for non-admins, recording any override in the audit trail; consider a daily cap. (`docs/COST-AND-LIMITS.md` already recommends Cloudflare Rate Limiting Rules as "recommended, not yet configured".)

### M4. `sales` can deactivate a customer, though the delete path is manager-only

**Location:** `src/api/schemas.ts:118-120` adds `isActive` to `customerUpdateSchema`, enforced only by `crm:write` at `src/api/routes/customers.ts:102`. The intended path, `DELETE /api/customers/:id` (a soft delete), correctly requires `crm:delete`, which `sales` lacks.

So `sales` reaches the same outcome by a different verb, and `app/lib/customer-payload.server.ts:50` sends `isActive` on **every** save.

**Remediation:** move `isActive` out of the general update schema into a manager-only field set, or raise the PATCH requirement when the diff touches it.

### M5. Check issuance races the vendor-bill balance

**Location:** `src/services/checkwriting.ts:97-110` validates against a read `bill.balanceCents`; `:142-158` writes `bill.balanceCents - entry.amountCents` from that stale read, outside one transaction. Two concurrent issues both pass validation and the second overwrites rather than compounds — two checks against one bill, payable understated. Admin-only and needs concurrency, but it is money.

**Remediation:** make the balance update relative (`balanceCents = balanceCents - :amount`) with a guard in the same statement, or re-read inside the batch. `recordInvoicePayment` (`src/services/invoicing.ts:547-561`) accumulates the same way and deserves the same treatment.

### M6. `/api/health` leaks driver error detail to anonymous callers

**Location:** `src/api/routes/health.ts:18-36` returns the raw driver `error.message` in the body of a 503, which can disclose table/column names and query fragments. Endpoint is unauthenticated by design.

**Remediation:** keep the boolean status, log the detail server-side, drop `databaseError` from the response.

---

## 4. Open — Low

| | Issue | Location |
|---|---|---|
| **L2** | PII in logs: recipient email logged when mail is unconfigured; unexpected errors log full stacks; observability is enabled at 100% sampling | `src/services/mailer.ts:107`, `src/api/app.ts:49`, `wrangler.toml:24` |
| **L3** | `GET /api/company` returns the EIN and licence to every authenticated role, including `sales` | `src/api/routes/company.ts:32` |
| **L4** | `workers_dev = true` exposes a second hostname bypassing domain-scoped WAF/Access/Rate-Limiting rules | `wrangler.toml:21` |
| **L5** | Check-number allocation is not in the insert's batch, so a failed batch burns a number (README claims otherwise). Uniqueness still holds | `src/services/checkwriting.ts:112` vs `:158` |
| **L6** | `quantity`, `acres`, `delta`, `factorToBase`, `density` have no upper bound; `1e300` passes and totals can overflow to `Infinity`. (Zod rejects `NaN`/`Infinity` itself) | `src/api/schemas.ts:357`, `:239`, `:288`, `:188` |
| **L7** | No `Cache-Control: no-store` on authenticated SSR HTML (the API sets it). Informational — Cloudflare does not cache HTML by default | `app/root.tsx` |

---

## 5. Already handled — verified, do not re-audit

- **Deny-by-default RBAC, enforced server-side on every route.** Every mutating endpoint carries `requirePermission`/`requireAdmin`; checkwriting is hard-locked with `checkRoutes.use('*', requireAdmin)` **before** any handler. `requireAuth` rejects revoked sessions, expired sessions and deactivated users on the next request.
- **No mass assignment.** Zod objects strip unknown keys (no `.passthrough()`), so `role`, `status`, `createdByUserId`, `verified` etc. cannot be injected. Sort keys are whitelisted against fixed maps; search terms capped at 40 chars to stay under D1's 50-byte `LIKE` limit.
- **No SQL injection.** Every `sql` template interpolates a Drizzle column or a bound parameter; nothing concatenates user input. The one raw `prepare` uses a constant.
- **Sessions are correct.** 32 bytes CSPRNG, only the SHA-256 digest persisted, httpOnly + Secure in production + Lax + path=/ + maxAge, no `Domain`, no fixation, server-side logout, and changing a password revokes all sessions.
- **Passwords.** Argon2id with per-digest parameters bounded above so a corrupt digest fails closed, constant-time comparison via the platform primitive, automatic rehash on sign-in, and a dummy hash with matching cost so the unknown-account path does not leak existence by timing.
- **Login abuse.** Per-email (10) and per-IP (50) rolling windows checked **before** the account lookup; generic 401; lockouts audited; unknown and wrong-password are indistinguishable.
- **XSS.** The only `dangerouslySetInnerHTML` is one static inline `<script>` in `app/root.tsx` that resolves the theme before paint — a module constant with no interpolation, so there is no injection surface. There is no `innerHTML`, `eval` or `document.write` anywhere. SSR and print output go through React escaping; outbound email HTML escapes every interpolated value.
- **No email header injection.** `to` is validated as an email and passed to the provider's JSON API, not raw SMTP; subjects are built from server-side values.
- **Seed-compliance gate is applied on both send and email delivery**; a zero-total invoice cannot be sent.
- **Check numbering cannot duplicate** — atomic `UPDATE … RETURNING` plus a unique index.
- **Audit trail is sound.** Append-only, admin-only, no write/delete endpoint; stores a before/after diff of changed fields only and redacts credential-shaped keys.
- **Off-money status transitions** (invoice send/cancel, check print/clear/void) correctly enforce `ALLOWED_TRANSITIONS`.
- **Secrets hygiene.** Nothing sensitive committed; `.dev.vars` gitignored; `wrangler.toml` holds no secrets.
- **R2 is unused in code** (no `env.DOCUMENTS` accessor), so there is no object-key or access-control problem yet.
- **Single-company by design.** No tenant column; `company_settings` is a singleton; shared staff access to all records is intended, so there is no cross-tenant IDOR to find.
- **Errors don't leak to API clients** — generic `internal_error` with a correlation id; unique violations map to a clean 409.

---

## 6. Functional gaps and open items

Not security — these block normal operation and are worth knowing before testing:

1. **Nothing ever sets `verified = true` on a compliance log.** Imports only insert `verified: false`, and no UI or CLI verifies one. **Regulated-seed invoices therefore cannot be sent at all** — the gate correctly refuses them. This is the single biggest functional blocker, and **H3 must be fixed in the same change** as whatever builds the verification step.
2. **The 2027 sheet still has no real prices.** Placeholder prices are now seeded (`pnpm prices:test`) so invoicing can be exercised, and they are tagged `TEST DATA (placeholder)` and removable with `pnpm prices:test -- --clear`. They must be cleared before real prices are loaded, or a placeholder reads as a quote someone entered.
3. **Customer fields cannot be cleared.** `parseCustomerForm` omits empty strings so a PATCH leaves the field untouched, and the API's optional text fields accept a string or nothing — not `null`. Clearing a phone number or address line is currently impossible.
4. **`PATCH /api/customers/:id` cannot be told to change only `isActive`** without also sending the rest of the payload — see M4.
5. **No user management screen.** `admin:users` exists and `pnpm user:create` covers the CLI, but there are no `/api/users` routes or UI.
6. **`reports:read` and some schemas are defined but unused** (`invoiceUpdateSchema`, `checkStatusSchema`) — dead surface, no exposure.
7. **R2 (`agpro-documents`) is provisioned but nothing writes to it.** Document storage is unbuilt.
8. **Nine product columns are never read** and are no longer rendered on the form: `category`, `pesticideType`, `seedTraitSystem`, `packageSize`, `activeIngredient`, `density`, `stateRestrictions`, `brand`, `markupPercent`. See the README's catalogue note. They are kept deliberately; the import parser still writes some of them.

### Closed since this document was written

- ~~No customer edit screen~~ — `customers/new` and `customers/:id` now exist, sharing one `CustomerForm`.
- ~~No way to test invoicing without prices~~ — see item 2; placeholders are seeded and reversible.
- ~~`requireUser` builds its `?next=` login redirect from `pathname`~~ — still open, but noted here rather than lost: an expired session on a client-side data request produces `next=/customers/<id>.data`, which lands on a JSON payload rather than a page. Low impact, one-line fix.

---

## 7. How to verify a fix

This project's gates, in order:

```
rtk pnpm typecheck     # react-router typegen + tsc, app + config projects
rtk pnpm test          # vitest in workerd against a real D1 — 188 tests
rtk pnpm smoke         # builds, boots a preview, signs in, walks every screen
```

`smoke` is the only gate that sees the React Router SSR layer. Three production bugs
came from that blind spot, so **add a smoke check for any fix that touches a form or a
route**, not just a unit test.

Two traps that cost real time:

- **Load a record page as a client-side request as well as a document.** React Router
  appends `.data` on client navigation, so a loader parsing the request URL sees
  `<id>.data`. The document request still passes, so a page check that only does a plain
  GET proves nothing. `checkPage` in `scripts/smoke.mjs` asserts both for this reason.
- **An unticked checkbox and an absent field are both missing from `FormData`.** If a
  form omits a field, the parser must treat it as "unchanged" — and checkboxes need a
  paired hidden `off` input so unticked stays distinguishable from removed.

Test files live beside what they cover: `src/services/*.test.ts` (services, real D1 via
`cloudflare:test`), `src/api/lib/*.test.ts` (crypto and schemas), `app/lib/*.test.ts`
(form payload contracts) and `test/api.test.ts` (routes and RBAC over the Hono app).

**Before pushing anything containing a migration:** `rtk pnpm db:migrate:remote`.
CI has no D1 permission, so a build cannot apply or verify one — see the README's **Deployment** section.
