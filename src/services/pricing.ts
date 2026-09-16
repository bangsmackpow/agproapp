import { and, desc, eq, gt, isNull, lte, or } from 'drizzle-orm';

import type { Database } from '../db';
import {
  applicationFees,
  priceTiers,
  programPrices,
  type ApplicationFee,
  type PriceTier,
  type ProgramPrice,
} from '../db/schema';
import type { ApplicationMethod, CropType, PriceTierKey } from '../shared/enums';
import { notFound, unprocessable } from '../api/lib/http';

/**
 * Read-only lookups against the pricing tables.
 *
 * Application code must resolve prices through this module so that a tier whose
 * multiplier has been edited in the database is always honoured — the constants
 * in `src/shared/pricing.ts` are seed data, not runtime truth.
 */

export async function listActiveTiers(db: Database): Promise<PriceTier[]> {
  return db.select().from(priceTiers).where(eq(priceTiers.isActive, true)).orderBy(priceTiers.sortOrder).all();
}

export async function getTierByKey(db: Database, key: PriceTierKey): Promise<PriceTier> {
  const tier = await db.select().from(priceTiers).where(eq(priceTiers.key, key)).get();
  if (!tier) throw notFound(`Pricing tier "${key}" is not configured`);
  if (!tier.isActive) throw unprocessable(`Pricing tier "${tier.label}" is inactive`);
  return tier;
}

export async function getTierById(db: Database, id: string): Promise<PriceTier | undefined> {
  return db.select().from(priceTiers).where(eq(priceTiers.id, id)).get();
}

/**
 * Finds the program price in force on `on`, preferring the most recently
 * effective row. Dated rows let the 2024 and 2027 price sheets coexist.
 */
export async function findProgramPrice(
  db: Database,
  options: { programId: string; tierId: string; on: Date },
): Promise<ProgramPrice | undefined> {
  const { programId, tierId, on } = options;

  return db
    .select()
    .from(programPrices)
    .where(
      and(
        eq(programPrices.programId, programId),
        eq(programPrices.tierId, tierId),
        lte(programPrices.effectiveFrom, on),
        or(isNull(programPrices.effectiveTo), gt(programPrices.effectiveTo, on)),
      ),
    )
    .orderBy(desc(programPrices.effectiveFrom))
    .limit(1)
    .get();
}

/** Resolves an application fee by explicit id, or by method (+ crop) and date. */
export async function findApplicationFee(
  db: Database,
  options: { applicationFeeId?: string; method?: ApplicationMethod; crop?: CropType; on: Date },
): Promise<ApplicationFee | undefined> {
  const { applicationFeeId, method, crop, on } = options;

  if (applicationFeeId) {
    return db.select().from(applicationFees).where(eq(applicationFees.id, applicationFeeId)).get();
  }

  if (!method) return undefined;

  return db
    .select()
    .from(applicationFees)
    .where(
      and(
        eq(applicationFees.method, method),
        eq(applicationFees.isActive, true),
        lte(applicationFees.effectiveFrom, on),
        or(isNull(applicationFees.effectiveTo), gt(applicationFees.effectiveTo, on)),
        crop ? or(eq(applicationFees.crop, crop), isNull(applicationFees.crop)) : undefined,
      ),
    )
    .orderBy(desc(applicationFees.effectiveFrom))
    .limit(1)
    .get();
}
