import { z } from 'zod';

import {
  APPLICATION_METHODS,
  CHECK_STATUSES,
  DOCUMENT_TYPES,
  DRONE_UNIT_STATUSES,
  IMPORT_TARGETS,
  INVOICE_LINE_TYPES,
  INVOICE_STATUSES,
  PRICE_TIER_KEYS,
  PRODUCT_TYPES,
  UNITS,
  USER_ROLES,
  VENDOR_BILL_STATUSES,
} from '../shared/enums';
import { MIN_PASSWORD_LENGTH } from './lib/constants';

/**
 * All request validation lives here.
 *
 * `oneOf` is used instead of `z.enum` for domain enums so the canonical tuples in
 * `src/shared/enums.ts` stay the single source of truth without a cast.
 */
const oneOf = <T extends string>(values: readonly T[]) =>
  z.custom<T>((value) => typeof value === 'string' && (values as readonly string[]).includes(value), {
    message: `Expected one of: ${values.join(', ')}`,
  });

const id = () => z.string().trim().min(1);
const optionalText = (max: number) => z.string().trim().max(max).optional();
const cents = () => z.number().int().min(0);
const email = () => z.string().trim().toLowerCase().email().max(200);

/**
 * Query-string booleans.
 *
 * `z.coerce.boolean()` is unusable here: it is `Boolean(value)` semantics, so the
 * string "false" coerces to `true`. This parses the literal words instead.
 */
const booleanQuery = (defaultValue = false) =>
  z.preprocess(
    (value) => (value === undefined ? defaultValue : value),
    z.union([z.boolean(), z.string()]).transform((value) =>
      typeof value === 'boolean' ? value : ['true', '1', 'yes', 'on'].includes(value.toLowerCase()),
    ),
  );

/* ── Auth ──────────────────────────────────────────────────────────────────── */

export const loginSchema = z.object({
  email: email(),
  password: z.string().min(1).max(512),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(512),
});

export const createUserSchema = z.object({
  email: email(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(512),
  name: z.string().trim().min(1).max(120),
  role: oneOf(USER_ROLES),
  phone: optionalText(30),
});

export const updateUserSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: oneOf(USER_ROLES).optional(),
  phone: optionalText(30),
  isActive: z.boolean().optional(),
});

/* ── CRM ───────────────────────────────────────────────────────────────────── */

const addressShape = {
  line1: optionalText(120),
  line2: optionalText(120),
  city: optionalText(80),
  state: optionalText(2),
  postalCode: optionalText(12),
};

export const customerCreateSchema = z.object({
  accountNumber: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(200),
  contactName: optionalText(120),
  phone: optionalText(30),
  email: email().optional(),

  billLine1: addressShape.line1,
  billLine2: addressShape.line2,
  billCity: addressShape.city,
  billState: addressShape.state,
  billPostalCode: addressShape.postalCode,

  shipLine1: addressShape.line1,
  shipLine2: addressShape.line2,
  shipCity: addressShape.city,
  shipState: addressShape.state,
  shipPostalCode: addressShape.postalCode,

  /** Required at time of sale for carry tiers — see `requiresPesticideLicense`. */
  pesticideLicenseNumber: optionalText(60),
  pesticideLicenseExpiresAt: z.coerce.date().optional(),
  resaleCertificateNumber: optionalText(60),

  taxExempt: z.boolean().optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
  creditLimitCents: cents().optional(),
  notes: optionalText(2000),
});

export const customerUpdateSchema = customerCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const listQuerySchema = z.object({
  q: optionalText(200),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  includeInactive: booleanQuery(false),
});

/* ── Catalogue ─────────────────────────────────────────────────────────────── */

