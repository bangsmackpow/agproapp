/**
 * AG Pro Solutions — D1 / Drizzle schema (v2).
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * CONVENTIONS
 * ───────────
 * • Primary keys are application-generated UUIDv4 TEXT, portable across D1
 *   replicas and R2 keys.
 * • Timestamps are INTEGER unix milliseconds (`timestamp_ms`), default
 *   `unixepoch() * 1000`.
 * • MONEY IS INTEGER CENTS. Never float for settled money. Fractional rates
 *   (multipliers, costs per acre, quantities) are REAL and rounded to cents the
 *   instant they become an amount.
 * • Enum columns are constrained by the tuples in `src/shared/enums.ts`.
 * • Foreign keys declare `onDelete` explicitly; nothing cascades by accident.
 *
 * WHAT v2 LEFT OUT
 * ────────────────
 * The first build reached 33 tables. These 21 cover the business as it operates
 * today. The rest return with their module, not before it:
 *
 *   • accounts payable and checkwriting (vendor bills, bank accounts, checks)
 *   • the document parse/OCR review queue — R2 still stores uploads, nothing
 *     parses them
 *   • serialized drone units and service orders, for the future sales/repair line
 *   • warehouses, because stock is in one place
 *   • the units registry: a product is stocked and billed in one unit, and a
 *     program's ingredient rate is expressed in that same unit, so there is no
 *     conversion math to get wrong
 *   • lot-level inventory and FIFO allocation: stock is one pooled quantity per
 *     product, and lot numbers live on the compliance record that needs them
 */

import { relations, sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import {
  APPLICATION_METHODS,
  CROP_TYPES,
  DELIVERY_METHODS,
  DELIVERY_STATUSES,
  DOCUMENT_KINDS,
  INVOICE_LINE_TYPES,
  INVOICE_STATUSES,
  MOVEMENT_REFERENCE_TYPES,
  PAYMENT_METHODS,
  PRICE_TIER_KEYS,
  PRODUCT_TYPES,
  SERVICE_RATE_KINDS,
  SERVICE_RATE_UNITS,
  STOCK_MOVEMENT_TYPES,
  UNITS,
  USER_ROLES,
} from '../shared/enums';

/* ────────────────────────────────────────────────────────────────────────────
 * Column helpers
 * ──────────────────────────────────────────────────────────────────────────── */

const primaryId = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());

const unixMs = sql`(unixepoch() * 1000)`;

/** `created_at` / `updated_at`. `updated_at` is maintained by the app layer. */
const timestamps = () => ({
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(unixMs),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(unixMs),
});

/** Append-only rows never update, so they carry only `created_at`. */
const createdAtOnly = () => ({
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(unixMs),
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1. AUTH & ACCESS
 * ════════════════════════════════════════════════════════════════════════════ */

export const users = sqliteTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    /** Argon2id digest — never the plaintext password. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('staff'),
    phone: text('phone'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    ...timestamps(),
  },
  (t) => [uniqueIndex('users_email_unique').on(t.email), index('users_role_idx').on(t.role)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: primaryId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256 of the opaque cookie token. The raw token is never persisted. */
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Sign-in attempts, append-only. Backs brute-force protection and answers
 * "who has been trying to get in". Held in D1 rather than KV because KV
 * serializes writes to a single key to about one per second — exactly the access
 * pattern a credential-stuffing run produces.
 */
export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: primaryId(),
    /** Normalized (lower-cased) email, whether or not the account exists. */
    email: text('email').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    success: integer('success', { mode: 'boolean' }).notNull().default(false),
    ...createdAtOnly(),
  },
  (t) => [
    index('login_attempts_email_created_idx').on(t.email, t.createdAt),
    index('login_attempts_ip_created_idx').on(t.ipAddress, t.createdAt),
  ],
);

/**
 * Password-reset tokens. Only the SHA-256 digest is stored, and a token is
 * single-use: `usedAt` is set on redemption, so a stolen row cannot mint a
 * second reset.
 */
