import { asc, eq } from 'drizzle-orm';

import { createDb } from '../db';
import { priceTiers, serviceRates, settings, type PriceTier, type ServiceRate, type Settings } from '../db/schema';
import type {
  PriceTierUpdateInput,
  ServiceRateCreateInput,
  ServiceRateUpdateInput,
  SettingsUpdateInput,
} from '../api/schemas';
import { recordChange } from './audit';

/**
 * Company settings and the two editable pricing tables: margin tiers and service
 * rates.
 *
 * These are the numbers a small business expects to change — a fuel price moves
 * the mileage rate, a season moves a multiplier — and a deploy for each is the
 * wrong answer. `settings` is a singleton by convention; `getSettings` creates it
 * on first read, so a freshly migrated database is usable without a seed step
 * being run first.
 */
export const SETTINGS_ID = 'primary';

export async function getSettings(db: ReturnType<typeof createDb>): Promise<Settings> {
  const existing = await db.select().from(settings).where(eq(settings.id, SETTINGS_ID)).get();
  if (existing) return existing;

  // The insert carries no values, so every column default in the schema is what
  // lands. Defaults are the single source of truth; there is no second copy of
  // the Creston address here to drift from it.
  const [created] = await db.insert(settings).values({ id: SETTINGS_ID }).returning();
  if (!created) throw new Error('Failed to initialize company settings');
  return created;
}

export async function updateSettings(
  db: ReturnType<typeof createDb>,
  input: SettingsUpdateInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<Settings> {
  const before = await getSettings(db);

  // Undefined means "not supplied"; only present keys are written, so a form that
  // omits a field cannot clear it.
  const patch = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );

  if (Object.keys(patch).length === 0) return before;

  const [updated] = await db
    .update(settings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(settings.id, SETTINGS_ID))
    .returning();

  if (!updated) throw new Error('Failed to update settings');

  await recordChange(db, {
    actorUserId: actor.userId,
    action: 'settings.updated',
    entityType: 'settings',
    entityId: SETTINGS_ID,
    before,
    after: updated,
    ipAddress: actor.ipAddress,
  });

  return updated;
}

export async function listPriceTiers(
  db: ReturnType<typeof createDb>,
  options: { activeOnly?: boolean } = {},
): Promise<PriceTier[]> {
  const rows = await db.select().from(priceTiers).orderBy(asc(priceTiers.sortOrder)).all();
  return options.activeOnly ? rows.filter((row) => row.isActive) : rows;
}

export async function getActivePriceTier(
  db: ReturnType<typeof createDb>,
  key: PriceTier['key'],
): Promise<PriceTier> {
  const rows = await listPriceTiers(db, { activeOnly: true });
  const tier = rows.find((row) => row.key === key);
  if (!tier) throw new Error(`No active price tier "${key}"`);
  return tier;
}

export async function updatePriceTier(
  db: ReturnType<typeof createDb>,
  id: string,
  input: PriceTierUpdateInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<PriceTier> {
  const before = await db.select().from(priceTiers).where(eq(priceTiers.id, id)).get();
  if (!before) throw new Error('Price tier not found');

  const patch = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(patch).length === 0) return before;

  const [updated] = await db
    .update(priceTiers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(priceTiers.id, id))
    .returning();

  if (!updated) throw new Error('Failed to update price tier');

  await recordChange(db, {
    actorUserId: actor.userId,
    action: 'price_tier.updated',
    entityType: 'price_tier',
    entityId: id,
    before,
    after: updated,
    ipAddress: actor.ipAddress,
  });

  return updated;
}

export async function listServiceRates(
  db: ReturnType<typeof createDb>,
  options: { activeOnly?: boolean } = {},
): Promise<ServiceRate[]> {
  const rows = await db.select().from(serviceRates).orderBy(asc(serviceRates.sortOrder)).all();
  return options.activeOnly ? rows.filter((row) => row.isActive) : rows;
}

export async function createServiceRate(
  db: ReturnType<typeof createDb>,
  input: ServiceRateCreateInput,
): Promise<ServiceRate> {
  const [created] = await db
    .insert(serviceRates)
    .values({ ...input, sortOrder: input.sortOrder ?? 0 })
    .returning();
  if (!created) throw new Error('Failed to create service rate');
  return created;
}

export async function updateServiceRate(
  db: ReturnType<typeof createDb>,
  id: string,
  input: ServiceRateUpdateInput,
  actor: { userId: string; ipAddress: string | null },
): Promise<ServiceRate> {
  const before = await db.select().from(serviceRates).where(eq(serviceRates.id, id)).get();
  if (!before) throw new Error('Service rate not found');

  const patch = Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
  if (Object.keys(patch).length === 0) return before;

  const [updated] = await db
    .update(serviceRates)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(serviceRates.id, id))
    .returning();

  if (!updated) throw new Error('Failed to update service rate');

  await recordChange(db, {
    actorUserId: actor.userId,
    action: 'service_rate.updated',
    entityType: 'service_rate',
    entityId: id,
    before,
    after: updated,
    ipAddress: actor.ipAddress,
  });

  return updated;
}
