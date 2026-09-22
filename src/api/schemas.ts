import { z } from 'zod';

import { PRODUCT_TYPES, UNITS, USER_ROLES } from '../shared/enums';
import { MIN_PASSWORD_LENGTH } from './lib/constants';

/**
 * All request validation lives here.
 *
 * `oneOf` is used instead of `z.enum` so the canonical tuples in
 * `src/shared/enums.ts` stay the single source of truth without a cast.
 *
 * A field omitted from an update schema means "leave it alone"; a field that can
 * be *cleared* is explicitly `.nullable()`, so null empties it. The two must never
 * be conflated — that is how a form that stops rendering an input silently wipes
 * the value it stores.
 */
const oneOf = <T extends string>(values: readonly T[]) =>
  z.custom<T>((value) => typeof value === 'string' && (values as readonly string[]).includes(value), {
    message: `Expected one of: ${values.join(', ')}`,
  });

const optionalText = (max: number) => z.string().trim().max(max).optional();
const nullableText = (max: number) => z.string().trim().max(max).nullable().optional();
const cents = () => z.number().int().min(0);
const email = () => z.string().trim().toLowerCase().email().max(200);

/**
 * `optionalId` / `nullableId` are the two shapes a form can send for a link, and
 * the difference is not cosmetic: "not supplied" must leave the stored vendor
 * alone, while an explicit null must detach it. Collapsing them into one is how a
 * form stops rendering a field and silently wipes the value behind it.
 */
const optionalId = z.string().trim().min(1).optional();
const nullableId = z.string().trim().min(1).nullable().optional();

/* ── Query shapes ─────────────────────────────────────────────────────────────
 *
 * Pagination is capped so a runaway page size cannot serialize years of history
 * into one response. Declared before the schemas that extend them, because a
 * `const` above its own use is a load-time ReferenceError, not a type error.
 * ──────────────────────────────────────────────────────────────────────────── */

export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

/** Query-string booleans: `z.coerce.boolean()` would treat the string "false" as true. */
function booleanQuery(defaultValue = false) {
  return z.preprocess(
    (value) => (value === undefined || value === '' ? defaultValue : value),
    z.union([z.boolean(), z.string()]).transform((value) =>
      typeof value === 'boolean'
        ? value
        : ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase()),
    ),
  );
}

/* ── Auth ──────────────────────────────────────────────────────────────────── */

export const loginSchema = z.object({
  email: email(),
  password: z.string().min(1).max(512),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(512),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(512),
});

/* ── Users ─────────────────────────────────────────────────────────────────── */

export const userCreateSchema = z.object({
  email: email(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(512),
  name: z.string().trim().min(1).max(120),
  role: oneOf(USER_ROLES),
  phone: optionalText(30),
});

export const userUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: oneOf(USER_ROLES).optional(),
  phone: nullableText(30),
  isActive: z.boolean().optional(),
});

/**
 * An admin setting a new password directly. Deliberately does not ask for the
 * old one — that is the point of the capability — and it revokes every session.
 */
export const adminResetPasswordSchema = z.object({
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(512),
});

/* ── Settings ──────────────────────────────────────────────────────────────────
 *
 * The numbers a business changes without wanting a deploy: the default tax rate,
 * the default terms, the four tier multipliers, and the service rates a mileage
 * or application charge pulls from.
 * ──────────────────────────────────────────────────────────────────────────── */

export const settingsUpdateSchema = z.object({
  legalName: z.string().trim().min(1).max(200).optional(),
  displayName: z.string().trim().min(1).max(200).optional(),
  addressLine1: nullableText(120),
  addressLine2: nullableText(120),
  city: nullableText(80),
  state: nullableText(2),
  postalCode: nullableText(12),
  phone: nullableText(30),
  email: nullableText(200),
  website: nullableText(200),
  ein: nullableText(20),
  pesticideLicenseNumber: nullableText(60),
  /** A decimal fraction: 0.07 is 7%. Null or omitted leaves it alone. */
  defaultTaxRate: z.number().min(0).max(0.2).nullable().optional(),
  defaultTermsDays: z.number().int().min(0).max(365).optional(),
  invoicePrefix: z.string().trim().min(1).max(8).optional(),
});

export const priceTierUpdateSchema = z.object({
  label: z.string().trim().min(1).max(80).optional(),
  description: nullableText(300),
  multiplier: z.number().min(1).max(3).optional(),
  requiresApplication: z.boolean().optional(),
  requiresPesticideLicense: z.boolean().optional(),
  isActive: z.boolean().optional(),
});

export const serviceRateCreateSchema = z.object({
  kind: oneOf(['application', 'mileage', 'other'] as const),
  label: z.string().trim().min(1).max(80),
  method: oneOf(['drone', 'ground', 'none'] as const).optional(),
  unit: oneOf(['acre', 'mile', 'hour', 'each'] as const),
  priceCents: cents(),
  sortOrder: z.number().int().min(0).optional(),
});

