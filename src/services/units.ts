import { eq } from 'drizzle-orm';

import { unprocessable } from '../api/lib/http';
import type { Database } from '../db';
import { units, type UnitRow } from '../db/schema';

/**
 * Units of measure.
 *
 * The registry is the validation source for the `unit` columns scattered across
 * products, invoice items, vendor bills and program rates. Those columns are
 * plain TEXT, so nothing at the database level would reject "gallons" as a
 * spelling of "gal" — this is where that gets caught.
 */

/** Active units in display order. */
export async function listUnits(db: Database): Promise<UnitRow[]> {
  return db.select().from(units).where(eq(units.isActive, true)).orderBy(units.sortOrder).all();
}

/**
 * Rejects unit codes that are not in the registry.
 *
 * The error names the offending codes and tells the operator what to do about
 * it, because "unknown unit" without the code is a miserable thing to debug.
 */
export async function assertKnownUnits(
  db: Database,
  codes: readonly (string | null | undefined)[],
): Promise<void> {
  const wanted = [...new Set(codes.filter((code): code is string => Boolean(code)))];
  if (wanted.length === 0) return;

  const known = new Set((await listUnits(db)).map((unit) => unit.code));

  // An empty registry means the units seed has not been applied yet, not that
  // every unit is invalid. Rejecting everything here would turn a deployment
  // ordering mistake into an outage on every product write.
  if (known.size === 0) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        message: 'units registry is empty; skipping unit validation until it is seeded',
        attemptedUnits: wanted,
      }),
    );
    return;
  }

  const unknown = wanted.filter((code) => !known.has(code));

  if (unknown.length > 0) {
    throw unprocessable(
      `Unknown unit ${unknown.map((code) => `"${code}"`).join(', ')}. ` +
        'Add it in Units first, or pick an existing one.',
      { unknownUnits: unknown, knownUnits: [...known] },
    );
  }
}

/**
 * Converts a quantity between two units.
 *
 * Returns null when the units measure different things. Ounces to pounds needs to
 * know what the substance is, so converting anyway would invent a number — and a
 * wrong number is worse than a refusal.
 */
export function convertWithinDimension(
  from: UnitRow,
  to: UnitRow,
  quantity: number,
): number | null {
  if (from.dimension !== to.dimension) return null;
  if (to.factorToBase === 0) return null;

  return (quantity * from.factorToBase) / to.factorToBase;
}

/** Looks up units by code, for callers holding a set of codes. */
export async function unitsByCode(db: Database): Promise<Map<string, UnitRow>> {
  const rows = await db.select().from(units).all();
  return new Map(rows.map((row) => [row.code, row]));
}
