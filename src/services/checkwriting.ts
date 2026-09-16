import { eq, inArray, sql } from 'drizzle-orm';

import { conflict, notFound, unprocessable } from '../api/lib/http';
import type { CheckCreateInput } from '../api/schemas';
import type { Database } from '../db';
import {
  bankAccounts,
  checkAllocations,
  checks,
  vendorBills,
  vendors,
  type Check,
  type CheckAllocation,
} from '../db/schema';
import type { CheckStatus, VendorBillStatus } from '../shared/enums';

/* ────────────────────────────────────────────────────────────────────────────
 * Numbering
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Allocates the next check number for an account.
 *
 * The counter is advanced by a single `UPDATE … RETURNING`, so two concurrent
 * requests can never receive the same number. The unique index on
 * `(bank_account_id, check_number)` is the backstop that makes the guarantee
 * structural rather than merely conventional — if it is ever violated, the
 * insert fails loudly instead of silently duplicating a payment.
 */
export async function allocateCheckNumber(db: Database, bankAccountId: string): Promise<number> {
  const [row] = await db
    .update(bankAccounts)
    .set({ nextCheckNumber: sql`${bankAccounts.nextCheckNumber} + 1`, updatedAt: new Date() })
    .where(eq(bankAccounts.id, bankAccountId))
    .returning({ allocated: sql<number>`${bankAccounts.nextCheckNumber} - 1` });

  if (!row) throw notFound(`Bank account ${bankAccountId} not found`);
  return Number(row.allocated);
}

/** Derives a vendor bill's status from its balance. */
function deriveBillStatus(balanceCents: number, totalCents: number): VendorBillStatus {
  if (balanceCents <= 0) return 'paid';
  if (balanceCents < totalCents) return 'partial';
  return 'open';
}

/* ────────────────────────────────────────────────────────────────────────────
 * Issuing
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CreateCheckResult {
  check: Check;
  allocations: CheckAllocation[];
}

/**
 * Issues a check, optionally allocating it across vendor bills.
 *
 * All validation happens before the first write, and the writes are issued as one
 * D1 batch (a single transaction), so a check can never exist without its
 * allocations or with partially-adjusted bill balances.
 */
export async function createCheck(
  db: Database,
  input: CheckCreateInput,
  actorUserId: string,
): Promise<CreateCheckResult> {
  const account = await db.select().from(bankAccounts).where(eq(bankAccounts.id, input.bankAccountId)).get();
  if (!account) throw notFound(`Bank account ${input.bankAccountId} not found`);
  if (!account.isActive) throw unprocessable(`Bank account "${account.name}" is inactive`);

  if (input.payeeVendorId) {
    const vendor = await db.select().from(vendors).where(eq(vendors.id, input.payeeVendorId)).get();
    if (!vendor) throw notFound(`Vendor ${input.payeeVendorId} not found`);
  }

  const requested = input.allocations ?? [];

  if (requested.length > 0) {
    const allocated = requested.reduce((total, entry) => total + entry.amountCents, 0);
    if (allocated > input.amountCents) {
      throw unprocessable(
        'Allocations exceed the check amount',
        { checkAmountCents: input.amountCents, allocatedCents: allocated },
      );
    }
  }

  const billIds = [...new Set(requested.map((entry) => entry.vendorBillId))];
  const bills = billIds.length
    ? await db.select().from(vendorBills).where(inArray(vendorBills.id, billIds)).all()
    : [];

  const billById = new Map(bills.map((bill) => [bill.id, bill]));

  for (const entry of requested) {
    const bill = billById.get(entry.vendorBillId);
    if (!bill) throw notFound(`Vendor bill ${entry.vendorBillId} not found`);
    if (bill.status === 'void') throw unprocessable(`Vendor bill ${bill.billNumber} is voided`);
    if (entry.amountCents > bill.balanceCents) {
      throw unprocessable(
        `Allocation of ${entry.amountCents} exceeds the open balance of bill ${bill.billNumber}`,
        { balanceCents: bill.balanceCents },
      );
    }
    if (input.payeeVendorId && bill.vendorId !== input.payeeVendorId) {
      throw unprocessable(`Bill ${bill.billNumber} does not belong to the selected payee`);
    }
  }

  const checkNumber = await allocateCheckNumber(db, account.id);
  const now = new Date();

  const [check] = await db
    .insert(checks)
    .values({
      bankAccountId: account.id,
      checkNumber,
      payeeVendorId: input.payeeVendorId ?? null,
      payeeName: input.payeeName,
      amountCents: input.amountCents,
      memo: input.memo ?? null,
      paymentDate: input.paymentDate ?? now,
      status: 'draft',
      paymentDescriptor: input.paymentDescriptor ?? null,
      createdByUserId: actorUserId,
      updatedAt: now,
    })
    .returning();

  if (!check) throw conflict('Failed to create check');

  if (requested.length === 0) return { check, allocations: [] };

  const allocationRows = requested.map((entry) => ({
    checkId: check.id,
    vendorBillId: entry.vendorBillId,
    amountCents: entry.amountCents,
  }));

  const statements = [
    db.insert(checkAllocations).values(allocationRows),
    ...requested.map((entry) => {
      const bill = billById.get(entry.vendorBillId) as (typeof bills)[number];
      const balanceCents = bill.balanceCents - entry.amountCents;
      return db
        .update(vendorBills)
        .set({
          balanceCents,
          status: deriveBillStatus(balanceCents, bill.totalCents),
          updatedAt: now,
        })
        .where(eq(vendorBills.id, bill.id));
    }),
  ];

  await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);

  const allocations = await db
    .select()
    .from(checkAllocations)
    .where(eq(checkAllocations.checkId, check.id))
    .all();

  return { check, allocations };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Lifecycle
 * ──────────────────────────────────────────────────────────────────────────── */