export const serviceRateUpdateSchema = z.object({
  kind: oneOf(['application', 'mileage', 'other'] as const).optional(),
  label: z.string().trim().min(1).max(80).optional(),
  method: oneOf(['drone', 'ground', 'none'] as const).nullable().optional(),
  unit: oneOf(['acre', 'mile', 'hour', 'each'] as const).optional(),
  priceCents: cents().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

/* ── Catalog & stock ─────────────────────────────────────────────────────────
 *
 * A product is stocked and billed in exactly one unit, and a program's
 * ingredient rate is expressed in that same unit — so there is no base-unit
 * column and no conversion to get wrong here.
 *
 * `costCents` is the whole price story (price = cost x tier multiplier), so it is
 * the one field that must be kept current. It is optional at creation because a
 * product is often catalogued before its invoice arrives, but a product without
 * one cannot be sold, and both the API and the UI say so plainly rather than
 * pricing it at zero.
 * ──────────────────────────────────────────────────────────────────────────── */

export const productCreateSchema = z.object({
  sku: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(200),
  description: optionalText(2000),
  type: oneOf(PRODUCT_TYPES),
  unit: oneOf(UNITS),
  costCents: cents().optional(),
  epaNumber: optionalText(60),
  isRegulatedSeed: z.boolean().optional(),
  reorderPoint: z.number().nonnegative().optional(),
  reorderQuantity: z.number().positive().optional(),
  vendorId: optionalId,
  notes: optionalText(2000),
});

export const productUpdateSchema = productCreateSchema.partial().extend({
  // An explicit false deactivates; absent means unchanged.
  isActive: z.boolean().optional(),
  costCents: cents().nullable().optional(),
  epaNumber: nullableText(60),
  reorderPoint: z.number().nonnegative().nullable().optional(),
  reorderQuantity: z.number().positive().nullable().optional(),
  vendorId: nullableId,
  description: nullableText(2000),
  notes: nullableText(2000),
});

/** Receiving is a positive quantity. Cost may arrive with it, as a dated basis. */
export const stockReceiptSchema = z.object({
  quantity: z.number().positive(),
  unit: oneOf(UNITS).optional(),
  unitCostCents: cents().optional(),
  vendorId: optionalId,
  reference: optionalText(120),
  occurredAt: z.coerce.date().optional(),
  note: optionalText(500),
});

/**
 * A physical-count correction. The delta is signed and the reason is mandatory:
 * an unexplained change to the quantity of a chemical is exactly what an audit
 * asks about later, and "shrinkage" without a reason is not an answer.
 */
export const stockAdjustSchema = z.object({
  delta: z.number().refine((value) => value !== 0, { message: 'delta cannot be zero' }),
  unit: oneOf(UNITS).optional(),
  reason: z.string().trim().min(3).max(500),
  occurredAt: z.coerce.date().optional(),
});

/** A vendor worth phoning when something is low. */
export const vendorCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contactName: optionalText(120),
  phone: optionalText(30),
  email: nullableText(200),
  accountNumber: optionalText(60),
  notes: optionalText(2000),
});

export const vendorUpdateSchema = vendorCreateSchema.partial().extend({
  isActive: z.boolean().optional(),
  contactName: nullableText(120),
  phone: nullableText(30),
  accountNumber: nullableText(60),
  notes: nullableText(2000),
});

/** Retired vendors are hidden by default, so the catalog stays short. */
export const vendorListQuerySchema = z.object({
  includeInactive: booleanQuery(),
});

/**
 * Search terms are capped at 40 characters because D1 refuses a `LIKE` pattern
 * longer than 50 bytes outright. That is a hard error, not a slow query, so an
 * over-long search looks like the feature being broken.
 */
export const catalogListQuerySchema = listQuerySchema.extend({
  q: z.string().trim().max(40).optional(),
  type: oneOf(PRODUCT_TYPES).optional(),
  includeInactive: booleanQuery(),
  /** 'low' restricts to the needs-ordering set. */
  stock: z.enum(['all', 'low']).optional(),
  sort: z.enum(['name', 'sku', 'type', 'costCents', 'createdAt']).default('name'),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;
export type PriceTierUpdateInput = z.infer<typeof priceTierUpdateSchema>;
export type ServiceRateCreateInput = z.infer<typeof serviceRateCreateSchema>;
export type ServiceRateUpdateInput = z.infer<typeof serviceRateUpdateSchema>;
export type ProductCreateInput = z.infer<typeof productCreateSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
export type StockReceiptInput = z.infer<typeof stockReceiptSchema>;
export type StockAdjustInput = z.infer<typeof stockAdjustSchema>;
export type VendorCreateInput = z.infer<typeof vendorCreateSchema>;
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;
export type CatalogListQuery = z.infer<typeof catalogListQuerySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