export const productCreateSchema = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  type: oneOf(PRODUCT_TYPES),
  brand: optionalText(80),
  manufacturer: optionalText(80),
  unit: oneOf(UNITS).optional(),
  packageSize: optionalText(60),
  category: optionalText(80),

  epaNumber: optionalText(40),
  pesticideType: optionalText(60),
  activeIngredient: optionalText(200),
  density: z.number().positive().optional(),
  stateRestrictions: z.array(z.string().trim().length(2)).optional(),

  isRegulatedSeed: z.boolean().optional(),
  seedTraitSystem: optionalText(60),
  isSerialized: z.boolean().optional(),

  financedAppPriceCents: cents().optional(),
  cashAppPriceCents: cents().optional(),
  carryPriceCents: cents().optional(),

  defaultCostCents: cents().optional(),
  taxable: z.boolean().optional(),
  notes: optionalText(2000),
});

export const productUpdateSchema = productCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
});

export const productListQuerySchema = listQuerySchema.extend({
  type: oneOf(PRODUCT_TYPES).optional(),
});

export const inventoryLotListQuerySchema = listQuerySchema.extend({
  productId: id().optional(),
  warehouseId: id().optional(),
});

export const droneUnitListQuerySchema = listQuerySchema.extend({
  productId: id().optional(),
  status: oneOf(DRONE_UNIT_STATUSES).optional(),
});

/* ── Inventory ─────────────────────────────────────────────────────────────── */

export const inventoryLotCreateSchema = z.object({
  productId: id(),
  warehouseId: id().optional(),
  lotNumber: optionalText(80),
  seedNumber: optionalText(60),
  expirationDate: z.coerce.date().optional(),
  quantityOnHand: z.number().min(0).optional(),
  unitCostCents: cents().optional(),
  receivedAt: z.coerce.date().optional(),
  sourceVendorId: id().optional(),
  notes: optionalText(1000),
});

/** Relative adjustment, so concurrent stock movements do not clobber each other. */
export const inventoryAdjustSchema = z.object({
  delta: z.number(),
  reason: optionalText(200),
});

export const droneUnitCreateSchema = z.object({
  productId: id(),
  serialNumber: z.string().trim().min(1).max(80),
  status: oneOf(DRONE_UNIT_STATUSES).optional(),
  costCents: cents().optional(),
  warrantyExpiresAt: z.coerce.date().optional(),
  lotId: id().optional(),
  notes: optionalText(1000),
});

/* ── Vendors & accounts payable ────────────────────────────────────────────── */

export const vendorBillCreateSchema = z.object({
  vendorId: id(),
  billNumber: z.string().trim().min(1).max(60),
  poReference: optionalText(60),
  billDate: z.coerce.date(),
  dueDate: z.coerce.date().optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  subtotalCents: cents().optional(),
  taxCents: cents().optional(),
  totalCents: cents().optional(),
  status: oneOf(VENDOR_BILL_STATUSES).optional(),
  notes: optionalText(2000),
});

/* ── Invoicing ─────────────────────────────────────────────────────────────── */

/**
 * A line may arrive pre-priced (carry/misc items) or unpriced (program and
 * application-fee lines, whose price the server resolves from the pricing
 * tables). A client-supplied price is treated as an explicit override.
 */
