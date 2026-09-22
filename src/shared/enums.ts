/**
 * Canonical domain enums — the single source of truth for Drizzle column enums,
 * Zod validators, and UI option lists, so adding a value here propagates
 * everywhere with type safety.
 *
 * v2 keeps only what the business uses today. The first build grew a long tail
 * of enums (import review states, check statuses, drone lifecycle, unit
 * dimensions) for modules that were never reached; they return with their module.
 *
 * US spelling throughout: catalog, license, check.
 */

/* ── Auth & access ─────────────────────────────────────────────────────────── */

/** Three roles for a handful of people. Deny-by-default; see rbac.ts. */
export const USER_ROLES = ['staff', 'manager', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/* ── Catalog & stock ───────────────────────────────────────────────────────── */

/** Catalog divisions. `drone` is reserved for the future sales/repair line. */
export const PRODUCT_TYPES = ['chemical', 'seed', 'drone', 'other'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/**
 * The vocabulary of measure. A product is stocked and billed in exactly one of
 * these, and a program's ingredient rate is expressed in the ingredient product's
 * own unit — so there is no conversion table and no dimension math.
 */
export const UNITS = [
  'acre',
  'mile',
  'hour',
  'gal',
  'qt',
  'pt',
  'oz',
  'lb',
  'ton',
  'bag',
  'jug',
  'bottle',
  'each',
] as const;
export type Unit = (typeof UNITS)[number];

/** Crop families a program is applied to. */
export const CROP_TYPES = ['corn', 'soybean', 'other'] as const;
export type CropType = (typeof CROP_TYPES)[number];

/**
 * Kinds of stock movement. The ledger is append-only, so a correction is a new
 * movement rather than an edit: `reversal` undoes a sale, `adjustment` covers a
 * physical count difference.
 */
export const STOCK_MOVEMENT_TYPES = ['receipt', 'sale', 'adjustment', 'reversal'] as const;
export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

/** What caused a movement, so it can be traced back to a document. */
export const MOVEMENT_REFERENCE_TYPES = ['invoice', 'manual', 'import'] as const;
export type MovementReferenceType = (typeof MOVEMENT_REFERENCE_TYPES)[number];

/* ── Pricing engine ────────────────────────────────────────────────────────── */

/** The four margin tiers, verified against both source price sheets. */
export const PRICE_TIER_KEYS = [
  'financed_app',
  'cash_app',
  'cash_carry',
  'finance_carry',
] as const;
export type PriceTierKey = (typeof PRICE_TIER_KEYS)[number];

/** Tiers where the company performs the application. */
export const APPLICATION_TIER_KEYS: readonly PriceTierKey[] = ['financed_app', 'cash_app'];

/** Tiers where the customer takes the product; these require a license on file. */
export const CARRY_TIER_KEYS: readonly PriceTierKey[] = ['cash_carry', 'finance_carry'];

/** How an application is delivered. */
export const APPLICATION_METHODS = ['drone', 'ground', 'none'] as const;
export type ApplicationMethod = (typeof APPLICATION_METHODS)[number];

/** Kinds of charge that are neither a product nor a program: application, mileage. */
export const SERVICE_RATE_KINDS = ['application', 'mileage', 'other'] as const;
export type ServiceRateKind = (typeof SERVICE_RATE_KINDS)[number];

/** Units a service rate is billed in. */
export const SERVICE_RATE_UNITS = ['acre', 'mile', 'hour', 'each'] as const;
export type ServiceRateUnit = (typeof SERVICE_RATE_UNITS)[number];

/* ── Invoicing / AR ────────────────────────────────────────────────────────── */

/**
 * `issued` replaced the old `sent`, and `void` replaced `canceled`. There is no
 * state after `issued` that permits editing lines: an issued invoice is a legal
 * document, corrected by voiding it and issuing a new one.
 */
export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** Invoice line kinds. Each drives one pricing path; see services/pricing.ts. */
export const INVOICE_LINE_TYPES = ['program', 'product', 'service'] as const;
export type InvoiceLineType = (typeof INVOICE_LINE_TYPES)[number];

export const PAYMENT_METHODS = ['check', 'cash', 'card', 'ach', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** How an invoice left the building. */
export const DELIVERY_METHODS = ['email', 'print', 'download'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** Outcomes of a delivery attempt. `skipped` means no provider is configured. */
export const DELIVERY_STATUSES = ['sent', 'skipped', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/* ── Compliance & documents ────────────────────────────────────────────────── */

/** What a stored file is, so the right filter finds it. */
export const DOCUMENT_KINDS = ['bol', 'price_sheet', 'other'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];