export const passwordResetTokens = sqliteTable(
  'password_reset_tokens',
  {
    id: primaryId(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    ipAddress: text('ip_address'),
    ...createdAtOnly(),
  },
  (t) => [
    uniqueIndex('password_reset_token_hash_unique').on(t.tokenHash),
    index('password_reset_user_idx').on(t.userId),
  ],
);

/**
 * The activity trail. Entries record *what changed*, not merely that something
 * did: `changes` holds a before/after diff of only the fields that differ.
 * Append-only — there is no update or delete path, in the schema or the API.
 */
export const activityLog = sqliteTable(
  'activity_log',
  {
    id: primaryId(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    changes: text('changes', { mode: 'json' }).$type<Record<string, { from: unknown; to: unknown }>>(),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    ...createdAtOnly(),
  },
  (t) => [
    index('activity_actor_idx').on(t.actorUserId),
    index('activity_entity_idx').on(t.entityType, t.entityId),
    index('activity_created_idx').on(t.createdAt),
  ],
);

/**
 * Singleton row (`id = 'primary'` by convention): letterhead, the default tax
 * rate, default terms, and the invoice number prefix. Everything here is
 * editable in Settings — no deploy to change a rate.
 *
 * `lastDigestAt` guards the low-stock email: the cron can retry, and a second
 * digest in the same morning would be noise, so the job claims the day here.
 */
export const settings = sqliteTable('settings', {
  id: text('id').primaryKey().default('primary'),
  legalName: text('legal_name').notNull().default('Agpro Solutions'),
  displayName: text('display_name').notNull().default('AG Pro Solutions'),
  addressLine1: text('address_line1').notNull().default('1200 E Howard St'),
  addressLine2: text('address_line2'),
  city: text('city').notNull().default('Creston'),
  state: text('state').notNull().default('IA'),
  postalCode: text('postal_code').notNull().default('50801'),
  country: text('country').notNull().default('US'),
  phone: text('phone'),
  email: text('email'),
  website: text('website'),
  ein: text('ein'),
  pesticideLicenseNumber: text('pesticide_license_number'),
  /** Decimal fraction, e.g. 0.07 for 7%. Iowa ag inputs are commonly exempt. */
  defaultTaxRate: real('default_tax_rate').notNull().default(0),
  defaultTermsDays: integer('default_terms_days').notNull().default(30),
  invoicePrefix: text('invoice_prefix').notNull().default('INV'),
  lastDigestAt: integer('last_digest_at', { mode: 'timestamp_ms' }),
  ...timestamps(),
});

/**
 * Allocated numbering for invoices and customer account numbers. One row per
 * scope, incremented with `UPDATE … RETURNING` inside the same batch as the
 * insert, so concurrent creates cannot be handed the same number.
 *
 * A failed create burns a number, so sequences show gaps; that is inherent to
 * allocated identifiers. `nextNumber` is the first number to be issued.
 */
export const counters = sqliteTable('counters', {
  scope: text('scope').primaryKey(),
  prefix: text('prefix').notNull(),
  nextNumber: integer('next_number').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(unixMs),
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. CRM & VENDORS
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The account a sale belongs to. A customer's address is copied onto each invoice
 * at issue time, so editing this record never rewrites a legal document.
 */
export const customers = sqliteTable(
  'customers',
  {
    id: primaryId(),
    /** Allocated from `counters` as `AGP-###`; never typed and never changed. */
    accountNumber: text('account_number').notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    phone: text('phone'),
    email: text('email'),

    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),

    /** Optional; when absent, an invoice ships to the billing address. */
    shipSameAsBill: integer('ship_same_as_bill', { mode: 'boolean' }).notNull().default(true),
    shipAddressLine1: text('ship_address_line1'),
    shipAddressLine2: text('ship_address_line2'),
    shipCity: text('ship_city'),
    shipState: text('ship_state'),
    shipPostalCode: text('ship_postal_code'),

    /** Required to issue a carry-tier invoice — see the issue gate. */
    pesticideLicenseNumber: text('pesticide_license_number'),
    pesticideLicenseExpiresAt: integer('pesticide_license_expires_at', { mode: 'timestamp_ms' }),

    /** Overrides the company default when set. */
    termsDays: integer('terms_days'),
    notes: text('notes'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('customers_account_number_unique').on(t.accountNumber),
    index('customers_name_idx').on(t.name),
    index('customers_phone_idx').on(t.phone),
  ],
);

/** Who to order from. Minimal by design: a reorder list is only useful with a name. */
export const vendors = sqliteTable(
  'vendors',
  {
    id: primaryId(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    phone: text('phone'),
    email: text('email'),
    accountNumber: text('account_number'),
    notes: text('notes'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('vendors_name_idx').on(t.name)],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 3. CATALOG & STOCK
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * A sellable item or stock ingredient, in exactly one division and one unit.
 *
 * `costCents` is the whole pricing story: nothing carries a price column, because
 * price is cost × the tier multiplier (see `src/shared/pricing.ts`). That makes
 * cost the one number that must be entered and kept current — a product with no
 * cost cannot be invoiced, and the app says so plainly rather than issuing it at
 * zero.
 *
 * The first build carried ~28 columns, nine of which no code ever read. Everything
 * here is read or written by something.
 */
export const products = sqliteTable(
  'products',
  {
    id: primaryId(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    /** Internal free text. Invoice lines describe themselves from `name`. */
    description: text('description'),
    type: text('type', { enum: PRODUCT_TYPES }).notNull().default('other'),
    /** The one unit this product is stocked and billed in. */
    unit: text('unit', { enum: UNITS }).notNull().default('each'),
    costCents: integer('cost_cents'),
    epaNumber: text('epa_number'),
    /** Regulated seed needs a compliance record attached before an invoice issues. */
    isRegulatedSeed: integer('is_regulated_seed', { mode: 'boolean' }).notNull().default(false),
    /** Stock at or below this triggers a reorder alert. Null means never alert. */
    reorderPoint: real('reorder_point'),
    reorderQuantity: real('reorder_quantity'),
    vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    notes: text('notes'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('products_sku_unique').on(t.sku),
    index('products_name_idx').on(t.name),
    index('products_type_idx').on(t.type),
    index('products_regulated_seed_idx').on(t.isRegulatedSeed),
  ],
);

/**
 * The stock ledger — the only source of truth for how much of a product exists.
 * On hand is `SUM(quantity_delta)`; it is never stored, so it cannot drift.
 *
 * Append-only and never pruned. Issuing an invoice writes `sale` rows; voiding
 * writes `reversal` rows that net them out. A correction is a new movement, which
 * is what keeps a recall or a "where did this go" question answerable years on.
 */
export const stockMovements = sqliteTable(
  'stock_movements',
  {
    id: primaryId(),
    /** `restrict`: the ledger must not lose the subject it describes. */
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    movementType: text('movement_type', { enum: STOCK_MOVEMENT_TYPES }).notNull(),
    /** Signed: receipts positive, sales and shrinkage negative. */
    quantityDelta: real('quantity_delta').notNull(),
    unit: text('unit', { enum: UNITS }),
    unitCostCents: integer('unit_cost_cents'),
    referenceType: text('reference_type', { enum: MOVEMENT_REFERENCE_TYPES }),
    referenceId: text('reference_id'),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    note: text('note'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...createdAtOnly(),
  },
  (t) => [
    index('stock_product_idx').on(t.productId, t.occurredAt),
    index('stock_reference_idx').on(t.referenceType, t.referenceId),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 4. PRICING ENGINE
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The configurable margin tiers. Multipliers are the whole pricing rule; an Admin
 * edits them in Settings, and application code always reads them from here.
 */
export const priceTiers = sqliteTable(
  'price_tiers',
  {
    id: primaryId(),
    key: text('key', { enum: PRICE_TIER_KEYS }).notNull(),
    label: text('label').notNull(),
    description: text('description'),
    multiplier: real('multiplier').notNull(),
    requiresApplication: integer('requires_application', { mode: 'boolean' }).notNull().default(false),
    requiresPesticideLicense: integer('requires_pesticide_license', { mode: 'boolean' })
      .notNull()
      .default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('price_tiers_key_unique').on(t.key), index('price_tiers_sort_idx').on(t.sortOrder)],
);

/** A named blend, e.g. "CORN (1 PASS)". Edited in place as rates change by year. */
export const programs = sqliteTable(
  'programs',
  {
    id: primaryId(),
    name: text('name').notNull(),
    crop: text('crop', { enum: CROP_TYPES }).notNull().default('other'),
    notes: text('notes'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('programs_name_unique').on(t.name), index('programs_crop_idx').on(t.crop)],
);

/**
 * One ingredient inside a program. `ratePerAcre` is in the ingredient product's
 * own stock unit — which is why there is no conversion layer: the number you
 * enter is the number that is drawn from the pool.
 */
export const programIngredients = sqliteTable(
  'program_ingredients',
  {
    id: primaryId(),
    programId: text('program_id')
      .notNull()
      .references(() => programs.id, { onDelete: 'cascade' }),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    ratePerAcre: real('rate_per_acre').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('program_ingredients_program_idx').on(t.programId)],
);

/**
 * Charges that are neither a product nor a program: drone application per acre,
 * ground application per acre, mileage per mile. Rates live here so the mileage
 * price changes with fuel without a deploy.
 */
export const serviceRates = sqliteTable(
  'service_rates',
  {
    id: primaryId(),
    kind: text('kind', { enum: SERVICE_RATE_KINDS }).notNull().default('other'),
    label: text('label').notNull(),
    method: text('method', { enum: APPLICATION_METHODS }),
    unit: text('unit', { enum: SERVICE_RATE_UNITS }).notNull().default('each'),
    priceCents: integer('price_cents').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('service_rates_kind_idx').on(t.kind, t.isActive)],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 5. INVOICING / ACCOUNTS RECEIVABLE
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * An invoice. `draft` is editable; `issued` is immutable and corrected by voiding
 * and reissuing, which is why there is no reconciliation logic anywhere: nothing
 * ever mutates a document that has already moved stock.
 *
 * Party addresses are copied from the customer at issue time and stored as JSON.
 * Invoices are legal documents, so a later edit to the customer record must never
 * rewrite the address printed on one.
 */
export const invoices = sqliteTable(
  'invoices',
  {
    id: primaryId(),
    invoiceNumber: text('invoice_number').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),

    pricingTierKey: text('pricing_tier_key', { enum: PRICE_TIER_KEYS }),

    issueDate: integer('issue_date', { mode: 'timestamp_ms' }).notNull(),
    dueDate: integer('due_date', { mode: 'timestamp_ms' }),
    termsDays: integer('terms_days'),
    poNumber: text('po_number'),
    serviceAcres: real('service_acres'),

    /** Snapshotted at issue time; the settings row may change afterwards. */
    taxRate: real('tax_rate').notNull().default(0),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    amountPaidCents: integer('amount_paid_cents').notNull().default(0),
    balanceCents: integer('balance_cents').notNull().default(0),

    billTo: text('bill_to', { mode: 'json' }).$type<Record<string, string | null>>(),
    shipTo: text('ship_to', { mode: 'json' }).$type<Record<string, string | null>>(),

    notes: text('notes'),
    internalNotes: text('internal_notes'),

    issuedAt: integer('issued_at', { mode: 'timestamp_ms' }),
    voidedAt: integer('voided_at', { mode: 'timestamp_ms' }),
    voidReason: text('void_reason'),

    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invoices_number_unique').on(t.invoiceNumber),
    index('invoices_customer_idx').on(t.customerId),
    index('invoices_status_idx').on(t.status),
    index('invoices_issue_date_idx').on(t.issueDate),
  ],
);

/**
 * One line on an invoice.
 *
 * Each line snapshots the unit price, the unit cost, and the resulting margin, so
 * an issued invoice explains its own economics years later even after a cost
 * changes. There are no discount or taxable columns: discounts were never used,
 * and tax is one invoice-level rate.
 */
export const invoiceItems = sqliteTable(
  'invoice_items',
  {
    id: primaryId(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineType: text('line_type', { enum: INVOICE_LINE_TYPES }).notNull(),

    programId: text('program_id').references(() => programs.id, { onDelete: 'set null' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    serviceRateId: text('service_rate_id').references(() => serviceRates.id, {
      onDelete: 'set null',
    }),
    /** Regulated seed lines point at the evidence that clears them. */
    seedRecordId: text('seed_record_id').references(() => seedRecords.id, {
      onDelete: 'set null',
    }),

    description: text('description').notNull(),
    /** Acreage-priced lines carry acres here; quantity-priced lines carry units. */
    quantity: real('quantity').notNull().default(1),
    unit: text('unit', { enum: UNITS }),

    unitPriceCents: integer('unit_price_cents').notNull(),
    unitCostCents: integer('unit_cost_cents'),
    marginPercent: real('margin_percent'),
    lineTotalCents: integer('line_total_cents').notNull(),

    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [index('invoice_items_invoice_idx').on(t.invoiceId, t.sortOrder)],
);

/**
 * Money received. A row per payment rather than a counter on the invoice, so a
 * deposit is a fact with a date, method, and reference — which is what reconciling
 * a bank statement actually needs.
 */
export const payments = sqliteTable(
  'payments',
  {
    id: primaryId(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'restrict' }),
    amountCents: integer('amount_cents').notNull(),
    method: text('method', { enum: PAYMENT_METHODS }).notNull().default('check'),
    reference: text('reference'),
    paidAt: integer('paid_at', { mode: 'timestamp_ms' }).notNull(),
    recordedByUserId: text('recorded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...createdAtOnly(),
  },
  (t) => [index('payments_invoice_idx').on(t.invoiceId, t.paidAt)],
);

/** What left the office, and whether it actually went. */
export const invoiceDeliveries = sqliteTable(
  'invoice_deliveries',
  {
    id: primaryId(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    method: text('method', { enum: DELIVERY_METHODS }).notNull(),
    destination: text('destination'),
    providerMessageId: text('provider_message_id'),
    /** `sent`, `failed`, or `skipped` when no mail provider is configured. */
    status: text('status', { enum: DELIVERY_STATUSES }).notNull().default('sent'),
    error: text('error'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    ...createdAtOnly(),
  },
  (t) => [index('invoice_deliveries_invoice_idx').on(t.invoiceId)],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 6. IOWA SEED COMPLIANCE
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The paperwork the State of Iowa requires when regulated seed is sold.
 *
 * The record *is* the evidence: holding the three required tokens makes the line
 * issuable. The first build added a `verified` flag with no workflow ever setting
 * it, which made every regulated-seed invoice unsendable — a gate nobody could
 * pass is not a gate.
 *
 * Unique over (bol_cmr_number, order_number, lot_number) so the same paperwork
 * cannot be entered twice. It is not capped by quantity: one record can back any
 * number of lines, a deliberate simplification that leaves over-reuse a human
 * judgement rather than a ledger constraint.
 */
export const seedRecords = sqliteTable(
  'seed_records',
  {
    id: primaryId(),
    bolCmrNumber: text('bol_cmr_number').notNull(),
    orderNumber: text('order_number').notNull(),
    lotNumber: text('lot_number').notNull(),
    seedNumber: text('seed_number'),
    shipperNumber: text('shipper_number'),
    poNumber: text('po_number'),

    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** How much the record covers, and when it was bought. */
    quantity: real('quantity'),
    unit: text('unit', { enum: UNITS }),
    purchasedAt: integer('purchased_at', { mode: 'timestamp_ms' }),

    /** The scanned bill of lading, if one is filed. */
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    notes: text('notes'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('seed_records_tokens_unique').on(t.bolCmrNumber, t.orderNumber, t.lotNumber),
    index('seed_records_customer_idx').on(t.customerId),
    index('seed_records_product_idx').on(t.productId),
  ],
);

/**
 * An uploaded file in R2 — a scanned BOL, a price sheet.
 *
 * Only storage: the first build's parse-and-review pipeline is gone until there is
 * a document worth parsing. Uploads are attached to the record that needs them.
 */
export const documents = sqliteTable(
  'documents',
  {
    id: primaryId(),
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    kind: text('kind', { enum: DOCUMENT_KINDS }).notNull().default('other'),
    checksumSha256: text('checksum_sha256'),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('documents_r2_key_unique').on(t.r2Key),
    index('documents_kind_idx').on(t.kind),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * RELATIONS (for `db.query.*`)
 * ════════════════════════════════════════════════════════════════════════════ */

export const customersRelations = relations(customers, ({ many }) => ({
  invoices: many(invoices),
}));

export const productsRelations = relations(products, ({ many }) => ({
  movements: many(stockMovements),
  ingredientsIn: many(programIngredients),
}));

export const programsRelations = relations(programs, ({ many }) => ({
  ingredients: many(programIngredients),
}));

export const programIngredientsRelations = relations(programIngredients, ({ one }) => ({
  program: one(programs, { fields: [programIngredients.programId], references: [programs.id] }),
  product: one(products, { fields: [programIngredients.productId], references: [products.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  items: many(invoiceItems),
  payments: many(payments),
  deliveries: many(invoiceDeliveries),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceItems.invoiceId], references: [invoices.id] }),
  product: one(products, { fields: [invoiceItems.productId], references: [products.id] }),
  program: one(programs, { fields: [invoiceItems.programId], references: [programs.id] }),
  seedRecord: one(seedRecords, {
    fields: [invoiceItems.seedRecordId],
    references: [seedRecords.id],
  }),
}));

/* ════════════════════════════════════════════════════════════════════════════
 * INFERRED TYPES
 * ════════════════════════════════════════════════════════════════════════════ */

export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type ActivityLogEntry = typeof activityLog.$inferSelect;
export type Settings = typeof settings.$inferSelect;
export type Customer = typeof customers.$inferSelect;
export type Vendor = typeof vendors.$inferSelect;
export type Product = typeof products.$inferSelect;
export type StockMovement = typeof stockMovements.$inferSelect;
export type PriceTier = typeof priceTiers.$inferSelect;
export type Program = typeof programs.$inferSelect;
export type ProgramIngredient = typeof programIngredients.$inferSelect;
export type ServiceRate = typeof serviceRates.$inferSelect;
export type Invoice = typeof invoices.$inferSelect;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type Payment = typeof payments.$inferSelect;
export type InvoiceDelivery = typeof invoiceDeliveries.$inferSelect;
export type SeedRecord = typeof seedRecords.$inferSelect;
export type Document = typeof documents.$inferSelect;

export type NewStockMovement = typeof stockMovements.$inferInsert;
export type NewActivityLogEntry = typeof activityLog.$inferInsert;
export type NewInvoice = typeof invoices.$inferInsert;
export type NewInvoiceItem = typeof invoiceItems.$inferInsert;