export const invoiceItemInputSchema = z
  .object({
    lineType: oneOf(INVOICE_LINE_TYPES),
    productId: id().optional(),
    programId: id().optional(),
    applicationFeeId: id().optional(),
    applicationMethod: oneOf(APPLICATION_METHODS).optional(),
    description: z.string().trim().min(1).max(300),
    quantity: z.number().positive().default(1),
    unit: oneOf(UNITS).optional(),
    acres: z.number().positive().optional(),
    unitPriceCents: cents().optional(),
    unitCostCents: cents().optional(),
    lotNumber: optionalText(80),
    complianceLogId: id().optional(),
    taxable: z.boolean().optional(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine((line) => (line.lineType === 'program' ? Boolean(line.programId) : true), {
    message: 'programId is required for program lines',
    path: ['programId'],
  })
  .refine((line) => (line.lineType === 'application_fee' ? Boolean(line.applicationFeeId) : true), {
    message: 'applicationFeeId is required for application_fee lines',
    path: ['applicationFeeId'],
  })
  .refine(
    (line) =>
      line.lineType === 'program' ? Boolean(line.acres ?? line.quantity) : true,
    { message: 'acres is required for program lines', path: ['acres'] },
  );

export const invoiceCreateSchema = z.object({
  customerId: id(),
  pricingTierKey: oneOf(PRICE_TIER_KEYS),
  issueDate: z.coerce.date().optional(),
  dueDate: z.coerce.date().optional(),
  termsDays: z.number().int().min(0).max(365).optional(),
  poNumber: optionalText(60),
  serviceAcres: z.number().positive().optional(),
  applicationMethod: oneOf(APPLICATION_METHODS).optional(),
  discountCents: cents().optional(),
  notes: optionalText(2000),
  internalNotes: optionalText(2000),
  items: z.array(invoiceItemInputSchema).min(1).max(200),
});

export const invoiceUpdateSchema = invoiceCreateSchema.partial().extend({
  status: oneOf(INVOICE_STATUSES).optional(),
});

export const invoiceStatusSchema = z.object({
  status: oneOf(INVOICE_STATUSES),
  reason: optionalText(500),
});

export const invoiceListQuerySchema = listQuerySchema.extend({
  customerId: id().optional(),
  status: oneOf(INVOICE_STATUSES).optional(),
});

export const invoiceRecordPaymentSchema = z.object({
  amountCents: z.number().int().positive(),
});

/* ── Checkwriting ──────────────────────────────────────────────────────────── */

export const checkCreateSchema = z.object({
  bankAccountId: id(),
  payeeVendorId: id().optional(),
  payeeName: z.string().trim().min(1).max(200),
  amountCents: z.number().int().positive(),
  memo: optionalText(120),
  paymentDate: z.coerce.date().optional(),
  paymentDescriptor: optionalText(200),
  allocations: z
    .array(
      z.object({
        vendorBillId: id(),
        amountCents: z.number().int().positive(),
      }),
    )
    .optional(),
});

export const checkStatusSchema = z.object({
  status: oneOf(CHECK_STATUSES),
  reason: optionalText(500),
});

export const checkListQuerySchema = listQuerySchema.extend({
  bankAccountId: id().optional(),
  payeeVendorId: id().optional(),
  status: oneOf(CHECK_STATUSES).optional(),
});

export const bankAccountCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  bankName: optionalText(120),
  routingNumber: z.string().trim().regex(/^\d{9}$/, 'Routing number must be 9 digits').optional(),
  accountNumberLast4: z.string().trim().regex(/^\d{4}$/, 'Expected the last 4 digits').optional(),
  nextCheckNumber: z.number().int().min(1).optional(),
  isDefault: z.boolean().optional(),
});

/* ── Ingestion ─────────────────────────────────────────────────────────────── */

export const importBatchCreateSchema = z.object({
  label: z.string().trim().min(1).max(200),
  vendorId: id().optional(),
  docType: oneOf(DOCUMENT_TYPES).optional(),
  /** Force a parser instead of auto-detecting from the document body. */
  parserKey: optionalText(60),
  /** Extracted text of the document; parsers never read the binary directly. */
  text: z.string().min(1).max(500_000),
});

export const importDraftUpdateSchema = z.object({
  target: oneOf(IMPORT_TARGETS).optional(),
  parsedPayload: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(['pending', 'accepted', 'edited', 'rejected']).optional(),
});

export const importCommitSchema = z.object({
  /** Commit only these drafts; omit to commit every accepted/edited row. */
  draftIds: z.array(id()).min(1).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export type InvoiceCreateInput = z.infer<typeof invoiceCreateSchema>;
export type CheckCreateInput = z.infer<typeof checkCreateSchema>;
export type ImportBatchCreateInput = z.infer<typeof importBatchCreateSchema>;
