import { sql } from 'drizzle-orm';

import type { Database } from '../db';
import { customerSequences } from '../db/schema';
import { conflict } from '../api/lib/http';

/**
 * Allocates the next customer account number, e.g. `AGP-057`.
 *
 * Mirrors `allocateInvoiceNumber`: the increment and the read happen in a single
 * atomic statement, so two simultaneous creations cannot be handed the same
 * number. `next_number` holds the number *about to be issued*, not the last used,
 * so a seeded 57 yields AGP-057.
 *
 * Three digits, matching the account numbers already in service.
 */
export async function allocateCustomerNumber(db: Database): Promise<string> {
  const [row] = await db
    .update(customerSequences)
    .set({ nextNumber: sql`${customerSequences.nextNumber} + 1`, updatedAt: new Date() })
    .returning({
      allocated: sql<number>`${customerSequences.nextNumber} - 1`,
      prefix: customerSequences.prefix,
    });

  if (!row) {
    throw conflict('No customer number sequence is configured');
  }

  return `${row.prefix}-${String(Number(row.allocated)).padStart(3, '0')}`;
}
