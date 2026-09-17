/**
 * AG Pro Solutions — D1 / Drizzle schema.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * CONVENTIONS
 * ───────────
 * • Primary keys are application-generated UUIDv4 TEXT (`crypto.randomUUID()`),
 *   which keeps IDs portable across D1 replicas, R2 keys and future sync.
 * • Timestamps are INTEGER unix milliseconds. Column type is `timestamp_ms`
 *   so Drizzle hands you `Date` objects; the DB default is `unixepoch() * 1000`.
 * • MONEY IS INTEGER CENTS. Every `*_cents` column is an integer number of USD
 *   minor units. Never store settled money as REAL. Per-unit *rates* that are
 *   fractional in the source data (e.g. $34.632/oz) use REAL and are rounded to
 *   cents the instant they become an amount — see `src/shared/pricing.ts`.
 * • Enum columns are constrained by the tuples in `src/shared/enums.ts`.
 * • Foreign keys declare `onDelete` explicitly; nothing cascades by accident.
 *
 * MODELLING NOTE — PROGRAMS VS PRODUCTS
 * ─────────────────────────────────────
 * The source worksheets (`2027_chemical_prices.xlsx`, `chemical_inventory.xlsx`)
 * price a *blend*, not a single bottle: a named program is a set of ingredients
 * with a rate/acre and cost/acre, and the four margin tiers are priced on the
 * program total. So a program is the normal sellable unit, billed per acre.
 * `products` still carries flat `financed_app_price_cents` / `cash_app_price_cents`
 * / `carry_price_cents` for misc, carry-only and drone items that are not blends.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { relations, sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

import {
  APPLICATION_METHODS,  CHECK_STATUSES,
  COMPLIANCE_SOURCES,
  CROP_TYPES,
  DELIVERY_METHODS,
  DOCUMENT_TYPES,
  DRONE_UNIT_STATUSES,
  IMPORT_BATCH_STATUSES,
  IMPORT_DRAFT_STATUSES,
  IMPORT_TARGETS,
  INVENTORY_MOVEMENT_TYPES,
  INVOICE_LINE_TYPES,
  INVOICE_STATUSES,
  PAYMENT_METHODS,
  PRICE_TIER_KEYS,
  PRODUCT_TYPES,
  PROGRAM_STAGES,
  MOVEMENT_REFERENCE_TYPES,
  UNITS,
  UNIT_DIMENSIONS,
  USER_ROLES,
  VENDOR_BILL_STATUSES,
} from '../shared/enums';
import type { CheckTemplateConfig } from '../shared/check-template';

/* ────────────────────────────────────────────────────────────────────────────
 * Column helpers
 * ──────────────────────────────────────────────────────────────────────────── */

/** Application-generated UUID primary key. */
const primaryId = () => text('id').primaryKey().$defaultFn(() => crypto.randomUUID());

/** Default expression matching Drizzle's `timestamp_ms` integer format. */
const unixMs = sql`(unixepoch() * 1000)`;

/** `created_at` / `updated_at` pair. `updated_at` is maintained by the app layer. */
const timestamps = () => ({
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(unixMs),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().default(unixMs),
});

/* ════════════════════════════════════════════════════════════════════════════
 * 1. AUTH, SESSIONS & AUDIT
 * ════════════════════════════════════════════════════════════════════════════ */

export const users = sqliteTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    /** Argon2id digest — never the plaintext password. Legacy PBKDF2 digests are accepted and upgraded on sign-in. */
    passwordHash: text('password_hash').notNull(),
    name: text('name').notNull(),
    role: text('role', { enum: USER_ROLES }).notNull().default('sales'),
    phone: text('phone'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('users_email_unique').on(t.email),
    index('users_role_idx').on(t.role),
  ],
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

/** Administrative trail. Backs the Admin-exclusive "system configuration logs". */
export const auditLogs = sqliteTable(  'audit_logs',
  {
    id: primaryId(),
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id'),
    metadata: text('metadata', { mode: 'json' }).$type<Record<string, unknown>>(),
    ipAddress: text('ip_address'),
    ...timestamps(),
  },
  (t) => [
    index('audit_logs_actor_idx').on(t.actorUserId),
    index('audit_logs_entity_idx').on(t.entityType, t.entityId),
    index('audit_logs_created_idx').on(t.createdAt),
  ],
);

/**
 * Sign-in attempts. Append-only.
 *
 * Backs brute-force protection and gives an internal tool a usable answer to
 * "who has been trying to get in". Held in D1 rather than KV because KV
 * serialises writes to a single key to roughly one per second, which is exactly
 * the access pattern a credential-stuffing run produces.
 */
