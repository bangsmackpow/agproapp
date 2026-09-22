import { env } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { createDb } from '../db';
import { products, settings, stockMovements, users, vendors } from '../db/schema';
import type { Env } from '../env';
import { lowStockProducts } from './catalog';
import { runReorderDigest } from './reorder-digest';

/**
 * The morning reorder digest.
 *
 * Two failure modes are worth pinning, and both are the kind that only show up in
 * production: mailing the same list twice because a cron retried, and emailing an
 * empty list until people stop reading the subject line.
 *
 * The digest is run against an env with **no mail key on purpose**. It exercises
 * the real provider path — which reports `skipped` rather than claiming a send
 * that never happened — without any chance of delivering mail to a real address
 * from a test.
 */

const STAMP = Date.now();

/** Deliberately omits MAIL_PROVIDER_API_KEY: see the note above. */
function maillessEnv(): Env {
  return {
    DB: env.DB,
    ENVIRONMENT: 'test',
    APP_NAME: 'AG Pro Solutions',
    APP_REGION: 'Creston, IA',
    MAIL_FROM: 'AG Pro Solutions <digest@example.invalid>',
    MAIL_REPLY_TO: '',
  } as unknown as Env;
}

async function reset() {
  const db = createDb(env.DB);
  await db.delete(stockMovements);
  await db.delete(products);
  await db.delete(settings);
  await db.delete(users);
}

async function seed(options: { onHand: number; reorderPoint: number | null; withAdmin?: boolean }) {
  const db = createDb(env.DB);

  if (options.withAdmin !== false) {
    await db.insert(users).values({
      email: `digest-admin-${STAMP}@agpro.local`,
      passwordHash: 'not-a-real-hash',
      name: 'Digest Admin',
      role: 'admin',
    });
  }

  const [product] = await db
    .insert(products)
    .values({
      sku: `DIGEST-${STAMP}`,
      name: 'Ventas',
      type: 'chemical',
      unit: 'gal',
      costCents: 4200,
      reorderPoint: options.reorderPoint,
      reorderQuantity: 55,
    })
    .returning();

  if (options.onHand !== 0) {
    await db.insert(stockMovements).values({
      productId: product!.id,
      movementType: 'receipt',
      quantityDelta: options.onHand,
      unit: 'gal',
      occurredAt: new Date(),
      note: 'Opening stock',
    });
  }

  return product!;
}

describe('the reorder digest', () => {
  beforeEach(async () => {
    await reset();
  });

  it('sends nothing when nothing is low', async () => {
    await seed({ onHand: 100, reorderPoint: 50 });

    const outcome = await runReorderDigest(maillessEnv());

    expect(outcome.status).toBe('nothing');
    expect(outcome.productCount).toBe(0);
  });

  it('treats "no reorder point set" as "do not alert", not as zero', async () => {
    await seed({ onHand: 0, reorderPoint: null });

    const outcome = await runReorderDigest(maillessEnv());

    expect(outcome.status).toBe('nothing');
  });

  it('reports skipped rather than a send when no mail provider is configured', async () => {
    await seed({ onHand: 10, reorderPoint: 50 });

    const outcome = await runReorderDigest(maillessEnv());

    expect(outcome.status).toBe('skipped');
    expect(outcome.productCount).toBe(1);
    expect(outcome.recipients).toBe(1);
  });

  it('will not send twice in the same window', async () => {
    await seed({ onHand: 10, reorderPoint: 50 });

    const first = await runReorderDigest(maillessEnv());
    const second = await runReorderDigest(maillessEnv());

    expect(first.status).toBe('skipped');
    expect(second.status).toBe('already-sent-today');
  });

  it('claims the day even when the send is skipped, so a retry cannot double-mail', async () => {
    await seed({ onHand: 10, reorderPoint: 50 });
    const db = createDb(env.DB);

    await runReorderDigest(maillessEnv());

    const row = await db.select().from(settings).where(eq(settings.id, 'primary')).get();
    expect(row?.lastDigestAt).toBeInstanceOf(Date);
  });

  it('includes the vendor so the alert is actionable', async () => {
    const product = await seed({ onHand: 10, reorderPoint: 50 });
    const db = createDb(env.DB);

    await db.insert(vendors).values({ id: crypto.randomUUID(), name: 'Wickman Chemical' });
    const vendor = await db.select().from(vendors).limit(1).get();
    await db.update(products).set({ vendorId: vendor!.id }).where(eq(products.id, product.id));

    const low = await lowStockProducts(db);

    expect(low).toHaveLength(1);
    expect(low[0]!.vendorName).toBe('Wickman Chemical');
  });
});
