import { z } from 'zod';

import { USER_ROLES } from '../shared/enums';
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

/* ── Shared query shapes ───────────────────────────────────────────────────────
 *
 * Search terms are capped well under D1's hard 50-byte `LIKE` pattern limit.
 * Longer than that is a hard database error, not a slow query, and it would look
 * like the feature is broken. Pagination caps bound the response. Both join the
 * list endpoints that need them, rather than sitting here unused.
 * ──────────────────────────────────────────────────────────────────────────── */

export type LoginInput = z.infer<typeof loginSchema>;
export type UserCreateInput = z.infer<typeof userCreateSchema>;
export type UserUpdateInput = z.infer<typeof userUpdateSchema>;
export type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;
export type PriceTierUpdateInput = z.infer<typeof priceTierUpdateSchema>;
export type ServiceRateCreateInput = z.infer<typeof serviceRateCreateSchema>;
export type ServiceRateUpdateInput = z.infer<typeof serviceRateUpdateSchema>;