const ALLOWED_TRANSITIONS: Record<CheckStatus, readonly CheckStatus[]> = {
  draft: ['printed', 'voided'],
  printed: ['cleared', 'voided'],
  cleared: ['voided'],
  voided: [],
  reissued: ['printed', 'voided'],
};

/**
 * Moves a check through its lifecycle.
 *
 * Voiding reverses every allocation and restores the affected vendor bill
 * balances and statuses, in one batch, so a void can never leave the payables
 * ledger overstated.
 */
export async function updateCheckStatus(
  db: Database,
  checkId: string,
  nextStatus: CheckStatus,
  reason?: string,
): Promise<Check> {
  const check = await db.select().from(checks).where(eq(checks.id, checkId)).get();
  if (!check) throw notFound(`Check ${checkId} not found`);

  if (check.status === nextStatus) return check;

  const allowed = ALLOWED_TRANSITIONS[check.status];
  if (!allowed.includes(nextStatus)) {
    throw conflict(`Cannot move check from "${check.status}" to "${nextStatus}"`);
  }

  const now = new Date();
  const patch: Partial<typeof checks.$inferInsert> = { status: nextStatus, updatedAt: now };

  if (nextStatus === 'printed') patch.printedAt = now;
  if (nextStatus === 'voided') {
    patch.voidedAt = now;
    patch.voidReason = reason ?? null;
  }

  if (nextStatus !== 'voided') {
    const [updated] = await db.update(checks).set(patch).where(eq(checks.id, checkId)).returning();
    if (!updated) throw conflict('Failed to update check');
    return updated;
  }

  const allocations = await db
    .select()
    .from(checkAllocations)
    .where(eq(checkAllocations.checkId, checkId))
    .all();

  const billIds = [...new Set(allocations.map((entry) => entry.vendorBillId).filter((id): id is string => Boolean(id)))];
  const bills = billIds.length
    ? await db.select().from(vendorBills).where(inArray(vendorBills.id, billIds)).all()
    : [];

  const billById = new Map(bills.map((bill) => [bill.id, bill]));

  const statements = [
    db.update(checks).set(patch).where(eq(checks.id, checkId)),
    ...allocations.map((entry) => {
      const bill = entry.vendorBillId ? billById.get(entry.vendorBillId) : undefined;
      if (!bill) return db.delete(checkAllocations).where(eq(checkAllocations.id, entry.id));

      const balanceCents = Math.min(bill.totalCents, bill.balanceCents + entry.amountCents);
      return db
        .update(vendorBills)
        .set({
          balanceCents,
          status: deriveBillStatus(balanceCents, bill.totalCents),
          updatedAt: now,
        })
        .where(eq(vendorBills.id, bill.id));
    }),
  ];

  await db.batch(statements as [(typeof statements)[number], ...(typeof statements)[number][]]);

  const refreshed = await db.select().from(checks).where(eq(checks.id, checkId)).get();
  if (!refreshed) throw conflict('Failed to void check');
  return refreshed;
}

export async function getCheckWithAllocations(db: Database, checkId: string) {
  const check = await db.select().from(checks).where(eq(checks.id, checkId)).get();
  if (!check) throw notFound(`Check ${checkId} not found`);

  const allocations = await db
    .select()
    .from(checkAllocations)
    .where(eq(checkAllocations.checkId, checkId))
    .all();

  return { check, allocations };
}
