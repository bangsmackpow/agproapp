/**
 * Canonical domain enums.
 *
 * These are the single source of truth: Drizzle column `enum` constraints, Zod
 * validators (Phase 2) and UI option lists (Phase 3) all derive from these
 * tuples, so adding a value here propagates everywhere with type safety.
 */

/* ── Auth & access ─────────────────────────────────────────────────────────── */

export const USER_ROLES = ['sales', 'manager', 'admin'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/* ── Inventory / catalogue ─────────────────────────────────────────────────── */

/** Inventory divisions. */
export const PRODUCT_TYPES = ['chemical', 'seed', 'drone', 'misc'] as const;
export type ProductType = (typeof PRODUCT_TYPES)[number];

/** Units of measure seen across the price sheets and vendor invoices. */
export const UNITS = [
  'acre',
  'gal',
  'qt',
  'pt',
  'oz',
  'lb',
  'bag',
  'bottle',
  'each',
  'package',
  'ton',
] as const;
export type Unit = (typeof UNITS)[number];

/** Crop families used by the program/price-sheet hierarchy. */
export const CROP_TYPES = ['corn', 'bean', 'other'] as const;
export type CropType = (typeof CROP_TYPES)[number];

/** Timing bucket within a crop cycle ("CORN (1 PASS)", "BEAN PRE", ...). */
export const PROGRAM_STAGES = ['single', 'pre', 'post', 'fungicide', 'other'] as const;
export type ProgramStage = (typeof PROGRAM_STAGES)[number];

/** Lifecycle of a serialized drone unit. */
export const DRONE_UNIT_STATUSES = [
  'in_stock',
  'sold',
  'deployed',
  'in_service',
  'retired',
] as const;
export type DroneUnitStatus = (typeof DRONE_UNIT_STATUSES)[number];

/* ── Pricing engine ────────────────────────────────────────────────────────── */

/**
 * The four margin tiers actually present on both worksheets.
 * The original spec named three; the source price sheets price four.
 */
export const PRICE_TIER_KEYS = [
  'financed_app',
  'cash_app',
  'cash_carry',
  'finance_carry',
] as const;
export type PriceTierKey = (typeof PRICE_TIER_KEYS)[number];

/** Tiers that imply the company performs the application (drone/ground). */
export const APPLICATION_TIER_KEYS: readonly PriceTierKey[] = ['financed_app', 'cash_app'];

/** Tiers where the customer takes the product (no application service). */
export const CARRY_TIER_KEYS: readonly PriceTierKey[] = ['cash_carry', 'finance_carry'];

/** Application service methods billed alongside product. */
export const APPLICATION_METHODS = ['drone', 'ground', 'helicopter', 'none'] as const;
export type ApplicationMethod = (typeof APPLICATION_METHODS)[number];

/* ── Invoicing / AR ────────────────────────────────────────────────────────── */

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'canceled'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/** How an invoice left the building. */
export const DELIVERY_METHODS = ['email', 'print', 'download', 'sms'] as const;
export type DeliveryMethod = (typeof DELIVERY_METHODS)[number];

/** Invoice line kinds. Drives which FK/pricing path a line uses. */
export const INVOICE_LINE_TYPES = [
  'program',
  'product',
  'application_fee',
  'package',
  'misc',
] as const;
export type InvoiceLineType = (typeof INVOICE_LINE_TYPES)[number];

/* ── Accounts payable / checkwriting ───────────────────────────────────────── */

export const VENDOR_BILL_STATUSES = ['open', 'partial', 'paid', 'void'] as const;
export type VendorBillStatus = (typeof VENDOR_BILL_STATUSES)[number];

export const CHECK_STATUSES = ['draft', 'printed', 'voided', 'cleared', 'reissued'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const PAYMENT_METHODS = ['check', 'ach', 'wire', 'cash', 'card'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/* ── Documents & ingestion review queue ────────────────────────────────────── */

export const DOCUMENT_TYPES = [
  'bol_seed',
  'vendor_invoice',
  'customer_invoice',
  'price_sheet',
  'inventory_sheet',
  'other',
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const IMPORT_BATCH_STATUSES = [
  'draft',
  'in_review',
  'committed',
  'rejected',
] as const;
export type ImportBatchStatus = (typeof IMPORT_BATCH_STATUSES)[number];

export const IMPORT_DRAFT_STATUSES = [
  'pending',
  'accepted',
  'edited',
  'rejected',
] as const;
export type ImportDraftStatus = (typeof IMPORT_DRAFT_STATUSES)[number];

/**
 * Which table a staged import row will be committed into. The review queue is
 * polymorphic, so the target is stored rather than modelled as N nullable FKs.
 */
export const IMPORT_TARGETS = [
  'product',
  'inventory_lot',
  'program',
  'program_ingredient',
  'program_price',
  'vendor_bill',
  'vendor_bill_item',
  'customer',
  'iowa_compliance_log',
] as const;
export type ImportTarget = (typeof IMPORT_TARGETS)[number];

/** Where a compliance record's tokens came from. */
export const COMPLIANCE_SOURCES = [
  'manual',
  'bol_import',
  'vendor_invoice',
  'customer_invoice',
] as const;
export type ComplianceSource = (typeof COMPLIANCE_SOURCES)[number];

/* ── Known vendor slugs (drives the parser registry in Phase 2) ────────────── */

export const VENDOR_CODE_PRODUCT_SUPPLY = 'product_supply_seeds';
export const VENDOR_CODE_ATTICUS = 'atticus';
export const VENDOR_CODE_IB_AG = 'ib_ag_supply';
export const VENDOR_CODE_WICKMAN = 'wickman_chemical';
