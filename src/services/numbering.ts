import { sql } from 'drizzle-orm';

import { createDb } from '../db';
import { counters } from '../db/schema';

/**
 * Allocated identifiers: invoice numbers and customer account numbers.
 *
 * Both are things people expect to be sequential and unique, and both were a
 * source of trouble when typed by hand. The increment happens inside a single
 * `UPDATE … RETURNING`, so two concurrent requests cannot observe the same
 * counter value — combined with D1's single-writer serialization, a number cannot
 * be handed out twice.
 *
 * A failed create or a deleted record burns a number, so the sequence will show
 * gaps. That is inherent to allocated identifiers and is the right trade against
 * reusing a number that was once printed on a document.
 */

export const INVOICE_COUNTER = 'invoice';
export const CUSTOMER_COUNTER = 'customer';

interface CounterDefaults {
  prefix: string;
  firstNumber: number;
}

const COUNTER_DEFAULTS: Record<string, CounterDefaults> = {
  [INVOICE_COUNTER]: { prefix: 'INV', firstNumber: 1001 },
  [CUSTOMER_COUNTER]: { prefix: 'AGP', firstNumber: 57 },
};

/** Zero-padded width per scope: invoice numbers are 5 digits, account numbers 3. */
const COUNTER_WIDTH: Record<string, number> = {
  [INVOICE_COUNTER]: 5,
  [CUSTOMER_COUNTER]: 3,
};

/**
 * Hands out the next number in a scope, creating the counter row on first use so
 * the app works against a migrated-but-unseeded database.
 */
export async function allocateNumber(
  db: ReturnType<typeof createDb>,
  scope: string,
): Promise<string> {
  const defaults = COUNTER_DEFAULTS[scope] ?? { prefix: scope.toUpperCase(), firstNumber: 1 };
  const width = COUNTER_WIDTH[scope] ?? 5;

  await db
    .insert(counters)
    .values({ scope, prefix: defaults.prefix, nextNumber: defaults.firstNumber })
    .onConflictDoNothing();

  const [row] = await db
    .update(counters)
    .set({ nextNumber: sql`${counters.nextNumber} + 1`, updatedAt: new Date() })
    .where(sql`${counters.scope} = ${scope}`)
    .returning({
      allocated: sql<number>`${counters.nextNumber} - 1`,
      prefix: counters.prefix,
    });

  if (!row) throw new Error(`Failed to allocate a number for "${scope}"`);

  const prefix = row.prefix || defaults.prefix;
  return `${prefix}-${String(Number(row.allocated)).padStart(width, '0')}`;
}