export const loginAttempts = sqliteTable(
  'login_attempts',
  {
    id: primaryId(),
    /** Normalised (lower-cased) email, whether or not the account exists. */
    email: text('email').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    success: integer('success', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().default(unixMs),
  },
  (t) => [
    index('login_attempts_email_created_idx').on(t.email, t.createdAt),
    index('login_attempts_ip_created_idx').on(t.ipAddress, t.createdAt),
    index('login_attempts_created_idx').on(t.createdAt),
  ],
);

/** Singleton row (enforced by convention: `id = 'primary'`). */
export const companySettings = sqliteTable('company_settings', {
  id: primaryId(),
  legalName: text('legal_name').notNull().default('AG Pro Solutions LLC'),
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
  invoiceTermsDays: integer('invoice_terms_days').notNull().default(30),
  defaultCurrency: text('default_currency').notNull().default('USD'),
  /** Absolute offsets (inches) for the three-part check print template. */
  checkTemplateConfig: text('check_template_config', { mode: 'json' }).$type<CheckTemplateConfig>(),
  ...timestamps(),
});

/* ════════════════════════════════════════════════════════════════════════════
 * 2. CRM
 * ════════════════════════════════════════════════════════════════════════════ */

export const customers = sqliteTable(
  'customers',
  {
    id: primaryId(),
    accountNumber: text('account_number').notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    phone: text('phone'),
    email: text('email'),

    billLine1: text('bill_line1'),
    billLine2: text('bill_line2'),
    billCity: text('bill_city'),
    billState: text('bill_state'),
    billPostalCode: text('bill_postal_code'),

    shipLine1: text('ship_line1'),
    shipLine2: text('ship_line2'),
    shipCity: text('ship_city'),
    shipState: text('ship_state'),
    shipPostalCode: text('ship_postal_code'),

    /**
     * Iowa pesticide applicator/dealer licence. REQUIRED at time of sale for
     * carry tiers — see `requiresPesticideLicense()` in src/shared/pricing.ts.
     */
    pesticideLicenseNumber: text('pesticide_license_number'),
    pesticideLicenseExpiresAt: integer('pesticide_license_expires_at', { mode: 'timestamp_ms' }),
    resaleCertificateNumber: text('resale_certificate_number'),

    taxExempt: integer('tax_exempt', { mode: 'boolean' }).notNull().default(false),
    defaultTermsDays: integer('default_terms_days'),
    creditLimitCents: integer('credit_limit_cents'),
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

/**
 * Account-number sequence for customers.
 *
 * Matches the `invoice_sequences` shape, minus `scope` — there is only ever one
 * customer sequence, so a discriminator would be noise.
 *
 * The starting row is inserted by the migration rather than the reference seed.
 * Invoice numbering depends on a hand-applied seed, which means a database that
 * has been migrated but not seeded cannot write an invoice at all; that trap is
 * worth not repeating. `next_number` is the *first number to be issued*, not the
 * last used.
 */
export const customerSequences = sqliteTable('customer_sequences', {
  id: primaryId(),
  prefix: text('prefix').notNull().default('AGP'),
  nextNumber: integer('next_number').notNull().default(57),
  ...timestamps(),
});

/* ════════════════════════════════════════════════════════════════════════════
 * 3. VENDORS, DOCUMENTS & INGESTION
 * ════════════════════════════════════════════════════════════════════════════ */

export const vendors = sqliteTable(
  'vendors',
  {
    id: primaryId(),
    /** Stable slug used by the parser registry, e.g. `wickman_chemical`. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    contactName: text('contact_name'),
    phone: text('phone'),
    email: text('email'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    accountNumber: text('account_number'),
    defaultTermsDays: integer('default_terms_days'),
    defaultPaymentMethod: text('default_payment_method', { enum: PAYMENT_METHODS }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('vendors_code_unique').on(t.code),
    index('vendors_name_idx').on(t.name),
  ],
);

/** An uploaded artefact in R2 (scanned BOL, vendor invoice, price sheet). */
export const documents = sqliteTable(
  'documents',
  {
    id: primaryId(),
    r2Key: text('r2_key').notNull(),
    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    docType: text('doc_type', { enum: DOCUMENT_TYPES }).notNull().default('other'),
    vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    pageCount: integer('page_count'),
    checksumSha256: text('checksum_sha256'),
    /** Raw parser output, retained for audit even after review. */
    parsedPayload: text('parsed_payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    parsedAt: integer('parsed_at', { mode: 'timestamp_ms' }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('documents_r2_key_unique').on(t.r2Key),
    index('documents_doc_type_idx').on(t.docType),
    index('documents_vendor_idx').on(t.vendorId),
    index('documents_customer_idx').on(t.customerId),
  ],
);

/**
 * Staged import batch: one uploaded document's worth of proposed rows, held in
 * the human review queue until an operator commits it. Nothing reaches live
 * inventory without passing through here.
 */
export const importBatches = sqliteTable(
  'import_batches',
  {
    id: primaryId(),
    label: text('label').notNull(),
    vendorId: text('vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    docType: text('doc_type', { enum: DOCUMENT_TYPES }).notNull().default('other'),
    /** Which parser produced this batch, e.g. `channel_bol_v1`. */
    parserKey: text('parser_key'),
    status: text('status', { enum: IMPORT_BATCH_STATUSES }).notNull().default('draft'),
    rowCount: integer('row_count').notNull().default(0),
    committedCount: integer('committed_count').notNull().default(0),
    uploadedByUserId: text('uploaded_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    committedAt: integer('committed_at', { mode: 'timestamp_ms' }),
    committedByUserId: text('committed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    index('import_batches_status_idx').on(t.status),
    index('import_batches_vendor_idx').on(t.vendorId),
    index('import_batches_document_idx').on(t.documentId),
  ],
);

/** A single proposed row awaiting review. Polymorphic target by design. */
export const importDrafts = sqliteTable(
  'import_drafts',
  {
    id: primaryId(),
    batchId: text('batch_id')
      .notNull()
      .references(() => importBatches.id, { onDelete: 'cascade' }),
    target: text('target', { enum: IMPORT_TARGETS }).notNull(),
    lineNumber: integer('line_number'),
    status: text('status', { enum: IMPORT_DRAFT_STATUSES }).notNull().default('pending'),
    /** Parser self-assessment 0..1; low values drive review ordering. */
    confidence: real('confidence'),
    rawPayload: text('raw_payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    parsedPayload: text('parsed_payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    issues: text('issues', { mode: 'json' }).$type<string[]>(),
    committedRecordId: text('committed_record_id'),
    reviewedByUserId: text('reviewed_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    ...timestamps(),
  },
  (t) => [
    index('import_drafts_batch_idx').on(t.batchId),
    index('import_drafts_status_idx').on(t.status),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 4. CATALOGUE & INVENTORY
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Units of measure.
 *
 * A table rather than a fixed list, because the business registers units as it
 * goes and an Admin should not need a deploy to add "2.5 gal jug".
 *
 * The six `unit`-style columns elsewhere stay TEXT: Drizzle's column `enum` is a
 * TypeScript-level constraint with no SQL CHECK behind it, so this table becomes
 * the *validation* source rather than a foreign key. That is why introducing it
 * needs no data migration — existing values keep working and are checked against
 * the registry at the API boundary.
 *
 * `factor_to_base` expresses the unit in base units of its own dimension, so
 * conversion within a dimension is multiplication. `fl oz` is the volume base and
 * `lb` the mass base, matching how the sheets are written.
 */
export const units = sqliteTable(
  'units',
  {
    code: text('code').primaryKey(),
    label: text('label').notNull(),
    dimension: text('dimension', { enum: UNIT_DIMENSIONS }).notNull(),
    factorToBase: real('factor_to_base').notNull().default(1),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [index('units_dimension_idx').on(t.dimension)],
);

export const products = sqliteTable(
  'products',
  {
    id: primaryId(),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    /**
     * Free text for the catalogue — what the item actually is and what it is for.
     *
     * Internal only: invoice lines describe themselves from the product *name*, so
     * this never reaches a customer-facing document.
     */
    description: text('description'),
    /** Inventory division: chemical | seed | drone | misc. */
    type: text('type', { enum: PRODUCT_TYPES }).notNull(),
    brand: text('brand'),
    manufacturer: text('manufacturer'),
    unit: text('unit').notNull().default('each'),
    /**
     * The unit stock is pooled and reported in. Null means "use `unit`".
     *
     * A product bought in 2.5 gal jugs and applied at 32 oz/acre still holds
     * stock in one canonical unit; every quantity is converted into this before
     * being summed, which is what makes a running total meaningful.
     */
    baseUnitCode: text('base_unit_code'),
    /**
     * Fallback margin for flat items that carry no explicit tier price.
     * The 2027 sheet is unpriced, so this is how a product gets a sell price.
     */
    markupPercent: real('markup_percent').notNull().default(10),
    packageSize: text('package_size'),
    category: text('category'),

    /* Chemical regulatory attributes (EPA numbers appear on Wickman/I&B docs) */
    epaNumber: text('epa_number'),
    pesticideType: text('pesticide_type'),
    activeIngredient: text('active_ingredient'),
    density: real('density'),
    /** e.g. `["AK","CA","HI"]` — parsed from vendor item descriptions. */
    stateRestrictions: text('state_restrictions', { mode: 'json' }).$type<string[]>(),

    /* Seed regulatory attributes (Channel BOL carries lot + Seed NO) */
    isRegulatedSeed: integer('is_regulated_seed', { mode: 'boolean' }).notNull().default(false),
    seedTraitSystem: text('seed_trait_system'),

    /* Drone inventory is unit-serialized */
    isSerialized: integer('is_serialized', { mode: 'boolean' }).notNull().default(false),

    /* Flat per-product price fallback, in cents (spec tiers) */
    financedAppPriceCents: integer('financed_app_price_cents'),
    cashAppPriceCents: integer('cash_app_price_cents'),
    carryPriceCents: integer('carry_price_cents'),

    defaultCostCents: integer('default_cost_cents'),
    taxable: integer('taxable', { mode: 'boolean' }).notNull().default(true),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('products_sku_unique').on(t.sku),
    index('products_name_idx').on(t.name),
    index('products_type_idx').on(t.type),
    index('products_epa_idx').on(t.epaNumber),
  ],
);

/** Dated cost basis. Lets an invoice reproduce the cost it was priced from. */
export const productCosts = sqliteTable(
  'product_costs',
  {
    id: primaryId(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    costCents: integer('cost_cents').notNull(),
    unit: text('unit'),
    effectiveFrom: integer('effective_from', { mode: 'timestamp_ms' }).notNull(),
    effectiveTo: integer('effective_to', { mode: 'timestamp_ms' }),
    sourceVendorId: text('source_vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    sourceDocumentId: text('source_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    index('product_costs_product_idx').on(t.productId),
    index('product_costs_from_idx').on(t.effectiveFrom),
  ],
);

export const warehouses = sqliteTable(
  'warehouses',
  {
    id: primaryId(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    addressLine1: text('address_line1'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('warehouses_code_unique').on(t.code)],
);

/**
 * Lot-level stock. Seed is tracked by lot + Seed NO to satisfy Iowa seed-audit
 * requirements; chemicals are tracked by lot for traceability and FIFO costing.
 */
export const inventoryLots = sqliteTable(
  'inventory_lots',
  {
    id: primaryId(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    warehouseId: text('warehouse_id').references(() => warehouses.id, { onDelete: 'set null' }),
    lotNumber: text('lot_number'),
    /** Channel BOL "Seed NO." field. */
    seedNumber: text('seed_number'),
    expirationDate: integer('expiration_date', { mode: 'timestamp_ms' }),
    quantityOnHand: real('quantity_on_hand').notNull().default(0),
    quantityReserved: real('quantity_reserved').notNull().default(0),
    unitCostCents: integer('unit_cost_cents'),
    receivedAt: integer('received_at', { mode: 'timestamp_ms' }),
    sourceVendorId: text('source_vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    sourceDocumentId: text('source_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    index('inventory_lots_product_idx').on(t.productId),
    index('inventory_lots_warehouse_idx').on(t.warehouseId),
    index('inventory_lots_lot_idx').on(t.lotNumber),
    index('inventory_lots_seed_idx').on(t.seedNumber),
  ],
);

/** One row per physical drone. `serialNumber` is the identity that matters. */
export const droneUnits = sqliteTable(
  'drone_units',
  {
    id: primaryId(),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    serialNumber: text('serial_number').notNull(),
    status: text('status', { enum: DRONE_UNIT_STATUSES }).notNull().default('in_stock'),
    costCents: integer('cost_cents'),
    warrantyExpiresAt: integer('warranty_expires_at', { mode: 'timestamp_ms' }),
    lotId: text('lot_id').references(() => inventoryLots.id, { onDelete: 'set null' }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('drone_units_serial_unique').on(t.serialNumber),
    index('drone_units_product_idx').on(t.productId),
    index('drone_units_status_idx').on(t.status),
  ],
);

/**
 * Append-only stock ledger. The source of truth for how much of a product exists.
 *
 * Stock is pooled per product rather than partitioned by lot, because a gallon of
 * herbicide is a gallon of herbicide and nobody should have to pick 1 from one
 * batch and 13 from another to sell 14. Lots remain as *receipts* recording where
 * stock came from and what it cost; FIFO allocation draws on them behind the
 * scenes purely to compute cost of goods sold, and the allocation is written here
 * so a recall question can still be answered after the fact.
 *
 * Nothing prunes this table. Audit rows record actions and are archived after
 * twelve months; these are financial data, and pruning them would reset every
 * running total and destroy margin history.
 */
export const inventoryMovements = sqliteTable(
  'inventory_movements',
  {
    id: primaryId(),
    /** `restrict`: the ledger must not lose the subject it describes. */
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    /** The receipt drawn on, when FIFO allocation attributed this movement. */
    lotId: text('lot_id').references(() => inventoryLots.id, { onDelete: 'set null' }),
    movementType: text('movement_type', { enum: INVENTORY_MOVEMENT_TYPES }).notNull(),
    /** Signed: receipts positive, sales and write-offs negative. */
    quantityDelta: real('quantity_delta').notNull(),
    unit: text('unit'),
    /** The same quantity in the product's base unit, so the pool is a plain SUM. */
    quantityInBase: real('quantity_in_base').notNull(),
    unitCostCents: integer('unit_cost_cents'),
    referenceType: text('reference_type', { enum: MOVEMENT_REFERENCE_TYPES }),
    referenceId: text('reference_id'),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    note: text('note'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    index('inventory_movements_product_idx').on(t.productId, t.occurredAt),
    index('inventory_movements_lot_idx').on(t.lotId),
    index('inventory_movements_reference_idx').on(t.referenceType, t.referenceId),
  ],
);
/* ════════════════════════════════════════════════════════════════════════════
 * 5. PRICING ENGINE
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * The configurable markup tiers. Seeded from DEFAULT_TIER_MULTIPLIERS but
 * editable by an Admin — the database, not the code, is the source of truth.
 */
export const priceTiers = sqliteTable(
  'price_tiers',
  {
    id: primaryId(),
    key: text('key', { enum: PRICE_TIER_KEYS }).notNull(),
    label: text('label').notNull(),
    description: text('description'),
    /** Multiplier applied to the cost basis, e.g. 1.20. */
    multiplier: real('multiplier').notNull(),
    requiresApplication: integer('requires_application', { mode: 'boolean' })
      .notNull()
      .default(false),
    requiresPesticideLicense: integer('requires_pesticide_license', { mode: 'boolean' })
      .notNull()
      .default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('price_tiers_key_unique').on(t.key),
    index('price_tiers_sort_idx').on(t.sortOrder),
  ],
);

/** A named blend, e.g. "CORN (1 PASS)" or "BEAN POST / FLEX". */
export const applicationPrograms = sqliteTable(
  'application_programs',
  {
    id: primaryId(),
    name: text('name').notNull(),
    crop: text('crop', { enum: CROP_TYPES }).notNull().default('other'),
    stage: text('stage', { enum: PROGRAM_STAGES }).notNull().default('other'),
    passCount: integer('pass_count').notNull().default(1),
    /** Trait platform from the sheet, e.g. Single | Dual | E3 | Flex. */
    traitSystem: text('trait_system'),
    defaultApplicationMethod: text('default_application_method', { enum: APPLICATION_METHODS })
      .notNull()
      .default('drone'),
    seasonYear: integer('season_year'),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('application_programs_name_season_unique').on(t.name, t.seasonYear),
    index('application_programs_crop_stage_idx').on(t.crop, t.stage),
  ],
);

/** One ingredient line inside a program: product + rate/acre + cost/acre. */
export const programIngredients = sqliteTable(
  'program_ingredients',
  {
    id: primaryId(),
    programId: text('program_id')
      .notNull()
      .references(() => applicationPrograms.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    /** Preserves the sheet's spelling when no catalogue product matches yet. */
    productNameRaw: text('product_name_raw'),
    ratePerAcre: real('rate_per_acre'),
    rateUnit: text('rate_unit', { enum: UNITS }),
    costPerAcreCents: integer('cost_per_acre_cents'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('program_ingredients_program_idx').on(t.programId),
    index('program_ingredients_product_idx').on(t.productId),
  ],
);

/**
 * The price of a whole program, per acre, for one tier, in one season.
 * Dated so the 2024 and 2027 price sheets can coexist.
 */
export const programPrices = sqliteTable(
  'program_prices',
  {
    id: primaryId(),
    programId: text('program_id')
      .notNull()
      .references(() => applicationPrograms.id, { onDelete: 'cascade' }),
    tierId: text('tier_id')
      .notNull()
      .references(() => priceTiers.id, { onDelete: 'cascade' }),
    pricePerAcreCents: integer('price_per_acre_cents').notNull(),
    costPerAcreCents: integer('cost_per_acre_cents'),
    /** Multiplier actually applied, retained for auditability. */
    multiplierApplied: real('multiplier_applied'),
    effectiveFrom: integer('effective_from', { mode: 'timestamp_ms' }).notNull(),
    effectiveTo: integer('effective_to', { mode: 'timestamp_ms' }),
    /** Provenance, e.g. `2027_chemical_prices.xlsx!AG Pro 2027`. */
    sourceSheet: text('source_sheet'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('program_prices_unique').on(t.programId, t.tierId, t.effectiveFrom),
    index('program_prices_tier_idx').on(t.tierId),
    index('program_prices_effective_idx').on(t.effectiveFrom),
  ],
);

/** Service fees by application method, per acre. */
export const applicationFees = sqliteTable(
  'application_fees',
  {
    id: primaryId(),
    method: text('method', { enum: APPLICATION_METHODS }).notNull(),
    label: text('label').notNull(),
    pricePerAcreCents: integer('price_per_acre_cents').notNull(),
    crop: text('crop', { enum: CROP_TYPES }),
    effectiveFrom: integer('effective_from', { mode: 'timestamp_ms' }).notNull(),
    effectiveTo: integer('effective_to', { mode: 'timestamp_ms' }),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    index('application_fees_method_idx').on(t.method),
    index('application_fees_effective_idx').on(t.effectiveFrom),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 6. ACCOUNTS PAYABLE
 * ════════════════════════════════════════════════════════════════════════════ */

export const vendorBills = sqliteTable(
  'vendor_bills',
  {
    id: primaryId(),
    vendorId: text('vendor_id')
      .notNull()
      .references(() => vendors.id, { onDelete: 'restrict' }),
    billNumber: text('bill_number').notNull(),
    poReference: text('po_reference'),
    billDate: integer('bill_date', { mode: 'timestamp_ms' }).notNull(),
    dueDate: integer('due_date', { mode: 'timestamp_ms' }),
    termsDays: integer('terms_days'),
    subtotalCents: integer('subtotal_cents').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    balanceCents: integer('balance_cents').notNull().default(0),
    status: text('status', { enum: VENDOR_BILL_STATUSES }).notNull().default('open'),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('vendor_bills_vendor_number_unique').on(t.vendorId, t.billNumber),
    index('vendor_bills_status_idx').on(t.status),
    index('vendor_bills_due_idx').on(t.dueDate),
  ],
);

export const vendorBillItems = sqliteTable(
  'vendor_bill_items',
  {
    id: primaryId(),
    vendorBillId: text('vendor_bill_id')
      .notNull()
      .references(() => vendorBills.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    itemCode: text('item_code'),
    description: text('description').notNull(),
    quantity: real('quantity'),
    unit: text('unit', { enum: UNITS }),
    unitCostCents: integer('unit_cost_cents'),
    amountCents: integer('amount_cents'),
    epaNumber: text('epa_number'),
    lotNumber: text('lot_number'),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('vendor_bill_items_bill_idx').on(t.vendorBillId),
    index('vendor_bill_items_product_idx').on(t.productId),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 7. INVOICING / ACCOUNTS RECEIVABLE
 * ════════════════════════════════════════════════════════════════════════════ */

export const invoices = sqliteTable(
  'invoices',
  {
    id: primaryId(),
    invoiceNumber: text('invoice_number').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    status: text('status', { enum: INVOICE_STATUSES }).notNull().default('draft'),

    pricingTierId: text('pricing_tier_id').references(() => priceTiers.id, { onDelete: 'set null' }),
    pricingTierKey: text('pricing_tier_key', { enum: PRICE_TIER_KEYS }),

    issueDate: integer('issue_date', { mode: 'timestamp_ms' }).notNull(),
    dueDate: integer('due_date', { mode: 'timestamp_ms' }),
    termsDays: integer('terms_days'),
    poNumber: text('po_number'),

    /**
     * Denormalized party snapshot. Invoices are legal documents: later edits to
     * a customer record must never rewrite a historical invoice.
     */
    customerName: text('customer_name').notNull(),
    billLine1: text('bill_line1'),
    billLine2: text('bill_line2'),
    billCity: text('bill_city'),
    billState: text('bill_state'),
    billPostalCode: text('bill_postal_code'),
    shipLine1: text('ship_line1'),
    shipLine2: text('ship_line2'),
    shipCity: text('ship_city'),
    shipState: text('ship_state'),
    shipPostalCode: text('ship_postal_code'),

    serviceAcres: real('service_acres'),
    applicationMethod: text('application_method', { enum: APPLICATION_METHODS }),

    subtotalCents: integer('subtotal_cents').notNull().default(0),
    discountCents: integer('discount_cents').notNull().default(0),
    taxRate: real('tax_rate').notNull().default(0),
    taxCents: integer('tax_cents').notNull().default(0),
    totalCents: integer('total_cents').notNull().default(0),
    amountPaidCents: integer('amount_paid_cents').notNull().default(0),
    balanceCents: integer('balance_cents').notNull().default(0),

    /**
     * Set when every regulated seed line on the invoice has verified BOL/CMR +
     * Order Number tokens. Invoice submission is blocked while this is null.
     */
    complianceVerifiedAt: integer('compliance_verified_at', { mode: 'timestamp_ms' }),
    complianceVerifiedByUserId: text('compliance_verified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),

    notes: text('notes'),
    internalNotes: text('internal_notes'),

    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    paidAt: integer('paid_at', { mode: 'timestamp_ms' }),
    canceledAt: integer('canceled_at', { mode: 'timestamp_ms' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invoices_number_unique').on(t.invoiceNumber),
    index('invoices_customer_idx').on(t.customerId),
    index('invoices_status_idx').on(t.status),
    index('invoices_issue_date_idx').on(t.issueDate),
  ],
);

export const invoiceItems = sqliteTable(
  'invoice_items',
  {
    id: primaryId(),
    invoiceId: text('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    lineType: text('line_type', { enum: INVOICE_LINE_TYPES }).notNull(),

    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    programId: text('program_id').references(() => applicationPrograms.id, {
      onDelete: 'set null',
    }),
    applicationFeeId: text('application_fee_id').references(() => applicationFees.id, {
      onDelete: 'set null',
    }),
    applicationMethod: text('application_method', { enum: APPLICATION_METHODS }),

    description: text('description').notNull(),
    quantity: real('quantity').notNull().default(1),
    unit: text('unit'),
    /** Populated for per-acre program lines. */
    acres: real('acres'),

    unitPriceCents: integer('unit_price_cents').notNull(),
    unitCostCents: integer('unit_cost_cents'),
    /** Retained so a historical line explains its own margin. */
    marginPercent: real('margin_percent'),

    lineSubtotalCents: integer('line_subtotal_cents').notNull(),
    discountCents: integer('discount_cents').notNull().default(0),
    taxable: integer('taxable', { mode: 'boolean' }).notNull().default(true),

    lotNumber: text('lot_number'),
    /** Regulated seed lines point at the audit token row that clears them. */
    complianceLogId: text('compliance_log_id').references(() => iowaComplianceLogs.id, {
      onDelete: 'set null',
    }),

    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    index('invoice_items_invoice_idx').on(t.invoiceId),
    index('invoice_items_product_idx').on(t.productId),
    index('invoice_items_program_idx').on(t.programId),
  ],
);

/** Serialized invoice numbering. Increment atomically with `UPDATE ... RETURNING`. */
export const invoiceSequences = sqliteTable(
  'invoice_sequences',
  {
    id: primaryId(),
    scope: text('scope').notNull(),
    prefix: text('prefix').notNull().default('INV'),
    nextNumber: integer('next_number').notNull().default(1001),
    ...timestamps(),
  },
  (t) => [uniqueIndex('invoice_sequences_scope_unique').on(t.scope)],
);

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
    status: text('status').notNull().default('pending'),
    error: text('error'),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }),
    ...timestamps(),
  },
  (t) => [
    index('invoice_deliveries_invoice_idx').on(t.invoiceId),
    index('invoice_deliveries_status_idx').on(t.status),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 8. IOWA SEED COMPLIANCE
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * Regulatory audit tokens. The two tokens the State of Iowa requires from a
 * Channel straight BOL are `bolCmrNumber` and `orderNumber`; `seedNumber`,
 * `shipperNumber` and `poNumber` are captured because they appear on the same
 * document and are needed to reconcile a line to its shipment.
 *
 * The unique index tolerates NULLs (SQLite treats NULLs as distinct), so a
 * partially-populated draft can exist while an operator completes it.
 */
export const iowaComplianceLogs = sqliteTable(
  'iowa_compliance_logs',
  {
    id: primaryId(),
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'set null' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),

    /** Channel BOL header: "BOL/CMR Number". */
    bolCmrNumber: text('bol_cmr_number'),
    /** Channel BOL header: "Order Number". */
    orderNumber: text('order_number'),
    /** Channel BOL "Seed NO." */
    seedNumber: text('seed_number'),
    /** Channel BOL "Shipper's No." */
    shipperNumber: text('shipper_number'),
    poNumber: text('po_number'),
    lotNumber: text('lot_number'),

    quantity: real('quantity'),
    unit: text('unit', { enum: UNITS }),
    purchaseDate: integer('purchase_date', { mode: 'timestamp_ms' }),

    source: text('source', { enum: COMPLIANCE_SOURCES }).notNull().default('manual'),
    documentId: text('document_id').references(() => documents.id, { onDelete: 'set null' }),

    verified: integer('verified', { mode: 'boolean' }).notNull().default(false),
    verifiedByUserId: text('verified_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    verifiedAt: integer('verified_at', { mode: 'timestamp_ms' }),
    notes: text('notes'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('iowa_compliance_tokens_unique').on(t.bolCmrNumber, t.orderNumber, t.lotNumber),
    index('iowa_compliance_customer_idx').on(t.customerId),
    index('iowa_compliance_product_idx').on(t.productId),
    index('iowa_compliance_verified_idx').on(t.verified),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 9. BANKING & CHECKWRITING (ADMIN ONLY)
 * ════════════════════════════════════════════════════════════════════════════ */

export const bankAccounts = sqliteTable(
  'bank_accounts',
  {
    id: primaryId(),
    name: text('name').notNull(),
    bankName: text('bank_name'),
    routingNumber: text('routing_number'),
    /**
     * Full account number, needed to compose a MICR line.
     *
     * Sensitive: it is never returned by list endpoints, only by the single
     * account lookup the cheque print view uses (Admin-only router).
     */
    accountNumber: text('account_number'),
    accountNumberLast4: text('account_number_last4'),
    /** Monotonic counter. Advanced atomically inside the same batch as insert. */
    nextCheckNumber: integer('next_check_number').notNull().default(1001),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    ...timestamps(),
  },
  (t) => [uniqueIndex('bank_accounts_name_unique').on(t.name)],
);

/**
 * Issued checks. `unique(bankAccountId, checkNumber)` is the structural guard
 * against duplicate check numbers — combined with D1's single-primary write
 * serialization, an atomic `UPDATE ... RETURNING` on `bankAccounts.nextCheckNumber`
 * cannot hand out the same number twice.
 */
export const checks = sqliteTable(
  'checks',
  {
    id: primaryId(),
    bankAccountId: text('bank_account_id')
      .notNull()
      .references(() => bankAccounts.id, { onDelete: 'restrict' }),
    checkNumber: integer('check_number').notNull(),
    payeeVendorId: text('payee_vendor_id').references(() => vendors.id, { onDelete: 'set null' }),
    payeeName: text('payee_name').notNull(),
    amountCents: integer('amount_cents').notNull(),
    memo: text('memo'),
    paymentDate: integer('payment_date', { mode: 'timestamp_ms' }).notNull(),
    status: text('status', { enum: CHECK_STATUSES }).notNull().default('draft'),
    /** Serialized instructions, e.g. "INV 103935 / INV 500059753". */
    paymentDescriptor: text('payment_descriptor'),
    printedAt: integer('printed_at', { mode: 'timestamp_ms' }),
    voidedAt: integer('voided_at', { mode: 'timestamp_ms' }),
    voidReason: text('void_reason'),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('checks_account_number_unique').on(t.bankAccountId, t.checkNumber),
    index('checks_payee_idx').on(t.payeeVendorId),
    index('checks_status_idx').on(t.status),
    index('checks_payment_date_idx').on(t.paymentDate),
  ],
);

/** Dollar allocations of one check across vendor bills. */
export const checkAllocations = sqliteTable(
  'check_allocations',
  {
    id: primaryId(),
    checkId: text('check_id')
      .notNull()
      .references(() => checks.id, { onDelete: 'cascade' }),
    vendorBillId: text('vendor_bill_id').references(() => vendorBills.id, { onDelete: 'set null' }),
    amountCents: integer('amount_cents').notNull(),
    note: text('note'),
    ...timestamps(),
  },
  (t) => [
    index('check_allocations_check_idx').on(t.checkId),
    index('check_allocations_bill_idx').on(t.vendorBillId),
  ],
);

/* ════════════════════════════════════════════════════════════════════════════
 * 10. RELATIONS (for `db.query.*`)
 * ════════════════════════════════════════════════════════════════════════════ */

export const usersRelations = relations(users, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const customersRelations = relations(customers, ({ many }) => ({
  invoices: many(invoices),
  complianceLogs: many(iowaComplianceLogs),
  documents: many(documents),
}));

export const vendorsRelations = relations(vendors, ({ many }) => ({
  bills: many(vendorBills),
  documents: many(documents),
  checks: many(checks),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  vendor: one(vendors, { fields: [documents.vendorId], references: [vendors.id] }),
  customer: one(customers, { fields: [documents.customerId], references: [customers.id] }),
  importBatches: many(importBatches),
}));

export const productsRelations = relations(products, ({ many }) => ({
  costs: many(productCosts),
  lots: many(inventoryLots),
  droneUnits: many(droneUnits),
  programIngredients: many(programIngredients),
}));

export const inventoryLotsRelations = relations(inventoryLots, ({ one }) => ({
  product: one(products, { fields: [inventoryLots.productId], references: [products.id] }),
  warehouse: one(warehouses, { fields: [inventoryLots.warehouseId], references: [warehouses.id] }),
}));

export const priceTiersRelations = relations(priceTiers, ({ many }) => ({
  programPrices: many(programPrices),
  invoices: many(invoices),
}));

export const applicationProgramsRelations = relations(applicationPrograms, ({ many }) => ({
  ingredients: many(programIngredients),
  prices: many(programPrices),
  invoiceItems: many(invoiceItems),
}));

export const programIngredientsRelations = relations(programIngredients, ({ one }) => ({
  program: one(applicationPrograms, {
    fields: [programIngredients.programId],
    references: [applicationPrograms.id],
  }),
  product: one(products, {
    fields: [programIngredients.productId],
    references: [products.id],
  }),
}));

export const programPricesRelations = relations(programPrices, ({ one }) => ({
  program: one(applicationPrograms, {
    fields: [programPrices.programId],
    references: [applicationPrograms.id],
  }),
  tier: one(priceTiers, { fields: [programPrices.tierId], references: [priceTiers.id] }),
}));

export const vendorBillsRelations = relations(vendorBills, ({ one, many }) => ({
  vendor: one(vendors, { fields: [vendorBills.vendorId], references: [vendors.id] }),
  items: many(vendorBillItems),
  allocations: many(checkAllocations),
}));

export const vendorBillItemsRelations = relations(vendorBillItems, ({ one }) => ({
  bill: one(vendorBills, {
    fields: [vendorBillItems.vendorBillId],
    references: [vendorBills.id],
  }),
  product: one(products, { fields: [vendorBillItems.productId], references: [products.id] }),
}));

export const invoicesRelations = relations(invoices, ({ one, many }) => ({
  customer: one(customers, { fields: [invoices.customerId], references: [customers.id] }),
  tier: one(priceTiers, { fields: [invoices.pricingTierId], references: [priceTiers.id] }),
  createdBy: one(users, { fields: [invoices.createdByUserId], references: [users.id] }),
  items: many(invoiceItems),
  deliveries: many(invoiceDeliveries),
}));

export const invoiceItemsRelations = relations(invoiceItems, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceItems.invoiceId], references: [invoices.id] }),
  product: one(products, { fields: [invoiceItems.productId], references: [products.id] }),
  program: one(applicationPrograms, {
    fields: [invoiceItems.programId],
    references: [applicationPrograms.id],
  }),
  applicationFee: one(applicationFees, {
    fields: [invoiceItems.applicationFeeId],
    references: [applicationFees.id],
  }),
  complianceLog: one(iowaComplianceLogs, {
    fields: [invoiceItems.complianceLogId],
    references: [iowaComplianceLogs.id],
  }),
}));

export const invoiceDeliveriesRelations = relations(invoiceDeliveries, ({ one }) => ({
  invoice: one(invoices, { fields: [invoiceDeliveries.invoiceId], references: [invoices.id] }),
}));

export const iowaComplianceLogsRelations = relations(iowaComplianceLogs, ({ one, many }) => ({
  customer: one(customers, {
    fields: [iowaComplianceLogs.customerId],
    references: [customers.id],
  }),
  product: one(products, { fields: [iowaComplianceLogs.productId], references: [products.id] }),
  document: one(documents, {
    fields: [iowaComplianceLogs.documentId],
    references: [documents.id],
  }),
  invoiceItems: many(invoiceItems),
}));

export const bankAccountsRelations = relations(bankAccounts, ({ many }) => ({
  checks: many(checks),
}));

export const checksRelations = relations(checks, ({ one, many }) => ({
  bankAccount: one(bankAccounts, {
    fields: [checks.bankAccountId],
    references: [bankAccounts.id],
  }),
  payeeVendor: one(vendors, { fields: [checks.payeeVendorId], references: [vendors.id] }),
  allocations: many(checkAllocations),
}));

export const checkAllocationsRelations = relations(checkAllocations, ({ one }) => ({
  check: one(checks, { fields: [checkAllocations.checkId], references: [checks.id] }),
  vendorBill: one(vendorBills, {
    fields: [checkAllocations.vendorBillId],
    references: [vendorBills.id],
  }),
}));

export const importBatchesRelations = relations(importBatches, ({ one, many }) => ({
  vendor: one(vendors, { fields: [importBatches.vendorId], references: [vendors.id] }),
  document: one(documents, { fields: [importBatches.documentId], references: [documents.id] }),
  drafts: many(importDrafts),
}));

export const importDraftsRelations = relations(importDrafts, ({ one }) => ({
  batch: one(importBatches, {
    fields: [importDrafts.batchId],
    references: [importBatches.id],
  }),
}));

/* ════════════════════════════════════════════════════════════════════════════
 * 11. INFERRED TYPES
 * ════════════════════════════════════════════════════════════════════════════ */

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type CompanySettings = typeof companySettings.$inferSelect;

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

export type Vendor = typeof vendors.$inferSelect;
export type Document = typeof documents.$inferSelect;
export type ImportBatch = typeof importBatches.$inferSelect;
export type ImportDraft = typeof importDrafts.$inferSelect;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;
export type UnitRow = typeof units.$inferSelect;
export type ProductCost = typeof productCosts.$inferSelect;
export type Warehouse = typeof warehouses.$inferSelect;
export type InventoryLot = typeof inventoryLots.$inferSelect;
export type InventoryMovement = typeof inventoryMovements.$inferSelect;
export type NewInventoryMovement = typeof inventoryMovements.$inferInsert;
export type DroneUnit = typeof droneUnits.$inferSelect;

export type PriceTier = typeof priceTiers.$inferSelect;
export type ApplicationProgram = typeof applicationPrograms.$inferSelect;
export type ProgramIngredient = typeof programIngredients.$inferSelect;
export type ProgramPrice = typeof programPrices.$inferSelect;
export type ApplicationFee = typeof applicationFees.$inferSelect;

export type VendorBill = typeof vendorBills.$inferSelect;
export type VendorBillItem = typeof vendorBillItems.$inferSelect;

export type Invoice = typeof invoices.$inferSelect;
export type NewInvoice = typeof invoices.$inferInsert;
export type InvoiceItem = typeof invoiceItems.$inferSelect;
export type NewInvoiceItem = typeof invoiceItems.$inferInsert;
export type InvoiceSequence = typeof invoiceSequences.$inferSelect;
export type InvoiceDelivery = typeof invoiceDeliveries.$inferSelect;

export type IowaComplianceLog = typeof iowaComplianceLogs.$inferSelect;
export type NewIowaComplianceLog = typeof iowaComplianceLogs.$inferInsert;

export type BankAccount = typeof bankAccounts.$inferSelect;
export type Check = typeof checks.$inferSelect;
export type NewCheck = typeof checks.$inferInsert;
export type CheckAllocation = typeof checkAllocations.$inferSelect;
